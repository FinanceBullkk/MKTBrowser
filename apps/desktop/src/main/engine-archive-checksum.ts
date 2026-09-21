export function requireEngineArchiveSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Engine archive checksum is missing or invalid; download refused.");
  }
  return value.toLowerCase();
}

/** A checksum list is usable only when it identifies the archive unambiguously. */
export function parseEngineArchiveSha256(
  text: string,
  archiveName: string,
  expectedVersion?: string,
): string {
  let selected: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^version=\d+(?:\.\d+){2,4}$/.test(line)) {
      if (expectedVersion && line !== `version=${expectedVersion}`) {
        throw new Error("CloakBrowser SHA256SUMS version does not match the requested engine.");
      }
      continue;
    }
    const entry = /^([a-f0-9]{64})[ \t]+\*?(\S+)$/i.exec(line);
    if (!entry) throw new Error("CloakBrowser SHA256SUMS contains an invalid checksum entry.");
    if (entry[2] !== archiveName) continue;
    if (selected !== undefined) {
      throw new Error("CloakBrowser SHA256SUMS contains duplicate archive checksums.");
    }
    selected = requireEngineArchiveSha256(entry[1]);
  }
  if (!selected) throw new Error(`CloakBrowser SHA256SUMS has no checksum for ${archiveName}.`);
  return selected;
}

export async function fetchEngineArchiveSha256(
  url: string,
  archiveName: string,
  expectedVersion?: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    // Fetch errors can contain signed URLs. Preserve the failure without disclosing credentials.
    throw new Error("Unable to fetch CloakBrowser SHA256SUMS; download refused.");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching CloakBrowser SHA256SUMS; download refused.`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error("Unable to read CloakBrowser SHA256SUMS; download refused.");
  }
  return parseEngineArchiveSha256(text, archiveName, expectedVersion);
}
