import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  LICENCE_VERDICT_WINDOW_MS,
  SEAT_LIMIT_EXIT_CODE,
  classifyLaunchExit,
  isSeatRefusal,
  settleLicenceVerdict,
  type LicenceVerdictSubject,
} from "./licence-verdict.ts";

/** What the driver does with a classification, so the two halves are tested as one decision. */
function taggedError(exitCode: number | null, stage: string): Error {
  const { licenceReason, fallbackMessage } = classifyLaunchExit(exitCode, stage);
  if (licenceReason) {
    const refusal = new Error(licenceReason);
    (refusal as { licenseExitCode?: number }).licenseExitCode = exitCode ?? undefined;
    return refusal;
  }
  return new Error(fallbackMessage);
}

/** A stand-in for the spawned engine: the launch path only ever waits on its `exit`. */
function fakeChild(): EventEmitter & { exitAfter: (ms: number, subject: LicenceVerdictSubject, code: number) => void } {
  const emitter = new EventEmitter() as EventEmitter & {
    exitAfter: (ms: number, subject: LicenceVerdictSubject, code: number) => void;
  };
  emitter.exitAfter = (ms, subject, code) => {
    setTimeout(() => {
      // The driver's own exit handler records the exit before listeners run; mirror that order,
      // because the check after the wait reads the record rather than the event payload.
      subject.childExit = { exitCode: code, signal: null };
      emitter.emit("exit");
    }, ms).unref?.();
  };
  return emitter;
}

test("catches a refusal that lands after the launch has otherwise finished", async () => {
  // The defect this module exists for. The engine serves CDP, the launch work completes, and the
  // licence verdict arrives a few hundred milliseconds later. A single sample taken when the work
  // finished sees a live process and reports a running profile that is already dying.
  const subject: LicenceVerdictSubject = {};
  const child = fakeChild();
  const spawnedAtMs = Date.now();
  child.exitAfter(80, subject, SEAT_LIMIT_EXIT_CODE);

  // What the old one-shot check saw at this instant: nothing. Compared as a boolean so the
  // assertion does not narrow the field away for the checks that follow.
  assert.equal(subject.childExit === undefined, true);

  await settleLicenceVerdict(subject, child, spawnedAtMs, { windowMs: 400 });

  assert.deepEqual(subject.childExit, { exitCode: SEAT_LIMIT_EXIT_CODE, signal: null });
  assert.ok(subject.childExit);
  assert.ok(isSeatRefusal(taggedError(subject.childExit.exitCode, "licence verification")));
});

test("returns as soon as the child exits rather than sleeping out the window", async () => {
  // A refusal must be reported at the speed it happens: the operator is waiting, and the rotation
  // loop still has another key to try.
  const subject: LicenceVerdictSubject = {};
  const child = fakeChild();
  child.exitAfter(40, subject, SEAT_LIMIT_EXIT_CODE);

  const startedAt = Date.now();
  await settleLicenceVerdict(subject, child, Date.now(), { windowMs: 5_000 });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 1_000, `settled in ${elapsed}ms, so it did not wait out the whole window`);
});

test("waits the full window when the engine keeps running", async () => {
  // The cost side of the trade. A launch that is genuinely fine pays the remainder of the window,
  // and must not be waved through early on the strength of the process merely being alive.
  const subject: LicenceVerdictSubject = {};
  const child = fakeChild();

  const startedAt = Date.now();
  await settleLicenceVerdict(subject, child, Date.now(), { windowMs: 150 });
  const elapsed = Date.now() - startedAt;

  assert.equal(subject.childExit, undefined);
  assert.ok(elapsed >= 140, `waited ${elapsed}ms, expected the window to be honoured`);
});

test("costs nothing when the verdict is already in or the window has already passed", async () => {
  // Both early exits matter: a launch that spent its budget elsewhere must not be taxed again.
  const alreadyExited: LicenceVerdictSubject = { childExit: { exitCode: 0, signal: null } };
  let startedAt = Date.now();
  await settleLicenceVerdict(alreadyExited, fakeChild(), Date.now(), { windowMs: 5_000 });
  assert.ok(Date.now() - startedAt < 100);

  const windowPassed: LicenceVerdictSubject = {};
  startedAt = Date.now();
  await settleLicenceVerdict(windowPassed, fakeChild(), Date.now() - 10_000, { windowMs: 2_500 });
  assert.ok(Date.now() - startedAt < 100);
});

test("tags a seat refusal so the rotation loop can reach the next key", () => {
  const error = taggedError(SEAT_LIMIT_EXIT_CODE, "licence verification");

  assert.ok(isSeatRefusal(error), "exit 76 must be recognised as a seat refusal");
  assert.match(error.message, /session limit/i);
  assert.doesNotMatch(
    error.message,
    /exited during/,
    "a refusal reported as a raw exit reads as a crash, which is the misreading this replaces",
  );
});

test("does not tag failures that would repeat on every key", () => {
  // Rotating here would multiply the operator's wait and end with the same answer.
  const crash = taggedError(1, "launch");
  assert.equal(isSeatRefusal(crash), false);
  assert.match(crash.message, /exited during launch with code 1/);

  // Exit 78 is a licence-channel failure — the licence server was unreachable. It gets the operator
  // message, because that is what happened, but it is NOT a seat refusal: every key would fail the
  // same way, so the loop must report it rather than burn the pool discovering that.
  const serverDown = taggedError(78, "licence verification");
  assert.equal(
    isSeatRefusal(serverDown),
    false,
    "only a seat refusal may rotate; other licence failures repeat on every key",
  );
});

test("the default window is wider than the verdicts actually measured", () => {
  // Measured 23 August 2026 on one machine: 1.16s, 1.21s and 1.24s after spawn. A window that
  // drifts below those numbers restores the original defect silently, so it is asserted here.
  assert.ok(
    LICENCE_VERDICT_WINDOW_MS >= 2_480,
    `window is ${LICENCE_VERDICT_WINDOW_MS}ms, too tight for a verdict measured at 1.24s`,
  );
});
