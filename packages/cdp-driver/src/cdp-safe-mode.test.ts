import assert from "node:assert/strict";
import test from "node:test";

import { CdpSession } from "./CdpSession.js";

interface RecordingClient {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}

function createSession(engine: string) {
  const calls: Array<{ method: string; sessionId?: string }> = [];
  const session = new CdpSession({ port: 9222, engine });
  const client: RecordingClient = {
    send: async (method, _params, sessionId) => {
      calls.push({ method, sessionId });
      return { ok: true };
    },
  };

  // CdpSession has no transport injection seam; install a recording client without opening CDP.
  (session as unknown as { client: RecordingClient }).client = client;
  return { session, calls };
}

test("H24: safe mode refuses an untracked CDP domain enable before sending it", async () => {
  const { session, calls } = createSession("cft");

  await assert.rejects(
    session.cdpSend("Debugger.enable", {}, undefined, { safe: true }),
    /safe mode/,
  );
  assert.deepEqual(calls, []);
});

test("safe mode pairs an approved domain enable with its disable", async () => {
  const { session, calls } = createSession("cft");

  await session.cdpSend("DOM.enable", {}, undefined, { safe: true });

  assert.deepEqual(
    calls.map((call) => call.method),
    ["DOM.enable", "DOM.disable"],
  );
});

test("safe mode refuses a CloakBrowser-sensitive enable before sending it", async () => {
  const { session, calls } = createSession("cloakbrowser");

  await assert.rejects(
    session.cdpSend("Runtime.enable", {}, undefined, { safe: true }),
    /Refusing Runtime\.enable in safe mode/,
  );
  assert.deepEqual(calls, []);
});

test("connect retries with a fresh client when Page.enable fails", async () => {
  let factoryCalls = 0;
  let failedClientClosed = false;
  const session = new CdpSession({
    port: 9222,
    clientFactory: async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        return {
          Page: { enable: async () => Promise.reject(new Error("enable failed")) },
          close: async () => {
            failedClientClosed = true;
          },
        } as never;
      }
      return {
        Page: { enable: async () => {} },
        close: async () => {},
      } as never;
    },
  });

  await assert.rejects(session.connect(), /enable failed/);
  await session.connect();

  assert.equal(factoryCalls, 2);
  assert.equal(failedClientClosed, true);
});

test("close invalidates and disposes a connection that completes late", async () => {
  let resolveClient: ((client: never) => void) | undefined;
  let clientClosed = false;
  const session = new CdpSession({
    port: 9222,
    clientFactory: () =>
      new Promise((resolve) => {
        resolveClient = resolve;
      }),
  });

  const connecting = session.connect();
  await session.close();
  resolveClient?.({
    Page: { enable: async () => {} },
    close: async () => {
      clientClosed = true;
    },
  } as never);

  await assert.rejects(connecting, /closed while connecting/);
  assert.equal(clientClosed, true);
});

test("closeBrowser uses a browser-level transport instead of the page target", async () => {
  const pageCalls: string[] = [];
  const browserCalls: string[] = [];
  let browserClientClosed = false;
  const session = new CdpSession({
    port: 9222,
    clientFactory: async () => ({
      Page: { enable: async () => {} },
      send: async (method: string) => {
        pageCalls.push(method);
      },
      close: async () => {},
    }) as never,
    browserClientFactory: async () => ({
      send: async (method: string) => {
        browserCalls.push(method);
      },
      close: async () => {
        browserClientClosed = true;
      },
    }) as never,
  });

  await session.connect();
  await session.closeBrowser();

  assert.deepEqual(browserCalls, ["Browser.close"]);
  assert.deepEqual(pageCalls, []);
  assert.equal(browserClientClosed, true);
});
