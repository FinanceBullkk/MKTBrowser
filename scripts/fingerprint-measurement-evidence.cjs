const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function assertTemporaryPath(target) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(target);
  const relative = path.relative(tempRoot, resolved);
  assert.ok(
    relative.length > 0 &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    "Sensitive fingerprint evidence must stay inside the temporary directory.",
  );
  return resolved;
}

function preparedRecording({ label, profileCount, runCount, surfaceNames }) {
  return {
    schemaVersion: 1,
    sensitiveHostFingerprintData: true,
    label,
    preparedAt: new Date().toISOString(),
    surfaceNames,
    stock: null,
    preflight: null,
    profiles: Array.from({ length: profileCount }, (_, index) => ({
      label: `P${index + 1}`,
      seed: `phase02-cloak-stable2-profile-${index + 1}`,
      id: null,
      configuredFingerprint: null,
      runs: Array(runCount).fill(null),
    })),
  };
}

async function summarizeLifecycle(userData, profileIds, expectedCloses) {
  const logPath = path.join(userData, "profile-shutdown.log");
  const records = existsSync(logPath)
    ? (await readFile(logPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const relevant = records.filter((record) => profileIds.includes(record.profileId));
  const completed = relevant.filter((record) => record.reason === "SHUTDOWN-COMPLETE");
  return {
    expectedCloses,
    completedCloses: completed.length,
    browserClose: completed.filter((record) => record.shutdownMethod === "Browser.close").length,
    signalEscalations: completed.filter((record) =>
      ["SIGTERM", "SIGKILL"].includes(record.shutdownMethod),
    ).length,
  };
}

function summarizeCoverage(profiles, stock, surfaceNames) {
  const samples = [stock, ...profiles.flatMap((profile) => profile.runs)];
  const contexts = ["document", "iframe", "worker", "offscreenCanvas"];
  return Object.fromEntries(
    contexts.map((context) => [
      context,
      Object.fromEntries(
        surfaceNames.map((surface) => {
          const values = samples.map((sample) => sample.contexts?.[context]?.surfaces?.[surface]);
          return [surface, values.filter((value) => value?.supported === true).length];
        }),
      ),
    ]),
  );
}

async function persist(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function removeTemporaryTree(target) {
  const resolved = assertTemporaryPath(target);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(resolved, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

module.exports = {
  assertTemporaryPath,
  persist,
  preparedRecording,
  removeTemporaryTree,
  summarizeCoverage,
  summarizeLifecycle,
};
