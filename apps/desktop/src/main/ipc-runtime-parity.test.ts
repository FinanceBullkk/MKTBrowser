import assert from "node:assert/strict";
import test from "node:test";

import { createMktBrowserApi } from "../preload/create-mkt-browser-api.ts";
import { IPC, IPC_EVENTS } from "../shared/ipc-exposure-policy.ts";
import { createIpcRuntimeRegistration } from "./ipc-runtime-registration.ts";

test("H39: the executable preload API reaches every classified invoke and event channel", async () => {
  const invoked: string[] = [];
  const subscribed: string[] = [];
  const api = createMktBrowserApi({
    invoke: async <T>(channel: string): Promise<T> => {
      invoked.push(channel);
      return undefined as T;
    },
    subscribe: <T>(channel: string, _cb: (payload: T) => void): (() => void) => {
      subscribed.push(channel);
      return () => {};
    },
  });

  await Promise.all([
    api.profiles.list(),
    api.profiles.get("profile-1"),
    api.profiles.create({} as never),
    api.profiles.update("profile-1", {}),
    api.profiles.deletePermanently({ profileId: "profile-1", confirmation: "DELETE profile-1" }),
    api.profiles.launch("profile-1"),
    api.profiles.close("profile-1"),
    api.profiles.exportArchive("profile-1", "synthetic-passphrase"),
    api.profiles.importArchive("synthetic-passphrase"),
    api.settings.get(),
    api.settings.update({}),
    api.activity.recent(),
    api.system.info(),
    api.chromium.status(),
    api.chromium.retry(),
    api.chromium.switchToCft(),
    api.chromium.activateLatest(),
    api.extensions.list("profile-1"),
    api.extensions.addFromFile("profile-1"),
    api.extensions.addFromFolder("profile-1"),
    api.extensions.addFromWebStore("profile-1", "a".repeat(32)),
    api.extensions.remove("profile-1", "a".repeat(32)),
    api.extensions.toggle("profile-1", "a".repeat(32), true),
    api.extensions.storeEntries(),
    api.extensions.prepareFromWebStore("a".repeat(32)),
    api.extensions.prepareFromFile(),
    api.extensions.prepareFromFolder(),
    api.extensions.icon({} as never, "profile-1"),
    api.fingerprint.generate(),
    api.fingerprint.devices(),
    api.fingerprint.locales(),
    api.fingerprint.reconcile({} as never, {}),
    api.fingerprint.localeForCountry("US"),
    api.proxy.detectGeo({} as never, "profile-1"),
  ]);

  api.profiles.onRunningChanged(() => {});
  api.profiles.onProxyCountryUpdated(() => {});
  api.activity.onEvent(() => {});
  api.chromium.onStatus(() => {});
  api.extensions.onInstalled(() => {});

  assert.deepEqual([...new Set(invoked)].sort(), Object.values(IPC).sort());
  assert.deepEqual([...new Set(subscribed)].sort(), Object.values(IPC_EVENTS).sort());
});

test("H39: main-process registration fails closed on missing, duplicate, or foreign channels", () => {
  type Event = { trusted: boolean };
  const installed = new Map<string, (event: Event, ...args: unknown[]) => unknown>();
  const registration = createIpcRuntimeRegistration<Event>({
    register: (channel, handler) => installed.set(channel, handler),
    isTrustedSender: (event) => event.trusted,
  });

  for (const channel of Object.values(IPC)) registration.handle(channel, () => channel);
  registration.assertComplete();
  assert.deepEqual([...installed.keys()].sort(), Object.values(IPC).sort());
  assert.equal(installed.get(IPC.PROFILES_LIST)?.({ trusted: true }), IPC.PROFILES_LIST);
  assert.throws(
    () => installed.get(IPC.PROFILES_LIST)?.({ trusted: false }),
    /Rejected IPC sender/i,
  );
  assert.throws(() => registration.handle(IPC.PROFILES_LIST, () => null), /duplicate/i);

  const incomplete = createIpcRuntimeRegistration<Event>({
    register: () => {},
    isTrustedSender: () => true,
  });
  for (const channel of Object.values(IPC).slice(1)) incomplete.handle(channel, () => null);
  assert.throws(() => incomplete.assertComplete(), /missing IPC handlers/i);
  assert.throws(
    () => incomplete.handle("foreign:channel" as never, () => null),
    /unclassified IPC channel/i,
  );
});
