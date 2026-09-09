import { execFile } from "node:child_process";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import {
  createWindowsProcessQueryWorker,
  type WindowsProcessQueryWorker,
} from "./windows-process-query-worker.ts";

const execFileAsync = promisify(execFile);
const MAX_NETSTAT_OUTPUT_BYTES = 1_048_576;
const WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS = 5_000;
// A machine that has just booted pays for WinMgmt starting up on its first CIM query, and that one
// call can outrun the warm budget above by a wide margin. Reading that as "the process table cannot
// be read" is the wrong conclusion, and an expensive one: a shutdown sweep then fails closed over a
// browser that is still holding the single licence seat. It is not hypothetical - on a fresh CI
// runner the discovery contract failed at exactly the 5s mark. A timeout is evidence the machine is
// cold rather than hung, so the one retry gets a budget sized for a cold WMI.
const WINDOWS_PROCESS_INSPECTION_COLD_TIMEOUT_MS = 20_000;
let windowsProcessWorker: { powershell: string; worker: WindowsProcessQueryWorker } | undefined;

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

/** Parse bounded netstat rows; the wildcard foreign endpoint identifies a listener across locales. */
export function parseLoopbackPortOwners(raw: string, port: number): number[] {
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536) return [];
  if (Buffer.byteLength(raw, "utf8") > MAX_NETSTAT_OUTPUT_BYTES) return [];

  const owners = new Set<number>();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+0\.0\.0\.0:0\s+\S+\s+(\d+)\s*$/i);
    if (!match || Number(match[1]) !== port) continue;
    const pid = Number(match[2]);
    if (Number.isInteger(pid) && pid > 0) owners.add(pid);
  }
  return [...owners];
}

/** Enumerate every Windows process listening specifically on 127.0.0.1 for `port`. */
export async function enumerateLoopbackPortOwners(
  port: number,
): Promise<LoopbackPortOwnersInspection> {
  if (process.platform !== "win32") return { inspected: false, pids: [] };
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536) {
    return { inspected: true, pids: [] };
  }
  const systemRoot = windowsSystemRootFromEnv();
  if (!systemRoot) return { inspected: false, pids: [] };

  try {
    const { stdout } = await execFileAsync(
      join(systemRoot, "System32", "netstat.exe"),
      ["-ano", "-p", "tcp"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3000,
        maxBuffer: MAX_NETSTAT_OUTPUT_BYTES,
      },
    );
    return { inspected: true, pids: parseLoopbackPortOwners(stdout, port) };
  } catch {
    return { inspected: false, pids: [] };
  }
}

async function listWindowsProcesses(): Promise<BrowserProcessInfo[]> {
  const systemRoot = windowsSystemRootFromEnv();
  if (!systemRoot) throw new Error("Windows system root is unavailable");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$query = \"SELECT ProcessId, CommandLine FROM Win32_Process WHERE CommandLine LIKE '%--user-data-dir=%'\"",
    "$items = Get-CimInstance -Query $query -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; commandLine = [string]$_.CommandLine } }",
    "if ($items) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($items) -Compress)) } else { [Console]::Out.WriteLine('[]') }",
  ].join("; ");
  if (windowsProcessWorker?.powershell !== powershell) {
    windowsProcessWorker?.worker.dispose();
    windowsProcessWorker = {
      powershell,
      worker: createWindowsProcessQueryWorker(powershell, script),
    };
  }
  const worker = windowsProcessWorker.worker;

  try {
    return (await worker.query(WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS)).filter(isBrowserProcessInfo);
  } catch (cause) {
    // Only a timeout earns the second, longer attempt. Anything else - a missing shell, refused
    // access, unparseable output - would fail the same way twice and only delay the answer.
    if (!isChildProcessTimeout(cause)) {
      // Propagate: the one caller that cannot tolerate a false empty checks for it.
      throw new Error("could not enumerate Windows processes", { cause });
    }
  }

  try {
    return (await worker.query(WINDOWS_PROCESS_INSPECTION_COLD_TIMEOUT_MS)).filter(
      isBrowserProcessInfo,
    );
  } catch (cause) {
    throw new Error("could not enumerate Windows processes", { cause });
  }
}

/** A query timeout retires its shell before any retry can observe a late response. */
function isChildProcessTimeout(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const failure = cause as { killed?: unknown; signal?: unknown };
  return failure.killed === true && typeof failure.signal === "string";
}

export function windowsSystemRootFromEnv(
  env: Partial<Pick<NodeJS.ProcessEnv, "SystemRoot" | "WINDIR">> = process.env,
): string | null {
  const candidate = env.SystemRoot || env.WINDIR;
  if (!candidate) return null;
  if (!/^[A-Za-z]:[\\/]/.test(candidate)) return null;
  const normalized = win32.resolve(candidate);
  return normalized;
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

function isBrowserProcessInfo(value: unknown): value is BrowserProcessInfo {
  if (typeof value !== "object" || value === null) return false;
  const item = value as BrowserProcessInfo;
  return Number.isInteger(item.pid) && item.pid > 0 && typeof item.commandLine === "string";
}
