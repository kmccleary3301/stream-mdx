import { Link } from "next-view-transitions";

import { LiveRendererComparison } from "@/components/benchmarks/live-renderer-comparison";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-static";

const comparisonRows = [
  { renderer: "StreamMDX", updateModel: "Incremental patch apply", goodFor: "Streaming UIs + deterministic replay" },
  { renderer: "Streamdown", updateModel: "React re-render on content updates", goodFor: "Drop-in migration from react-markdown" },
  { renderer: "react-markdown", updateModel: "React re-render on content updates", goodFor: "Simple static markdown content" },
];

export default function BenchmarksPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-10">
      <header className="flex flex-col gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Benchmarks</div>
        <h1 className="text-3xl font-semibold text-foreground">Streaming performance benchmarks</h1>
        <p className="max-w-2xl text-sm text-muted">
          Use reproducible harnesses, then validate in-browser behavior with live delta-by-delta comparisons against alternative renderers.
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

      <LiveRendererComparison />

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
          <h3 className="text-sm font-semibold text-foreground">Renderer model comparison</h3>
          <div className="mt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Renderer</TableHead>
                  <TableHead>Update model</TableHead>
                  <TableHead>Best fit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {comparisonRows.map((row) => (
                  <TableRow key={row.renderer}>
                    <TableCell className="font-semibold text-foreground">{row.renderer}</TableCell>
                    <TableCell className="text-muted">{row.updateModel}</TableCell>
                    <TableCell className="text-muted">{row.goodFor}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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
