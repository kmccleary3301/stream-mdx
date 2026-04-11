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
| Execution model | Main-thread React rendering | Worker-first parse pipeline with incremental patch application |
| Rendering surface | React component, close to `react-markdown` ergonomics | Dedicated `StreamingMarkdown` renderer plus lower-level packages |
| Incremental model | Incomplete-markdown resilience + memoized rerendering | Explicit semantic/enrichment patch batches committed to a stable render tree |
| Long-document posture | Main-thread work scales with content updates | Worker offload, queueing, and patch scheduling intended to reduce main-thread pressure |
| Packaging | Single package | Modular packages plus `stream-mdx` convenience wrapper |

## Integration tradeoffs

| Topic | Streamdown | StreamMDX |
| --- | --- | --- |
| Install / adopt | Lower friction for existing `react-markdown` users | Higher setup cost because worker/runtime configuration matters |
| CSP / hosting | No worker hosting requirement | Hosted worker strongly recommended for production CSP clarity |
| Custom syntax | remark/rehype ecosystem, plus Streamdown behavior | Worker/plugin model, custom matcher paths, and more explicit runtime composition |
| Terminal / protocol use | React-first surface | Dedicated TUI / protocol path exists |
| Operational visibility | Mostly renderer-level behavior | More moving parts, but more instrumentation and runtime controls |

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

## Related references

- [`PERF_HARNESS.md`](./PERF_HARNESS.md)
- [`PERFORMANCE_GUIDE.md`](./PERFORMANCE_GUIDE.md)
- [`STREAMING_CORRECTNESS_CONTRACT.md`](./STREAMING_CORRECTNESS_CONTRACT.md)
- Public benchmark route: <https://stream-mdx.vercel.app/benchmarks>
