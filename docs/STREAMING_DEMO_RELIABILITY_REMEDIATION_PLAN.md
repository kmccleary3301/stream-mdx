# Streaming Demo Reliability Remediation Plan

Last updated: 2026-03-03 (afternoon tranche, phase 4 gate expansion)
Owner: StreamMDX docs + renderer pipeline

## Scope

This plan tracks the remaining failures observed on the streaming demo and benchmark surfaces after the initial list-structure and store-isolation fixes.

Remaining user-reported classes:

1. MDX segments intermittently skipped.
2. Code block content incomplete or out of order.
3. Table cells incomplete/truncated.
4. List marker/padding standardization (unordered bullets vs ordered numbers).
5. Footnote dark-mode contrast issues.
6. Regression coverage gaps (failures escaped existing strict suites).

Fixed previously (already landed in this branch):

- Nested list lookahead marker leakage.
- Imaginary nested-list break / empty nested list render.
- Multi-store snapshot cache aliasing (`Maximum update depth` class).

## Non-Negotiable Standard

- Final output must be deterministic and chunk-size independent.
- Deferred/streaming state must not leak malformed intermediate structure into finalized output.
- Known failure classes must be covered by deterministic regression tests (no manual-only validation).

## Execution Strategy

## Phase 0: Baseline + Repro Lock

- [x] Enumerate canonical repro fixtures for each failure class.
- [x] Define matrix of chunk sizes / cadence proxies:
  - `chunk=1` (pathological low-speed)
  - small primes (`3, 5, 7, 11`)
  - medium realistic (`37, 89`)
  - coarse (`233+`)
- [x] Capture baseline signatures from non-streamed append+finalize runs.
- [x] Ensure all streaming scenarios compare against the same baseline signatures.

Acceptance:
- Every scenario produces a stable baseline signature and can be rerun locally with no flake.

## Phase 1: Determinism + Integrity Harness Hardening

- [x] Extend worker fidelity matrix to explicitly include:
  - MDX inline + block transitions.
  - Table width/content parity.
  - Code line ordering/completeness parity.
- [x] Assert invariants at every append step and post-finalize:
  - at most one dirty tail block
  - finalized prefix immutability
  - no empty nested lists
  - code-line indices contiguous
  - finalized table rows match header width + baseline content
  - finalized code text reconstructed from line nodes equals raw code payload
- [x] Add scenario-specific stress coverage for very low-speed streaming (`chunk=1`) across full coverage fixture (not just prefix windows).
- [x] Add finalized node-tree parity assertions (renderer store subtree shape) so list-item segment drift is detected even when block payload appears equal.
- [x] Expand coverage fixture sweep across prime/realistic/coarse chunk sizes with jittered credits.

Acceptance:
- Fidelity matrix fails on any structural drift for MDX/table/code/list invariants.
- Finalized snapshots are chunk-size independent.

## Phase 2: Rendering/State Fixes for Remaining Functional Failures

### 2.1 MDX Segment Continuity

- [x] Audit mixed-segment generation for `paragraph|blockquote|list-item` under anticipation.
- [x] Verify no segment loss when MDX boundaries split across chunks.
- [x] Patch segment extraction so paired MDX tags are captured as one segment (instead of opening-tag-only segments).
- [x] Add regression fixture for paired MDX component extraction in core tests.
- [x] Add worker-level chunk-boundary regression explicitly splitting MDX open/body/close across append boundaries.

Acceptance:
- MDX segment counts and ordering are stable and match baseline across all chunk scenarios.

### 2.2 Code Block Integrity

- [x] Audit `appendLines` coalescing + store application ordering.
- [x] Verify line reindexing and subtree replacement cannot reorder finalized lines.
- [x] Patch ordering/canonicalization via finalized line-count validation + snapshot rebuild fallback.
- [x] Add regression checks for full reconstructed code text equality.

Acceptance:
- Reconstructed code text from rendered line nodes equals baseline for all scenarios.

### 2.3 Table Cell Integrity

- [x] Audit table snapshot generation for partial rows/cells during streaming.
- [x] Ensure finalize path cannot preserve partial cell text when full text exists (validated via parity checks).
- [x] Add regression checks comparing finalized header and row cell plain text to baseline.
- [x] Add worker-level synthetic table stress fixture with explicit cell boundary slicing (`|` and newline split every character).

Acceptance:
- Finalized table cell text is identical to baseline across all scenarios.

## Phase 3: Visual Parity & CSS Correctness

### 3.1 List Marker/Padding Standardization

- [x] Compute ordered-list marker digit width at list-block level.
- [x] Standardize unordered marker column width to match ordered one-digit width.
- [x] Expand ordered marker column width only when marker digit count grows (10+ etc).
- [x] Keep nested list indentation consistent after marker-width normalization.
- [x] Add visual-snapshot/DOM assertion for nested ordered+unordered mixed lists to lock alignment.

Acceptance:
- Unordered and ordered lists visually align for one-digit lists.
- Ordered lists with multi-digit markers expand cleanly without misalignment.

### 3.2 Footnote Dark Mode Contrast

- [x] Re-tune footnote color variables for dark theme.
- [x] Ensure footnote indices and backlinks meet readable contrast.
- [x] Add style-target regression entry for footnotes in dark mode.

Acceptance:
- Footnotes remain readable in both light and dark themes without washed-out text.

## Phase 4: Regression Gate Expansion

- [x] Update test documentation with new invariants and fixtures.
- [x] Ensure test commands include new suites in package-level runs.
- [x] Add targeted benchmark/demo runtime checks for worker attach/restart races.

Acceptance:
- `@stream-mdx/worker` + `@stream-mdx/react` tests cover all known failure classes.
- Docs build succeeds and benchmark/demo smokes pass.

Implemented gate commands:

- `npm run test:reliability:packages`
- `npm run test:reliability:docs`
- `npm run test:runtime:worker-races`

## Current Tranche (In Progress)

Tranche 2 execution order:

1. [x] Land paired-MDX segment extraction fix and verify core/worker regressions.
2. [x] Add worker chunk-boundary MDX regression (open/body/close split across appends).
3. [x] Add table extreme-boundary regression (`chunk=1` around cell separators and row breaks).
4. [x] Add list alignment + dark-footnote visual regression checks.
5. [x] Run full worker/react/core/docs validation and capture remaining residual risk list.

## Newly Fixed Root Causes (This Tranche)

- Renderer store `setProps` now synchronizes node `type` when block type changes under stable id (e.g., `html -> mdx`), preventing stale renderer dispatch.
- Worker snapshot diff now treats child-node `(id,type)` as identity, so child type flips emit structural replace paths instead of stale `setProps`.
- Renderer store adds finalized table subtree canonicalization from block snapshots for touched table roots to eliminate stale/truncated trailing cells under aggressive coalescing.
