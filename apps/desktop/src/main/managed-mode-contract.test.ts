import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MKT_BROWSER_CAPABILITIES,
  MKT_BROWSER_PROFILE_SCHEMA_VERSION,
} from "../../../../packages/types/src/index.ts";

const REPO_ROOT = new URL("../../../../", import.meta.url);

test("advertises only the implemented MKB-02 create capability", () => {
  assert.equal(MKT_BROWSER_PROFILE_SCHEMA_VERSION, 2);
  assert.equal(MKT_BROWSER_CAPABILITIES.includes("idempotent-create-v1"), true);
  for (const pending of ["managed-profile-v1", "atomic-launch-v1"]) {
    assert.equal((MKT_BROWSER_CAPABILITIES as readonly string[]).includes(pending), false, pending);
  }
});

test("keeps managed create paired, deterministic, and conflict-safe", () => {
  const server = source("packages/mcp-server/src/server.ts");
  assert.match(server, /external_ref and request_id must be provided together/);
  assert.match(server, /Managed profile creation requires a deterministic seed/);
  assert.match(server, /profileManager\.createIdempotent/);
  assert.match(server, /managedCreateRequestHash/);
  assert.match(server, /created: result\.created/);

  const manager = source("packages/profile-manager/src/ProfileManager.ts");
  assert.match(manager, /CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_external_ref/);
  assert.match(manager, /CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_create_request_id/);
  assert.match(manager, /IdempotentProfileCreateConflictError/);
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}
