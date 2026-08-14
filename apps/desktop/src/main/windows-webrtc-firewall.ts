import { execFile as nodeExecFile } from "node:child_process";
import { basename, win32 } from "node:path";
import { promisify } from "node:util";
import type { BrowserEngine } from "@mktbrowser/settings-store";

const execFileP = promisify(nodeExecFile);
const RULE_PREFIX = "MKT Browser WebRTC UDP Block";

type ExecFile = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

export function firewallRuleNameForEngine(engine: BrowserEngine): string {
  return `${RULE_PREFIX} (${engine === "cft" ? "Chrome for Testing" : "CloakBrowser"})`;
}

export async function assertWindowsWebRtcFirewallProtection(options: {
  platform?: NodeJS.Platform;
  engine: BrowserEngine;
  binaryPath: string;
  execFile?: ExecFile;
}): Promise<void> {
  if ((options.platform ?? process.platform) !== "win32") return;

  const binaryPath = win32.normalize(options.binaryPath);
  const expectedSuffix = win32.join(
    "chromium",
    options.engine,
    "runtime",
    "chrome.exe",
  ).toLowerCase();
  if (
    basename(binaryPath).toLowerCase() !== "chrome.exe" ||
    !binaryPath.toLowerCase().endsWith(expectedSuffix)
  ) {
    throw protectionError(options.engine, "unexpected-runtime");
  }

  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: process.env.PATH,
    PSModulePath: process.env.PSModulePath,
    ProgramFiles: process.env.ProgramFiles,
    ProgramData: process.env.ProgramData,
    SystemDrive: process.env.SystemDrive,
    MKT_BROWSER_FIREWALL_RULE: firewallRuleNameForEngine(options.engine),
    MKT_BROWSER_FIREWALL_PROGRAM: binaryPath,
  };
  const script = [
    "$ErrorActionPreference='Stop'",
    "$policy=New-Object -ComObject HNetCfg.FwPolicy2",
    "$rules=@($policy.Rules | Where-Object { $_.Name -eq $env:MKT_BROWSER_FIREWALL_RULE })",
    "if($rules.Count -ne 1){throw 'rule-count'}",
    "$rule=$rules[0]",
    "$program=[IO.Path]::GetFullPath($env:MKT_BROWSER_FIREWALL_PROGRAM)",
    "$programOk=-not [string]::IsNullOrWhiteSpace($rule.ApplicationName) -and [IO.Path]::GetFullPath($rule.ApplicationName).Equals($program,[StringComparison]::OrdinalIgnoreCase)",
    "$udpOk=$rule.Protocol -eq 17",
    "$profileOk=($rule.Profiles -band 7) -eq 7",
    "$ruleOk=$rule.Enabled -and $rule.Direction -eq 2 -and $rule.Action -eq 0",
    "$firewallOk=@(1,2,4 | Where-Object { -not $policy.FirewallEnabled($_) }).Count -eq 0",
    "if(-not ($programOk -and $udpOk -and $profileOk -and $ruleOk -and $firewallOk)){throw 'rule-invalid'}",
    "[Console]::Out.Write('{\"protected\":true}')",
  ].join(";");

  try {
    const execFile = options.execFile ?? (execFileP as unknown as ExecFile);
    const result = await execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env, encoding: "utf8" },
    );
    const output = JSON.parse(result.stdout.trim()) as { protected?: boolean; reason?: string };
    if (output.protected !== true) throw protectionError(options.engine, output.reason);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("WebRTC protection is not active")) {
      throw cause;
    }
    throw protectionError(options.engine, "verification-failed", cause);
  }
}

function protectionError(engine: BrowserEngine, reason = "unknown", cause?: unknown): Error {
  const label = engine === "cft" ? "Chrome for Testing" : "CloakBrowser";
  return new Error(
    `WebRTC protection is not active for ${label} (${reason}). ` +
      "The proxied profile was not launched. Rerun the current MKT Browser installer as Administrator, then retry.",
    cause === undefined ? undefined : { cause },
  );
}
