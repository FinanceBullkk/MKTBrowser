# Fingerprint acceptance gate

**Created:** 2 September 2026
**Status:** experimental gate; first applied to Brave on 2 September 2026. Runs **in parallel** with
`G2-IDENTITY`; replaces nothing.
**Plan:** [phase 01](../../plans/260902-0544-fingerprint-gate-and-brave-spike/phase-01-acceptance-gate-specification.md)

## What this document is for

`G2-IDENTITY` currently asks whether every profile has a **unique** font, audio, and WebGL hash. That
question is unsafe, so a FAIL against it does not reliably tell us how far the product is from being
acceptable. This document defines the question that should be asked instead, so the next measurement
produces a usable answer.

It defines a gate. It does not measure anything, promote any engine, or authorize any rollout.

## Why the current objective is wrong

From `research-260828-0153-vendor-independent-fingerprint-isolation.md`:

> Real devices naturally share many component values. **Artificially unique noise increases entropy
> and can become a stronger detector.**

Two profiles reporting the same common font list look like two ordinary Windows machines. Two
profiles reporting font lists that no real machine has look like two instances of a tool. Optimizing
each surface for uniqueness therefore works against the goal it was meant to serve.

The consequence for reading history: **part of the current `G2-IDENTITY=FAIL` may be an artefact of
the question, not a measure of the engine.** How much is unknown until something is measured against
the gate below. That is the point of writing it.

## Scope of the pool

**Pool size: 3 to 5 profiles per physical machine.** One profile active at a time.

**Measure at 5.** Five is the upper bound of the declared pool, and a pass at five covers three; a
pass at three says nothing about five. A run at fewer than five is `NOT-RUN` for the pool, not a
partial pass.

Decided 2 September 2026. This is part of the gate definition, not a tuning parameter: criterion B is
meaningless without it, and changing it invalidates every measurement taken under the old value.

The earlier working assumption was 10 concurrent profiles. That is a materially different — and
harder — problem, and results measured against it do not transfer.

## The three criteria

They are **independent**. Each is measured, reported, and passed or failed **on its own**. There is
no combined score, and a pass on two does not soften a fail on the third.

### Criterion A — consistency

> Same profile + same first-party site + same engine revision → identical result across restarts and
> across execution contexts.

An identity that drifts between runs is not an identity; it is noise that a site can detect as
instability. Contexts that must agree: top-level document, iframe, web worker, offscreen canvas.

**Measure:** run each profile, record the full surface set, restart the browser, run again. Compare.
Then compare across contexts within a single run.

**Pass:** exact repeat across restarts, and agreement across all four contexts.

### Criterion B — no joint-tuple collision within the pool

> No two profiles in the pool share the **entire** stable identity tuple.

Sharing an individual component is **allowed and expected** — that is what criterion C is for. What
must not happen is two profiles being linkable as the same machine.

**The tuple is built from stable surfaces only.** This is the subtle part, and the 27 August
measurement (`P0-G2-IDENTITY-20260827131800`) shows why. Two profiles on the same host produced:

| Surface | Behaviour |
|---|---|
| Fonts `08050B16`, Audio `0B09CAEB`, WebGL image `BF16CA5C` | **identical across profiles** |
| Canvas, WebGL Report, Client Rects, WebGPU Report, visitor ID, hardware concurrency, screen, GPU renderer string, timezone, language stack | rotated per profile |

The acceptance matrix draws the right conclusion: those three identical fields are *"a three-field
join that survives separate proxies, separate cookies and separate canvas noise. One flagged account
can point at every sibling on the host."*

So a tuple that includes the rotating fields would show "no collision" while the profiles remain
trivially linkable. **Rotating a value does not hide you when a stable subset still joins you.**
Criterion B is therefore evaluated over the surfaces that do not rotate.

**The stable subset is computed, never chosen.** A surface is stable in a run if it takes the same
value across every profile in that run. That is a property of the data, decided by the data. Nobody
selects which surfaces "count" after seeing whether the collision check passes — that discretion is
exactly how a gate is talked into passing.

**Measure:**

1. Record every surface for all five profiles.
2. Compute the stable subset: surfaces whose value is identical across all five. **Publish that
   list** as part of the result; it is a finding in its own right.
3. Compare all profile pairs on the computed subset.
4. Also report the full-tuple comparison separately. It is the weaker check and is informational —
   when the two disagree, the stable-subset verdict is the one that governs.

**Pass:** no two profiles share the complete stable subset.

An empty stable subset is a pass and a strong result: it means nothing at all is constant across
profiles. A stable subset that covers most surfaces is a fail regardless of how much the remainder
rotates.

### Criterion C — cohort plausibility

> Every individual component must belong to a measurable, common Windows/Chromium cohort.

This is where a shared value is judged. A shared value that matches what ordinary machines report is
fine. A shared value that **no ordinary machine reports** is a mark of the tool, and it fails — even
when criterion B passes.

**Measure — this procedure is mandatory and cannot be replaced by judgement:**

1. Run **stock Chrome or CFT on the same physical machine**, in the same session.
2. Compare each surface: engine under test vs stock.
3. Classify:

| Observation | Verdict |
|---|---|
| Matches stock | plausible cohort — **pass** |
| Differs from stock, varies per profile | farbled — pass if criterion A still holds |
| **Differs from stock, invariant across every profile** | **vendor mark — FAIL** |

The third row is the decisive one. An invariant value that differs from stock is a signature of the
engine build itself: every profile using it announces which tool is being used. That is worse than a
collision between two of our own profiles, because a collision exposes one operator while a vendor
mark exposes the category.

The existing evidence already suggests CloakBrowser's invariant audio value falls in that third row —
research 0153 records that a stock CFT control produced a *different* audio hash and concludes the
Cloak value is *"likely an engine/build cohort mark, not physical audio hardware."* Confirming or
refuting that is the first job of the measurement phase.

Comparison against stock on a **different** machine, or against values quoted from documentation, is
not evidence for this criterion. Hardware differs; only a same-machine control isolates the engine.

## Surfaces to measure

| Surface | APIs / readings |
|---|---|
| Fonts | enumerable family list, `document.fonts` / `FontFaceSet`, CSS `local()` resolution, canvas text metrics |
| Audio | `OfflineAudioContext` render, `AudioBuffer.getChannelData`, `copyFromChannel`, analyser byte/float methods, sample rate, channel count, latency |
| WebGL 1/2 | vendor, renderer, `WEBGL_debug_renderer_info`, extension list, parameter limits, shader precision, `readPixels` image hash |
| WebGPU | adapter, features, limits |
| Canvas | 2D image hash, text rendering |
| Client rects | element bounding boxes |
| UA / client hints | `navigator.userAgent`, UA-CH high-entropy values, `platform`, `hardwareConcurrency`, `deviceMemory` |
| Screen / locale | resolution, colour depth, timezone, language stack, `Intl` output |
| Aggregate | scanner visitor hash |

Every surface is read in all four contexts required by criterion A.

**BrowserScan and CreepJS are diagnostic instruments, not targets.** Their scores are not a pass
condition; their per-surface readings are inputs. A score can improve while the joint identity gets
worse.

## Harness status

The original coverage gap closed in MKTBrowser commit `76d74bf`. The measurement modules now cover
fonts, audio, WebGL 1/2, WebGPU, canvas, client rects, UA/client hints/plugins, screen/locale, and an
aggregate hash. They exercise document, iframe, worker, and offscreen-canvas contexts according to
the context support matrix used by criterion A.

The analyser computes the stable subset from the readings, reports stable-subset and full-tuple
collisions separately, and classifies each component against a same-machine stock control. Raw
host-identifying values remain temporary; committed evidence uses aliases, classifications, counts,
and digests.

## Reporting rules

- Report A, B, and C as three separate verdicts. Never a single combined score.
- Reuse the existing status vocabulary from the P0 acceptance matrix: `PASS`, `FAIL`, `BLOCKED`,
  `OPEN`, `INVALID`, `NOT-RUN`, `SUPERSEDED`, `DEFERRED`. `NOT-RUN` is never implied to pass, and
  `DEFERRED` may never be counted as a pass.
- Record raw readings alongside verdicts. A verdict without its numbers cannot be rechecked.
- Separate what was **measured** from what was **inferred**.

### Evidence contract

Inherited from the P0 acceptance matrix and binding here:

Never retain licence keys, proxy URLs, proxy hosts, proxy credentials, observed IP addresses, MCP
tokens, Relay tickets, cookies, credentials, OTP values, raw vendor responses, or page content.

Do not commit fingerprint values that identify the project's own physical machine in a way that can
be traced back to it. Where a value must be shown, prefer the comparison (matches stock / differs)
over the raw hash.

## First application - 2 September 2026

The gate was applied to official Brave `v1.94.117` at the declared pool of five, with two runs per
profile and an exact Chromium `152.0.7977.64` CFT control on the same machine.

| Criterion | Result | Evidence |
|---|---|---|
| A - consistency | `FAIL` | `65` restart mismatches, `20` cross-context mismatches, `0` coverage gaps |
| B - stable-subset collision | `FAIL` | `62`/`63` stable components; all `10/10` profile pairs collided in both runs; full tuple had `0/10` collisions |
| C - cohort plausibility | `FAIL` | Rendered audio and canvas changed after restart; UA-CH and available screen height retained invariant stock differences |

The decisive audio result is neither a stock cohort nor an invariant Brave mark. Seven audio
components matched stock. Five rendered hashes varied across profiles but also changed for the same
profile after restart, so the identity is session-drifting rather than persistent.

CloakBrowser Stable `.2` remains `BLOCKED` with `0/10` readings and is not assigned a fabricated
A/B/C verdict. The Brave result therefore does not prove a better/equal/worse rank against `.2`; it
independently fails the gate. Full evidence:
[Phase 04 report](../../plans/260902-0544-fingerprint-gate-and-brave-spike/reports/brave-identity.md).

## Relationship to `G2-IDENTITY`

This gate is **experimental** and runs alongside the existing one. `G2-IDENTITY` keeps its current
`FAIL` and remains the release gate.

Lowering a release gate before the evidence exists is how a project gives itself permission. So this
gate does not replace anything on its own authority.

**Retiring `G2-IDENTITY` requires all of:**

1. A measurement of the current pinned engine against A, B, and C at pool 3-5, with raw readings.
2. A same-machine stock control for criterion C.
3. An explicit written decision by the project owner citing that measurement.

Until all three exist, `G2-IDENTITY=FAIL` stands, and no identity-isolation claim may be made.

The first application does not satisfy those retirement conditions. The current pinned engine was
not measured, Brave failed A/B/C, and the Phase 05 owner decision is not yet signed. `G2-IDENTITY`
therefore remains `FAIL` without qualification.

## What a pass does not mean

A pass on all three criteria means the measured engine produced coherent, non-colliding,
cohort-plausible identities for 3-5 profiles on one machine, under measurement conditions.

It does **not** mean: profiles are unlinkable in the field, real accounts are safe, the browser may
be distributed, human login and posting may be automated, or `G2-IDENTITY` is closed. Those are
separate gates with separate evidence.
