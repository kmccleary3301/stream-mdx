"use client";

import { useEffect, useMemo } from "react";

import {
  createMarkdownRenderer,
  MarkdownBlocksRenderer,
  useRendererBlocks,
  type RendererConfig,
} from "@stream-mdx/react";
import { createDefaultWorker, releaseDefaultWorker } from "@stream-mdx/worker";
import { cn } from "@/lib/utils";
import { DocsCodeBlock } from "@/components/markdown/docs-code-block";

const DEFAULT_RENDERER_CONFIG: RendererConfig = {
  plugins: {
    html: true,
    tables: true,
    math: true,
    mdx: true,
    footnotes: true,
    callouts: true,
    codeHighlighting: "final",
  },
};

export function StreamingCodeBlock({
  code,
  language = "text",
  className,
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  const markdown = useMemo(() => `\n\n\`\`\`${language}\n${code}\n\`\`\`\n`, [code, language]);
  const renderer = useMemo(() => {
    const instance = createMarkdownRenderer(DEFAULT_RENDERER_CONFIG);
    instance.setBlockComponents({ code: DocsCodeBlock });
    return instance;
  }, []);
  const store = renderer.getStore();
  const blocks = useRendererBlocks(store);

  useEffect(() => {
    let cancelled = false;
    const fallbackWorker = () => new Worker("/workers/markdown-worker.js", { type: "module", name: "markdown-v2" });
    const worker = createDefaultWorker() ?? fallbackWorker();

    renderer.attachWorker(worker, { skipInit: true });

    renderer.renderStatic(markdown).catch((error) => {
      if (!cancelled) {
        console.error("[StreamingCodeBlock] Failed to render markdown", error);
      }
    });

    return () => {
      cancelled = true;
      renderer.detachWorker();
      try {
        worker.terminate();
      } catch {
        // ignore worker termination errors
      }
      releaseDefaultWorker(worker);
    };
  }, [renderer, markdown]);

  return (
    <div className={cn("prose max-w-none text-sm", className)}>
      <MarkdownBlocksRenderer
        blocks={blocks}
        componentRegistry={renderer.getComponentRegistry()}
        className="markdown-v2-output"
        store={store}
      />
    </div>
  );
}
