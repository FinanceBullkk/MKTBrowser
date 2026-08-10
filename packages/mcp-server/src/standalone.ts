/**
 * Standalone runner for the MCP server.
 *
 * Used both for `yarn mcp:dev` (development) and as the entry point in
 * `bin/mkt-browser-mcp.js` so an MCP client like Cursor or Claude Desktop
 * can spawn it via stdio without launching the desktop app.
 *
 * In standalone mode the browser driver is the MockBrowserDriver — useful
 * for protocol tests but not for real browser work. The desktop app embeds
 * the same MCP server with the real Chromium-backed driver.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProfileManager } from "@mktbrowser/profile-manager";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { createMktBrowserMcpServer } from "./server.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";

async function main(): Promise<void> {
  const dataRoot = join(homedir(), ".mkt-browser");
  mkdirSync(dataRoot, { recursive: true });

  const profileManager = new ProfileManager({
    dbPath: join(dataRoot, "profiles.db"),
    profilesRoot: join(dataRoot, "profiles"),
  });

  const browserDriver = new MockBrowserDriver();
  const { server, activityLog } = createMktBrowserMcpServer({ profileManager, browserDriver });

  // Pipe activity events to stderr in standalone mode (stdout is reserved for MCP transport)
  activityLog.on("event", (e) => {
    if (e.status !== "pending") {
      process.stderr.write(
        `[mcp] ${e.tool} (${e.status}, ${e.durationMs ?? 0}ms) ${e.summary ?? ""}\n`,
      );
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", () => {
    profileManager.close();
    process.exit(0);
  });
}

main().catch((e) => {
  process.stderr.write(`MCP server crashed: ${String(e)}\n`);
  process.exit(1);
});
