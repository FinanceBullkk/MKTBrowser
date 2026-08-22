import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BrowserProcessInfo {
  pid: number;
  commandLine: string;
}

export interface LoopbackPortOwnersInspection {
  inspected: boolean;
  pids: number[];
}

/**
 * Ask the OS which processes hold `dataDir`, and say whether the asking worked.
 *
 * `enumerated: false` means the process table could not be read at all — not that nothing holds the
 * directory. The two are opposite conclusions and the caller must not confuse them: a shutdown
 * sweep that reads a failed enumeration as "nothing left" reports a clean close over a browser that
 * is still running and still holding the single licence seat.
 */
export async function enumerateBrowserProcessesUsingDataDir(
  dataDir: string,
): Promise<{ processes: BrowserProcessInfo[]; enumerated: boolean }> {
  let processes: BrowserProcessInfo[];
  try {
    processes =
      process.platform === "win32" ? await listWindowsProcesses() : await listPosixProcesses();
  } catch {
    return { processes: [], enumerated: false };
  }
  return {
    processes: processes.filter((candidate) =>
      commandLineUsesDataDir(candidate.commandLine, dataDir),
    ),
    enumerated: true,
  };
}

/** Every browser process holding any profile beneath `root`, and whether the asking worked. */
export async function enumerateBrowserProcessesUnderRoot(
  root: string,
): Promise<{ processes: BrowserProcessInfo[]; enumerated: boolean }> {
  let processes: BrowserProcessInfo[];
  try {
    processes =
      process.platform === "win32" ? await listWindowsProcesses() : await listPosixProcesses();
  } catch {
    return { processes: [], enumerated: false };
  }
  return {
    processes: processes.filter((candidate) =>
      commandLineUsesDataDirUnder(candidate.commandLine, root),
    ),
    enumerated: true,
  };
}

/**
 * The lossy view, for callers that already have a safe fallback (they pass a known PID to
 * `selectPrimaryBrowserPid`). Anything that treats "empty" as proof of termination must use
 * `enumerateBrowserProcessesUsingDataDir` and check the flag instead.
 */
export async function findBrowserProcessesUsingDataDir(
  dataDir: string,
): Promise<BrowserProcessInfo[]> {
  return (await enumerateBrowserProcessesUsingDataDir(dataDir)).processes;
}

export function selectPrimaryBrowserPid(
  processes: readonly BrowserProcessInfo[],
  fallbackPid: number,
): number {
  const primary = processes.find(
    (candidate) => !/(?:^|\s)--type(?:=|\s)/.test(candidate.commandLine),
  );
  return primary?.pid ?? fallbackPid;
}

/**
 * The DevTools port a running browser was started with, or null if it has none.
 *
 * This is what makes a browser we did not launch still closable the polite way: an orphan left by a
 * force-killed app carries its own port on its command line, and `Browser.close` on that port is
 * the only shutdown that returns the licence seat. Killing it keeps the seat for the 7-17 minutes
 * the lease takes to expire.
 */
export function debugPortFromCommandLine(commandLine: string): number | null {
  // Last flag wins, matching Chromium's own switch handling.
  let found: number | null = null;
  const pattern = /(?:^|\s)--remote-debugging-port=(?:"(\d+)"|'(\d+)'|(\d+))/g;
  for (const match of commandLine.matchAll(pattern)) {
    const port = Number(match[1] ?? match[2] ?? match[3]);
    if (Number.isInteger(port) && port > 0 && port < 65_536) found = port;
  }
  return found;
}

/** The effective Chromium user-data-dir. Chromium honors the last occurrence. */
export function dataDirFromCommandLine(commandLine: string): string | null {
  let found: string | null = null;
  const pattern = /(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  for (const match of commandLine.matchAll(pattern)) {
    found = match[1] ?? match[2] ?? match[3] ?? null;
  }
  return found;
}

/**
 * Like `commandLineUsesDataDir`, but matches any directory *beneath* `root`.
 *
 * The startup sweep needs every browser holding any profile in the app's profiles folder, and it
 * must not reach one directory further: the operator's own Chrome is also a Chromium with a
 * `--user-data-dir`, and closing it would be an unforgivable way to reclaim a seat.
 */
export function commandLineUsesDataDirUnder(commandLine: string, root: string): boolean {
  const expected = normalizePath(root);
  const sep = process.platform === "win32" ? "\\" : "/";
  const value = dataDirFromCommandLine(commandLine);
  if (!value) return false;
  const normalized = normalizePath(value);
  return normalized === expected || normalized.startsWith(expected + sep);
}

export function commandLineUsesDataDir(commandLine: string, dataDir: string): boolean {
  const expected = normalizePath(dataDir);
  const value = dataDirFromCommandLine(commandLine);
  return value !== null && normalizePath(value) === expected;
}

/** Enumerate every Windows process listening specifically on 127.0.0.1 for `port`. */
export async function enumerateLoopbackPortOwners(
  port: number,
): Promise<LoopbackPortOwnersInspection> {
  if (process.platform !== "win32") return { inspected: false, pids: [] };
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536) {
    return { inspected: true, pids: [] };
  }

  const script = [
    `$items = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq ${port} -and $_.LocalAddress -eq '127.0.0.1' } | Select-Object -ExpandProperty OwningProcess -Unique)`,
    "$result = [pscustomobject]@{ inspected = $true; pids = @($items | ForEach-Object { [int]$_ }) }",
    "[Console]::Out.Write(($result | ConvertTo-Json -Compress))",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 3000 },
    );
    const parsed = JSON.parse(stdout) as { inspected?: unknown; pids?: unknown };
    if (parsed.inspected !== true || !Array.isArray(parsed.pids)) {
      return { inspected: false, pids: [] };
    }
    return {
      inspected: true,
      pids: parsed.pids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0),
    };
  } catch {
    return { inspected: false, pids: [] };
  }
}

async function listWindowsProcesses(): Promise<BrowserProcessInfo[]> {
  const script = [
    "$items = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--user-data-dir=*' } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; commandLine = [string]$_.CommandLine } }",
    "if ($items) { ConvertTo-Json -InputObject @($items) -Compress }",
  ].join("; ");

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 3000 },
    );
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as BrowserProcessInfo[] | BrowserProcessInfo;
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(isBrowserProcessInfo);
  } catch (cause) {
    // Propagate: the one caller that cannot tolerate a false empty checks for it.
    throw new Error("could not enumerate Windows processes", { cause });
  }
}

async function listPosixProcesses(): Promise<BrowserProcessInfo[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,command="], {
      encoding: "utf8",
    });
    const processes: BrowserProcessInfo[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid > 0 && pid !== process.pid) processes.push({ pid, commandLine: match[2]! });
    }
    return processes;
  } catch (cause) {
    throw new Error("could not enumerate processes", { cause });
  }
}

function normalizePath(value: string): string {
  if (process.platform === "win32") {
    return value
      .replaceAll("/", "\\")
      .replace(/[\\]+$/, "")
      .toLowerCase();
  }
  return value.replace(/\/+$/, "");
}

function isBrowserProcessInfo(value: BrowserProcessInfo): boolean {
  return Number.isInteger(value?.pid) && value.pid > 0 && typeof value.commandLine === "string";
}
