import { execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

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

/** Shares the installer's ownership checks with `/setup` without mutating or stopping anything. */
export class WindowsLocalInstallInspector {
  private readonly options: WindowsLocalInstallInspectorOptions;
  private readonly now: () => number;
  private cached: { ready: boolean; expiresAt: number } | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(options: WindowsLocalInstallInspectorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async isReady(): Promise<boolean> {
    const current = this.now();
    if (this.cached && current < this.cached.expiresAt) return this.cached.ready;
    if (this.inFlight) return await this.inFlight;

    this.inFlight = this.inspect().then((ready) => {
      this.cached = {
        ready,
        expiresAt: this.now() + (this.options.cacheTtlMs ?? 5_000),
      };
      return ready;
    });

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async inspect(): Promise<boolean> {
    if ((this.options.platform ?? process.platform) !== "win32") return false;
    if (
      [
        this.options.scriptPath,
        this.options.browserPath,
        this.options.relayPath,
        this.options.startupDirectory,
      ].some((value) => value.trim() === "")
    ) {
      return false;
    }

    const pathExists = this.options.pathExists ?? existsSync;
    if (!pathExists(this.options.scriptPath)) return false;

    try {
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
      return true;
    } catch {
      return false;
    }
  }
}
