# First attested release candidate — 23 August 2026

This record exists so the provenance of the first attested Windows candidate survives. It is
history, not a rollout document: the candidate below has been superseded and must not be
distributed or treated as the current artifact.

## What it was

Produced on 23 August 2026 from frozen commit
`eac77f8fd72707cbb5ad867bb69da4358e8cb6f8`, whose tree is
`cce7b897233467e457b9cd5c190b6bb4f7201c45` — the same tree the required pull-request gate passed
on. The tree was built twice on two clean Windows runners and the payloads matched: 128 files,
normalized payload manifest
`be9f2c324ea8bdf8ea4aa1ce77ef46ae861f8be48e9ddc02da12149c6ffb503b`.

| Field | Value |
|---|---|
| Artifact | `MKTBrowser-win-x64.exe` |
| Size | 146,020,764 bytes |
| SHA-256 | `d18c8d79fc6a6f77e1783044e2e9fae4ac28f73b152992bee0a0bcbc6a4e3490` |
| Frozen commit | `eac77f8fd72707cbb5ad867bb69da4358e8cb6f8` |
| Tree | `cce7b897233467e457b9cd5c190b6bb4f7201c45` |

The commit and tree hashes are verifiable in this repository. The artifact size and SHA-256 are
carried over from the build record; they cannot be re-derived here, because the candidate is not
kept in the repository.

## Why the hash mattered

The candidate shipped unsigned, so Windows publisher verification was unavailable and nothing in
the file identified who produced it. That SHA-256 and the channel it arrived through were the only
origin evidence there was, which is why it is written down rather than left in a build log.
SmartScreen warns once on an unsigned installer, and onboarding was required to say so before the
operator met the warning, because an unannounced warning teaches people to dismiss warnings.

## Status

Retained, not distributed. The candidate predates the current line of work: this repository has
since moved to the verified Relay v16 archive and Browser contract v4, and the `0.3.13` source
candidate is a measured technical draft that is likewise not approved for real-account use. The
Phase 5 gates named at the time — real proxy, DNS and WebRTC proof, human-controlled login, live
vendor lease recovery, crash and reboot behaviour, and a clean second-PC install — are tracked in
[the fingerprint acceptance gate](fingerprint-acceptance-gate.md) and in the README's current
status section. Rollout remains NO-GO.
