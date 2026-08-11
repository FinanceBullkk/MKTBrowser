/**
 * Stable failure classification for the MKT Browser MCP contract.
 *
 * Every tool rejection leaves this process carrying a `MktBrowserErrorCode`, so MKTTool and the
 * Relay can branch on the failing layer without matching sentences. Messages stay human-readable
 * for the activity log and remain free to change; the code is the part under contract.
 */

import { z } from "zod";
import {
  FingerprintReconcileError,
  IdempotentProfileCreateConflictError,
} from "@mktbrowser/profile-manager";
import type { MktBrowserErrorCode } from "@mktbrowser/types";

export class MktBrowserToolError extends Error {
  constructor(
    readonly code: MktBrowserErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MktBrowserToolError";
  }
}

/**
 * Raised when a CDP call or URL is refused by a security gate (denylisted method, privileged URL
 * scheme). Distinct from INVALID_INPUT: the request was well-formed and was refused on policy.
 */
export class CdpPolicyError extends MktBrowserToolError {
  constructor(message: string) {
    super("FORBIDDEN", message);
    this.name = "CdpPolicyError";
  }
}

export function profileNotFound(profileId: string): MktBrowserToolError {
  return new MktBrowserToolError("PROFILE_NOT_FOUND", `Profile ${profileId} not found`);
}

export function profileNotRunning(profileId: string): MktBrowserToolError {
  return new MktBrowserToolError(
    "PROFILE_NOT_RUNNING",
    `Profile ${profileId} is not running. Call launch_profile first.`,
  );
}

export function unknownTool(name: string): MktBrowserToolError {
  return new MktBrowserToolError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
}

export function proxyRejected(message: string, options?: { cause?: unknown }): MktBrowserToolError {
  return new MktBrowserToolError("PROXY_REJECTED", message, options);
}

export function engineUnavailable(
  message: string,
  options?: { cause?: unknown },
): MktBrowserToolError {
  return new MktBrowserToolError("ENGINE_UNAVAILABLE", message, options);
}

/**
 * Classify anything that escaped a dispatch case. An unclassified throw becomes INTERNAL_ERROR
 * rather than a guess, so a rise in that code reads as a contract gap worth closing.
 */
export function toErrorCode(error: unknown): MktBrowserErrorCode {
  if (error instanceof MktBrowserToolError) return error.code;
  if (
    error instanceof z.ZodError ||
    error instanceof FingerprintReconcileError ||
    error instanceof IdempotentProfileCreateConflictError
  ) {
    return "INVALID_INPUT";
  }
  return "INTERNAL_ERROR";
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
