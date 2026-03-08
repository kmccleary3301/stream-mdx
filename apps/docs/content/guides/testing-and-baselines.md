# Testing and Baselines

StreamMDX uses layered validation so rendering quality remains deterministic across releases.

## Test layers

| Layer | Goal | Command |
| --- | --- | --- |
| Unit tests | Parser/renderer logic correctness | `npm test` |
| HTML regression | Lock final rendered markup | `npm run test:regression:html` |
| Style regression | Lock key computed styles | `npm run test:regression:styles` |
| Perf baseline | Detect latency/jank regressions | `npm run perf:demo -- ...` |

## Regression snapshot workflow

Update snapshots only when output changes are intentional.

```bash
npm run test:regression:html:update
npm run test:regression:styles:update
```

Verify no unexpected diff remains:

```bash
npm run test:regression:html
npm run test:regression:styles
```

Artifacts for failures are emitted to `tests/regression/artifacts/`.

## Perf baseline workflow

Start docs with automation API enabled:

```bash
NEXT_PUBLIC_STREAMING_DEMO_API=true npm run docs:dev
```

Capture baseline and candidate runs:

```bash
npm run perf:demo -- --rate 12000 --tick 5 --runs 3 --out tmp/perf-baseline/main.json
npm run perf:demo -- --rate 12000 --tick 5 --runs 3 --out tmp/perf-baseline/candidate.json
```

Compare key metrics:

- first flush
- patch p95
- long tasks
- memory peak
- coalescing rate

## CI gate strategy

A practical gate strategy:

- Always run regression snapshots on docs/site changes.
- Run perf baseline when `packages/*`, demo renderer, or worker changes.
- Fail PRs when thresholds exceed agreed limits.

Example threshold defaults:

- first flush regression > 15% => fail
- patch p95 regression > 20% => fail
- long tasks > 2x baseline => fail

## How to triage failures

1. Confirm fixture and run settings are unchanged.
2. Re-run to exclude one-off noise.
3. Diff snapshot artifacts for exact semantic/style changes.
4. Bisect feature flags (`html`, `mdx`, `math`) to isolate subsystem.
5. If intentional, update snapshot + changelog entry.

## Release checklist

- [ ] Regression snapshots pass with clean diff review.
- [ ] Perf run attached for changed renderer/worker behavior.
- [ ] Docs routes build + export successfully.
- [ ] Worker bundle regenerated and copied to static assets.

## Related docs

- [Perf harness](/docs/perf-harness)
- [Perf quality changelog](/docs/perf-quality-changelog)
- [Release checklist](/docs/release-checklist)
