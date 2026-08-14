import type { ProfileManager } from "@mktbrowser/profile-manager";
import type { ProfileId } from "@mktbrowser/types";
import { profileDeletionConfirmation } from "../shared/profile-deletion-contract.ts";

interface ProfileDeletionBrowserDriver {
  isRunning(profileId: ProfileId): boolean;
}

export interface BrowserProfileDeletionInput {
  profileId: ProfileId;
  confirmation: string;
}

export function deleteBrowserProfile(
  input: BrowserProfileDeletionInput,
  deps: {
    profileManager: Pick<ProfileManager, "get" | "deletePermanently">;
    browserDriver: ProfileDeletionBrowserDriver;
  },
): void {
  const profile = deps.profileManager.get(input.profileId);
  if (!profile) throw new Error(`Profile ${input.profileId} not found.`);
  if (input.confirmation !== profileDeletionConfirmation(profile.id)) {
    throw new Error("The typed profile-deletion confirmation does not match this profile.");
  }
  if (deps.browserDriver.isRunning(profile.id)) {
    throw new Error("Close this profile and wait for Chromium to exit before deleting it.");
  }
  deps.profileManager.deletePermanently(profile.id);
}
