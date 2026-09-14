const assert = require("node:assert/strict");
const test = require("node:test");
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  clearFailureMarker, evaluate, summarize, writeFailureMarker,
} = require("./canary-daily-check.cjs");

function clean(overrides = {}) {
  return {
    at: "2026-09-14T00:00:00.000Z",
    browser: { installed: true, version: "0.3.23" },
    engine: { provisioned: [{ engine: "cloakbrowser", version: "151.0.7922.108.6", binaryPresent: true }] },
    containment: [{ engine: "cloakbrowser", ok: true }],
    processes: {},
    profileDirectories: 3,
    host: { ramFreeMb: 4000, diskFreeGb: 20 },
    ...overrides,
  };
}

test("a healthy machine produces no findings", () => {
  assert.deepEqual(evaluate(clean()), []);
});

test("names each way the machine can drift under the product", () => {
  assert.match(evaluate(clean({ browser: { installed: false } }))[0], /not installed/);
  assert.match(evaluate(clean({ engine: { provisioned: [] } }))[0], /No provisioned engine/);
  assert.match(
    evaluate(clean({ engine: { provisioned: [{ engine: "cloakbrowser", binaryPresent: false }] } }))[0],
    /no runtime binary/,
  );
  // Containment vanishing is the quiet one: nothing looks wrong until a proxied launch is refused.
  assert.match(
    evaluate(clean({ containment: [{ engine: "cloakbrowser", ok: false, reason: "count=0" }] }))[0],
    /containment for cloakbrowser is not intact \(count=0\)/,
  );
  assert.match(evaluate(clean({ host: { ramFreeMb: 4000, diskFreeGb: 2 } }))[0], /2 GB free/);
});

test("counts distinct days, not check runs, and never calls a broken run partial", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "canary-summary-"));
  const write = (entries) => {
    const file = path.join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return file;
  };
  const day = (date, findings = []) => ({ at: `${date}T09:00:00.000Z`, findings });

  // Seven checks in one day is one day of evidence, whatever the log length says.
  const sameDay = write(Array.from({ length: 7 }, () => day("2026-09-14")));
  assert.equal(summarize(sameDay), 1);

  const sevenDays = Array.from({ length: 7 }, (_, index) => day(`2026-09-${String(14 + index).padStart(2, "0")}`));
  assert.equal(summarize(write(sevenDays)), 0);

  // One finding anywhere fails the whole window; a canary is a continuity claim, not a score.
  const withFinding = [...sevenDays];
  withFinding[3] = day("2026-09-17", ["WebRTC containment for cloakbrowser is not intact (count=0)."]);
  assert.equal(summarize(write(withFinding)), 1);
});

test("a finding leaves a marker nobody can miss, and a clean day removes it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "canary-marker-"));
  const logPath = path.join(dir, "canary-log.jsonl");
  const marker = path.join(dir, "CANARY-FAILED.txt");

  // Chay bang Task Scheduler thi khong ai doc stdout; exit 1 mot minh la mot lan hong bi giau.
  const written = writeFailureMarker(logPath, clean({
    at: "2026-09-17T09:00:00.000Z",
    findings: ["WebRTC containment for cloakbrowser is not intact (count=0)."],
  }));
  assert.equal(written, marker);
  assert.equal(existsSync(marker), true);
  const body = readFileSync(marker, "utf8");
  assert.match(body, /2026-09-17T09:00:00.000Z/);
  assert.match(body, /containment for cloakbrowser/);
  assert.match(body, /bat dau lai tu ngay mot/);

  // Su ton tai cua file la tin hieu, nen mot ngay sach phai don no di.
  clearFailureMarker(logPath);
  assert.equal(existsSync(marker), false);
  // Va don mot file khong co san khong duoc nem loi.
  assert.doesNotThrow(() => clearFailureMarker(logPath));
});
