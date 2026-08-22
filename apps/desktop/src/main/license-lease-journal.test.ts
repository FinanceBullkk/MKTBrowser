import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LicenseLeaseJournal } from "./license-lease-journal.ts";

test("persists a reserved lease without persisting the full key", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-journal-"));
  const file = join(root, "license-leases.json");
  const fullKey = "cb_live_secret_abcdef123456";

  try {
    const journal = await LicenseLeaseJournal.open(file, {
      now: () => Date.parse("2026-08-21T12:00:00.000Z"),
      idFactory: () => "lease-record-1",
    });
    const reserved = await journal.reserve({ profileId: "profile-a", key: fullKey });

    assert.equal(reserved.state, "reserved");
    assert.equal(reserved.keyTail, "123456");
    assert.equal(reserved.keyFingerprint.length, 64);

    const persisted = await readFile(file, "utf8");
    assert.equal(persisted.includes(fullKey), false);

    const reopened = await LicenseLeaseJournal.open(file);
    assert.deepEqual(reopened.get("profile-a"), reserved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not persist a short development key as its own tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-journal-"));
  const file = join(root, "license-leases.json");
  const fullKey = "short";

  try {
    const journal = await LicenseLeaseJournal.open(file);
    const reserved = await journal.reserve({ profileId: "profile-short", key: fullKey });
    const persisted = await readFile(file, "utf8");

    assert.notEqual(reserved.keyTail, fullKey);
    assert.equal(persisted.includes(`"keyTail":"${fullKey}"`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects reserving one profile with a different license key", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-journal-"));
  const file = join(root, "license-leases.json");

  try {
    const journal = await LicenseLeaseJournal.open(file, {
      idFactory: () => "lease-record-cross-wire",
    });
    const reserved = await journal.reserve({
      profileId: "profile-a",
      key: "cb_live_secret_key_a_123456",
    });

    await assert.rejects(
      journal.reserve({ profileId: "profile-a", key: "cb_live_secret_key_b_654321" }),
      /different license key/i,
    );
    assert.deepEqual(journal.get("profile-a"), reserved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects reserving one license key for two profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-journal-"));
  const file = join(root, "license-leases.json");

  try {
    const journal = await LicenseLeaseJournal.open(file);
    const key = "cb_live_secret_shared_123456";
    await journal.reserve({ profileId: "profile-a", key });

    await assert.rejects(
      journal.reserve({ profileId: "profile-b", key }),
      /another profile/i,
    );
    assert.equal(journal.get("profile-b"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows only explicit lease lifecycle transitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-journal-"));
  const file = join(root, "license-leases.json");
  let now = Date.parse("2026-08-21T12:00:00.000Z");

  try {
    const journal = await LicenseLeaseJournal.open(file, {
      now: () => now,
      idFactory: () => "lease-record-2",
    });
    await journal.reserve({ profileId: "profile-a", key: "cb_live_secret_abcdef123456" });

    await assert.rejects(
      journal.transition("profile-a", "confirmed-released"),
      /cannot transition.*reserved.*confirmed-released/i,
    );

    now += 1;
    await journal.transition("profile-a", "starting", { childPid: 4123 });
    await journal.transition("profile-a", "active");
    await journal.transition("profile-a", "ending");
    const released = await journal.transition("profile-a", "confirmed-released");

    assert.equal(released.childPid, 4123);
    assert.equal(released.state, "confirmed-released");
    assert.equal(released.updatedAt, new Date(now).toISOString());
    await assert.rejects(journal.transition("profile-a", "active"), /cannot transition/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers the last committed record when the current journal is malformed", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-journal-"));
  const file = join(root, "license-leases.json");

  try {
    const journal = await LicenseLeaseJournal.open(file, {
      idFactory: () => "lease-record-3",
    });
    await journal.reserve({ profileId: "profile-a", key: "cb_live_secret_abcdef123456" });
    await journal.transition("profile-a", "starting", { childPid: 9876 });
    await writeFile(file, '{"schemaVersion":1,"records":[', "utf8");

    const recovered = await LicenseLeaseJournal.open(file);
    assert.equal(recovered.get("profile-a")?.state, "reserved");
    assert.equal(recovered.get("profile-a")?.childPid, null);
    const restoredContents = await readFile(file, "utf8");
    assert.doesNotThrow(() => JSON.parse(restoredContents));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects duplicate profile records instead of silently cross-wiring them", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-journal-"));
  const file = join(root, "license-leases.json");

  try {
    const journal = await LicenseLeaseJournal.open(file, {
      idFactory: () => "lease-record-duplicate-a",
    });
    await journal.reserve({ profileId: "profile-a", key: "cb_live_secret_key_a_123456" });

    const persisted = JSON.parse(await readFile(file, "utf8")) as {
      schemaVersion: 1;
      records: Array<Record<string, unknown>>;
    };
    persisted.records.push({ ...persisted.records[0], id: "lease-record-duplicate-b" });
    await writeFile(file, JSON.stringify(persisted), "utf8");

    await assert.rejects(LicenseLeaseJournal.open(file), /duplicate profile/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects incomplete records instead of accepting ambiguous recovery state", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-journal-"));
  const file = join(root, "license-leases.json");

  try {
    const journal = await LicenseLeaseJournal.open(file);
    await journal.reserve({ profileId: "profile-a", key: "cb_live_secret_key_a_123456" });
    const persisted = JSON.parse(await readFile(file, "utf8")) as {
      schemaVersion: 1;
      records: Array<Record<string, unknown>>;
    };
    delete persisted.records[0]!.updatedAt;
    await writeFile(file, JSON.stringify(persisted), "utf8");

    await assert.rejects(LicenseLeaseJournal.open(file), /invalid record/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps in-memory state unchanged when a durable journal write fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-journal-"));
  const parent = join(root, "journal-parent");
  const file = join(parent, "license-leases.json");

  try {
    await mkdir(parent);
    const journal = await LicenseLeaseJournal.open(file);
    await rm(parent, { recursive: true, force: true });
    await writeFile(parent, "not-a-directory", "utf8");

    await assert.rejects(
      journal.reserve({ profileId: "profile-a", key: "cb_live_secret_abcdef123456" }),
    );
    assert.equal(journal.get("profile-a"), null);
    assert.deepEqual(journal.snapshot(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts only stable redacted error codes in persisted recovery state", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-journal-"));
  const file = join(root, "license-leases.json");
  const fullKey = "cb_live_secret_abcdef123456";

  try {
    const journal = await LicenseLeaseJournal.open(file);
    await journal.reserve({ profileId: "profile-a", key: fullKey });

    await assert.rejects(
      journal.markPendingRecovery("profile-a", fullKey),
      /stable error code/i,
    );
    assert.equal(journal.get("profile-a")?.state, "reserved");
    assert.equal((await readFile(file, "utf8")).includes(fullKey), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent reservations without losing a durable record", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-journal-"));
  const file = join(root, "license-leases.json");

  try {
    const journal = await LicenseLeaseJournal.open(file);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        journal.reserve({
          profileId: `profile-${index}`,
          key: `cb_live_concurrent_${String(index).padStart(6, "0")}`,
        }),
      ),
    );

    assert.equal(journal.snapshot().length, 12);
    assert.equal((await LicenseLeaseJournal.open(file)).snapshot().length, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
