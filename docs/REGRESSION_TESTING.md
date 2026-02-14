# Regression Testing (Local Only)

These regression checks are intentionally **local-only** for now. They lock in the compiled HTML and computed styles for a curated set of fixtures and streaming scenarios.

## What gets locked in

- HTML snapshots for multiple streaming scenarios (small chunks, typical, fast, chunky network, split-marker boundaries, and a stress-only extreme throughput scenario).
- HTML checkpoints now also capture **structural signatures** (top-level tag order + element counts) and **root child hashes** for easier localization of diffs.
- Computed style snapshots for critical elements (headings, tables, lists, blockquotes, footnotes, preview/code adjacency, etc).
- Invariant checks after finalize (duplicate block IDs, MDX compile state, range ordering, queue drain).

Snapshots live in:
- `tests/regression/snapshots/html/**`
- `tests/regression/snapshots/styles/**`

Artifacts for failures are written to `tests/regression/artifacts/` (ignored in git).

## Run the regression harness (tmux)

The regression harness is a Next.js page at `/regression/html`. Start the docs app in a tmux session:

```bash
cd /home/skra/projects/ql_homepage/stream-mdx

tmux new-session -d -s streammdx-docs 'npm run docs:dev > tmp/docs-dev.log 2>&1'
```

Wait until it responds:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/regression/html/
```

## Update snapshots (when intentionally changing output)

```bash
npm run test:regression:html:update
npm run test:regression:styles:update
```

## Validate (no output changes expected)

```bash
npm run test:regression:html
npm run test:regression:styles
```

## Stress scenario (heavy fixtures only)

Run the extreme throughput scenario against fixtures tagged `stress`:

```bash
npm run test:regression:html -- --scenario S6_extreme
```

## Interpreting failures

- HTML failures report the **first diff index** and show a small context slice for expected vs received.
- Style failures list the first handful of computed property changes.
- Invariant failures list the offending blocks or state values after finalize.
- Full expected/received payloads are written under `tests/regression/artifacts/<timestamp>/...`.

## Shut down the dev server

```bash
tmux kill-session -t streammdx-docs
```

## Notes

- These tests are local-only by design and should not be wired into CI yet.
- If you need new coverage, add fixtures under `tests/regression/fixtures/` and register them in `tests/regression/fixtures/index.ts`.
- The `S6_extreme` scenario only runs for fixtures tagged with `stress`. Use tags to keep the stress run focused on heavy fixtures.
- The regression harness waits for worker readiness, flushes patches, and stabilizes the renderer version before snapshotting to avoid flaky results.
