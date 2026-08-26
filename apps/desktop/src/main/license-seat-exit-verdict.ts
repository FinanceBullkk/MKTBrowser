/**
 * Whether an already-exited Browser gave its vendor seat back cleanly.
 *
 * A normal window close exits with code 0 and no signal after the engine flushes its session. A
 * crash, hard kill, or ambiguous exit may leave the vendor heartbeat lease alive, so it must rest.
 */
export function didBrowserExitReleaseSeat(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  exitBelongsToBrowser = true,
): boolean {
  return exitBelongsToBrowser && exitCode === 0 && signal === null;
}
