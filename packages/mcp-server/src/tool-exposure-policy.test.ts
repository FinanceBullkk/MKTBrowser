import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL_LOCAL_ACCESS_POLICY,
  MCP_TOOL_EXPOSURE,
  PROFILE_MANAGEMENT_ACCESS_POLICY,
  isMcpToolAllowed,
} from "./tool-exposure-policy.js";
import { buildMcpInstructions } from "./server.js";

test("profile-management token hides and rejects every page, cookie, and raw-CDP tool", () => {
  assert.equal(Object.hasOwn(MCP_TOOL_EXPOSURE, "delete_profile"), false);
  for (const [name, capability] of Object.entries(MCP_TOOL_EXPOSURE)) {
    const expected = ![
      "page-control",
      "page-read",
      "cookie-read",
      "cookie-write",
      "raw-cdp",
    ].includes(capability);
    assert.equal(isMcpToolAllowed(name, PROFILE_MANAGEMENT_ACCESS_POLICY), expected, name);
  }
  assert.equal(
    isMcpToolAllowed("future_unclassified_tool", PROFILE_MANAGEMENT_ACCESS_POLICY),
    false,
  );
});

test("initialize instructions describe the authenticated token capabilities", () => {
  const profileManagement = buildMcpInstructions(PROFILE_MANAGEMENT_ACCESS_POLICY);
  assert.match(profileManagement, /profile-management only/);
  assert.match(profileManagement, /cannot navigate, click, type, read pages/);
  assert.doesNotMatch(profileManagement, /Use extract to read the page/);

  const fullLocal = buildMcpInstructions(FULL_LOCAL_ACCESS_POLICY);
  assert.match(fullLocal, /Use extract to read the page/);
  assert.doesNotMatch(fullLocal, /profile-management only/);
});
