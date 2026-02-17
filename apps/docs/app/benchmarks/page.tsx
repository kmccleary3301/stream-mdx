import { Link } from "next-view-transitions";

import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-static";

const comparisonRows = [
  {
    name: "StreamMDX",
    version: "v1.2.4",
    firstRender: 12,
    peakMemory: "4.2MB",
    jank: "0",
  },
  {
    name: "react-markdown",
    version: "v9.0.1",
    firstRender: 48,
    peakMemory: "12.8MB",
    jank: "3 (avg 18ms)",
  },
];

const renderBars = [
  { label: "StreamMDX", value: 12 },
  { label: "Alternative A", value: 48 },
];

const p50Series = [10, 11, 9, 12, 10, 11, 10, 9, 10, 11, 10, 9];
const p95Series = [22, 24, 21, 26, 24, 25, 23, 22, 24, 26, 25, 23];

function buildLinePath(values: number[], width: number, height: number) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(1, max - min);
  return values
    .map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export default function BenchmarksPage() {
  const barMax = Math.max(...renderBars.map((item) => item.value));
  const chartWidth = 360;
  const chartHeight = 120;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-10">
      <header className="flex flex-col gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Benchmarks</div>
        <h1 className="text-3xl font-semibold text-foreground">Streaming performance benchmarks</h1>
        <p className="max-w-2xl text-sm text-muted">
          StreamMDX benchmarks are designed to be reproducible. Every comparison starts with local baselines, shared fixtures, and the same
          harness settings.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {[
            "Fixture: naive-bayes.md",
            "Scenario: S2_typical (50ms)",
            "Mode: incremental",
            "Renderer: V2",
          ].map((item) => (
            <span key={item} className="rounded-full border border-border/40 bg-muted/20 px-3 py-1">
              {item}
            </span>
          ))}
          <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href="/docs/perf-harness">
            Methodology documentation
          </Link>
        </div>
      </header>

      <section className="rounded-lg border border-border/40 bg-background p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Comparison summary</h2>
            <p className="mt-1 text-sm text-muted">Results are local and machine-dependent. Lower is better.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {["First", "Incremental", "Live"].map((item, index) => (
              <span
                key={item}
                className={cn(
                  "rounded-full border px-3 py-1",
                  index === 0 ? "border-foreground/20 bg-foreground/5 text-foreground" : "border-border/40 bg-background text-muted",
                )}
              >
                {item}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-4">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Renderer</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>First render</TableHead>
                <TableHead>Peak memory</TableHead>
                <TableHead>Jank (long tasks)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {comparisonRows.map((row) => (
                <TableRow key={row.name}>
                  <TableCell className="font-semibold text-foreground">{row.name}</TableCell>
                  <TableCell className="text-muted">{row.version}</TableCell>
                  <TableCell>{row.firstRender} ms</TableCell>
                  <TableCell>{row.peakMemory}</TableCell>
                  <TableCell>{row.jank}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border/40 bg-background p-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Time to first visible render</h3>
              <p className="mt-1 text-xs text-muted">Latency from first chunk to initial DOM paint. Lower is better.</p>
            </div>
            <span className="text-xs text-muted">ms</span>
          </div>
          <div className="mt-4 space-y-3">
            {renderBars.map((bar) => (
              <div key={bar.label} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>{bar.label}</span>
                  <span>{bar.value} ms</span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted/40">
                  <div
                    className="h-2 rounded-full bg-foreground/70"
                    style={{ width: `${Math.max(6, (bar.value / barMax) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border/40 bg-background p-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Patch to DOM latency (p50 / p95)</h3>
              <p className="mt-1 text-xs text-muted">Batch processing time across the stream.</p>
            </div>
            <span className="text-xs text-muted">ms</span>
          </div>
          <div className="mt-4">
            <svg width="100%" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="text-muted">
              <path d={buildLinePath(p50Series, chartWidth, chartHeight)} stroke="#64748b" strokeWidth="2" fill="none" />
              <path d={buildLinePath(p95Series, chartWidth, chartHeight)} stroke="#0f172a" strokeWidth="2" fill="none" />
            </svg>
            <div className="mt-3 flex items-center gap-4 text-xs text-muted">
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-slate-500" /> p50 latency
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-foreground" /> p95 latency
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div className="rounded-lg border border-border/40 bg-background p-6">
          <h3 className="text-sm font-semibold text-foreground">Reproduce</h3>
          <p className="mt-1 text-xs text-muted">Run the harness locally with the same fixture and scenario.</p>
          <div className="mt-4 space-y-3 text-xs">
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 font-mono text-[11px]">
              NEXT_PUBLIC_STREAMING_DEMO_API=true npm run docs:dev
            </div>
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 font-mono text-[11px]">
              npm run perf:harness -- --fixture naive-bayes --scenario S2_typical --runs 3 --warmup 1 --out tmp/perf-baselines
            </div>
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 font-mono text-[11px]">
              npm run perf:compare -- --base tmp/perf-baselines/&lt;base&gt; --candidate tmp/perf-baselines/&lt;candidate&gt;
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border/40 bg-background p-6">
          <h3 className="text-sm font-semibold text-foreground">Notes on interpretation</h3>
          <ul className="mt-3 space-y-2 text-xs text-muted">
            <li>First flush is the most user-visible metric. Aim for under 50ms.</li>
            <li>Long tasks should stay under 50ms to avoid frame drops.</li>
            <li>Memory peaks matter for multi-stream dashboards.</li>
          </ul>
          <div className="mt-4 text-xs text-muted">
            <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href="/docs/perf-quality-changelog">
              Perf quality changelog
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
