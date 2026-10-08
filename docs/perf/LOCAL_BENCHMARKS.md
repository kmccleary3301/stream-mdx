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
3. **Syntax Code Highlighting & Grammar**: Shiki syntax highlighter is enabled on both renderers with `diff` grammar support. StreamMDX parity uses the shared public `features.emitDiffBlocks = false`, so neither renderer adds structured diff cards. This flag exists in both baseline `4350a2a` and engine-v2.
4. **Streamdown Controls & Animation**: Streamdown MUST run with `controls={false}`, `isAnimating={false}`, and `animated={false}` to avoid mounting copy/download control dropdowns or running animation tickers.
   Parity also disables Streamdown link-safety buttons through its public 2.7.0 `linkSafety={{ enabled: false }}` configuration. `LinkSafetyConfig` is exported from `streamdown`. The API does not accept a boolean. Native parity renders plain anchors, and no private React state or callbacks are inspected.
5. **HTML, GFM & Footnotes**: MUST be enabled equally across both renderers.
6. **Streaming Incomplete Markdown Repair**: Enabled equally on both renderers. Streamdown runs `parseIncompleteMarkdown: true`. StreamMDX runs `formatAnticipation` enabled for inline, mathInline, mathBlock, html, with MDX anticipation disabled (`mdx: false`).
7. **No Custom Markup Overrides**: StreamMDX in parity mode MUST NOT pass custom component wrappers (`ScrollAreaHorizontal`, custom `Table`, `TableCell`) that swallow built-in features. It renders using native built-in element nodes (`defaultBlockComponents`, `defaultInlineComponents`, `defaultTableElements`, `defaultHtmlElements`).
8. **Deterministic Finalization & Timings**: Measurements MUST NOT capture unfinished DOM or arbitrary sleeps. StreamMDX uses the public `worker` factory prop to observe the real `WorkerOut.FINALIZED` response after `finalize()`, then awaits scheduler idle, finalized blocks, all lazy tokenization lines, and three frames with stable renderer version and DOM. Readiness traverses both public store descendants and serialized `meta.htmlTree`, `meta.htmlParagraphTree`, and `preparedNested` block ownership. Native HTML block slots use separate renderer stores. Streamdown awaits the final React text commit, settled public highlighting-plugin callbacks for every final code body, absence of skeletons, and three mutation-free frames. Both require completed KaTeX. Timeout, worker error, or navigation cancellation MUST invalidate the measurement, not publish a partial report. Caller-owned workers and listeners are released on success, error, and navigation.
9. **First committed content**: The legacy `firstFlushAt` field records the first post-run-start DOM mutation containing nonempty rendered markdown content under the same policy for both renderers. Empty worker initialization and scheduler flushes do not count. A missing start signal or missing committed content invalidates the report.
10. **Revision labels**: The runner supplies the installed package version to the page via `rendererVersion`. Package version identifies the release, while runner metadata `gitSha` identifies baseline versus candidate. Direct page visits without a version use an explicitly unknown StreamMDX label, never `engine-v2`.
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

Comparisons require matching SHA-256 hashes of full canonical records, not merely equal text lengths or DOM counts. Records retain logical text, verbatim fenced and inline code, authored `<pre>` whitespace and siblings even with a `<code>` child, math source/display mode, heading levels, table cells/alignment, list numbering/tasks, link destinations, and semantic HTML attributes. Ordered enter/exit events associate headings, lists/items, tables/cells, links, code, math and emphasis with repeated text occurrences and preserve nesting while ignoring styling wrappers.

Only an actual `h2.sr-only#footnote-label` directly owned by `section[data-footnotes]` is classified as generated rather than authored. The generated heading's HTML is recorded separately. Streamdown's real footnote section does not set `aria-labelledby`; footnote references use `aria-describedby="footnote-label"`. Footnote body text, reference attributes and backlinks remain in the canonical records. Raw final DOM HTML, raw heading counts and generated-label HTML remain in each `run.json`.

`perf:compare --gate` and `perf:gate` reject missing or divergent canonical hashes, fixture/chunk trace hashes, feature policies, per-run evidence, and primary-metric values. Invalid comparisons cannot print `[ok]`. The primary metric is median main-thread CDP TaskDuration delta in milliseconds, configurable with `--taskMedianMaxPct`. End-to-end duration and other timing/heap metrics remain separate diagnostics and guardrails.
The CDP-controlled runner captures start metrics before acknowledging the page's first feed command. After real renderer completion, the page pauses before semantic DOM collection until the runner captures end metrics. This includes early chunks and excludes canonicalization/hash work from the primary interval. Both handshake waits reject timeout or navigation cancellation.

## Baseline `4350a2a` Run Plan

To measure engine-v2 baseline commit `4350a2a` under the exact same fair harness byte/config snapshot on a quiet machine without altering baseline runtime code:

```bash
# 1. Target existing baseline worktree (.worktrees/ev2-baseline at 4350a2a, npm ci already completed)
cd /Users/kylemccleary/projects/ql_homepage/stream-mdx/.worktrees/ev2-baseline

# 2. Copy ONLY benchmark-only harness files and scripts (no runtime package code)
rsync -av ../ev2-perf-completion/apps/docs/components/perf/ apps/docs/components/perf/
rsync -av ../ev2-perf-completion/scripts/perf/ scripts/perf/

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

## Completion acknowledgment proof

Source inspection on 2026-10-07 confirmed that baseline `4350a2a` and the candidate both emit the public `WorkerOut` message `{ type: "FINALIZED" }` after final block diffing, canonical snapshot dispatch, and deferred patch flushing. Baseline implementation is `packages/markdown-v2-worker/src/worker.ts`, `finalizeAllBlocks`; candidate implementation is `packages/markdown-v2-worker/src/engine/engine.ts`, `MarkdownEngine.finalizeAllBlocks`. Scheduler `waitForIdle()` alone is not a worker completion acknowledgment.

Only the shared benchmark commit may be copied to the baseline by the parent. No runtime changes or public completion API are required. Production smoke evidence and quiet-machine comparison evidence are separate. A single S6 smoke is not a performance claim.

### Production smoke, 2026-10-07 local time

Isolated branch `ev2/perf-completion` was built from `feat/engine-v2` at `525dfe7`. Benchmark instrumentation commits are `c491bd7`, `8322d70`, and `ac1e0cf`. `npm run docs:build` completed package builds, hosted worker generation, and docs snapshots, then its first docs typecheck rejected `Promise.withResolvers` under the existing library declarations. The benchmark-local ES2024 promise reference fixed this without changing project compiler configuration. Final `npm -w stream-mdx-docs run build` passed compilation, typechecking, and generation of all 74 pages. Build output: `artifact://2273`.

Each successful browser smoke used the real production docs server on port 3037, Chromium 153, `naive-bayes/S6_extreme`, parity profile, `--runs 1 --warmup 0`. These single runs are completion checks, not performance samples. Both consumed all 22,714 fixture characters. Their shared artifact root is `.codex-optimization/runs/20261007-211411-engine-v2-comparison/perf-completion-smoke/` in the parent `ql_homepage` directory.

| Renderer | Successful artifact directory | Page package version | Post-start first content |
| --- | --- | --- | --- |
| StreamMDX | `streammdx-naive-bayes-S6_extreme-2026-10-08T05-00-17-251Z` | `0.4.0` | 218 ms |
| Streamdown | `streamdown-naive-bayes-S6_extreme-2026-10-08T05-02-17-251Z` | `2.7.0` | 10.4 ms |

StreamMDX published its report only after the real worker completion acknowledgment, scheduler drain, and final DOM checks. Streamdown's first smoke correctly rejected its report on highlighting timeout. Browser inspection showed that its code lines are block spans with no separating text nodes, with a newline sentinel for empty lines. `ac1e0cf` reconstructs those rendered line boundaries before matching public highlighting-plugin inputs. The corrected production smoke then completed successfully.

Semantic equivalence is **not proved** by these smoke runs. Both reported 19 code elements, 7 inline code elements, 2 tables, 14 table rows, 36 list items, and 27 math expressions. Their normalized semantic text lengths and hashes differed: StreamMDX 17,208 / `736daa86c75db726dcfbb8f834f52364a01f44c00e11dcb682cf7e1f5c359fba`; Streamdown 17,253 / `028b504b8183bd4f68aebb10c02bc803b6f095b44575dfe9f7ca5024c7b77dfa`. Wrapper-dependent `pre` counts also differed, 24 versus 12. Preserve the rich/parity correctness checks and investigate semantic differences before any comparison claim.

No baseline files were changed. The parent must copy the identical benchmark instrumentation to baseline, integrate remaining runtime work, rebuild, and run the contracted quiet-AC warmup plus three measured runs per renderer/scenario. The smoke servers were stopped.

## Final guard proof, 2026-10-07 local time

The source under review is `dfc3cac59c3809233a36d41961d630b4159eedf1` on `ev2/perf-completion`. This is benchmark-only work on the inherited runtime snapshot, not the parent's final integrated engine-v2 revision. The earlier smoke above and intermediate runs are superseded by this proof.

`npm exec -- tsx scripts/perf/check-completion-guards.ts` passed all real DOM counterexamples, including verbatim authored PRE whitespace, PRE siblings and descendant links/code, repeated link/emphasis/code occurrences, heading/list positions, styling-wrapper equivalence, actual Streamdown public link-safety output, and its generated footnote label. Serialized HTML block-slot readiness tests cover both ownership tree fields and prepared nested metadata. CLI smoke checks prove semantic, fixture, chunk and missing-evidence invalidity reject both comparison gates.

The full `npm run docs:build` built packages, the hosted worker and snapshots. Its first Next typecheck caught an `Element` versus `HTMLPreElement` lookup type mismatch, repaired with the same explicit DOM element query convention used for inline code. Source-review corrections then required affected-app rebuilds. The final `npm -w stream-mdx-docs run build` passed compilation, typechecking and all 74 static pages after the last semantic walker and CDP handshake changes. Final guard/build output is `artifact://2483`; the initial full build output is `artifact://2461`.

The final harness also compiled against preserved baseline built-entry declarations with zero diagnostics. That check used baseline React types and Next ambient declarations to avoid duplicate cross-worktree React identities, with baseline application imports and baseline `@stream-mdx/react`/`@stream-mdx/core` built exports. Evidence is `baseline-built-entry-typecheck.json` under the final artifact root below. No baseline files or runtime packages were edited.

The final production server was started with `npm -w stream-mdx-docs run start -- --port 3037`. Each renderer then ran:

```bash
npm run perf:harness -- --baseUrl http://localhost:3037 \
  --renderer streammdx --profile parity --fixture naive-bayes \
  --scenario S6_extreme --runs 1 --warmup 0 \
  --out .codex-optimization/runs/20261007-engine-v2-guard-finish-final
# Repeat the identical command with --renderer streamdown.
```

Both completed after the final handshake-controlled CDP boundaries and consumed 22,714 characters in the same 1,136 chunks. Fixture SHA-256 is `fcb46279b829f97a15d391dbb2aad611fa09231ca03d0ddf7583ab64b81dd30b`; chunk trace SHA-256 is `75d1279fb41353a88891efd037e257b7e94e1d2545c067650b7d29a0f44bdf90`.

Final artifacts are inside `.worktrees/ev2-perf-completion/.codex-optimization/runs/20261007-engine-v2-guard-finish-final/`:

| Renderer | Artifact directory | Package version | First committed content |
| --- | --- | --- | --- |
| StreamMDX | `streammdx-naive-bayes-S6_extreme-2026-10-08T06-08-55-664Z` | `0.4.0` | 198.5 ms |
| Streamdown | `streamdown-naive-bayes-S6_extreme-2026-10-08T06-09-03-055Z` | `2.7.0` | 8.8 ms |

These are completion smokes, not speed evidence. The real paired comparison was deliberately run with `npm run perf:compare -- --base <native-directory> --candidate <streamdown-directory> --gate --out <artifact-root>/comparison.txt`. It exited 1 with `INVALID COMPARISON`, because the canonical records diverge. Neither `[ok]` nor a clean-regression claim was emitted.

The final records preserve concrete differences rather than stripping content to pass. Native and Streamdown have the same 36 authored heading records; Streamdown's extra raw heading is the separately recorded generated `Footnotes` label. The native `Hyperlink` href is `https://www.example.com`, while Streamdown emits `https://www.example.com/`, from fixture line 128. At fixture line 319, Streamdown emits the footnote reference anchor `#user-content-fn-1`; the inherited native runtime has no corresponding anchor. Both retain the definition body from line 470, but their backrefs are `#fnref:1` and `#user-content-fnref-1`. Full records and raw DOM HTML remain in each `run.json`.

The final semantic hashes are native `6dd860b219e756343a467a57ffad92427963a9e2de1041286b467235f26c220c` and Streamdown `83a899c4eeb0a7cd1bfe04ff816d87eed45c1c51cb2a38c4bf04beaca23df592`. Both preserve 19 code elements, 7 inline code elements, 2 tables, 14 rows, 36 list items and 27 math expressions. The stale inherited server and both replacement smoke services were stopped. Parent-owned integration, baseline rebuilding and quiet warmup-plus-three-run measurement remain separate gates.

### Absolute URL normalization follow-up

After the paired source proof above, the canonical collector now uses standard `new URL(url).href` for explicit absolute HTTP(S) link destinations, in both link records and ordered href attributes. `https://www.example.com` and `https://www.example.com/` have the same browser destination and no longer create a false mismatch. Relative targets stay relative; distinct path, query, fragment and footnote-reference targets remain distinct. Raw DOM HTML remains unchanged evidence. Real DOM counterexample checks cover equivalent URL forms and materially different destinations.
`npm exec -- tsx scripts/perf/check-completion-guards.ts` passed after this change, including all earlier semantic/readiness/gate checks and the new URL equivalence counterexamples.

No new production build or performance sample is claimed for this collector-only follow-up. The parent owns the final integrated production build and comparison; the missing source footnote anchor remains a real preserved difference.

### Native control and navigation attributes

The ordered collector also retains effective live checked/disabled state for every native checkbox, including inputs outside lists and additional inputs within one item. It records anchor target, rel and download semantics. Standard target keywords are case-normalized; rel tokens are case-normalized, deduplicated and sorted. Different navigation contexts, rel behaviors, download filenames and checkbox states remain distinct. Initial checkbox attributes cannot hide a later live checked-state change.
`npm exec -- tsx scripts/perf/check-completion-guards.ts` passed after these additions, including outside-list, multiple-checkbox and live-property counterexamples plus target/rel/download behavior. This remains collector-only proof; no new production or performance claim.

### Resolved generated footnote target graph

The collector resolves generated footnote links within the measured root, requiring a unique DOM ID and the native or Streamdown generated footer/reference signature. Definition identities use footer and item ordinals; reference identities use their document occurrence within that definition. Both ordered href attributes and link records use this resolved graph. Generated ID namespaces alone are not content differences, but unresolved targets, missing IDs and duplicate IDs remain distinct. Backreference destinations must resolve to an occurrence belonging to their own definition. Counts, document locations, footnote bodies and control text remain intact.

ARIA ID references normalize only when they uniquely resolve to the actual generated footnote label. Authored headings, arbitrary fragment links and authored ARIA remain literal. Raw DOM evidence retains all original IDs, hrefs and attributes. Real DOM guards cover equivalent generated graphs, twelve occurrences, dangling/missing/duplicate targets, backreference counts/order, body differences and authored lookalikes. Parent-owned runtime repairs and the final integrated paired smoke are separate from this collector change.

`npm exec -- tsx scripts/perf/check-completion-guards.ts` passed after the resolved-graph change, including the real public Streamdown footnote DOM. No new production sample is claimed; the earlier paired artifacts remain pinned to their recorded source.

### Parent paired-smoke collector corrections

The parent's `canonical-footnote-smoke` raw DOM exposed a generated native outer PRE frame around the highlighted fence. The collector now recognizes that exact public ownership structure and atomizes it once. An outer PRE with authored sibling text does not qualify; authored whitespace/content guards remain. Only generated fence highlighting normalizes an omitted language to the public plain-text default. Distinct language labels and authored code annotations remain significant.

Generated footnote identities now independently qualify for HTML diagnostic records, without suppressing meaningful ARIA, navigation target or rel attributes. UL/OL contribute explicit structural separators to flat text; ordered list events remain unchanged. Image-associated literal fence-like text is not weakened.

The actual paired evidence also contains true incompatibilities: native same-paragraph `$$` math is display math and splits paragraph structure, whereas Streamdown renders it inline. Streamdown's generated reference has `_blank`/`noopener noreferrer` navigation and generated-label ARIA; native references retain same-page navigation. These differences remain semantic gate failures, not normalization targets. No content-compatible timing or speed claim follows from the pair.

The final DOM checker passed after these corrections. Reprojecting the parent's actual saved DOM with the corrected collector yields matching code blocks (12), authored preformatted blocks (0), inline code (7), headings (36), tables (2) and links (4). Canonical records still differ: display/paragraph math events, reference/backreference ARIA and navigation attributes, the native footer HR, and retained text/paragraph boundaries. This reprojection is not a new browser sample or timing measurement.



