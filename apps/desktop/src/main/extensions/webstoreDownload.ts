import { net } from "electron";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { createNetworkRequestDeadlines } from "../network-request-deadlines.ts";
import { tempCrxPath } from "./crxPipeline.ts";

/**
 * Parse a Chrome Web Store URL (or a bare ID) into the 32-char extension ID.
 * Accepts:
 *   https://chromewebstore.google.com/detail/<slug>/<id>?...
 *   https://chrome.google.com/webstore/detail/<slug>/<id>
 *   <id>
 */
export function parseExtensionId(urlOrId: string): string {
  const s = urlOrId.trim();
  // Bare ID.
  if (/^[a-p]{32}$/.test(s)) return s;
  // Prefer the canonical /detail/<slug>/<id> segment so a long lowercase slug
  // can't be mistaken for the ID.
  const detail = /\/detail\/[^/]+\/([a-p]{32})/.exec(s);
  if (detail?.[1]) return detail[1];
  // Fallback: any 32-char a–p run.
  const any = /([a-p]{32})/.exec(s);
  if (any?.[1]) return any[1];
  throw new Error("Couldn't find a Chrome extension ID in that input.");
}

/**
 * Download an extension's `.crx` by ID from Google's update endpoint (the same
 * endpoint the browser uses), following the redirect to the CDN, and write it
 * to a temp file. Returns the temp file path (caller unpacks then deletes it).
 *
 * `prodversion` must be a real Chromium version matching the engine (e.g.
 * "145.0.7632.109") — stale/sentinel versions can 404.
 *
 * Note: this hits Google's own CRX endpoint on the user's behalf (user-initiated
 * install). It's a grey area in Google's ToS; the file-upload path is the
 * always-available alternative.
 */
export async function downloadCrxById(id: string, prodversion: string): Promise<string> {
  const url =
    `https://clients2.google.com/service/update2/crx?response=redirect` +
    `&acceptformat=crx2,crx3&prodversion=${encodeURIComponent(prodversion)}` +
    `&x=${encodeURIComponent(`id=${id}&installsource=ondemand&uc`)}`;

  const outPath = tempCrxPath();

  await new Promise<void>((resolve, reject) => {
    let out: ReturnType<typeof createWriteStream> | null = null;
    let settled = false;
    let responseEnded = false;
    let deadlines: ReturnType<typeof createNetworkRequestDeadlines> | null = null;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      deadlines?.complete();
      if (out) {
        out.destroy();
        out = null;
      }
      reject(err);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      deadlines?.complete();
      resolve();
    };

    const request = net.request({ method: "GET", url, redirect: "follow" });
    deadlines = createNetworkRequestDeadlines({
      label: `Web Store extension ${id} download`,
      abort: () => request.abort(),
      onTimeout: fail,
    });
    request.on("error", (error) => {
      if (!responseEnded) fail(error);
    });
    request.on("response", (response) => {
      if (settled) {
        response.on("data", () => {});
        return;
      }
      deadlines?.responseStarted();
      const status = response.statusCode;
      // 204 (and sometimes an empty 200) means the endpoint has no CRX for this
      // ID — delisted, geo-blocked, or never existed. Surface a clear message
      // rather than writing a 0-byte file that later fails as "corrupt zip".
      if (status === 204) {
        response.on("data", () => {});
        fail(new Error(`Extension ${id} isn't available from the Web Store (it may be delisted or region-restricted). Try uploading the .crx/.zip instead.`));
        return;
      }
      if (status < 200 || status >= 300) {
        response.on("data", () => {});
        fail(new Error(`HTTP ${status} downloading extension ${id} from the Web Store.`));
        return;
      }
      let received = 0;
      const stream = createWriteStream(outPath);
      out = stream;
      stream.on("error", fail);
      const flow = response as unknown as { pause?: () => void; resume?: () => void };
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        deadlines?.bodyActivity();
        received += chunk.length;
        if (!stream.write(chunk) && flow.pause && flow.resume) {
          flow.pause();
          stream.once("drain", () => {
            if (settled) return;
            deadlines?.bodyActivity();
            flow.resume!();
          });
        }
      });
      response.on("error", fail);
      response.on("end", () => {
        responseEnded = true;
        deadlines?.finalizationStarted();
        stream.once("close", () => {
          out = null;
          // An empty (or absurdly tiny) body means "no CRX" even on a 200.
          if (received < 16) {
            fail(
              new Error(
                `Extension ${id} isn't available from the Web Store (empty response). Try uploading the .crx/.zip instead.`,
              ),
            );
            return;
          }
          succeed();
        });
        try {
          stream.end();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    try {
      request.end();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }).catch(async (e) => {
    await rm(outPath, { force: true }).catch(() => {});
    throw e as Error;
  });

  return outPath;
}
