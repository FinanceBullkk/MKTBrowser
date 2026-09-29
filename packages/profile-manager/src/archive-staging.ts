import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const PROFILE_ARCHIVE_STAGING_PREFIX = ".mzar-profile-";
export const EXTENSION_ARCHIVE_STAGING_PREFIX = ".mzar-extension-";

const ARCHIVE_STAGING_PREFIXES = [
  PROFILE_ARCHIVE_STAGING_PREFIX,
  EXTENSION_ARCHIVE_STAGING_PREFIX,
] as const;

/** Remove decrypted import staging directories left by an interrupted process. */
export async function reclaimStaleArchiveStaging(parent: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  let removed = 0;
  const failures: unknown[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !ARCHIVE_STAGING_PREFIXES.some((prefix) => entry.name.startsWith(prefix))
    ) {
      continue;
    }
    try {
      await rm(join(parent, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Could not remove stale profile-import staging data.");
  }
  return removed;
}
