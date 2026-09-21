const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { existsSync } = require("node:fs");
const { readFile, writeFile } = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { measureCdpEndpoint } = require("./fingerprint-measurement-cdp.cjs");

// Default propagation window between profiles. It is deliberately short, and on 21 September
// 2026 it proved too short on a one-seat key: the vendor answered a launch with
// session_limit_exceeded (active_sessions 1, limit 1) minutes after a clean close that the
// local pool had already reported as a free seat. A longer explicit quiet interval does not
// itself prove that the vendor has released the seat.
const REMOTE_SEAT_SETTLE_MS = 5_000;

async function launchMktBrowser({ executable, appPath, userData, licenseKey }) {
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({
      theme: "dark",
      mcpHttpEnabled: true,
      browserEngine: "cloakbrowser",
      cloakBrowserLicenseKey: licenseKey,
      cloakBrowserLicenseKeys: [],
      startupOrphanSweep: true,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  const port = await reservePort();
  const env = {
    ...process.env,
    MKT_BROWSER_MCP_PORT: String(port),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [...(appPath ? [appPath] : []), `--user-data-dir=${userData}`], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let diagnostics = "";
  const collect = (chunk) => {
    diagnostics = (diagnostics + chunk.toString("utf8")).slice(-20_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  try {
    // Surface executable/startup errors through the caller's cleanup path.
    await once(child, "spawn");
    const tokenPath = path.join(userData, "mcp-token");
    await waitFor(() => existsSync(tokenPath), 30_000, "MCP token", child);
    const token = (await readFile(tokenPath, "utf8")).trim();
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => {
        try {
          return (await fetch(`${baseUrl}/healthz`, { headers: auth(token) })).ok;
        } catch {
          return false;
        }
      },
      30_000,
      "MCP health endpoint",
      child,
    );
    await rpc(baseUrl, token, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "phase02-fingerprint-measurer", version: "2.0.0" },
    });
    return {
      child,
      diagnostics: () => diagnostics,
      callTool: (name, toolArgs) => callTool(baseUrl, token, name, toolArgs),
      stop: async () => {
        child.kill();
        await waitForPidExit(child.pid, 8_000);
        if (isPidAlive(child.pid)) throw new Error("MKT Browser did not exit after measurement.");
      },
    };
  } catch (error) {
    child.kill();
    await Promise.race([once(child, "exit"), delay(5_000)]);
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (diagnostics.trim()) wrapped.message += `\nPackaged app diagnostics:\n${diagnostics.trim()}`;
    throw wrapped;
  }
}

async function waitForReadyRuntime(app, timeoutMs) {
  let latest;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    latest = await app.callTool("get_runtime_info", {});
    if (latest.engine?.status === "ready") return latest;
    if (latest.engine?.status === "error") {
      throw new Error(`Engine bootstrap failed: ${JSON.stringify(latest.engine)}`);
    }
    await delay(1_000);
  }
  throw new Error(
    `Timed out waiting for engine readiness. Last runtime: ${JSON.stringify(latest)}`,
  );
}

async function assertSeatFree(app, stage) {
  const runtime = await app.callTool("get_runtime_info", {});
  assert.deepEqual(
    runtime.licenseCapacity,
    { total: 1, free: 1, active: 0, pendingRecovery: 0, cooling: 0 },
    `CloakBrowser seat is not free at ${stage}.`,
  );
}

/**
 * Retained opt-in experiment from 21 September 2026, not a seat-recovery strategy.
 * A fixed 17-minute wait and vendor API release checks did not prove that a launch would work.
 * Later refusals 18 minutes apart stayed blocked for 40 minutes. Whether each attempt resets
 * the vendor timer remains unconfirmed; retries may prolong the hold and are disabled by default.
 */
const SEAT_RETRY_INTERVAL_MS = 2 * 60_000;

function isSeatBusyError(error) {
  const message = String(error?.message ?? error);
  return (
    message.includes("ENGINE_UNAVAILABLE") ||
    /session limit|seat|capacity/i.test(message)
  );
}

async function launchWithSeatRetry(app, profileId, retryDeadlineMs, log) {
  for (;;) {
    try {
      return await app.callTool("launch_profile", { profile_id: profileId });
    } catch (error) {
      if (!isSeatBusyError(error) || Date.now() >= retryDeadlineMs) throw error;
      log(`seat still busy; asking again in ${SEAT_RETRY_INTERVAL_MS / 1000}s`);
      await delay(SEAT_RETRY_INTERVAL_MS);
    }
  }
}

async function measureCloakProfile(app, profileId, probeUrl, options = {}) {
  const {
    settleMs = REMOTE_SEAT_SETTLE_MS,
    seatRetryMinutes = 0,
    log = () => {},
  } = options;
  if (seatRetryMinutes > 0) {
    log("WARNING: experimental seat retries are enabled; each attempt may prolong the vendor hold. This is not a validated recovery policy.");
  }
  let launched = false;
  try {
    const profile = seatRetryMinutes > 0
      ? await launchWithSeatRetry(app, profileId, Date.now() + seatRetryMinutes * 60_000, log)
      : await app.callTool("launch_profile", { profile_id: profileId });
    launched = true;
    const measurement = await measureCdpEndpoint({
      cdpEndpoint: profile.cdpEndpoint,
      probeUrl,
    });
    assertMeasurement(measurement, "CloakBrowser profile");
    return measurement;
  } finally {
    if (launched) {
      await app.callTool("close_profile", { profile_id: profileId });
      // Honour an explicit quiet interval before checking the now-conservative local capacity.
      await delay(settleMs);
      await waitForSeatFree(app, 15_000);
    }
  }
}

async function recoverProfilesAndSeat(app, rows) {
  for (const row of rows) {
    if (!row.id) continue;
    await app.callTool("close_profile", { profile_id: row.id }).catch(() => undefined);
  }
  const runtime = await app.callTool("get_runtime_info", {}).catch(() => null);
  if (
    runtime?.licenseCapacity?.active === 0 &&
    runtime.licenseCapacity.pendingRecovery === 0
  ) {
    return true;
  }
  try {
    await waitForSeatFree(app, 15_000);
    return true;
  } catch {
    return false;
  }
}

function assertMeasurement(measurement, label) {
  assert.equal(measurement?.schemaVersion, 1, `${label} returned an invalid probe schema.`);
  for (const context of ["document", "iframe", "worker", "offscreenCanvas"]) {
    assert.ok(measurement.contexts?.[context], `${label} is missing ${context}.`);
  }
}

async function waitForSeatFree(app, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = await app.callTool("get_runtime_info", {});
    if (
      runtime.licenseCapacity?.free === 1 &&
      runtime.licenseCapacity.active === 0 &&
      runtime.licenseCapacity.pendingRecovery === 0 &&
      runtime.licenseCapacity.cooling === 0
    ) {
      return;
    }
    await delay(250);
  }
  throw new Error("CloakBrowser local seat remains unavailable after close; vendor release is unconfirmed. Stop and respect the reported retry time.");
}

async function callTool(baseUrl, token, name, toolArgs) {
  const response = await rpc(baseUrl, token, "tools/call", { name, arguments: toolArgs });
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string", `${name} returned no text body.`);
  const data = JSON.parse(text);
  if (response.result?.isError) throw new Error(`${name} failed: ${text}`);
  return data;
}

async function rpc(baseUrl, token, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...auth(token),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  assert.equal(response.status, 200, `${method} failed with HTTP ${response.status}.`);
  return response.json();
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitFor(check, timeoutMs, label, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`App exited while waiting for ${label}.`);
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) await delay(100);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  assertMeasurement,
  assertSeatFree,
  launchMktBrowser,
  measureCloakProfile,
  recoverProfilesAndSeat,
  waitForReadyRuntime,
};
