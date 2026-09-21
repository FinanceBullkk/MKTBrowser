import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserLaunchEnvironment } from "./browser-launch-environment.ts";

test("keeps native Windows paths and temp directories without leaking Electron markers", () => {
  const environment = buildBrowserLaunchEnvironment(
    {
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      SYSTEMDRIVE: "C:",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      TEMP: "C:\\Temp",
      TMP: "C:\\Tmp",
      USERPROFILE: "C:\\Users\\operator",
      APPDATA: "C:\\Users\\operator\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_RENDERER_URL: "http://127.0.0.1:5173",
      NODE_OPTIONS: "--inspect",
      CHROME_DESKTOP: "electron.desktop",
      V8_OPTIONS: "--trace-gc",
    },
    "win32",
  );

  assert.equal(environment.TMPDIR, undefined);
  assert.equal(environment.HOME, undefined);
  assert.equal(environment.SHELL, undefined);
  assert.deepEqual(environment, {
    PATH: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    SystemDrive: "C:",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    TEMP: "C:\\Temp",
    TMP: "C:\\Tmp",
    USERPROFILE: "C:\\Users\\operator",
    APPDATA: "C:\\Users\\operator\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local",
  });
});

test("retains the established POSIX browser environment and Linux desktop session", () => {
  const environment = buildBrowserLaunchEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/home/operator",
      USER: "operator",
      DISPLAY: ":0",
      XDG_RUNTIME_DIR: "/run/user/1000",
      ELECTRON_RUN_AS_NODE: "1",
    },
    "linux",
  );

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.HOME, "/home/operator");
  assert.equal(environment.DISPLAY, ":0");
  assert.equal(environment.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
});
