import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Exercise the actual driver without starting Electron or any browser process.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") {
      return { url: "data:text/javascript,export const app = { getPath: () => '' };", shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL) {
      const candidate = new URL(specifier.endsWith(".js") ? specifier.slice(0, -3) + ".ts" : `${specifier}.ts`, context.parentURL);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { ChromiumBrowserDriver } = await import("./ChromiumBrowserDriver.ts");
hooks.deregister();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(startupBarrier = Promise.resolve()) {
  const driver = new ChromiumBrowserDriver({
    profileManager: {} as never,
    chromiumBootstrap: {} as never,
    extensionStoreRoot: "unused",
    startupBarrier,
  });
  const launched: string[] = [];
  const closed: string[] = [];
  const active = new Map<string, object>();
  Object.defineProperty(driver, "running", { value: active });
  Object.defineProperty(driver, "launchWithKeyRotation", { configurable: true, value: async (id: string) => {
    launched.push(id);
    active.set(id, {});
    return { id, cdpEndpoint: "fixture", pid: 1, startedAt: "fixture" };
  } });
  Object.defineProperty(driver, "close", { configurable: true, value: async (id: string) => {
    closed.push(id);
    active.delete(id);
  } });
  return { driver, launched, closed, active };
}

test("shutdown tracks a launch waiting for the orphan sweep and refuses new launches", async () => {
  const barrier = deferred();
  const { driver, launched } = fixture(barrier.promise);
  const launching = driver.launch("waiting");
  const rejected = assert.rejects(launching, /launch cancelled/);
  const shutdown = driver.closeAll({ shutdown: true });
  let closed = false;
  void shutdown.then(() => { closed = true; });
  await assert.rejects(driver.launch("new"), /closing profiles/);
  assert.equal(closed, false);
  barrier.resolve();
  await Promise.all([shutdown, rejected]);
  assert.deepEqual(launched, []);
  await assert.rejects(driver.launch("after"), /closing profiles/);
});

test("closeAll joins an already started launch, coalesces drains, then permits later reuse", async () => {
  const { driver, closed, active } = fixture();
  const launched = deferred();
  const finishLaunch = deferred();
  Object.defineProperty(driver, "launchWithKeyRotation", { configurable: true, value: async (id: string) => {
    launched.resolve();
    await finishLaunch.promise;
    active.set(id, {});
    return { id, cdpEndpoint: "fixture", pid: 1, startedAt: "fixture" };
  } });
  const pending = driver.launch("pending");
  await launched.promise;
  const drain = driver.closeAll();
  assert.equal(driver.closeAll(), drain);
  await assert.rejects(driver.launch("during"), /closing profiles/);
  finishLaunch.resolve();
  await Promise.all([pending, drain]);
  assert.deepEqual(closed, ["pending"]);
  assert.equal(active.size, 0);
  assert.equal((await driver.launch("later")).id, "later");
  await driver.closeAll();
});

test("a failed close waits for the other closes before reporting failure", async () => {
  const { driver, active } = fixture();
  active.set("failed", {});
  active.set("slow", {});
  const finishClose = deferred();
  Object.defineProperty(driver, "close", { value: async (id: string) => {
    if (id === "failed") throw new Error("process still alive");
    await finishClose.promise;
    active.delete(id);
  } });
  let settled = false;
  const drain = driver.closeAll({ shutdown: true });
  const rejected = assert.rejects(drain, /could not be closed/).then(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  finishClose.resolve();
  await rejected;
  assert.equal(active.has("slow"), false);
  assert.equal(active.has("failed"), true);
  await assert.rejects(driver.launch("after-failure"), /closing profiles/);
});
