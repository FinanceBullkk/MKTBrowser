import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionConfig } from "@mktbrowser/types";
import { extractArchiveSafely, type SafeArchivePolicy } from "../safe-archive-extraction.ts";
import { unwrapVerifiedCrx } from "./crx-signature-verification.ts";
import { storeEntryDir } from "./extensionStore.ts";

const MAX_UNPACKED_BYTES = 150 * 1024 * 1024; // ~150 MB cap per extension
const EXTENSION_ZIP_POLICY: SafeArchivePolicy = {
  archiveType: "browser-extension",
  maxCompressedBytes: MAX_UNPACKED_BYTES,
  maxUncompressedBytes: MAX_UNPACKED_BYTES,
  maxEntries: 10_000,
  maxFileBytes: MAX_UNPACKED_BYTES,
  maxCompressionRatio: 250,
  maxPathLength: 512,
};

export interface UnpackToStoreInput {
  /** Absolute path to a .crx file, .zip file, or an unpacked extension folder. */
  source: string;
  /** Root of the shared store, e.g. `<userData>/data/extension-store`. */
  storeRoot: string;
  /** How the extension was obtained (for the stored ExtensionConfig). */
  origin: ExtensionConfig["source"];
  /** Required for Web Store downloads; prevents substitution with another signed extension. */
  expectedId?: string;
}

/**
 * Validate + unpack an extension into the SHARED store at
 * `<storeRoot>/<id>/<version>/`, deduped by id+version, and return a shared
 * ExtensionConfig reference. The bytes are stored once and loaded into any
 * number of profiles via --load-extension.
 *
 * Identity:
 *  - A CRX2/CRX3 publisher signature must verify before its key becomes the
 *    genuine store ID. Web Store installs must also match the requested ID.
 *  - Keyless folder/zip → a stable content-hash ID (shareable + dedupable).
 *  - If a manifest already carries a `key`, that ID is used as-is.
 * Invalid CRX signatures and conflicting manifest keys fail closed.
 *
 * Atomic + concurrent-safe: everything happens in a temp staging dir and is
 * renamed into the final entry only once validated. If the target entry already
 * exists (another profile installed the same id+version, possibly concurrently)
 * the stage is discarded and the existing entry reused.
 */
export async function unpackToStore(input: UnpackToStoreInput): Promise<ExtensionConfig> {
  const { source, storeRoot, origin, expectedId } = input;
  if (!existsSync(source)) throw new Error(`Extension source not found: ${source}`);
  if (origin === "web-store" && !/^[a-p]{32}$/.test(expectedId ?? "")) {
    throw new Error("A valid expected Web Store extension ID is required.");
  }

  await mkdir(storeRoot, { recursive: true });
  const staging = join(storeRoot, `.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: true });

  try {
    let publicKey: Buffer | undefined;
    let root: string;
    const info = await stat(source);
    if (info.isDirectory()) {
      await cp(source, staging, { recursive: true });
      root = await resolveManifestRoot(staging);
    } else {
      const unwrapped = await unwrapVerifiedCrx(source, staging);
      if (origin === "web-store" && !unwrapped.isCrx) {
        throw new Error("Web Store download was not a signed CRX package.");
      }
      publicKey = unwrapped.publicKey;
      const extractedRoot = join(staging, "payload");
      await extractArchiveSafely({
        archivePath: unwrapped.zipPath,
        destinationPath: extractedRoot,
        policy: EXTENSION_ZIP_POLICY,
      });
      if (unwrapped.zipPath !== source) await rm(unwrapped.zipPath, { force: true });
      root = await resolveManifestRoot(extractedRoot);
    }

    const manifestPath = join(root, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error("No manifest.json found in the extension.");
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      manifest_version?: number;
      name?: string;
      version?: string;
      default_locale?: string;
      key?: string;
    };
    if (manifest.manifest_version !== 3) {
      throw new Error(
        `Manifest V${manifest.manifest_version ?? "?"} isn't supported by modern Chromium — only V3 extensions can be loaded.`,
      );
    }

    const size = await dirSize(root);
    if (size > MAX_UNPACKED_BYTES) {
      throw new Error(
        `Extension is too large (${Math.round(size / 1024 / 1024)} MB > 150 MB limit).`,
      );
    }

    // Determine the extension identity, preferring a verified CRX publisher key.
    let id: string;
    if (publicKey) {
      // The verified publisher key is authoritative and becomes Chromium's ID.
      const keyB64 = publicKey.toString("base64");
      id = computeExtensionId({ key: keyB64 });
      if (manifest.key && computeExtensionId({ key: manifest.key }) !== id) {
        throw new Error("CRX publisher key does not match the manifest key.");
      }
      manifest.key = keyB64;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    } else if (manifest.key) {
      // A local unpacked extension may carry its own Chromium identity key.
      id = computeExtensionId({ key: manifest.key });
    } else {
      // Keyless local folder/ZIP → stable content-hash ID.
      id = await contentHashId(root);
    }
    if (expectedId && id !== expectedId) {
      throw new Error(`Signed CRX ID ${id} does not match requested Web Store ID ${expectedId}.`);
    }
    const version = manifest.version ?? "";
    const name = await resolveName(manifest, root);

    const finalDir = storeEntryDir(storeRoot, id, version);
    if (existsSync(finalDir)) {
      // Already in the store (same id+version) — reuse, discard our stage. This
      // is the dedup + concurrent-install convergence point.
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    } else {
      await mkdir(join(finalDir, ".."), { recursive: true });
      try {
        await rename(root, finalDir);
      } catch (e) {
        // A concurrent installer may have published the same entry between our
        // existsSync check and rename — treat an existing target as success.
        if (existsSync(finalDir)) {
          await rm(staging, { recursive: true, force: true }).catch(() => {});
        } else {
          throw e;
        }
      }
      if (root !== staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    }

    return {
      id,
      name,
      version,
      enabled: true,
      scope: "shared",
      dir: "",
      source: origin,
    };
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Compute the Chromium extension ID. With a manifest `key`, it's the SHA-256 of
 * the DER public key; otherwise it's the SHA-256 of the absolute install path
 * (how Chromium derives the ID for unpacked extensions). First 16 bytes, hex,
 * mapped 0–f → a–p.
 */
export function computeExtensionId(opts: { key?: string; absPath?: string }): string {
  let digestInput: Buffer;
  if (opts.key) {
    digestInput = Buffer.from(opts.key, "base64");
    try {
      createPublicKey({ key: digestInput, format: "der", type: "spki" });
    } catch {
      throw new Error("Invalid extension public key in manifest.");
    }
  } else {
    digestInput = Buffer.from(opts.absPath ?? "", "utf8");
  }
  return hashToId(createHash("sha256").update(digestInput).digest());
}

/** Map a digest to a Chromium-style 32-char a–p extension ID (first 16 bytes). */
function hashToId(hash: Buffer): string {
  let id = "";
  for (let i = 0; i < 16; i++) {
    const byte = hash[i] ?? 0;
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

/**
 * Deterministic ID derived from the unpacked file tree — used for keyless
 * folder/zip installs (no developer key to recover). Identical bytes always
 * yield the same ID, so two profiles uploading the same extension dedup to one
 * shared store entry. Hashes each file's relative path + contents in sorted
 * order so the result is independent of filesystem walk order.
 */
async function contentHashId(dir: string): Promise<string> {
  const files: string[] = [];
  const stack = ["."];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel === "." ? dir : join(dir, rel);
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow symlinks (DoS / escape)
      const childRel = rel === "." ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) stack.push(childRel);
      else if (e.isFile()) files.push(childRel);
    }
  }
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(join(dir, rel)));
  }
  return hashToId(hash.digest());
}

/** If `dir` has no manifest.json but a single subdirectory that does, return it. */
async function resolveManifestRoot(dir: string): Promise<string> {
  if (existsSync(join(dir, "manifest.json"))) return dir;
  const entries = await readdir(dir, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory());
  if (subdirs.length === 1 && subdirs[0]) {
    const inner = join(dir, subdirs[0].name);
    if (existsSync(join(inner, "manifest.json"))) return inner;
  }
  return dir;
}

/** Resolve a display name, dereferencing `__MSG_x__` via the default locale. */
async function resolveName(
  manifest: { name?: string; default_locale?: string },
  extDir: string,
): Promise<string> {
  const raw = manifest.name ?? "";
  const msg = /^__MSG_(.+)__$/.exec(raw);
  if (msg && manifest.default_locale) {
    try {
      const messagesPath = join(extDir, "_locales", manifest.default_locale, "messages.json");
      const messages = JSON.parse(await readFile(messagesPath, "utf8")) as Record<
        string,
        { message?: string }
      >;
      const key = msg[1] ?? "";
      const resolved = messages[key]?.message ?? messages[key.toLowerCase()]?.message ?? undefined;
      if (resolved) return resolved;
    } catch {
      // fall through to a sensible fallback
    }
  }
  return raw && !msg ? raw : "Extension";
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // don't follow symlinks (size DoS / escape)
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        const s = await stat(p).catch(() => null);
        if (s) total += s.size;
      }
    }
  }
  return total;
}

/** Exposed for callers that download a CRX to a temp file first. */
export function tempCrxPath(): string {
  return join(tmpdir(), `mkt-browser-ext-${randomUUID()}.crx`);
}
