const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { inspectExecutable } = require("./fingerprint-measurement-cdp.cjs");

const execFileAsync = promisify(execFile);

async function collectArtifactEvidence(repositoryRoot, executable) {
  const appAsar = path.join(path.dirname(executable), "resources", "app.asar");
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const [{ stdout: head }, { stdout: status }, executableInfo] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }),
    execFileAsync("git", ["status", "--porcelain=v1"], { cwd: repositoryRoot, encoding: "utf8" }),
    inspectExecutable(executable),
  ]);
  return {
    browserHead: head.trim(),
    sourceDirty: Boolean(status.trim()),
    sourceStatusSha256: sha256Text(status),
    executableVersion: executableInfo.version,
    executableSha256: executableInfo.sha256,
    appAsarSha256: await sha256File(appAsar),
    yarnLockSha256: await sha256File(path.join(repositoryRoot, "yarn.lock")),
    packageManager: packageJson.packageManager,
  };
}

async function collectShutdownEvidence(userData, profileId, requestedAt) {
  try {
    const records = (await readFile(path.join(userData, "profile-shutdown.log"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) =>
        record.profileId === profileId &&
        Date.parse(record.timestamp) >= Date.parse(requestedAt),
      );
    const completed = records.findLast((record) => record.reason === "SHUTDOWN-COMPLETE");
    const childExit = records.findLast((record) => record.reason === "CHILD-EXIT");
    const allowedMethods = new Set(["already-exited", "Browser.close", "SIGTERM", "SIGKILL"]);
    return {
      completed: Boolean(completed),
      shutdownMethod: allowedMethods.has(completed?.shutdownMethod)
        ? completed.shutdownMethod
        : null,
      childExitObserved: Boolean(childExit),
      childExitCode: Number.isInteger(childExit?.exitCode) ? childExit.exitCode : null,
      childExitSignalled: typeof childExit?.signal === "string" && childExit.signal.length > 0,
    };
  } catch {
    return null;
  }
}

async function createExclusiveReceipt(output, initial) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(initial, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  return async (value) => {
    await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flush: true,
    });
  };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  await new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

const LICENCE_EXIT_CODES = {
  LICENSE_SESSION_LIMIT: 76,
  LICENSE_KEY_INVALID: 77,
  LICENSE_SERVER_UNREACHABLE: 78,
  LICENSE_LOCAL_STATE_NOT_WRITABLE: 79,
};

const ADMISSION_FAILURE_MESSAGES = [
  ["Another browser availability check is already running. Try once after it finishes.", "ADMISSION_BUSY"],
  ["No CloakBrowser licence key is configured on this PC.", "NO_LICENSE_KEY"],
  ["A browser profile is already open. Close it before opening another profile.", "LOCAL_SESSION_ACTIVE"],
  ["MKT Browser is recovering a prior browser session. Finish recovery before trying once.", "LOCAL_RECOVERY_PENDING"],
  ["Local browser capacity is still cooling. Check availability before trying once.", "LOCAL_CAPACITY_UNAVAILABLE"],
  ["Browser state changed while availability was checked. Check again before trying once.", "LOCAL_STATE_CHANGED"],
  ["The licence provider reports that all session capacity is in use.", "VENDOR_CAPACITY_OCCUPIED"],
  ["The licence provider denied the capacity check. Verify the configured licence.", "VENDOR_ACCESS_DENIED"],
  ["The licence provider rate-limited the capacity check. Wait before checking again.", "VENDOR_RATE_LIMITED"],
  ["The licence provider returned an unreadable capacity response.", "VENDOR_RESPONSE_MALFORMED"],
  ["The licence provider did not answer the capacity check in time.", "VENDOR_REQUEST_TIMEOUT"],
  ["The licence provider could not be reached to verify capacity.", "VENDOR_UNREACHABLE"],
  ["MKT Browser could not durably record licence capacity state.", "JOURNAL_PERSISTENCE_FAILED"],
];

function normalizeAdmissionFailure(message) {
  const normalized = String(message).toLocaleLowerCase("en-US");
  for (const [operatorMessage, reason] of ADMISSION_FAILURE_MESSAGES) {
    if (normalized.includes(operatorMessage.toLocaleLowerCase("en-US"))) return reason;
  }
  return null;
}

function normalizeLicenceFailure(message) {
  if (/session limit|plan's session limit|seat (?:is )?(?:busy|reached)|capacity (?:is )?(?:occupied|unavailable)/i.test(message)) {
    return "LICENSE_SESSION_LIMIT";
  }
  if (/licen[cs]e key[^.\n]*(?:missing|invalid|expired)/i.test(message)) {
    return "LICENSE_KEY_INVALID";
  }
  if (
    /licen[cs]e server[^.\n]*(?:could not be reached|unreachable)/i.test(message) ||
    /couldn't verify (?:your )?licen[cs]e|connection problem/i.test(message)
  ) {
    return "LICENSE_SERVER_UNREACHABLE";
  }
  if (
    /local (?:licen[cs]e )?(?:state|configuration)[^.\n]*(?:not writable|problem)/i.test(message) ||
    /\.cloakbrowser[^.\n]*not writable/i.test(message)
  ) {
    return "LICENSE_LOCAL_STATE_NOT_WRITABLE";
  }
  return null;
}

function classifyFailure(error) {
  const message = errorMessages(error).join("\n");
  if (
    normalizeAdmissionFailure(message) ||
    normalizeLicenceFailure(message) ||
    /capacity|seat|session limit|ENGINE_UNAVAILABLE/i.test(message)
  ) {
    return "CAPACITY_OR_LICENCE_REFUSAL";
  }
  if (/timeout|timed out/i.test(message)) return "TIMEOUT";
  if (/process remained|ownership|wrong profile|more than one/i.test(message)) return "OWNERSHIP_MISMATCH";
  if (/cleanup|remove|exit after close/i.test(message)) return "CLEANUP_FAILED";
  if (/fingerprint/i.test(message)) return "FINGERPRINT_CONFIGURATION_FAILED";
  if (/storage/i.test(message)) return "PROFILE_STORAGE_FAILED";
  return "PRODUCT_PATH_FAILED";
}

function failureEvidence(error, diagnostics = "") {
  const message = errorMessages(error).join("\n");
  const mcpFailure = parseMcpFailure(message);
  const reasonText = [mcpFailure?.message, message].filter(Boolean).join("\n");
  const admissionReason = normalizeAdmissionFailure(reasonText);
  const licenceReason = normalizeLicenceFailure(reasonText);
  const diagnosticExitCodes = [
    ...String(diagnostics).matchAll(/exited code=(76|77|78|79)\b/g),
  ];
  const observedExitCode = diagnosticExitCodes.length > 0
    ? Number(diagnosticExitCodes.at(-1)[1])
    : null;
  const inferredExitCode = licenceReason ? LICENCE_EXIT_CODES[licenceReason] : null;
  const licenseExitCode = observedExitCode ?? inferredExitCode;
  const appDiagnostic = {};
  if (observedExitCode !== null) appDiagnostic.licenceExitObserved = true;
  const endpointReady = String(diagnostics).match(
    /DevTools endpoint ready childPid=(\d+) primaryPid=(\d+)\b/i,
  );
  if (endpointReady) {
    appDiagnostic.devToolsEndpointReady = true;
    appDiagnostic.primaryProcessMatchesSpawnedChild = endpointReady[1] === endpointReady[2];
  } else if (/DevTools endpoint ready/i.test(diagnostics)) {
    appDiagnostic.devToolsEndpointReady = true;
  }
  if (/\bCDP ready\b/i.test(diagnostics)) appDiagnostic.cdpReady = true;

  return {
    category: classifyFailure(error),
    ...(mcpFailure?.code ? { mcpCode: mcpFailure.code } : {}),
    ...(admissionReason ? { admissionReason } : {}),
    ...(licenceReason ? { licenceReason } : {}),
    ...(licenseExitCode !== null ? { licenseExitCode } : {}),
    ...(Object.keys(appDiagnostic).length > 0 ? { appDiagnostic } : {}),
  };
}

function errorMessages(error) {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap((nested) => errorMessages(nested))];
  }
  return [error instanceof Error ? error.message : String(error)];
}

function parseMcpFailure(message) {
  const marker = '{"error":';
  const start = message.indexOf(marker);
  if (start === -1) return null;
  const candidate = balancedJsonObject(message, start);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    const code = parsed?.error?.code;
    const detail = parsed?.error?.message;
    return {
      code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null,
      message: typeof detail === "string" ? detail : null,
    };
  } catch {
    return null;
  }
}

function balancedJsonObject(value, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return value.slice(start, index + 1);
  }
  return null;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${name ?? "end of command"}.`);
    }
    parsed[name.slice(2)] = value;
  }
  return parsed;
}

module.exports = {
  classifyFailure,
  collectArtifactEvidence,
  collectShutdownEvidence,
  createExclusiveReceipt,
  failureEvidence,
  parseArgs,
};
