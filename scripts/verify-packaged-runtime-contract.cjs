#!/usr/bin/env node

const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { createReadStream, existsSync, readFileSync } = require("node:fs");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  installSystemChromeEngineFixture,
  removeSystemChromeEngineFixture,
} = require("./system-chrome-engine-fixture.cjs");

const EXPECTED_PROVIDER = "mkt-browser";
const EXPECTED_CONTRACT_VERSION = readContractVersion(
  readFileSync(path.resolve(__dirname, "..", "packages", "types", "src", "index.ts"), "utf8"),
);
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const MCP_REQUEST_TIMEOUT_MS = 90_000;
const execFileAsync = promisify(execFile);

async function main() {
  if (process.platform !== "win32") {
    throw new Error("The packaged runtime contract verifier currently requires Windows.");
  }

  const options = parseOptions(process.argv.slice(2));
  const executable = path.resolve(
    process.env.MKT_BROWSER_EXECUTABLE ?? "apps/desktop/release/win-unpacked/MKTBrowser.exe",
  );
  assert.ok(existsSync(executable), "Build the Windows directory package before verification.");
  verifyPackagedExtractionDependencies(executable);

  const artifact = await collectArtifactEvidence(executable, options.artifactManifest);
  process.stdout.write(
    `Packaged artifact evidence sourceSha=${artifact.sourceSha ?? "local"} ` +
      `artifactSha256=${artifact.artifactSha256 ?? "none"} ` +
      `executableSha256=${artifact.executableSha256} appAsarSha256=${artifact.appAsarSha256}\n`,
  );

  const timings = [];
  for (let iteration = 1; iteration <= options.repeat; iteration++) {
    const startedAtMs = Date.now();
    const iterationEvidence = {};
    try {
      await runIteration(executable, iteration, options, iterationEvidence);
      timings.push({
        iteration,
        status: "passed",
        elapsedMs: Date.now() - startedAtMs,
        ...iterationEvidence,
      });
      await writeTimings(options.timingsOutput, artifact, timings);
    } catch (error) {
      timings.push({
        iteration,
        status: "failed",
        elapsedMs: Date.now() - startedAtMs,
        ...iterationEvidence,
      });
      await writeTimings(options.timingsOutput, artifact, timings);
      throw error;
    }
  }
  process.stdout.write(
    `Packaged runtime contract completed ${options.repeat}/${options.repeat} iterations.\n`,
  );
}

async function runIteration(executable, iteration, options, iterationEvidence) {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), `mkt-browser-packaged-contract-${iteration}-`),
  );
  const isolatedLocalAppData = path.join(userData, "local-app-data");
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
    await mkdir(isolatedLocalAppData, { recursive: true });
    engineFixture = await installSystemChromeEngineFixture(userData);
    iterationEvidence.engine = {
      version: engineFixture.version,
      sha256: engineFixture.sha256,
    };
    process.stdout.write(
      `Packaged engine evidence iteration=${iteration} version=${engineFixture.version} ` +
        `sha256=${engineFixture.sha256}\n`,
    );
    // Checked before the launch so a mismatch costs a fixture install, not a full cold launch.
    assertExpectedEngine(options.expectedEngineVersion, engineFixture);
    const port = await reservePort();
    const env = {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      LOCALAPPDATA: isolatedLocalAppData,
      MKT_BROWSER_ALLOW_UNPINNED_ENGINE: "1",
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
          const response = await withHttpDeadline(
            (signal) =>
              fetch(`${baseUrl}/healthz`, {
                headers: { authorization: `Bearer ${token}` },
                signal,
              }),
            HEALTH_REQUEST_TIMEOUT_MS,
          );
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
      "refresh_license_capacity",
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
    assert.equal(
      blockedLaunch.body.error?.code,
      "PROXY_REJECTED",
      `Managed invalid-proxy launch returned the wrong error: ${describeToolBody(blockedLaunch.body)}`,
    );

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

    process.stdout.write(
      `Packaged MKT Browser runtime and profile lifecycle contracts passed ` +
        `(iteration ${iteration}/${options.repeat}).\n`,
    );
  } catch (error) {
    const failureError = error instanceof Error ? error : new Error(String(error));
    const snapshot = await collectFailureSnapshot(userData, child, launchedPid).catch(
      (snapshotError) => ({
        snapshotError: snapshotError?.code ?? snapshotError?.name ?? "snapshot-failed",
      }),
    );
    const combinedDiagnostics = [
      `Verifier failure: ${failureError.message}`,
      diagnostics.trim(),
      `Verifier failure snapshot: ${JSON.stringify(snapshot)}`,
    ]
      .filter(Boolean)
      .join("\n");
    const sanitizedDiagnostics = sanitizeDiagnostics(combinedDiagnostics);
    failureError.message += `\nPackaged app diagnostics:\n${sanitizedDiagnostics}`;
    if (options.diagnosticsDir) {
      await mkdir(options.diagnosticsDir, { recursive: true });
      await writeFile(
        path.join(options.diagnosticsDir, `iteration-${iteration}.log`),
        `${sanitizedDiagnostics}\n`,
        "utf8",
      );
    }
    failure = failureError;
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
      // Windows can release Electron helper-process handles shortly after the parent exits. Keep
      // cleanup strict, but tolerate that bounded release window instead of reporting a false
      // packaged-contract failure on a transient EBUSY.
      await rm(userData, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      const details = sanitizeDiagnostics(cleanupErrors.map((error) => error.message).join("\n"));
      if (failure) failure.message += `\nPackaged verifier cleanup failed:\n${details}`;
      else failure = new Error(`Packaged verifier cleanup failed:\n${details}`);
    }
  }
  if (failure) throw failure;
}

// The verifier links whichever Google Chrome the runner image ships, so the engine under test can
// change between runs without anything in this repository changing. That is tolerable for one run,
// which records the version it measured, but a multi-run stability streak is a claim about a single
// engine. Declaring the expected version turns a silent runner-image refresh into a red run.
//
// The expectation stays opt-in: a developer verifying locally has a different Chrome than the runner
// and must not be forced to match it. Only a declared streak sets a value.
function assertExpectedEngine(expectedVersion, observed) {
  if (!expectedVersion) return;
  if (observed.version === expectedVersion) return;
  throw new Error(
    `Packaged verifier engine mismatch. Expected "${expectedVersion}" but the runner supplied ` +
      `"${observed.version}" (sha256 ${observed.sha256}). A stability streak measured across two ` +
      `engines is not a streak; re-declare the expectation and start the count again.`,
  );
}

function readContractVersion(source) {
  const match = /export const MKT_BROWSER_CONTRACT_VERSION = (\d+);/.exec(source);
  if (!match) throw new Error("Cannot read MKT_BROWSER_CONTRACT_VERSION from the runtime contract.");
  return Number(match[1]);
}

function parseOptions(args) {
  const options = {
    repeat: 1,
    timingsOutput: process.env.MKT_BROWSER_TIMINGS_OUTPUT,
    diagnosticsDir: process.env.MKT_BROWSER_DIAGNOSTICS_DIR,
    artifactManifest: process.env.MKT_BROWSER_ARTIFACT_MANIFEST,
    expectedEngineVersion: (process.env.MKT_BROWSER_EXPECTED_ENGINE_VERSION ?? "").trim(),
  };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !["--repeat", "--timings-output", "--diagnostics-dir", "--artifact-manifest"].includes(name)
    ) {
      throw new Error(`Unknown packaged verifier option: ${name}`);
    }
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    index += 1;
    if (name === "--repeat") {
      options.repeat = Number(value);
      if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 100) {
        throw new Error("--repeat must be an integer from 1 to 100");
      }
    } else if (name === "--timings-output") {
      options.timingsOutput = path.resolve(value);
    } else if (name === "--diagnostics-dir") {
      options.diagnosticsDir = path.resolve(value);
    } else {
      options.artifactManifest = path.resolve(value);
    }
  }
  return options;
}

async function collectArtifactEvidence(executable, manifestPath) {
  const appAsar = path.join(path.dirname(executable), "resources", "app.asar");
  const evidence = {
    sourceSha: null,
    artifactSha256: null,
    executableSha256: await sha256File(executable),
    appAsarSha256: await sha256File(appAsar),
  };
  if (!manifestPath) return evidence;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.match(String(manifest.sourceSha ?? ""), /^[0-9a-f]{40}$/i, "Invalid artifact source SHA.");
  assert.match(String(manifest.sha256 ?? ""), /^[0-9a-f]{64}$/i, "Invalid artifact SHA-256.");
  evidence.sourceSha = manifest.sourceSha;
  evidence.artifactSha256 = manifest.sha256.toLowerCase();
  return evidence;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  await once(stream, "end");
  return hash.digest("hex");
}

async function writeTimings(outputPath, artifact, iterations) {
  if (!outputPath) return;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ artifact, iterations }, null, 2)}\n`, "utf8");
}

function sanitizeDiagnostics(value) {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:https?|socks5?):\/\/[^\s/@]+@/gi, (match) => {
      const schemeEnd = match.indexOf("//") + 2;
      return `${match.slice(0, schemeEnd)}[redacted]@`;
    })
    .replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, "[redacted-path]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
    .replace(/\[(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]*\]/gi, "[redacted-ip]")
    .replace(/(^|[\s=])(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}(?=$|[\s,])/gi, "$1[redacted-ip]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[redacted-id]")
    .replace(/\b(Bearer|token|password|proxy|key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

async function collectFailureSnapshot(userData, child, launchedPid) {
  const script = [
    "$needle = $env:MKT_BROWSER_SNAPSHOT_USER_DATA",
    "$processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { ([string]$_.CommandLine).IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = [string]$_.Name } })",
    "$pids = @($processes | Select-Object -ExpandProperty pid)",
    "$connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)",
    "$listeners = @($connections | Where-Object { $pids -contains [int]$_.OwningProcess } | ForEach-Object { $scope = if ($_.LocalAddress -eq '127.0.0.1') { 'loopback-v4' } elseif ($_.LocalAddress -eq '::1') { 'loopback-v6' } elseif ($_.LocalAddress -in @('0.0.0.0','::')) { 'wildcard' } else { 'other' }; [pscustomobject]@{ pid = [int]$_.OwningProcess; port = [int]$_.LocalPort; addressScope = $scope } })",
    "$fixed = @($connections | Where-Object { $_.LocalPort -in @(9222,9223) } | ForEach-Object { $scope = if ($_.LocalAddress -eq '127.0.0.1') { 'loopback-v4' } elseif ($_.LocalAddress -eq '::1') { 'loopback-v6' } elseif ($_.LocalAddress -in @('0.0.0.0','::')) { 'wildcard' } else { 'other' }; [pscustomobject]@{ pid = [int]$_.OwningProcess; port = [int]$_.LocalPort; addressScope = $scope } })",
    "$result = [pscustomobject]@{ processes = $processes; listeners = $listeners; fixedPortListeners = $fixed }",
    "[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))",
  ].join("; ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      env: { ...process.env, MKT_BROWSER_SNAPSHOT_USER_DATA: userData },
    },
  );
  const osSnapshot = JSON.parse(stdout);
  return {
    appPid: child?.pid ?? null,
    appExitCode: child?.exitCode ?? null,
    appSignalCode: child?.signalCode ?? null,
    launchedBrowserPid: launchedPid ?? null,
    ...osSnapshot,
  };
}

function verifyPackagedExtractionDependencies(executable) {
  const archive = path.join(path.dirname(executable), "resources", "app.asar");
  assert.ok(existsSync(archive), "The packaged application is missing resources/app.asar.");
  const asar = require(
    require.resolve("@electron/asar", { paths: [path.resolve("apps/desktop")] }),
  );
  const packageJson = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  const entries = asar.listPackage(archive).map((entry) => entry.replace(/^\\/, ""));
  const hasPackage = (name) =>
    entries.some((entry) => new RegExp(`(^|[\\\\/])${name}([\\\\/]|$)`, "i").test(entry));

  assert.equal(
    packageJson.dependencies?.["extract-zip"],
    undefined,
    "The packaged metadata still declares extract-zip.",
  );
  assert.equal(
    hasPackage("extract-zip"),
    false,
    "The packaged app.asar still contains extract-zip.",
  );
  assert.equal(
    packageJson.dependencies?.yauzl,
    "3.4.0",
    "The packaged metadata does not pin yauzl 3.4.0.",
  );
  assert.equal(hasPackage("yauzl"), true, "The packaged app.asar is missing yauzl.");
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
  return withHttpDeadline(async (signal) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    assert.equal(response.status, 200, `MCP request failed with HTTP ${response.status}.`);
    return response.json();
  }, MCP_REQUEST_TIMEOUT_MS);
}

function withHttpDeadline(operation, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`HTTP request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const request = Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([request, deadline]).finally(() => {
    clearTimeout(timeout);
  });
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

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${sanitizeDiagnostics(error.stack ?? error.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertExpectedEngine,
  parseOptions,
  readContractVersion,
  sanitizeDiagnostics,
  withHttpDeadline,
};
