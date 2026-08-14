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
    engine: "cft",
    binaryPath: "C:\\MKTTool\\MKTBrowser\\chromium\\cft\\runtime\\chrome.exe",
    execFile: async (file, args, options) => {
      calls.push({ file, args, env: options.env, encoding: options.encoding });
      return { stdout: '{"protected":true}', stderr: "" };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "powershell.exe");
  assert.equal(calls[0]?.env.MKT_BROWSER_FIREWALL_RULE, firewallRuleNameForEngine("cft"));
  assert.equal(
    calls[0]?.env.MKT_BROWSER_FIREWALL_PROGRAM,
    "C:\\MKTTool\\MKTBrowser\\chromium\\cft\\runtime\\chrome.exe",
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
    engine: "cft",
    binaryPath: "/runtime/chrome",
    execFile: async () => {
      called = true;
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(called, false);
});
