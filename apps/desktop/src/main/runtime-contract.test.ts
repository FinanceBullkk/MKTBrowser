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
  assert.equal(MKT_BROWSER_CONTRACT_VERSION, 3);
  assert.equal(MKT_BROWSER_PROFILE_SCHEMA_VERSION, 2);
  assert.deepEqual(
    [...MKT_BROWSER_CAPABILITIES],
    [
      "profile-contract-v1",
      "runtime-info-v1",
      "idempotent-create-v1",
      "atomic-launch-v1",
      "managed-profile-v1",
      "operation-diagnostics-v1",
    ],
  );
});

test("keeps every failing layer separately addressable", () => {
  for (const code of [
    "INVALID_INPUT",
    "FORBIDDEN",
    "PROFILE_NOT_FOUND",
    "PROFILE_NOT_RUNNING",
    "PROFILE_ALREADY_RUNNING",
    "PROXY_REJECTED",
    "ENGINE_UNAVAILABLE",
    "UNKNOWN_TOOL",
    "MANAGED_PROFILE_LOCKED",
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
      engine: "cft",
      attempt: 1,
      maxAttempts: 5,
      resuming: false,
    }),
    { kind: "cft", version: "148.0.0.0", status: "downloading" },
  );

  for (const status of [
    { kind: "missing" } as const,
    { kind: "fetching-manifest" } as const,
    { kind: "error", engine: "cft", message: "checksum mismatch" } as const,
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
  assert.match(server, /const code = toErrorCode\(e\)/);
  assert.match(server, /return err\(/);
  assert.equal(server.includes("throw new Error(`Profile"), false);
  assert.equal(server.includes("throw new Error(`Unknown tool"), false);

  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");
  assert.match(driver, /throw engineUnavailable\(/);
  assert.match(driver, /throw proxyRejected\(/);
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}
