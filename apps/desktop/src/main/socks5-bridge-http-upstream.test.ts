/**
 * Phase 02 / H31–H34 on the **HTTP-CONNECT upstream**, plus H40 (request injection).
 *
 * A profile's `ProxyConfig.type` selects one of two entirely different upstream paths. The prior
 * harness exercised `socks5` only; this covers `http`, which builds its CONNECT request by string
 * concatenation and carries `Proxy-Authorization` itself:
 *
 *     CONNECT ${targetHost}:${targetPort} HTTP/1.1
 *     Host: ${targetHost}:${targetPort}
 *
 * Two consequences follow from that shape and are tested here:
 *
 *  1. **Remote DNS must still hold.** The hostname arrives from the SOCKS5 request Chromium made to
 *     the bridge and must be forwarded unresolved, exactly as on the socks5 path.
 *  2. **H40 — the target host is interpolated into a header block with no validation**, and the
 *     bridge's own SOCKS5 parser builds it via `nameBuf.toString("ascii")`, so CR and LF bytes
 *     survive. A local client that can reach the bridge could therefore attempt to inject headers,
 *     or a second request, into the stream between the bridge and the operator's real proxy.
 *     Whether that is reachable in practice is a separate question from whether it is possible; this
 *     establishes which.
 *
 * Loopback only. No provider proxy, no real account, no external network, no observed IPs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, connect, type Socket } from "node:net";

import { startBridgeForProfile, stopBridgeForProfile } from "./socks5Bridge.ts";

interface HttpUpstream {
  port: number;
  /** Raw request text of every CONNECT the upstream received. */
  requests: string[];
  close: () => Promise<void>;
}

/**
 * A minimal HTTP proxy. It records the exact bytes of the request head, so header injection is
 * visible rather than normalised away by a parser.
 */
async function recordingHttpUpstream(
  opts: { reject?: boolean; forwardTo?: number } = {},
): Promise<HttpUpstream> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => undefined);
    let head = "";
    let established = false;

    sock.on("data", (chunk: Buffer) => {
      if (established) return;
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;

      requests.push(head.slice(0, end + 4));
      established = true;

      if (opts.reject || opts.forwardTo === undefined) {
        sock.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        sock.end();
        return;
      }

      const target = connect(opts.forwardTo, "127.0.0.1", () => {
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        sock.pipe(target);
        target.pipe(sock);
      });
      target.on("error", () => sock.destroy());
      sockets.add(target);
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

async function echoServer(): Promise<{ port: number; connections: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const state = { connections: 0 };
  const server = createServer((sock) => {
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

/**
 * A hand-written SOCKS5 client. `SocksClient` validates hostnames, which would reject the injection
 * payload before it ever reached the bridge — the library would be testing itself, not the bridge.
 */
function rawSocksConnect(
  port: number,
  host: string,
  targetPort: number,
): Promise<{ reply: Buffer; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let stage: "greeting" | "reply" = "greeting";
    sock.setTimeout(5_000, () => {
      sock.destroy();
      reject(new Error("timed out"));
    });
    sock.on("error", reject);
    sock.on("data", (chunk: Buffer) => {
      if (stage === "greeting") {
        stage = "reply";
        const name = Buffer.from(host, "latin1");
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]);
        sock.write(req);
        return;
      }
      resolve({ reply: chunk, socket: sock });
    });
  });
}

test("H32/http: the CONNECT request carries the hostname, not a locally resolved address", async () => {
  const echo = await echoServer();
  const upstream = await recordingHttpUpstream({ forwardTo: echo.port });
  const profileId = "http-remote-dns";
  try {
    const url = await startBridgeForProfile(profileId, {
      type: "http",
      host: "127.0.0.1",
      port: upstream.port,
    });
    const { socket } = await rawSocksConnect(bridgePort(url), "localhost", echo.port);
    socket.destroy();

    assert.equal(upstream.requests.length, 1);
    const request = upstream.requests[0];
    assert.ok(request, "upstream recorded no request");

    // `localhost` resolves everywhere, so a bridge doing local DNS would still work — only the
    // request line distinguishes the leaking case from the correct one.
    assert.ok(
      request.startsWith(`CONNECT localhost:${echo.port} HTTP/1.1\r\n`),
      `expected a hostname CONNECT, got: ${JSON.stringify(request.split("\r\n")[0])}`,
    );
    assert.equal(request.includes("127.0.0.1:" + echo.port), false, "hostname was resolved locally");
  } finally {
    await stopBridgeForProfile(profileId);
    await upstream.close();
    await echo.close();
  }
});

test("H34/http: Proxy-Authorization is sent only when credentials are configured", async () => {
  const echo = await echoServer();
  const withCreds = await recordingHttpUpstream({ forwardTo: echo.port });
  const withoutCreds = await recordingHttpUpstream({ forwardTo: echo.port });
  try {
    const a = await startBridgeForProfile("http-creds", {
      type: "http",
      host: "127.0.0.1",
      port: withCreds.port,
      username: "operator",
      password: "secret-value",
    });
    (await rawSocksConnect(bridgePort(a), "localhost", echo.port)).socket.destroy();

    const b = await startBridgeForProfile("http-nocreds", {
      type: "http",
      host: "127.0.0.1",
      port: withoutCreds.port,
    });
    (await rawSocksConnect(bridgePort(b), "localhost", echo.port)).socket.destroy();

    const authed = withCreds.requests[0] ?? "";
    const anonymous = withoutCreds.requests[0] ?? "";

    // Differential: the same call shape, only the configured credentials differ.
    assert.ok(authed.includes("Proxy-Authorization: Basic "), "credentials were not sent");
    assert.equal(
      authed.includes(Buffer.from("operator:secret-value").toString("base64")),
      true,
      "the Basic payload should encode the configured credentials",
    );
    assert.equal(
      anonymous.includes("Proxy-Authorization"),
      false,
      "an unauthenticated upstream must not receive an authorization header",
    );
  } finally {
    await stopBridgeForProfile("http-creds");
    await stopBridgeForProfile("http-nocreds");
    await withCreds.close();
    await withoutCreds.close();
    await echo.close();
  }
});

test("H34/http: a rejected CONNECT reaches no destination", async () => {
  const echo = await echoServer();
  const upstream = await recordingHttpUpstream({ reject: true, forwardTo: echo.port });
  const profileId = "http-rejected";
  try {
    const url = await startBridgeForProfile(profileId, {
      type: "http",
      host: "127.0.0.1",
      port: upstream.port,
    });
    const { reply, socket } = await rawSocksConnect(bridgePort(url), "localhost", echo.port);
    socket.destroy();

    // SOCKS5 reply byte 1 is the status; 0x00 is success and anything else is a refusal.
    assert.notEqual(reply[1], 0x00, "the bridge reported success for a rejected CONNECT");
    assert.equal(echo.connections, 0, "traffic reached the destination despite a 407");
  } finally {
    await stopBridgeForProfile(profileId);
    await upstream.close();
    await echo.close();
  }
});

test("H31/http: the bridge fails closed when the HTTP upstream dies", async () => {
  const echo = await echoServer();
  const upstream = await recordingHttpUpstream({ forwardTo: echo.port });
  const profileId = "http-upstream-death";
  try {
    const url = await startBridgeForProfile(profileId, {
      type: "http",
      host: "127.0.0.1",
      port: upstream.port,
    });

    const alive = await rawSocksConnect(bridgePort(url), "localhost", echo.port);
    assert.equal(alive.reply[1], 0x00);
    alive.socket.destroy();
    const reachedWhileAlive = echo.connections;
    assert.ok(reachedWhileAlive > 0);

    await upstream.close();

    const dead = await rawSocksConnect(bridgePort(url), "localhost", echo.port);
    dead.socket.destroy();
    assert.notEqual(dead.reply[1], 0x00, "the bridge must refuse once the upstream is gone");
    assert.equal(
      echo.connections,
      reachedWhileAlive,
      "a connection reached the destination after the proxy died — direct-egress leak",
    );
  } finally {
    await stopBridgeForProfile(profileId);
    await echo.close();
  }
});

test("H40: CR/LF in the target host cannot inject into the upstream CONNECT request", async () => {
  /**
   * The bridge reads the SOCKS5 destination with `toString("ascii")` and interpolates it into a
   * `\r\n`-joined header block. A hostname carrying CRLF would therefore append attacker-chosen
   * lines to the request the operator's real proxy receives — header injection, or a smuggled second
   * request, on the hop between MKT Browser and the proxy provider.
   *
   * The assertion is on the bytes the upstream received, not on whether the call failed: a refusal
   * that still forwarded the injected header would be a pass by luck.
   */
  const echo = await echoServer();
  const upstream = await recordingHttpUpstream({ forwardTo: echo.port });
  const profileId = "http-crlf-injection";
  try {
    const url = await startBridgeForProfile(profileId, {
      type: "http",
      host: "127.0.0.1",
      port: upstream.port,
    });

    const payload = "evil.test\r\nX-Injected: yes\r\nX-Second: 1";
    try {
      const { socket } = await rawSocksConnect(bridgePort(url), payload, echo.port);
      socket.destroy();
    } catch {
      // A timeout or reset is an acceptable outcome; the recording below is what decides.
    }

    const received = upstream.requests.join("\n---\n");
    assert.equal(
      received.includes("X-Injected"),
      false,
      `injected header reached the upstream proxy:\n${received}`,
    );
    assert.equal(received.includes("X-Second"), false, "a second injected header reached upstream");
  } finally {
    await stopBridgeForProfile(profileId);
    await upstream.close();
    await echo.close();
  }
});

test("H40: the host allowlist rejects separator characters without breaking real hostnames", async () => {
  /**
   * An over-strict guard would be its own outage, so both directions are asserted. The accepted set
   * covers what a profile legitimately visits; the rejected set is everything that could act as a
   * separator once the value is interpolated into a request head.
   */
  const echo = await echoServer();
  const upstream = await recordingHttpUpstream({ forwardTo: echo.port });
  const profileId = "http-host-allowlist";
  try {
    const url = await startBridgeForProfile(profileId, {
      type: "http",
      host: "127.0.0.1",
      port: upstream.port,
    });
    const port = bridgePort(url);

    // Built from character codes so the payloads survive any editor or tooling that would
    // normalise escape sequences — these bytes are the entire point of the test.
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const NUL = String.fromCharCode(0);
    const TAB = String.fromCharCode(9);

    const rejected = [
      `evil.test${CR}${LF}X-Injected: yes`,
      `evil.test${LF}X-Injected: yes`,
      `evil.test${CR}X-Injected: yes`,
      "evil test",
      `evil.test${NUL}`,
      `evil.test${TAB}X: 1`,
      "",
    ];
    for (const host of rejected) {
      let status: number | undefined;
      try {
        const { reply, socket } = await rawSocksConnect(port, host, echo.port);
        status = reply[1];
        socket.destroy();
      } catch {
        status = undefined;
      }
      assert.notEqual(status, 0x00, `host ${JSON.stringify(host)} should have been refused`);
    }

    const accepted = ["sub.domain-1.example", "example.test", "127.0.0.1", "a"];
    for (const host of accepted) {
      const { reply, socket } = await rawSocksConnect(port, host, echo.port);
      socket.destroy();
      assert.equal(reply[1], 0x00, `host ${JSON.stringify(host)} should have been allowed`);
    }

    const seen = upstream.requests.join(LF);
    assert.equal(seen.includes("X-Injected"), false);
    assert.equal(seen.includes("X: 1"), false);
  } finally {
    await stopBridgeForProfile(profileId);
    await upstream.close();
    await echo.close();
  }
});
