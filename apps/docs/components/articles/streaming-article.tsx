"use client";

import type { BlockComponents, StreamingMarkdownHandle } from "@stream-mdx/react";
import { MermaidBlock } from "@stream-mdx/mermaid";
import { StreamingMarkdown } from "@stream-mdx/react";
import { PATCH_ROOT_ID } from "@stream-mdx/core";
import { useEffect, useMemo, useRef } from "react";

import { DocsCodeBlock } from "@/components/markdown/docs-code-block";
import { useTocContext } from "@/components/on-this-page/toc-context";
import type { TocHeading } from "@/lib/toc";

export function StreamingArticle({ content }: { content: string }) {
  const tocContext = useTocContext();
  const handleRef = useRef<StreamingMarkdownHandle | null>(null);
  const components = useMemo<Partial<BlockComponents>>(
    () => ({
      code: DocsCodeBlock,
      mermaid: MermaidBlock,
    }),
    [],
  );

  useEffect(() => {
    if (!tocContext) return;
    const handle = handleRef.current;
    if (!handle) return;

    const updateHeadings = () => {
      const root = handle.getState().store.getNode(PATCH_ROOT_ID);
      const headings = (root?.props?.tocHeadings as TocHeading[] | undefined) ?? [];
      tocContext.setHeadings(headings);
    };

    updateHeadings();
    const unsubscribe = handle.onFlush(() => {
      updateHeadings();
    });

    return () => {
      unsubscribe?.();
      tocContext.setHeadings([]);
    };
  }, [content, tocContext]);

  return (
    <div
      id="article-content-wrapper"
      className="prose markdown flex w-full max-w-3xl flex-col space-y-3 text-theme-primary"
    >
      <StreamingMarkdown
        text={content}
        className="markdown-v2-output"
        components={components}
        worker="/workers/markdown-worker.js"
        ref={handleRef}
        mdxCompileMode="worker"
        features={{
          html: true,
          tables: true,
          math: true,
          mdx: true,
          footnotes: true,
          callouts: true,
          codeHighlighting: "final",
        }}
      />
    </div>
  );
}
