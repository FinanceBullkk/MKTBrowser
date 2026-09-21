const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { existsSync } = require("node:fs");
const { readFile, writeFile } = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { measureCdpEndpoint } = require("./fingerprint-measurement-cdp.cjs");

// The integrated product now performs a bounded provider-capacity check. A fixed delay is not
// release evidence, so the measurement path defaults to no artificial wait and records the
// provider response-completion timestamp instead.
const REMOTE_SEAT_SETTLE_MS = 0;

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
  const requestedAt = new Date().toISOString();
  const refreshed = await app.callTool("refresh_license_capacity", {});
  const completedAt = new Date().toISOString();
  const capacity = refreshed?.licenseCapacity;
  const check = { requestedAt, completedAt, capacity };
  try {
    assert.equal(capacity?.total, 1, `CloakBrowser has an unexpected seat total at ${stage}.`);
    assert.equal(capacity?.free, 1, `CloakBrowser seat is not free at ${stage}.`);
    assert.equal(capacity?.active, 0, `CloakBrowser still has an active local seat at ${stage}.`);
    assert.equal(
      capacity?.pendingRecovery,
      0,
      `CloakBrowser still has pending recovery at ${stage}.`,
    );
    assert.equal(capacity?.cooling, 0, `CloakBrowser seat is still cooling at ${stage}.`);
    assert.equal(capacity?.availability, "ready", `CloakBrowser capacity is not ready at ${stage}.`);
    assert.equal(
      capacity?.reason,
      "CAPACITY_AVAILABLE",
      `CloakBrowser capacity was not verified available at ${stage}.`,
    );
    assert.equal(capacity?.vendorActive, 0, `Vendor capacity is occupied at ${stage}.`);
    assert.ok(
      Number.isSafeInteger(capacity?.vendorLimit) && capacity.vendorLimit >= 1,
      `Vendor capacity limit is invalid at ${stage}.`,
    );
    assert.ok(
      Number.isFinite(Date.parse(capacity?.observedAt)),
      `Vendor response-completion time is missing at ${stage}.`,
    );
    assert.ok(
      Number.isFinite(Date.parse(capacity?.freshUntil)),
      `Vendor freshness deadline is missing at ${stage}.`,
    );
    return check;
  } catch (error) {
    if (error && typeof error === "object") error.capacityCheck = check;
    throw error;
  }
}

function capacityCheckFromError(error) {
  if (!error || typeof error !== "object") return null;
  if (error.capacityCheck) return error.capacityCheck;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const check = capacityCheckFromError(nested);
      if (check) return check;
    }
  }
  return null;
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
      // An optional diagnostic wait is recorded by the caller. Availability still comes from one
      // explicit provider refresh, never from the timer itself.
      if (settleMs > 0) await delay(settleMs);
      await assertSeatFree(app, `after closing ${profileId}`);
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
  capacityCheckFromError,
  launchMktBrowser,
  measureCloakProfile,
  recoverProfilesAndSeat,
  waitForReadyRuntime,
};
