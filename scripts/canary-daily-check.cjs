#!/usr/bin/env node
/**
 * Một lần đo trong canary 7 ngày, ghi thành một dòng JSON.
 *
 * Canary không phải là "chờ bảy ngày". Nó là bảy lần đo cùng một máy đang được dùng thật, để bắt
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
const { appendFileSync, existsSync, readFileSync, statSync, readdirSync } = require("node:fs");
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

function profileCount() {
  const root = path.join(process.env.LOCALAPPDATA ?? "", "MKTTool", "MKTBrowser", "data", "profiles");
  if (!existsSync(root)) return 0;
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
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

function summarize(logPath) {
  if (!existsSync(logPath)) throw new Error(`No canary log at ${logPath}.`);
  const entries = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const days = [...new Set(entries.map((entry) => entry.at.slice(0, 10)))].sort();
  const failed = entries.filter((entry) => entry.findings.length);
  process.stdout.write(`Canary log: ${entries.length} checks across ${days.length} distinct day(s).\n`);
  process.stdout.write(`First: ${days[0]}  Last: ${days[days.length - 1]}\n`);
  for (const entry of failed) process.stdout.write(`  FINDING ${entry.at}: ${entry.findings.join(" ")}\n`);
  // Seven distinct days, each clean. Anything less is an unfinished canary, never a partial pass.
  const passed = days.length >= 7 && failed.length === 0;
  process.stdout.write(passed
    ? "Seven-day canary PASSED. This attests continuity on this machine only.\n"
    : `Seven-day canary NOT complete (${days.length}/7 days, ${failed.length} finding(s)).\n`);
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
    profiles: profileCount(),
    host: hostResources(),
  };
  entry.findings = evaluate(entry);
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");

  process.stdout.write(`Recorded ${entry.at} -> ${logPath}\n`);
  if (entry.findings.length) {
    for (const finding of entry.findings) process.stdout.write(`  FINDING: ${finding}\n`);
    process.stdout.write("This canary run is broken; restart the seven days after fixing the cause.\n");
    return 1;
  }
  process.stdout.write(`Clean. Browser ${browser.version}, engine ${engine.provisioned.map((e) => `${e.engine} ${e.version}`).join(", ")}, ${entry.profiles} profile(s).\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Canary check failed."}\n`); process.exitCode = 1; }
}

module.exports = { evaluate, summarize };
