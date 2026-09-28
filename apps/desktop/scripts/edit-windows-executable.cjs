const { access } = require("node:fs/promises");
const { join } = require("node:path");

const PRODUCT_NAME = "MKT Browser";
const EXECUTABLE_NAME = "MKTBrowser.exe";
const LEGAL_COPYRIGHT = "Copyright (c) 2023 oboshto and MKTTool contributors";
const TRANSIENT_COMMIT_ERROR = "Unable to commit changes";
const RETRY_DELAYS_MS = [250, 500, 1000];

function windowsVersionInfo(version) {
  return {
    "file-version": version,
    "product-version": version,
    "version-string": {
      CompanyName: "MKTTool",
      FileDescription: PRODUCT_NAME,
      InternalName: "MKTBrowser",
      LegalCopyright: LEGAL_COPYRIGHT,
      OriginalFilename: EXECUTABLE_NAME,
      ProductName: PRODUCT_NAME,
    },
  };
}

function isTransientCommitError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(TRANSIENT_COMMIT_ERROR);
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function runRceditWithRetry(
  editExecutable,
  executablePath,
  options,
  { retryDelaysMs = RETRY_DELAYS_MS, sleep = wait, warn = console.warn } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await editExecutable(executablePath, options);
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (!isTransientCommitError(error) || retryDelayMs === undefined) {
        throw error;
      }

      warn(
        `[edit-windows-executable] rcedit could not commit PE changes; retrying in ${retryDelayMs}ms ` +
          `(attempt ${attempt + 2}/${retryDelaysMs.length + 1}).`,
      );
      await sleep(retryDelayMs);
    }
  }
}

/**
 * Apply Windows VersionInfo after electron-builder creates the directory
 * package. Signing stays disabled in W01; this hook edits identity resources
 * only and runs before any future installer target consumes the executable.
 */
module.exports = async function editWindowsExecutable(context) {
  if (context.electronPlatformName !== "win32") return;

  const executablePath = join(context.appOutDir, EXECUTABLE_NAME);
  await access(executablePath);

  const { rcedit } = await import("rcedit");
  const version = context.packager.appInfo.version;

  await runRceditWithRetry(rcedit, executablePath, windowsVersionInfo(version));
};

module.exports.isTransientCommitError = isTransientCommitError;
module.exports.runRceditWithRetry = runRceditWithRetry;
module.exports.windowsVersionInfo = windowsVersionInfo;
