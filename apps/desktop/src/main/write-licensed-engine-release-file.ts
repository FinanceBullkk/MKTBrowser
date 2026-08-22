/**
 * Regenerates `windows-engine-release.json` — the record Windows packaging is
 * required to name, and the one the compatibility manifest is signed over.
 *
 * The committed record describes 146.0.7680.177.5 from the open GitHub
 * releases, because that was the last build with a public archive. Machines now
 * converge on the licensed channel instead, so a record naming 146 would sign a
 * claim that contradicts what those machines actually run — precisely the
 * mixed-version assertion the compatibility set exists to prevent.
 *
 * A licensed record therefore carries no URL. That is not an omission:
 *
 *   - the licensed archive URL is presigned and expires, so it cannot be signed
 *     into a durable artifact and still be true later
 *   - it would buy nothing if it could. The 151 binary enforces its own licence
 *     at launch — measured: exit 77 without a key — so no URL, public or
 *     mirrored, lets a machine use the engine without its own key. Reach is
 *     already zero; only the digest carries weight
 *
 * `source` states this positively, so a reader months from now sees "fetched
 * through the licensed channel" rather than guessing someone forgot a field.
 */
import { writeFileSync } from "node:fs";
import { win32 } from "node:path";

import { resolveLicensedEngineDescriptor } from "./resolve-licensed-engine-descriptor.ts";

export interface LicensedEngineReleaseRecord {
  schemaVersion: 1;
  type: "mktbrowser.windows-engine-release";
  engineKind: "cloakbrowser";
  source: "licensed-channel";
  version: string;
  sha256: string;
  sizeBytes: number;
  verifiedAt: string;
}

export async function buildLicensedEngineReleaseRecord(
  licenseKey: string,
  now = new Date(),
): Promise<LicensedEngineReleaseRecord> {
  const engine = await resolveLicensedEngineDescriptor(licenseKey);
  return {
    schemaVersion: 1,
    type: "mktbrowser.windows-engine-release",
    engineKind: "cloakbrowser",
    source: "licensed-channel",
    version: engine.version,
    sha256: engine.sha256,
    sizeBytes: engine.sizeBytes,
    verifiedAt: now.toISOString(),
  };
}

if (process.argv[1] && import.meta.url.endsWith(win32.basename(process.argv[1]))) {
  const target =
    process.argv[2] ?? win32.join(process.cwd(), "apps", "desktop", "windows-engine-release.json");
  buildLicensedEngineReleaseRecord(process.env.CLOAKBROWSER_LICENSE_KEY ?? "")
    .then((record) => {
      writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      console.log(`Wrote ${record.version} (${record.sizeBytes} bytes) to ${target}`);
    })
    .catch((error: unknown) => {
      console.error(`Refused: ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
