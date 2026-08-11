#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { existsSync } = require("node:fs");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));

async function main() {
  if (process.platform !== "win32") throw new Error("Fingerprint measurement requires Windows.");
  if (!args.output) throw new Error("Pass --output <json-path>.");

  const executable = path.resolve("apps/desktop/release/win-unpacked/MKTBrowser.exe");
  assert.ok(existsSync(executable), "Build the Windows directory package before measurement.");

  const userData = path.join(os.tmpdir(), "mkt-browser-mkb01e-fingerprint");
  await mkdir(userData, { recursive: true });
  const port = await reservePort();
  const env = { ...process.env, MKT_BROWSER_MCP_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(executable, [`--user-data-dir=${userData}`], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let diagnostics = "";
  const collect = (chunk) => {
    diagnostics = (diagnostics + chunk.toString("utf8")).slice(-12_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  let profileId;
  let profileLaunched = false;
  let failure = null;
  const cleanupErrors = [];
  try {
    const tokenPath = path.join(userData, "mcp-token");
    await waitFor(() => existsSync(tokenPath), 30_000, "MCP token", child);
    const token = (await readFile(tokenPath, "utf8")).trim();
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      try {
        return (await fetch(`${baseUrl}/healthz`, { headers: auth(token) })).ok;
      } catch {
        return false;
      }
    }, 30_000, "MCP health endpoint", child);

    await rpc(baseUrl, token, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mkb01e-fingerprint-measurer", version: "1.0.0" },
    });

    let runtime = await callTool(baseUrl, token, "get_runtime_info", {});
    const created = await callTool(baseUrl, token, "create_profile", {
      name: `MKB-01E fingerprint ${args.label ?? "measurement"}`,
      seed: "mkb-01e-fixed-seed-v1",
      fingerprint: {
        device: "windows-desktop-nvidia",
        localeId: "en-US",
        timezone: "America/New_York",
        screen: { width: 1920, height: 1080 },
        hardwareConcurrency: 8,
        deviceMemory: 8,
      },
    });
    profileId = created.id;
    await waitFor(async () => {
      try {
        await callTool(baseUrl, token, "launch_profile", { profile_id: profileId });
        return true;
      } catch (error) {
        if (!String(error.message).includes("ENGINE_UNAVAILABLE")) throw error;
        return false;
      }
    }, 600_000, "browser engine readiness", child);
    profileLaunched = true;
    runtime = await callTool(baseUrl, token, "get_runtime_info", {});

    const measured = await callTool(baseUrl, token, "evaluate_js", {
      profile_id: profileId,
      expression: `(() => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl");
        const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
        return {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          languages: [...navigator.languages],
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory ?? null,
          webdriver: navigator.webdriver,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
          webglVendor: gl && ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
          webglRenderer: gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null
        };
      })()`,
    });

    const fingerprint = measured?.result?.value;
    assert.ok(fingerprint && typeof fingerprint === "object", "Fingerprint evaluation returned no value.");
    const report = {
      label: args.label ?? null,
      measuredAt: new Date().toISOString(),
      runtime,
      configuredFingerprint: created.fingerprint,
      observedFingerprint: fingerprint,
    };
    await mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
    await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`Fingerprint measurement written to ${path.resolve(args.output)}\n`);
  } catch (error) {
    failure = error;
  } finally {
    if (profileId) {
      const tokenPath = path.join(userData, "mcp-token");
      if (existsSync(tokenPath)) {
        try {
          const token = (await readFile(tokenPath, "utf8")).trim();
          const baseUrl = `http://127.0.0.1:${port}`;
          if (profileLaunched) {
            try {
              await callTool(baseUrl, token, "close_profile", { profile_id: profileId });
            } catch (error) {
              cleanupErrors.push(new Error("Failed to close the fingerprint profile.", { cause: error }));
            }
          }
          try {
            await callTool(baseUrl, token, "delete_profile", { profile_id: profileId });
          } catch (error) {
            cleanupErrors.push(new Error("Failed to delete the fingerprint profile.", { cause: error }));
          }
        } catch (error) {
          cleanupErrors.push(new Error("Failed to initialize fingerprint cleanup.", { cause: error }));
        }
      } else {
        cleanupErrors.push(new Error("Failed to clean up the fingerprint profile: MCP token is missing."));
      }
    }
    child.kill();
    await Promise.race([once(child, "exit"), delay(5_000)]);
  }

  if (failure) {
    const error = failure instanceof Error ? failure : new Error(String(failure));
    if (diagnostics.trim()) error.message += `\nPackaged app diagnostics:\n${diagnostics.trim()}`;
    if (cleanupErrors.length > 0) error.message += `\n${formatCleanupErrors(cleanupErrors)}`;
    throw error;
  }
  if (cleanupErrors.length > 0) throw new Error(formatCleanupErrors(cleanupErrors));
}

function formatCleanupErrors(errors) {
  return `Fingerprint cleanup failed:\n${errors.map((error) => `- ${describeError(error)}`).join("\n")}`;
}

function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof Error && error.cause ? `${message} Cause: ${describeError(error.cause)}` : message;
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
    headers: { ...auth(token), accept: "application/json, text/event-stream", "content-type": "application/json" },
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

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i += 2) parsed[values[i].replace(/^--/, "")] = values[i + 1];
  return parsed;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
