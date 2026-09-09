import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { RelayFailureNotifier } from "./relay-failure-notifier.ts";

test("pending Relay error leaves the caller and event loop available without duplicate dialogs", async () => {
  const dialogs: string[] = [];
  let dismiss!: () => void;
  const pending = new Promise<void>((resolve) => {
    dismiss = resolve;
  });
  const notifier = new RelayFailureNotifier({
    showMessageBox: (options) => {
      dialogs.push(options.message);
      return pending;
    },
    notify: () => assert.fail("explicit failure should open a dialog"),
  });
  assert.equal(notifier.show("Ownership check failed", true), undefined);
  notifier.show("Repeated check failed", true);
  await setImmediate();
  assert.deepEqual(dialogs, ["Ownership check failed"]);
  dismiss();
  await setImmediate();
  notifier.show("Retry after dismissal", true);
  assert.deepEqual(dialogs, ["Ownership check failed", "Retry after dismissal"]);
});

test("background failure uses the tray without opening a dialog", () => {
  const notices: string[][] = [];
  new RelayFailureNotifier({
    showMessageBox: () => assert.fail("background notification should use the tray"),
    notify: (title, message) => {
      notices.push([title, message]);
    },
  }).show("Relay is not installed", false);
  assert.deepEqual(notices, [["Relay needs attention", "Relay is not installed"]]);
});

for (const mode of ["throw", "reject"] as const) {
  test(`dialog ${mode} falls back without an unhandled rejection and allows retry`, async () => {
    let attempts = 0;
    const notices: string[] = [];
    const notifier = new RelayFailureNotifier({
      showMessageBox: () => {
        attempts++;
        if (mode === "throw") throw new Error("UI unavailable");
        return Promise.reject(new Error("UI unavailable"));
      },
      notify: (_title, message) => {
        notices.push(message);
      },
    });
    notifier.show("Failure", true);
    await setImmediate();
    notifier.show("Retry", true);
    await setImmediate();
    assert.equal(attempts, 2);
    assert.deepEqual(notices, ["Failure", "Retry"]);
  });
}

test("packaged companion failure is wired to the asynchronous Electron dialog API", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const check = source.slice(
    source.indexOf("async function checkRelayCompanion("),
    source.indexOf("const ADDITIONAL_LICENSE_KEYS_ENABLED"),
  );
  assert.match(
    source,
    /new RelayFailureNotifier\(\{\s*showMessageBox: \(options\) => dialog\.showMessageBox\(options\)/,
  );
  assert.match(
    check,
    /relayFailureNotifier\.show\(result\.message, notifyFailure \|\| !backgroundLifecycle\?\.canHide\)/,
  );
  assert.doesNotMatch(check, /showErrorBox|showMessageBoxSync/);
});
