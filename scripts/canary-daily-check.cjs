#!/usr/bin/env node
/**
 * Một lần đo trong canary 7 ngày, ghi thành một dòng JSON.
 *
 * Canary không phải là "chờ bảy ngày". Nó là bảy lần đo cùng một máy đang được dùng thật, để bắt
 * - và "đang được dùng thật" nay được ĐO chứ không còn được giả định: mỗi dòng ghi lại số lần mở
 * và đóng profile trong 24 giờ trước đó, và một ngày máy ngồi không thì không tính vào bảy ngày,
 * những thứ chỉ lộ ra theo thời gian: engine bị thay dưới chân, rule chặn WebRTC biến mất sau một
 * lần cập nhật Windows, tiến trình rò rỉ qua từng lần mở, đĩa đầy dần.
 *
 * Script CHỈ ĐỌC. Nó không sửa, không tắt, không cài gì cả.
 *
 *   node scripts/canary-daily-check.cjs            → ghi vào canary-log.jsonl cạnh script
 *   node scripts/canary-daily-check.cjs --log <p>  → ghi vào file khác
 *   node scripts/canary-daily-check.cjs --summary  → đọc log, in kết quả 7 ngày
 *
 * Thoát 0 nếu lần đo này đạt, 1 nếu có phát hiện. Một lần 1 là canary hỏng — bắt đầu lại từ đầu,
 * vì bảy ngày liên tiếp mới là thứ đang được chứng minh.
 */
const { execFileSync } = require("node:child_process");
const { appendFileSync, existsSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const ENGINES = { cft: "Chrome for Testing", cloakbrowser: "CloakBrowser" };

function powershell(script, extraEnv = {}) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
    // Names go in as environment values, never spliced into the script: a display name carrying a
    // quote or a parenthesis would otherwise read as zero matching rules and look like a finding.
    env: { ...process.env, ...extraEnv },
  }).trim();
}

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function installedBrowser() {
  const exe = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "MKTBrowser", "MKTBrowser.exe");
  if (!existsSync(exe)) return { installed: false };
  const version = powershell(
    `(Get-Item -LiteralPath '${exe}').VersionInfo.FileVersion`,
  );
  return { installed: true, exe, version, sizeBytes: statSync(exe).size };
}

/** The engine must stay the one that was accepted; a silent swap is exactly what this watches for. */
function engineState() {
  const root = path.join(process.env.LOCALAPPDATA ?? "", "MKTTool", "MKTBrowser", "chromium");
  if (!existsSync(root)) return { provisioned: [] };
  const provisioned = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, "current.json")))
    .map((entry) => {
      const current = JSON.parse(readFileSync(path.join(root, entry.name, "current.json"), "utf8"));
      const binary = path.join(root, entry.name, "runtime", "chrome.exe");
      return {
        engine: entry.name,
        version: current.version,
        binary,
        binaryPresent: existsSync(binary),
        binarySizeBytes: existsSync(binary) ? statSync(binary).size : null,
      };
    });
  return { provisioned };
}

/**
 * A proxied launch is refused without this rule, so its quiet disappearance - a Windows update, a
 * security tool, a second install - would turn into "the proxy is broken" days later.
 */
function containmentRules(engines) {
  return engines.map(({ engine, binary }) => {
    const display = ENGINES[engine];
    if (!display) return { engine, ok: false, reason: "unknown-engine" };
    const raw = powershell(
      "$p=New-Object -ComObject HNetCfg.FwPolicy2; " +
        "$r=@($p.Rules | Where-Object { $_.Name -eq $env:MKT_CANARY_RULE_NAME }); " +
        "if($r.Count -ne 1){'count=' + $r.Count} else { $x=$r[0]; " +
        "\"program=$($x.ApplicationName)|enabled=$($x.Enabled)|dir=$($x.Direction)|" +
        "action=$($x.Action)|proto=$($x.Protocol)|profiles=$($x.Profiles)\" }",
      { MKT_CANARY_RULE_NAME: `MKT Browser WebRTC UDP Block (${display})` },
    );
    if (raw.startsWith("count=")) return { engine, ok: false, reason: raw };
    const fields = Object.fromEntries(raw.split("|").map((part) => part.split("=")));
    const ok =
      path.resolve(fields.program ?? "").toLowerCase() === path.resolve(binary).toLowerCase() &&
      fields.enabled === "True" && fields.dir === "2" && fields.action === "0" &&
      fields.proto === "17" && (Number(fields.profiles) & 7) === 7;
    return { engine, ok, program: fields.program, enabled: fields.enabled, protocol: fields.proto };
  });
}

function liveProcesses() {
  const raw = powershell(
    "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('MKTBrowser.exe','MKTTool-Relay.exe') " +
      "-or $_.ExecutablePath -like '*chromium*runtime*chrome.exe' } | " +
      "Group-Object Name | ForEach-Object { \"$($_.Name)=$($_.Count)\" }) -join '|'",
  );
  return Object.fromEntries(
    raw ? raw.split("|").map((part) => { const [name, count] = part.split("="); return [name, Number(count)]; }) : [],
  );
}

function hostResources() {
  const raw = powershell(
    "$os=Get-CimInstance Win32_OperatingSystem; $c=Get-PSDrive C; " +
      "\"ramFreeMb=$([math]::Round($os.FreePhysicalMemory/1KB))|diskFreeGb=$([math]::Round($c.Free/1GB,1))\"",
  );
  const fields = Object.fromEntries(raw.split("|").map((part) => part.split("=")));
  return { ramFreeMb: Number(fields.ramFreeMb), diskFreeGb: Number(fields.diskFreeGb) };
}

/**
 * Directories on disk, which is NOT the product's profile count: the app reported 19 profiles on
 * 14 Sep 2026 while 20 directories existed. Whether the extra one is an orphan or simply a kind the
 * adapter does not list, calling this "profiles" would put a number in the log that the product
 * would contradict. It is context for reading drift, never a pass criterion.
 */
function profileDirectoryCount() {
  const root = path.join(process.env.LOCALAPPDATA ?? "", "MKTTool", "MKTBrowser", "data", "profiles");
  if (!existsSync(root)) return 0;
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

/**
 * Nhật ký vòng đời profile mà chính Browser ghi ra. Xem `profile-lifecycle-log.ts`.
 *
 * Canary đo 'máy có trôi đi không', nhưng điều kiện để phép đo ấy có nghĩa là **máy phải
 * đang được dùng**: doc của canary viết thẳng rằng máy để không thì không trôi đi đâu cả.
 * Trước 18/09/2026 không có gì ghi lại điều kiện đó, nên một tuần máy ngồi không cũng ra
 * đúng bảy dòng sạch như một tuần làm việc thật.
 */
const LIFECYCLE_LOG = path.join(process.env.LOCALAPPDATA ?? "", "MKTTool", "MKTBrowser", "profile-shutdown.log");

/** Cửa sổ 24 giờ trước lúc đo, không phải 'cùng ngày lịch': tránh lệch múi giờ và lệch giờ chạy task. */
const ACTIVITY_WINDOW_HOURS = 24;

/** Mở xong một profile. Các chặng BOOTSTRAP-* khác là nửa đường, không tính. */
const LAUNCH_REASONS = new Set(["BOOTSTRAP-DONE"]);

/** Đóng xong. `CHILD-EXIT` tính vì một profile chết cũng là một vòng đời đã chạy. */
const CLOSE_REASONS = new Set(["SHUTDOWN-COMPLETE", "CHILD-EXIT"]);

function readLifecycleRecords(logPath) {
  if (!existsSync(logPath)) return null;
  const records = [];
  for (const line of readFileSync(logPath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* một dòng rách không được làm hỏng cả phép đo */ }
  }
  return records;
}

/** Máy có mở VÀ đóng profile trong 24 giờ qua không — đúng điều kiện doc canary đặt ra. */
function profileActivity(now = new Date(), logPath = LIFECYCLE_LOG) {
  const records = readLifecycleRecords(logPath);
  const base = { windowHours: ACTIVITY_WINDOW_HOURS, logPresent: records !== null, launches: 0, closes: 0, profiles: 0 };
  if (!records) return base;

  const until = now.getTime();
  const since = until - ACTIVITY_WINDOW_HOURS * 60 * 60 * 1000;
  const profiles = new Set();
  for (const record of records) {
    const at = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(at) || at < since || at > until) continue;
    if (LAUNCH_REASONS.has(record.reason)) base.launches += 1;
    else if (!CLOSE_REASONS.has(record.reason)) continue;
    else base.closes += 1;
    if (record.profileId) profiles.add(record.profileId);
  }
  base.profiles = profiles.size;
  return base;
}

/**
 * Đo lại hoạt động theo NGÀY LỊCH, dùng cho những dòng canary ghi trước 18/09/2026.
 *
 * Chúng không có trường `profileActivity`, nhưng bằng chứng thì vẫn còn nguyên trong nhật ký
 * vòng đời. Vứt chúng đi là mất bằng chứng đang có thật; mặc định coi là đạt lại là thứ dự án
 * này cấm. Đo lại bằng đúng phép đo, rồi nói rõ dòng nào là đo lại.
 */
function activityByCalendarDay(logPath = LIFECYCLE_LOG) {
  const records = readLifecycleRecords(logPath);
  if (!records) return null;
  const days = new Map();
  for (const record of records) {
    const day = String(record.timestamp ?? "").slice(0, 10);
    if (day.length !== 10) continue;
    const seen = days.get(day) ?? { launches: 0, closes: 0 };
    if (LAUNCH_REASONS.has(record.reason)) seen.launches += 1;
    if (CLOSE_REASONS.has(record.reason)) seen.closes += 1;
    days.set(day, seen);
  }
  return days;
}

/** Một ngày chỉ tính vào canary khi máy thật sự mở và đóng ít nhất một profile trong ngày đó. */
function dayIsUsed(activity) {
  return Boolean(activity) && activity.launches > 0 && activity.closes > 0;
}

function evaluate(entry) {
  const findings = [];
  if (!entry.browser.installed) findings.push("MKT Browser is not installed.");
  if (!entry.engine.provisioned.length) findings.push("No provisioned engine.");
  for (const engine of entry.engine.provisioned) {
    if (!engine.binaryPresent) findings.push(`Engine ${engine.engine} has no runtime binary.`);
  }
  for (const rule of entry.containment) {
    if (!rule.ok) findings.push(`WebRTC containment for ${rule.engine} is not intact (${rule.reason ?? "mismatch"}).`);
  }
  if (entry.host.diskFreeGb < 5) findings.push(`Only ${entry.host.diskFreeGb} GB free on C:.`);
  return findings;
}

/**
 * Mot canary hong im lang thi khong phai canary.
 *
 * Script nay chay bang Task Scheduler, khong ai ngoi xem. Thoat 1 chi hien o cot "Last Run Result"
 * cua Task Scheduler, va khong ai mo cho do hang ngay. Nen mot lan hong de lai mot file ten to
 * tuong ngay canh log, va mot lan sach thi don no di - de chinh su ton tai cua file la tin hieu.
 */
function writeFailureMarker(logPath, entry) {
  const marker = path.join(path.dirname(logPath), "CANARY-FAILED.txt");
  writeFileSync(marker, [
    `Canary phat hien van de luc ${entry.at}`,
    "",
    ...entry.findings.map((finding) => `  - ${finding}`),
    "",
    "Cua so 7 ngay nay da hong. Sua nguyen nhan roi bat dau lai tu ngay mot.",
    `Log: ${logPath}`,
    "",
  ].join("\n"), "utf8");
  return marker;
}

function clearFailureMarker(logPath) {
  try {
    rmSync(path.join(path.dirname(logPath), "CANARY-FAILED.txt"), { force: true });
  } catch {
    // Mot canh bao thua khong nguy hiem bang mot lan hong bi giau, nen loi xoa la bo qua duoc.
  }
}

function summarize(logPath, lifecycleLog = LIFECYCLE_LOG) {
  if (!existsSync(logPath)) throw new Error(`No canary log at ${logPath}.`);
  const entries = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const days = [...new Set(entries.map((entry) => entry.at.slice(0, 10)))].sort();
  const failed = entries.filter((entry) => entry.findings.length);
  const recomputed = activityByCalendarDay(lifecycleLog);

  const used = [];
  const idle = [];
  const unknown = [];
  for (const day of days) {
    const measured = entries.filter((entry) => entry.at.slice(0, 10) === day && entry.profileActivity);
    if (measured.length) {
      (measured.some((entry) => dayIsUsed(entry.profileActivity)) ? used : idle).push(day);
      continue;
    }
    // Dòng ghi trước khi có phép đo: đo lại từ nhật ký vòng đời, và nói rõ là đo lại.
    if (!recomputed) { unknown.push(day); continue; }
    (dayIsUsed(recomputed.get(day)) ? used : idle).push(`${day}*`);
  }

  process.stdout.write(`Canary log: ${entries.length} checks across ${days.length} distinct day(s).\n`);
  process.stdout.write(`First: ${days[0]}  Last: ${days[days.length - 1]}\n`);
  for (const entry of failed) process.stdout.write(`  FINDING ${entry.at}: ${entry.findings.join(" ")}\n`);
  process.stdout.write(`Days the machine was actually used (opened and closed a profile): ${used.length}/7`
    + (used.length ? ` - ${used.join(", ")}` : "") + "\n");
  if (idle.length) process.stdout.write(`  Idle, does not count: ${idle.join(", ")}\n`);
  if (unknown.length) process.stdout.write(`  Not measured and no lifecycle log to recompute from: ${unknown.join(", ")}\n`);
  if (used.some((day) => day.endsWith("*")) || idle.some((day) => day.endsWith("*"))) {
    process.stdout.write("  * recomputed from profile-shutdown.log; that day predates the activity field.\n");
  }

  // Bảy ngày lịch khác nhau, mỗi ngày sạch VÀ máy có được dùng. Thiếu bất cứ vế nào cũng là
  // một canary chưa xong, không bao giờ là một lần đạt một phần.
  const passed = used.length >= 7 && failed.length === 0;
  process.stdout.write(passed
    ? "Seven-day canary PASSED. This attests continuity on this machine only.\n"
    : `Seven-day canary NOT complete (${used.length}/7 used day(s), ${failed.length} finding(s)).\n`);
  return passed ? 0 : 1;
}

function main() {
  if (process.platform !== "win32") throw new Error("The canary check runs on the Windows machine under test.");
  const logPath = path.resolve(argValue("log", path.join(__dirname, "canary-log.jsonl")));
  if (process.argv.includes("--summary")) return summarize(logPath);

  const browser = installedBrowser();
  const engine = engineState();
  const entry = {
    at: new Date().toISOString(),
    browser,
    engine,
    containment: containmentRules(engine.provisioned.map(({ engine: name, binary }) => ({ engine: name, binary }))),
    processes: liveProcesses(),
    profileDirectories: profileDirectoryCount(),
    profileActivity: profileActivity(),
    host: hostResources(),
  };
  entry.findings = evaluate(entry);
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");

  process.stdout.write(`Recorded ${entry.at} -> ${logPath}\n`);
  if (entry.findings.length) {
    const marker = writeFailureMarker(logPath, entry);
    for (const finding of entry.findings) process.stdout.write(`  FINDING: ${finding}\n`);
    process.stdout.write(`  Da ghi canh bao: ${marker}\n`);
    process.stdout.write("This canary run is broken; restart the seven days after fixing the cause.\n");
    return 1;
  }
  clearFailureMarker(logPath);
  process.stdout.write(`Clean. Browser ${browser.version}, engine ${engine.provisioned.map((e) => `${e.engine} ${e.version}`).join(", ")}, ${entry.profileDirectories} profile director(ies).\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Canary check failed."}\n`); process.exitCode = 1; }
}

module.exports = { activityByCalendarDay, clearFailureMarker, dayIsUsed, evaluate, profileActivity, summarize, writeFailureMarker };
