#!/usr/bin/env node
"use strict";

/*
 * Release provenance for one attested installer.
 *
 * V1 ships unsigned by owner decision, so nothing in the installer file identifies who produced it.
 * The published SHA-256 and this record are therefore the only origin evidence there is, which
 * raises rather than lowers the bar for what has to be written down.
 *
 * The record answers one question: given this exact file, what produced it and what is inside it.
 * Every value here is read from the tree or the artifact, never passed in as a claim, except the
 * dependency-audit verdict, which the caller supplies from the audit it actually ran.
 *
 * Scope note, stated rather than implied: `dependencyInventory` is the packaged production
 * dependency set with the versions resolved for this build. It is a component list, not a CycloneDX
 * or SPDX document, and it is not described as one anywhere it is consumed.
 */

const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

/**
 * Shelf life of one unsigned artifact, counted from the build that produced it.
 *
 * The wire field is `signing.exceptionExpiresAt` and the R2 metadata key is
 * `signing-exception-expires-at`, both of which read as though they date the owner's decision to
 * ship unsigned. They do not, and the difference decides whether the mechanism can ever fire.
 *
 * What this actually expresses, confirmed by the owner on 13 September 2026: each published
 * installer stops being downloadable this many days after it was built. The metadata travels on the
 * individual R2 object, so an old artifact expires on its own schedule while newer ones keep their
 * full window. That is a staleness control on artifacts -- it forces a stale build to be rebuilt,
 * re-verified and re-published rather than served indefinitely on an unsigned binary nobody has
 * looked at in months.
 *
 * It is deliberately NOT a deadline for the unsigned-shipping decision. Such a deadline would have
 * to be an absolute date anchored to that decision; this window resets on every build by design.
 * Both the publisher (`publish-windows-installer.ts`) and the download route fail closed once it
 * passes, so the rolling window is the only thing keeping a published installer available.
 */
const UNSIGNED_ARTIFACT_USABLE_DAYS = 60;

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function readJsonPath(filePath) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function sha256OfFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * The commit is what a person quotes; the tree is what actually determines the bytes. Two commits
 * with different messages and the same tree produce the same artifact, so both are recorded and the
 * tree is the one the artifact is bound to.
 */
function frozenSource() {
  return {
    commit: process.env.GITHUB_SHA || git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    branch: process.env.GITHUB_REF_NAME || git("rev-parse", "--abbrev-ref", "HEAD"),
    // A dirty tree cannot be attested: the artifact would not correspond to any committed state.
    clean: git("status", "--porcelain") === "",
  };
}

/** Versions resolved for the packaged production dependencies declared in electron-builder.yml. */
function dependencyInventory() {
  const builderConfig = readFileSync(path.join(repoRoot, "apps/desktop/electron-builder.yml"), "utf8");
  const block = builderConfig.split(/^\s*dependencies:\s*$/m)[1];
  if (!block) throw new Error("electron-builder.yml no longer declares a packaged dependency block.");

  const declared = [];
  for (const line of block.split("\n")) {
    if (/^\s*$/.test(line)) continue;
    const match = line.match(/^\s{4}"?([^":\s]+)"?:\s*"([^"]+)"\s*$/);
    if (!match) break; // End of the indented block.
    declared.push({ name: match[1], range: match[2] });
  }
  if (declared.length === 0) throw new Error("Packaged dependency block parsed as empty.");

  const lockfile = readFileSync(path.join(repoRoot, "yarn.lock"), "utf8");
  const unresolved = [];
  const inventory = declared.map(({ name, range }) => {
    // Yarn 4 lockfile entries look like `"name@npm:range":` followed by a `version:` line. The
    // line ending is deliberately `\r?\n`: this file is checked out with CRLF on Windows, and the
    // first version of this pattern required a bare newline, matched nothing, and produced an
    // inventory of eleven nulls that still looked like a complete record.
    const escaped = `${name}@npm:${range}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const entry = new RegExp(`${escaped}[^\\n]*:\\r?\\n(?:[ \\t]+.*\\r?\\n)*?[ \\t]+version:[ \\t]*(\\S+)`);
    const match = lockfile.match(entry);
    if (!match) unresolved.push(`${name}@${range}`);
    return { name, range, resolved: match ? match[1] : null };
  });

  // A provenance record whose component versions are null is worse than no record: it has the shape
  // of evidence without the content, and it is the shape a reader trusts.
  if (unresolved.length > 0) {
    throw new Error(
      `Could not resolve packaged dependency versions from yarn.lock: ${unresolved.join(", ")}. ` +
        `Provenance is not emitted with unknown component versions.`,
    );
  }
  return inventory;
}

function buildProvenance({
  installerPath,
  payloadManifestPath,
  dependencyAudit,
  engineReleasePath = process.env.MKT_BROWSER_ENGINE_RELEASE_FILE || "apps/desktop/windows-engine-release.json",
  candidateId = process.env.MKT_RELEASE_CANDIDATE_ID?.trim() || null,
}) {
  const installerStats = statSync(installerPath);
  const payloadManifest = JSON.parse(readFileSync(payloadManifestPath, "utf8"));
  const desktopPackage = readJson("apps/desktop/package.json");
  const generatedAt = new Date();
  const artifactUsableUntil = new Date(
    generatedAt.getTime() + UNSIGNED_ARTIFACT_USABLE_DAYS * 24 * 60 * 60 * 1000,
  );

  return {
    schemaVersion: 1,
    type: "mktbrowser.release-provenance",
    generatedAt: generatedAt.toISOString(),
    signing: {
      authenticode: false,
      status: "unsigned-internal-exception",
      exceptionExpiresAt: artifactUsableUntil.toISOString(),
      allowedLanes: ["A", "B"],
      // Written here rather than left as an absence, so a reader never has to decide whether the
      // missing signature was a decision or an oversight.
      note:
        "V1 ships unsigned by owner decision reaffirmed on 22 August 2026. Windows publisher " +
        "verification is unavailable, so the published installerSha256 below and the distribution " +
        "channel are the only origin evidence. Onboarding must announce SmartScreen in advance. " +
        `exceptionExpiresAt is this artifact's shelf life: it expires ${UNSIGNED_ARTIFACT_USABLE_DAYS} ` +
        "days after this build, not on a fixed date, and it does not express a deadline for the " +
        "unsigned-shipping decision itself.",
    },
    source: frozenSource(),
    // The candidate id is supplied by the release manifest, never inferred from a filename. Keep it
    // nullable while a dirty/local build is being inspected; the publisher requires it before R2.
    candidateId,
    product: {
      version: desktopPackage.version,
      electron: desktopPackage.devDependencies?.electron ?? null,
      node: process.version,
    },
    installer: {
      fileName: path.basename(installerPath),
      sizeBytes: installerStats.size,
      // The value published to operators and checked on the receiving machine before first install.
      installerSha256: sha256OfFile(installerPath),
    },
    payload: {
      manifestSha256: payloadManifest.manifestSha256,
      fileCount: payloadManifest.fileCount,
    },
    relay: readJson("apps/desktop/relay-release.json"),
    // Use the same explicit engine manifest that packaging consumed. A caller that packages an
    // externally pinned engine must not accidentally attest the repository's default manifest.
    engine: readJsonPath(engineReleasePath),
    dependencyAudit,
    dependencyInventory: dependencyInventory(),
    workflow: process.env.GITHUB_RUN_ID
      ? {
          repository: process.env.GITHUB_REPOSITORY,
          runId: process.env.GITHUB_RUN_ID,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT,
          runnerImage: process.env.ImageOS ?? null,
        }
      : null,
  };
}

function parseArguments(argv) {
  const options = {
    installerPath: null,
    payloadManifestPath: null,
    output: null,
    dependencyAudit: null,
    engineReleasePath: null,
    candidateId: null,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (!value) throw new Error(`Missing value for ${name}`);
    if (name === "--installer") options.installerPath = value;
    else if (name === "--payload-manifest") options.payloadManifestPath = value;
    else if (name === "--output") options.output = value;
    else if (name === "--dependency-audit") options.dependencyAudit = value;
    else if (name === "--engine-release") options.engineReleasePath = value;
    else if (name === "--candidate-id") options.candidateId = value;
    else throw new Error(`Unknown option: ${name}`);
  }
  for (const required of ["installerPath", "payloadManifestPath", "output"]) {
    if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  return options;
}

module.exports = { buildProvenance, dependencyInventory, parseArguments };

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const provenance = buildProvenance({
      installerPath: options.installerPath,
      payloadManifestPath: options.payloadManifestPath,
      dependencyAudit: options.dependencyAudit ?? "not-recorded",
      engineReleasePath: options.engineReleasePath ?? undefined,
      candidateId: options.candidateId ?? undefined,
    });
    if (!provenance.source.clean) {
      throw new Error(
        "The working tree has uncommitted changes, so this artifact corresponds to no committed " +
          "state and cannot be attested. Commit or stash, then rebuild.",
      );
    }
    writeFileSync(options.output, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
    process.stdout.write(
      `Release provenance written.\n  tree      ${provenance.source.tree}\n` +
        `  installer ${provenance.installer.installerSha256}\n` +
        `  payload   ${provenance.payload.manifestSha256}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
