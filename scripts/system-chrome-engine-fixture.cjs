const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { createReadStream, existsSync } = require("node:fs");
const { mkdir, symlink, unlink, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function locateSystemChrome() {
  const candidates = [
    process.env.MKT_BROWSER_SYSTEM_CHROME,
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);

  const chromeExecutable = candidates.find((candidate) => existsSync(candidate));
  if (!chromeExecutable) {
    throw new Error(
      "Packaged verification requires Google Chrome. Install Chrome or set MKT_BROWSER_SYSTEM_CHROME.",
    );
  }
  return path.resolve(chromeExecutable);
}

async function installSystemChromeEngineFixture(userData) {
  const chromeExecutable = locateSystemChrome();
  const evidence = await inspectChromeEvidence(chromeExecutable);
  const cacheDir = path.join(userData, "chromium", "cloakbrowser");
  const version = "system-chrome";
  const junctionPath = path.join(cacheDir, "runtime");

  await mkdir(cacheDir, { recursive: true });
  try {
    // Link the complete Application directory so chrome.exe can resolve its DLLs and resources.
    await symlink(path.dirname(chromeExecutable), junctionPath, "junction");
    await writeFile(
      path.join(cacheDir, "current.json"),
      JSON.stringify(
        {
          version,
          binaryRelative: path.join("runtime", "chrome.exe"),
          installedAt: new Date().toISOString(),
          channel: "System Chrome verifier fixture",
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      path.join(userData, "settings.json"),
      JSON.stringify(
        {
          theme: "dark",
          mcpHttpEnabled: true,
          browserEngine: "cloakbrowser",
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (error) {
    if (existsSync(junctionPath)) await unlink(junctionPath);
    throw error;
  }

  return { chromeExecutable, junctionPath, ...evidence };
}

async function removeSystemChromeEngineFixture(fixture) {
  if (existsSync(fixture.junctionPath)) await unlink(fixture.junctionPath);
  if (!existsSync(fixture.chromeExecutable)) {
    throw new Error("System Chrome disappeared while removing the packaged verifier fixture.");
  }
}

async function inspectChromeEvidence(chromeExecutable) {
  const [{ stdout }, sha256] = await Promise.all([
    execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$item = Get-Item -LiteralPath $env:MKT_BROWSER_CHROME_EVIDENCE_PATH; [Console]::Out.Write([string]$item.VersionInfo.ProductVersion)",
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        env: { ...process.env, MKT_BROWSER_CHROME_EVIDENCE_PATH: chromeExecutable },
      },
    ),
    sha256File(chromeExecutable),
  ]);
  const version = stdout
    .trim()
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, 120);
  if (!version) throw new Error("System Chrome returned an empty version string.");
  return { version, sha256 };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  await once(stream, "end");
  return hash.digest("hex");
}

module.exports = {
  installSystemChromeEngineFixture,
  locateSystemChrome,
  removeSystemChromeEngineFixture,
};
