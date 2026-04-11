# Regression Testing

This document covers the HTML/style regression harnesses, the seeded replay guards, and the artifact/debug workflow used when a regression fails.

## What is covered

The regression stack currently locks in:

- HTML snapshots for curated fixtures and streaming scenarios
- deterministic seeded final-HTML convergence for promoted high-risk fixtures
- scheduler-mode final-HTML parity for representative fixtures
- computed style snapshots and explicit geometry/color invariants for high-risk surfaces
- finalize-time invariants such as duplicate IDs, queue drain, MDX state, and structural signatures

Snapshots live in:

- `tests/regression/snapshots/html/**`
- `tests/regression/snapshots/styles/**`

Failure artifacts are written under:

- `tests/regression/artifacts/**`

## Guard ownership

| Guard | What it owns | Typical command |
| --- | --- | --- |
| HTML regression | checkpoint/final HTML and structural signatures | `npm run test:regression:html` |
| Style regression | computed-style snapshots for curated selectors | `npm run test:regression:styles` |
| Style invariants | explicit geometry/color/layout assertions | `npm run test:regression:style-invariants` |
| Seeded smoke | final-HTML convergence for promoted high-risk fixtures | `npm run test:regression:seeded-smoke` |
| Scheduler parity | final-HTML equivalence across supported scheduler modes | `npm run test:regression:scheduler-parity` |
| Docs quality audit | route-level content and shell sanity on the built site | `npm run docs:quality:audit` |

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
