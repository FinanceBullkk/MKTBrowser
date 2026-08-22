import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseLicenseLeaseJournal,
  type LicenseLeaseJournalData,
  type LicenseLeaseRecord,
} from "./license-lease-journal-schema.ts";

export async function loadLicenseLeaseRecords(filePath: string): Promise<LicenseLeaseRecord[]> {
  try {
    return parseLicenseLeaseJournal(await readFile(filePath, "utf8")).records;
  } catch (currentError) {
    const backupPath = `${filePath}.previous`;
    try {
      const records = parseLicenseLeaseJournal(await readFile(backupPath, "utf8")).records;
      await copyFile(backupPath, filePath);
      return records;
    } catch (backupError) {
      if (
        (currentError as NodeJS.ErrnoException).code !== "ENOENT" ||
        (backupError as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw currentError;
      }
      return [];
    }
  }
}

export async function persistLicenseLeaseRecords(
  filePath: string,
  records: readonly LicenseLeaseRecord[],
): Promise<void> {
  const data: LicenseLeaseJournalData = {
    schemaVersion: 1,
    records: records.map((record) => ({ ...record })),
  };
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    await copyFile(filePath, `${filePath}.previous`).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
