import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MKT_BROWSER_CAPABILITIES,
  MKT_BROWSER_CONTRACT_VERSION,
  MKT_BROWSER_ERROR_CODES,
  MKT_BROWSER_PROFILE_SCHEMA_VERSION,
} from "../../../../packages/types/src/index.ts";
import { describeEngineStatus } from "./engine-runtime-info.ts";

const REPO_ROOT = new URL("../../../../", import.meta.url);

test("publishes a versioned runtime contract", () => {
  assert.equal(MKT_BROWSER_CONTRACT_VERSION, 1);
  assert.equal(MKT_BROWSER_PROFILE_SCHEMA_VERSION, 2);
  assert.deepEqual([...MKT_BROWSER_CAPABILITIES], [
    "profile-contract-v1",
    "runtime-info-v1",
    "idempotent-create-v1",
  ]);
});

test("never advertises a capability this build has not implemented", () => {
  // Managed mode is MKB-02. Advertising it early would make the Relay choose a call path that
  // does not exist, and the failure would surface as a launch error on a real account.
  for (const unimplemented of ["managed-profile-v1", "atomic-launch-v1"]) {
    assert.equal(
      (MKT_BROWSER_CAPABILITIES as readonly string[]).includes(unimplemented),
      false,
      `${unimplemented} is advertised but not implemented`,
    );
  }
});

test("keeps every failing layer separately addressable", () => {
  for (const code of [
    "INVALID_INPUT",
    "FORBIDDEN",
    "PROFILE_NOT_FOUND",
    "PROFILE_NOT_RUNNING",
    "PROXY_REJECTED",
    "ENGINE_UNAVAILABLE",
    "UNKNOWN_TOOL",
    "INTERNAL_ERROR",
  ]) {
    assert.equal((MKT_BROWSER_ERROR_CODES as readonly string[]).includes(code), true, code);
  }
});

test("reports an engine version only when one is actually installed", () => {
  assert.deepEqual(
    describeEngineStatus("cloakbrowser", {
      kind: "ready",
      version: "145.0.0.0",
      binaryPath: "C:/engine/chrome.exe",
    }),
    { kind: "cloakbrowser", version: "145.0.0.0", status: "ready" },
  );

  // A stage that knows its target version still reports it, so a caller can distinguish "preparing
  // the approved version" from "preparing something unexpected".
  assert.deepEqual(
    describeEngineStatus("cft", {
      kind: "downloading",
      bytesReceived: 1,
      bytesTotal: 2,
      version: "148.0.0.0",
    }),
    { kind: "cft", version: "148.0.0.0", status: "downloading" },
  );

  for (const status of [
    { kind: "missing" } as const,
    { kind: "fetching-manifest" } as const,
    { kind: "error", message: "checksum mismatch" } as const,
    { kind: "dev-system", binaryPath: "C:/chrome.exe" } as const,
  ]) {
    const described = describeEngineStatus("cft", status);
    assert.equal(described.version, null, status.kind);
    assert.equal(described.status, status.kind);
  }
});

test("exposes get_runtime_info and classifies failures by code, not by message", () => {
  const server = source("packages/mcp-server/src/server.ts");
  assert.match(server, /name: "get_runtime_info"/);
  assert.match(server, /case "get_runtime_info"/);
  // The dispatch catch must derive the code from the taxonomy; a hand-written ternary chain is how
  // an unclassified failure silently becomes INTERNAL_ERROR again.
  assert.match(server, /return err\(toErrorCode\(e\), message\)/);
  assert.equal(server.includes('throw new Error(`Profile'), false);
  assert.equal(server.includes("throw new Error(`Unknown tool"), false);

  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");
  assert.match(driver, /throw engineUnavailable\(/);
  assert.match(driver, /throw proxyRejected\(/);
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}
