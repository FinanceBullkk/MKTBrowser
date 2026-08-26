import assert from "node:assert/strict";
import test from "node:test";
import { didBrowserExitReleaseSeat } from "./license-seat-exit-verdict.ts";

test("treats only a normal zero exit as a clean seat release", () => {
  assert.equal(didBrowserExitReleaseSeat(0, null), true);
  assert.equal(didBrowserExitReleaseSeat(1, null), false);
  assert.equal(didBrowserExitReleaseSeat(null, "SIGKILL"), false);
  assert.equal(didBrowserExitReleaseSeat(null, null), false);
  assert.equal(
    didBrowserExitReleaseSeat(0, null, false),
    false,
    "a clean launcher exit is not evidence that its handed-off browser released the seat",
  );
});
