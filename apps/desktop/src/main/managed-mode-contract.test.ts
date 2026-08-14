import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MKT_BROWSER_CAPABILITIES,
  MKT_BROWSER_PROFILE_SCHEMA_VERSION,
} from "../../../../packages/types/src/index.ts";

const REPO_ROOT = new URL("../../../../", import.meta.url);

test("advertises the completed MKB-02 managed-mode capabilities", () => {
  assert.equal(MKT_BROWSER_PROFILE_SCHEMA_VERSION, 3);
  assert.equal(MKT_BROWSER_CAPABILITIES.includes("idempotent-create-v1"), true);
  assert.equal(MKT_BROWSER_CAPABILITIES.includes("atomic-launch-v1"), true);
  for (const implemented of ["managed-profile-v1", "operation-diagnostics-v1"]) {
    assert.equal(
      (MKT_BROWSER_CAPABILITIES as readonly string[]).includes(implemented),
      true,
      implemented,
    );
  }
});

test("keeps managed launch atomic and aware of the active proxy", () => {
  const server = source("packages/mcp-server/src/server.ts");
  assert.match(server, /case "launch_managed_profile"/);
  assert.match(server, /launchManagedProfile/);

  const managedLaunch = source("packages/mcp-server/src/managed-profile-launch.ts");
  assert.match(managedLaunch, /getRunningProfileState/);
  assert.match(managedLaunch, /PROFILE_ALREADY_RUNNING|profileAlreadyRunning/);
  assert.match(managedLaunch, /profileManager\.updateManagedProxy/);
  assert.match(managedLaunch, /profileManager\.get/);
  assert.match(managedLaunch, /browserDriver\.launch/);
});

test("locks ordinary managed-profile controls and carries operation diagnostics", () => {
  const server = source("packages/mcp-server/src/server.ts");
  const manager = source("packages/profile-manager/src/ProfileManager.ts");
  const main = source("apps/desktop/src/main/index.ts");

  assert.match(server, /managedProfileLocked/);
  assert.match(manager, /ManagedProfileLockedError/);
  assert.match(main, /Managed profile .* can be launched only through MKTTool/);
  assert.match(server, /operation_id/);
  assert.match(server, /operationDiagnostic/);
  assert.match(server, /durationMs/);
});

test("keeps managed create paired, deterministic, and conflict-safe", () => {
  const server = source("packages/mcp-server/src/server.ts");
  assert.match(server, /external_ref and request_id must be provided together/);
  assert.match(server, /Managed profile creation requires a deterministic seed/);
  assert.match(server, /profileManager\.createIdempotent/);
  assert.match(server, /managedCreateRequestHash/);
  assert.match(server, /operation_id: _operationId/);
  assert.match(server, /created: result\.created/);

  const manager = source("packages/profile-manager/src/ProfileManager.ts");
  assert.match(manager, /CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_external_ref/);
  assert.match(manager, /CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_create_request_id/);
  assert.match(manager, /IdempotentProfileCreateConflictError/);
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}
