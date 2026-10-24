# StreamMDX vs Streamdown

This comparison is deliberately narrow. It is not a claim that one project is globally "better" than the other. It is a technical comparison of runtime model, integration shape, and the behaviors our current harnesses are actually built to measure.

## Scope of this comparison

The current comparison is grounded in:

- local browser runs
- shared markdown fixtures
- seeded streaming scenarios
- one-shot static content-class runs

It does **not** claim universal latency or memory superiority across every browser, machine, or integration pattern.

It also does **not** treat the rich capability workload on the benchmark page as a direct parity result. That workload exists to show StreamMDX behavior when math, MDX, HTML, tables, code, and footnotes are active together; unsupported cells are intentionally excluded from cross-engine claim language.
## Short version

- **Choose Streamdown** if your priority is a minimal migration from `react-markdown` and you want streaming-tolerant formatting behavior without introducing a worker runtime.
- **Choose StreamMDX** if your priority is worker isolation, explicit incremental patching, richer plugin/runtime control, or better guardrails for long-running / high-frequency streams.

## Architecture

| Category | Streamdown | StreamMDX |
| --- | --- | --- |
| Execution model | Main-thread React rendering | Instance-scoped engine; worker, main-thread, or automatic execution |
| Rendering surface | React component, close to `react-markdown` ergonomics | Dedicated `StreamingMarkdown` renderer plus lower-level packages |
| Incremental model | Incomplete-markdown resilience + memoized rerendering | Explicit semantic/enrichment patch batches committed to a stable render tree |
| Long-document posture | Main-thread work scales with content updates | Worker offload, queueing, and patch scheduling intended to reduce main-thread pressure |
| Packaging | Single package | Modular packages plus `stream-mdx` convenience wrapper |

## Integration tradeoffs

| Topic | Streamdown | StreamMDX |
| --- | --- | --- |
| Install / adopt | Lower friction for existing `react-markdown` users | Higher setup cost because worker/runtime configuration matters |
| CSP / hosting | No worker hosting requirement | Hosted worker strongly recommended for production CSP clarity |
| Custom syntax | remark/rehype ecosystem, plus Streamdown behavior | Native Lezer/document plugins, serialized inline rules, optional finalized-block remark/rehype adapter |
| Terminal / protocol use | React-first surface | Dedicated TUI / protocol path exists |
| Operational visibility | Mostly renderer-level behavior | More moving parts, but more instrumentation and runtime controls |

## Feature surface (engine v2)

StreamMDX features below are default off unless stated, so default rendering is unchanged.

| Feature | StreamMDX | Notes / open gaps |
| --- | --- | --- |
| Code/table/Mermaid copy and download controls | `controls`, `controlsComponent`, `labels` | No `icons` or `prefix` customization props; replace the bar through `controlsComponent`. |
| Animated streaming text | `animated` (fade/blur/slide, stagger, reduced-motion CSS) | Static/SSR output is never animated. |
| Element filtering | `allowedElements`, `disallowedElements`, `allowElement`, `unwrapDisallowed`, `disableAutolinkProtocols` | Applied at render time across markdown and raw HTML. |
| Custom code presentations | `components.code.wrapper`, routed by `metadata.language` | |
| URL policy | Default denylist plus `urlTransform` | |
| Shiki themes | Configurable light/dark themes | |
| remark/rehype plugins | Optional adapter on finalized blocks | Streaming (non-finalized) blocks do not run remark/rehype. |
| Incomplete-markdown repair | Built into the incremental parser | No public hook to replace or extend it. |
| Artifacts | Sandboxed iframe renderer | No `artifact={{ Frame }}` replacement prop. |
## What the current harnesses are good at measuring

The current StreamMDX harnesses are good at comparing:

- first visible render under live incremental streaming
- final convergence under live incremental streaming
- patch-to-DOM latency distributions
- static render timing across prose / tables / code / mixed markdown

The harnesses are **not** yet a definitive public source for:

- absolute bundle-cost comparisons across all deployment shapes
- absolute memory superiority claims across all browsers
- every edge of incomplete-markdown recovery semantics

Read the benchmark page in two layers:

- parity workloads for direct renderer-vs-renderer comparison
- capability workloads for richer StreamMDX-only behavior inspection
## Security and isolation

| Topic | Streamdown | StreamMDX |
| --- | --- | --- |
| HTML / pipeline posture | Main-thread rehype/remark pipeline | HTML sanitization plus worker isolation options |
| Security operational model | Simpler runtime surface | Stronger isolation story when the worker is hosted deliberately |
| CSP implications | Simpler by default | Requires intentional worker policy (`blob:` vs hosted worker asset) |

## Conformance and Spec Parity (CommonMark 0.31.2 + GFM Extensions)

Harness: `scripts/conformance/run-commonmark.mts` evaluating 675 examples (652 CommonMark 0.31.2 + 23 GFM extension fixtures).

Comparing Streamdown with default chat sanitization against StreamMDX with `docPlugins.html: true` is unfair on HTML sections. Streamdown is evaluated under two configurations:
1. **Default**: chat sanitization and hardening enabled (`linkSafety: { enabled: false }`).
2. **Raw HTML**: raw HTML enabled and sanitization/hardening disabled via `rehypePlugins: [defaultRehypePlugins.raw]` (`linkSafety: { enabled: false }`).

| Evaluation Mode | StreamMDX (Static/Stream/SSR) | micromark (GFM) | Streamdown (Default) | Streamdown (Raw HTML) |
| --- | --- | --- | --- | --- |
| **Normalized Semantics** | **675 / 675** (0 divergences) | 669 / 675 | 540 / 675 | 586 / 675 |
| **Strict Semantics** (titles + language) | **675 / 675** (0 divergences) | 669 / 675 | 540 / 675 | 586 / 675 |

### Key takeaways on conformance
- **HTML Sanitization Fairness**: Enabling raw HTML on Streamdown raises its score from 540 to 586 (+46 examples), closing the gap on HTML blocks and raw HTML inlines.
- **Strict Parity**: StreamMDX achieves 100% strict conformance (675/675) across static, streaming, and SSR paths with zero divergences. Unlabeled code blocks and indented code blocks emit bare `<pre><code>` without `language-*` classes, preserving 100% parity on link titles (90/90), image titles (22/22), and code blocks.
- **micromark 669**: The 6 micromark failures are standard GFM tagfilter escaping on 5 HTML blocks (`cm_170`, `cm_171`, `cm_172`, `cm_176`, `cm_178`) and a dropped FTP autolink in modern micromark (`gfm_628`).
## Where Streamdown is the better fit

- You already use `react-markdown` and want the smallest possible change.
- You want streaming-aware formatting behavior without adding worker infrastructure.
- Your documents are modest in size and your throughput requirements are ordinary.

## Where StreamMDX is the better fit

- You care about main-thread isolation during frequent streaming updates.
- You need explicit control over incremental behavior, batching, and queueing.
- You want the same project to cover React rendering, worker composition, and TUI/protocol consumers.
- You are willing to pay a slightly more complex setup cost to get those controls.

## Benchmark reading guidance

When you look at StreamMDX vs Streamdown numbers on the benchmark page, keep the interpretation disciplined:

- Compare engines under the same fixture and scenario.
- Separate **live incremental** results from **static render** results.
- Treat first visible render and final convergence as different metrics.
- Treat memory, bundle cost, and CSP/runtime shape as adjacent tradeoffs, not as interchangeable latency claims.

### Engine-v2 production comparison, 2026-10-08

The locked quiet-AC run attempted preserved runtime `4350a2a`, engine-v2 runtime
`342b378`, and Streamdown `2.7.0` on `naive-bayes` in S2, S3, and S6. Each set
requested one unreported warmup and three measured streams. All six engine-v2
and Streamdown sets completed, producing 18 measured streams. All three
preserved-runtime warmups failed the final-DOM/highlighting completion guard;
there are no baseline measurements.

The strict comparison rejected the completed pair: canonical semantic records
differ in display/inline math placement, paragraph boundaries, footnote
navigation and ARIA, and the native footer separator. These are retained
behavior differences, not normalization targets. No valid speedup, slowdown,
or before/after performance claim follows from this run.

The primary metric is main-thread CDP `TaskDuration`, not total process CPU.
Raw samples, median/spread, frame p95, peak JS heap, first committed content,
duration, live attached DOM, failed attempts, and semantic evidence are retained
in the isolated consumer worktree's
`.codex-optimization/runs/20261007-211411-engine-v2-comparison/` directory
(`results.md`, `summary.json`, and `final-quiet/`).

### Firehose matrix, 2026-10-09

Streamdown `2.7.0` vs StreamMDX on long, full-feature documents (headings, nested and task lists, tables, multi-language code, inline and display math, blockquotes, inline HTML, footnotes) streamed at 5k, 10k, and 20k characters per second. Minified production docs build, Chrome 153 headless, Apple M5 Pro. Each row is one warmup plus three measured streams; the metric is median main-thread CDP `TaskDuration`.

| Fixture | Rate | StreamMDX ms | Streamdown ms | Delta | Canonical semantics |
|---|---|---|---|---|---|
| `code-huge` (16.5 KB, one fence) | 20k | 258 | 208 | +24% | identical |
| `code-huge` | 5k | 777 | 604 | +29% | identical |
| `stress-mega` (253 KB) | 20k | 2954 | 4318 | -32% | identical |
| `stress-mega` | 10k | 5014 | 7926 | -37% | identical |
| `stress-mega` | 5k | 9281 | 14123 | -34% | identical |
| `stress-xl` (1 MB) | 20k | 30942 | 48511 | -36% | identical |

- On long documents StreamMDX does 32-37% less main-thread work, with lower peak heap and rAF p95 at 16.8 ms. Streamdown's main-thread script time is 2.5-3.5x higher.
- On a single small code block Streamdown is cheaper, and it commits first content at about 24 ms vs 68-85 ms.
- StreamMDX ends each long stream with one finalize long task: about 190 ms at 253 KB and about 530 ms at 1 MB. Streamdown has none on `stress-mega`.
- `stress-mega-footnotes` is excluded from the table. Visible text matches, but footnote link attributes and the footer separator differ. On that fixture Streamdown's per-update cost grows with the document (71 s of main-thread work for a 13 s stream at 20k cps; StreamMDX: 3.1 s).
- The `stress-xl` 10k and 5k rows ran on battery and are omitted.

Raw runs, spreads, guardrails, and the per-change before/after evidence are in the engine-v2 worktree's `.codex-optimization/runs/20261008-171503-firehose-vs-streamdown/` directory (`contract.md`, `results.md`, `final/`). That directory is not committed.
## Related references

- [`PERF_HARNESS.md`](./PERF_HARNESS.md)
- [`PERFORMANCE_GUIDE.md`](./PERFORMANCE_GUIDE.md)
- [`STREAMING_CORRECTNESS_CONTRACT.md`](./STREAMING_CORRECTNESS_CONTRACT.md)
- Public benchmark route: <https://stream-mdx.vercel.app/benchmarks>
