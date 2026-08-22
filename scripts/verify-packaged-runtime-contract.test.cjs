const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseOptions,
  sanitizeDiagnostics,
  withHttpDeadline,
} = require("./verify-packaged-runtime-contract.cjs");

test("parses bounded repeat and evidence output options", () => {
  const options = parseOptions([
    "--repeat",
    "5",
    "--timings-output",
    "timings.json",
    "--diagnostics-dir",
    "diagnostics",
    "--artifact-manifest",
    "artifact-manifest.json",
  ]);

  assert.equal(options.repeat, 5);
  assert.match(options.timingsOutput, /timings\.json$/);
  assert.match(options.diagnosticsDir, /diagnostics$/);
  assert.match(options.artifactManifest, /artifact-manifest\.json$/);
});

test("rejects invalid or unknown verifier options", () => {
  assert.throws(() => parseOptions(["--repeat", "0"]), /integer from 1 to 100/);
  assert.throws(() => parseOptions(["--repeat", "101"]), /integer from 1 to 100/);
  assert.throws(() => parseOptions(["--repeat"]), /Missing value/);
  assert.throws(() => parseOptions(["--unknown", "1"]), /Unknown/);
});

test("bounds an HTTP request even when the transport never settles", async () => {
  let signal;
  const startedAt = Date.now();

  await assert.rejects(
    withHttpDeadline(async (requestSignal) => {
      signal = requestSignal;
      await new Promise(() => {});
    }, 20),
    /timed out after 20ms/,
  );

  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - startedAt < 500, "hung request escaped the verifier deadline");
});

test("keeps a successful response readable after the request deadline is cleared", async () => {
  let signal;
  const body = await withHttpDeadline(async (requestSignal) => {
    signal = requestSignal;
    const response = {
      json: async () => {
        if (signal.aborted) throw new Error("response body was aborted before consumption");
        return { ok: true };
      },
    };
    return response.json();
  }, 100);

  assert.deepEqual(body, { ok: true });
  assert.equal(signal.aborted, false);
});

test("redacts paths, network identities, profile ids, and secret-like diagnostics", () => {
  const sanitized = sanitizeDiagnostics(
    [
      "path=C:\\Users\\operator\\profile",
      "ipv4=203.0.113.7 ipv6=2001:db8::7 bracketed=[2001:db8::8]",
      "profile=123e4567-e89b-12d3-a456-426614174000",
      "token=secret Authorization: Bearer bearer-secret",
      "proxy=http://operator:password@proxy.example:8080",
    ].join("\n"),
  );

  assert.doesNotMatch(
    sanitized,
    /operator|203\.0\.113\.7|2001:db8|123e4567|bearer-secret|password/,
  );
  assert.match(sanitized, /\[redacted-path\]|\[redacted-ip\]/);
});
