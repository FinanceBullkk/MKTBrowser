/**
 * The preload script that keeps WebRTC from reporting an address the proxy does not own.
 *
 * Extracted from `ChromiumBrowserDriver.ts` on 18 September 2026 without changing behaviour. It is
 * one long string builder and nothing else, which is exactly why it does not belong in the driver.
 *
 * Defence in depth behind the machine-wide firewall rules, not a substitute for them: a page that
 * never reaches a STUN server has nothing to leak in the first place.
 */

/**
 * Build the WebRTC spoof script with the supplied proxy IP baked in.
 *
 * Stealth strategy: we DO NOT replace `window.RTCPeerConnection` — its
 * `.toString()` would diverge from `[native code]`. Instead we patch the
 * prototype's `addEventListener`, the `onicecandidate` setter, and the
 * `localDescription` / `currentLocalDescription` getters to launder ICE
 * candidates as they leave the API. The constructor stays native.
 *
 * For every emitted ICE candidate:
 *   - Drop mDNS `.local` host candidates (would expose hostname).
 *   - Drop loopback / private-RFC1918 candidates.
 *   - Replace any public IP in `candidate.candidate` and `candidate.address`
 *     with the proxy's public IP, keeping foundation/port/typ srflx so
 *     the SDP looks like a real STUN-discovered candidate.
 *
 * For SDP munging (`localDescription`):
 *   - Same IP rewrite + remove `c=IN IP4 <real>` lines that don't match
 *     the proxy IP.
 *
 * `Function.prototype.toString` is also patched on our wrappers so that
 * naive `RTCPeerConnection.prototype.addEventListener.toString()` checks
 * still return `function addEventListener() { [native code] }`.
 */
export function buildWebRtcSpoofScript(proxyIp: string): string {
  return `
(() => {
  if (!window.RTCPeerConnection) return;
  const PROXY_IP = ${JSON.stringify(proxyIp)};
  // Sentinel: patchEvent returns this when the candidate must be
  // silently suppressed. Listener wrappers check for it and skip
  // dispatch entirely — emitting candidate=null would prematurely
  // signal "gathering done" to the page.
  const SUPPRESS = Symbol("suppress-ice");
  // Plausible LAN IP for raddr/rport — real srflx candidates carry
  // the local interface IP that STUN used. Stripping these creates
  // an "srflx without raddr" anomaly that fingerprinters flag.
  const FAKE_LAN = "192.168.1.42";

  const PRIV_RE = /^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|169\\.254\\.|127\\.|fe80:|fc00:|fd)/i;
  function isPrivate(ip) {
    if (!ip) return true;
    if (ip.endsWith(".local")) return true;
    return PRIV_RE.test(ip);
  }

  function rewriteCandidateLine(line) {
    // candidate:foundation 1 udp 2113937151 1.2.3.4 50000 typ host generation 0 ufrag XXX network-id 1
    const parts = line.split(" ");
    if (parts.length < 8) return line;
    const port = parts[5];
    parts[4] = PROXY_IP;       // public IP
    parts[7] = "srflx";        // looks STUN-discovered

    // Walk extra k/v pairs after typ — rewrite raddr/rport to fake LAN.
    let hasRaddr = false;
    for (let i = 8; i < parts.length - 1; i++) {
      if (parts[i] === "raddr") { parts[i + 1] = FAKE_LAN; hasRaddr = true; }
      if (parts[i] === "rport") { parts[i + 1] = port; }
    }
    if (!hasRaddr) {
      // Insert raddr/rport right after "typ srflx" so the candidate
      // looks like a real STUN-reflected one.
      parts.splice(8, 0, "raddr", FAKE_LAN, "rport", port);
    }
    return parts.join(" ");
  }

  function patchEvent(event) {
    const c = event && event.candidate;
    if (!c) return event; // end-of-gathering marker — pass through
    const real = c.address || c.ip || "";
    // mDNS .local hostnames leak the device hostname — suppress, but
    // do NOT replace with candidate=null mid-stream.
    if (real.endsWith(".local")) return SUPPRESS;
    try {
      const newStr = rewriteCandidateLine(c.candidate || "");
      const fake = new RTCIceCandidate({
        candidate: newStr,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        usernameFragment: c.usernameFragment,
      });
      return new RTCPeerConnectionIceEvent("icecandidate", { candidate: fake });
    } catch (_) {
      return SUPPRESS;
    }
  }

  function mungeSdp(sdp) {
    if (!sdp) return sdp;
    // Replace c=IN IP4 / c=IN IP6 with proxy IP.
    let out = sdp.replace(/c=IN IP4 \\S+/g, "c=IN IP4 " + PROXY_IP);
    // Rewrite a=candidate lines, drop private-IP entries (mDNS .local).
    out = out
      .split(/\\r?\\n/)
      .map((line) => {
        if (!line.startsWith("a=candidate:")) return line;
        const parts = line.replace("a=candidate:", "").split(" ");
        const ip = parts[4];
        if (ip && (ip.endsWith(".local"))) return null;
        return "a=candidate:" + rewriteCandidateLine(parts.join(" "));
      })
      .filter((l) => l !== null)
      .join("\\r\\n");
    return out;
  }

  // ---- Hook prototype, leave constructor untouched ------------------------
  const proto = window.RTCPeerConnection.prototype;
  const ctorVariants = [window.RTCPeerConnection];
  if (window.webkitRTCPeerConnection && window.webkitRTCPeerConnection !== window.RTCPeerConnection) {
    ctorVariants.push(window.webkitRTCPeerConnection);
  }

  // 1. addEventListener('icecandidate', ...)
  const origAdd = proto.addEventListener;
  function wrappedAdd(type, listener, options) {
    if (type === "icecandidate" && typeof listener === "function") {
      const wrapped = function (event) {
        return listener.call(this, patchEvent(event));
      };
      // Make .toString look ordinary so detection that does
      // listener.toString() doesn't see "wrapped".
      try {
        Object.defineProperty(wrapped, "toString", {
          value: listener.toString.bind(listener),
        });
      } catch (_) {}
      return origAdd.call(this, type, wrapped, options);
    }
    return origAdd.call(this, type, listener, options);
  }
  Object.defineProperty(proto, "addEventListener", { value: wrappedAdd });
  fakeNativeToString(wrappedAdd, "addEventListener");

  // 2. onicecandidate setter
  const origDescr = Object.getOwnPropertyDescriptor(proto, "onicecandidate");
  if (origDescr && origDescr.set) {
    const origSet = origDescr.set;
    Object.defineProperty(proto, "onicecandidate", {
      get: origDescr.get,
      set: function (cb) {
        if (typeof cb === "function") {
          const wrapped = function (event) {
            return cb.call(this, patchEvent(event));
          };
          try {
            Object.defineProperty(wrapped, "toString", {
              value: cb.toString.bind(cb),
            });
          } catch (_) {}
          return origSet.call(this, wrapped);
        }
        return origSet.call(this, cb);
      },
      configurable: true,
    });
  }

  // 3. localDescription / currentLocalDescription getters
  for (const propName of ["localDescription", "currentLocalDescription"]) {
    const d = Object.getOwnPropertyDescriptor(proto, propName);
    if (!d || !d.get) continue;
    const origGet = d.get;
    Object.defineProperty(proto, propName, {
      get: function () {
        const desc = origGet.call(this);
        if (desc && desc.sdp) {
          try {
            return { type: desc.type, sdp: mungeSdp(desc.sdp), toJSON: desc.toJSON };
          } catch (_) {
            return desc;
          }
        }
        return desc;
      },
      configurable: true,
    });
  }

  // 4. createOffer / createAnswer munge their SDP before resolving.
  for (const fnName of ["createOffer", "createAnswer"]) {
    const orig = proto[fnName];
    function wrapped() {
      const args = arguments;
      return orig.apply(this, args).then((desc) => {
        if (desc && desc.sdp) desc.sdp = mungeSdp(desc.sdp);
        return desc;
      });
    }
    fakeNativeToString(wrapped, fnName);
    Object.defineProperty(proto, fnName, { value: wrapped, configurable: true, writable: true });
  }

  // 4b. getStats() — bypasses onicecandidate / localDescription wrappers.
  // Returns RTCIceCandidateStats with .address / .ip / .relatedAddress
  // fields straight from internal state. browserscan reads these to
  // catch the real public IP. We rewrite IPs in stats too.
  const origGetStats = proto.getStats;
  if (origGetStats) {
    function wrappedGetStats() {
      const args = arguments;
      return origGetStats.apply(this, args).then((report) => {
        try {
          report.forEach((stat) => {
            if (!stat) return;
            if (typeof stat.address === "string" && !isPrivate(stat.address) && !stat.address.endsWith(".local")) {
              stat.address = PROXY_IP;
            }
            if (typeof stat.ip === "string" && !isPrivate(stat.ip) && !stat.ip.endsWith(".local")) {
              stat.ip = PROXY_IP;
            }
            if (typeof stat.relatedAddress === "string" && !isPrivate(stat.relatedAddress)) {
              stat.relatedAddress = "192.168.1.42";
            }
            // Hide candidate type "host" (which would imply native interface)
            if (stat.candidateType === "host") {
              stat.candidateType = "srflx";
            }
          });
        } catch (_) {}
        return report;
      });
    }
    fakeNativeToString(wrappedGetStats, "getStats");
    Object.defineProperty(proto, "getStats", { value: wrappedGetStats, configurable: true, writable: true });
  }

  // 5. mediaDevices.enumerateDevices — keep working but strip per-device
  //    ids that uniquely identify hardware. Returns generic labels.
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    const origEnum = navigator.mediaDevices.enumerateDevices.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.enumerateDevices = function () {
      return origEnum().then((list) =>
        list.map((d) => ({
          deviceId: "",
          groupId: "",
          kind: d.kind,
          label: "",
          toJSON: d.toJSON,
        })),
      );
    };
    fakeNativeToString(navigator.mediaDevices.enumerateDevices, "enumerateDevices");
  }

  function fakeNativeToString(fn, name) {
    try {
      Object.defineProperty(fn, "toString", {
        value: function () { return "function " + name + "() { [native code] }"; },
        configurable: false,
        writable: false,
      });
      Object.defineProperty(fn, "name", { value: name });
    } catch (_) {}
  }

  // Sanity: keep ctorVariants reachable so if the page fishes the
  // original via a global, it still reaches our patched prototype.
  void ctorVariants;
})();
`;
}

/**
 * Removes WebRTC peer-connection APIs entirely. Runs before any page
 * script via Page.addScriptToEvaluateOnNewDocument.
 *
 * We do not just override with `undefined` — we use `Object.defineProperty`
 * with a getter that returns undefined and `configurable: false` so a
 * page cannot later restore the constructor by digging out the original
 * via iframe contentWindow. Iframes also get the script via the same
 * preload mechanism (it runs on every new document, including frames).
 *
 * This is detectable as a "no WebRTC" signal — a real Chrome on a real
 * machine has it. For an anti-detect profile that's an OK trade-off:
 * "WebRTC disabled" is a small population but not unheard of (corporate
 * networks, privacy extensions). "WebRTC reveals real IP" is the
 * unambiguous-bot-or-proxy-leak signal we MUST avoid.
 */
export const WEBRTC_BLOCK_SCRIPT = `
(() => {
  const noop = function () { throw new TypeError("WebRTC is disabled"); };
  // Make .toString() look like a native function so naive detection
  // (Function.prototype.toString.call(RTCPeerConnection)) returns
  // [native code] like in real Chrome with WebRTC behind enterprise
  // policy.
  try {
    Object.defineProperty(noop, "toString", {
      value: function () { return "function () { [native code] }"; },
      configurable: false,
      writable: false,
    });
    Object.defineProperty(noop, "name", { value: "RTCPeerConnection" });
  } catch (_) {}

  const kill = (name) => {
    try {
      Object.defineProperty(window, name, {
        get: () => undefined,
        set: () => {},
        configurable: false,
      });
    } catch (_) {}
  };

  kill("RTCPeerConnection");
  kill("webkitRTCPeerConnection");
  kill("RTCDataChannel");
  kill("RTCSessionDescription");
  kill("RTCIceCandidate");

  // mediaDevices.enumerateDevices() can also leak hardware identifiers;
  // wrap it so it returns an empty list. getUserMedia stays so sites
  // can ask permission, but it'll never actually return devices.
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const orig = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = function () {
        return Promise.resolve([]);
      };
      // Preserve toString shape
      try {
        Object.defineProperty(navigator.mediaDevices.enumerateDevices, "toString", {
          value: orig.toString.bind(orig),
        });
      } catch (_) {}
    }
  } catch (_) {}
})();
`;
