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
    <div className="container mx-auto max-w-4xl py-8">
      <h1 className="mb-2 text-2xl font-bold">Streaming Markdown Demo</h1>
      <p className="mb-6 text-muted">Stream the Naive Bayes article into the renderer to evaluate incremental performance.</p>
      <StreamingMarkdownDemoV2 fullText={testString} />
    </div>
  );
}
