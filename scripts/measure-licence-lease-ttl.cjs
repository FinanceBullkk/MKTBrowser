#!/usr/bin/env node
/**
 * Measure how long the vendor keeps counting a licence seat after its holder stops.
 *
 * Why this exists: `LicenseKeyPool` rests an unclean-exit key for a fixed 17 minutes, but the
 * repository holds three different numbers for what the real lease is — a 7-17 minute range in the
 * pool's own comment, a nominal 900s in the protocol, and a 20-25 minute observation in
 * phase-04. If the true value is longer than the cooldown, the pool offers the key back too early,
 * the engine refuses it, and the operator waits a second full cooldown for no reason. Guessing the
 * constant is worse than measuring it.
 *
 * Method: open a session, then simply stop — no `session/end`, no heartbeat, which is exactly what
 * a killed browser does. Then ask for a session once a minute until one is granted, and end that
 * one properly. The gap is the answer.
 *
 * This talks only to the vendor's documented HTTP API with the operator's own key. It does not
 * touch the engine binary, and it does not redirect the licence channel anywhere.
 *
 * COST: the key under test is unusable for the whole run — that is the thing being measured. Do
 * not run this while an operator needs to launch a profile.
 *
 * Usage:
 *   CLOAKBROWSER_LICENSE_KEY=<key> node scripts/measure-licence-lease-ttl.cjs [--poll-seconds 60]
 *                                                                            [--max-minutes 45]
 *
 * The key is read from the environment and is never printed, logged, or written to the report.
 */

"use strict";

const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const API_BASE = process.env.CLOAKBROWSER_LICENSE_API || "https://cloakbrowser.dev";
const PLATFORM = "windows-x64";
/** Any accepted version string; the lease clock does not depend on it. */
const VERSION = process.env.MKT_PROBE_ENGINE_VERSION || "151.0.7922.108";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const POLL_SECONDS = arg("poll-seconds", 60);
const MAX_MINUTES = arg("max-minutes", 45);

function readInstallId() {
  // The same machine identity the engine sends. Reused so the server sees one install, not two.
  const path = join(homedir(), ".cloakbrowser", "install_id");
  try {
    const value = readFileSync(path, "utf8").trim();
    if (value) return value;
  } catch {
    /* fall through */
  }
  // A fresh id still measures the lease; it just looks like a different machine to the vendor.
  return randomUUID();
}

async function post(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* a non-JSON body is still a useful status */
  }
  return { status: response.status, payload };
}

/** Strip anything that identifies the key, the lease, or the machine. */
function safeFields(payload) {
  if (!payload || typeof payload !== "object") return {};
  const keep = [
    "error",
    "code",
    "active_sessions",
    "limit",
    "plan",
    "lease_ttl_seconds",
    "heartbeat_interval_seconds",
  ];
  const out = {};
  for (const field of keep) {
    if (payload[field] !== undefined) out[field] = payload[field];
  }
  return out;
}

const stamp = () => new Date().toISOString();
const log = (message) => process.stdout.write(`${stamp()}  ${message}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const licenseKey = (process.env.CLOAKBROWSER_LICENSE_KEY || "").trim();
  if (!licenseKey) {
    process.stderr.write(
      "Set CLOAKBROWSER_LICENSE_KEY to the key under test. It is never printed.\n",
    );
    process.exit(2);
  }

  const installId = readInstallId();
  log(`probe start — api=${API_BASE} poll=${POLL_SECONDS}s cap=${MAX_MINUTES}m`);

  // `--since <iso>` measures a lease that was abandoned before this process started — a browser
  // killed by hand, or an earlier probe run. Skips straight to polling and counts from that moment
  // instead of taking a fresh seat, so a seat already resting is measured rather than a new one
  // spent.
  const sinceIndex = process.argv.indexOf("--since");
  if (sinceIndex !== -1 && sinceIndex + 1 < process.argv.length) {
    const sinceMs = Date.parse(process.argv[sinceIndex + 1]);
    if (Number.isNaN(sinceMs)) {
      process.stderr.write("--since needs an ISO timestamp.\n");
      process.exit(2);
    }
    log(`measuring a lease abandoned at ${new Date(sinceMs).toISOString()} — not opening one`);
    await pollUntilReclaimed(installId, licenseKey, sinceMs);
    return;
  }

  // 1. Take the seat.
  const opened = await post("/api/license/session/start", {
    install_id: installId,
    instance_id: randomUUID(),
    license_key: licenseKey,
    platform: PLATFORM,
    version: VERSION,
  });
  if (opened.status !== 200) {
    log(`FAILED to open a session: HTTP ${opened.status} ${JSON.stringify(safeFields(opened.payload))}`);
    log("The key must be free before the probe starts. Close every profile, or wait out a lease.");
    process.exit(1);
  }
  const declared = safeFields(opened.payload);
  log(`session opened. server declares ${JSON.stringify(declared)}`);

  // 2. Abandon it — no end, no heartbeat. This is what a SIGKILLed browser leaves behind.
  const abandonedAtMs = Date.now();
  log("session abandoned (no session/end, no heartbeat). Waiting for the server to reclaim it.");

  await pollUntilReclaimed(installId, licenseKey, abandonedAtMs);
}

/**
 * Ask for the seat once per interval until the server hands it over, then give it straight back.
 *
 * A granted request is the measurement *and* a seat taken, so it is released immediately — leaving
 * this probe's own lease behind would poison the next run with the very state it measures.
 */
async function pollUntilReclaimed(installId, licenseKey, abandonedAtMs) {
  const deadlineMs = abandonedAtMs + MAX_MINUTES * 60_000;
  for (;;) {
    await sleep(POLL_SECONDS * 1000);
    const elapsedMin = (Date.now() - abandonedAtMs) / 60_000;

    const instanceId = randomUUID();
    const attempt = await post("/api/license/session/start", {
      install_id: installId,
      instance_id: instanceId,
      license_key: licenseKey,
      platform: PLATFORM,
      version: VERSION,
    });

    if (attempt.status === 200) {
      log(`SEAT RECLAIMED after ${elapsedMin.toFixed(1)} minutes`);
      const leaseId = attempt.payload && attempt.payload.lease_id;
      if (leaseId) {
        // `license_key` is included because a release sent without it was answered HTTP 422 on
        // 24 August 2026, which left the probe's own seat held for a full further lease — the
        // exact failure this script exists to measure. If a release is ever not confirmed, say so
        // loudly: a silent 422 here costs the operator 15 minutes.
        const ended = await post("/api/license/session/end", {
          lease_id: leaseId,
          install_id: installId,
          instance_id: instanceId,
          license_key: licenseKey,
        });
        log(`probe session released: HTTP ${ended.status}`);
        if (ended.status !== 200) {
          log(
            `WARNING: release NOT confirmed — this probe is now holding the seat until roughly ` +
              `${new Date(Date.now() + 900_000).toISOString()}.`,
          );
        }
      }
      log("");
      log(`RESULT: abandoned lease reclaimed after ~${elapsedMin.toFixed(1)} minutes.`);
      log(`Pool cooldown is currently 17 minutes — set it above this figure, not below.`);
      return;
    }

    log(
      `t+${elapsedMin.toFixed(0)}m still held: HTTP ${attempt.status} ` +
        `${JSON.stringify(safeFields(attempt.payload))}`,
    );

    if (Date.now() >= deadlineMs) {
      log(`GAVE UP at ${MAX_MINUTES} minutes — the lease outlives the probe window.`);
      log("Re-run with a larger --max-minutes. The seat frees on its own regardless.");
      process.exit(3);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${String(error)}\n`);
  process.exit(1);
});
