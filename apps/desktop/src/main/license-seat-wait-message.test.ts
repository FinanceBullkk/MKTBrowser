import assert from "node:assert/strict";
import test from "node:test";
import type { LicenseKeyPoolSnapshot } from "./license-key-pool.ts";
import { licenseSeatWaitMessage } from "./license-seat-wait-message.ts";

function snapshotOf(
  keys: readonly { state: "idle" | "in-use" | "cooling"; profileId?: string }[],
): LicenseKeyPoolSnapshot {
  const full = keys.map((key, index) => ({
    keyTail: `tail${String(index)}`,
    state: key.state,
    profileId: key.profileId ?? null,
    cooldownEndsAt: null,
  }));
  return {
    total: full.length,
    idle: full.filter((k) => k.state === "idle").length,
    inUse: full.filter((k) => k.state === "in-use").length,
    cooling: full.filter((k) => k.state === "cooling").length,
    keys: full,
  };
}

test("names the profile to close when every seat is genuinely in use", () => {
  const message = licenseSeatWaitMessage({
    snapshot: snapshotOf([{ state: "in-use", profileId: "p1" }]),
    nextFreeAtMs: null,
    nowMs: 0,
    describeProfile: (id) => (id === "p1" ? "TikTok main" : null),
  });

  assert.match(message, /TikTok main/);
  assert.match(message, /Close a running profile/);
});

test("a resting seat is never reported as something the operator can close", () => {
  // The engine's own exit-76 text says "close another running profile". With nothing open that
  // reads as a bug in the product, and the operator has no move to make.
  const message = licenseSeatWaitMessage({
    snapshot: snapshotOf([{ state: "cooling" }]),
    nextFreeAtMs: 4 * 60_000,
    nowMs: 0,
  });

  assert.match(message, /closed without handing its licence session back/);
  assert.match(message, /about 4 minutes/);
  assert.doesNotMatch(message, /Close a running profile/);
});

test("rounds a sub-minute wait rather than showing a dead countdown", () => {
  const message = licenseSeatWaitMessage({
    snapshot: snapshotOf([{ state: "cooling" }]),
    nextFreeAtMs: 20_000,
    nowMs: 0,
  });

  assert.match(message, /under a minute/);
});

test("a mixed pool offers the action that actually shortens the wait", () => {
  const message = licenseSeatWaitMessage({
    snapshot: snapshotOf([{ state: "in-use", profileId: "p1" }, { state: "cooling" }]),
    nextFreeAtMs: 10 * 60_000,
    nowMs: 0,
    describeProfile: () => "Shop account",
  });

  assert.match(message, /Shop account/);
  assert.match(message, /resting/);
  assert.match(message, /Close a running profile to free one sooner/);
});

test("no configured key is a setup problem, not a capacity problem", () => {
  const message = licenseSeatWaitMessage({
    snapshot: snapshotOf([]),
    nextFreeAtMs: null,
    nowMs: 0,
  });

  assert.match(message, /No CloakBrowser licence key is set up/);
  assert.doesNotMatch(message, /in use/);
});

test("never leaks a licence key", () => {
  const message = licenseSeatWaitMessage({
    snapshot: snapshotOf([{ state: "cooling" }, { state: "in-use", profileId: "p1" }]),
    nextFreeAtMs: 60_000,
    nowMs: 0,
  });

  assert.doesNotMatch(message, /tail0|tail1|cb_/);
});
