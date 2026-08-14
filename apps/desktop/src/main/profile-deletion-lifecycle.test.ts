import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deleteBrowserProfile } from "./profile-deletion-lifecycle.ts";
import { profileDeletionConfirmation } from "../shared/profile-deletion-contract.ts";

const profile = {
  id: "profile-1",
  name: "Managed operator profile",
  managed: true,
  deletionPending: false,
};
const REPO_ROOT = new URL("../../../../", import.meta.url);

test("requires the exact typed confirmation and refuses active lifecycle work", () => {
  let deleted = false;
  const deps = {
    profileManager: {
      get: () => profile as never,
      deletePermanently: () => {
        deleted = true;
      },
    },
    browserDriver: { isRunning: () => false },
  };

  assert.throws(
    () => deleteBrowserProfile({ profileId: profile.id, confirmation: "DELETE profile" }, deps),
    /does not match/,
  );
  assert.equal(deleted, false);
  assert.throws(
    () =>
      deleteBrowserProfile(
        { profileId: profile.id, confirmation: profileDeletionConfirmation(profile.id) },
        { ...deps, browserDriver: { isRunning: () => true } },
      ),
    /wait for Chromium to exit/,
  );
  assert.equal(deleted, false);
});

test("allows a managed profile only after the Browser confirmation boundary", () => {
  let deletedId: string | null = null;
  deleteBrowserProfile(
    { profileId: profile.id, confirmation: profileDeletionConfirmation(profile.id) },
    {
      profileManager: {
        get: () => profile as never,
        deletePermanently: (id) => {
          deletedId = id;
        },
      },
      browserDriver: { isRunning: () => false },
    },
  );
  assert.equal(deletedId, profile.id);
});

test("keeps permanent deletion inside the Browser UI and out of MCP", () => {
  const dialog = source("apps/desktop/src/renderer/src/components/profile/DeleteProfileDialog.tsx");
  const main = source("apps/desktop/src/main/index.ts");
  const server = source("packages/mcp-server/src/server.ts");
  assert.match(dialog, /profileDeletionConfirmation/);
  assert.match(dialog, /Cookies, login sessions, browsing state/);
  assert.match(dialog, /MultiZen data are not/);
  assert.match(main, /PROFILES_DELETE_PERMANENTLY/);
  assert.doesNotMatch(server, /name: "delete_profile"|case "delete_profile"/);
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}
