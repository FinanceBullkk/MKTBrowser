import { lstatSync, mkdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Profile } from "@mktbrowser/types";

export interface StagedExtension {
  source: string;
  destination: string;
}

function existingDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Unsafe extension store path.");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** No await: another in-process installer must not adopt an extension before the row commits. */
export function publishImportedProfile(
  profile: Profile,
  extensions: StagedExtension[],
  stagingRoot: string | undefined,
  persist: ((value: Profile) => Profile) | undefined,
): Profile {
  const published: string[] = [];
  const parents: string[] = [];
  try {
    for (const ext of extensions) {
      const parent = dirname(ext.destination);
      if (!existingDirectory(parent)) {
        mkdirSync(parent);
        parents.push(parent);
      }
      if (existingDirectory(ext.destination)) continue;
      renameSync(ext.source, ext.destination);
      published.push(ext.destination);
    }
    if (stagingRoot) rmSync(stagingRoot, { recursive: true, force: true });
    return persist ? persist(profile) : profile;
  } catch (error) {
    const failed: unknown[] = [];
    for (const dir of published.reverse()) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (cleanupError) {
        failed.push(cleanupError);
      }
    }
    for (const dir of parents.reverse()) {
      try {
        rmdirSync(dir);
      } catch (cleanupError) {
        if (!["ENOENT", "ENOTEMPTY"].includes((cleanupError as NodeJS.ErrnoException).code ?? "")) {
          failed.push(cleanupError);
        }
      }
    }
    if (failed.length) {
      throw new AggregateError(
        [error, ...failed],
        "Extension publication cleanup was incomplete.",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}
