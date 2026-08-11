import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, win32 } from "node:path";

/** A legacy profile store that can be copied into a fresh MKT Browser root. */
export interface LegacyMultiZenImportCandidate {
  status: "ready";
  legacyDataRoot: string;
  profileCount: number;
}

export interface LegacyMultiZenImportUnreadable {
  status: "unreadable";
  legacyDataRoot: string;
}

export type LegacyMultiZenImportDiscovery =
  | LegacyMultiZenImportCandidate
  | LegacyMultiZenImportUnreadable;

export interface LegacyMultiZenImportResult {
  profileCount: number;
}

export function findLegacyMultiZenImport(
  appDataRoot: string,
  currentDataRoot: string,
): LegacyMultiZenImportDiscovery | null {
  if (existsSync(join(currentDataRoot, "profiles.db"))) return null;

  const legacyDataRoot = win32.join(appDataRoot, "MultiZen", "data");
  const legacyDbPath = win32.join(legacyDataRoot, "profiles.db");
  if (!existsSync(legacyDbPath)) return null;

  try {
    const db = new Database(legacyDbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM profiles").get() as { count: number };
      return { status: "ready", legacyDataRoot, profileCount: row.count };
    } finally {
      db.close();
    }
  } catch {
    return { status: "unreadable", legacyDataRoot };
  }
}

export async function copyLegacyMultiZenData(
  legacyDataRoot: string,
  currentDataRoot: string,
): Promise<LegacyMultiZenImportResult> {
  if (existsSync(currentDataRoot)) {
    throw new Error("MKT Browser data already exists; legacy import will not overwrite it.");
  }

  const sourceDbPath = win32.join(legacyDataRoot, "profiles.db");
  const stagingRoot = `${currentDataRoot}.importing-${randomUUID()}`;
  const stagingDbPath = join(stagingRoot, "profiles.db");
  const sourceProfilesRoot = win32.join(legacyDataRoot, "profiles");
  const targetProfilesRoot = win32.join(currentDataRoot, "profiles");

  await mkdir(stagingRoot, { recursive: true });
  try {
    await copyDirectoryIfPresent(sourceProfilesRoot, join(stagingRoot, "profiles"));
    await copyDirectoryIfPresent(
      win32.join(legacyDataRoot, "extension-store"),
      join(stagingRoot, "extension-store"),
    );

    const sourceDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
    try {
      await sourceDb.backup(stagingDbPath);
    } finally {
      sourceDb.close();
    }

    const profileCount = rewriteCopiedProfilePaths(
      stagingDbPath,
      sourceProfilesRoot,
      targetProfilesRoot,
    );
    await mkdir(dirname(currentDataRoot), { recursive: true });
    await rename(stagingRoot, currentDataRoot);
    return { profileCount };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function copyDirectoryIfPresent(source: string, destination: string): Promise<void> {
  if (!existsSync(source)) return;
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}

function rewriteCopiedProfilePaths(
  dbPath: string,
  sourceProfilesRoot: string,
  targetProfilesRoot: string,
): number {
  const db = new Database(dbPath);
  try {
    const rows = db.prepare("SELECT id, data_dir FROM profiles").all() as Array<{
      id: string;
      data_dir: string;
    }>;
    const update = db.prepare("UPDATE profiles SET data_dir = ? WHERE id = ?");
    const rewrite = db.transaction(() => {
      for (const row of rows) {
        const relative = win32.relative(sourceProfilesRoot, row.data_dir);
        if (!relative || relative === "." || relative.startsWith("..") || win32.isAbsolute(relative)) {
          throw new Error("A legacy profile points outside the MultiZen profile directory.");
        }
        if (!existsSync(row.data_dir) || !statSync(row.data_dir).isDirectory()) {
          throw new Error("A legacy profile directory is missing.");
        }
        update.run(win32.join(targetProfilesRoot, relative), row.id);
      }
    });
    rewrite();
    return rows.length;
  } finally {
    db.close();
  }
}
