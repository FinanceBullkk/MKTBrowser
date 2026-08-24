import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LicenseLeaseJournal } from "./license-lease-journal.ts";
import { LicenseLeaseRecorder } from "./license-lease-recorder.ts";

const KEY = "cb_aaaaaa111111";

async function journalIn(): Promise<{ journal: LicenseLeaseJournal; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mkt-lease-recorder-"));
  const journal = await LicenseLeaseJournal.open(join(dir, "license-leases.json"));
  return { journal, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("a clean close records the seat as given back", async () => {
  const { journal, cleanup } = await journalIn();
  try {
    const recorder = new LicenseLeaseRecorder(journal);
    await recorder.reserved("p1", KEY);
    await recorder.started("p1", 4123);
    await recorder.active("p1");
    await recorder.released("p1", true);

    assert.equal(journal.get("p1")?.state, "confirmed-released");
  } finally {
    await cleanup();
  }
});

test("a killed browser records the seat as still resting", async () => {
  // The whole point: this record is what stops the next run offering a key the vendor still counts.
  const { journal, cleanup } = await journalIn();
  try {
    const recorder = new LicenseLeaseRecorder(journal);
    await recorder.reserved("p1", KEY);
    await recorder.started("p1", 4123);
    await recorder.active("p1");
    await recorder.released("p1", false);

    assert.equal(journal.get("p1")?.state, "cooling");
  } finally {
    await cleanup();
  }
});

test("a launch that never spawned frees the key for other profiles", async () => {
  // A reservation left behind would make `reserve` refuse this key to every other profile.
  const { journal, cleanup } = await journalIn();
  try {
    const recorder = new LicenseLeaseRecorder(journal);
    await recorder.reserved("p1", KEY);
    await recorder.released("p1", true);

    await recorder.reserved("p2", KEY);
    assert.equal(journal.get("p2")?.state, "reserved");
  } finally {
    await cleanup();
  }
});

test("a refusal is recorded terminally so a restart keeps resting the key", async () => {
  const { journal, cleanup } = await journalIn();
  try {
    const recorder = new LicenseLeaseRecorder(journal);
    await recorder.reserved("p1", KEY);
    await recorder.started("p1", 4123);
    await recorder.refused("p1");

    assert.equal(journal.get("p1")?.state, "terminal-refused");
  } finally {
    await cleanup();
  }
});

test("a journal failure is logged and never thrown at the launch", async () => {
  // A bookkeeping write must not be able to stop a browser that would otherwise open.
  const logged: string[] = [];
  const broken = {
    get: () => null,
    reserve: () => Promise.reject(new Error("disk full")),
    transition: () => Promise.reject(new Error("disk full")),
    releaseUnstartedReservation: () => Promise.reject(new Error("disk full")),
  };
  const recorder = new LicenseLeaseRecorder(broken as never, (m) => logged.push(m));

  await recorder.reserved("p1", KEY);

  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /reserve failed for profile=p1/);
});

test("released on a profile with no record does nothing", async () => {
  const { journal, cleanup } = await journalIn();
  try {
    const recorder = new LicenseLeaseRecorder(journal);
    await recorder.released("never-seen", false);
    assert.equal(journal.snapshot().length, 0);
  } finally {
    await cleanup();
  }
});

test("a double close does not corrupt an already-final record", async () => {
  const { journal, cleanup } = await journalIn();
  try {
    const recorder = new LicenseLeaseRecorder(journal);
    await recorder.reserved("p1", KEY);
    await recorder.started("p1", 4123);
    await recorder.released("p1", false);
    await recorder.released("p1", true);

    assert.equal(journal.get("p1")?.state, "cooling", "the first, honest verdict must stand");
  } finally {
    await cleanup();
  }
});
