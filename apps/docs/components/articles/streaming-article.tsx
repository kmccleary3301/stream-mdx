"use client";

import { createTrustedMdxEngine } from "@stream-mdx/react/trusted-mdx";
import type { StreamingMarkdownHandle } from "@stream-mdx/react";
import { createMermaidEngine } from "@stream-mdx/mermaid";
import { StreamingMarkdown } from "@stream-mdx/react";
import { PATCH_ROOT_ID } from "@stream-mdx/core";
import { useEffect, useRef, type ElementType } from "react";

import { components as trustedMdxElements } from "@/mdx-components";

import { useTocContext } from "@/components/on-this-page/toc-context";
import type { TocHeading } from "@/lib/toc";


const articleMdxEngine = createTrustedMdxEngine({
  components: trustedMdxElements as Readonly<Record<string, ElementType>>,
});
const articleEngines = {
  mdx: articleMdxEngine,
  mermaid: createMermaidEngine(),
};
export function StreamingArticle({ content }: { content: string }) {
  const tocContext = useTocContext();
  const handleRef = useRef<StreamingMarkdownHandle | null>(null);

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
      className="prose flex w-full max-w-3xl flex-col space-y-3 text-theme-primary"
    >
      <StreamingMarkdown
        text={content}
        className="markdown-v2-output"
        worker="/workers/markdown-worker.js"
        ref={handleRef}
        contentPolicy="trusted-mdx"
        engines={articleEngines}
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
