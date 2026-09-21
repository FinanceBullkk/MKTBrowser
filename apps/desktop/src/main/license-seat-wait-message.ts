/**
 * What to tell an operator whose launch found no free licence seat.
 *
 * The engine's own exit-76 wording is "close another running profile", which is right for one of
 * the two ways this happens and actively misleading for the other. A seat is also unavailable when
 * a previous browser died without flushing its shutdown: the vendor still counts that session for
 * the rest of its lease, so the operator sees a refusal with nothing open to close, and the only
 * honest thing to say is how long the wait is and why it exists.
 *
 * On a one-key install this is the whole failure surface of the product, so it gets its own module
 * and its own tests rather than living as a string inside the driver.
 */

import { CLOAKBROWSER_FREE_KEY_URL } from "../shared/cloakbrowser-signup-url.ts";
import type { LicenseKeyPoolSnapshot } from "./license-key-pool.ts";

export interface LicenseSeatWaitInput {
  snapshot: LicenseKeyPoolSnapshot;
  /** From `LicenseKeyPool.nextFreeAtMs()` — null when no cooling key has a deadline. */
  nextFreeAtMs: number | null;
  nowMs: number;
  /** Profile display name, so the operator is told what to close rather than an id. */
  describeProfile?: (profileId: string) => string | null;
}

/** "about 4 minutes" / "under a minute" — a countdown nobody can act on to the second. */
function describeWait(untilMs: number, nowMs: number): string {
  const remainingMs = Math.max(0, untilMs - nowMs);
  const minutes = Math.ceil(remainingMs / 60_000);
  return remainingMs < 60_000 ? "under a minute" : `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function listProfiles(input: LicenseSeatWaitInput): string {
  const names = input.snapshot.keys
    .filter((key) => key.profileId !== null)
    .map((key) => input.describeProfile?.(key.profileId as string) ?? (key.profileId as string));
  return names.join(", ");
}

/**
 * The operator-facing reason no profile can start right now.
 *
 * Deliberately never names a licence key beyond the tail the snapshot already carries, and never
 * quotes a lease id or a vendor response — this string reaches the renderer and the MCP surface.
 */
export function licenseSeatWaitMessage(input: LicenseSeatWaitInput): string {
  const { snapshot } = input;

  if (snapshot.total === 0) {
    return (
      "No CloakBrowser licence key is set up. Add one in Settings, " +
      `or register your own free key at ${CLOAKBROWSER_FREE_KEY_URL}.`
    );
  }

  const seats = `${String(snapshot.total)} licence session${snapshot.total === 1 ? "" : "s"}`;

  if (snapshot.cooling === 0) {
    const open = listProfiles(input);
    return (
      `All ${seats} are in use${open ? ` by ${open}` : ""}. ` +
      "Close a running profile, then wait for its licence cooldown before another manual launch."
    );
  }

  const wait = input.nextFreeAtMs === null ? null : describeWait(input.nextFreeAtMs, input.nowMs);
  const retry = input.nextFreeAtMs === null
    ? "The next retry time is not known. Wait for MKT Browser to finish session recovery."
    : `Do not retry before ${new Date(input.nextFreeAtMs).toLocaleString(undefined, { hour12: false })} ` +
      `(local time; ${wait}). This is the earliest local retry time, not a guarantee of vendor availability.`;
  const resting =
    "The licence session may still be held after a browser closes or a launch is refused. " +
    `${retry} Retrying early may extend the wait. Launch again manually after the wait; there is no automatic retry.`;

  if (snapshot.inUse === 0) return resting;

  const open = listProfiles(input);
  return (
    `All ${seats} are unavailable: ${open ? `${open} still open, and a` : "a"}nother ` +
    `session is cooling. ${resting}`
  );
}
