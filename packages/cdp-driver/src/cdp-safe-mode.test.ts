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
