/**
 * Phase 02 / H31–H34: does the SOCKS5 bridge actually contain a proxied profile?
 *
 * The bridge exists for one reason, stated in its own header: Chromium's `--proxy-server=http://…`
 * resolves DNS **locally**, so every hostname the profile visits leaks to the host's resolver even
 * though the traffic itself is proxied. Pointing Chromium at a local `socks5://` bridge makes it do
 * *remote* DNS instead. That reasoning is sound. What was never tested is whether the bridge keeps
 * the promise, and what it does when the upstream misbehaves.
 *
 * The harness is a **test-controlled SOCKS5 upstream that records the destination it is asked for**.
 * That single recording answers the question the bridge exists to answer: a hostname arriving as
 * ATYP=DOMAINNAME means remote DNS is working; an ATYP=IPV4 means the bridge resolved locally and
 * the leak the bridge was built to prevent is back.
 *
 * `localhost` is deliberately one of the destinations. It resolves on every machine, so a bridge
 * doing local resolution would still *work* — the failure would be invisible except in the recording.
 * That is exactly the silent failure this phase exists to catch.
 *
 * Everything is loopback. No provider proxy, no real account, no external network, no observed IPs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, connect, type Server, type Socket } from "node:net";
import { SocksClient } from "socks";

import { startBridgeForProfile, stopBridgeForProfile } from "./socks5Bridge.ts";

/** One CONNECT request as the upstream saw it. */
interface RecordedRequest {
  atyp: number;
  address: string;
  port: number;
  authenticated: boolean;
}

interface Upstream {
  port: number;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;

/**
 * A minimal SOCKS5 server. Hand-rolled rather than pulled from a library so the bytes on the wire
 * are inspected directly — a library would normalise exactly the detail under test.
 */
async function recordingUpstream(
  opts: { requireAuth?: boolean; rejectAuth?: boolean; failConnect?: boolean; forwardTo?: number } = {},
): Promise<Upstream> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => undefined);
    let stage: "greeting" | "auth" | "request" | "relay" = "greeting";
    let authenticated = !opts.requireAuth;
    let buf = Buffer.alloc(0);

    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === "greeting") {
        if (buf.length < 2) return;
        const nMethods = buf[1] ?? 0;
        if (buf.length < 2 + nMethods) return;
        buf = buf.subarray(2 + nMethods);
        const method = opts.requireAuth ? 0x02 : 0x00;
        sock.write(Buffer.from([0x05, method]));
        stage = opts.requireAuth ? "auth" : "request";
      }

      if (stage === "auth") {
        if (buf.length < 2) return;
        const uLen = buf[1] ?? 0;
        if (buf.length < 2 + uLen + 1) return;
        const pLen = buf[2 + uLen] ?? 0;
        if (buf.length < 3 + uLen + pLen) return;
        buf = buf.subarray(3 + uLen + pLen);
        if (opts.rejectAuth) {
          sock.write(Buffer.from([0x01, 0x01])); // failure
          sock.end();
          return;
        }
        authenticated = true;
        sock.write(Buffer.from([0x01, 0x00]));
        stage = "request";
      }

      if (stage === "request") {
        if (buf.length < 5) return;
        const atyp = buf[3] ?? 0;
        let address: string;
        let offset: number;
        if (atyp === ATYP_IPV4) {
          if (buf.length < 10) return;
          address = Array.from(buf.subarray(4, 8)).join(".");
          offset = 8;
        } else if (atyp === ATYP_DOMAIN) {
          const len = buf[4] ?? 0;
          if (buf.length < 5 + len + 2) return;
          address = buf.subarray(5, 5 + len).toString("utf8");
          offset = 5 + len;
        } else {
          sock.end();
          return;
        }
        const port = buf.readUInt16BE(offset);
        buf = buf.subarray(offset + 2);
        requests.push({ atyp, address, port, authenticated });

        if (opts.failConnect || opts.forwardTo === undefined) {
          sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // refused
          sock.end();
          return;
        }

        const target = connect(opts.forwardTo, "127.0.0.1", () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          stage = "relay";
          sock.pipe(target);
          target.pipe(sock);
        });
        target.on("error", () => {
          sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          sock.end();
        });
        sockets.add(target);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    requests,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A stand-in destination that records how many connections reached it. */
async function echoServer(): Promise<{ port: number; connections: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const state = { connections: 0 };
  const server: Server = createServer((sock) => {
    state.connections += 1;
    sockets.add(sock);
    sock.on("error", () => undefined);
    sock.pipe(sock);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    get connections() {
      return state.connections;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function bridgePort(url: string): number {
  return Number(new URL(url).port);
}

/** Connect through the bridge to `destination`, returning the socket or the failure. */
async function throughBridge(
  port: number,
  destination: { host: string; port: number },
): Promise<{ ok: true; socket: Socket } | { ok: false; error: Error }> {
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: "127.0.0.1", port, type: 5 },
      command: "connect",
      destination,
      timeout: 4_000,
    });
    return { ok: true, socket };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}

test("H32: the bridge passes the hostname upstream instead of resolving it locally", async () => {
  const echo = await echoServer();
  const upstream = await recordingUpstream({ forwardTo: echo.port });
  const profileId = "h32-remote-dns";
  try {
    const url = await startBridgeForProfile(profileId, {
      type: "socks5",
      host: "127.0.0.1",
      port: upstream.port,
    });
    const result = await throughBridge(bridgePort(url), { host: "localhost", port: echo.port });
    assert.equal(result.ok, true, "the bridge should have completed the connection");
    if (result.ok) result.socket.destroy();

    assert.equal(upstream.requests.length, 1);
    const seen = upstream.requests[0];
    assert.ok(seen, "upstream recorded no request");

    /**
     * The whole point. `localhost` resolves everywhere, so a bridge doing local DNS would still have
     * produced a working connection — and an IPv4 request here. Only the recorded ATYP distinguishes
     * the working-but-leaking case from the correct one.
     */
    assert.equal(
      seen.atyp,
      ATYP_DOMAIN,
      `upstream received ATYP ${seen.atyp} (${seen.address}); local DNS resolution would leak every hostname`,
    );
    assert.equal(seen.address, "localhost");
    assert.equal(seen.port, echo.port);
  } finally {
    await stopBridgeForProfile(profileId);
    await upstream.close();
    await echo.close();
  }
});

test("H32: a hostname that cannot resolve locally still reaches the upstream", async () => {
  // `.test` is reserved by RFC 6761 and never resolves. A bridge doing local DNS could not even
  // form this request, so its arrival upstream is independent evidence for the same property.
  const echo = await echoServer();
  const upstream = await recordingUpstream({ forwardTo: echo.port });
  const profileId = "h32-unresolvable";
  try {
    const url = await startBridgeForProfile(profileId, {
      type: "socks5",
      host: "127.0.0.1",
      port: upstream.port,
    });
    const result = await throughBridge(bridgePort(url), { host: "no-such-host.test", port: 80 });
    if (result.ok) result.socket.destroy();

    assert.equal(upstream.requests.length, 1);
    const seen = upstream.requests[0];
    assert.ok(seen, "upstream recorded no request");
    assert.equal(seen.atyp, ATYP_DOMAIN);
    assert.equal(seen.address, "no-such-host.test");
  } finally {
    await stopBridgeForProfile(profileId);
    await upstream.close();
    await echo.close();
  }
});

test("H33: the bridge listens on loopback only", async () => {
  const upstream = await recordingUpstream({});
  const profileId = "h33-bind-scope";
  try {
    const url = await startBridgeForProfile(profileId, {
      type: "socks5",
      host: "127.0.0.1",
      port: upstream.port,
    });
    // A bridge on 0.0.0.0 would let any process on the LAN relay through this user's proxy.
    assert.equal(new URL(url).hostname, "127.0.0.1");

    const { networkInterfaces } = await import("node:os");
    const external = Object.values(networkInterfaces())
      .flat()
      .find((nic) => nic && nic.family === "IPv4" && !nic.internal);

    if (external) {
      const refused = await new Promise<boolean>((resolve) => {
        const sock = connect({ host: external.address, port: bridgePort(url) });
        sock.setTimeout(3_000);
        sock.once("connect", () => {
          sock.destroy();
          resolve(false);
        });
        sock.once("timeout", () => {
          sock.destroy();
          resolve(true);
        });
        sock.once("error", () => resolve(true));
      });
      assert.equal(refused, true, `bridge was reachable on ${external.address} — not loopback-only`);
    }
  } finally {
    await stopBridgeForProfile(profileId);
    await upstream.close();
  }
});

test("H34: nothing reaches the destination when upstream authentication fails", async () => {
  /**
   * The containment property, stated as traffic rather than status: if the bridge relayed anything
   * before the upstream accepted it, that traffic left the machine unproxied. The echo server is the
   * destination, and it must never see a connection.
   */
  const echo = await echoServer();
  const upstream = await recordingUpstream({ requireAuth: true, rejectAuth: true, forwardTo: echo.port });
  const profileId = "h34-auth-ordering";
  try {
    const url = await startBridgeForProfile(profileId, {
      type: "socks5",
      host: "127.0.0.1",
      port: upstream.port,
      username: "wrong-user",
      password: "wrong-pass",
    });
    const result = await throughBridge(bridgePort(url), { host: "localhost", port: echo.port });

    assert.equal(result.ok, false, "a connection must not succeed when upstream auth is rejected");
    assert.equal(echo.connections, 0, "traffic reached the destination without a proxied path");
    assert.equal(upstream.requests.length, 0, "the CONNECT was sent before auth completed");
  } finally {
    await stopBridgeForProfile(profileId);
    await upstream.close();
    await echo.close();
  }
});

test("H31: when the upstream dies the bridge fails closed, it does not fall back to direct", async () => {
  /**
   * The highest-value assertion in this phase. A proxy that dies must break the profile, not quietly
   * egress on the host IP. Asserted by observation at the destination: after the upstream is gone,
   * the echo server must receive no further connections, because the only legitimate route to it was
   * through the proxy.
   */
  const echo = await echoServer();
  const upstream = await recordingUpstream({ forwardTo: echo.port });
  const profileId = "h31-upstream-death";
  try {
    const url = await startBridgeForProfile(profileId, {
      type: "socks5",
      host: "127.0.0.1",
      port: upstream.port,
    });

    // Control: while the upstream is alive the path works and the destination is reached.
    const alive = await throughBridge(bridgePort(url), { host: "localhost", port: echo.port });
    assert.equal(alive.ok, true);
    if (alive.ok) alive.socket.destroy();
    const reachedWhileAlive = echo.connections;
    assert.ok(reachedWhileAlive > 0, "control connection should have reached the destination");

    // The upstream dies mid-session.
    await upstream.close();

    const afterDeath = await throughBridge(bridgePort(url), { host: "localhost", port: echo.port });
    assert.equal(afterDeath.ok, false, "the bridge must refuse once the upstream is gone");
    if (afterDeath.ok) (afterDeath as { socket: Socket }).socket.destroy();

    assert.equal(
      echo.connections,
      reachedWhileAlive,
      "a connection reached the destination after the proxy died — this is a direct-egress leak",
    );
  } finally {
    await stopBridgeForProfile(profileId);
    await echo.close();
  }
});
