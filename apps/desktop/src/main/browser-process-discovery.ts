import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BrowserProcessInfo {
  pid: number;
  commandLine: string;
}

export async function findBrowserProcessesUsingDataDir(
  dataDir: string,
): Promise<BrowserProcessInfo[]> {
  const processes =
    process.platform === "win32" ? await listWindowsProcesses() : await listPosixProcesses();
  return processes.filter((candidate) => commandLineUsesDataDir(candidate.commandLine, dataDir));
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

export function commandLineUsesDataDir(commandLine: string, dataDir: string): boolean {
  const expected = normalizePath(dataDir);
  const pattern = /(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  for (const match of commandLine.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value && normalizePath(value) === expected) return true;
  }
  return false;
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
      { encoding: "utf8", windowsHide: true },
    );
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as BrowserProcessInfo[] | BrowserProcessInfo;
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(isBrowserProcessInfo);
  } catch {
    return [];
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
  } catch {
    return [];
  }
}

function normalizePath(value: string): string {
  if (process.platform === "win32") {
    return value.replaceAll("/", "\\").replace(/[\\]+$/, "").toLowerCase();
  }
  return value.replace(/\/+$/, "");
}

function isBrowserProcessInfo(value: BrowserProcessInfo): boolean {
  return Number.isInteger(value?.pid) && value.pid > 0 && typeof value.commandLine === "string";
}
