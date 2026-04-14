# Lookahead Trace Workflow

This document is the operator workflow for the settled Lookahead V1 tracing stack.

See also:
- [`LOOKAHEAD_CONTRACT.md`](./LOOKAHEAD_CONTRACT.md)
- [`LOOKAHEAD_V1_EXECUTION_PLAN.md`](./LOOKAHEAD_V1_EXECUTION_PLAN.md)
- [`REGRESSION_TESTING.md`](./REGRESSION_TESTING.md)

## Why this exists

The lookahead tranche depends on debugger-grade evidence, not visual guesses.

The canonical trace path:
- bakes the snippet automation API into the docs export
- serves the exported site from a static server
- runs `scripts/analyze-test-snippets.ts` against that exported surface

This is more stable than `next dev` and avoids the bootstrap race that existed when traces tried to mutate the demo after first render.

## Canonical workflow

From the repo root:

```bash
cd /home/skra/projects/ql_homepage/stream-mdx/.worktrees/public-api-fix
NEXT_PUBLIC_STREAMING_DEMO_API=true npm run docs:build
cd apps/docs/out
python3 -m http.server 3002 --bind 127.0.0.1
```

Then, from another shell:

```bash
cd /home/skra/projects/ql_homepage/stream-mdx/.worktrees/public-api-fix
SNIPPET_TEST_URL=http://127.0.0.1:3002/regression/snippet-test/ \
  npx tsx scripts/analyze-test-snippets.ts \
  --trace-lookahead \
  --trace-snippet anticipation-inline.md \
  --trace-mode chunk \
  --trace-max-steps 3
```

## Current useful trace commands

Chunk-mode trace:

```bash
SNIPPET_TEST_URL=http://127.0.0.1:3002/regression/snippet-test/ \
  npx tsx scripts/analyze-test-snippets.ts \
  --trace-lookahead \
  --trace-snippet nested-formatting-ancestors.md \
  --trace-mode chunk
```

Small bounded trace:

```bash
SNIPPET_TEST_URL=http://127.0.0.1:3002/regression/snippet-test/ \
  npx tsx scripts/analyze-test-snippets.ts \
  --trace-lookahead \
  --trace-snippet inline-html-allowlist.md \
  --trace-mode chunk \
  --trace-max-steps 5
```

MDX char-mode trace:

```bash
SNIPPET_TEST_URL=http://127.0.0.1:3002/regression/snippet-test/ \
  npx tsx scripts/analyze-test-snippets.ts \
  --trace-lookahead \
  --trace-snippet mdx-tag-allowlist-inline.mdx \
  --trace-mode char \
  --trace-max-steps 8
```

Math hard-stop char-mode trace:

```bash
SNIPPET_TEST_URL=http://127.0.0.1:3002/regression/snippet-test/ \
  npx tsx scripts/analyze-test-snippets.ts \
  --trace-lookahead \
  --trace-snippet math-hard-stop-negative.md \
  --trace-mode char \
  --trace-max-steps 8
```

Math display char-mode trace:

```bash
SNIPPET_TEST_URL=http://127.0.0.1:3002/regression/snippet-test/ \
  npx tsx scripts/analyze-test-snippets.ts \
  --trace-lookahead \
  --trace-snippet math-display-supported.md \
  --trace-mode char \
  --trace-max-steps 8
```

Focused math trace around a structural token:

```bash
SNIPPET_TEST_URL=http://127.0.0.1:3002/regression/snippet-test/ \
  npx tsx scripts/analyze-test-snippets.ts \
  --trace-lookahead \
  --trace-snippet math-hard-stop-negative.md \
  --trace-mode char \
  --trace-from-pattern='\\left' \
  --trace-window-before 8 \
  --trace-window-after 80 \
  --trace-max-steps 24
```

Math display hard-stop char-mode trace:

```bash
SNIPPET_TEST_URL=http://127.0.0.1:3002/regression/snippet-test/ \
  npx tsx scripts/analyze-test-snippets.ts \
  --trace-lookahead \
  --trace-snippet math-display-hard-stop-negative.md \
  --trace-mode char \
  --trace-max-steps 8
```

MDX expression char-mode trace:

```bash
SNIPPET_TEST_URL=http://127.0.0.1:3002/regression/snippet-test/ \
  npx tsx scripts/analyze-test-snippets.ts \
  --trace-lookahead \
  --trace-snippet mdx-expression-no-swallow-negative.mdx \
  --trace-mode char \
  --trace-max-steps 8
```

## Output directory

Trace bundles are written under:

```text
tmp/snippet_analysis/lookahead-traces/
```

Example:

```text
tmp/snippet_analysis/lookahead-traces/nested-formatting-ancestors-chunk/
```

## Expected artifact layout

Each trace bundle currently includes:
- `trace-summary.json`
- `focus-summary.json`
- `math-tail-analysis.json`
- `math-candidates.json`
- `math-validation.json`
- `latch-rearm.json`
- `trace.ndjson`
- `steps/step-XXXX.json`
- `steps/telemetry-XXXX.json`
- `diffs/step-XXXX.json`
- `failures/first-divergence.json` when a trace detects the first inconsistent step

Key fields in the step artifacts:
- raw prefix
- rendered HTML
- block summary
- `inlineLookahead`
- `mixedLookahead`
- `inlineContainerSignature`
- `inlineLookaheadInvalidated`

Key fields in the summary artifact:
- `totalSteps`
- `focus`
- `firstRenderableStep`
- `firstProviderActivation`
- `firstTermination`
- `firstDowngrade`
- `firstFinalizedStep`
- aggregate provider counts
- aggregate surface counts
- aggregate feature-family counts
- aggregate termination counts
- aggregate downgrade counts

Math-specific summary artifacts:
- `math-tail-analysis.json`
  - per-step math family classification, tokens, obligations, checkpoints
- `math-candidates.json`
  - selected candidate state per traced math decision
- `math-validation.json`
  - validation and downgrade results per traced math decision
- `latch-rearm.json`
  - termination and rearm metadata per traced math decision

## Current requirements and caveats

- The docs build must be produced with `NEXT_PUBLIC_STREAMING_DEMO_API=true`
- The exported site must be served from `apps/docs/out`
- `next dev` is not the canonical trace path for this tranche
- HTML / MDX provider traces are now live and show up under `mixedLookahead`
- Math V1 traces are live for the bounded subset and hard-stop cases, but the hard-stop negative fixture is currently trace/unit-backed rather than browser-regression-backed

## Reduced smoke status

Current reduced smoke promotions:
- `nested-formatting-ancestors`
- `inline-html-allowlist`
- `block-html-no-swallow`
- `math-inline-supported`
- `math-display-supported`
- `mdx-tag-allowlist-inline`

Current targeted-only cases:
- `mdx-tag-no-swallow-negative`
- `mdx-expression-no-swallow-negative`
- `math-inline-hard-stop-negative`
- `math-display-hard-stop-negative`
- `math-hard-stop-negative`

These boundaries are final for V1. Any broader smoke expansion is post-V1 work.

## Char vs chunk guidance

Use `char` mode when:
- a provider is boundary-sensitive at single-byte granularity
- you are debugging hard-stop / fallback transitions
- you need to inspect first provider activation precisely

Use `chunk` mode when:
- you want broader convergence sanity on a realistic stream cadence
- you are checking container invalidation across larger increments
- you want smaller, less noisy trace bundles

Use focus controls when:
- you already know the structural token or byte region you care about
- a long fixture makes full-prefix traces noisy
- you want first-divergence artifacts around one math family instead of the entire snippet

Useful focus flags:
- `--trace-from-pattern='\\left'`
- `--trace-start-offset 81`
- `--trace-window-before 8`
- `--trace-window-after 80`
- `--trace-surface math-block`
- `--trace-feature-family math-left-right-local`

## Maintainer workflow

When a lookahead regression appears, use this order:

1. Run the smallest direct unit test for the affected provider family.
2. Run the targeted browser regression fixture.
3. Run the canonical trace command for that fixture in `char` mode if the failure is boundary-sensitive.
4. Use `chunk` mode for broader convergence or invalidation questions.
5. Promote a case into smoke only after:
   - browser output is deterministic
   - trace expectations are stable
   - first-divergence artifacts are useful
   - no known flake remains

Canonical replay commands by fixture family:
- `inline-html-allowlist.md`
  - `npx tsx scripts/analyze-test-snippets.ts --trace-lookahead --trace-snippet inline-html-allowlist.md --trace-mode char`
- `mdx-tag-allowlist-inline.mdx`
  - `npx tsx scripts/analyze-test-snippets.ts --trace-lookahead --trace-snippet mdx-tag-allowlist-inline.mdx --trace-mode char`
- `mdx-expression-no-swallow-negative.mdx`
  - `npx tsx scripts/analyze-test-snippets.ts --trace-lookahead --trace-snippet mdx-expression-no-swallow-negative.mdx --trace-mode char`
- `math-inline-supported.md`
  - `npx tsx scripts/analyze-test-snippets.ts --trace-lookahead --trace-snippet math-inline-supported.md --trace-mode char`
- `math-display-supported.md`
  - `npx tsx scripts/analyze-test-snippets.ts --trace-lookahead --trace-snippet math-display-supported.md --trace-mode char`

## No-fake-progress rule

Do not count a fixture or trace run as substantive progress unless at least one of these is true:
- there is a direct assertion around the behavior
- there is regression HTML coverage
- there is a stable trace expectation that is useful for triage

The point of the tracing workflow is to make the settled V1 provider set explainable, and to keep any future post-V1 work from regressing into unverified heuristics.
