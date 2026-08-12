import assert from "node:assert/strict";
import test from "node:test";
import { ActivityLog } from "./ActivityLog.js";

test("activity diagnostics drop arguments under unrecognised keys", () => {
  const log = new ActivityLog();
  log.startCall("future_tool", {
    profile_id: "profile-1",
    unclassified_argument: "must never reach the activity feed",
  });

  const event = log.recent()[0];
  assert.ok(event);
  assert.deepEqual(event.args, { profile_id: "profile-1" });
  assert.doesNotMatch(JSON.stringify(event), /unclassified_argument|must never reach/);
});
