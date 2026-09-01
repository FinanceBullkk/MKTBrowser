/**
 * Deciding whether a launched engine actually got its licence.
 *
 * CloakBrowser opens its DevTools port before the licence server has answered. A refused key
 * therefore produces a browser that is briefly indistinguishable from a working one: `/json/version`
 * responds, a page target exists, CDP attaches, the page bootstrap starts — and only then does the
 * process exit 76.
 *
 * Every check for that exit used to be a single sample taken while the child was still alive, so
 * all of them passed and the launch resolved with an endpoint and a pid for a browser that was
 * already dying. That is what made a second licence key worthless: the rotation loop can only
 * rotate on a thrown refusal, and by the time a refusal existed the loop had already returned
 * success. Measured on 23 August 2026, three refusals on one machine landed 1.16s, 1.21s and 1.24s
 * after spawn, against a CDP-ready time near 0.8s.
 *
 * This module holds the timing and the classification. It deliberately builds no errors: the launch
 * error type lives in the MCP package, which the main-process tests cannot load, and a rule this
 * easy to re-break deserves tests that run without Electron or a built workspace.
 */

import { licenseExitMessage } from "./cloakbrowser-pro-channel.ts";

/** CloakBrowser's exit code for "this key already has a session open". */
export const SEAT_LIMIT_EXIT_CODE = 76;

/**
 * How long after spawn the engine's licence verdict can still arrive.
 *
 * Twice the slowest measured verdict. It costs a licensed launch the difference between the rest of
 * the launch work finishing and this window closing, and only on the engine that has a licence
 * channel at all.
 */
export const LICENCE_VERDICT_WINDOW_MS = 2_500;

/**
 * Was this failure the engine refusing the key, rather than anything about the profile?
 *
 * Tagged at the throw site rather than matched on the message: the message is operator-facing and
 * will be rewritten, and a rotation loop that stops working because someone improved the wording
 * would be a quiet, expensive bug.
 */
export function isSeatRefusal(error: unknown): boolean {
  return (error as { licenseExitCode?: number } | null)?.licenseExitCode === SEAT_LIMIT_EXIT_CODE;
}

/** The launch record this module reads: only whether the child's exit has been observed yet. */
export interface LicenceVerdictSubject {
  childExit?: { exitCode: number | null; signal: NodeJS.Signals | null };
}

/** The part of a ChildProcess this module needs. Narrowed so a test can supply a plain emitter. */
export interface ExitNotifier {
  once(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
}

/**
 * Wait until the child has exited or has outlived the licence verdict window, whichever is first.
 *
 * Returns at once when the exit is already recorded or the window has already passed, so a launch
 * that spent its budget elsewhere pays nothing more here. Resolving on the exit event rather than
 * always sleeping means a refusal is reported as fast as it happens.
 */
export async function settleLicenceVerdict(
  subject: LicenceVerdictSubject,
  child: ExitNotifier,
  spawnedAtMs: number,
  options: { windowMs?: number; now?: () => number } = {},
): Promise<void> {
  if (subject.childExit) return;
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? LICENCE_VERDICT_WINDOW_MS;
  const remainingMs = windowMs - (now() - spawnedAtMs);
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, remainingMs);
    child.once("exit", finish);
  });
}

/** What a during-launch child exit means, without deciding how to represent it as an error. */
export interface LaunchExitClassification {
  /** Operator-facing reason when this was the licence channel talking, else null. */
  licenceReason: string | null;
  /** True only for a seat refusal — the one failure worth spending another key on. */
  seatRefusal: boolean;
  /** What to say when the exit was not a licence matter at all. */
  fallbackMessage: string;
}

/**
 * Classify a child that died during launch.
 *
 * A licence refusal reported as a raw exit code reads as a crash, which is a misreading this
 * repository has already paid for more than once. `licenseExitMessage` already says what happened
 * and what to do about it.
 *
 * `seatRefusal` is narrower than `licenceReason` on purpose. Exit 78 — the licence server was
 * unreachable — is a licence failure and gets the operator message, but it would fail identically
 * on every key, so rotating through the pool would only multiply the wait before reporting the same
 * thing.
 */
export function classifyLaunchExit(
  exitCode: number | null,
  stage: string,
): LaunchExitClassification {
  return {
    licenceReason: licenseExitMessage(exitCode),
    seatRefusal: exitCode === SEAT_LIMIT_EXIT_CODE,
    fallbackMessage: `Chromium exited during ${stage} with code ${String(exitCode)}`,
  };
}
