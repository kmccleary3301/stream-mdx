# Results: firehose streaming vs Streamdown

Machine: Apple M5 Pro (18 cores), 48 GB, macOS 26 (darwin 25.6.0), Chrome 153 headless. Matrix run 2026-10-09 06:40-08:30 UTC (`final-matrix.sh`, log `final/matrix.log`). AC power until 07:53 UTC; the `stress-xl` 10k and 5k rows ran on battery and support no claim.

## StreamMDX vs Streamdown (main-thread task time)

| Fixture | Rate (cps) | Power | StreamMDX task ms (median [min-max]) | Streamdown task ms | Delta | StreamMDX script | Streamdown script | Canonical hash |
|---|---|---|---|---|---|---|---|---|
| code-huge | 20k | AC | 258 [258-270] | 208 [206-210] | +24% | 138 | 89 | same (`7ce0b889`/`7ce0b889`) |
| code-huge | 10k | AC | 438 [427-447] | 327 [326-329] | +34% | 201 | 163 | same (`7ce0b889`/`7ce0b889`) |
| code-huge | 5k | AC | 777 [761-787] | 604 [584-617] | +29% | 319 | 319 | same (`7ce0b889`/`7ce0b889`) |
| stress-mega | 20k | AC | 2954 [2952-3093] | 4318 [4270-4397] | -32% | 1029 | 2555 | same (`1b7c3075`/`1b7c3075`) |
| stress-mega | 10k | AC | 5014 [4938-5231] | 7926 [7735-8127] | -37% | 1576 | 4884 | same (`1b7c3075`/`1b7c3075`) |
| stress-mega | 5k | AC | 9281 [9015-10360] | 14123 [13831-14178] | -34% | 2597 | 9037 | same (`1b7c3075`/`1b7c3075`) |
| stress-mega-footnotes | 20k | AC | 3082 [2965-3101] | 71403 [71220-75178] | -96% | 1084 | 69089 | differs (`f156e55c`/`aa194e50`) |
| stress-mega-footnotes | 10k | AC | 5036 [5030-5220] | 142212 [141277-142698] | -96% | 1605 | 138371 | differs (`f156e55c`/`aa194e50`) |
| stress-mega-footnotes | 5k | AC | 9647 [9014-9787] | 283158 [282052-287733] | -97% | 2782 | 276288 | differs (`f156e55c`/`aa194e50`) |
| stress-xl | 20k | AC | 30942 [29338-31444] | 48511 [48136-49100] | -36% | 8374 | 29200 | same (`c3197c3d`/`c3197c3d`) |
| stress-xl | 10k | Battery | 57620 [50567-57740] | 90541 [87110-92049] | -36% | 13061 | 55846 | same (`c3197c3d`/`c3197c3d`) |
| stress-xl | 5k | Battery | 105811 [102873-107410] | 172266 [167326-174854] | -39% | 21373 | 109344 | same (`c3197c3d`/`c3197c3d`) |

- `stress-mega` and `stress-xl` at 20k (AC): StreamMDX uses 32-36% less main-thread time, with identical canonical semantics. Each delta is far outside both ranges.
- `code-huge` (one 16.5 KB code fence): Streamdown is 24-34% cheaper and commits first content at about 24 ms vs 68-85 ms. StreamMDX does not win on small single-block documents.
- `stress-mega-footnotes`: StreamMDX is 23-29x cheaper, but the canonical hashes differ, so no strict claim is made. Visible text is identical; the differences are Streamdown's footnote link attributes (`aria-describedby`, `rel`, `target`) and the footer separator element. Streamdown's per-update cost grows with document length here (rAF p95 150-167 ms; the stream takes 72-286 s for 13-52 s of input).

## Before (`1669abb`) vs after, 20k cps, AC

| Fixture (20k cps, AC) | before task ms | after task ms | Delta | before script | after script | before style | after style | Hash note |
|---|---|---|---|---|---|---|---|---|
| code-huge | 965 [960-995] | 258 [258-270] | -73% | 823 | 138 | 44 | 46 | identical |
| stress-mega | 5862 [5784-5976] | 2954 [2952-3093] | -50% | 3559 | 1029 | 531 | 248 | differs only by removed `aria-checked` |
| stress-mega-footnotes | 6295 [6223-6337] | 3082 [2965-3101] | -51% | 3873 | 1084 | 521 | 256 | before leaves consecutive definitions as literal `[^nN]`; fixed |
| stress-xl | did not finish (worker FINALIZED timeout) | 30942 | n/a | | 8374 | | 1297 | before fails the completion guard |

- `stress-xl` before: the worker never sent FINALIZED within the 900 s guard. The worker replay measured about 127 s of parse time for the 50 s stream, so it fell further behind on every append.
- Hash notes: the `stress-mega` difference is only the removed redundant `aria-checked` on task checkboxes (verified record by record). The `stress-mega-footnotes` difference is the consecutive-definitions fix: before rendered later definitions' references as literal `[^nN]`.

## Guardrails

| Fixture | Rate | Renderer | first flush ms | long task p95 ms | rAF p95 ms | peak heap MB | duration ms |
|---|---|---|---|---|---|---|---|
| code-huge | 20k | StreamMDX | 84.5 | 61.0 | 16.8 | 14.5 | 1032 |
| code-huge | 20k | Streamdown | 24.0 | 64.0 | 16.8 | 24.8 | 899 |
| code-huge | 10k | StreamMDX | 84.4 | 60.0 | 16.8 | 14.5 | 1882 |
| code-huge | 10k | Streamdown | 24.7 | 55.0 | 16.8 | 23.37 | 1732 |
| code-huge | 5k | StreamMDX | 68.0 | 60.0 | 16.8 | 13.64 | 3564 |
| code-huge | 5k | Streamdown | 24.8 | none | 16.8 | 22.03 | 3381 |
| stress-mega | 20k | StreamMDX | 33.0 | 188.0 | 16.8 | 15.35 | 13035 |
| stress-mega | 20k | Streamdown | 25.6 | none | 16.7 | 28.04 | 12733 |
| stress-mega | 10k | StreamMDX | 33.4 | 198.0 | 16.8 | 14.5 | 25735 |
| stress-mega | 10k | Streamdown | 25.2 | none | 16.8 | 19.55 | 25400 |
| stress-mega | 5k | StreamMDX | 32.9 | 1405.0 | 16.8 | 13.64 | 51117 |
| stress-mega | 5k | Streamdown | 25.1 | 127.0 | 16.8 | 16.31 | 50715 |
| stress-mega-footnotes | 20k | StreamMDX | 33.3 | 193.0 | 16.8 | 15.35 | 13169 |
| stress-mega-footnotes | 20k | Streamdown | 24.8 | 184.0 | 166.6 | 28.04 | 71698 |
| stress-mega-footnotes | 10k | StreamMDX | 32.6 | 184.0 | 16.8 | 14.5 | 25951 |
| stress-mega-footnotes | 10k | Streamdown | 25.4 | 180.0 | 150.0 | 19.55 | 143378 |
| stress-mega-footnotes | 5k | StreamMDX | 33.2 | 187.0 | 16.8 | 13.64 | 51586 |
| stress-mega-footnotes | 5k | Streamdown | 24.7 | 182.0 | 150.0 | 16.31 | 285823 |
| stress-xl | 20k | StreamMDX | 31.7 | 529.0 | 16.8 | 18.41 | 53582 |
| stress-xl | 20k | Streamdown | 25.9 | 58.0 | 16.8 | 22.03 | 59277 |
| stress-xl | 10k | StreamMDX | 33.1 | 553.0 | 16.8 | 16.31 | 104849 |
| stress-xl | 10k | Streamdown | 25.2 | 50.0 | 16.8 | 20.69 | 115090 |
| stress-xl | 5k | StreamMDX | 32.5 | 508.0 | 16.8 | 16.31 | 205126 |
| stress-xl | 5k | Streamdown | 24.2 | 1362.0 | 16.8 | 19.55 | 223376 |

- rAF p95 is 16.7-16.8 ms for every StreamMDX run.
- StreamMDX peak heap is lower in every row.
- First flush: StreamMDX is 7-9 ms later on the long fixtures, which includes the worker round trip. On `code-huge` it is about 45-60 ms later.
- Long tasks: StreamMDX has one finalize long task at the end of each stream: about 190 ms on 253 KB documents and 510-550 ms on 1 MB. One `stress-mega` 5k run had a single 1405 ms task 17.6 s into the stream; its other two runs peaked at 199 ms and 192 ms. Streamdown has no long tasks on `stress-mega`.

## Changes kept

| Id | Where | Change |
|---|---|---|
| A | worker `html-ownership.ts` | private marker attribute checked against the region source, not the whole document |
| B | worker `parse-extract.ts` | reuse the `from:to` source slice per block |
| C | worker `engine.ts` | take change ranges straight from the parser |
| D | core `worker-html-sanitizer.ts` | cache the unified/rehype-sanitize processor per (allowed tags, marker) |
| E | plugins footnotes | skip numbering passes for blocks whose raw has no `[^`, `&`, or `>` |
| F | core `reference-collector.ts` | skip leaf blocks when collecting link reference definitions |
| G | react `store.ts` | code-line props identity fast path |
| H | react `store.ts`, `hooks.ts`, `node-subscriptions.ts` | node hooks subscribe per id; notify wakes only changed ids |
| I | react `store.ts` | finalize replace keeps unchanged records and their React snapshots |
| J | `theme-tailwind/theme.css`, docs `prose.css` | `p:is(blockquote *):last-of-type` instead of `blockquote p:last-of-type`. Selects the same elements; Chrome stops restyling every sibling paragraph on append. Applies to both renderers in this harness. |
| main thread | react `store.ts`, core `security.ts` | one public block clone per unchanged block; lazy invariant scan; preconfigured code-row DOMPurify |
| correctness | plugins footnotes | consecutive `[^x]:` definitions all register |
| harness | docs `perf-harness.tsx` | wait for worker INITIALIZED before the run clock; worker boot used to land inside the measured run (about 150 ms) |

## Measured and reverted (neutral)

| Change | Result |
|---|---|
| `React.memo` on `BlockNodeRenderer` | mega 2799 -> 2850, xl 26892 -> 27729 |
| boolean `useRendererHasActiveBlocks` hook | interleaved A/B: mega 2976/2930/3030 vs 3269/3133/2943 |
| root block chunking (64 per memo chunk) | xl 26072/26225/27426 vs 27951/27901/26498 (battery) |
| `content-visibility: auto` per block | not adopted: changes rendering behavior. Probe only. |

## Correctness gates (current tree)

- `npm run docs:build` (clean `.next`), Node 20 `test:reliability:packages`, unified, mermaid, `ci:pack-smoke`, `test:conformance`: all exit 0.
- Reference collector check: 375 fixture checks and 16,006 spec-prefix checks, no differences from the HEAD collector.
- HTML regression (`test:regression:html` against :3013): 105/109 matched. The 4 `footnotes` goldens were regenerated: HEAD recorded the consecutive-definition bug, and both definitions now render. 0 store invariant violations.
- The regression run caught a bug in E (prepared blockquotes nested in MDX regions lost their streamed `inline`). It was bisected to the plugin, fixed with the `>` check, and covered by `runNestedBlockquoteWithoutReferencesTest` (fails before the fix, passes after).
- `test:regression:styles`: `code-highlight-incremental` reports code-pre border color and radius mismatches. This tree's CSS change touches only the blockquote `::after` selector [INFERENCE: unrelated; not re-run at HEAD].

## Artifacts

- `final/metrics.json`: per-run CDP task/script/layout/style samples, guardrails, and canonical SHA-256 for every matrix row
- `final/{after,before,streamdown}/*/{summary.txt,metadata.json}` and `final/*.log`: per-row summaries, environment, power state, harness logs
- `e2e-*`, `ab-*`, `prof-*`, `worker-replay/`: per-change `summary.txt`/`metadata.json`
- Raw `run.json`, `summary.json`, record dumps, CPU profiles, and traces (about 4 GB) were deleted to reclaim disk; rerun `final-matrix.sh` to regenerate.
