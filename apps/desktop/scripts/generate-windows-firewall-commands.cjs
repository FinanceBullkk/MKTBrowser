/**
 * Encodes the WebRTC containment script into the NSIS defines installer.nsh
 * runs. The script itself is kept terse because it travels on a command line;
 * the reasoning behind what it does lives here.
 *
 * ## Why the rule blocks all outbound UDP except 53 and 443
 *
 * WebRTC's STUN/TURN and its media streams sit on 3478 and on ephemeral high
 * ports, and stay blocked. Two ports are left open, each for its own reason.
 *
 * **53, because blocking it broke the browser.** Blocking every UDP port also
 * blocked DNS, and Chromium resolves names itself rather than calling the OS
 * resolver, so it could not look up its own licence host and exited reporting
 * the licence server as unreachable — on a machine whose network was fine,
 * with a key the server confirmed valid. The message sent the operator to
 * check their key and their connection, neither of which was wrong.
 *
 * Measured in order on 19 August 2026: all UDP blocked exits 78; the same rule
 * with `--disable-features=AsyncDns` exits 76, which is the licence server
 * answering through the OS resolver; the rule rebuilt with 53 open exits 76
 * with no flag at all. An earlier attempt that opened only 443 still exited
 * 78, which is what ruled QUIC out as the cause.
 *
 * **443, because never using it is itself a tell.** A real Chrome negotiates
 * HTTP/3 where it is offered, and one that never can is deviating from what it
 * claims to be — visible to exactly the sites this tool exists to blend into.
 *
 * TURN relayed over UDP 443 slips through this gap, so the firewall is not the
 * only layer: profiles launch with `--fingerprint-webrtc-ip`, which replaces
 * the address WebRTC would report at the source. A browser that refuses to
 * start protects nothing at all.
 */
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

/**
 * NSIS's large-string build caps a define at 8192 characters and truncates
 * past it without a word: the installer hands PowerShell a half-decoded
 * payload and reports an unintelligible code. This turns that into a build
 * failure.
 *
 * It cost an evening on 19 August 2026. Forty lines of comment added to the
 * .ps1 pushed the longest define from 6,836 to 9,760 characters, and every
 * install began failing with "firewall ownership could not be verified safely
 * (code -196608)" on a machine whose rules were in fact correct.
 *
 * Keep prose out of the .ps1 and put it here, where it is never embedded.
 */
const NSIS_STRING_LIMIT = 8192;

function assertWithinNsisStringLimit(commands) {
  for (const [mode, encoded] of Object.entries(commands)) {
    if (encoded.length > NSIS_STRING_LIMIT) {
      throw new Error(
        `The ${mode} firewall command encodes to ${encoded.length} characters, over NSIS's ` +
          `${NSIS_STRING_LIMIT}-character limit. NSIS truncates silently and the installer then ` +
          "fails with an unintelligible code. Shrink windows-webrtc-firewall.ps1 — explanation " +
          "belongs in this file, which is never embedded.",
      );
    }
  }
  return commands;
}

function buildEncodedFirewallCommands(script) {
  const payload = gzipSync(Buffer.from(script, "utf8")).toString("base64");
  return assertWithinNsisStringLimit({
    checkProfiles: encodeWrapper(payload, "CheckProfiles"),
    checkOwner: encodeWrapper(payload, "CheckOwner"),
    install: encodeWrapper(payload, "Install"),
    uninstall: encodeWrapper(payload, "Uninstall"),
    verify: encodeWrapper(payload, "Verify"),
    verifyAbsent: encodeWrapper(payload, "VerifyAbsent"),
  });
}

function encodeWrapper(payload, mode) {
  const requiresPaths = ["CheckOwner", "Install", "Uninstall", "Verify"].includes(mode);
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
      `!define MKT_BROWSER_FIREWALL_CHECK_OWNER_COMMAND "${commands.checkOwner}"`,
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
