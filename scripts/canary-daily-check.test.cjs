const assert = require("node:assert/strict");
const test = require("node:test");
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  activityByCalendarDay, clearFailureMarker, dayIsUsed, evaluate, profileActivity, summarize,
  writeFailureMarker,
} = require("./canary-daily-check.cjs");

/** Một ngày có mở và đóng profile, viết dưới dạng nhật ký vòng đời thật. */
function usedDay(date) {
  return [
    { timestamp: `${date}T08:00:00.000Z`, reason: "BOOTSTRAP-DONE", profileId: "p1" },
    { timestamp: `${date}T08:30:00.000Z`, reason: "SHUTDOWN-COMPLETE", profileId: "p1" },
  ];
}

/** Máy bật lên rồi thôi: chỉ có lượt quét mồ côi lúc khởi động, không profile nào được mở. */
function idleDay(date) {
  return [{ timestamp: `${date}T08:00:00.000Z`, reason: "ORPHAN-SWEEP-NONE" }];
}

function writeLifecycle(dir, records) {
  const file = path.join(dir, `lifecycle-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

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

test("counts days the machine was used, not check runs, and never calls a broken run partial", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "canary-summary-"));
  const write = (entries) => {
    const file = path.join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return file;
  };
  const day = (date, findings = []) => ({
    at: `${date}T09:00:00.000Z`,
    findings,
    profileActivity: { windowHours: 24, logPresent: true, launches: 1, closes: 1, profiles: 1 },
  });
  const dates = Array.from({ length: 7 }, (_, index) => `2026-09-${String(14 + index).padStart(2, "0")}`);
  // Nhật ký vòng đời rỗng: các dòng đã tự mang số đo, không được đo lại từ máy đang chạy test.
  const empty = writeLifecycle(dir, []);

  // Seven checks in one day is one day of evidence, whatever the log length says.
  const sameDay = write(Array.from({ length: 7 }, () => day("2026-09-14")));
  assert.equal(summarize(sameDay, empty), 1);

  const sevenDays = dates.map((date) => day(date));
  assert.equal(summarize(write(sevenDays), empty), 0);

  // One finding anywhere fails the whole window; a canary is a continuity claim, not a score.
  const withFinding = [...sevenDays];
  withFinding[3] = day("2026-09-17", ["WebRTC containment for cloakbrowser is not intact (count=0)."]);
  assert.equal(summarize(write(withFinding), empty), 1);

  // Một ngày máy ngồi không là một ngày KHÔNG tính, dù dòng ghi vẫn sạch trơn.
  const withIdleDay = sevenDays.map((entry, index) =>
    index === 2
      ? { ...entry, profileActivity: { windowHours: 24, logPresent: true, launches: 0, closes: 0, profiles: 0 } }
      : entry);
  assert.equal(summarize(write(withIdleDay), empty), 1);
});

test("measures a real open-and-close cycle, and refuses to read a startup sweep as usage", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "canary-activity-"));
  const now = new Date("2026-09-18T09:00:00.000Z");

  const used = writeLifecycle(dir, usedDay("2026-09-18"));
  assert.deepEqual(profileActivity(now, used), {
    windowHours: 24, logPresent: true, launches: 1, closes: 1, profiles: 1,
  });
  assert.equal(dayIsUsed(profileActivity(now, used)), true);

  // Lượt quét mồ côi chạy mỗi lần bật app. Đọc nó thành 'máy được dùng' là đúng cái dối trá
  // mà phép đo này sinh ra để chặn.
  const idle = writeLifecycle(dir, idleDay("2026-09-18"));
  assert.equal(dayIsUsed(profileActivity(now, idle)), false);

  // Ngoài cửa sổ 24 giờ thì không tính, dù vẫn nằm trong file.
  const old = writeLifecycle(dir, usedDay("2026-09-16"));
  assert.equal(dayIsUsed(profileActivity(now, old)), false);

  // Không có nhật ký thì nói là không có, đừng nói là không hoạt động.
  assert.equal(profileActivity(now, path.join(dir, "khong-ton-tai.log")).logPresent, false);
});

test("recomputes an older day from the lifecycle log instead of discarding it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "canary-recompute-"));
  const lifecycle = writeLifecycle(dir, [...usedDay("2026-09-14"), ...idleDay("2026-09-15")]);
  const days = activityByCalendarDay(lifecycle);

  assert.equal(dayIsUsed(days.get("2026-09-14")), true);
  assert.equal(dayIsUsed(days.get("2026-09-15")), false);
  assert.equal(days.get("2026-09-16"), undefined);
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
