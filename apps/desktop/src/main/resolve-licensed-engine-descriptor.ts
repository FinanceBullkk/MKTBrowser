/**
 * Resolves the newest licensed CloakBrowser build into the four facts every
 * consumer of it needs: version, archive URL, SHA-256, and byte size.
 *
 * Two callers want exactly this and would otherwise duplicate the guards: the
 * engine pin (which the browser obeys at launch) and the packaged engine
 * release record (which the compatibility manifest is signed over). They differ in
 * what they keep — the pin keeps the URL because it fetches once, the release
 * record drops it because a presigned link cannot be signed into a durable
 * artifact — so the shared part stops here.
 */
import { resolveCloakBrowserProManifest } from "./cloakbrowser-pro-channel.ts";

export interface LicensedEngineDescriptor {
  version: string;
  /** Presigned and short-lived. Usable immediately; never durable. */
  url: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Byte size of the archive, and proof the URL is still fetchable.
 *
 * Both matter. Size is required by every record shape, and the licensed URL is
 * a presigned storage link with an expiry — a caller that writes a pin clears
 * the current runtime BEFORE the replacement downloads, so a dead URL would
 * strand the machine. Checking liveness here keeps that failure ahead of the
 * deletion.
 */
async function measureArchive(url: string): Promise<number> {
  const res = await fetch(url, { headers: { range: "bytes=0-0" } });
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(
      `The licensed archive URL answered HTTP ${res.status}. Refusing to record an engine that cannot be fetched.`,
    );
  }
  // A ranged response reports the full size in content-range's total; a plain
  // 200 means the server ignored the range and content-length is the whole file.
  const total = res.headers.get("content-range")?.split("/")[1];
  const size = Number.parseInt(total ?? res.headers.get("content-length") ?? "", 10);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error("The licensed archive URL reported no usable size.");
  }
  void res.body?.cancel();
  return size;
}

export async function resolveLicensedEngineDescriptor(
  licenseKey: string,
): Promise<LicensedEngineDescriptor> {
  const key = licenseKey.trim();
  if (!key) throw new Error("A CloakBrowser licence key is required to resolve the engine.");

  const manifest = await resolveCloakBrowserProManifest(key);

  // A header-authenticated URL would need its Authorization replayed at
  // download time, which neither the pin nor the release record can carry.
  if (Object.keys(manifest.headers).length > 0) {
    throw new Error(
      "The licensed endpoint returned a header-authenticated URL, which no engine record can carry.",
    );
  }
  if (new URL(manifest.url).protocol !== "https:") {
    throw new Error("The licensed archive URL is not https.");
  }
  if (!manifest.sha256 || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new Error(
      "The licensed channel published no SHA-256 for this build; refusing to record an unverifiable archive.",
    );
  }

  return {
    version: manifest.version,
    url: manifest.url,
    sha256: manifest.sha256,
    sizeBytes: await measureArchive(manifest.url),
  };
}
