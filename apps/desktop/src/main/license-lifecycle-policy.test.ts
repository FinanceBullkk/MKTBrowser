import assert from "node:assert/strict";
import test from "node:test";
import {
  FAST_LICENSE_REUSE_ENV,
  fastLicenseReuseEnabled,
  shouldDetachBrowserProcess,
  shouldUseCloakBrowserSdkLifecycle,
} from "./license-lifecycle-policy.ts";

test("fast sequential reuse is enabled by default and has a conservative rollback switch", () => {
  assert.equal(fastLicenseReuseEnabled({}), true);
  for (const value of ["0", "false", "off"]) {
    assert.equal(fastLicenseReuseEnabled({ [FAST_LICENSE_REUSE_ENV]: value }), false);
  }
  assert.equal(fastLicenseReuseEnabled({ [FAST_LICENSE_REUSE_ENV]: "unexpected" }), false);
});

test("only the enabled Windows Cloak lifecycle follows the proven attached-process path", () => {
  assert.equal(shouldDetachBrowserProcess("cloakbrowser", true, "win32"), false);
  assert.equal(shouldDetachBrowserProcess("cloakbrowser", false, "win32"), true);
  assert.equal(shouldDetachBrowserProcess("cft", true, "win32"), true);
  assert.equal(shouldDetachBrowserProcess("cloakbrowser", true, "darwin"), true);
  assert.equal(shouldDetachBrowserProcess("cloakbrowser", true, "linux"), true);
});

test("only the enabled Windows Cloak lifecycle uses the official SDK adapter", () => {
  assert.equal(shouldUseCloakBrowserSdkLifecycle("cloakbrowser", true, "win32"), true);
  assert.equal(shouldUseCloakBrowserSdkLifecycle("cloakbrowser", false, "win32"), false);
  assert.equal(shouldUseCloakBrowserSdkLifecycle("cft", true, "win32"), false);
  assert.equal(shouldUseCloakBrowserSdkLifecycle("cloakbrowser", true, "darwin"), false);
  assert.equal(shouldUseCloakBrowserSdkLifecycle("cloakbrowser", true, "linux"), false);
});
