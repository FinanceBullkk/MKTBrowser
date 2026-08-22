import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * The one writer for `profile-shutdown.log`.
 *
 * A packaged Electron main process throws stdout and stderr away, so for most of this app's life
 * the only record of why a profile closed was whatever an operator remembered seeing. An evening
 * in August 2026 went into deducing from the outside what the app knew exactly and never wrote
 * down. This file is that record, and it is deliberately a single append-only JSONL stream: one
 * writer, one format, greppable, and readable without the app running.
 *
 * Every caller goes through here rather than opening the file itself, so the shape stays uniform
 * and the path is stated once.
 */
export function appendProfileLifecycleLine(record: Record<string, unknown>): void {
  try {
    appendFileSync(
      join(app.getPath("userData"), "profile-shutdown.log"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`,
      "utf8",
    );
  } catch {
    // Diagnostics must never interfere with launching or closing a browser.
  }
}
