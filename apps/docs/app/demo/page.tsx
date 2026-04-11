import fs from "node:fs";
import path from "node:path";

import type { Metadata } from "next";
import { StreamingMarkdownDemoV2 } from "@/components/screens/streaming-markdown-demo-v2";

export const metadata: Metadata = {
  title: "Streaming Markdown Demo",
  description: "Stream the Naive Bayes article into the renderer to evaluate incremental performance.",
};

function readNaiveBayesDoc(): string {
  const filePath = path.join(process.cwd(), "app", "demo", "naive-bayes-classifier.mdx");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (raw.startsWith("---")) {
      const end = raw.indexOf("\n---", 3);
      if (end !== -1) return raw.slice(end + 4);
    }
    return raw;
  } catch {
    return "# Missing test document\nCould not read naive-bayes-classifier.mdx";
  }
}

export default function DemoPage() {
  const testString = readNaiveBayesDoc();

  return (
    <div className="mx-auto flex w-full max-w-screen-xl flex-col gap-8 px-4 py-8">
      <div className="route-panel-hero flex flex-col gap-6 px-6 py-8 md:px-8">
        <div className="route-shell-grid">
          <div className="max-w-3xl">
            <div className="route-kicker">Live demo</div>
            <h1 className="mt-3 text-3xl font-semibold text-foreground md:text-5xl">Streaming Markdown Demo</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">
              Stream the Naive Bayes article into the renderer to inspect incremental layout behavior, scheduler sensitivity, and patch
              convergence on the exact surface used by the docs and benchmark pages.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="route-chip">Interactive controls</span>
              <span className="route-chip">Scheduler-aware rendering</span>
              <span className="route-chip">Automation hooks for regression</span>
            </div>
          </div>
          <div className="grid gap-3">
            <div className="route-panel p-4">
              <div className="route-stat-label">What to look for</div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Focus on visible-first latency, list/table/code stability during streaming, and whether the final DOM settles without
                post-finalize structural drift.
              </p>
            </div>
            <div className="route-panel-soft p-4 text-sm leading-relaxed text-muted-foreground">
              The same demo surface feeds the reliability harness. If this page looks wrong under real streaming conditions, that is a product
              defect rather than a cosmetic edge case.
            </div>
          </div>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="route-stat-tile px-4 py-4">
          <div className="route-stat-label">Streaming lab</div>
          <div className="mt-2 text-sm font-semibold text-foreground">Same surface used by the reliability harness</div>
        </div>
        <div className="route-stat-tile px-4 py-4">
          <div className="route-stat-label">Use it for</div>
          <div className="mt-2 text-sm font-semibold text-foreground">Visual-first latency and convergence checks</div>
        </div>
        <div className="route-stat-tile px-4 py-4">
          <div className="route-stat-label">Operator focus</div>
          <div className="mt-2 text-sm font-semibold text-foreground">Control rail, metrics strip, and final DOM stability</div>
        </div>
      </div>
      <div className="route-panel overflow-hidden px-2 py-2 md:px-3 md:py-3">
        <StreamingMarkdownDemoV2 fullText={testString} />
      </div>
    </div>
  );
}
