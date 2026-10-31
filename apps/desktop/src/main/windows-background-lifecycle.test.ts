import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserWindow, Menu, MenuItemConstructorOptions, Tray } from "electron";
import {
  WindowsBackgroundLifecycle,
  usesNormalWindowsSession,
} from "./windows-background-lifecycle.ts";

function fixture(trayFails = false) {
  const window = Object.assign(new EventEmitter(), {
    hide: () => {
      calls.push("hide");
    },
    show: () => {
      calls.push("show");
    },
    focus: () => {
      calls.push("focus");
    },
    restore: () => {
      calls.push("restore");
    },
    isMinimized: () => true,
    isDestroyed: () => false,
  });
  const calls: string[] = [];
  const tray = Object.assign(new EventEmitter(), {
    setToolTip: () => {},
    setContextMenu: () => {},
    displayBalloon: () => {
      calls.push("notice");
    },
    destroy: () => {
      calls.push("destroy-tray");
    },
  });
  let menu: MenuItemConstructorOptions[] = [];
  const controller = new WindowsBackgroundLifecycle({
    createTray: () => {
      if (trayFails) throw new Error("tray unavailable");
      return tray as unknown as Tray;
    },
    buildMenu: (items) => {
      menu = items;
      return {} as Menu;
    },
    getWindow: () => window as unknown as BrowserWindow,
    quit: () => {
      calls.push("quit");
    },
    endSession: () => {
      calls.push("session-cleanup");
    },
    retryRelay: () => {
      calls.push("retry-relay");
    },
  });
  controller.attachWindow(window as unknown as BrowserWindow);
  const close = () =>
    window.emit("close", {
      preventDefault: () => {
        calls.push("prevent");
      },
    });
  const click = (label: string) =>
    (menu.find((entry) => entry.label === label)?.click as () => void)();
  return { controller, calls, close, click, tray, window, menu: () => menu };
}

test("normal Windows session excludes development and disposable roots", () => {
  const normal = {
    platform: "win32",
    isPackaged: true,
    explicitUserData: false,
  };
  assert.equal(usesNormalWindowsSession(normal), true);
  for (const change of [{ platform: "darwin" }, { isPackaged: false }, { explicitUserData: true }]) {
    assert.equal(usesNormalWindowsSession({ ...normal, ...change }), false);
  }
});

test("explicit canonical Windows root cannot bypass the normal instance lock", () => {
  const input = {
    platform: "win32",
    isPackaged: true,
    explicitUserData: true,
    canonicalUserDataPath: "C:\\Users\\operator\\MKTBrowser",
  };
  for (const userDataPath of [
    input.canonicalUserDataPath,
    "c:\\users\\operator\\tmp\\..\\mktbrowser\\",
  ]) {
    assert.equal(usesNormalWindowsSession({ ...input, userDataPath }), true);
  }
  assert.equal(
    usesNormalWindowsSession({ ...input, userDataPath: "C:\\temporary\\fixture" }),
    false,
  );
});

test("close hides the manager without quitting or retrying Relay; notice appears once", () => {
  const f = fixture();
  f.close();
  f.close();
  assert.deepEqual(f.calls, ["prevent", "hide", "notice", "prevent", "hide"]);
  assert.equal(f.controller.canHide, true);
});

test("tray reopen restores the existing window and explicitly retries Relay", () => {
  const f = fixture();
  f.click("Open MKT Browser");
  assert.deepEqual(f.calls, ["restore", "show", "focus", "retry-relay"]);
  f.calls.length = 0;
  f.tray.emit("double-click");
  assert.deepEqual(f.calls, ["restore", "show", "focus", "retry-relay"]);
});

test("explicit Quit bypasses hide and is requested once", () => {
  const f = fixture();
  f.click("Quit MKT Browser");
  f.click("Quit MKT Browser");
  f.close();
  assert.deepEqual(f.calls, ["quit"]);
  assert.equal(f.controller.canHide, false);
  assert.ok(
    f
      .menu()
      .some(
        (entry) =>
          entry.label === "Quit closes browser profiles; Relay stays running." &&
          entry.enabled === false,
      ),
  );
});

test("external quit and Windows logout query do not intercept window close", () => {
  for (const trigger of ["quit", "query-session-end"]) {
    const f = fixture();
    if (trigger === "quit") f.controller.beginQuit();
    else f.window.emit("query-session-end");
    f.close();
    f.controller.show();
    assert.deepEqual(f.calls, trigger === "quit" ? [] : ["quit"]);
  }
});

test("logout query requests real shutdown even when Windows logout is later cancelled", () => {
  const f = fixture();
  f.window.emit("query-session-end");
  f.window.emit("query-session-end");
  assert.deepEqual(f.calls, ["quit"]);
});

test("committed session end invokes cleanup even if Electron skips before-quit", () => {
  const f = fixture();
  f.window.emit("session-end");
  f.close();
  assert.deepEqual(f.calls, ["session-cleanup"]);
});

test("tray failure keeps the window visible and normal close available", () => {
  const f = fixture(true);
  assert.equal(f.controller.canHide, false);
  f.close();
  assert.deepEqual(f.calls, []);
});

test("status update is visible but never automatically starts Relay", () => {
  const f = fixture();
  f.controller.setRelayStatus("Relay needs repair.");
  assert.ok(
    f.menu().some((entry) => entry.label === "Relay needs repair." && entry.enabled === false),
  );
  assert.deepEqual(f.calls, []);
  f.click("Check Relay");
  assert.deepEqual(f.calls, ["retry-relay"]);
});

test("disposed controller stops tray actions and does not block shutdown", () => {
  const f = fixture();
  f.controller.dispose();
  f.controller.dispose();
  f.click("Check Relay");
  f.close();
  assert.deepEqual(f.calls, ["destroy-tray"]);
});
