import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createZip, type ZipEntry } from "./extensions/crx-test-fixtures.ts";
import {
  SafeArchiveExtractionError,
  extractArchiveSafely,
  type SafeArchivePolicy,
} from "./safe-archive-extraction.ts";

const policy: SafeArchivePolicy = {
  archiveType: "test",
  maxCompressedBytes: 256 * 1024,
  maxUncompressedBytes: 512 * 1024,
  maxEntries: 20,
  maxFileBytes: 256 * 1024,
  maxCompressionRatio: 50,
  maxPathLength: 200,
};

async function fixture(entries: ZipEntry[]): Promise<{
  root: string;
  archive: string;
  destination: string;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "mktbrowser-safe-archive-"));
  const archive = join(root, "fixture.zip");
  await writeFile(archive, createZip(entries));
  return {
    root,
    archive,
    destination: join(root, "extracted"),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

async function rejectsWithCode(
  entries: ZipEntry[],
  code: SafeArchiveExtractionError["code"],
  override: Partial<SafeArchivePolicy> = {},
): Promise<void> {
  const f = await fixture(entries);
  try {
    await assert.rejects(
      extractArchiveSafely({
        archivePath: f.archive,
        destinationPath: f.destination,
        policy: { ...policy, ...override },
      }),
      (error) => error instanceof SafeArchiveExtractionError && error.code === code,
    );
    assert.equal(existsSync(f.destination), false);
  } finally {
    await f.dispose();
  }
}

test("extracts a valid ZIP only after the full archive passes preflight", async () => {
  const f = await fixture([
    { name: "browser/", content: "", mode: 0o040755 },
    { name: "browser/chrome.exe", content: "binary", mode: 0o100755 },
    { name: "browser/resources/config.json", content: "{}" },
  ]);
  try {
    await extractArchiveSafely({
      archivePath: f.archive,
      destinationPath: f.destination,
      policy,
    });
    assert.equal(await readFile(join(f.destination, "browser", "chrome.exe"), "utf8"), "binary");
  } finally {
    await f.dispose();
  }
});

test("rejects traversal, absolute, drive-qualified, mixed-separator, and NUL paths", async () => {
  for (const name of [
    "../escaped.txt",
    "/absolute.txt",
    "C:/drive.txt",
    "nested\\..\\escaped.txt",
    "nul\0name.txt",
  ]) {
    await rejectsWithCode([{ name, content: "blocked" }], "ARCHIVE_INVALID_PATH");
  }
});

test("rejects case-folded duplicates and file-directory collisions", async () => {
  await rejectsWithCode(
    [
      { name: "Folder/item.txt", content: "one" },
      { name: "folder/ITEM.txt", content: "two" },
    ],
    "ARCHIVE_DUPLICATE_ENTRY",
  );
  await rejectsWithCode(
    [
      { name: "parent/child.txt", content: "child" },
      { name: "parent", content: "file" },
    ],
    "ARCHIVE_DUPLICATE_ENTRY",
  );
  await rejectsWithCode(
    [
      { name: "Folder/item.txt", content: "child" },
      { name: "folder/", content: "", mode: 0o040755 },
    ],
    "ARCHIVE_DUPLICATE_ENTRY",
  );
  await rejectsWithCode(
    [
      { name: "folder/", content: "", mode: 0o040755 },
      { name: "FOLDER/item.txt", content: "child" },
    ],
    "ARCHIVE_DUPLICATE_ENTRY",
  );
});

test("rejects Windows device names, including console aliases and superscript ports", async () => {
  for (const name of ["CON.txt", "CONIN$", "CONOUT$", "COM\u00b9.txt", "LPT\u00b2"]) {
    await rejectsWithCode([{ name, content: "blocked" }], "ARCHIVE_INVALID_PATH");
  }
});

test("rejects symlink entries before writing", async () => {
  await rejectsWithCode(
    [{ name: "browser/link", content: "../../outside", mode: 0o120777 }],
    "ARCHIVE_LINK_NOT_ALLOWED",
  );
});

test("rejects archive bombs by metadata before extraction", async () => {
  await rejectsWithCode(
    [{ name: "huge.txt", content: Buffer.alloc(128 * 1024), compress: true }],
    "ARCHIVE_LIMIT_EXCEEDED",
    { maxCompressionRatio: 10 },
  );
  await rejectsWithCode(
    [
      { name: "one.txt", content: "1" },
      { name: "two.txt", content: "2" },
    ],
    "ARCHIVE_LIMIT_EXCEEDED",
    { maxEntries: 1 },
  );
});

test("rejects truncated archives without leaving staging", async () => {
  const f = await fixture([{ name: "file.txt", content: "content" }]);
  try {
    const bytes = await readFile(f.archive);
    await writeFile(f.archive, bytes.subarray(0, bytes.length - 8));
    await assert.rejects(
      extractArchiveSafely({
        archivePath: f.archive,
        destinationPath: f.destination,
        policy,
      }),
      (error) =>
        error instanceof SafeArchiveExtractionError && error.code === "ARCHIVE_CORRUPT",
    );
    assert.equal(existsSync(f.destination), false);
  } finally {
    await f.dispose();
  }
});

test("verifies CRC and removes output written before a later corrupt entry", async () => {
  const f = await fixture([
    { name: "first.txt", content: "valid-first" },
    { name: "second.txt", content: "tamper-target" },
  ]);
  try {
    const bytes = await readFile(f.archive);
    const target = Buffer.from("tamper-target");
    const offset = bytes.indexOf(target);
    assert.notEqual(offset, -1);
    bytes[offset] = (bytes[offset] ?? 0) ^ 0xff;
    await writeFile(f.archive, bytes);

    await assert.rejects(
      extractArchiveSafely({
        archivePath: f.archive,
        destinationPath: f.destination,
        policy,
      }),
      (error) =>
        error instanceof SafeArchiveExtractionError && error.code === "ARCHIVE_INTEGRITY_FAILED",
    );
    assert.equal(existsSync(f.destination), false);
  } finally {
    await f.dispose();
  }
});
