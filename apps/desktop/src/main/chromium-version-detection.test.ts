import assert from "node:assert/strict";
import test from "node:test";
import type { FingerprintConfig } from "@mktbrowser/types";
import {
  parseChromiumVersion,
  reconcileVersionInFingerprint,
} from "./chromium-version-detection.ts";

test("parses the Chromium portion of a vendor-patch version", () => {
  assert.deepEqual(parseChromiumVersion("151.0.7922.108.6"), {
    major: 151,
    full: "151.0.7922.108",
  });
});

test("returns null for a string without a four-part Chromium version", () => {
  assert.equal(parseChromiumVersion("not-a-version"), null);
  assert.equal(parseChromiumVersion(""), null);
});

test("rewrites the version-bearing fingerprint fields to the actual engine version", () => {
  const fp = {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7390.42 Safari/537.36",
    clientHints: {
      secChUa: '"Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"',
      secChUaFullVersionList:
        '"Chromium";v="148.0.7390.42", "Google Chrome";v="148.0.7390.42", "Not?A_Brand";v="99.0.0.0"',
    },
  } as FingerprintConfig;
  const reconciled = reconcileVersionInFingerprint(fp, { major: 151, full: "151.0.7922.108" });
  assert.match(reconciled.userAgent, /Chrome\/151\.0\.7922\.108/);
  assert.equal(
    reconciled.clientHints?.secChUa,
    '"Chromium";v="151", "Google Chrome";v="151", "Not?A_Brand";v="99"',
  );
  assert.match(
    reconciled.clientHints?.secChUaFullVersionList ?? "",
    /"Google Chrome";v="151\.0\.7922\.108"/,
  );
});
