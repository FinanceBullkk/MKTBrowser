/**
 * Asking the engine binary which version it is, and keeping the profile's fingerprint in step.
 *
 * Extracted from `ChromiumBrowserDriver.ts` on 18 September 2026 without changing behaviour.
 */
import { spawn } from "node:child_process";
import type { BrowserEngine } from "@mktbrowser/settings-store";
import type { FingerprintConfig } from "@mktbrowser/types";

export interface ChromiumVersion {
  major: number;
  full: string;
}

export function parseChromiumVersion(value: string): ChromiumVersion | null {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    full: `${match[1]}.${match[2]}.${match[3]}.${match[4]}`,
  };
}

/**
 * CloakBrowser's `--version` path enters its licensed runtime and can consume the only seat without
 * an SDK context to close. Its verified bootstrap version is authoritative, so only CFT is probed.
 */
export async function resolveChromiumVersionForLaunch(
  options: {
    engine: BrowserEngine;
    binaryPath: string;
    verifiedVersion: string | null;
  },
  detector: (binaryPath: string) => Promise<ChromiumVersion | null> = detectChromiumVersion,
): Promise<ChromiumVersion | null> {
  if (options.engine === "cloakbrowser") {
    return options.verifiedVersion ? parseChromiumVersion(options.verifiedVersion) : null;
  }
  return detector(options.binaryPath);
}

/**
 * Run `chromium --version` and parse the version triple. Returns null
 * if the probe fails — the caller should then trust whatever version is
 * baked into the profile.
 */
export async function detectChromiumVersion(
  binaryPath: string,
): Promise<ChromiumVersion | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v: ChromiumVersion | null): void => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };
    try {
      const p = spawn(binaryPath, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      p.stdout?.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      p.on("close", () => {
        done(parseChromiumVersion(out));
      });
      p.on("error", () => done(null));
      setTimeout(() => {
        p.kill();
        done(null);
      }, 2000);
    } catch {
      done(null);
    }
  });
}

/**
 * Rewrite the version-bearing fields of a fingerprint to match the
 * actual Chromium binary. Returns a new object — does NOT persist; if
 * the user wants the persisted profile updated they should hit Regen.
 *
 * Touches: userAgent, clientHints.secChUa, clientHints.secChUaFullVersionList.
 * Leaves device, locale, screen, etc. untouched.
 */
export function reconcileVersionInFingerprint(
  fp: FingerprintConfig,
  actual: { major: number; full: string },
): FingerprintConfig {
  // Rewrite Chrome version in UA: "Chrome/148.0.7390.42" → "Chrome/147.0.7727.138"
  const newUA = fp.userAgent.replace(/Chrome\/\d+\.\d+\.\d+\.\d+/, `Chrome/${actual.full}`);
  if (!fp.clientHints) {
    return { ...fp, userAgent: newUA };
  }
  const ch = fp.clientHints;
  // "Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"
  // Rewrite v="<num>" only on Chromium / Google Chrome / Microsoft Edge
  // brand entries; leave the GREASE brand alone.
  const newSecChUa = ch.secChUa.replace(
    /("(?:Chromium|Google Chrome|Microsoft Edge)";v=")(\d+)(")/g,
    `$1${actual.major}$3`,
  );
  const newFullList = ch.secChUaFullVersionList.replace(
    /("(?:Chromium|Google Chrome|Microsoft Edge)";v=")[\d.]+(")/g,
    `$1${actual.full}$2`,
  );
  return {
    ...fp,
    userAgent: newUA,
    clientHints: {
      ...ch,
      secChUa: newSecChUa,
      secChUaFullVersionList: newFullList,
    },
  };
}
