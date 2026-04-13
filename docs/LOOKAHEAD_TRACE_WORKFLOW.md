# Lookahead Trace Workflow

This document is the operator workflow for the current lookahead tracing stack.

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
- `trace.ndjson`
- `steps/step-XXXX.json`
- `steps/telemetry-XXXX.json`
- `diffs/step-XXXX.json`

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
- `firstRenderableStep`
- `firstFinalizedStep`
- aggregate provider counts
- aggregate termination counts
- aggregate downgrade counts

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
- `math-inline-supported`
- `mdx-tag-allowlist-inline`

Current targeted-only cases:
- `block-html-no-swallow`
- `mdx-tag-no-swallow-negative`
- `mdx-expression-no-swallow-negative`
- `math-inline-hard-stop-negative`
- `math-hard-stop-negative`

## Char vs chunk guidance

Use `char` mode when:
- a provider is boundary-sensitive at single-byte granularity
- you are debugging hard-stop / fallback transitions
- you need to inspect first provider activation precisely

Use `chunk` mode when:
- you want broader convergence sanity on a realistic stream cadence
- you are checking container invalidation across larger increments
- you want smaller, less noisy trace bundles

## Current no-fake-progress rule

Do not count a fixture or trace run as substantive progress unless at least one of these is true:
- there is a direct assertion around the behavior
- there is regression HTML coverage
- there is a stable trace expectation that is useful for triage

The point of the tracing workflow is to make the next provider slices explainable, not to create piles of unverified artifacts.
