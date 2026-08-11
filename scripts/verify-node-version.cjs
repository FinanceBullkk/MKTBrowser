#!/usr/bin/env node

const REQUIRED_NODE_MAJOR = 22;

function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(version.split(".")[0], 10);
  if (major !== REQUIRED_NODE_MAJOR) {
    throw new Error(
      `MKT Browser builds require Node.js ${REQUIRED_NODE_MAJOR}. Current runtime: ${version}. ` +
        "Switch Node versions before running the build so native modules keep the expected ABI.",
    );
  }
}

if (require.main === module) {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { REQUIRED_NODE_MAJOR, assertSupportedNodeVersion };
