import assert from "node:assert/strict";
import test from "node:test";
import { ActivityLog } from "./ActivityLog.js";
import { sanitizedProxySummary } from "./server.js";

test("activity diagnostics never retain proxy endpoints, credentials, cookies, or page text", () => {
  const log = new ActivityLog();
  log.startCall("create_profile", {
    text: "secret page content",
    proxy: {
      type: "http",
      host: "proxy.example",
      port: 8080,
      username: "operator",
      password: "secret",
    },
    cookies: [{ name: "session", value: "cookie-secret", domain: "example.com" }],
  });

  const serialized = JSON.stringify(log.recent());
  for (const secret of [
    "secret page content",
    "proxy.example",
    "8080",
    "operator",
    "secret",
    "cookie-secret",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("MCP profile responses never expose proxy endpoints or credentials", () => {
  const summary = sanitizedProxySummary({
    type: "socks5",
    host: "proxy.example.internal",
    port: 1080,
    username: "operator",
    password: "secret",
  });

  assert.deepEqual(summary, { type: "socks5", configured: true, hasAuth: true });
  assert.doesNotMatch(JSON.stringify(summary), /proxy\.example|1080|operator|secret/);
});
