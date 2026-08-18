import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, win32 } from "node:path";
import test, { afterEach } from "node:test";
import {
  claimCompatibilitySmokeAuthorization,
  clearClaimedCompatibilitySmokeAuthorization,
} from "./compatibility-smoke-authorization.ts";
import { compatibilityUpdaterRoot } from "./compatibility-engine-pin.ts";

const authorizationId = "741d4377-4c55-4fb0-8c41-133aaa15057a";
const now = new Date("2026-08-15T00:00:30.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("claims a short-lived authorization once and binds it to the smoke marker", () => {
  const fixture = createFixture();
  const claimed = claimCompatibilitySmokeAuthorization({
    localAppData: fixture.localAppData,
    authorizationId,
    now,
  });
  assert.equal(claimed.authorization.profileId, "profile-smoke");
  assert.throws(
    () =>
      claimCompatibilitySmokeAuthorization({
        localAppData: fixture.localAppData,
        authorizationId,
        now,
      }),
    /ENOENT/,
  );
  clearClaimedCompatibilitySmokeAuthorization(claimed.consumedPath);
});

test("consumes and rejects an authorization whose marker is not in smoke phase", () => {
  const fixture = createFixture("activating");
  assert.throws(
    () =>
      claimCompatibilitySmokeAuthorization({
        localAppData: fixture.localAppData,
        authorizationId,
        now,
      }),
    /activation marker does not authorize/,
  );
});

test("rejects expired and overlong authorizations", () => {
  const expired = createFixture("smoke", {
    issuedAt: "2026-08-14T23:58:00.000Z",
    expiresAt: "2026-08-14T23:59:00.000Z",
  });
  assert.throws(
    () =>
      claimCompatibilitySmokeAuthorization({
        localAppData: expired.localAppData,
        authorizationId,
        now,
      }),
    /invalid or expired/,
  );
  const overlong = createFixture("smoke", {
    issuedAt: "2026-08-15T00:00:00.000Z",
    expiresAt: "2026-08-15T00:04:00.000Z",
  });
  assert.throws(
    () =>
      claimCompatibilitySmokeAuthorization({
        localAppData: overlong.localAppData,
        authorizationId,
        now,
      }),
    /invalid or expired/,
  );
});

function createFixture(
  phase = "smoke",
  time = {
    issuedAt: "2026-08-15T00:00:00.000Z",
    expiresAt: "2026-08-15T00:01:00.000Z",
  },
) {
  const root = mkdtempSync(join(os.tmpdir(), "mkt-browser-smoke-auth-"));
  roots.push(root);
  const localAppData = root;
  const updateRoot = compatibilityUpdaterRoot(localAppData);
  const directory = win32.join(updateRoot, "smoke-authorizations");
  mkdirSync(directory, { recursive: true });
  const manifestDigest = "a".repeat(64);
  writeFileSync(
    win32.join(directory, `${authorizationId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      type: "mkttool.compatibility-smoke-authorization",
      authorizationId,
      sequence: 7,
      manifestDigest,
      profileId: "profile-smoke",
      ...time,
    }),
  );
  writeFileSync(
    win32.join(updateRoot, "activation-marker.json"),
    JSON.stringify({ schemaVersion: 1, sequence: 7, manifestDigest, phase }),
  );
  return { localAppData };
}
