import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { WindowsRelayCompanion } from "./windows-relay-companion.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const start = source.indexOf("    if (compatibilityActivationBlock) {");
const end = source.indexOf("    // macOS:", start);
assert.ok(start > 0 && end > start);
// Run the production startup branch with the real companion and disposable process/health seams.
const branch = source.slice(start, end);

for (const status of ["started", "blocked", "starting"] as const) {
  test(`activation block attempts pinned Relay once (${status}) and never falls through to profiles`, async () => {
    const calls: string[] = [];
    let message = "";
    const context = {
      compatibilityActivationBlock: "Update pending. Run installer repair.",
      normalWindowsSession: true,
      relayCompanion: null,
      join,
      process: { resourcesPath: "fixture-resources", execPath: "fixture-browser" },
      app: { getPath: () => "fixture-appdata", quit: () => { calls.push("quit"); } },
      dialog: { showErrorBox: (_title: string, body: string) => { message = body; calls.push("notice"); } },
      WindowsRelayCompanion: class extends WindowsRelayCompanion {
        constructor(options: ConstructorParameters<typeof WindowsRelayCompanion>[0]) {
          assert.equal(options.scriptPath, join("fixture-resources", "installer", "windows-relay-companion.ps1"));
          super({ ...options, platform: "win32", systemRoot: "C:\\Windows", pathExists: () => true,
            execFile: async () => { calls.push("attempt"); return { stdout: JSON.stringify({ status }), stderr: "" }; },
            fetch: async () => { calls.push("health"); return new Response('{"relayVersion":17}'); },
          });
        }
        override dispose() { calls.push("dispose"); super.dispose(); }
      },
    };
    await runInNewContext(`(async () => { ${branch}\nthrow new Error('profile startup reached'); })()`, context);
    assert.deepEqual(calls, status === "started"
      ? ["attempt", "health", "dispose", "notice", "quit"]
      : ["attempt", "dispose", "notice", "quit"]);
    assert.match(message, /Run installer repair/);
    assert.match(message, /does not confirm update recovery/);
    if (status === "blocked") assert.match(message, /could not be started safely/);
    assert.equal(context.relayCompanion, null);
  });
}

test("disposable/development activation blocks do not start the installed Relay", async () => {
  let quit = false;
  await runInNewContext(`(async () => { ${branch}\nthrow new Error('profile startup reached'); })()`, {
    compatibilityActivationBlock: "Update pending",
    normalWindowsSession: false,
    dialog: { showErrorBox: () => {} },
    app: { quit: () => { quit = true; } },
  });
  assert.equal(quit, true);
});
