import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Relay activation writes the stable runtime before Browser's download index exists. */
export async function findActivatedWindowsEngine(
  cacheDir: string,
  pin: { version: string } | null,
  platform: NodeJS.Platform = process.platform,
): Promise<{ version: string; binaryPath: string } | null> {
  if (platform !== "win32" || !pin?.version) return null;
  try {
    const runtime = join(cacheDir, "runtime");
    const metadata: unknown = JSON.parse(
      await readFile(join(runtime, ".mkt-runtime.json"), "utf8"),
    );
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !("version" in metadata) ||
      metadata.version !== pin.version
    )
      return null;
    const binaryPath = join(runtime, "chrome.exe");
    const binary = await stat(binaryPath);
    if (!binary.isFile() || binary.size === 0) return null;
    return { version: pin.version, binaryPath };
  } catch {
    return null;
  }
}
