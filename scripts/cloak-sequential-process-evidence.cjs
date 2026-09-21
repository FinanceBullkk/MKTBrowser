const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const REQUIRED_NATIVE_FLAGS = [
  "fingerprint",
  "fingerprint-device-memory",
  "fingerprint-hardware-concurrency",
  "fingerprint-locale",
  "fingerprint-platform",
  "fingerprint-screen-height",
  "fingerprint-screen-width",
  "fingerprint-storage-quota",
  "fingerprint-taskbar-height",
  "fingerprint-timezone",
  "force-device-scale-factor",
  "remote-debugging-port",
  "user-data-dir",
];

async function inspectLaunchedProcess({ pid, userData, expectedEngineExecutable }) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:MKT_STAGE_A_PID); " +
        "if(-not $p){exit 3}; " +
        "[PSCustomObject]@{ExecutablePath=$p.ExecutablePath;CommandLine=$p.CommandLine}|ConvertTo-Json -Compress",
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, MKT_STAGE_A_PID: String(pid) },
    },
  );
  const observed = JSON.parse(stdout);
  const commandLine = String(observed.CommandLine ?? "");
  const executablePath = String(observed.ExecutablePath ?? "");
  const flags = parseCommandLineFlags(commandLine);
  const missingNativeFlags = REQUIRED_NATIVE_FLAGS.filter((flag) => !flags.has(flag));
  const fingerprintSeed = flags.get("fingerprint") ?? "";
  assert.ok(fingerprintSeed, "The engine command line has no native fingerprint seed.");
  return {
    executableSha256: await sha256File(executablePath),
    executableMatchesPinnedRuntime:
      path.resolve(executablePath).toLowerCase() ===
      path.resolve(expectedEngineExecutable).toLowerCase(),
    profileDataRootOwned: commandLine.toLowerCase().includes(path.resolve(userData).toLowerCase()),
    nativeFingerprintFlagCount: REQUIRED_NATIVE_FLAGS.length - missingNativeFlags.length,
    missingNativeFlags,
    fingerprintSeedDigest: sha256Text(fingerprintSeed),
    fingerprintDisabledFlagPresent: [...flags.keys()].some((flag) =>
      /fingerprint.*(?:off|disable)|disable.*fingerprint/.test(flag),
    ),
    proxyFlagPresent: flags.has("proxy-server"),
  };
}

function parseCommandLineFlags(commandLine) {
  const flags = new Map();
  const matcher = /--([a-z0-9-]+)(?:=("[^"]*"|'[^']*'|\S+))?/gi;
  for (const match of commandLine.matchAll(matcher)) {
    const raw = match[2] ?? "";
    flags.set(match[1].toLowerCase(), raw.replace(/^(["'])|(["'])$/g, ""));
  }
  return flags;
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidAlive(pid);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  await new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

module.exports = { inspectLaunchedProcess, parseCommandLineFlags, waitForPidExit };
