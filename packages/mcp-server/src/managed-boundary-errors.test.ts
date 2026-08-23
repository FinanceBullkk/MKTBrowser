import assert from "node:assert/strict";
import test from "node:test";
import { managedProfileLocked, unmanagedProfileLaunch } from "./mkt-browser-tool-errors.js";

/**
 * Both sides of the managed/unmanaged boundary refuse, and for a while both said the same thing.
 *
 * `launch_managed_profile` on a profile MKTTool does not own reported "Managed profile X can be
 * controlled only through MKTTool" — the exact opposite of what had happened. Reading it sends you
 * looking for MKTTool ownership and permissions that were never part of the failure. It cost real
 * time during the Phase 5 isolation run before the source said otherwise.
 */

const PROFILE_ID = "profile-1";

test("the managed direction says the profile belongs to MKTTool", () => {
  const error = managedProfileLocked(PROFILE_ID);

  assert.equal(error.code, "MANAGED_PROFILE_LOCKED");
  assert.match(error.message, /only through MKTTool/);
});

test("the unmanaged direction says the profile is not managed, and names the tool that works", () => {
  const error = unmanagedProfileLaunch(PROFILE_ID);

  assert.match(error.message, /is not a managed profile/);
  assert.match(error.message, /launch_profile/);
  // The sentence that caused the misreading must not come back on this path.
  assert.doesNotMatch(
    error.message,
    /only through MKTTool/,
    "an unmanaged profile must not be described as controllable only through MKTTool",
  );
});

test("both keep the same code, because the same layer refused", () => {
  // The Relay allowlists these codes across repositories. The wording was wrong; the classification
  // was not, and splitting the code would be a cross-repository contract change for a message bug.
  assert.equal(unmanagedProfileLaunch(PROFILE_ID).code, managedProfileLocked(PROFILE_ID).code);
});
