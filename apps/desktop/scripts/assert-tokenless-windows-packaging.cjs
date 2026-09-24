#!/usr/bin/env node

const releaseToken = (process.env.MKTTOOL_RELEASE_TOKEN ?? "").trim();

if (releaseToken) {
  process.stderr.write(
    "Refusing direct Windows packaging while the Relay release token is present. Use the tokenized CMD wrapper.\n",
  );
  process.exitCode = 1;
}
