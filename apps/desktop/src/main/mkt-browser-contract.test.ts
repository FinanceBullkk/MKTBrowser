import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname } from "node:path";
import test from "node:test";
import {
  MKT_BROWSER_DEFAULT_MCP_PORT,
  MKT_BROWSER_MCP_HEALTH_NAME,
  MKT_BROWSER_MCP_PORT_ENV,
  MKT_BROWSER_MCP_SERVER_NAME,
  mktBrowserMcpBaseUrl,
  resolveMktBrowserMcpPort,
} from "../../../../packages/types/src/index.ts";

const REPO_ROOT = new URL("../../../../", import.meta.url);

test("defines the owned MKT Browser MCP contract", () => {
  assert.equal(MKT_BROWSER_MCP_SERVER_NAME, "mkt-browser");
  assert.equal(MKT_BROWSER_MCP_HEALTH_NAME, "mkt-browser-mcp");
  assert.equal(MKT_BROWSER_DEFAULT_MCP_PORT, 47_822);
  assert.equal(MKT_BROWSER_MCP_PORT_ENV, "MKT_BROWSER_MCP_PORT");
  assert.equal(mktBrowserMcpBaseUrl(), "http://127.0.0.1:47822");
});

test("supports one explicit MCP port override and rejects invalid values", () => {
  assert.equal(resolveMktBrowserMcpPort(undefined), MKT_BROWSER_DEFAULT_MCP_PORT);
  assert.equal(resolveMktBrowserMcpPort(" 49123 "), 49_123);
  for (const value of ["0", "65536", "1.5", "port", "-1"]) {
    assert.throws(() => resolveMktBrowserMcpPort(value), /MKT_BROWSER_MCP_PORT/);
  }
});

test("uses MKT Browser-owned workspace, preload, and MCP identities", () => {
  const rootPackage = packageJson("package.json");
  const desktopPackage = packageJson("apps/desktop/package.json");
  const mcpPackage = packageJson("packages/mcp-server/package.json");

  assert.equal(rootPackage.name, "mkt-browser");
  assert.equal(desktopPackage.name, "@mktbrowser/desktop");
  assert.deepEqual(Object.keys(mcpPackage.bin as Record<string, string>), ["mkt-browser-mcp"]);

  const preload = source("apps/desktop/src/preload/index.ts");
  const server = source("packages/mcp-server/src/server.ts");
  assert.match(preload, /exposeInMainWorld\("mktBrowser", api\)/);
  assert.match(server, /name: MKT_BROWSER_MCP_SERVER_NAME/);
});

test("contains no retired first-party compatibility markers", () => {
  const banned = [
    "@multizen/",
    "window.multizen",
    "MULTIZEN_MCP_",
    "multizenToken",
    "multizenUrl",
    "127.0.0.1:7777",
    "node_modules/@multizen",
    "bin/multizen-mcp",
    ".multizen",
    "multizen.ui",
    "mz-",
    "autoUpdate",
    "usageReporting",
    "electron-updater",
    "ping.getmultizen.com",
    "github.com/multizenteam/multizen-browser/releases",
    "--publish",
  ];

  const files = [
    ...textFiles(new URL("apps/", REPO_ROOT)),
    ...textFiles(new URL("packages/", REPO_ROOT)),
    new URL("package.json", REPO_ROOT),
    new URL(".github/workflows/release.yml", REPO_ROOT),
  ];

  for (const file of files) {
    if (file.pathname.endsWith("/mkt-browser-contract.test.ts")) continue;
    const contents = readFileSync(file, "utf8");
    for (const marker of banned) {
      assert.equal(contents.includes(marker), false, `${file.pathname} contains ${marker}`);
    }
  }
});

function packageJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(source(relativePath)) as Record<string, unknown>;
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}

function textFiles(root: URL): URL[] {
  const files: URL[] = [];
  const visit = (directory: URL): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", "out", "dist", "release"].includes(entry.name)) continue;
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) {
        visit(child);
      } else if (
        [".ts", ".tsx", ".js", ".cjs", ".css", ".json", ".yml", ".yaml"].includes(
          extname(entry.name),
        )
      ) {
        files.push(child);
      }
    }
  };
  visit(root);
  return files;
}
