import { execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(nodeExecFile);
const messages = {
  running: "Relay is running on this PC.",
  started: "Relay was started on this PC.",
  starting: "Relay is starting or has not responded yet. Wait, then retry; no second Relay was started.",
  blocked: "Relay could not be started safely. Close conflicting installations or run MKT Browser installer repair, then retry.",
  "not-installed": "Relay is not installed on this PC. Run the combined MKT Browser installer, then retry.",
  failed: "Relay startup could not be verified. Run MKT Browser installer repair, then retry.",
  cancelled: "Relay startup was cancelled.",
} as const;

export type RelayCompanionStatus = keyof typeof messages;
export interface RelayCompanionResult {
  status: RelayCompanionStatus;
  message: string;
}
type ExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: "utf8";
    timeout: number;
    windowsHide: boolean;
    maxBuffer: number;
    signal: AbortSignal;
  },
) => Promise<{ stdout: string; stderr: string }>;

export interface WindowsRelayCompanionOptions {
  scriptPath: string;
  browserPath: string;
  startupDirectory: string;
  platform?: NodeJS.Platform;
  systemRoot?: string;
  browserProcessId?: number;
  timeoutMs?: number;
  healthTimeoutMs?: number;
  pathExists?: (path: string) => boolean;
  execFile?: ExecFile;
  fetch?: typeof fetch;
}

function result(status: RelayCompanionStatus): RelayCompanionResult {
  return { status, message: messages[status] };
}

/** Explicit launch attempts only: never supervise Relay or restart it after retirement. */
export class WindowsRelayCompanion {
  private readonly options: WindowsRelayCompanionOptions;
  private readonly cancellation = new AbortController();
  private inFlight: Promise<RelayCompanionResult> | null = null;

  constructor(options: WindowsRelayCompanionOptions) {
    this.options = options;
  }

  start(): Promise<RelayCompanionResult> {
    if (this.cancellation.signal.aborted) return Promise.resolve(result("cancelled"));
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  dispose(): void {
    this.cancellation.abort();
  }

  private async run(): Promise<RelayCompanionResult> {
    const options = this.options;
    const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? "";
    if ((options.platform ?? process.platform) !== "win32" || !systemRoot) {
      return result("failed");
    }
    if ([options.scriptPath, options.browserPath, options.startupDirectory].some((path) => !path.trim()) ||
        !(options.pathExists ?? existsSync)(options.scriptPath)) {
      return result("failed");
    }
    try {
      const execFile = options.execFile ?? (execFileP as unknown as ExecFile);
      const { stdout } = await execFile(
        join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File",
          options.scriptPath, "-ExpectedBrowserPath", options.browserPath,
          "-ExpectedBrowserProcessId", String(options.browserProcessId ?? process.pid),
          "-StartupDirectory", options.startupDirectory],
        { encoding: "utf8", timeout: options.timeoutMs ?? 18_000, windowsHide: true,
          maxBuffer: 4096, signal: this.cancellation.signal },
      );
      if (this.cancellation.signal.aborted) return result("cancelled");
      const response: unknown = JSON.parse(stdout.trim());
      const status = response && typeof response === "object" && "status" in response
        ? response.status : null;
      if (typeof status !== "string" || !Object.hasOwn(messages, status)) return result("failed");
      if (status !== "running" && status !== "started") return result(status as RelayCompanionStatus);
      return await this.verifyResponse(status);
    } catch {
      return result(this.cancellation.signal.aborted ? "cancelled" : "failed");
    }
  }

  private async verifyResponse(status: "running" | "started"): Promise<RelayCompanionResult> {
    const signal = AbortSignal.any([
      this.cancellation.signal,
      AbortSignal.timeout(this.options.healthTimeoutMs ?? 3_000),
    ]);
    try {
      const response = await (this.options.fetch ?? fetch)("http://127.0.0.1:47821/health", {
        redirect: "error", signal,
      });
      // Unconfigured and retirement-pending Relay can return HTTP 400. That is not offline.
      if (response.status !== 200 && response.status !== 400) return result("starting");
      const reader = response.body?.getReader();
      if (!reader) return result("starting");
      let body = "";
      let bytes = 0;
      try {
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 16_384) return result("starting");
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } finally {
        await reader.cancel();
      }
      const health: unknown = JSON.parse(body);
      return result(health && typeof health === "object" && "relayVersion" in health &&
        Number.isSafeInteger(health.relayVersion) && Number(health.relayVersion) > 0
        ? status : "starting");
    } catch {
      return result(this.cancellation.signal.aborted ? "cancelled" : "starting");
    }
  }
}
