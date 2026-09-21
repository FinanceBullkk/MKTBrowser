const WINDOWS_BROWSER_ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "windir",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "PUBLIC",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PSModulePath",
] as const;

const LINUX_DESKTOP_ENV_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

/**
 * Keep Electron/Node markers out of the engine while preserving the native platform environment
 * that Chromium and the licensed runtime need during startup and graceful shutdown.
 */
export function buildBrowserLaunchEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === "win32") {
    return pickEnvironment(source, WINDOWS_BROWSER_ENV_KEYS);
  }

  const environment: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: source.HOME ?? "",
    USER: source.USER ?? "",
    LOGNAME: source.LOGNAME ?? source.USER ?? "",
    SHELL: source.SHELL ?? "/bin/sh",
    LANG: source.LANG ?? "en_US.UTF-8",
    LC_ALL: source.LC_ALL ?? "",
    TMPDIR: source.TMPDIR ?? "/tmp",
  };

  if (platform === "darwin" && source.DYLD_FALLBACK_FRAMEWORK_PATH !== undefined) {
    environment.DYLD_FALLBACK_FRAMEWORK_PATH = source.DYLD_FALLBACK_FRAMEWORK_PATH;
  }
  if (platform === "linux") {
    Object.assign(environment, pickEnvironment(source, LINUX_DESKTOP_ENV_KEYS));
  }
  return environment;
}

function pickEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  keys: readonly string[],
): NodeJS.ProcessEnv {
  const entries = new Map(
    Object.entries(source).map(([key, value]) => [key.toLocaleLowerCase("en-US"), value]),
  );
  const selected: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = entries.get(key.toLocaleLowerCase("en-US"));
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}
