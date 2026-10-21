# Regression Testing

This document covers the HTML/style regression harnesses, the seeded replay guards, and the artifact/debug workflow used when a regression fails.

## What is covered

The regression stack currently locks in:

- final HTML, root-child hashes, structural signatures and inline style semantics for curated fixtures and streaming scenarios
- deterministic seeded final-HTML convergence for promoted high-risk fixtures
- scheduler-mode final-HTML parity for representative fixtures
- computed style snapshots and explicit geometry/color invariants for high-risk surfaces
- finalize-time invariants such as duplicate IDs, queue drain, native semantic completion, and structural signatures; trusted document readiness and committed-render checks are a separate asynchronous lifecycle

Snapshots live in:

- `tests/regression/snapshots/html/**`
- `tests/regression/snapshots/styles/**`

Failure artifacts are written under:

- `tests/regression/artifacts/**`

## Guard ownership

| Guard | What it owns | Typical command |
| --- | --- | --- |
| HTML regression | exact final output and live consumer-behavior invariants; provisional captures are diagnostics | `npm run test:regression:html` |
| Style regression | computed-style snapshots for curated selectors | `npm run test:regression:styles` |
| Style invariants | explicit geometry/color/layout assertions | `npm run test:regression:style-invariants` |
| Seeded smoke | final-HTML convergence for promoted high-risk fixtures | `npm run test:regression:seeded-smoke` |
| Scheduler parity | final-HTML equivalence across supported scheduler modes | `npm run test:regression:scheduler-parity` |
| Docs quality audit | route-level content and shell sanity on the built site | `npm run docs:quality:audit` |

### Diagnostics and behavior locks

The HTML runner captures first-chunk, progress, and first-seen selector checkpoints for debugging. Their count, order, serialized HTML, and broad structural signatures are not baseline assertions. Event timing, provisional wrappers, and generated partial-math markup may change without changing the consumer contract.

Final HTML remains byte-for-byte compared outside canonicalizable inline style declaration spelling. Both inputs use the same browser CSSOM preparation, preserving declaration values, priorities and order; root-child hashes are recomputed from that preparation. Unsupported, invalid, duplicate or lossy declarations stay raw. Comparison does not rewrite baselines. There is no blanket KaTeX, text-whitespace or wrapper normalization. Live guards still enforce text/code prefixes, code line order, table integrity and visibility deadlines, list integrity, security restrictions, MDX state, and fixture-specific selectors/text.

`math-display-checkpoint-supported` retains a dedicated ordinary S5 boundary assertion. Immediately after its explicit marker, the open display formula `a_n = \frac{1}{n}` must have renderable display KaTeX with matching TeX/MathML and no KaTeX error. After finalize, the formula must include the `\sqrt{x}` tail, and the fixture's trailing prose must remain present. An eventual `.katex` selector alone does not satisfy the boundary contract.

### Source-owned release boundaries

- `packages/markdown-v2-core/__tests__/lookahead-budget-boundaries.test.ts` covers provisional size limits and finalized-content preservation. Oversized provisional input falls back to literal source before token scanning; finalized complete content still renders its formatting.
- `packages/markdown-v2-react/__tests__/virtualized-code-streaming-guard.test.ts` uses a real inline worker and mounted custom code consumer. Identical-source `INIT` with reused code IDs starts a fresh lazy-request lifetime; held replacement work leaves the new document unhighlighted, and releasing its real request renders the authored token rows. Pending requests remain cancellable on detach.
- The snippet analyzer validates every retained coalescing batch before breakdown or release guardrails: six finite nonnegative integer counters, finite nonnegative duration, reconciled input/output counts, and operation counts bounded by input. Retained counter sums and coalescing-duration sums cannot exceed their respective aggregate totals; either may be lower because retained history is capped. A singleton may omit coalescing metrics because the scheduler skips that work. Missing counters never become zero observations, and reported coalescing work without retained samples fails.

### Seed coverage and eligibility

The existing `--seed` and `--seed-count` replay options generate varied deterministic chunks from marker-stripped text, including for split-marker fixtures. Seeded replay has an internal exception to the ordinary marker-only scenario restriction; scenario include/exclude tags still apply. The seeded smoke's S2 requests for `imaginary-empty-list` and `math-display-checkpoint-supported` therefore execute real varied chunks and compare exact finals against their ordinary S5 baselines and against the other seeds.

Unseeded S5 still uses the authored fixed split boundaries. Seeded S5 does not repeat those fixed chunks. Scheduler-only replays retain the ordinary eligibility and split behavior.

HTML and style runners fail when eligibility filters execute no cases. Explicit fixture/scenario filters also cannot silently skip every case for a matched requested fixture or scenario. Missing ordinary baselines remain failures; seeded replays also require their final-output oracle. Do not exclude missing S1/S3/S4 entries from the ordinary matrix or copy S2 snapshots into those slots.

The style runner honors `waitForMdxCompiled: false`, just like the HTML runner. Fixtures for bounded inline shells or unsupported MDX do not wait for an unsupported compiled-inline state.

## CI vs local

These checks are no longer purely local-only.

CI-required contract checks currently include:

- `npm run test:benchmarks:methodology`
- `npm run test:regression:scheduler-parity`
- `npm run test:regression:seeded-smoke:server`
- `npm run docs:build`
- `DOCS_CHECK_ANCHORS=1 npm run docs:check-links`

Local and merge-time checks still include:

- `npm run test:regression:html`
- `npm run test:regression:styles`
- `npm run test:regression:style-invariants`
- `npm run docs:quality:audit`

## Recommended local workflow

### 1. Build the exported docs site

```bash
npm run docs:build
```

### 2. Serve the exported site

```bash
cd apps/docs/out
python3 -m http.server 3012 --bind 127.0.0.1
```

### 3. Point regression commands at that server

```bash
STREAM_MDX_REGRESSION_BASE_URL=http://127.0.0.1:3012 npm run test:regression:html
STREAM_MDX_REGRESSION_BASE_URL=http://127.0.0.1:3012 npm run test:regression:styles
STREAM_MDX_REGRESSION_BASE_URL=http://127.0.0.1:3012 npm run test:regression:seeded-smoke
STREAM_MDX_REGRESSION_BASE_URL=http://127.0.0.1:3012 npm run test:regression:scheduler-parity
DOCS_AUDIT_BASE_URL=http://127.0.0.1:3012 npm run docs:quality:audit
```

If you want the managed exported-site runner instead of running the server manually:

```bash
npm run test:regression:seeded-smoke:server
```

## Updating snapshots

Update snapshots only after the output change is understood and accepted.

```bash
UPDATE_SNAPSHOTS=1 npm run test:regression:html
UPDATE_SNAPSHOTS=1 npm run test:regression:styles
```

Read the full policy before doing this:

- [`BASELINE_UPDATE_POLICY.md`](./BASELINE_UPDATE_POLICY.md)

## Failure artifacts and how to read them

- HTML failures report the **first diff index** and show a small context slice for expected vs received.
- Style failures list the first handful of computed property changes.
- Invariant failures list the offending blocks or state values after finalize.
- `requiredTextFragments` are validated against the **rendered DOM text** of `#regression-root`, not the serialized HTML string. Syntax highlighting splits source lines into per-token `<span>`s, so an HTML substring match is incidental to the highlighter markup. Matching stays verbatim (meaningful characters, newlines and protocols are not normalized away), so a fragment that is genuinely missing from the rendered text still fails. Add fragments as the text a reader sees, not as HTML markup.
- Full expected/received payloads are written under `tests/regression/artifacts/<timestamp>/...`.

### HTML regression artifacts

Written under:

- `tests/regression/artifacts/<timestamp>/<fixture>/<scenario>/<label>/`

Typical contents:

- `expected.html`
- `received.html`
- `expected.snap.json`
- `received.snap.json`
- `message.txt`

The CLI output should also report:

- fixture and scenario
- seed when applicable
- first diff index
- expected/received diff context
- artifact path

### Scheduler parity artifacts

Written under:

- `tests/regression/artifacts/scheduler-parity/<timestamp>/<fixture>/<scenario>/<seed-mode-pair>/`

Typical contents:

- `baseline.html`
- `candidate.html`
- `summary.json`

`summary.json` includes:

- fixture
- scenario
- seed
- baseline mode
- candidate mode
- first diff index
- `baselineLastTx`
- `candidateLastTx`
- expected/received context

### Style regression artifacts

Written under:

- `tests/regression/artifacts/<timestamp>/<fixture>/styles/`

Typical contents:

- `expected.json`
- `received.json`

### Managed exported-site runner logs

The managed seeded-smoke wrapper and release gate static server write logs under:

- `tmp/seeded-smoke/docs-server.log`
- `tmp/release-gates/docs-server.log`

If the wrapper fails before readiness, inspect those logs first.

## Practical failure triage

1. Read the command output for the fixture, scenario, seed, and artifact path.
2. Inspect the artifact payloads under `tests/regression/artifacts/**`.
3. Determine whether the failure is:
   - deterministic contract drift
   - a real correctness regression
   - a style/geometry regression
   - a serving-model or startup failure
4. Only refresh snapshots after confirming the output drift is intentional and covered by policy.

## Adding new coverage

When a correctness bug escapes once, add all three:

- one fixture under `tests/regression/fixtures/`
- one invariant or targeted test
- one scenario or deterministic seed path

See also:

- [`STREAMING_CORRECTNESS_CONTRACT.md`](./STREAMING_CORRECTNESS_CONTRACT.md)
- [`ESCAPED_BUG_TRACEABILITY_MATRIX.md`](./ESCAPED_BUG_TRACEABILITY_MATRIX.md)
- [`BASELINE_UPDATE_POLICY.md`](./BASELINE_UPDATE_POLICY.md)
