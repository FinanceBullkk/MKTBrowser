import type { ProfileManager } from "@mktbrowser/profile-manager";
import type { LaunchedProfile, ProfileId, ProxyConfig } from "@mktbrowser/types";
import {
  profileAlreadyRunning,
  profileNotFound,
  proxyRejected,
} from "./mkt-browser-tool-errors.js";

export interface RunningProfileState {
  proxy?: ProxyConfig;
}

export interface ManagedLaunchBrowserDriver {
  launch(profileId: ProfileId): Promise<LaunchedProfile>;
  getRunningProfileState(profileId: ProfileId): RunningProfileState | null;
}

interface ManagedProfileLaunchDeps {
  profileManager: Pick<ProfileManager, "get" | "updateManagedProxy">;
  browserDriver: ManagedLaunchBrowserDriver;
}

const profileLaunchLocks = new Map<ProfileId, Promise<void>>();

export async function launchManagedProfile(
  profileId: ProfileId,
  proxy: ProxyConfig,
  deps: ManagedProfileLaunchDeps,
): Promise<LaunchedProfile> {
  return withProfileLaunchLock(profileId, () =>
    launchManagedProfileUnlocked(profileId, proxy, deps),
  );
}

async function launchManagedProfileUnlocked(
  profileId: ProfileId,
  proxy: ProxyConfig,
  deps: ManagedProfileLaunchDeps,
): Promise<LaunchedProfile> {
  const existing = deps.profileManager.get(profileId);
  if (!existing) throw profileNotFound(profileId);

  const running = deps.browserDriver.getRunningProfileState(profileId);
  if (running && !proxyConfigsEqual(running.proxy, proxy)) {
    throw profileAlreadyRunning(profileId);
  }

  if (!proxyConfigsEqual(existing.proxy, proxy)) {
    try {
      deps.profileManager.updateManagedProxy(profileId, proxy);
    } catch (cause) {
      throw proxyRejected(
        `The proxy configuration for profile ${profileId} could not be stored; the profile was not launched.`,
        { cause },
      );
    }
  }

  const persisted = deps.profileManager.get(profileId);
  if (!persisted || !proxyConfigsEqual(persisted.proxy, proxy)) {
    throw proxyRejected(
      `The proxy configuration for profile ${profileId} could not be verified; the profile was not launched.`,
    );
  }

  return deps.browserDriver.launch(profileId);
}

async function withProfileLaunchLock<T>(
  profileId: ProfileId,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = profileLaunchLocks.get(profileId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  profileLaunchLocks.set(profileId, queued);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (profileLaunchLocks.get(profileId) === queued) profileLaunchLocks.delete(profileId);
  }
}

export function proxyConfigsEqual(
  left: ProxyConfig | null | undefined,
  right: ProxyConfig | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return (
    left.type === right.type &&
    left.host === right.host &&
    left.port === right.port &&
    left.username === right.username &&
    left.password === right.password
  );
}
