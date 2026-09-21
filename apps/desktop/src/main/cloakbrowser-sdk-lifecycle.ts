import type { BrowserContext, Page } from "playwright-core";
import type { LaunchPersistentContextOptions } from "cloakbrowser";
import { buildBrowserLaunchEnvironment } from "./browser-launch-environment.ts";
import {
  enumerateBrowserProcessesUsingDataDir,
  type BrowserProcessInfo,
} from "./browser-process-discovery.ts";
import { LICENCE_VERDICT_WINDOW_MS } from "./licence-verdict.ts";

const PLAYWRIGHT_IGNORED_DEFAULT_ARGS = [
  "--enable-automation",
  "--enable-unsafe-swiftshader",
  "about:blank",
] as const;

type LaunchPersistentContext = (
  options: LaunchPersistentContextOptions,
) => Promise<BrowserContext>;

export interface CloakBrowserSdkLaunchOptions {
  executablePath: string;
  browserDataDir: string;
  licenseKey: string;
  browserVersion: string;
  args: readonly string[];
  initialUrl?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
}

export interface CloakBrowserSdkLifecycle {
  context: BrowserContext;
  close(): Promise<void>;
  settleLicenceVerdict(spawnedAtMs: number): Promise<void>;
}

export interface CloakBrowserSdkLifecycleDependencies {
  launchPersistentContext?: LaunchPersistentContext;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CloakBrowserSdkProcessDiscoveryDependencies {
  enumerateProcesses?: (
    browserDataDir: string,
  ) => Promise<{ processes: BrowserProcessInfo[]; enumerated: boolean }>;
}

/**
 * Launch the pinned binary through the vendor-supported Playwright lifecycle while leaving profile,
 * proxy and native fingerprint arguments under MKT Browser control.
 */
export async function launchCloakBrowserSdkLifecycle(
  options: CloakBrowserSdkLaunchOptions,
  dependencies: CloakBrowserSdkLifecycleDependencies = {},
): Promise<CloakBrowserSdkLifecycle> {
  const launchPersistentContext =
    dependencies.launchPersistentContext ??
    (await import("cloakbrowser")).launchPersistentContext;
  const args = sdkCompatibleArgs(options.args);
  const priorBinaryPath = process.env.CLOAKBROWSER_BINARY_PATH;
  const hadBinaryPath = Object.hasOwn(process.env, "CLOAKBROWSER_BINARY_PATH");
  let context: BrowserContext;

  process.env.CLOAKBROWSER_BINARY_PATH = options.executablePath;
  try {
    context = await launchPersistentContext({
      userDataDir: options.browserDataDir,
      licenseKey: options.licenseKey,
      browserVersion: options.browserVersion,
      releaseChannel: "stable",
      headless: false,
      humanize: false,
      geoip: false,
      stealthArgs: false,
      viewport: null,
      args,
      launchOptions: {
        timeout: 30_000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        chromiumSandbox: !args.includes("--no-sandbox"),
        ignoreDefaultArgs: [...PLAYWRIGHT_IGNORED_DEFAULT_ARGS],
        env: buildBrowserLaunchEnvironment(options.environment, "win32"),
      },
    });
  } finally {
    if (hadBinaryPath) process.env.CLOAKBROWSER_BINARY_PATH = priorBinaryPath;
    else delete process.env.CLOAKBROWSER_BINARY_PATH;
  }

  let page: Page;
  try {
    page = context.pages()[0] ?? (await context.newPage());
    if (options.initialUrl) {
      await page.goto(options.initialUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    }
    // The SDK guard translates a post-handshake denial file into a licence error.
    await page.evaluate(() => true);
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  return {
    context,
    close: () => {
      closePromise ??= context.close();
      return closePromise;
    },
    settleLicenceVerdict: async (spawnedAtMs) => {
      const now = dependencies.now ?? Date.now;
      const sleep = dependencies.sleep ?? defaultSleep;
      const remainingMs = LICENCE_VERDICT_WINDOW_MS - (now() - spawnedAtMs);
      if (remainingMs > 0) await sleep(remainingMs);
      await page.evaluate(() => true);
    },
  };
}

export function sdkCompatibleArgs(args: readonly string[]): string[] {
  return args.filter(
    (arg) =>
      arg.startsWith("-") &&
      !arg.startsWith("--user-data-dir=") &&
      !arg.startsWith("--remote-debugging-pipe"),
  );
}

export function cloakBrowserSdkLicenseExitCode(error: unknown): number | null {
  const message = errorMessages(error).join("\n");
  const explicit = message.match(/(?:exitCode=|exit(?:ed)? with (?:exit )?code\s+)(76|77|78|79)\b/i);
  if (explicit) return Number(explicit[1]);
  if (/session limit reached/i.test(message)) return 76;
  if (/license key is invalid, expired, or missing/i.test(message)) return 77;
  if (/couldn't verify your license|license server unreachable/i.test(message)) return 78;
  if (/local configuration problem|\.cloakbrowser is not writable/i.test(message)) return 79;
  return null;
}

/** Resolve the SDK-owned primary process strictly from this profile's owned data directory. */
export async function discoverCloakBrowserSdkProcess(
  browserDataDir: string,
  dependencies: CloakBrowserSdkProcessDiscoveryDependencies = {},
): Promise<number> {
  const enumerateProcesses =
    dependencies.enumerateProcesses ?? enumerateBrowserProcessesUsingDataDir;
  const { processes, enumerated } = await enumerateProcesses(browserDataDir);
  if (!enumerated) {
    throw new Error("Could not inspect the SDK-owned CloakBrowser process");
  }
  const primary = processes.find(
    (candidate) => !/(?:^|\s)--type(?:=|\s)/.test(candidate.commandLine),
  );
  if (!primary) {
    throw new Error("The SDK did not leave an owned CloakBrowser primary process running");
  }
  return primary.pid;
}

function errorMessages(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const cause = error.cause;
  return [error.message, ...(cause === undefined ? [] : errorMessages(cause))];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
