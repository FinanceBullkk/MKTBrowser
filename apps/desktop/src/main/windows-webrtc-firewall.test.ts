import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWindowsWebRtcFirewallProtection,
  firewallRuleNameForEngine,
} from "./windows-webrtc-firewall.ts";

test("accepts a verified outbound UDP block for the exact runtime", async () => {
  const calls: Array<{
    file: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    encoding: string;
  }> = [];
  await assertWindowsWebRtcFirewallProtection({
    platform: "win32",
    engine: "cloakbrowser",
    binaryPath: "C:\\MKTTool\\MKTBrowser\\chromium\\cloakbrowser\\runtime\\chrome.exe",
    execFile: async (file, args, options) => {
      calls.push({ file, args, env: options.env, encoding: options.encoding });
      return { stdout: '{"protected":true}', stderr: "" };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "powershell.exe");
  assert.equal(calls[0]?.env.MKT_BROWSER_FIREWALL_RULE, firewallRuleNameForEngine());
  assert.equal(
    calls[0]?.env.MKT_BROWSER_FIREWALL_PROGRAM,
    "C:\\MKTTool\\MKTBrowser\\chromium\\cloakbrowser\\runtime\\chrome.exe",
  );
  assert.equal(calls[0]?.encoding, "utf8");
  assert.match(calls[0]?.args.join(" ") ?? "", /HNetCfg\.FwPolicy2/);
  assert.doesNotMatch(calls[0]?.args.join(" ") ?? "", /Get-NetFirewallRule/);
});

test("fails closed before launch when the protection cannot be verified", async () => {
  await assert.rejects(
    assertWindowsWebRtcFirewallProtection({
      platform: "win32",
      engine: "cloakbrowser",
      binaryPath:
        "C:\\MKTTool\\MKTBrowser\\chromium\\cloakbrowser\\runtime\\chrome.exe",
      execFile: async () => ({
        stdout: '{"protected":false,"reason":"rule-missing"}',
        stderr: "",
      }),
    }),
    /WebRTC protection is not active for CloakBrowser/,
  );
});

test("does not apply the Windows firewall boundary on other platforms", async () => {
  let called = false;
  await assertWindowsWebRtcFirewallProtection({
    platform: "darwin",
    engine: "cloakbrowser",
    binaryPath: "/runtime/chrome",
    execFile: async () => {
      called = true;
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(called, false);
});

/**
 * The runtime-identity guard had no coverage: disabling the `chrome.exe` / expected-suffix check
 * left all three tests above green. It is the check that ties the firewall rule to the binary the
 * browser will actually launch. Without it, protection can be verified against one executable while
 * a different one starts — the operator believes WebRTC is contained and it is not, which is an IP
 * leak rather than a crash.
 *
 * Each case asserts the probe was **never run**: refusing after asking PowerShell would still have
 * consulted the firewall about the wrong program.
 *
 * Paths are written with forward slashes and normalised by the module under test, which uses
 * `win32.normalize`. Backslash literals do not survive this file's editing pipeline intact.
 */
const RUNTIME_CLOAK = "C:/MKTTool/MKTBrowser/chromium/cloakbrowser/runtime/chrome.exe";

async function probeWasRun(binaryPath: string): Promise<boolean> {
  let probed = false;
  try {
    await assertWindowsWebRtcFirewallProtection({
      platform: "win32",
      engine: "cloakbrowser",
      binaryPath,
      execFile: async () => {
        probed = true;
        return { stdout: '{"protected":true}', stderr: "" };
      },
    });
  } catch {
    /* rejection is the expected outcome for the refusal cases */
  }
  return probed;
}

test("refuses a binary that is not chrome.exe, without probing the firewall", async () => {
  for (const binaryPath of [
    "C:/MKTTool/MKTBrowser/chromium/cloakbrowser/runtime/notchrome.exe",
    "C:/MKTTool/MKTBrowser/chromium/cloakbrowser/runtime/chrome.com",
    "C:/MKTTool/MKTBrowser/chromium/cloakbrowser/runtime/chrome.exe.bak",
    "C:/MKTTool/MKTBrowser/chromium/cloakbrowser/runtime/",
  ]) {
    await assert.rejects(
      assertWindowsWebRtcFirewallProtection({
        platform: "win32",
        engine: "cloakbrowser",
        binaryPath,
        execFile: async () => ({ stdout: '{"protected":true}', stderr: "" }),
      }),
      /WebRTC protection/,
      binaryPath,
    );
    assert.equal(await probeWasRun(binaryPath), false, `firewall probed for ${binaryPath}`);
  }
});

test("refuses a chrome.exe outside the expected engine runtime path", async () => {
  /**
   * The more interesting half: the file is genuinely named chrome.exe, so a name-only check passes.
   * Only the expected-suffix comparison separates this engine's own runtime from any other Chromium
   * on the machine, including one an attacker placed and one left behind by the retired cft engine.
   */
  for (const binaryPath of [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/MKTTool/MKTBrowser/chromium/cft/runtime/chrome.exe",
    "C:/Temp/chrome.exe",
  ]) {
    await assert.rejects(
      assertWindowsWebRtcFirewallProtection({
        platform: "win32",
        engine: "cloakbrowser",
        binaryPath,
        execFile: async () => ({ stdout: '{"protected":true}', stderr: "" }),
      }),
      /WebRTC protection/,
      binaryPath,
    );
    assert.equal(await probeWasRun(binaryPath), false, `firewall probed for ${binaryPath}`);
  }

  // Differential: the engine's own runtime is accepted, so the rejections above are attributable to
  // the path rather than to the fixture.
  assert.equal(await probeWasRun(RUNTIME_CLOAK), true);
});
