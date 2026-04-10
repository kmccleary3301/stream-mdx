# Correctness Gate Residuals (2026-04-10)

This note records the residual failures observed after the latest correctness tranche.

## What Passed

- `npm -w @stream-mdx/core run test`
- `npm run docs:build` when run in isolation
- `npm run test:regression:seeded-smoke:server` when run in isolation
  - `code-huge / S1_slow_small`
  - `mdx-transitions / S2_typical`
  - `edge-regressions / S2_typical`
  - `lists-nested / S2_typical`
  - `table-boundary / S2_typical`
  - `mdx-math-code-mixed / S2_typical`
  - `mdx-multi-status / S2_typical`
- `npm run test:regression:seeded-smoke`
- `npm run test:regression:scheduler-parity`
- `npm run test:benchmarks:methodology`
- `edge-boundaries / S1_slow_small`

Additional targeted MDX convergence checks now green:

- `packages/markdown-v2-react/__tests__/mdx-coordinator-store-path.test.tsx`
  - same-id raw-content races no longer reuse an in-flight compile incorrectly
  - stale store-mode compile/error responses are ignored when raw content has changed
- `mdx-math-code-mixed / S2_typical / seed-count 3`
- `mdx-multi-status / S2_typical / seed-count 3`

## MDX Residuals

No known seeded final-HTML divergence remains in the dedicated MDX convergence fixtures from this tranche.

Current remaining MDX caveat is scope, not a reproduced failure:

- the smoke suite still samples a narrow set of mixed MDX workloads compared with the total Markdown regression corpus
- additional MDX-heavy fixtures should still be promoted when they represent a new failure family, not just more volume

## Residual Failures

### 1. HTML snapshot contract drift from list marker metadata

Observed across fixtures such as:

- `kitchen-sink`
- `mixed-content-golden`

Current HTML includes:

- `data-marker-digits="1"`
- `style="--list-marker-digits: 1; ..."`

Older baselines do not. This is deterministic contract drift, not evidence of seeded semantic divergence.

### 2. Missing HTML snapshots

Observed in the current run:

- `mixed-content-golden / S3_fast_reasonable`
- `mixed-content-golden / S4_chunky_network`

These are coverage gaps in the snapshot set, not renderer crashes.

### 3. Style baseline drift

Observed broadly across style fixtures.

Primary drifts:

- typography scale (`h1`, `h2` font-size/line-height/letter-spacing/margins)
- `pre` padding contract drift
- list marker geometry drift (`padding-left`, `::before left/right/width`)

Missing style baselines were also reported for:

- `mixed-content-golden`
- `math-mdx-sentinel`
- `imaginary-empty-list`

This is a style-contract refresh / style-lock pass, not a seeded correctness failure.

### 4. Managed gate orchestration caveat

Running `docs:build` and `test:regression:seeded-smoke:server` concurrently can trigger `tsup` unlink races in package builds such as:

- `packages/stream-mdx/dist/*.mjs`
- `packages/stream-mdx/dist/*.d.cts`

Both commands succeeded when run in isolation. The issue is build orchestration overlap, not an application-level correctness failure.

## Immediate Follow-up Order

1. Refresh HTML baselines for deterministic list-marker metadata drift.
2. Fill missing HTML snapshots for `mixed-content-golden` scenarios.
3. Run a deliberate style-lock pass for typography, `pre` padding, and list marker geometry.
4. Consider making the managed smoke runner reuse existing built packages or serialize package-build entrypoints more explicitly.
