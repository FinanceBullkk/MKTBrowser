import assert from "node:assert/strict";
import test from "node:test";
import { stableWindowsRuntime, win32PathEquals } from "./chromium-runtime-path.ts";

test("keeps the Windows executable path stable across runtime versions", () => {
  assert.equal(
    stableWindowsRuntime("C:\\Users\\operator\\AppData\\Local\\MKTTool\\MKTBrowser\\chromium\\cft"),
    "C:\\Users\\operator\\AppData\\Local\\MKTTool\\MKTBrowser\\chromium\\cft\\runtime\\chrome.exe",
  );
});

test("compares stable runtime paths with Windows casing semantics", () => {
  assert.equal(win32PathEquals("C:\\Runtime\\chrome.exe", "c:\\runtime\\CHROME.EXE"), true);
});
