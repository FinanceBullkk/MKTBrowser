const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { inspectWorkspaceQuality } = require("./workspace-quality-contract.cjs");

function fixture(workspacePackage, files = { "src/index.ts": "export {};\n" }) {
  const root = mkdtempSync(path.join(tmpdir(), "mktbrowser-quality-"));
  writeJson(path.join(root, "package.json"), { workspaces: ["packages/*"] });
  const workspace = path.join(root, "packages", "fixture");
  writeJson(path.join(workspace, "package.json"), workspacePackage);
  for (const [relative, contents] of Object.entries(files)) {
    const destination = path.join(workspace, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  return root;
}

function writeJson(destination, value) {
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(value)}\n`);
}

test("rejects a source workspace without lint", () => {
  const root = fixture({ name: "fixture", scripts: {} });
  try {
    assert.deepEqual(inspectWorkspaceQuality(root), ["fixture has source files but no lint script."]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a workspace whose tests cannot be run", () => {
  const root = fixture(
    { name: "fixture", scripts: { lint: "tsc --noEmit" } },
    { "src/index.ts": "export {};\n", "src/index.test.ts": "export {};\n" },
  );
  try {
    assert.deepEqual(inspectWorkspaceQuality(root), ["fixture has tests but no test script."]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts explicit lint and test commands", () => {
  const root = fixture(
    { name: "fixture", scripts: { lint: "tsc --noEmit", "test:unit": "node --test" } },
    { "src/index.test.ts": "export {};\n" },
  );
  try {
    assert.deepEqual(inspectWorkspaceQuality(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
