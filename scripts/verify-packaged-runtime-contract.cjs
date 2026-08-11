#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { existsSync } = require("node:fs");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const EXPECTED_PROVIDER = "mkt-browser";
const EXPECTED_CONTRACT_VERSION = 1;

async function main() {
  if (process.platform !== "win32") {
    throw new Error("The packaged runtime contract verifier currently requires Windows.");
  }

  const executable = path.resolve(
    process.env.MKT_BROWSER_EXECUTABLE ??
      "apps/desktop/release/win-unpacked/MKTBrowser.exe",
  );
  assert.ok(existsSync(executable), "Build the Windows directory package before verification.");

  const userData = await mkdtemp(path.join(os.tmpdir(), "mkt-browser-packaged-contract-"));
  const port = await reservePort();
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
    MKT_BROWSER_MCP_PORT: String(port),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const appPath = process.env.MKT_BROWSER_APP_PATH;
  const child = spawn(
    executable,
    [
      ...(appPath ? [path.resolve(appPath)] : []),
      `--user-data-dir=${userData}`,
      // The verifier exercises MCP only; CI and restricted Windows hosts may not launch GPU/sandbox subprocesses.
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--no-sandbox",
      "--enable-logging=stderr",
      "--v=1",
    ],
    {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    },
  );
  let diagnostics = "";
  const collect = (chunk) => {
    diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  try {
    const tokenPath = path.join(userData, "mcp-token");
    await waitFor(() => existsSync(tokenPath), 30_000, "MCP token file", child);
    const token = (await readFile(tokenPath, "utf8")).trim();
    assert.ok(token, "The packaged app created an empty MCP token.");

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      try {
        const response = await fetch(`${baseUrl}/healthz`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return response.ok;
      } catch {
        return false;
      }
    }, 30_000, "packaged MCP health endpoint", child);

    const initialize = await rpc(baseUrl, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "packaged-contract-verifier", version: "1.0.0" },
      },
    });
    assert.equal(initialize.result?.serverInfo?.name, EXPECTED_PROVIDER);

    const runtime = await callTool(baseUrl, token, "get_runtime_info", {});
    assert.equal(runtime.provider, EXPECTED_PROVIDER);
    assert.equal(runtime.contractVersion, EXPECTED_CONTRACT_VERSION);
    assert.ok(runtime.capabilities.includes("runtime-info-v1"));

    const beforeCreate = await callTool(baseUrl, token, "list_profiles", {});
    const created = await callTool(baseUrl, token, "create_profile", {
      name: "Packaged contract verifier",
      seed: "packaged-contract-verifier-v1",
    });
    assert.equal(typeof created.id, "string");
    assert.ok(created.id);

    const afterCreate = await callTool(baseUrl, token, "list_profiles", {});
    assert.equal(afterCreate.profiles.length, beforeCreate.profiles.length + 1);
    assert.ok(afterCreate.profiles.some((profile) => profile.id === created.id));

    const launch = await callToolResult(baseUrl, token, "launch_profile", {
      profile_id: created.id,
    });
    if (launch.isError) {
      assert.equal(launch.body.error?.code, "ENGINE_UNAVAILABLE");
    } else {
      assert.equal(launch.body.id, created.id);
    }

    const closed = await callTool(baseUrl, token, "close_profile", { profile_id: created.id });
    assert.equal(closed.closed, created.id);
    const deleted = await callTool(baseUrl, token, "delete_profile", { profile_id: created.id });
    assert.equal(deleted.deleted, created.id);

    const afterDelete = await callTool(baseUrl, token, "list_profiles", {});
    assert.equal(afterDelete.profiles.length, beforeCreate.profiles.length);
    assert.ok(!afterDelete.profiles.some((profile) => profile.id === created.id));

    process.stdout.write("Packaged MKT Browser runtime and profile lifecycle contracts passed.\n");
  } catch (error) {
    if (diagnostics.trim()) {
      error.message += `\nPackaged app diagnostics:\n${diagnostics.trim()}`;
    }
    throw error;
  } finally {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await rm(userData, { recursive: true, force: true });
  }
}

async function callTool(baseUrl, token, name, toolArgs) {
  const result = await callToolResult(baseUrl, token, name, toolArgs);
  assert.equal(result.isError, false, `${name} returned an MCP tool error.`);
  return result.body;
}

async function callToolResult(baseUrl, token, name, toolArgs) {
  const response = await rpc(baseUrl, token, {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name, arguments: toolArgs },
  });
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string", `${name} returned no text body.`);
  return { body: JSON.parse(text), isError: response.result?.isError === true };
}

async function rpc(baseUrl, token, body) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `MCP request failed with HTTP ${response.status}.`);
  return response.json();
}

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitFor(check, timeoutMs, label, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged app exited with code ${child.exitCode} while waiting for ${label}.`);
    }
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
