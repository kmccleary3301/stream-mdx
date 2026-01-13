# Testing and Baselines

StreamMDX includes **local-only** regression baselines that lock in HTML output and critical CSS styles while streaming.

## What is covered

- HTML snapshots across streaming scenarios (slow, typical, fast, chunky, split boundaries).
- Computed styles for typography, tables, lists, blockquotes, footnotes, and preview/code adjacency.

## Update baselines (local)

```bash
npm run test:regression:html:update
npm run test:regression:styles:update
```

## Validate (no changes expected)

```bash
npm run test:regression:html
npm run test:regression:styles
```

Artifacts for failures are written to `tests/regression/artifacts/` and are ignored by git.

## Performance baseline (local)

The demo page exposes an automation API for perf capture. Run the dev server with the API enabled:

```bash
NEXT_PUBLIC_STREAMING_DEMO_API=true npm run docs:dev
```

Then capture a baseline:

```bash
npm run perf:demo -- --rate 12000 --tick 5 --runs 1
```

The script writes JSON output under `tmp/perf-baseline/`.

## Notes

- These checks are intentionally **not** in CI yet.
- If you add fixtures, update `tests/regression/fixtures/index.ts` and regenerate snapshots.
