const { spawn, execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { createReadStream, existsSync } = require("node:fs");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

async function startProbeServer(assets) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const asset = assets[pathname];
    if (!asset) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self'; worker-src 'self'",
      "content-type": asset.type,
      "cross-origin-resource-policy": "same-origin",
    });
    response.end(asset.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("CDP websocket closed."));
      }
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP websocket is not open."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

async function measureStockChrome({ chromeExecutable, probeUrl }) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "mkt-stock-fingerprint-"));
  const child = spawn(
    chromeExecutable,
    [
      `--user-data-dir=${userData}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1920,1080",
      probeUrl,
    ],
    { stdio: "ignore", windowsHide: false },
  );
  let browserClient;
  try {
    const { port, browserPath } = await waitForDevToolsActivePort(userData, child, 30_000);
    const browserUrl = `ws://127.0.0.1:${port}${browserPath}`;
    browserClient = new CdpClient(browserUrl);
    await browserClient.connect();
    const measurement = await measureCdpPort(port, probeUrl);
    return {
      measurement,
      executable: await inspectExecutable(chromeExecutable),
    };
  } finally {
    if (browserClient) {
      await browserClient.send("Browser.close").catch(() => undefined);
      browserClient.close();
    }
    await waitForExit(child, 8_000);
    if (child.exitCode === null) child.kill();
    await retryRemove(userData);
  }
}

async function measureCdpEndpoint({ cdpEndpoint, probeUrl }) {
  const endpoint = new URL(cdpEndpoint);
  assertLoopbackEndpoint(endpoint);
  return measureCdpPort(Number(endpoint.port), probeUrl);
}

async function measureCdpPort(port, probeUrl) {
  const target = await waitForPageTarget(port, 30_000);
  const pageClient = new CdpClient(target.webSocketDebuggerUrl);
  await pageClient.connect();
  try {
    await pageClient.send("Page.navigate", { url: probeUrl });
    await waitForPageReady(pageClient, probeUrl, 30_000);
    const evaluation = await pageClient.send("Runtime.evaluate", {
      expression: "globalThis.__runFingerprintMeasurement()",
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluation.exceptionDetails) {
      throw new Error(`Fingerprint probe failed: ${JSON.stringify(evaluation.exceptionDetails)}`);
    }
    return evaluation.result?.value;
  } finally {
    pageClient.close();
  }
}

function assertLoopbackEndpoint(endpoint) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("Refusing a non-loopback CDP endpoint.");
  }
  if (!Number.isInteger(Number(endpoint.port)) || Number(endpoint.port) <= 0) {
    throw new Error("CDP endpoint has no valid port.");
  }
}

async function waitForDevToolsActivePort(userData, child, timeoutMs) {
  const filePath = path.join(userData, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const [portLine, browserPath] = (await readFile(filePath, "utf8")).trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && browserPath) return { port, browserPath };
    }
    if (child.exitCode !== null) throw new Error(`Stock Chrome exited with ${child.exitCode}.`);
    await delay(100);
  }
  throw new Error("Timed out waiting for stock Chrome DevToolsActivePort.");
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
        response.json(),
      );
      const target = targets.find(
        (candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl,
      );
      if (target) return target;
    } catch {
      // Endpoint can race the DevToolsActivePort write.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for a stock Chrome page target.");
}

async function waitForPageReady(client, probeUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await client.send("Runtime.evaluate", {
        expression:
          "({ href: location.href, ready: document.readyState, probe: typeof globalThis.__runFingerprintMeasurement })",
        returnByValue: true,
      });
      const value = result.result?.value;
      if (value?.href === probeUrl && value.ready === "complete" && value.probe === "function")
        return;
    } catch {
      // Navigation replaces the execution context once; retry against the new one.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the stock Chrome probe page.");
}

async function inspectExecutable(executable) {
  const [{ stdout }, sha256] = await Promise.all([
    execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$item = Get-Item -LiteralPath $env:MKT_FINGERPRINT_EXE; [Console]::Out.Write([string]$item.VersionInfo.ProductVersion)",
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        env: { ...process.env, MKT_FINGERPRINT_EXE: executable },
      },
    ),
    sha256File(executable),
  ]);
  return { path: executable, version: stdout.trim(), sha256 };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  await once(stream, "end");
  return hash.digest("hex");
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([once(child, "exit"), delay(timeoutMs)]);
}

async function retryRemove(target) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(250);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  inspectExecutable,
  measureCdpEndpoint,
  measureStockChrome,
  startProbeServer,
};
