#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { existsSync } = require("node:fs");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  installSystemChromeEngineFixture,
  removeSystemChromeEngineFixture,
} = require("./system-chrome-engine-fixture.cjs");

const EXPECTED_PROVIDER = "mkt-browser";
const EXPECTED_CONTRACT_VERSION = 4;

async function main() {
  if (process.platform !== "win32") {
    throw new Error("The packaged runtime contract verifier currently requires Windows.");
  }

  const executable = path.resolve(
    process.env.MKT_BROWSER_EXECUTABLE ?? "apps/desktop/release/win-unpacked/MKTBrowser.exe",
  );
  assert.ok(existsSync(executable), "Build the Windows directory package before verification.");

  const userData = await mkdtemp(path.join(os.tmpdir(), "mkt-browser-packaged-contract-"));
  let engineFixture;
  let child;
  let diagnostics = "";
  let baseUrl;
  let token;
  let createdProfileId;
  let lifecycleProfileId;
  let launchedPid;
  let failure;
  try {
    engineFixture = await installSystemChromeEngineFixture(userData);
    const port = await reservePort();
    const env = {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      MKT_BROWSER_PACKAGED_CONTRACT_VERIFY: "1",
      MKT_BROWSER_MCP_PORT: String(port),
    };
    delete env.ELECTRON_RUN_AS_NODE;

    const appPath = process.env.MKT_BROWSER_APP_PATH;
    child = spawn(
      executable,
      [
        ...(appPath ? [path.resolve(appPath)] : []),
        `--user-data-dir=${userData}`,
        // The verifier exercises MCP only; restricted hosts may not launch GPU/sandbox subprocesses.
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
    const collect = (chunk) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const tokenPath = path.join(userData, "mcp-token");
    await waitFor(() => existsSync(tokenPath), 30_000, "MCP token file", child);
    token = (await readFile(tokenPath, "utf8")).trim();
    assert.ok(token, "The packaged app created an empty MCP token.");

    baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => {
        try {
          const response = await fetch(`${baseUrl}/healthz`, {
            headers: { authorization: `Bearer ${token}` },
          });
          return response.ok;
        } catch {
          return false;
        }
      },
      30_000,
      "packaged MCP health endpoint",
      child,
    );

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

    const tools = await listTools(baseUrl, token);
    const toolNames = tools.map((tool) => tool.name);
    for (const required of [
      "get_runtime_info",
      "list_profiles",
      "create_profile",
      "update_profile",
      "launch_managed_profile",
      "close_profile",
    ]) {
      assert.ok(toolNames.includes(required), `Missing profile-management tool: ${required}`);
    }
    for (const forbidden of [
      "delete_profile",
      "navigate",
      "click",
      "type",
      "extract",
      "get_cookies",
      "cdp_send",
    ]) {
      assert.ok(
        !toolNames.includes(forbidden),
        `Profile token exposed forbidden tool: ${forbidden}`,
      );
    }

    const runtime = await callTool(baseUrl, token, "get_runtime_info", {});
    assert.equal(runtime.provider, EXPECTED_PROVIDER);
    assert.equal(runtime.contractVersion, EXPECTED_CONTRACT_VERSION);
    assert.ok(runtime.capabilities.includes("runtime-info-v1"));
    assert.ok(runtime.capabilities.includes("atomic-launch-v1"));
    assert.ok(runtime.capabilities.includes("managed-profile-v1"));
    assert.ok(runtime.capabilities.includes("operation-diagnostics-v1"));

    const beforeCreate = await callTool(baseUrl, token, "list_profiles", {});
    const createRequest = {
      name: "Packaged contract verifier",
      seed: "packaged-contract-verifier-v1",
      external_ref: "packaged-contract-verifier",
      request_id: "packaged-contract-verifier-v1",
    };
    const created = await callTool(baseUrl, token, "create_profile", {
      ...createRequest,
      operation_id: "packaged-create-1",
    });
    assert.equal(typeof created.id, "string");
    assert.ok(created.id);
    assert.equal(created.created, true);
    assert.equal(created.managed, true);
    assert.equal(created.diagnostic?.operationId, "packaged-create-1");
    assert.equal(created.diagnostic?.requestId, createRequest.request_id);
    createdProfileId = created.id;

    const retried = await callTool(baseUrl, token, "create_profile", {
      ...createRequest,
      operation_id: "packaged-create-2",
    });
    assert.equal(retried.id, created.id);
    assert.equal(retried.created, false);
    assert.equal(retried.diagnostic?.operationId, "packaged-create-2");

    const conflictingCreate = await callToolResult(baseUrl, token, "create_profile", {
      ...createRequest,
      name: "Conflicting packaged contract verifier",
    });
    assert.equal(conflictingCreate.isError, true);
    assert.equal(conflictingCreate.body.error?.code, "INVALID_INPUT");

    const afterCreate = await callTool(baseUrl, token, "list_profiles", {});
    assert.equal(afterCreate.profiles.length, beforeCreate.profiles.length + 1);
    assert.ok(afterCreate.profiles.some((profile) => profile.id === created.id));

    const updated = await callTool(baseUrl, token, "update_profile", {
      profile_id: created.id,
      name: "Packaged contract verifier updated",
      tags: ["packaged-contract", "lifecycle"],
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "Packaged contract verifier updated");
    assert.deepEqual(updated.tags, ["packaged-contract", "lifecycle"]);

    const invalidProxy = await callToolResult(baseUrl, token, "update_profile", {
      profile_id: created.id,
      proxy: { type: "http", host: "127.0.0.1", port: 0 },
    });
    assert.equal(invalidProxy.isError, true, "update_profile accepted proxy port 0.");
    assert.equal(invalidProxy.body.error?.code, "INVALID_INPUT");

    const afterUpdate = await callTool(baseUrl, token, "list_profiles", {});
    const persisted = afterUpdate.profiles.find((profile) => profile.id === created.id);
    assert.equal(persisted?.name, "Packaged contract verifier updated");
    assert.deepEqual(persisted?.tags, ["packaged-contract", "lifecycle"]);
    assert.equal(persisted?.proxy, null);

    const directLaunch = await callToolResult(baseUrl, token, "launch_profile", {
      profile_id: created.id,
    });
    assert.equal(directLaunch.isError, true);
    assert.equal(directLaunch.body.error?.code, "MANAGED_PROFILE_LOCKED");

    const pageControl = await callToolResult(baseUrl, token, "navigate", {
      profile_id: created.id,
      url: "https://example.com",
    });
    assert.equal(pageControl.isError, true);
    assert.equal(pageControl.body.error?.code, "UNKNOWN_TOOL");

    const blockedLaunch = await callToolResult(baseUrl, token, "launch_managed_profile", {
      profile_id: created.id,
      proxy: { type: "http", host: "127.0.0.1", port: 9 },
      operation_id: "packaged-launch-1",
    });
    assert.equal(blockedLaunch.isError, true);
    assert.equal(blockedLaunch.body.error?.code, "PROXY_REJECTED");

    const lifecycleProfile = await callTool(baseUrl, token, "create_profile", {
      name: "Packaged browser lifecycle verifier",
      seed: "packaged-browser-lifecycle-verifier-v1",
    });
    assert.equal(lifecycleProfile.managed, false);
    lifecycleProfileId = lifecycleProfile.id;

    const launch = await callTool(baseUrl, token, "launch_profile", {
      profile_id: lifecycleProfile.id,
    });
    assert.equal(launch.id, lifecycleProfile.id);
    assert.equal(Number.isInteger(launch.pid), true);
    launchedPid = launch.pid;
    assert.equal(isProcessRunning(launch.pid), true, "Launched Chrome process is not running.");

    const closed = await callTool(baseUrl, token, "close_profile", {
      profile_id: lifecycleProfile.id,
    });
    assert.equal(closed.closed, lifecycleProfile.id);
    await waitFor(
      () => !isProcessRunning(launch.pid),
      10_000,
      `Chrome process ${launch.pid} to exit after close_profile`,
      child,
    );
    lifecycleProfileId = undefined;

    const afterLifecycle = await callTool(baseUrl, token, "list_profiles", {});
    assert.equal(afterLifecycle.profiles.length, beforeCreate.profiles.length + 2);
    assert.ok(afterLifecycle.profiles.some((profile) => profile.id === created.id));
    assert.ok(afterLifecycle.profiles.some((profile) => profile.id === lifecycleProfile.id));

    process.stdout.write("Packaged MKT Browser runtime and profile lifecycle contracts passed.\n");
  } catch (error) {
    if (diagnostics.trim()) {
      error.message += `\nPackaged app diagnostics:\n${diagnostics.trim()}`;
    }
    failure = error;
  } finally {
    const cleanupErrors = [];
    if (child && baseUrl && token && createdProfileId) {
      try {
        const closeResult = await callToolResult(baseUrl, token, "close_profile", {
          profile_id: createdProfileId,
        });
        assert.equal(closeResult.isError, false, "Cleanup close_profile returned an MCP error.");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (child && baseUrl && token && lifecycleProfileId) {
      try {
        await callToolResult(baseUrl, token, "close_profile", {
          profile_id: lifecycleProfileId,
        });
        if (launchedPid) {
          await waitFor(
            () => !isProcessRunning(launchedPid),
            10_000,
            `Chrome process ${launchedPid} to exit during cleanup`,
            child,
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (child) {
      try {
        await stopChild(child, "packaged MKT Browser app");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      if (engineFixture) await removeSystemChromeEngineFixture(engineFixture);
      await rm(userData, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      const details = cleanupErrors.map((error) => error.message).join("\n");
      if (failure) failure.message += `\nPackaged verifier cleanup failed:\n${details}`;
      else failure = new Error(`Packaged verifier cleanup failed:\n${details}`);
    }
  }
  if (failure) throw failure;
}

async function callTool(baseUrl, token, name, toolArgs) {
  const result = await callToolResult(baseUrl, token, name, toolArgs);
  // The body carries the tool's own diagnostics, and this runs on a CI machine nobody can attach a
  // debugger to. Asserting without it reduced a real failure to "launch_profile returned an MCP
  // tool error" with nothing to act on, so the run had to be repeated just to learn what broke.
  assert.equal(
    result.isError,
    false,
    `${name} returned an MCP tool error: ${describeToolBody(result.body)}`,
  );
  return result.body;
}

/** Bounded so a large diagnostic payload stays readable in a CI log instead of flooding it. */
function describeToolBody(body) {
  let text;
  try {
    text = JSON.stringify(body);
  } catch {
    text = String(body);
  }
  if (typeof text !== "string") return String(body);
  return text.length > 2000 ? `${text.slice(0, 2000)}… (truncated)` : text;
}

async function listTools(baseUrl, token) {
  const response = await rpc(baseUrl, token, {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/list",
    params: {},
  });
  assert.ok(Array.isArray(response.result?.tools), "tools/list returned no tool inventory.");
  return response.result.tools;
}

async function callToolResult(baseUrl, token, name, toolArgs) {
  const response = await rpc(baseUrl, token, {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name, arguments: toolArgs },
  });
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(
    typeof text,
    "string",
    `${name} returned no text body: ${describeToolBody(response.result)}`,
  );
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
    if (child.exitCode !== null || child.signalCode !== null) {
      const outcome =
        child.exitCode !== null ? `code ${child.exitCode}` : `signal ${child.signalCode}`;
      throw new Error(`Packaged app exited with ${outcome} while waiting for ${label}.`);
    }
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function stopChild(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exitPromise = once(child, "exit");
  child.kill();
  let timeout;
  try {
    await Promise.race([
      exitPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label} (PID ${child.pid}) to exit.`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
