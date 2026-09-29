import { createReadStream, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Profile } from "@mktbrowser/types";
import { ARCHIVE_LIMITS } from "./archive-limits.js";
import { publishImportedProfile, type StagedExtension } from "./archive-publication.js";
import {
  EXTENSION_ARCHIVE_STAGING_PREFIX,
  PROFILE_ARCHIVE_STAGING_PREFIX,
} from "./archive-staging.js";
import {
  ArchiveAuthenticationError,
  ARCHIVE_MAGIC,
  ARCHIVE_VERSION,
  openArchivePlaintext,
  writeEncryptedArchive,
  type ArchiveSourceFile,
} from "./archive-streaming.js";
import {
  archiveFilePath,
  isSafeSegment,
  validateManifest,
  type ArchiveManifest,
  type BundledExtension,
  type FileMeta,
} from "./archive-validation.js";

export interface ExportOptions {
  /** Shared-store extension directories to include; imports restore them disabled. */
  extensions?: Array<{ id: string; version: string; dir: string }>;
}

/** Pack a profile into MZAR v2 without buffering profile files or ciphertext. */
export async function exportProfile(
  profile: Profile,
  passphrase: string,
  outPath: string,
  opts: ExportOptions = {},
): Promise<void> {
  const profileFiles = await collectFiles(profile.dataDir);
  const bundled: BundledExtension[] = [];
  const extensionFiles: ArchiveSourceFile[] = [];

  for (const ext of opts.extensions ?? []) {
    const files = await collectFiles(ext.dir);
    if (files.length === 0) continue;
    bundled.push({ id: ext.id, version: ext.version, files: files.map(fileMeta) });
    extensionFiles.push(...files);
  }

  const manifest: ArchiveManifest = {
    magic: ARCHIVE_MAGIC,
    version: ARCHIVE_VERSION,
    profile,
    files: profileFiles.map(fileMeta),
    extensions: bundled.length > 0 ? bundled : undefined,
  };
  validateManifest(manifest, ARCHIVE_VERSION);
  const manifestJson = Buffer.from(JSON.stringify(manifest), "utf8");

  await writeEncryptedArchive({
    outPath,
    passphrase,
    version: ARCHIVE_VERSION,
    manifestJson,
    files: [...profileFiles, ...extensionFiles],
  });
}

export interface ImportOptions {
  /** Return true when a profile id is already committed in the local database. */
  idTaken?: (id: string) => boolean;
  /** Shared extension store root used for authenticated v2 extension publication. */
  extensionStoreRoot?: string;
  /** Commit the restored row synchronously. If insertion fails, extraction is rolled back. */
  persist?: (profile: Profile) => Profile;
}

// Imports share the extension store. Serialize publication and rollback so another
// import cannot adopt an entry that a failing transaction is about to remove.
let importQueue: Promise<unknown> = Promise.resolve();

export function importProfile(
  archivePath: string,
  passphrase: string,
  destProfilesRoot: string,
  opts: ImportOptions = {},
): Promise<Profile> {
  const run = importQueue.then(() =>
    restoreProfile(archivePath, passphrase, destProfilesRoot, opts),
  );
  importQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function restoreProfile(
  archivePath: string,
  passphrase: string,
  destProfilesRoot: string,
  opts: ImportOptions,
): Promise<Profile> {
  const { version, reader } = await openArchivePlaintext(archivePath, passphrase);
  let manifest: ArchiveManifest | undefined;
  let profileStagingRoot: string | undefined;
  let extensionStagingRoot: string | undefined;
  const stagedExtensions: StagedExtension[] = [];
  let failure: unknown;

  try {
    const manifestLength = await reader.readUInt32("Invalid archive manifest.");
    if (manifestLength > ARCHIVE_LIMITS.maxManifestBytes) {
      throw new Error("Archive manifest exceeds the allowed size.");
    }
    const manifestBytes = await reader.readBuffer(manifestLength, "Invalid archive manifest.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      throw new Error("Invalid archive manifest.");
    }
    validateManifest(parsed, version);
    manifest = parsed;

    const profileStagingParent = dirname(destProfilesRoot);
    await mkdir(profileStagingParent, { recursive: true });
    profileStagingRoot = await mkdtemp(join(profileStagingParent, PROFILE_ARCHIVE_STAGING_PREFIX));

    if (opts.extensionStoreRoot) {
      const extensionStagingParent = dirname(opts.extensionStoreRoot);
      await mkdir(extensionStagingParent, { recursive: true });
      extensionStagingRoot = await mkdtemp(
        join(extensionStagingParent, EXTENSION_ARCHIVE_STAGING_PREFIX),
      );
    }

    for (const meta of manifest.files) {
      await reader.consumeFrame(meta, guardedStagingPath(profileStagingRoot, meta.path));
    }
    for (const [index, ext] of (manifest.extensions ?? []).entries()) {
      let stagingDir: string | undefined;
      if (extensionStagingRoot && opts.extensionStoreRoot) {
        stagingDir = join(extensionStagingRoot, String(index));
        await mkdir(stagingDir);
      }
      for (const meta of ext.files) {
        await reader.consumeFrame(
          meta,
          stagingDir ? guardedStagingPath(stagingDir, meta.path) : undefined,
        );
      }
      if (stagingDir && opts.extensionStoreRoot) {
        stagedExtensions.push({
          source: stagingDir,
          destination: join(opts.extensionStoreRoot, ext.id, ext.version || "0"),
        });
      }
    }
    await reader.ensureNoTrailingData();
  } catch (error) {
    failure = error;
    if (!(error instanceof ArchiveAuthenticationError)) {
      try {
        await reader.drain();
      } catch (authenticationError) {
        failure = authenticationError;
      }
    }
  }

  if (failure || !manifest || !profileStagingRoot) {
    const error =
      failure instanceof ArchiveAuthenticationError
        ? new Error("Wrong passphrase or corrupted archive.")
        : (failure ?? new Error("Invalid archive manifest."));
    return cleanupAndThrow(error, [profileStagingRoot, extensionStagingRoot]);
  }

  let finalDataDir: string | undefined;
  try {
    const published = await publishStagedProfileDirectory(
      profileStagingRoot,
      manifest.profile.id,
      destProfilesRoot,
      opts.idTaken,
    );
    profileStagingRoot = undefined;
    finalDataDir = published.dataDir;

    const importedExtensions = manifest.profile.extensions?.map((extension) => ({
      ...extension,
      enabled: false,
    }));
    const restored: Profile = {
      ...manifest.profile,
      ...(importedExtensions ? { extensions: importedExtensions } : {}),
      id: published.id,
      dataDir: published.dataDir,
    };

    if (opts.extensionStoreRoot) await mkdir(opts.extensionStoreRoot, { recursive: true });
    return publishImportedProfile(
      restored,
      stagedExtensions,
      extensionStagingRoot,
      opts.persist,
    );
  } catch (error) {
    return cleanupAndThrow(error, [profileStagingRoot, extensionStagingRoot, finalDataDir]);
  }
}

async function publishStagedProfileDirectory(
  stagingRoot: string,
  originalId: string,
  destProfilesRoot: string,
  idTaken?: (id: string) => boolean,
): Promise<{ id: string; dataDir: string }> {
  await mkdir(destProfilesRoot, { recursive: true });
  const existingIds = new Set((await readdir(destProfilesRoot)).map((id) => id.toLowerCase()));
  let targetId = originalId;

  while (true) {
    if (!isSafeSegment(targetId) || existingIds.has(targetId.toLowerCase()) || idTaken?.(targetId)) {
      targetId = randomUUID();
      continue;
    }
    const dataDir = join(destProfilesRoot, targetId);
    try {
      await rename(stagingRoot, dataDir);
      return { id: targetId, dataDir };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (existsSync(dataDir) || code === "EEXIST" || code === "ENOTEMPTY") {
        existingIds.add(targetId.toLowerCase());
        targetId = randomUUID();
        continue;
      }
      throw error;
    }
  }
}

function guardedStagingPath(baseDir: string, relPath: string): string {
  const base = resolve(baseDir);
  const absPath = resolve(base, archiveFilePath(relPath));
  if (absPath === base || !absPath.startsWith(base + sep)) {
    throw new Error(`Refusing path-traversal entry: ${relPath}`);
  }
  return absPath;
}

async function cleanupAndThrow(error: unknown, paths: Array<string | undefined>): Promise<never> {
  const cleanupErrors: unknown[] = [];
  for (const path of paths.filter((value): value is string => Boolean(value)).reverse()) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [error, ...cleanupErrors],
      "Profile import failed and cleanup was incomplete.",
      { cause: error },
    );
  }
  throw error;
}

function fileMeta(file: ArchiveSourceFile): FileMeta {
  return { path: file.path, size: file.size, sha256: file.sha256 };
}

async function collectFiles(root: string): Promise<ArchiveSourceFile[]> {
  const files: ArchiveSourceFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
      } else if (entry.isFile()) {
        const fileStat = await stat(absPath);
        files.push({
          absPath,
          path: relative(root, absPath),
          size: fileStat.size,
          sha256: await fileSha256(absPath),
        });
      }
    }
  }
  try {
    await walk(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return files;
}

function fileSha256(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
    stream.on("error", reject);
  });
}
