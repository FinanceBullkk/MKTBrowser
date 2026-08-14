const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");

const desktopRoot = path.resolve(__dirname, "..");
const firewallScriptPath = path.join(desktopRoot, "build", "windows-webrtc-firewall.ps1");
const generatedDirectory = path.join(desktopRoot, ".installer-generated");
const generatedIncludePath = path.join(
  generatedDirectory,
  "windows-webrtc-firewall-commands.nsh",
);

function buildEncodedFirewallCommands(script) {
  const payload = gzipSync(Buffer.from(script, "utf8")).toString("base64");
  return {
    checkProfiles: encodeWrapper(payload, "CheckProfiles"),
    install: encodeWrapper(payload, "Install"),
    uninstall: encodeWrapper(payload, "Uninstall"),
    verify: encodeWrapper(payload, "Verify"),
    verifyAbsent: encodeWrapper(payload, "VerifyAbsent"),
  };
}

function encodeWrapper(payload, mode) {
  const requiresPaths = mode === "Install" || mode === "Verify";
  const invoke = requiresPaths
    ? "$root=[Environment]::GetFolderPath('LocalApplicationData');" +
      `& ([ScriptBlock]::Create($s)) -Mode ${mode} ` +
      "-CftPath ([IO.Path]::Combine($root,'MKTTool','MKTBrowser','chromium','cft','runtime','chrome.exe')) " +
      "-CloakBrowserPath ([IO.Path]::Combine($root,'MKTTool','MKTBrowser','chromium','cloakbrowser','runtime','chrome.exe'));" +
      "exit $LASTEXITCODE"
    : `& ([ScriptBlock]::Create($s)) -Mode ${mode};exit $LASTEXITCODE`;
  const wrapper =
    `$z='${payload}';` +
    "$m=New-Object IO.MemoryStream(,[Convert]::FromBase64String($z));" +
    "$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress);" +
    "$r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8);" +
    "$s=$r.ReadToEnd();" +
    invoke;
  return Buffer.from(wrapper, "utf16le").toString("base64");
}

function generateWindowsFirewallCommands() {
  const commands = buildEncodedFirewallCommands(readFileSync(firewallScriptPath, "utf8"));
  mkdirSync(generatedDirectory, { recursive: true });
  writeFileSync(
    generatedIncludePath,
    [
      `!define MKT_BROWSER_FIREWALL_CHECK_PROFILES_COMMAND "${commands.checkProfiles}"`,
      `!define MKT_BROWSER_FIREWALL_INSTALL_COMMAND "${commands.install}"`,
      `!define MKT_BROWSER_FIREWALL_UNINSTALL_COMMAND "${commands.uninstall}"`,
      `!define MKT_BROWSER_FIREWALL_VERIFY_COMMAND "${commands.verify}"`,
      `!define MKT_BROWSER_FIREWALL_VERIFY_ABSENT_COMMAND "${commands.verifyAbsent}"`,
      "",
    ].join("\n"),
    "ascii",
  );
  return generatedIncludePath;
}

if (require.main === module) generateWindowsFirewallCommands();

module.exports = { buildEncodedFirewallCommands, generateWindowsFirewallCommands };
