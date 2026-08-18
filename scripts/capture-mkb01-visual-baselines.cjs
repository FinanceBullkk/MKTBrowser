#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { existsSync } = require("node:fs");
const { copyFile, mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const OUTPUT_ROOT = path.resolve("assets/images/mkb-01-visual-baselines");

async function main() {
  assert.equal(process.platform, "win32", "MKB-01 visual baselines require Windows.");
  const executable = path.resolve("apps/desktop/release/win-unpacked/MKTBrowser.exe");
  assert.ok(existsSync(executable), "Build the Windows directory package before capture.");

  const chrome = findSystemChrome();
  const userData = await mkdtemp(path.join(os.tmpdir(), "mkt-browser-visual-baseline-"));
  const debugPort = await reservePort();
  const engineRoot = path.join(userData, "chromium", "cft");
  const versionRoot = path.join(engineRoot, "visual-baseline", "chrome-win64");
  await mkdir(versionRoot, { recursive: true });
  await copyFile(chrome, path.join(versionRoot, "chrome.exe"));
  await writeFile(
    path.join(engineRoot, "current.json"),
    JSON.stringify({ version: "visual-baseline", binaryRelative: "chrome-win64/chrome.exe" }),
  );
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({ theme: "dark", mcpHttpEnabled: false, browserEngine: "cft" }),
  );
  await mkdir(OUTPUT_ROOT, { recursive: true });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    executable,
    [`--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`],
    { env, stdio: "ignore", windowsHide: true },
  );

  try {
    const target = await waitForTarget(debugPort, child);
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    try {
      await cdp.call("Page.enable");
      await cdp.call("Runtime.enable");
      await waitForExpression(cdp, "document.readyState === 'complete'");
      await capture(cdp, "onboarding-welcome.png");

      await evaluate(cdp, `findButton("Continue").click()`);
      await waitForExpression(cdp, `document.body.innerText.includes("Name your first profile.")`);
      await capture(cdp, "onboarding-create-profile.png");

      await evaluate(
        cdp,
        `const input=document.querySelector('input'); input.value='Visual baseline'; input.dispatchEvent(new Event('input',{bubbles:true})); findButton("Create profile").click()`,
      );
      await waitForExpression(cdp, `!document.body.innerText.includes("Name your first profile.")`);
      await capture(cdp, "profiles.png");

      await evaluate(cdp, `document.querySelector('button[title^="MCP"]')?.click()`);
      await waitForExpression(cdp, `document.body.innerText.includes("MCP")`);
      await capture(cdp, "mcp.png");

      await evaluate(cdp, `document.querySelector('button[title^="Settings"]')?.click()`);
      await waitForExpression(cdp, `document.body.innerText.includes("Application updates")`);
      await capture(cdp, "settings.png");
    } finally {
      cdp.close();
    }
    process.stdout.write(`Captured MKB-01 visual baselines in ${OUTPUT_ROOT}.\n`);
  } finally {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await rm(userData, { recursive: true, force: true });
  }
}

function findSystemChrome() {
  const candidates = [
    path.join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  ];
  const match = candidates.find((candidate) => candidate && existsSync(candidate));
  assert.ok(match, "Google Chrome is required only to seed the offline visual-baseline engine state.");
  return match;
}

async function waitForTarget(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MKT Browser exited with code ${child.exitCode}.`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const target = targets.find((item) => item.type === "page");
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // DevTools is not listening yet. Every failure before the deadline is expected; the
      // throw below is what reports an endpoint that never came up.
    }
    await delay(200);
  }
  throw new Error("Timed out waiting for the Electron renderer DevTools target.");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await Promise.race([
    once(socket, "open"),
    once(socket, "error").then(([event]) => Promise.reject(event.error ?? event)),
    delay(10_000).then(() => Promise.reject(new Error("Timed out opening the renderer DevTools socket."))),
  ]);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const id = nextId++;
      const response = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
      return Promise.race([
        response,
        delay(10_000).then(() => {
          pending.delete(id);
          throw new Error(`Timed out waiting for CDP ${method}.`);
        }),
      ]);
    },
    close() {
      socket.close();
    },
  };
}

async function capture(cdp, filename) {
  await delay(250);
  const result = await cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(path.join(OUTPUT_ROOT, filename), Buffer.from(result.data, "base64"));
}

async function evaluate(cdp, statement) {
  const expression = `(() => { const findButton=(text)=>[...document.querySelectorAll('button')].find((button)=>button.textContent?.trim()===text); ${statement}; })()`;
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
}

async function waitForExpression(cdp, expression) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await cdp.call("Runtime.evaluate", { expression, returnByValue: true });
    if (result.result?.value === true) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for renderer state: ${expression}`);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
