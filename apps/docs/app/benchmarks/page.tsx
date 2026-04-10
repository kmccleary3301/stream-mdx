import { Link } from "next-view-transitions";

import { LiveRendererComparison } from "@/components/benchmarks/live-renderer-comparison";
import { StaticRenderComparison } from "@/components/benchmarks/static-render-comparison";
import {
  BENCHMARK_RUNTIME_COST_TERMS,
  BENCHMARK_SCHEDULER_MODES,
  BENCHMARK_STATIC_CONTENT_CLASSES,
} from "@/lib/benchmark-methodology";

export const dynamic = "force-static";

const methodologyBadges = [
  "Fixture driven",
  "Seeded scenarios",
  "Live incremental",
  "Static content classes",
  "Browser-local measurements",
];

const metricDefinitions = [
  {
    name: "First visible render",
    meaning: "Time from emitted delta to the first observable DOM mutation for an engine.",
    whyItMatters: "This is the most user-visible latency metric during streaming.",
  },
  {
    name: "Final convergence",
    meaning: "Time from emitted delta to the final stable DOM state for that update window.",
    whyItMatters: "This captures whether the renderer settles quickly or churns after visible output appears.",
  },
  {
    name: "Patch-to-DOM latency",
    meaning: "Measured time across the ingest, scheduling, and commit path before content becomes visible.",
    whyItMatters: "It exposes scheduler pressure and batching behavior under real incremental streams.",
  },
  {
    name: "Static render timing",
    meaning: "One-shot render timing for prose, tables, code, and mixed markdown fixtures.",
    whyItMatters: "It shows how engines behave outside the delta-stream case and catches content-class cliffs.",
  },
];

const interpretationNotes = [
  "Results are local and hardware-dependent. Compare engines under the same browser, fixture, and scheduler settings.",
  "Live incremental numbers answer a different question than static rendering. Both matter and should be read separately.",
  "Memory, bundle size, and worker-hosting tradeoffs belong alongside latency numbers; they are not interchangeable metrics.",
];

export default function BenchmarksPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-10">
      <header className="route-panel-hero flex flex-col gap-4 px-6 py-8 md:px-8">
        <div className="route-kicker">Benchmarks</div>
        <div className="max-w-3xl">
          <h1 className="text-3xl font-semibold text-foreground">Reproducible streaming and static markdown comparisons</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            This page distinguishes live incremental behavior from one-shot static rendering. The goal is not to publish a single vanity
            number, but to let you inspect how different renderers behave under the same fixtures, chunk cadence, and browser session.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {methodologyBadges.map((badge) => (
            <span key={badge} className="route-chip">
              {badge}
            </span>
          ))}
          <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href="/docs/perf-harness">
            Perf harness methodology
          </Link>
          <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href="/docs/streamdown-comparison">
            Streamdown comparison notes
          </Link>
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="route-panel p-6">
          <div className="text-sm font-semibold text-foreground">How to read this page</div>
          <ul className="mt-3 space-y-2 text-sm text-muted">
            {interpretationNotes.map((note) => (
              <li key={note} className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="route-panel p-6">
          <div className="text-sm font-semibold text-foreground">Reproduce locally</div>
          <div className="mt-3 space-y-3 text-xs">
            <div className="route-panel-soft p-3 font-mono">
              npm run docs:dev
            </div>
            <div className="route-panel-soft p-3 font-mono">
              npm run perf:harness -- --fixture naive-bayes --scenario S2_typical --runs 3 --warmup 1
            </div>
            <div className="route-panel-soft p-3 font-mono">
              npm run perf:compare -- --base tmp/perf-runs/&lt;base&gt;/summary.json --candidate tmp/perf-runs/&lt;candidate&gt;/summary.json
            </div>
          </div>
        </div>
      </section>

      <section className="route-panel p-6">
        <div className="text-sm font-semibold text-foreground">Metric definitions</div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {metricDefinitions.map((metric) => (
            <div key={metric.name} className="route-panel-soft p-4">
              <div className="text-sm font-semibold text-foreground">{metric.name}</div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{metric.meaning}</p>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">
                <span className="font-medium text-foreground/80">Why it matters:</span> {metric.whyItMatters}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="route-panel p-6">
          <div className="text-sm font-semibold text-foreground">Static content classes</div>
          <div className="mt-4 grid gap-3">
            {BENCHMARK_STATIC_CONTENT_CLASSES.map((contentClass) => (
              <div key={contentClass.id} className="route-panel-soft p-4">
                <div className="text-sm font-semibold text-foreground">{contentClass.label}</div>
                <p className="mt-2 text-[13px] leading-relaxed text-muted">{contentClass.summary}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="route-panel p-6">
          <div className="text-sm font-semibold text-foreground">Memory and bundle terminology</div>
          <div className="mt-4 grid gap-3">
            {BENCHMARK_RUNTIME_COST_TERMS.map((term) => (
              <div key={term.name} className="route-panel-soft p-4">
                <div className="text-sm font-semibold text-foreground">{term.name}</div>
                <p className="mt-2 text-[13px] leading-relaxed text-muted">{term.definition}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="route-panel p-6">
        <div className="text-sm font-semibold text-foreground">Scheduler / jitter modes</div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {BENCHMARK_SCHEDULER_MODES.map((mode) => (
            <div key={mode.id} className="route-panel-soft p-4">
              <div className="text-sm font-semibold text-foreground">{mode.label}</div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{mode.summary}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-muted">
          The live comparison lab exposes these modes directly. Use <span className="font-medium text-foreground/80">CI locked</span> for
          reproducible comparisons and <span className="font-medium text-foreground/80">Explore</span> to characterize scheduler sensitivity
          without turning the result into a public claim.
        </p>
      </section>

      <section className="route-panel p-6">
        <div className="text-sm font-semibold text-foreground">Parity workloads vs capability workloads</div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
          The benchmark surface now includes both <span className="font-medium text-foreground/80">parity workloads</span> and one
          <span className="font-medium text-foreground/80"> rich feature stress workload</span>. The parity workloads are the fair
          StreamMDX/Streamdown/react-markdown comparison set. The rich stress case exists to show how StreamMDX behaves when math, MDX, HTML,
          tables, code, and footnotes are all active in the same document. Unsupported cells are marked explicitly instead of being counted as
          comparable runs.
        </p>
      </section>

      <LiveRendererComparison />

      <StaticRenderComparison />
    </div>
  );
}
