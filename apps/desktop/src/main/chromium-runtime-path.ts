import { dirname, win32 } from "node:path";

export function stableWindowsRuntime(cacheDir: string): string {
  return win32.join(cacheDir, "runtime", "chrome.exe");
}

export function extractedWindowsRuntimeRoot(binaryPath: string): string {
  return dirname(binaryPath);
}

export function win32PathEquals(left: string, right: string): boolean {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}
