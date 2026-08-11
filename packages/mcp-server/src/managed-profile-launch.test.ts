import assert from "node:assert/strict";
import test from "node:test";
import type { Profile, ProxyConfig } from "@mktbrowser/types";
import { MktBrowserToolError } from "./mkt-browser-tool-errors.js";
import { launchManagedProfile, type RunningProfileState } from "./managed-profile-launch.js";

const PROFILE_ID = "profile-1";
const EXPECTED_PROXY: ProxyConfig = {
  type: "http",
  host: "proxy.example",
  port: 8080,
  username: "operator",
  password: "secret",
};

test("persists and verifies the proxy before launching a closed profile", async () => {
  const fixture = createFixture();

  const launched = await launchManagedProfile(PROFILE_ID, EXPECTED_PROXY, fixture.deps);

  assert.equal(fixture.updateCalls, 1);
  assert.equal(fixture.launchCalls, 1);
  assert.deepEqual(fixture.profile.proxy, EXPECTED_PROXY);
  assert.equal(launched.id, PROFILE_ID);
});

test("returns an already-running profile only when its active proxy matches", async () => {
  const fixture = createFixture({ storedProxy: EXPECTED_PROXY, runningProxy: EXPECTED_PROXY });

  await launchManagedProfile(PROFILE_ID, EXPECTED_PROXY, fixture.deps);

  assert.equal(fixture.updateCalls, 0);
  assert.equal(fixture.launchCalls, 1);
});

test("rejects a running profile whose active proxy differs without changing storage", async () => {
  const fixture = createFixture({
    storedProxy: EXPECTED_PROXY,
    runningProxy: { ...EXPECTED_PROXY, host: "other.example" },
  });

  const error = await launchManagedProfile(PROFILE_ID, EXPECTED_PROXY, fixture.deps).catch(
    (caught: unknown) => caught,
  );

  assert.ok(error instanceof MktBrowserToolError);
  assert.equal(error.code, "PROFILE_ALREADY_RUNNING");
  assert.equal(fixture.updateCalls, 0);
  assert.equal(fixture.launchCalls, 0);
});

test("fails closed when the persisted proxy cannot be read back", async () => {
  const fixture = createFixture({ discardUpdate: true });

  const error = await launchManagedProfile(PROFILE_ID, EXPECTED_PROXY, fixture.deps).catch(
    (caught: unknown) => caught,
  );

  assert.ok(error instanceof MktBrowserToolError);
  assert.equal(error.code, "PROXY_REJECTED");
  assert.equal(fixture.launchCalls, 0);
});

test("serializes concurrent launches so another proxy cannot replace the verified value", async () => {
  const otherProxy: ProxyConfig = { ...EXPECTED_PROXY, host: "other.example" };
  let profile = makeProfile();
  let runningProxy: ProxyConfig | undefined;
  let releaseFirstLaunch!: () => void;
  let firstLaunchStarted!: () => void;
  const firstLaunchGate = new Promise<void>((resolve) => {
    releaseFirstLaunch = resolve;
  });
  const firstLaunchSignal = new Promise<void>((resolve) => {
    firstLaunchStarted = resolve;
  });
  let launchCalls = 0;

  const deps = {
    profileManager: {
      get: () => profile,
      updateManagedProxy: (_profileId: string, proxy: ProxyConfig) => {
        profile = { ...profile, proxy };
        return profile;
      },
    },
    browserDriver: {
      getRunningProfileState: (): RunningProfileState | null =>
        runningProxy ? { proxy: runningProxy } : null,
      launch: async () => {
        launchCalls += 1;
        runningProxy = profile.proxy;
        if (launchCalls === 1) {
          firstLaunchStarted();
          await firstLaunchGate;
        }
        return {
          id: PROFILE_ID,
          cdpEndpoint: "http://127.0.0.1:9222",
          pid: 1,
          startedAt: "2026-08-12T00:00:00.000Z",
        };
      },
    },
  };

  const first = launchManagedProfile(PROFILE_ID, EXPECTED_PROXY, deps);
  await firstLaunchSignal;
  const second = launchManagedProfile(PROFILE_ID, otherProxy, deps).catch(
    (caught: unknown) => caught,
  );
  await Promise.resolve();

  assert.deepEqual(profile.proxy, EXPECTED_PROXY);
  assert.equal(launchCalls, 1);

  releaseFirstLaunch();
  await first;
  const secondError = await second;
  assert.ok(secondError instanceof MktBrowserToolError);
  assert.equal(secondError.code, "PROFILE_ALREADY_RUNNING");
  assert.deepEqual(profile.proxy, EXPECTED_PROXY);
  assert.equal(launchCalls, 1);
});

function createFixture(
  options: {
    storedProxy?: ProxyConfig;
    runningProxy?: ProxyConfig;
    discardUpdate?: boolean;
  } = {},
) {
  let profile = makeProfile(options.storedProxy);
  let updateCalls = 0;
  let launchCalls = 0;

  return {
    get profile() {
      return profile;
    },
    get updateCalls() {
      return updateCalls;
    },
    get launchCalls() {
      return launchCalls;
    },
    deps: {
      profileManager: {
        get: () => profile,
        updateManagedProxy: (_profileId: string, proxy: ProxyConfig) => {
          updateCalls += 1;
          if (!options.discardUpdate) {
            profile = { ...profile, proxy };
          }
          return profile;
        },
      },
      browserDriver: {
        getRunningProfileState: (): RunningProfileState | null =>
          options.runningProxy ? { proxy: options.runningProxy } : null,
        launch: async () => {
          launchCalls += 1;
          return {
            id: PROFILE_ID,
            cdpEndpoint: "http://127.0.0.1:9222",
            pid: 1,
            startedAt: "2026-08-12T00:00:00.000Z",
          };
        },
      },
    },
  };
}

function makeProfile(proxy?: ProxyConfig): Profile {
  return {
    id: PROFILE_ID,
    name: "Managed profile",
    tags: [],
    proxy,
    fingerprint: {} as Profile["fingerprint"],
    dataDir: "C:/profiles/profile-1",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    managed: true,
  };
}
