import { app } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the bundled first-party "companion" extension (the one that
 * injects the "Add to MKT Browser" button on Web Store pages). It is loaded into
 * every profile via --load-extension and is never part of a profile's
 * user-visible extension list.
 *
 *   packaged: <resources>/companion   (electron-builder extraResources)
 *   dev:      apps/desktop/resources/companion
 *
 * Returns null if it can't be located (loading just proceeds without it).
 */
export function companionDir(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "companion")]
    : [
        // import.meta.url resolves to out/main/index.js at runtime → up to
        // apps/desktop, then resources/companion.
        join(fileURLToPath(new URL(".", import.meta.url)), "../../resources/companion"),
      ];
  for (const c of candidates) {
    if (existsSync(join(c, "manifest.json"))) return c;
  }
  return null;
}
