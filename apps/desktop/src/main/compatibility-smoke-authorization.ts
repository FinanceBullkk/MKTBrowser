import { lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { win32 } from "node:path";
import { compatibilityUpdaterRoot } from "./compatibility-engine-pin.ts";

export const COMPATIBILITY_SMOKE_SWITCH = "mkt-compatibility-smoke";
export const COMPATIBILITY_SMOKE_PROFILE_TAG = "mkttool-compatibility-smoke";

const AUTHORIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_AUTHORIZATION_LIFETIME_MS = 2 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;

export interface CompatibilitySmokeAuthorization {
  schemaVersion: 1;
  type: "mkttool.compatibility-smoke-authorization";
  authorizationId: string;
  sequence: number;
  manifestDigest: string;
  profileId: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ClaimedCompatibilitySmokeAuthorization {
  authorization: CompatibilitySmokeAuthorization;
  consumedPath: string;
}

export function claimCompatibilitySmokeAuthorization(options: {
  localAppData: string;
  authorizationId: string;
  now?: Date;
}): ClaimedCompatibilitySmokeAuthorization {
  const authorizationId = options.authorizationId.trim().toLowerCase();
  if (!AUTHORIZATION_ID.test(authorizationId)) {
    throw new Error("The compatibility smoke authorization id is invalid.");
  }

  const directory = win32.join(
    compatibilityUpdaterRoot(options.localAppData),
    "smoke-authorizations",
  );
  const pendingPath = win32.join(directory, `${authorizationId}.json`);
  const consumedPath = win32.join(directory, `${authorizationId}.consumed.json`);
  assertRegularFile(pendingPath, "authorization");
  renameSync(pendingPath, consumedPath);

  try {
    const authorization = parseAuthorization(
      JSON.parse(readFileSync(consumedPath, "utf8")),
      authorizationId,
      options.now ?? new Date(),
    );
    assertMatchingSmokeMarker(options.localAppData, authorization);
    return { authorization, consumedPath };
  } catch (error) {
    throw new Error(`Compatibility smoke authorization rejected: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

export function clearClaimedCompatibilitySmokeAuthorization(consumedPath: string): void {
  rmSync(consumedPath, { force: true });
}

function parseAuthorization(
  value: unknown,
  expectedId: string,
  now: Date,
): CompatibilitySmokeAuthorization {
  if (!value || typeof value !== "object") throw new Error("invalid authorization shape");
  const authorization = value as Partial<CompatibilitySmokeAuthorization>;
  const issuedAt = Date.parse(authorization.issuedAt ?? "");
  const expiresAt = Date.parse(authorization.expiresAt ?? "");
  if (
    authorization.schemaVersion !== 1 ||
    authorization.type !== "mkttool.compatibility-smoke-authorization" ||
    authorization.authorizationId !== expectedId ||
    !Number.isSafeInteger(authorization.sequence) ||
    Number(authorization.sequence) <= 0 ||
    typeof authorization.manifestDigest !== "string" ||
    !SHA256.test(authorization.manifestDigest) ||
    typeof authorization.profileId !== "string" ||
    authorization.profileId.length === 0 ||
    authorization.profileId.length > 256 ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now.getTime() ||
    issuedAt > now.getTime() + MAX_CLOCK_SKEW_MS ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_AUTHORIZATION_LIFETIME_MS
  ) {
    throw new Error("invalid or expired authorization");
  }
  return authorization as CompatibilitySmokeAuthorization;
}

function assertMatchingSmokeMarker(
  localAppData: string,
  authorization: CompatibilitySmokeAuthorization,
): void {
  const markerPath = win32.join(
    compatibilityUpdaterRoot(localAppData),
    "activation-marker.json",
  );
  assertRegularFile(markerPath, "activation marker");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
    schemaVersion?: unknown;
    sequence?: unknown;
    manifestDigest?: unknown;
    phase?: unknown;
  };
  if (
    marker.schemaVersion !== 1 ||
    marker.sequence !== authorization.sequence ||
    marker.manifestDigest !== authorization.manifestDigest ||
    marker.phase !== "smoke"
  ) {
    throw new Error("activation marker does not authorize this smoke run");
  }
}

function assertRegularFile(filePath: string, label: string): void {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`The compatibility smoke ${label} is not a regular file.`);
  }
}
