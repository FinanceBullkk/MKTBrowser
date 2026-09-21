import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const driver = readFileSync(new URL("./ChromiumBrowserDriver.ts", import.meta.url), "utf8");

function method(start: string, end: string): string {
  const from = driver.indexOf(start);
  const to = driver.indexOf(end, from + start.length);
  assert.notEqual(from, -1, start);
  assert.notEqual(to, -1, end);
  return driver.slice(from, to);
}

test("records exit-76 refusal before cleanup can classify an exited child as released", () => {
  const rotation = method("private async launchWithLicenseSeat", "private async launchTracked");
  const refusedAt = rotation.indexOf("licenseLeaseRecorder?.refused");
  const cleanupAt = rotation.indexOf("cleanupFailedLaunch");

  assert.ok(refusedAt >= 0 && refusedAt < cleanupAt, "refusal must be durable before cleanup");
});

test("protects the durable reservation with failed-launch cleanup", () => {
  const rotation = method("private async launchWithLicenseSeat", "private async launchTracked");
  const protectedAt = rotation.indexOf("try {");
  const reservedAt = rotation.indexOf("licenseLeaseRecorder?.reserved");

  assert.ok(protectedAt >= 0 && protectedAt < reservedAt, "reservation must be inside cleanup flow");
});

test("releases a durable reservation when launch fails before a process is tracked", () => {
  const rotation = method("private async launchWithLicenseSeat", "private async launchTracked");
  const cleanup = method("private async cleanupFailedLaunch", "private async releaseLicenseKey");
  const noPending = cleanup.match(/if \(!pending\) \{([\s\S]*?)\n {4}\}/)?.[1] ?? "";

  assert.match(rotation, /await this\.licenseLeaseRecorder\?\.reserved[\s\S]*?leaseReserved = true/);
  assert.match(rotation, /cleanupFailedLaunch\([\s\S]*?leaseReserved/);
  assert.match(noPending, /if \(leaseReserved\)[\s\S]*?releaseLicenseKey/);
  assert.match(noPending, /else \{[\s\S]*?licenseKeyPool\?\.release\(profileId, true\)/);
});

test("makes active state durable before publishing a running Browser", () => {
  const launch = method("private async launchTracked", "private async handleRunningChildExit");
  const activeAt = launch.indexOf("licenseLeaseRecorder?.active");
  const publishAt = launch.indexOf("this.running.set");

  assert.ok(activeAt >= 0 && activeAt < publishAt, "active write must precede publication");
});

test("makes starting state durable before spawning a licensed Browser", () => {
  const launch = method("private async launchTracked", "private async handleRunningChildExit");
  const startingAt = launch.indexOf("licenseLeaseRecorder?.started");
  const spawnAt = launch.indexOf("const child = spawn");

  assert.ok(startingAt >= 0 && startingAt < spawnAt, "starting write must precede spawn");
});

test("persists release before changing in-memory capacity", () => {
  const release = method("private async releaseLicenseKey", "private shutdownRunningProfile");
  const durableAt = release.indexOf("licenseLeaseRecorder?.released");
  const poolAt = release.indexOf("licenseKeyPool?.release");

  assert.match(release, /licenseKeyPool\?\.keyFor\(profileId\)/);
  assert.ok(durableAt >= 0 && durableAt < poolAt, "journal release must precede pool release");
  assert.match(release, /licenseKeyPool\?\.release\(profileId, false\)/);
});

test("classifies an observed child exit before releasing its seat", () => {
  const exit = method("private async handleRunningChildExit", "private async cleanupFailedLaunch");
  const cleanup = method("private async cleanupFailedLaunch", "private async releaseLicenseKey");

  assert.match(
    exit,
    /didBrowserExitReleaseSeat\(exitCode, signal, record\.pid === record\.child\.pid\)/,
  );
  assert.match(cleanup, /pending\.pid === pending\.child\.pid/);
});

test("keeps an unreachable or ambiguously exited Browser seat resting", () => {
  const launch = method("private async launchTracked", "private async handleRunningChildExit");
  const release = method("private async releaseLicenseKey", "private shutdownRunningProfile");

  assert.match(launch, /CDP-UNREACHABLE[\s\S]*?\? false : undefined/);
  assert.match(release, /seatReleasedOverride \?\? false/);
  assert.doesNotMatch(release, /method === "Browser\.close"/);
  assert.doesNotMatch(release, /method === "already-exited"/);
});

test("a vendor refusal cannot automatically spawn another engine", () => {
  const launch = method("private async launchWithLicenseSeat", "private async launchTracked");
  assert.doesNotMatch(launch, /for\s*\(|while\s*\(|setTimeout|setInterval/);
  assert.equal(launch.match(/this\.launchTracked\(/g)?.length, 1);
  assert.match(launch, /markRefused/);
  assert.match(launch, /throw engineUnavailable/);
});
