import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_OUTPUT_BYTES = 1_048_576;
const IDLE_TIMEOUT_MS = 10_000;

interface PendingQuery {
  resolve: (rows: unknown[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type SpawnWorker = () => ChildProcessWithoutNullStreams;

/** Reuses the shell, never its process table. Only one fresh query is in flight at a time. */
export class WindowsProcessQueryWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private active: PendingQuery | null = null;
  private queue: PendingQuery[] = [];
  private output = "";
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly spawnWorker: SpawnWorker;
  private readonly idleTimeoutMs: number;

  constructor(spawnWorker: SpawnWorker, idleTimeoutMs = IDLE_TIMEOUT_MS) {
    this.spawnWorker = spawnWorker;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  query(timeoutMs: number): Promise<unknown[]> {
    if (this.disposed) return Promise.reject(new Error("Process query worker is disposed"));
    return new Promise((resolve, reject) => {
      const request: PendingQuery = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const error = Object.assign(new Error("Windows process query timed out"), {
            killed: true,
            signal: "SIGTERM",
          });
          if (this.active === request) this.fail(error);
          else {
            this.queue = this.queue.filter((item) => item !== request);
            reject(error);
          }
        }, timeoutMs),
      };
      this.queue.push(request);
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.retire();
    const requests = [...this.queue, ...(this.active ? [this.active] : [])];
    this.queue = [];
    this.active = null;
    for (const request of requests) {
      clearTimeout(request.timer);
      request.reject(new Error("Process query worker is disposed"));
    }
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    clearTimeout(this.idleTimer);
    this.active = this.queue.shift()!;
    try {
      if (!this.child) {
        const child = this.spawnWorker();
        this.child = child;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (this.child === child) this.receive(chunk);
        });
        child.stderr.resume();
        const failed = () => {
          if (this.child === child) this.fail(new Error("Windows process query worker exited"));
        };
        child.on("error", failed);
        child.on("exit", failed);
        child.stdin.on("error", failed);
        child.stdout.on("error", failed);
      }
      this.child.stdin.write("query\n");
    } catch {
      this.fail(new Error("Could not start Windows process query worker"));
    }
  }

  private receive(chunk: string): void {
    this.output += chunk;
    if (Buffer.byteLength(this.output, "utf8") > MAX_OUTPUT_BYTES) {
      this.fail(new Error("Windows process query output exceeded its bound"));
      return;
    }
    const newline = this.output.indexOf("\n");
    if (newline < 0) return;
    const line = this.output.slice(0, newline);
    const extra = this.output.slice(newline + 1);
    this.output = "";
    let rows: unknown;
    try {
      rows = JSON.parse(line);
      if (!Array.isArray(rows) || extra.length > 0 || !this.active) throw new Error();
    } catch {
      this.fail(new Error("Windows process query returned an invalid frame"));
      return;
    }
    const request = this.active!;
    this.active = null;
    clearTimeout(request.timer);
    request.resolve(rows as unknown[]);
    if (this.queue.length > 0) this.pump();
    else {
      this.idleTimer = setTimeout(() => this.retire(), this.idleTimeoutMs);
      this.idleTimer.unref();
    }
  }

  private fail(error: Error): void {
    const request = this.active;
    this.active = null;
    this.retire();
    if (request) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pump();
  }

  private retire(): void {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    this.output = "";
    // A timeout must retire the shell: its late response cannot satisfy the next snapshot.
    if (child) {
      child.stdin.destroy();
      child.kill();
    }
  }
}

export function createWindowsProcessQueryWorker(
  powershell: string,
  queryScript: string,
): WindowsProcessQueryWorker {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    // Requests contain no paths or executable code; stdout is one bounded JSON array per query.
    `while ([Console]::In.ReadLine() -eq 'query') { try { ${queryScript} } catch { [Console]::Out.WriteLine('!error') }; [Console]::Out.Flush() }`,
  ].join("; ");
  return new WindowsProcessQueryWorker(() =>
    spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: "pipe",
    }),
  );
}
