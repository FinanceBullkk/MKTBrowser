import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createCipheriv, createHash, scryptSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Profile } from "@mktbrowser/types";
import { exportProfile, importProfile } from "./archive.js";
import { ARCHIVE_LIMITS } from "./archive-limits.js";
import {
  EXTENSION_ARCHIVE_STAGING_PREFIX,
  PROFILE_ARCHIVE_STAGING_PREFIX,
  reclaimStaleArchiveStaging,
} from "./archive-staging.js";
import { defaultFingerprint } from "./fingerprint.js";

function profile(root: string): Profile {
  return {
    id: "original-id",
    name: "Archive fixture",
    tags: ["test"],
    dataDir: join(root, "source"),
    fingerprint: defaultFingerprint("archive-test"),
    createdAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
    managed: false,
    deletionPending: false,
  };
}

async function fixture(fn: (root: string, value: Profile) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mkt-archive-regression-"));
  try {
    await fn(root, profile(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const bytes = Buffer.from("retained cookies");
function file(path = "Default/Cookies") {
  return { path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function crafted(
  root: string,
  manifest: unknown,
  payloads = [bytes],
  trailing = Buffer.alloc(0),
  version = 2,
) {
  const json = Buffer.from(JSON.stringify(manifest));
  const manifestLength = Buffer.alloc(4);
  manifestLength.writeUInt32BE(json.length);
  const chunks = payloads.flatMap((content) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(content.length);
    return [length, content];
  });
  const salt = Buffer.alloc(16, 1);
  const iv = Buffer.alloc(12, 2);
  const cipher = createCipheriv("aes-256-gcm", scryptSync("test", salt, 32), iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([manifestLength, json, ...chunks, trailing])),
    cipher.final(),
  ]);
  const header = Buffer.from([77, 90, 65, 82, 0, version]);
  const archive = join(root, "fixture.mzar");
  await writeFile(archive, Buffer.concat([header, salt, iv, encrypted, cipher.getAuthTag()]));
  return archive;
}

test("roundtrips into an absent root and preserves metadata and cookies", async () => {
  await fixture(async (root, value) => {
    await mkdir(join(value.dataDir, "Default"), { recursive: true });
    await writeFile(join(value.dataDir, "Default", "Cookies"), bytes);
    const archive = join(root, "fixture.mzar");
    await exportProfile(value, "test", archive);
    const restored = await importProfile(archive, "test", join(root, "fresh", "profiles"));
    assert.equal(restored.id, value.id);
    assert.deepEqual(restored.fingerprint, value.fingerprint);
    assert.deepEqual(await readFile(join(restored.dataDir, "Default", "Cookies")), bytes);
  });
});

test("case-alias and orphan-directory collisions mint a new id without overwriting", async () => {
  await fixture(async (root, value) => {
    const profiles = join(root, "profiles");
    const original = join(profiles, value.id.toUpperCase());
    await mkdir(original, { recursive: true });
    await writeFile(join(original, "sentinel"), "existing");
    const archive = await crafted(root, {
      magic: "MZAR",
      version: 2,
      profile: value,
      files: [file()],
    });
    const restored = await importProfile(archive, "test", profiles);
    assert.notEqual(restored.id.toLowerCase(), value.id.toLowerCase());
    assert.equal(await readFile(join(original, "sentinel"), "utf8"), "existing");
  });
});

test("imports legacy v1 metadata without the later lifecycle fields", async () => {
  await fixture(async (root, value) => {
    const legacy = { ...value } as Partial<Profile>;
    delete legacy.managed;
    delete legacy.deletionPending;
    const fingerprint = legacy.fingerprint as unknown as Record<string, unknown>;
    delete fingerprint.clientHints;
    const legacyExtension = {
      id: "legacy-extension",
      name: "Legacy extension",
      enabled: true,
      dir: "extensions/legacy-extension",
      source: "file",
    };
    const archive = await crafted(
      root,
      {
        magic: "MZAR",
        version: 1,
        profile: { ...legacy, extensions: [legacyExtension] },
        files: [file()],
      },
      [bytes],
      Buffer.alloc(0),
      1,
    );
    const restored = await importProfile(archive, "test", join(root, "profiles"));
    assert.equal(restored.fingerprint.clientHints, undefined);
    assert.equal(restored.extensions?.[0]?.scope, "profile");
    assert.equal(restored.extensions?.[0]?.version, "");
    assert.equal(restored.extensions?.[0]?.enabled, false);
    assert.deepEqual(await readFile(join(restored.dataDir, "Default", "Cookies")), bytes);
  });
});

test("restores archived extension references disabled until the user reviews them", async () => {
  await fixture(async (root, value) => {
    const archive = await crafted(root, {
      magic: "MZAR",
      version: 2,
      profile: {
        ...value,
        extensions: [
          {
            id: "archived-extension",
            version: "1",
            name: "Archived extension",
            enabled: true,
            scope: "shared",
            dir: "",
            source: "file",
          },
        ],
      },
      files: [file()],
    });

    const restored = await importProfile(archive, "test", join(root, "profiles"));

    assert.equal(restored.extensions?.[0]?.enabled, false);
  });
});

test("streams a large multi-file profile through export and import", async () => {
  await fixture(async (root, value) => {
    const expected = new Map<string, Buffer>();
    for (let index = 0; index < 4; index += 1) {
      const content = Buffer.alloc(3 * 1024 * 1024, index + 1);
      const relativePath = join("Default", `large-${index}.bin`);
      expected.set(relativePath, content);
      await mkdir(join(value.dataDir, "Default"), { recursive: true });
      await writeFile(join(value.dataDir, relativePath), content);
    }
    const archive = join(root, "large.mzar");

    await exportProfile(value, "test", archive);
    const restored = await importProfile(archive, "test", join(root, "profiles"));

    for (const [relativePath, content] of expected) {
      assert.deepEqual(await readFile(join(restored.dataDir, relativePath)), content);
    }
  });
});

test("removes all private staging data when GCM authentication fails", async () => {
  await fixture(async (root, value) => {
    await mkdir(join(value.dataDir, "Default"), { recursive: true });
    await writeFile(join(value.dataDir, "Default", "Cookies"), bytes);
    const archive = join(root, "tampered.mzar");
    await exportProfile(value, "test", archive);
    const tampered = await readFile(archive);
    tampered[40] ^= 1;
    await writeFile(archive, tampered);

    await assert.rejects(
      importProfile(archive, "test", join(root, "profiles"), {
        extensionStoreRoot: join(root, "extensions"),
      }),
      /Wrong passphrase or corrupted archive/,
    );
    assert.equal(existsSync(join(root, "profiles")), false);
    assert.equal(existsSync(join(root, "extensions")), false);
    assert.equal((await readdir(root)).some((entry) => entry.startsWith(".mzar-")), false);
  });
});

test("reclaims only stale archive staging directories after an interrupted import", async () => {
  await fixture(async (root) => {
    const profileStaging = join(root, `${PROFILE_ARCHIVE_STAGING_PREFIX}stale`);
    const extensionStaging = join(root, `${EXTENSION_ARCHIVE_STAGING_PREFIX}stale`);
    const retainedDirectory = join(root, "profiles");
    const retainedFile = join(root, `${PROFILE_ARCHIVE_STAGING_PREFIX}note.txt`);
    await mkdir(profileStaging);
    await mkdir(extensionStaging);
    await mkdir(retainedDirectory);
    await writeFile(join(profileStaging, "Cookies"), bytes);
    await writeFile(join(extensionStaging, "extension.js"), bytes);
    await writeFile(retainedFile, bytes);

    assert.equal(await reclaimStaleArchiveStaging(root), 2);
    assert.equal(existsSync(profileStaging), false);
    assert.equal(existsSync(extensionStaging), false);
    assert.equal(existsSync(retainedDirectory), true);
    assert.equal(existsSync(retainedFile), true);
  });
});

test("rejects manifests and file frames above the explicit archive bounds", async () => {
  await fixture(async (root, value) => {
    const oversizedManifest = await crafted(root, {
      magic: "MZAR",
      version: 2,
      profile: { ...value, notes: "x".repeat(ARCHIVE_LIMITS.maxManifestBytes) },
      files: [file()],
    });
    await assert.rejects(
      importProfile(oversizedManifest, "test", join(root, "profiles")),
      /manifest exceeds the allowed size/i,
    );

    const oversizedFrame = await crafted(root, {
      magic: "MZAR",
      version: 2,
      profile: value,
      files: [{ ...file(), size: ARCHIVE_LIMITS.maxFrameBytes + 1 }],
    });
    await assert.rejects(
      importProfile(oversizedFrame, "test", join(root, "profiles")),
      /Invalid archive manifest/,
    );
  });
});

test("checks skipped extension payloads before creating profile files", async () => {
  await fixture(async (root, value) => {
    const archive = await crafted(
      root,
      {
        magic: "MZAR",
        version: 2,
        profile: value,
        files: [file()],
        extensions: [
          { id: "ignored", version: "1", files: [{ ...file(), sha256: "0".repeat(64) }] },
        ],
      },
      [bytes, bytes],
    );
    await assert.rejects(
      importProfile(archive, "test", join(root, "profiles")),
      /Checksum mismatch/,
    );
    assert.deepEqual(await readdir(root), ["fixture.mzar"]);
  });
});

for (const [name, mutate] of [
  [
    "null fingerprint",
    (p: Record<string, unknown>) => {
      p.fingerprint = null;
    },
  ],
  [
    "array fingerprint",
    (p: Record<string, unknown>) => {
      p.fingerprint = [];
    },
  ],
  [
    "incomplete fingerprint",
    (p: Record<string, unknown>) => {
      p.fingerprint = {};
    },
  ],
  [
    "non-string tags",
    (p: Record<string, unknown>) => {
      p.tags = [{}];
    },
  ],
  [
    "invalid extension metadata",
    (p: Record<string, unknown>) => {
      p.extensions = [null];
    },
  ],
] as const) {
  test(`rejects ${name} before creating a destination`, async () => {
    await fixture(async (root, value) => {
      const invalid = { ...value } as unknown as Record<string, unknown>;
      mutate(invalid);
      const archive = await crafted(root, {
        magic: "MZAR",
        version: 2,
        profile: invalid,
        files: [file()],
      });
      await assert.rejects(
        importProfile(archive, "test", join(root, "profiles")),
        /Invalid archive manifest/,
      );
      assert.deepEqual(await readdir(root), ["fixture.mzar"]);
    });
  });
}

for (const path of [
  "../outside",
  "Default/../outside",
  "Default:stream",
  "NUL",
  "Default/cookies.",
]) {
  test(`rejects unsafe file path ${path} before writing`, async () => {
    await fixture(async (root, value) => {
      const archive = await crafted(root, {
        magic: "MZAR",
        version: 2,
        profile: value,
        files: [file(path)],
      });
      await assert.rejects(
        importProfile(archive, "test", join(root, "profiles")),
        /unsafe archive path/,
      );
      assert.deepEqual(await readdir(root), ["fixture.mzar"]);
    });
  });
}

test("rejects duplicate and file-directory aliases before writing", async () => {
  await fixture(async (root, value) => {
    for (const paths of [
      ["Default/Cookies", "default/cookies"],
      ["Default", "Default/Cookies"],
      ["Default/Cookies", "Default"],
    ]) {
      const archive = await crafted(
        root,
        { magic: "MZAR", version: 2, profile: value, files: paths.map((p) => file(p)) },
        [bytes, bytes],
      );
      await assert.rejects(
        importProfile(archive, "test", join(root, "profiles")),
        /Invalid archive manifest/,
      );
    }
    assert.deepEqual(await readdir(root), ["fixture.mzar"]);
  });
});

test("checks all framing, sizes and checksums before writing", async () => {
  await fixture(async (root, value) => {
    const base = { magic: "MZAR", version: 2, profile: value, files: [file()] };
    for (const [manifest, payloads, trailing] of [
      [base, [], Buffer.alloc(0)],
      [base, [Buffer.from("short")], Buffer.alloc(0)],
      [{ ...base, files: [{ ...file(), sha256: "0".repeat(64) }] }, [bytes], Buffer.alloc(0)],
      [base, [bytes], Buffer.from("extra")],
      [{ ...base, version: 1 }, [bytes], Buffer.alloc(0)],
    ] as const) {
      const archive = await crafted(root, manifest, [...payloads], trailing);
      await assert.rejects(importProfile(archive, "test", join(root, "profiles")));
      assert.deepEqual(await readdir(root), ["fixture.mzar"]);
    }
  });
});

test("rolls back profile and newly restored extensions when persistence fails", async () => {
  await fixture(async (root, value) => {
    const profiles = join(root, "profiles");
    const extensions = join(root, "extensions");
    const existing = join(extensions, "existing", "1");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "sentinel"), "keep");
    const archive = await crafted(
      root,
      {
        magic: "MZAR",
        version: 2,
        profile: value,
        files: [file()],
        extensions: ["new", "existing"].map((id) => ({
          id,
          version: "1",
          files: [file("manifest.json")],
        })),
      },
      [bytes, bytes, bytes],
    );
    await assert.rejects(
      importProfile(archive, "test", profiles, {
        extensionStoreRoot: extensions,
        persist: () => {
          throw new Error("database unavailable");
        },
      }),
      /database unavailable/,
    );
    assert.deepEqual(await readdir(profiles), []);
    assert.deepEqual(await readdir(extensions), ["existing"]);
    assert.equal(await readFile(join(existing, "sentinel"), "utf8"), "keep");
    const restored = await importProfile(archive, "test", profiles, {
      extensionStoreRoot: extensions,
    });
    assert.equal(restored.id, value.id);
    assert.deepEqual(await readFile(join(extensions, "new", "1", "manifest.json")), bytes);
  });
});

test("does not write through an existing extension path that is a file", async () => {
  await fixture(async (root, value) => {
    const extensions = join(root, "extensions");
    await mkdir(extensions);
    await writeFile(join(extensions, "existing"), "keep");
    const archive = await crafted(
      root,
      {
        magic: "MZAR",
        version: 2,
        profile: value,
        files: [file()],
        extensions: [{ id: "existing", version: "1", files: [file("manifest.json")] }],
      },
      [bytes, bytes],
    );
    await assert.rejects(
      importProfile(archive, "test", join(root, "profiles"), { extensionStoreRoot: extensions }),
      /Unsafe extension store path/,
    );
    assert.deepEqual(await readdir(join(root, "profiles")), []);
    assert.equal(await readFile(join(extensions, "existing"), "utf8"), "keep");
  });
});

test("staging keeps incomplete extensions private and preserves a competing install on rollback", async (context) => {
  await fixture(async (root, value) => {
    const extensions = join(root, "extensions");
    const finalDir = join(extensions, "shared", "1");
    const archive = await crafted(
      root,
      {
        magic: "MZAR",
        version: 2,
        profile: value,
        files: [file()],
        extensions: [{ id: "shared", version: "1", files: [file("manifest.json")] }],
      },
      [bytes, bytes],
    );
    let entered!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalOpen = fsPromises.open;
    const originalWrite = fsPromises.writeFile;
    context.mock.method(
      fsPromises,
      "open",
      async (...args: Parameters<typeof originalOpen>) => {
        if (String(args[0]).endsWith("manifest.json")) {
          entered();
          await released;
        }
        return originalOpen(...args);
      },
    );
    syncBuiltinESMExports();
    const importing = importProfile(archive, "test", join(root, "profiles"), {
      extensionStoreRoot: extensions,
      persist: () => {
        throw new Error("database unavailable");
      },
    });
    const outcome = assert.rejects(importing, /database unavailable/);
    try {
      await paused;
      assert.equal(
        existsSync(finalDir),
        false,
        "another installer must not adopt an incomplete entry",
      );
      await mkdir(finalDir, { recursive: true });
      await originalWrite(join(finalDir, "manifest.json"), "competing install");
    } finally {
      resume();
      await outcome;
      context.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(await readFile(join(finalDir, "manifest.json"), "utf8"), "competing install");
    assert.deepEqual(await readdir(extensions), ["shared"]);
    assert.deepEqual(await readdir(join(root, "profiles")), []);
  });
});

test("failed persistence unpublishes extensions before another event-loop task can adopt them", async () => {
  await fixture(async (root, value) => {
    const extensions = join(root, "extensions");
    const finalDir = join(extensions, "shared", "1");
    const archive = await crafted(
      root,
      {
        magic: "MZAR",
        version: 2,
        profile: value,
        files: [file()],
        extensions: [{ id: "shared", version: "1", files: [file("manifest.json")] }],
      },
      [bytes, bytes],
    );
    let observedAfterPersistence: boolean | undefined;
    await assert.rejects(
      importProfile(archive, "test", join(root, "profiles"), {
        extensionStoreRoot: extensions,
        persist: () => {
          assert.equal(existsSync(join(finalDir, "manifest.json")), true);
          queueMicrotask(() => {
            observedAfterPersistence = existsSync(finalDir);
          });
          throw new Error("database unavailable");
        },
      }),
      /database unavailable/,
    );
    assert.equal(observedAfterPersistence, false);
    assert.deepEqual(await readdir(extensions), []);
  });
});
