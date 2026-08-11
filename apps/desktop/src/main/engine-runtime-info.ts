/**
 * Translate the Chromium bootstrap's internal state into the engine half of the runtime contract.
 *
 * Kept as a pure function so the mapping can be tested without starting Electron, and so a caller
 * can always tell "the engine is still being prepared" apart from "this device is broken".
 */

import type { ChromiumStatus, MktBrowserEngineInfo, MktBrowserEngineKind } from "@mktbrowser/types";

export function describeEngineStatus(
  engine: MktBrowserEngineKind,
  status: ChromiumStatus,
): MktBrowserEngineInfo {
  return {
    kind: engine,
    // Only some stages know a version. Reporting `null` is honest; inventing one would let a
    // caller believe a specific engine is installed while it is still downloading.
    version: "version" in status ? status.version : null,
    status: status.kind,
  };
}
