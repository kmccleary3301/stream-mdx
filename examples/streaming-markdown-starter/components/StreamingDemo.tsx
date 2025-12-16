"use client";

import { StreamingMarkdown, type RendererMetrics, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { createDefaultWorker } from "@stream-mdx/worker";
import { useMemo, useRef, useState } from "react";

const ARTICLE = `# Streaming Markdown

This starter demonstrates the ref-driven \`<StreamingMarkdown>\` component. Update the textarea or paste longer content to watch the renderer stream patches in real time.

## Features

- Worker-based parsing + diffing
- MDX compilation (server or worker)
- Math/list/table plugins enabled by default
- Instrumentation surfaced via \`onMetrics\`

Happy streaming!`;

const USE_WORKER_HELPER = process.env.NEXT_PUBLIC_STREAMING_WORKER_HELPER === "true";

export default function StreamingDemo() {
  const streamingRef = useRef<StreamingMarkdownHandle>(null);
  const [text, setText] = useState(ARTICLE);
  const [mdxMode, setMdxMode] = useState<"server" | "worker">("server");
  const stats = streamingRef.current?.getState();
  const [lastMetrics, setLastMetrics] = useState<RendererMetrics | null>(null);
  const workerFactory = useMemo<(() => Worker) | undefined>(() => {
    if (!USE_WORKER_HELPER) {
      return undefined;
    }
    return () => {
      const worker = createDefaultWorker({ url: "/workers/markdown-worker.js" });
      if (!worker) {
        throw new Error("Streaming Markdown worker unavailable in this environment");
      }
      return worker;
    };
  }, []);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 font-medium text-gray-700 text-sm">
          MDX mode
          <select
            value={mdxMode}
            onChange={(event) => setMdxMode(event.target.value as "server" | "worker")}
            className="rounded border border-gray-300 bg-white px-2 py-1 text-sm"
          >
            <option value="server">Server (API)</option>
            <option value="worker">Worker (client)</option>
          </select>
        </label>
        <button
          className="rounded border border-gray-300 px-3 py-1 font-medium text-gray-700 text-sm hover:bg-gray-50"
          type="button"
          onClick={() => streamingRef.current?.restart()}
        >
          Restart stream
        </button>
      </div>

      <textarea className="h-48 w-full rounded border border-gray-300 p-3 font-mono text-sm" value={text} onChange={(event) => setText(event.target.value)} />

      <div className="rounded border border-gray-200 bg-white p-4 shadow-sm">
        <StreamingMarkdown
          ref={streamingRef}
          text={text}
          worker={workerFactory}
          features={{ math: true, mdx: true, tables: true, html: true }}
          mdxCompileMode={mdxMode}
          prewarmLangs={["tsx", "python"]}
          onMetrics={(metric) => {
            setLastMetrics(metric);
            console.debug("[streaming metrics]", {
              tx: metric.tx,
              queueDelay: metric.queueDelay,
              adaptiveBudget: metric.adaptiveBudget,
            });
          }}
        />
      </div>

      <pre className="rounded border border-gray-200 bg-gray-50 p-3 text-gray-600 text-xs">
        {JSON.stringify(
          {
            queueDepth: stats?.queueDepth ?? 0,
            pendingBatches: stats?.pendingBatches ?? 0,
            rendererVersion: stats?.rendererVersion ?? 0,
            adaptiveBudget: lastMetrics?.adaptiveBudget ?? null,
            queueDelay: lastMetrics?.queueDelay ?? null,
          },
          null,
          2,
        )}
      </pre>
    </section>
  );
}
