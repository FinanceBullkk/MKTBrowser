import { EventEmitter } from "node:events";

export interface ActivityEvent {
  id: string;
  timestamp: string;
  /** Tool name as called via MCP, e.g. "navigate" */
  tool: string;
  profileId?: string;
  /** Sanitized args (no secrets) */
  args: Record<string, unknown>;
  /** "ok" if completed, "error" if threw, "pending" if still running */
  status: "pending" | "ok" | "error";
  /** Result summary or error message */
  summary?: string;
  durationMs?: number;
}

interface ActivityLogEvents {
  event: (e: ActivityEvent) => void;
}

/**
 * Emits ActivityEvent for every MCP tool call. The renderer subscribes
 * via IPC, the desktop app shows them in real-time, and they can also
 * be piped to a JSONL file for audit.
 */
export class ActivityLog extends EventEmitter {
  private readonly buffer: ActivityEvent[] = [];
  private readonly maxBuffer = 500;

  override on<K extends keyof ActivityLogEvents>(event: K, listener: ActivityLogEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof ActivityLogEvents>(
    event: K,
    ...args: Parameters<ActivityLogEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  startCall(tool: string, args: Record<string, unknown>): ActivityEvent {
    const event: ActivityEvent = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      tool,
      profileId: typeof args.profile_id === "string" ? args.profile_id : undefined,
      args: sanitize(args),
      status: "pending",
    };
    this.push(event);
    return event;
  }

  finish(event: ActivityEvent, status: "ok" | "error", summary: string, startedAt: number): void {
    event.status = status;
    event.summary = summary.slice(0, 500);
    event.durationMs = Date.now() - startedAt;
    this.emit("event", event);
  }

  recent(limit = 200): ActivityEvent[] {
    return this.buffer.slice(-limit);
  }

  private push(e: ActivityEvent): void {
    this.buffer.push(e);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }
    this.emit("event", e);
  }
}

type ArgumentReducer = (value: unknown) => unknown;

const boundedString: ArgumentReducer = (value) =>
  typeof value === "string" ? value.slice(0, 128) : undefined;

const boundedNumber: ArgumentReducer = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Diagnostics are default-deny. Each entry names one permitted argument and the reduced shape
 * retained by the feed; every unrecognised key is discarded.
 */
const ACTIVITY_ARGUMENT_ALLOWLIST: Readonly<Record<string, ArgumentReducer>> = {
  profile_id: boundedString,
  operation_id: boundedString,
  request_id: boundedString,
  sessionId: boundedString,
  target_id: boundedString,
  timeout_ms: boundedNumber,
  tags: (value) => (Array.isArray(value) ? { count: value.length } : undefined),
  urls: (value) => (Array.isArray(value) ? { count: value.length } : undefined),
  cookies: (value) => (Array.isArray(value) ? { count: value.length } : undefined),
  proxy: (value) => {
    if (!value || typeof value !== "object") return undefined;
    const proxy = value as Record<string, unknown>;
    return {
      type: proxy.type === "http" || proxy.type === "socks5" ? proxy.type : "unknown",
      configured: true,
      hasAuth: Boolean(proxy.username || proxy.password),
    };
  },
  fingerprint: (value) => {
    if (!value || typeof value !== "object") return undefined;
    const fingerprint = value as Record<string, unknown>;
    return {
      device: typeof fingerprint.device === "string" ? fingerprint.device : undefined,
      hasLocale: typeof fingerprint.localeId === "string",
      hasTimezone: typeof fingerprint.timezone === "string",
      hasScreen: Boolean(fingerprint.screen),
      hasHardwareConcurrency: typeof fingerprint.hardwareConcurrency === "number",
      hasDeviceMemory: typeof fingerprint.deviceMemory === "number",
    };
  },
};

function sanitize(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, reducer] of Object.entries(ACTIVITY_ARGUMENT_ALLOWLIST)) {
    if (!(key in args)) continue;
    const reduced = reducer(args[key]);
    if (reduced !== undefined) out[key] = reduced;
  }
  return out;
}
