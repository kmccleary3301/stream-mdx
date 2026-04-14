# Lookahead V2 Execution Plan

Repo anchor:
- repo: `stream-mdx`
- branch: `main`
- source planner response: `docs_tmp/LOOKAHEAD/LOOKAHEAD_V2_PLANNER_RESPONSE.md`
- V1 closeout anchor: [`LOOKAHEAD_V1_CLOSEOUT.md`](./LOOKAHEAD_V1_CLOSEOUT.md)
- V2 closeout anchor: [`LOOKAHEAD_V2_CLOSEOUT.md`](./LOOKAHEAD_V2_CLOSEOUT.md)

This document is the final execution record for **Math V2A**, the first post-V1 lookahead tranche.

Math V2A is complete for its bounded scope.

## Final Phase Status

| Phase | Status | Final note |
| --- | --- | --- |
| Phase 0: registry + trace groundwork | complete | executable registry support, focused trace controls, and math-specific sidecars are landed |
| Phase 1: MathTailEngine shadow mode | complete | family/candidate/checkpoint/comparison shadow analysis is landed and test-backed |
| Phase 2: Math V2A live path | complete | bounded live MathTailEngine selection owns the shipped Math V2A families |
| Phase 3: optional-argument decision gate | complete | `optional-arg-local` remains classification-only and repair-deferred for V2 |
| Phase 4: MDX decision gate | complete | Math V2A intentionally made no runtime MDX behavior changes |
| Phase 5: selective smoke promotion + hardening | complete | reduced hardening suite, trace acceptance, and bounded smoke promotion are frozen |

## What Math V2A Added

Math V2A kept the closed V1 narrow waist and improved the math internals only.

Landed behavior:
- structured `MathTailEngine` shadow analysis and live candidate selection
- migration of the bounded V1 math subset through the live engine
- `display-local` multiline checkpoint selection
- narrow `left-right-local` null-delimiter handling under strict validation-safe rules
- explicit `environment-structured` and `alignment-structured` classification with conservative fallback
- richer trace artifacts for family, candidates, validation, and first divergence

Math V2A did **not** broaden the support contract into full TeX repair.

## Final Math V2A Family Matrix

| Family | Surface | V2 status | Smoke status | Trace-backed | Browser-backed | Final note |
| --- | --- | --- | --- | --- | --- | --- |
| `math-local-core` | `math-inline` | bounded | promoted | yes | yes | bounded local repair remains supported |
| `math-fixed-arity-local` | `math-inline` | bounded | promoted | yes | yes | allowlisted `\\frac` / `\\sqrt` missing-group repair |
| `math-fixed-arity-local` | `math-block` | bounded | promoted | yes | yes | covered through bounded display support |
| `math-left-right-local` | `math-inline` | bounded | targeted-only | yes | targeted-only | live path stays conservative until validation-safe |
| `math-left-right-local` | `math-block` | bounded | promoted | yes | yes | narrow null-right completion only |
| `math-display-local` | `math-block` | bounded | promoted | yes | yes | multiline checkpoint selection is supported |
| `math-optional-arg-local` | `math-inline` / `math-block` | deferred | never | yes | targeted-only | classification-only, no live repair |
| `math-environment-structured` | `math-block` | hard-stop-only | never | yes | yes | explicit environment classification and raw fallback |
| `math-alignment-structured` | `math-block` | hard-stop-only | never | yes | yes | explicit alignment classification and raw fallback |

## Final Reduced Math V2A Hardening Suite

This is the frozen reduced suite for V2.

| Fixture | Purpose | Status |
| --- | --- | --- |
| `math-left-right-null-right-supported.md` | bounded `left-right-local` support without visible KaTeX error | smoke-promoted |
| `math-left-right-nested-negative.md` | nested left/right pressure degrades conservatively without swallow | targeted-only |
| `math-display-checkpoint-supported.md` | display-local checkpoint selection under split boundaries | smoke-promoted |
| `math-display-local-multiline.md` | display-local multiline classification and checkpoint preference | targeted-only |
| `math-environment-hard-stop-negative.md` | environment-structured classification and raw fallback | targeted-only |
| `math-alignment-hard-stop-negative.md` | alignment-structured classification and raw fallback | targeted-only |
| `math-inline-hard-stop-negative.md` | unsupported inline math remains conservative | targeted-only |
| `math-checkpoint-vs-raw.md` | checkpoint candidate vs raw fallback boundary | targeted-only |
| `math-optional-arg-classification.md` | deferred `optional-arg-local` classification evidence only | targeted-only |

## Final Smoke Criteria

A Math V2A case is smoke-worthy only when all of these are true:
- deterministic browser output across repeated seeded runs
- stable machine-checked trace expectations
- useful first-divergence artifacts under the canonical trace workflow
- no known flake in the reduced regression loop
- the support matrix explicitly promises only the bounded behavior the fixture exercises

## Final Smoke Decisions

Promoted Math V2A cases:
- `math-left-right-null-right-supported`
- `math-display-checkpoint-supported`

Targeted-only Math V2A cases:
- `math-left-right-nested-negative`
- `math-environment-hard-stop-negative`
- `math-alignment-hard-stop-negative`
- `math-inline-hard-stop-negative`
- `math-display-local-multiline`
- `math-checkpoint-vs-raw`
- `math-optional-arg-classification`

These stay targeted-only because they prove fallback boundaries, classification, or sharper branch behavior rather than a smoke-worthy supported promise.

## Closed Decision Gates

### Optional-argument gate

Final V2 decision:
- `optional-arg-local` remains classification-only
- live repair remains deferred for V2
- smoke status remains `never`

Why it stayed deferred:
- the bounded subset was not strong enough to justify widening the active support contract
- the live Math V2A tranche achieved its goals without optional-arg repair
- classification evidence is sufficient for post-V2 planning without creating a partial support promise now

Reopen only in post-V2 work if all of these are true:
- real user-value evidence for a narrow subset such as `\\sqrt[n]{...}`
- a bounded subset definition with no generic optional-argument support
- no-swallow proof and deterministic trace acceptance designed up front
- a credible browser/regression fixture plan before runtime work starts

### MDX gate

Final V2 decision:
- Math V2A made no runtime MDX behavior changes
- `mdx-expression` remains governed by the closed V1 conservative policy

Why it stayed unchanged:
- the Math V2A denominator was math-only
- there was no need to reopen MDX runtime behavior to complete the V2 goals
- the conservative V1 MDX policy remains coherent and testable without widening scope here

Reopen only in post-V2 work if all of these are true:
- a tiny bounded subset is defined in advance
- no-swallow behavior is provable under traces and browser regressions
- trace acceptance is deterministic
- there is a strong argument that the subset belongs in smoke rather than targeted-only coverage

## Final Invariants

Math V2A keeps the V1 invariants and adds these final math-specific ones:

1. Live math anticipation operates only inside already-identified math-local ranges.
2. Repairs may only add tail-local structure or choose a bounded validated checkpoint.
3. Repairs may not consume following Markdown, HTML, or MDX bytes.
4. Unsupported structured families must classify explicitly and degrade conservatively.
5. The supported `left-right-local` subset may only use narrow null-delimiter completion; it may not guess symmetric delimiters.
6. Display-local checkpoint selection may not hide substantial already-typed semantic tail content.
7. Trace artifacts must explain math behavior in terms of family, selected candidate, validation, downgrade, and first divergence.

## Final Maintainer Workflow

Start here when debugging a Math V2A regression:

1. Run the direct core tests:
   - `npx tsx packages/markdown-v2-core/__tests__/lookahead-support-matrix.test.ts`
   - `npx tsx packages/markdown-v2-core/__tests__/lookahead-trace-contract.test.ts`
   - `npx tsx packages/markdown-v2-core/__tests__/math-live-shadow-parity.test.ts`
   - `npx tsx packages/markdown-v2-core/__tests__/math-tail-shadow-fixtures.test.ts`
2. Run the canonical trace commands from [`LOOKAHEAD_TRACE_WORKFLOW.md`](./LOOKAHEAD_TRACE_WORKFLOW.md).
3. If the case is smoke-promoted, run reduced seeded smoke before changing the support claim.
4. If the case is targeted-only, keep it targeted unless the smoke criteria are met explicitly.
5. If the case would widen the contract beyond the matrices above, move it to post-V2 work instead of reopening V2 implicitly.

## Final Verification Contract

The closed V2 state is expected to satisfy:
- support-matrix, trace-contract, and math parity tests green
- targeted browser regressions green for the bounded and structured Math V2A families
- reduced seeded smoke green on the frozen promoted set
- docs build and docs link checks green
- no active-scope ambiguity between docs, traces, support matrix, and smoke status

## Out Of Scope For V2

These items are explicitly outside completed V2 scope and do not count against V2 completion:
- live optional-argument repair
- richer `\\left ... \\right` families beyond the narrow null-delimiter subset
- environment or alignment repair support
- runtime MDX behavior changes
- broader HTML work
- provider/public ABI work
- optimization work

Those items are tracked in [`LOOKAHEAD_POST_V1_ROADMAP.md`](./LOOKAHEAD_POST_V1_ROADMAP.md).
