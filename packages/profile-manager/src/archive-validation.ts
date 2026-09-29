import type { Profile } from "@mktbrowser/types";
import { ARCHIVE_LIMITS } from "./archive-limits.js";

export interface FileMeta {
  path: string;
  size: number;
  sha256: string;
}
export interface BundledExtension {
  id: string;
  version: string;
  files: FileMeta[];
}
export interface ArchiveManifest {
  magic: "MZAR";
  version: number;
  profile: Profile;
  files: FileMeta[];
  extensions?: BundledExtension[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function size(value: unknown): boolean {
  return object(value) && positive(value.width) && positive(value.height);
}
function invalid(): never {
  throw new Error("Invalid archive manifest.");
}

export function isSafeSegment(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) &&
    !value.endsWith(".") &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  );
}

/** Accept both separators used by older exports, but reject Windows path aliases on every host. */
export function archiveFilePath(value: string): string {
  const parts = value.replaceAll("\\", "/").split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[<>:"|?*]/.test(part) ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new Error(`Refusing unsafe archive path: ${value}`);
  }
  return parts.join("/");
}

interface FileBudget {
  count: number;
  bytes: number;
}

function validateFiles(value: unknown): FileBudget {
  if (!Array.isArray(value)) invalid();
  if (value.length > ARCHIVE_LIMITS.maxFileCount) invalid();
  const files = new Set<string>();
  const directories = new Set<string>();
  let bytes = 0;
  for (const entry of value) {
    if (
      !object(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > ARCHIVE_LIMITS.maxFrameBytes ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    )
      invalid();
    bytes += entry.size;
    if (bytes > ARCHIVE_LIMITS.maxTotalContentBytes) invalid();
    const key = archiveFilePath(entry.path).toLowerCase();
    if (files.has(key) || directories.has(key)) invalid();
    const parts = key.split("/");
    parts.pop();
    while (parts.length) {
      const parent = parts.join("/");
      if (files.has(parent)) invalid();
      directories.add(parent);
      parts.pop();
    }
    files.add(key);
  }
  return { count: value.length, bytes };
}

function validateProfile(value: unknown): void {
  if (!object(value) || !strings(value.tags)) invalid();
  for (const key of ["id", "name", "dataDir", "createdAt", "updatedAt"]) {
    if (typeof value[key] !== "string") invalid();
  }
  for (const key of [
    "notes",
    "icon",
    "startUrl",
    "searchProvider",
    "lastOpenedAt",
    "proxyCountry",
  ]) {
    if (value[key] !== undefined && typeof value[key] !== "string") invalid();
  }
  for (const key of ["managed", "deletionPending"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") invalid();
  }
  const fp = value.fingerprint;
  if (
    !object(fp) ||
    !strings(fp.languages) ||
    !size(fp.screen) ||
    (fp.availScreen !== undefined && !size(fp.availScreen)) ||
    !positive(fp.dpr) ||
    !positive(fp.hardwareConcurrency) ||
    !positive(fp.deviceMemory) ||
    (fp.clientHints !== undefined && !object(fp.clientHints)) ||
    !object(fp.webgl)
  )
    invalid();
  for (const key of [
    "device",
    "userAgent",
    "platform",
    "locale",
    "acceptLanguage",
    "timezone",
    "country",
  ]) {
    if (typeof fp[key] !== "string") invalid();
  }
  for (const key of [
    "secChUa",
    "secChUaPlatform",
    "secChUaPlatformVersion",
    "secChUaArch",
    "secChUaBitness",
    "secChUaMobile",
    "secChUaModel",
    "secChUaFullVersionList",
  ]) {
    if (fp.clientHints !== undefined && typeof fp.clientHints[key] !== "string") invalid();
  }
  if (
    typeof fp.webgl.vendor !== "string" ||
    typeof fp.webgl.renderer !== "string" ||
    (fp.seed !== undefined && typeof fp.seed !== "string")
  )
    invalid();
  if (value.proxy !== undefined) {
    const proxy = value.proxy;
    if (
      !object(proxy) ||
      !["http", "socks5"].includes(String(proxy.type)) ||
      typeof proxy.host !== "string" ||
      typeof proxy.port !== "number" ||
      !Number.isInteger(proxy.port) ||
      proxy.port < 1 ||
      proxy.port > 65535 ||
      (proxy.username !== undefined && typeof proxy.username !== "string") ||
      (proxy.password !== undefined && typeof proxy.password !== "string")
    )
      invalid();
  }
  if (value.extensions !== undefined) {
    if (!Array.isArray(value.extensions)) invalid();
    for (const ext of value.extensions) {
      if (!object(ext)) invalid();
      // Pre-dedup archives have profile-local extensions without these additive fields.
      if (ext.scope === undefined) ext.scope = "profile";
      if (ext.version === undefined) ext.version = "";
      if (
        typeof ext.id !== "string" ||
        !isSafeSegment(ext.id) ||
        typeof ext.version !== "string" ||
        !isSafeSegment(ext.version || "0") ||
        typeof ext.name !== "string" ||
        typeof ext.enabled !== "boolean" ||
        !["shared", "profile"].includes(String(ext.scope)) ||
        typeof ext.dir !== "string" ||
        !["web-store", "file", "folder"].includes(String(ext.source))
      )
        invalid();
      if (ext.scope === "profile") archiveFilePath(ext.dir);
    }
  }
}

export function validateManifest(
  value: unknown,
  version: number,
): asserts value is ArchiveManifest {
  if (!object(value) || value.magic !== "MZAR" || value.version !== version) invalid();
  validateProfile(value.profile);
  const profileBudget = validateFiles(value.files);
  let fileCount = profileBudget.count;
  let contentBytes = profileBudget.bytes;
  if (value.extensions === undefined) return;
  if (!Array.isArray(value.extensions)) invalid();
  if (value.extensions.length > ARCHIVE_LIMITS.maxExtensionBundles) invalid();
  const destinations = new Set<string>();
  for (const ext of value.extensions) {
    if (
      !object(ext) ||
      typeof ext.id !== "string" ||
      !isSafeSegment(ext.id) ||
      typeof ext.version !== "string" ||
      !isSafeSegment(ext.version || "0")
    )
      invalid();
    const key = `${ext.id}/${ext.version || "0"}`.toLowerCase();
    if (destinations.has(key)) invalid();
    destinations.add(key);
    const budget = validateFiles(ext.files);
    fileCount += budget.count;
    contentBytes += budget.bytes;
    if (
      fileCount > ARCHIVE_LIMITS.maxFileCount ||
      contentBytes > ARCHIVE_LIMITS.maxTotalContentBytes
    )
      invalid();
  }
}
