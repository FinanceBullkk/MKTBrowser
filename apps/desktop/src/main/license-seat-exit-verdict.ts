/**
 * Process exit status cannot prove that the vendor released a session. The licensed .6 engine
 * can exit normally while its seat remains held, so every observed exit requires a local wait.
 */
export function didBrowserExitReleaseSeat(
  _exitCode: number | null,
  _signal: NodeJS.Signals | null,
  _exitBelongsToBrowser = true,
): boolean {
  return false;
}
