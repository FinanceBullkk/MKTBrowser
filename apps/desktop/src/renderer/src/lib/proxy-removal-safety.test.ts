import assert from "node:assert/strict";
import test from "node:test";
import { shouldConfirmProxyRemoval } from "./proxyRemovalSafety.ts";

test("H37: removing an existing proxy requires confirmation", () => {
  assert.equal(
    shouldConfirmProxyRemoval({ type: "http", host: "proxy.example", port: 8080 }, false),
    true,
  );
});

test("H37: enabling a proxy or editing a direct profile does not require removal confirmation", () => {
  assert.equal(
    shouldConfirmProxyRemoval({ type: "http", host: "proxy.example", port: 8080 }, true),
    false,
  );
  assert.equal(shouldConfirmProxyRemoval(undefined, false), false);
});
