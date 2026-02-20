import fs from "node:fs";
import path from "node:path";

import type { Metadata } from "next";
import { Link } from "next-view-transitions";
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
    <div className="mx-auto flex w-full max-w-screen-xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Demo</div>
        <h1 className="text-3xl font-semibold text-foreground">Streaming Markdown Demo</h1>
        <p className="max-w-2xl text-sm text-muted">
          Stream the Naive Bayes article into the renderer to evaluate incremental performance and layout stability as content arrives.
        </p>
        <p className="text-xs text-muted">
          Need to validate sticky bottom scrolling separately?{" "}
          <Link href="/demo/sticky-scroll" className="underline decoration-border underline-offset-2">
            Open sticky-scroll test
          </Link>
          .
        </p>
      </div>
      <StreamingMarkdownDemoV2 fullText={testString} />
    </div>
  );
}
