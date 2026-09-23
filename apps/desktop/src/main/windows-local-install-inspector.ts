import { execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { MktBrowserLocalInstallReadiness } from "@mktbrowser/types";

const execFileP = promisify(nodeExecFile);

type ExecFile = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export interface WindowsLocalInstallInspectorOptions {
  scriptPath: string;
  browserPath: string;
  relayPath: string;
  startupDirectory: string;
  platform?: NodeJS.Platform;
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  pathExists?: (path: string) => boolean;
  execFile?: ExecFile;
}

export type WindowsLocalInstallReadiness = MktBrowserLocalInstallReadiness;

type CompletedReadiness = Exclude<WindowsLocalInstallReadiness, "checking">;

interface InFlightInspection {
  generation: number;
  promise: Promise<CompletedReadiness>;
}

/** Shares the installer's ownership checks with `/setup` without mutating or stopping anything. */
export class WindowsLocalInstallInspector {
  private readonly options: WindowsLocalInstallInspectorOptions;
  private readonly now: () => number;
  private cached: { readiness: CompletedReadiness; expiresAt: number; generation: number } | null =
    null;
  private inFlight: InFlightInspection | null = null;
  private generation = 0;
  private refreshAfterFlight = false;

  constructor(options: WindowsLocalInstallInspectorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Returns the current fail-closed verdict and starts one bounded refresh when it is stale. */
  snapshot(): WindowsLocalInstallReadiness {
    const current = this.now();
    if (
      this.cached &&
      this.cached.generation === this.generation &&
      current < this.cached.expiresAt
    ) {
      return this.cached.readiness;
    }

    this.startInspection();
    return "checking";
  }

  async isReady(): Promise<boolean> {
    const readiness = this.snapshot();
    if (readiness !== "checking") return readiness === "ready";

    const generation = this.generation;
    const inFlight = this.inFlight;
    if (!inFlight) return false;

    return (await inFlight.promise) === "ready" && generation === this.generation;
  }

  /** Drops a cached verdict and schedules a new serialized observation. */
  invalidate(): void {
    this.generation += 1;
    this.cached = null;

    if (this.inFlight) {
      // PowerShell cannot be cancelled safely here. Let it settle, discard its answer, then run one
      // current-generation observation instead of starting concurrent ownership checks.
      this.refreshAfterFlight = true;
      return;
    }

    this.startInspection();
  }

  private startInspection(): void {
    if (this.inFlight) return;

    const inspection: InFlightInspection = {
      generation: this.generation,
      promise: this.inspect(),
    };
    this.inFlight = inspection;

    void inspection.promise.then((readiness) => {
      if (this.inFlight === inspection) this.inFlight = null;

      const needsRefresh = this.refreshAfterFlight || inspection.generation !== this.generation;
      this.refreshAfterFlight = false;
      if (!needsRefresh) {
        this.cached = {
          readiness,
          expiresAt: this.now() + (this.options.cacheTtlMs ?? 5_000),
          generation: inspection.generation,
        };
        return;
      }

      this.startInspection();
    });
  }

  private async inspect(): Promise<CompletedReadiness> {
    try {
      if ((this.options.platform ?? process.platform) !== "win32") return "unavailable";
      if (
        [
          this.options.scriptPath,
          this.options.browserPath,
          this.options.relayPath,
          this.options.startupDirectory,
        ].some((value) => value.trim() === "")
      ) {
        return "unavailable";
      }

      const pathExists = this.options.pathExists ?? existsSync;
      if (!pathExists(this.options.scriptPath)) return "unavailable";

      const execFile = this.options.execFile ?? (execFileP as unknown as ExecFile);
      await execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.options.scriptPath,
          "-ExpectedBrowserPath",
          this.options.browserPath,
          "-ExpectedRelayPath",
          this.options.relayPath,
          "-StartupDirectory",
          this.options.startupDirectory,
          "-RuntimeInspection",
        ],
        {
          encoding: "utf8",
          timeout: this.options.timeoutMs ?? 5_000,
          windowsHide: true,
        },
      );
      return "ready";
    } catch (error) {
      return isDefinitiveDetectorFailure(error) ? "failed" : "unavailable";
    }
  }
}

function isDefinitiveDetectorFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const { code, killed, signal } = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  if (killed === true || (typeof signal === "string" && signal.length > 0)) return false;

  const exitCode =
    typeof code === "number"
      ? code
      : typeof code === "string" && /^\d+$/.test(code)
        ? Number(code)
        : null;

  // These are the detector's explicit ownership/conflict verdicts. Transport, timeout, launch,
  // and unrecognized failures mean the Browser cannot verify the installation, not that repair is
  // definitely required.
  return exitCode !== null && exitCode >= 20 && exitCode <= 26;
}
