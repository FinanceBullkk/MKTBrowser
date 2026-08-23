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

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
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

function buildProvenance({ installerPath, payloadManifestPath, dependencyAudit }) {
  const installerStats = statSync(installerPath);
  const payloadManifest = JSON.parse(readFileSync(payloadManifestPath, "utf8"));
  const desktopPackage = readJson("apps/desktop/package.json");

  return {
    schemaVersion: 1,
    type: "mktbrowser.release-provenance",
    generatedAt: new Date().toISOString(),
    signing: {
      authenticode: false,
      // Written here rather than left as an absence, so a reader never has to decide whether the
      // missing signature was a decision or an oversight.
      note:
        "V1 ships unsigned by owner decision reaffirmed on 22 August 2026. Windows publisher " +
        "verification is unavailable, so the published installerSha256 below and the distribution " +
        "channel are the only origin evidence. Onboarding must announce SmartScreen in advance.",
    },
    source: frozenSource(),
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
    engine: readJson("apps/desktop/windows-engine-release.json"),
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
  const options = { installerPath: null, payloadManifestPath: null, output: null, dependencyAudit: null };
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (!value) throw new Error(`Missing value for ${name}`);
    if (name === "--installer") options.installerPath = value;
    else if (name === "--payload-manifest") options.payloadManifestPath = value;
    else if (name === "--output") options.output = value;
    else if (name === "--dependency-audit") options.dependencyAudit = value;
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
