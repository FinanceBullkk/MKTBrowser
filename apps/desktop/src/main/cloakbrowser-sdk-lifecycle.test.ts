import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext } from "playwright-core";
import {
  cloakBrowserSdkLicenseExitCode,
  discoverCloakBrowserSdkProcess,
  launchCloakBrowserSdkLifecycle,
  sdkCompatibleArgs,
} from "./cloakbrowser-sdk-lifecycle.ts";

function fakeContext(options: {
  evaluate?: () => Promise<unknown>;
  close?: () => Promise<void>;
  goto?: (url: string) => Promise<unknown>;
} = {}): BrowserContext {
  const page = {
    evaluate: options.evaluate ?? (async () => true),
    goto: async (url: string) => options.goto?.(url),
  };
  return {
    pages: () => [page],
    newPage: async () => page,
    close: options.close ?? (async () => undefined),
  } as unknown as BrowserContext;
}

test("launches the exact pinned binary through the SDK without leaking host markers", async () => {
  const previous = process.env.CLOAKBROWSER_BINARY_PATH;
  delete process.env.CLOAKBROWSER_BINARY_PATH;
  let received: Record<string, unknown> | null = null;
  let binaryDuringLaunch: string | undefined;
  let navigatedTo: string | null = null;
  try {
    const lifecycle = await launchCloakBrowserSdkLifecycle(
      {
        executablePath: "C:\\engine\\chrome.exe",
        browserDataDir: "C:\\profiles\\p1\\cloakbrowser",
        licenseKey: "cb_fixture",
        browserVersion: "151.0.7922.108.6",
        args: [
          "--user-data-dir=C:\\profiles\\p1\\cloakbrowser",
          "--remote-debugging-pipe",
          "--remote-debugging-port=0",
          "--fingerprint=123",
          "https://start.invalid/",
        ],
        initialUrl: "https://start.invalid/",
        environment: {
          Path: "C:\\Windows\\System32",
          TEMP: "C:\\Temp",
          SystemRoot: "C:\\Windows",
          ELECTRON_RUN_AS_NODE: "1",
          NODE_OPTIONS: "--inspect",
        },
      },
      {
        launchPersistentContext: async (options) => {
          received = options as unknown as Record<string, unknown>;
          binaryDuringLaunch = process.env.CLOAKBROWSER_BINARY_PATH;
          return fakeContext({ goto: async (url) => { navigatedTo = url; } });
        },
        now: () => 3_000,
        sleep: async () => undefined,
      },
    );

    assert.equal(binaryDuringLaunch, "C:\\engine\\chrome.exe");
    assert.equal(process.env.CLOAKBROWSER_BINARY_PATH, undefined);
    const captured = received as unknown as Record<string, unknown>;
    assert.equal(captured.userDataDir, "C:\\profiles\\p1\\cloakbrowser");
    assert.equal(captured.licenseKey, "cb_fixture");
    assert.equal(captured.browserVersion, "151.0.7922.108.6");
    assert.equal(captured.stealthArgs, false);
    assert.equal(captured.viewport, null);
    assert.deepEqual(captured.args, ["--remote-debugging-port=0", "--fingerprint=123"]);
    const launchOptions = captured.launchOptions as Record<string, unknown>;
    assert.equal(launchOptions.chromiumSandbox, true);
    assert.deepEqual(launchOptions.ignoreDefaultArgs, [
      "--enable-automation",
      "--enable-unsafe-swiftshader",
      "about:blank",
    ]);
    assert.deepEqual(launchOptions.env, {
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
    });
    assert.equal(navigatedTo, "https://start.invalid/");
    await lifecycle.settleLicenceVerdict(0);
  } finally {
    if (previous === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH;
    else process.env.CLOAKBROWSER_BINARY_PATH = previous;
  }
});

test("restores a prior binary override and coalesces SDK close", async () => {
  const previous = process.env.CLOAKBROWSER_BINARY_PATH;
  process.env.CLOAKBROWSER_BINARY_PATH = "C:\\prior\\chrome.exe";
  let closeCalls = 0;
  try {
    const lifecycle = await launchCloakBrowserSdkLifecycle(
      {
        executablePath: "C:\\engine\\chrome.exe",
        browserDataDir: "C:\\profiles\\p1",
        licenseKey: "cb_fixture",
        browserVersion: "151.0.7922.108.6",
        args: ["--remote-debugging-port=0"],
      },
      {
        launchPersistentContext: async () => fakeContext({
          close: async () => { closeCalls += 1; },
        }),
      },
    );
    assert.equal(process.env.CLOAKBROWSER_BINARY_PATH, "C:\\prior\\chrome.exe");
    await Promise.all([lifecycle.close(), lifecycle.close()]);
    assert.equal(closeCalls, 1);
  } finally {
    if (previous === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH;
    else process.env.CLOAKBROWSER_BINARY_PATH = previous;
  }
});

test("restores the binary override when SDK launch fails", async () => {
  const previous = process.env.CLOAKBROWSER_BINARY_PATH;
  delete process.env.CLOAKBROWSER_BINARY_PATH;
  try {
    await assert.rejects(
      launchCloakBrowserSdkLifecycle(
        {
          executablePath: "C:\\engine\\chrome.exe",
          browserDataDir: "C:\\profiles\\p1",
          licenseKey: "cb_fixture",
          browserVersion: "151.0.7922.108.6",
          args: [],
        },
        { launchPersistentContext: async () => { throw new Error("launch failed"); } },
      ),
      /launch failed/,
    );
    assert.equal(process.env.CLOAKBROWSER_BINARY_PATH, undefined);
  } finally {
    if (previous === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH;
    else process.env.CLOAKBROWSER_BINARY_PATH = previous;
  }
});

test("maps only documented SDK licence failures to native exit codes", () => {
  assert.equal(
    cloakBrowserSdkLicenseExitCode(new Error("CloakBrowser Pro: session limit reached for your plan.")),
    76,
  );
  assert.equal(
    cloakBrowserSdkLicenseExitCode(new Error("browser process did exit: exitCode=78")),
    78,
  );
  assert.equal(cloakBrowserSdkLicenseExitCode(new Error("ordinary crash")), null);
});

test("removes arguments Playwright owns and positional start URLs", () => {
  assert.deepEqual(
    sdkCompatibleArgs([
      "--user-data-dir=C:\\profile",
      "--remote-debugging-pipe",
      "--remote-debugging-port=0",
      "--lang=en-US",
      "https://start.invalid/",
    ]),
    ["--remote-debugging-port=0", "--lang=en-US"],
  );
});

test("discovers the SDK-owned primary process from the exact profile directory", async () => {
  let inspected = "";
  const pid = await discoverCloakBrowserSdkProcess("C:\\profiles\\p1\\cloakbrowser", {
    enumerateProcesses: async (browserDataDir) => {
      inspected = browserDataDir;
      return {
        enumerated: true,
        processes: [
          { pid: 502, commandLine: "chrome.exe --type=renderer --user-data-dir=C:\\profiles\\p1\\cloakbrowser" },
          { pid: 501, commandLine: "chrome.exe --user-data-dir=C:\\profiles\\p1\\cloakbrowser" },
        ],
      };
    },
  });

  assert.equal(inspected, "C:\\profiles\\p1\\cloakbrowser");
  assert.equal(pid, 501);
});

test("fails closed when SDK process ownership cannot be established", async () => {
  await assert.rejects(
    discoverCloakBrowserSdkProcess("C:\\profiles\\p1", {
      enumerateProcesses: async () => ({ processes: [], enumerated: false }),
    }),
    /Could not inspect/,
  );
  await assert.rejects(
    discoverCloakBrowserSdkProcess("C:\\profiles\\p1", {
      enumerateProcesses: async () => ({
        enumerated: true,
        processes: [{ pid: 502, commandLine: "chrome.exe --type=renderer" }],
      }),
    }),
    /primary process/,
  );
});
