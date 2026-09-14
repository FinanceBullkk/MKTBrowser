import { existsSync, mkdirSync, realpathSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface PermanentProfileDeletionInput {
  profileId: string;
  dataDir: string;
  profilesRoot: string;
  pending: boolean;
  markPending: () => void;
  clearPending: () => void;
  deleteRecord: () => void;
}

export class UnsafeProfileDeletionPathError extends Error {
  constructor() {
    super(
      "Profile deletion refused because its data directory is outside the MKT Browser profile root.",
    );
    this.name = "UnsafeProfileDeletionPathError";
  }
}

export class ProfileDeletionIncompleteError extends Error {
  constructor(cause: unknown) {
    super(
      "Profile deletion did not complete. Retry from MKT Browser; no other profile was targeted.",
      {
        cause,
      },
    );
    this.name = "ProfileDeletionIncompleteError";
  }
}

/**
 * Moves one owned profile into a same-volume quarantine before removing it. A pending database row
 * makes every crash point retryable: source present, quarantine present, or files already gone.
 */
export function permanentlyDeleteOwnedProfile(input: PermanentProfileDeletionInput): void {
  const paths = resolveOwnedDeletionPaths(input);
  if (!input.pending) {
    if (!existsSync(paths.source) || existsSync(paths.quarantine)) {
      throw new ProfileDeletionIncompleteError(
        new Error("The profile directory is missing or ambiguous."),
      );
    }
    assertRealDirectoryInside(paths.source, paths.root);
    input.markPending();
  }

  try {
    const sourceExists = existsSync(paths.source);
    const quarantineExists = existsSync(paths.quarantine);
    if (sourceExists && quarantineExists) {
      throw new Error("Both the live and quarantined profile directories exist.");
    }

    if (sourceExists) {
      assertRealDirectoryInside(paths.source, paths.root);
      mkdirSync(paths.quarantineRoot, { recursive: true });
      assertRealDirectoryInside(paths.quarantineRoot, paths.root);
      renameSync(paths.source, paths.quarantine);
    }

    if (existsSync(paths.quarantine)) {
      assertRealDirectoryInside(paths.quarantine, paths.quarantineRoot);
      rmSync(paths.quarantine, { recursive: true, force: false });
    }

    if (existsSync(paths.source) || existsSync(paths.quarantine)) {
      throw new Error("The selected profile directory still exists after cleanup.");
    }
    // The quarantine root sits inside profilesRoot, so leaving an empty `.deleting` behind makes
    // every directory listing of that folder report one profile more than the product has. Best
    // effort only: a concurrent deletion may legitimately be holding it, and that must not fail a
    // deletion that has already completed.
    try {
      rmdirSync(paths.quarantineRoot);
    } catch {
      // Not empty or already gone; either way the deletion itself is done.
    }
    input.deleteRecord();
  } catch (cause) {
    // A failed atomic rename leaves the live directory untouched, so restore its active state.
    if (existsSync(paths.source) && !existsSync(paths.quarantine)) {
      try {
        input.clearPending();
      } catch (clearCause) {
        throw new ProfileDeletionIncompleteError(new AggregateError([cause, clearCause]));
      }
    }
    throw new ProfileDeletionIncompleteError(cause);
  }
}

function resolveOwnedDeletionPaths(input: PermanentProfileDeletionInput): {
  root: string;
  source: string;
  quarantineRoot: string;
  quarantine: string;
} {
  const root = resolve(input.profilesRoot);
  const source = resolve(input.dataDir);
  const expectedSource = resolve(root, input.profileId);
  if (!samePath(source, expectedSource) || basename(source) !== input.profileId) {
    throw new UnsafeProfileDeletionPathError();
  }
  const quarantineRoot = join(root, ".deleting");
  return { root, source, quarantineRoot, quarantine: join(quarantineRoot, input.profileId) };
}

function assertRealDirectoryInside(candidate: string, expectedParent: string): void {
  const realCandidate = realpathSync(candidate);
  const realParent = realpathSync(expectedParent);
  if (!samePath(dirname(realCandidate), realParent)) throw new UnsafeProfileDeletionPathError();
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(resolve(left)) === normalize(resolve(right));
}
