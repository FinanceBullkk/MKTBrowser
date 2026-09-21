import assert from "node:assert/strict";
import test from "node:test";
import {
  parseChromiumVersion,
  resolveChromiumVersionForLaunch,
} from "./chromium-version-detection.ts";

test("uses the verified CloakBrowser version without executing the licensed binary", async () => {
  let probes = 0;
  const version = await resolveChromiumVersionForLaunch(
    {
      engine: "cloakbrowser",
      binaryPath: "C:\\engine\\chrome.exe",
      verifiedVersion: "151.0.7922.108.6",
    },
    async () => {
      probes += 1;
      return null;
    },
  );

  assert.deepEqual(version, { major: 151, full: "151.0.7922.108" });
  assert.equal(probes, 0);
});

test("does not fall back to a licensed binary probe when verified metadata is unavailable", async () => {
  let probes = 0;
  const version = await resolveChromiumVersionForLaunch(
    {
      engine: "cloakbrowser",
      binaryPath: "C:\\engine\\chrome.exe",
      verifiedVersion: null,
    },
    async () => {
      probes += 1;
      return { major: 151, full: "151.0.7922.108" };
    },
  );

  assert.equal(version, null);
  assert.equal(probes, 0);
});

test("keeps probing the unlicensed CFT binary", async () => {
  const version = await resolveChromiumVersionForLaunch(
    {
      engine: "cft",
      binaryPath: "C:\\engine\\chrome.exe",
      verifiedVersion: "153.0.8010.50",
    },
    async (binaryPath) => {
      assert.equal(binaryPath, "C:\\engine\\chrome.exe");
      return { major: 153, full: "153.0.8010.50" };
    },
  );

  assert.deepEqual(version, { major: 153, full: "153.0.8010.50" });
});

test("parses the Chromium portion of a vendor-patch version", () => {
  assert.deepEqual(parseChromiumVersion("151.0.7922.108.6"), {
    major: 151,
    full: "151.0.7922.108",
  });
});
