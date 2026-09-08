import assert from "node:assert/strict";
import test from "node:test";
import { WindowsRelayCompanion, type WindowsRelayCompanionOptions } from "./windows-relay-companion.ts";

const base: WindowsRelayCompanionOptions = {
  scriptPath: "C:\\app\\resources\\installer\\windows-relay-companion.ps1",
  browserPath: "C:\\app\\MKTBrowser.exe",
  startupDirectory: "C:\\user\\Startup",
  systemRoot: "C:\\Windows",
  browserProcessId: 1234,
  platform: "win32",
  pathExists: () => true,
  execFile: async () => ({ stdout: '{"status":"running"}', stderr: "" }),
  fetch: async () => new Response('{"relayVersion":16,"ok":true}'),
};

test("uses only the packaged helper and fixed arguments, then probes loopback without redirects", async () => {
  const companion = new WindowsRelayCompanion({
    ...base,
    execFile: async (file, args, options) => {
      assert.match(file, /Windows[/\\]System32[/\\]WindowsPowerShell[/\\]v1\.0[/\\]powershell\.exe$/);
      assert.deepEqual(args, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File",
        base.scriptPath, "-ExpectedBrowserPath", base.browserPath,
        "-ExpectedBrowserProcessId", "1234", "-StartupDirectory", base.startupDirectory]);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 18_000);
      assert.equal(options.maxBuffer, 4096);
      assert.equal(options.signal.aborted, false);
      return { stdout: '{"status":"started"}', stderr: "" };
    },
    fetch: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:47821/health");
      assert.equal(options?.redirect, "error");
      return new Response('{"relayVersion":16,"ok":true}');
    },
  });
  assert.equal((await companion.start()).status, "started");
});

test("HTTP 400 unconfigured or retirement health still proves a responsive Relay", async () => {
  const companion = new WindowsRelayCompanion({ ...base,
    fetch: async () => new Response('{"relayVersion":16,"ok":false,"configured":false}', { status: 400 }),
  });
  assert.equal((await companion.start()).status, "running");
});

test("coalesces concurrent requests but permits later explicit retries", async () => {
  let resolveExecution: ((value: { stdout: string; stderr: string }) => void) | undefined;
  let calls = 0;
  const companion = new WindowsRelayCompanion({ ...base, execFile: () => {
    calls += 1;
    return new Promise((resolve) => { resolveExecution = resolve; });
  } });
  const first = companion.start();
  assert.equal(companion.start(), first);
  assert.equal(calls, 1);
  resolveExecution?.({ stdout: '{"status":"starting"}', stderr: "" });
  assert.equal((await first).status, "starting");
  const retry = companion.start();
  assert.equal(calls, 2);
  resolveExecution?.({ stdout: '{"status":"running"}', stderr: "" });
  assert.equal((await retry).status, "running");
});

test("dispose aborts execution, prevents health requests and permanently disables launch", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  let resolveExecution: ((value: { stdout: string; stderr: string }) => void) | undefined;
  const companion = new WindowsRelayCompanion({ ...base,
    execFile: async (_file, _args, options) => {
      calls += 1;
      signal = options.signal;
      return await new Promise((resolve) => { resolveExecution = resolve; });
    },
    fetch: async () => { throw new Error("must not request health after dispose"); },
  });
  const pending = companion.start();
  companion.dispose();
  assert.equal(signal?.aborted, true);
  resolveExecution?.({ stdout: '{"status":"started"}', stderr: "" });
  assert.equal((await pending).status, "cancelled");
  assert.equal((await companion.start()).status, "cancelled");
  assert.equal(calls, 1);
});

test("blocked and starting processes never cause a retry or health probe", async () => {
  for (const status of ["blocked", "not-installed", "starting"] as const) {
    let calls = 0;
    const companion = new WindowsRelayCompanion({ ...base,
      execFile: async () => { calls += 1; return { stdout: JSON.stringify({ status }), stderr: "" }; },
      fetch: async () => { throw new Error("must not probe"); },
    });
    assert.equal((await companion.start()).status, status);
    assert.equal(calls, 1);
  }
});

test("dispose aborts an in-flight health request without a restart", async () => {
  let healthStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { healthStarted = resolve; });
  const companion = new WindowsRelayCompanion({ ...base,
    fetch: async (_url, options) => {
      healthStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    },
  });
  const pending = companion.start();
  await started;
  companion.dispose();
  assert.equal((await pending).status, "cancelled");
});

test("missing prerequisites and malformed/helper errors fail closed without raw diagnostics", async () => {
  for (const overrides of [
    { platform: "linux" as const }, { pathExists: () => false }, { browserPath: "" },
    { execFile: async () => ({ stdout: "private error output", stderr: "secret" }) },
    { execFile: async () => ({ stdout: '{"status":"invented"}', stderr: "" }) },
    { execFile: async () => { throw new Error("private process detail"); } },
  ]) {
    const outcome = await new WindowsRelayCompanion({ ...base, ...overrides }).start();
    assert.equal(outcome.status, "failed");
    assert.doesNotMatch(outcome.message, /private|secret|invented/);
  }
});

test("unverified health stays starting without spawning another process", async () => {
  for (const response of [new Response("{}"), new Response('{"relayVersion":"16"}'),
    new Response("x".repeat(16_385)), new Response("denied", { status: 403 })]) {
    let calls = 0;
    const companion = new WindowsRelayCompanion({ ...base,
      execFile: async () => { calls += 1; return { stdout: '{"status":"running"}', stderr: "" }; },
      fetch: async () => response,
    });
    assert.equal((await companion.start()).status, "starting");
    assert.equal(calls, 1);
  }
  const timeout = new WindowsRelayCompanion({ ...base, fetch: async () => { throw new Error("timeout"); } });
  assert.equal((await timeout.start()).status, "starting");
});
