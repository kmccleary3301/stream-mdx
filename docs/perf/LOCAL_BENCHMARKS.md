# Local Perf Baselines

Use this log to track local perf harness runs while hill climbing. Each run writes a `summary.txt` and `summary.json`.

## Latest runs (2026-01-16)
- `tmp/perf-baselines/naive-bayes-S1_slow_small-2026-01-16T06-11-35-608Z`
- `tmp/perf-baselines/naive-bayes-S2_typical-2026-01-16T06-19-37-644Z`
- `tmp/perf-baselines/naive-bayes-S2_typical-2026-01-16T06-23-05-474Z` (includes `--profiler`)
- `tmp/perf-baselines/naive-bayes-S4_chunky_network-2026-01-16T06-21-10-866Z`
- `tmp/perf-baselines/table-large-S2_typical-2026-01-16T06-22-16-932Z`
- `tmp/perf-baselines/table-large-S6_extreme-2026-01-16T06-22-29-600Z`
- `tmp/perf-baselines/naive-bayes-S1_slow_small-2026-01-16T01-23-40-289Z`
- `tmp/perf-baselines/naive-bayes-S2_typical-2026-01-16T01-31-45-659Z`
- `tmp/perf-baselines/naive-bayes-S2_typical-2026-01-16T01-34-57-854Z` (includes `--profiler`)
- `tmp/perf-baselines/naive-bayes-S4_chunky_network-2026-01-16T01-33-19-667Z`
- `tmp/perf-baselines/table-large-S2_typical-2026-01-16T01-34-13-489Z`
- `tmp/perf-baselines/table-large-S6_extreme-2026-01-16T01-34-28-484Z`

Profiler note:
- `naive-bayes/S2_typical` (2026-01-16T06-23-05-474Z): actual p95 8.70 ms, base p95 128.40 ms.

## How to read
1. Open the text summary:
   `cat tmp/perf-baselines/<run>/summary.txt`
2. Check these p95 metrics:
   - `longTaskP95` for jank
   - `rafP95` for animation cadence
   - `memoryPeakMB` for heap growth
3. If `--profiler` is enabled, compare `profilerActual` vs `profilerBase`.

## Rerun commands
```bash
npx tsx scripts/perf/run-perf-harness.ts --fixture naive-bayes --scenario S1_slow_small --runs 3 --warmup 1 --out tmp/perf-baselines
npx tsx scripts/perf/run-perf-harness.ts --fixture naive-bayes --scenario S2_typical --runs 3 --warmup 1 --out tmp/perf-baselines
npx tsx scripts/perf/run-perf-harness.ts --fixture naive-bayes --scenario S2_typical --runs 3 --warmup 1 --out tmp/perf-baselines --profiler
npx tsx scripts/perf/run-perf-harness.ts --fixture naive-bayes --scenario S4_chunky_network --runs 3 --warmup 1 --out tmp/perf-baselines
npx tsx scripts/perf/run-perf-harness.ts --fixture table-large --scenario S2_typical --runs 3 --warmup 1 --out tmp/perf-baselines
npx tsx scripts/perf/run-perf-harness.ts --fixture table-large --scenario S6_extreme --runs 3 --warmup 1 --out tmp/perf-baselines
```

## Benchmark Profiles & Parity Policy Contract

The perf harness supports two configuration profiles:
- `--profile parity` (**Default**): Fair production baseline comparison.
- `--profile rich` (Legacy feature-rich configuration).

### Parity Contract Specification (RFC 2119)
1. **MDX & Callouts**: MUST be disabled on both StreamMDX (`features.mdx = false`, `features.callouts = false`) and Streamdown (no MDX plugin, no callouts).
2. **Math Rendering**: MUST use identical syntax parsing (`$...$` inline math with `singleDollarTextMath: true` and `$$...$$` display math) and identical KaTeX rendering outputting `htmlAndMathml` mode.
3. **Syntax Code Highlighting & Grammar**: Shiki syntax highlighter enabled by default on both renderers with `diff` language grammar support. Qualified as `diff: "grammar_only"` to reflect grammar support without claiming custom structured diff renderer parity.
4. **Streamdown Controls & Animation**: Streamdown MUST run with `controls={false}`, `isAnimating={false}`, and `animated={false}` to avoid mounting copy/download control dropdowns or running animation tickers.
5. **HTML, GFM & Footnotes**: MUST be enabled equally across both renderers.
6. **Streaming Incomplete Markdown Repair**: Enabled equally on both renderers. Streamdown runs `parseIncompleteMarkdown: true`. StreamMDX runs `formatAnticipation` enabled for inline, mathInline, mathBlock, html, with MDX anticipation disabled (`mdx: false`).
7. **No Custom Markup Overrides**: StreamMDX in parity mode MUST NOT pass custom component wrappers (`ScrollAreaHorizontal`, custom `Table`, `TableCell`) that swallow built-in features. It renders using native built-in element nodes (`defaultBlockComponents`, `defaultInlineComponents`, `defaultTableElements`, `defaultHtmlElements`).
8. **Deterministic Finalization & Timings**: Measurements MUST NOT capture unfinished DOM or arbitrary sleeps. StreamMDX awaits block finalization, lazy tokenization line completion, and version stability. Streamdown awaits full text commitment, absence of skeletons, and mutation quiescence. All rendering and tokenization work is included in the final run duration.
### Metric Classification: Live Attached DOM vs CDP Heap Retained Nodes

The harness and reports clearly distinguish between two fundamentally different node measurements:
1. **Live Document Subtree (Attached DOM Nodes)**:
   - Measured directly on the finalized live `#perf-root` container.
   - Subtree node counts: total element nodes (`liveElements`), `<pre>` (`livePre`), `<code>` (`liveCode`), fenced code blocks (`liveCodeBlocks`), inline code (`liveInlineCode`), `<table>` (`liveTable`), `<tr>` (`liveTr`), `<li>` (`liveLi`), `<math>`/KaTeX (`liveMath`).
   - Visible semantic content text: normalized text length (`semanticTextLength`) and cryptographic SHA-256 hash (`semanticTextHash`).
2. **CDP Process Heap DOM Counters (`Memory.getDOMCounters`)**:
   - Measures total DOM nodes across the entire browser renderer process heap (`cdpHeapTotalNodesEnd` and `cdpHeapTotalNodesDelta`).
   - **CRITICAL**: This metric includes detached uncollected DOM nodes and retained trees churned by repeated full-document re-renders (e.g. Streamdown's ~1,180 renders vs StreamMDX's fine-grained worker patch store). It must not be confused with the live attached DOM tree size.

### Semantic Equivalence Verification

Comparisons between candidate and baseline (or candidate and Streamdown) evaluate semantic equivalence across:
- Visible semantic text length delta and SHA-256 hash match.
- Count of rendered code blocks (`liveCode`, `livePre`).
- Count of rendered math expressions (`liveMath`).
- Count of rendered tables and list items (`liveTable`, `liveLi`).

## Baseline `4350a2a` Run Plan

To measure engine-v2 baseline commit `4350a2a` under the exact same fair harness byte/config snapshot on a quiet machine without altering baseline runtime code:

```bash
# 1. Target existing baseline worktree (.worktrees/ev2-baseline at 4350a2a, npm ci already completed)
cd /Users/kylemccleary/projects/ql_homepage/stream-mdx/.worktrees/ev2-baseline

# 2. Copy ONLY benchmark-only harness files and scripts (no runtime package code)
rsync -av ../ev2-perf-parity/apps/docs/components/perf/ apps/docs/components/perf/
rsync -av ../ev2-perf-parity/scripts/perf/ scripts/perf/

# 3. Add comparator dependencies to apps/docs/package.json (Streamdown 2.7.0 + code/math plugins):
#    "dependencies": {
#      "@streamdown/code": "2.0.0",
#      "@streamdown/math": "1.0.3",
#      "@streamdown/mermaid": "1.0.3",
#      "streamdown": "2.7.0"
#    }
npm install --workspace=stream-mdx-docs streamdown@2.7.0 @streamdown/code@2.0.0 @streamdown/math@1.0.3 @streamdown/mermaid@1.0.3

# 4. Build packages and docs app in baseline worktree
npm run build:packages
npm run docs:build

# 5. Execute parity benchmark on quiet machine (port 3010)
PORT=3010 npm -w stream-mdx-docs run start &
STREAM_MDX_PERF_BASE_URL=http://localhost:3010 npx tsx scripts/perf/run-perf-harness.ts \
  --renderer streammdx \
  --profile parity \
  --fixture naive-bayes \
  --scenario S2_typical \
  --runs 5 \
  --warmup 2 \
  --out tmp/perf-baselines/baseline-4350a2a
```
