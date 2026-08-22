import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  enumerateBrowserProcessesUsingDataDir,
  enumerateLoopbackPortOwners,
  type BrowserProcessInfo,
  type LoopbackPortOwnersInspection,
} from "./browser-process-discovery.ts";

const ACTIVE_PORT_FILE = "DevToolsActivePort";
const MAX_ACTIVE_PORT_BYTES = 512;
const POLL_INTERVAL_MS = 100;

export interface DevToolsEndpointIdentity {
  port: number;
  browserWebSocketPath: string;
}

export interface DevToolsDiscoveryTimings {
  activePortMs: number;
  processMs: number;
  ownershipMs: number;
  totalMs: number;
}

export interface OwnedDevToolsEndpoint extends DevToolsEndpointIdentity {
  primaryPid: number;
  processPids: number[];
  portOwnerPids: number[];
  timings: DevToolsDiscoveryTimings;
}

export type DevToolsDiscoveryStage = "active-port" | "process" | "ownership";

export interface DevToolsDiscoveryDiagnostics {
  stage: DevToolsDiscoveryStage;
  budgetMs: number;
  elapsedMs: number;
  childPid: number;
  childAlive: boolean;
  primaryPid: number | null;
  port: number | null;
  processPids: number[];
  portOwnerPids: number[];
}

export class DevToolsPortDiscoveryError extends Error {
  readonly diagnostics: DevToolsDiscoveryDiagnostics;

  constructor(diagnostics: DevToolsDiscoveryDiagnostics) {
    super(
      `DevTools endpoint discovery timed out at stage ${diagnostics.stage} ` +
        `within ${diagnostics.budgetMs}ms; elapsedMs=${diagnostics.elapsedMs}; ` +
        `childPid=${diagnostics.childPid}; childAlive=${diagnostics.childAlive}; ` +
        `primaryPid=${diagnostics.primaryPid ?? "none"}; port=${diagnostics.port ?? "none"}; ` +
        `processPids=${diagnostics.processPids.join(",") || "none"}; ` +
        `portOwnerPids=${diagnostics.portOwnerPids.join(",") || "none"}`,
    );
    this.name = "DevToolsPortDiscoveryError";
    this.diagnostics = diagnostics;
  }
}

export interface DevToolsActivePortRecord {
  contents: string;
  modifiedAtMs: number;
}

export interface DevToolsPortDiscoveryDeps {
  readActivePortRecord: (dataDir: string) => Promise<DevToolsActivePortRecord | null>;
  enumerateProcesses: (
    dataDir: string,
  ) => Promise<{ processes: BrowserProcessInfo[]; enumerated: boolean }>;
  enumeratePortOwners: (port: number) => Promise<LoopbackPortOwnersInspection>;
  isAlive: (pid: number) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: DevToolsPortDiscoveryDeps = {
  readActivePortRecord: readDevToolsActivePortRecord,
  enumerateProcesses: enumerateBrowserProcessesUsingDataDir,
  enumeratePortOwners: enumerateLoopbackPortOwners,
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function clearStaleDevToolsActivePort(dataDir: string): Promise<void> {
  await rm(join(dataDir, ACTIVE_PORT_FILE), { force: true });
}

export async function readDevToolsActivePortRecord(
  dataDir: string,
): Promise<DevToolsActivePortRecord | null> {
  const activePortPath = join(dataDir, ACTIVE_PORT_FILE);
  let handle;
  try {
    handle = await open(activePortPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_ACTIVE_PORT_BYTES) {
      throw new Error("DevToolsActivePort has an invalid bounded file size");
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(contents, "utf8") > MAX_ACTIVE_PORT_BYTES) {
      throw new Error("DevToolsActivePort exceeded the bounded read size");
    }
    return { contents, modifiedAtMs: fileStat.mtimeMs };
  } finally {
    await handle.close();
  }
}

export function parseDevToolsActivePort(raw: string): DevToolsEndpointIdentity {
  if (Buffer.byteLength(raw, "utf8") > MAX_ACTIVE_PORT_BYTES) {
    throw new Error("DevToolsActivePort exceeded the bounded parse size");
  }
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length !== 2) throw new Error("DevToolsActivePort must contain exactly two lines");
  if (!/^\d{1,5}$/.test(lines[0] ?? "")) {
    throw new Error("DevToolsActivePort contains an invalid port");
  }
  const port = Number(lines[0]);
  if (port <= 0 || port >= 65_536) throw new Error("DevToolsActivePort port is out of range");
  const browserWebSocketPath = lines[1] ?? "";
  if (!/^\/devtools\/browser\/[A-Za-z0-9._-]{1,200}$/.test(browserWebSocketPath)) {
    throw new Error("DevToolsActivePort contains an invalid browser websocket path");
  }
  return { port, browserWebSocketPath };
}

export async function waitForOwnedDevToolsEndpoint(
  options: {
    dataDir: string;
    childPid: number;
    startedAtMs: number;
    budgetMs: number;
  },
  deps: DevToolsPortDiscoveryDeps = defaultDeps,
): Promise<OwnedDevToolsEndpoint> {
  const discoveryStartedAtMs = deps.now();
  const deadlineMs = discoveryStartedAtMs + options.budgetMs;
  let stage: DevToolsDiscoveryStage = "active-port";
  let candidate: DevToolsEndpointIdentity | null = null;
  let primaryPid: number | null = null;
  let processPids: number[] = [];
  let portOwnerPids: number[] = [];
  let activePortReadyAtMs: number | null = null;
  let processReadyAtMs: number | null = null;

  while (deps.now() < deadlineMs) {
    stage = "active-port";
    try {
      const record = await withinDeadline(
        deps.readActivePortRecord(options.dataDir),
        deps,
        deadlineMs,
        "active-port",
      );
      if (record && record.modifiedAtMs >= options.startedAtMs) {
        candidate = parseDevToolsActivePort(record.contents);
        activePortReadyAtMs ??= deps.now();
      } else {
        candidate = null;
      }
    } catch (error) {
      if (isDeadlineError(error)) break;
      candidate = null;
    }

    if (!candidate) {
      stage = "active-port";
      await discoveryBackoff(deps, deadlineMs);
      continue;
    }

    stage = "process";
    let discovered: { processes: BrowserProcessInfo[]; enumerated: boolean };
    try {
      discovered = await withinDeadline(
        deps.enumerateProcesses(options.dataDir),
        deps,
        deadlineMs,
        "process",
      );
    } catch (error) {
      if (isDeadlineError(error)) break;
      stage = "process";
      await discoveryBackoff(deps, deadlineMs);
      continue;
    }

    const allProcessPids = discovered.processes.map((item) => item.pid);
    processPids = allProcessPids.slice(0, 20);
    const primaryProcesses = discovered.processes.filter(
      (item) => !/(?:^|\s)--type(?:=|\s)/.test(item.commandLine),
    );
    if (!discovered.enumerated || primaryProcesses.length === 0) {
      stage = "process";
      await discoveryBackoff(deps, deadlineMs);
      continue;
    }
    primaryPid = primaryProcesses[0]!.pid;
    processReadyAtMs ??= deps.now();

    stage = "ownership";
    let owners: LoopbackPortOwnersInspection;
    try {
      owners = await withinDeadline(
        deps.enumeratePortOwners(candidate.port),
        deps,
        deadlineMs,
        "ownership",
      );
    } catch (error) {
      if (isDeadlineError(error)) break;
      stage = "ownership";
      await discoveryBackoff(deps, deadlineMs);
      continue;
    }
    portOwnerPids = owners.pids.slice(0, 20);

    const ownerPidSet = new Set(owners.pids);
    const ownedPrimary = primaryProcesses.find((item) => ownerPidSet.has(item.pid));
    const hasForeignOwner = owners.pids.some((pid) => !allProcessPids.includes(pid));
    if (!owners.inspected || owners.pids.length === 0 || !ownedPrimary || hasForeignOwner) {
      stage = "ownership";
      await discoveryBackoff(deps, deadlineMs);
      continue;
    }

    primaryPid = ownedPrimary.pid;
    const completedAtMs = deps.now();
    const totalMs = completedAtMs - discoveryStartedAtMs;
    if (deps.now() > deadlineMs) break;
    const activePortCompletedAtMs = activePortReadyAtMs ?? completedAtMs;
    const processCompletedAtMs = processReadyAtMs ?? completedAtMs;
    return {
      ...candidate,
      primaryPid,
      processPids,
      portOwnerPids,
      timings: {
        activePortMs: activePortCompletedAtMs - discoveryStartedAtMs,
        processMs: processCompletedAtMs - activePortCompletedAtMs,
        ownershipMs: completedAtMs - processCompletedAtMs,
        totalMs,
      },
    };
  }

  throw new DevToolsPortDiscoveryError({
    stage,
    budgetMs: options.budgetMs,
    elapsedMs: deps.now() - discoveryStartedAtMs,
    childPid: options.childPid,
    childAlive: deps.isAlive(options.childPid),
    primaryPid,
    port: candidate?.port ?? null,
    processPids,
    portOwnerPids,
  });
}

async function discoveryBackoff(
  deps: Pick<DevToolsPortDiscoveryDeps, "now" | "sleep">,
  deadlineMs: number,
): Promise<void> {
  const remainingMs = deadlineMs - deps.now();
  if (remainingMs <= 0) return;
  await withinDeadline(
    deps.sleep(Math.min(POLL_INTERVAL_MS, remainingMs)),
    deps,
    deadlineMs,
    "backoff",
  ).catch(() => {});
}

async function withinDeadline<T>(
  operation: Promise<T>,
  deps: Pick<DevToolsPortDiscoveryDeps, "now">,
  deadlineMs: number,
  stage: string,
): Promise<T> {
  const remainingMs = deadlineMs - deps.now();
  if (remainingMs <= 0) throw new DiscoveryDeadlineError(stage);
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new DiscoveryDeadlineError(stage)), remainingMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        if (deps.now() > deadlineMs) reject(new DiscoveryDeadlineError(stage));
        else resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

class DiscoveryDeadlineError extends Error {}

function isDeadlineError(error: unknown): error is DiscoveryDeadlineError {
  return error instanceof DiscoveryDeadlineError;
}
