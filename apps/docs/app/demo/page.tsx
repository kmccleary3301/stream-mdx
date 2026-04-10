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
      <div className="route-panel-hero flex flex-col gap-4 px-6 py-8 md:px-8">
        <div className="route-kicker">Live demo</div>
        <div className="max-w-3xl">
          <h1 className="text-3xl font-semibold text-foreground md:text-4xl">Streaming Markdown Demo</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">
            Stream the Naive Bayes article into the renderer to inspect incremental layout behavior, scheduler sensitivity, and patch
            convergence on the exact surface used by the docs and benchmark pages.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="route-chip">Interactive controls</span>
          <span className="route-chip">Scheduler-aware rendering</span>
          <span className="route-chip">Automation hooks for regression</span>
        </div>
      </div>
      <div className="route-panel grid gap-4 px-5 py-4 md:grid-cols-[1.15fr_0.85fr] md:px-6">
        <div>
          <div className="text-sm font-semibold text-foreground">What to look for</div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Focus on visible-first latency, list/table/code stability during streaming, and whether the final DOM settles without post-finalize
            structural drift.
          </p>
        </div>
        <div className="text-sm leading-relaxed text-muted-foreground">
          The same demo surface feeds the reliability harness. If this page looks wrong under real streaming conditions, that is a product
          defect rather than a cosmetic edge case.
        </div>
      </div>
      <div className="route-panel overflow-hidden px-2 py-2 md:px-3 md:py-3">
        <StreamingMarkdownDemoV2 fullText={testString} />
      </div>
    </div>
  );
}
