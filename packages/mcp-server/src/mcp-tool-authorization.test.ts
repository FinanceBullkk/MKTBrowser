/**
 * Phase 02 / H21–H23: is the tool deny list enforced at *dispatch*, not only at listing?
 *
 * The Relay token holds `PROFILE_MANAGEMENT_ACCESS_POLICY`. Sixteen of the twenty-four tools are full
 * browser control — `evaluate_js` and `cdp_send` alone are arbitrary code in the page — and must be
 * unreachable with that token. There are two enforcement points in `server.ts`:
 *
 *   - `:466` filters `tools/list`
 *   - `:477` rejects `tools/call`
 *
 * Only the first is load-bearing for a well-behaved client. An attacker does not call `tools/list`
 * first; they call the tool by name. Existing coverage tests `isMcpToolAllowed` as a pure function
 * and `security-contract.test.ts` asserts the *string* appears in the source — neither proves the
 * dispatch path consults it.
 *
 * This drives the real `createMktBrowserMcpServer` over the real MCP protocol via the SDK's in-memory
 * transport, with the shipped `MockBrowserDriver` (the same one `standalone.ts` uses) wrapped in a
 * recorder. The decisive assertion is not that the call returned an error — a denied tool could error
 * for a dozen unrelated reasons — but that **the driver was never touched**. Reaching the driver at
 * all is the breach, whatever the response says.
 *
 * No real profiles, no real browser, no network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProfileManager } from "@mktbrowser/profile-manager";

import { createMktBrowserMcpServer, type BrowserDriver } from "./server.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import {
  FULL_LOCAL_ACCESS_POLICY,
  MCP_TOOL_EXPOSURE,
  PROFILE_MANAGEMENT_ACCESS_POLICY,
  isMcpToolAllowed,
  type McpToolAccessPolicy,
} from "./tool-exposure-policy.js";

/** Every tool the Relay token must NOT be able to reach. */
const DENIED_TO_RELAY = Object.keys(MCP_TOOL_EXPOSURE).filter(
  (name) => !isMcpToolAllowed(name, PROFILE_MANAGEMENT_ACCESS_POLICY),
);

/** Every tool it may reach. */
const ALLOWED_TO_RELAY = Object.keys(MCP_TOOL_EXPOSURE).filter((name) =>
  isMcpToolAllowed(name, PROFILE_MANAGEMENT_ACCESS_POLICY),
);

interface Harness {
  client: Client;
  touched: string[];
  driverCalls: Array<{ method: string; args: unknown[] }>;
  profileManager: ProfileManager;
  profileId: string;
  dispose: () => Promise<void>;
}

/**
 * Wrap the shipped driver so any call through it is recorded. Not a stand-in for the logic under
 * test — the authorization path is entirely real; this only observes whether it was escaped.
 */
function recordingDriver(
  inner: BrowserDriver,
  touched: string[],
  driverCalls: Array<{ method: string; args: unknown[] }>,
): BrowserDriver {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        touched.push(String(prop));
        driverCalls.push({ method: String(prop), args });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

async function harness(accessPolicy: McpToolAccessPolicy): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "mkb-mcp-authz-"));
  const profileManager = new ProfileManager({
    dbPath: join(root, "profiles.db"),
    profilesRoot: join(root, "profiles"),
  });
  const touched: string[] = [];
  const driverCalls: Array<{ method: string; args: unknown[] }> = [];
  const browserDriver = recordingDriver(
    new MockBrowserDriver(profileManager),
    touched,
    driverCalls,
  );

  // A real profile, so a permitted call actually reaches the driver instead of failing lookup.
  const profile = profileManager.create({ name: "audit-profile" });

  const { server } = createMktBrowserMcpServer({ profileManager, browserDriver, accessPolicy });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase-02-audit", version: "1.0.0" }, { capabilities: {} });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    touched,
    driverCalls,
    profileManager,
    profileId: profile.id,
    dispose: async () => {
      await client.close();
      await server.close();
      // The SQLite handle must be released before the directory can go, or Windows reports EBUSY.
      profileManager.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Call a tool and report whether the server refused it, however it chose to refuse. */
async function refused(client: Client, name: string, profileId = "p1"): Promise<boolean> {
  try {
    const result = (await client.callTool({
      name,
      arguments: {
        profile_id: profileId,
        url: "https://example.invalid/",
        selector: "body",
        text: "x",
      },
    })) as {
      isError?: boolean;
    };
    return result.isError === true;
  } catch {
    return true; // protocol-level rejection is equally a refusal
  }
}

test("the inventory under test is the full 25 tools, split into both groups", async () => {
  // Guards every assertion below against a vacuous pass if the policy or table is emptied.
  assert.equal(Object.keys(MCP_TOOL_EXPOSURE).length, 25);
  assert.ok(
    DENIED_TO_RELAY.length >= 15,
    `expected many denied tools, got ${DENIED_TO_RELAY.length}`,
  );
  assert.ok(
    ALLOWED_TO_RELAY.length >= 5,
    `expected several allowed tools, got ${ALLOWED_TO_RELAY.length}`,
  );
  for (const critical of ["evaluate_js", "cdp_send", "get_cookies", "set_cookies", "navigate"]) {
    assert.ok(DENIED_TO_RELAY.includes(critical), `${critical} must be denied to the Relay token`);
  }
});

test("H21: tools/list hides exactly the tools the policy denies", async () => {
  const h = await harness(PROFILE_MANAGEMENT_ACCESS_POLICY);
  try {
    const listed = new Set((await h.client.listTools()).tools.map((t) => t.name));

    for (const name of DENIED_TO_RELAY) {
      assert.equal(listed.has(name), false, `${name} must not be listed`);
    }
    for (const name of ALLOWED_TO_RELAY) {
      // `cdp_send` is additionally gated on rawCdpEnabled(); it is denied here anyway.
      assert.equal(listed.has(name), true, `${name} must be listed`);
    }
  } finally {
    await h.dispose();
  }
});

test("H21: a denied tool called directly by name is refused and never reaches the driver", async () => {
  const h = await harness(PROFILE_MANAGEMENT_ACCESS_POLICY);
  try {
    for (const name of DENIED_TO_RELAY) {
      const wasRefused = await refused(h.client, name);
      assert.equal(wasRefused, true, `${name} must be refused at dispatch`);
    }
    // The assertion that actually matters: no denied call reached the browser at all.
    assert.deepEqual(h.touched, [], `driver was reached by a denied tool: ${h.touched.join(", ")}`);
  } finally {
    await h.dispose();
  }
});

test("H21: the same tools are reachable under the full-local policy (differential)", async () => {
  /**
   * Without this, the refusals above could be caused by the fixture rather than the policy — a
   * missing profile, a schema error, anything. Same server, same call, only the policy differs.
   */
  const h = await harness(FULL_LOCAL_ACCESS_POLICY);
  try {
    const listed = new Set((await h.client.listTools()).tools.map((t) => t.name));
    for (const name of ["navigate", "evaluate_js", "get_cookies", "screenshot"]) {
      assert.equal(listed.has(name), true, `${name} must be listed under full-local`);
    }

    // Reaching the driver is the point here; the call itself may still fail further in.
    await refused(h.client, "navigate", h.profileId);
    assert.ok(
      h.touched.length > 0,
      "full-local policy should let at least one call through to the driver",
    );
  } finally {
    await h.dispose();
  }
});

test("H22: tool-name matching is exact, not case- or whitespace-tolerant", async () => {
  const h = await harness(PROFILE_MANAGEMENT_ACCESS_POLICY);
  try {
    const variants = [
      "Navigate",
      "NAVIGATE",
      "navigate ",
      " navigate",
      "navigate\t",
      "navigate\n",
      "nav igate",
      "navigate ",
    ];
    for (const variant of variants) {
      assert.equal(
        await refused(h.client, variant),
        true,
        `${JSON.stringify(variant)} must be refused`,
      );
    }
    assert.deepEqual(h.touched, [], `a name variant reached the driver: ${h.touched.join(", ")}`);
  } finally {
    await h.dispose();
  }
});

test("H23: an unclassified tool name defaults to deny", async () => {
  const h = await harness(PROFILE_MANAGEMENT_ACCESS_POLICY);
  try {
    for (const name of ["future_unclassified_tool", "delete_profile", "__proto__", "constructor"]) {
      assert.equal(await refused(h.client, name), true, `${name} must be refused`);
    }
    assert.deepEqual(h.touched, []);
  } finally {
    await h.dispose();
  }
});

test("H23: an unclassified tool is denied even under the most permissive policy", async () => {
  // Default-deny must come from classification, not from the policy's capability list.
  const h = await harness(FULL_LOCAL_ACCESS_POLICY);
  try {
    assert.equal(isMcpToolAllowed("future_unclassified_tool", FULL_LOCAL_ACCESS_POLICY), false);
    assert.equal(await refused(h.client, "future_unclassified_tool"), true);
  } finally {
    await h.dispose();
  }
});

test("H24: raw cdp_send always enters the driver through safe mode", async () => {
  const previous = process.env.MKT_BROWSER_MCP_ALLOW_RAW_CDP;
  process.env.MKT_BROWSER_MCP_ALLOW_RAW_CDP = "1";
  let h: Harness | undefined;
  try {
    h = await harness(FULL_LOCAL_ACCESS_POLICY);
    const launched = await h.client.callTool({
      name: "launch_profile",
      arguments: { profile_id: h.profileId },
    });
    assert.notEqual(launched.isError, true);
    h.touched.length = 0;
    h.driverCalls.length = 0;

    const result = await h.client.callTool({
      name: "cdp_send",
      arguments: {
        profile_id: h.profileId,
        method: "Runtime.evaluate",
        params: { expression: "1 + 1" },
      },
    });

    assert.notEqual(result.isError, true);
    assert.deepEqual(h.touched, ["isRunning", "cdpSend"]);
    const cdpCall = h.driverCalls.find((call) => call.method === "cdpSend");
    assert.ok(cdpCall);
    assert.deepEqual(cdpCall.args[4], { safe: true });
  } finally {
    await h?.dispose();
    if (previous === undefined) delete process.env.MKT_BROWSER_MCP_ALLOW_RAW_CDP;
    else process.env.MKT_BROWSER_MCP_ALLOW_RAW_CDP = previous;
  }
});

test("H25: managed launch cannot remove its required proxy or replace the fingerprint", async () => {
  const h = await harness(PROFILE_MANAGEMENT_ACCESS_POLICY);
  try {
    const managed = h.profileManager.createIdempotent(
      { name: "managed-audit-profile" },
      { externalRef: "account-1", requestId: "request-1", requestHash: "request-hash-1" },
    ).profile;
    const originalFingerprint = structuredClone(managed.fingerprint);
    const proxy = {
      type: "http" as const,
      host: "proxy.example",
      port: 8080,
      username: "operator",
      password: "secret",
    };

    h.touched.length = 0;
    h.driverCalls.length = 0;
    const launched = await h.client.callTool({
      name: "launch_managed_profile",
      arguments: {
        profile_id: managed.id,
        proxy,
        fingerprint: null,
        disable_proxy: true,
        disable_fingerprint: true,
      },
    });

    assert.notEqual(launched.isError, true);
    const stored = h.profileManager.get(managed.id);
    assert.ok(stored);
    assert.deepEqual(stored.proxy, proxy);
    assert.deepEqual(stored.fingerprint, originalFingerprint);
    assert.equal(h.driverCalls.filter((call) => call.method === "launch").length, 1);

    for (const invalidProxy of [undefined, null]) {
      h.touched.length = 0;
      h.driverCalls.length = 0;
      const rejected = await h.client.callTool({
        name: "launch_managed_profile",
        arguments: { profile_id: managed.id, proxy: invalidProxy },
      });
      assert.equal(rejected.isError, true);
      assert.equal(
        h.driverCalls.some((call) => call.method === "launch"),
        false,
      );
    }
  } finally {
    await h.dispose();
  }
});
