/**
 * What the driver remembers about a browser process, and the breadcrumbs it leaves behind.
 *
 * Extracted from `ChromiumBrowserDriver.ts` on 18 September 2026. These shapes are shared by the
 * driver, the shutdown sequence and the window watcher, so leaving them in the driver forced those
 * modules to import from the very file that calls them.
 */
import type { ChildProcess } from "node:child_process";
import type { CdpSession } from "@mktbrowser/cdp-driver";
import type { ProfileId, ProxyConfig } from "@mktbrowser/types";
import { appendProfileLifecycleLine } from "./profile-lifecycle-log.ts";

export interface BrowserProcessContext {
  /** Present for the legacy direct-spawn path. The vendor SDK owns its child process privately. */
  child?: ChildProcess;
  /** Vendor SDK context close when Playwright owns the process pipe. */
  gracefulClose?: () => Promise<void>;
  cdpEndpoint: string;
  port: number;
  pid: number;
  startedAt: string;
  session: CdpSession;
  /** The engine's `--user-data-dir`. Used to sweep any lingering browser
   *  process that still holds this profile's data dir on shutdown. */
  browserDataDir: string;
}

export interface WindowWatcher {
  stop(): void;
}

export interface RunningProcess extends BrowserProcessContext {
  /** Polls /json/list and kills the child when no page targets remain. */
  windowWatcher: WindowWatcher;
  /** Snapshot of the proxy actually used for this process, including auth for exact comparison. */
  proxy?: ProxyConfig;
  /** Egress observed by the launch-time proxy probe; never exposed through MCP output. */
  observedProxyIp?: string;
}

export interface LaunchingProcess {
  child?: ChildProcess;
  gracefulClose?: () => Promise<void>;
  cdpEndpoint: string | null;
  port: number | null;
  pid: number;
  startedAt: string;
  session: CdpSession | null;
  browserDataDir: string;
  childExit?: { exitCode: number | null; signal: NodeJS.Signals | null };
  spawnError?: unknown;
}

export type TrackedBrowserProcess = BrowserProcessContext | LaunchingProcess;

export type WindowWatcherShutdownReason =
  | { reason: "ZERO-PAGES"; targetTypes: Array<string | null> }
  | { reason: "CDP-UNREACHABLE"; errorCode: string };

export type ProfileLifecycleLogReason =
  | WindowWatcherShutdownReason["reason"]
  | "CLOSE-REQUESTED"
  | "CHILD-EXIT"
  | "Browser.close"
  | "SIGTERM"
  | "SIGKILL"
  | "BOOTSTRAP-START"
  | "BOOTSTRAP-TARGET-START"
  | "BOOTSTRAP-PROBE-START"
  | "BOOTSTRAP-PROBE-DONE"
  | "BOOTSTRAP-PROBE-FAILED"
  | "BOOTSTRAP-TARGET-DONE"
  | "BOOTSTRAP-DONE"
  | "BOOTSTRAP-FAILED"
  | "LAUNCH-FAILED"
  | "SHUTDOWN-COMPLETE"
  | "SHUTDOWN-FAILED"
  | "SWEEP-DISCOVERY-FAILED"
  | "LICENCE-KEY-REFUSED";

export interface ProfileLifecycleLogDetails {
  targetTypes?: Array<string | null>;
  errorCode?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  isRoot?: boolean;
  targetType?: "page" | "iframe";
  targetPid?: number;
  shutdownSource?: "graceful-shutdown" | "data-dir-sweep";
  shutdownMethod?: "already-exited" | "Browser.close" | "SIGTERM" | "SIGKILL";
}

export type ProfileLifecycleLogContext = Pick<TrackedBrowserProcess, "pid" | "port" | "startedAt">;

export function writeProfileLifecycleLog(
  profileId: ProfileId,
  context: ProfileLifecycleLogContext,
  reason: ProfileLifecycleLogReason,
  details: ProfileLifecycleLogDetails = {},
): void {
  // Persist before a hung launch or a shutdown escalation can erase the last useful breadcrumb.
  const elapsedSeconds = Number(((Date.now() - Date.parse(context.startedAt)) / 1000).toFixed(3));
  appendProfileLifecycleLine({
    profileId,
    pid: context.pid,
    port: context.port,
    elapsedSeconds,
    reason,
    ...details,
  });
}

export function isPidAlive(pid: number): boolean {
  try {
    // signal 0 = "is process alive" probe, doesn't actually signal it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
