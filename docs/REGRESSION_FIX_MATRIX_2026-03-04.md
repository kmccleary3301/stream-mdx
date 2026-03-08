# Regression Fix Matrix (2026-03-04)

## Scope
This matrix is based on:
- `npm run test:regression:html` (failed)
- `npm run test:regression:styles` (failed)
- `npm run determinism:matrix` (passed)
- `npm run determinism:html-parity` (passed)

Artifacts are under `tests/regression/artifacts/2026-03-04T20-*`.

## Clustered Failures

### C1: MDX Error Render Contract Drift
- Symptoms:
  - HTML snapshot mismatches across `mdx-preview-block`, `mdx-components`, `mdx-transitions` scenarios.
  - Checkpoint ordering drift (`event-hasBlockquote` vs `event-hasPre`) from extra fallback `<pre>` appearing early.
- Root cause:
  - Error UI structure changed from legacy `.markdown-mdx.error` + inline message to new nested panel + fallback code block.
- Primary code surface:
  - `packages/markdown-v2-react/src/components/index.ts` (MDX block renderer).
- Risk:
  - Medium; can break docs selectors and snapshot contracts.
- Fix strategy:
  - Restore legacy-compatible wrapper/markup for error state by default.
  - Gate richer fallback UI behind explicit opt-in (future follow-up), not default path.

### C2: Incremental Code Snapshot Drift (Checkpoint-Only)
- Symptoms:
  - `kitchen-sink`, `naive-bayes`, `code-highlight-incremental` fail at intermediate checkpoints while final HTML can match.
  - `data-code-total-lines`/`mounted-lines` transiently report `0` where expected `1`.
- Root cause:
  - Code block metadata uses `lines.length` even when only block-level highlighted/raw content exists before `appendLines` patches.
- Primary code surface:
  - `packages/markdown-v2-react/src/renderer/node-views.tsx`.
- Risk:
  - High for streamed UX consistency; can manifest as transient incomplete code rendering.
- Fix strategy:
  - Make metadata and initial render deterministic when line children are absent.
  - Ensure a stable first-line placeholder contract until line patches arrive.

### C3: Code Virtualization Contract Shift
- Symptoms:
  - `code-huge/*` final HTML mismatches (virtualized structure, mounted lines, container DOM).
- Root cause:
  - Virtualized code renderer now active by default for large code blocks; snapshots are from pre-virtualized contract.
- Primary code surface:
  - `packages/markdown-v2-react/src/renderer/node-views.tsx`
  - `packages/markdown-v2-react/src/renderer/virtualized-code.tsx`
- Risk:
  - High; changes DOM shape and can hide lines if scheduling/measurement is wrong.
- Fix strategy:
  - Decide explicit contract: default-off for deterministic snapshots or maintain virtualized-on and update contract/tests.
  - For this fix pass, prioritize correctness/determinism over optimization defaults.

### C4: Style Baseline Drift (Global Typography + Code + Marker Geometry)
- Symptoms:
  - Widespread style mismatches (`h1/h2`, `pre` padding, list marker offsets).
- Root cause:
  - Docs typography/CSS scale changed, and code wrapper/pre layout changed.
- Primary code surface:
  - `apps/docs/app/globals.css`
  - `apps/docs/app/prose.css`
- Risk:
  - Medium; mostly presentation contract drift but can affect readability and marker alignment.
- Fix strategy:
  - Re-align regression harness style contract to intended production values.
  - Add targeted assertions for list marker alignment and footnote dark mode.

### C5: Missing Snapshot Coverage
- Symptoms:
  - Missing snapshots for `mixed-content-golden` and `math-mdx-sentinel` (HTML/style).
  - Missing selector `.katex` in `math-mdx-sentinel`.
- Root cause:
  - Fixture/snapshot registration incomplete or fixture content no longer satisfies selector expectations.
- Primary code surface:
  - `tests/regression/fixtures/*`
  - `tests/regression/snapshots/*`
  - `tests/regression/style-targets.ts`
- Risk:
  - Medium; blind spots in strict suite.
- Fix strategy:
  - Resolve fixture/selector contract and commit complete baselines only after behavioral fixes land.

## Execution Order
1. C1 (MDX error contract): highest leverage, lowest implementation risk.
2. C2 (incremental code metadata): stream-correctness critical.
3. C3 (virtualization contract): choose deterministic default, then enforce via tests.
4. C4 (style contract): stabilize typography/code/list marker expectations.
5. C5 (missing coverage): finalize snapshots after behavior is stable.

## Required Verification per Cluster
- Cluster unit tests (renderer + worker where applicable).
- `npm run test:regression:html`.
- `npm run test:regression:styles`.
- `npm run determinism:matrix`.
- `npm run determinism:html-parity`.
