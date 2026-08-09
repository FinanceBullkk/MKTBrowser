const { access } = require("node:fs/promises");
const { join } = require("node:path");

const PRODUCT_NAME = "MKT Browser";
const EXECUTABLE_NAME = "MKTBrowser.exe";

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

  await rcedit(executablePath, {
    "file-version": version,
    "product-version": version,
    "version-string": {
      CompanyName: "MKTTool",
      FileDescription: PRODUCT_NAME,
      InternalName: "MKTBrowser",
      LegalCopyright: "",
      OriginalFilename: EXECUTABLE_NAME,
      ProductName: PRODUCT_NAME,
    },
  });
};
