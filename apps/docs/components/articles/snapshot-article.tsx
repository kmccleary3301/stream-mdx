"use client";

import type { Block } from "@stream-mdx/core";
import { ComponentRegistry, MarkdownBlocksRenderer } from "@stream-mdx/react";
import { MermaidBlock } from "@stream-mdx/mermaid";
import { useMemo } from "react";

import { DocsCodeBlock } from "@/components/markdown/docs-code-block";

export function SnapshotArticle({ blocks }: { blocks: Block[] }) {
  const registry = useMemo(() => {
    const next = new ComponentRegistry();
    next.setBlockComponents({
      code: DocsCodeBlock,
    });
    next.setCodeRenderers({
      mermaid: MermaidBlock,
    });
    return next;
  }, []);

  return (
    <div
      id="article-content-wrapper"
      className="prose flex w-full max-w-3xl flex-col space-y-3 text-theme-primary"
    >
      <MarkdownBlocksRenderer blocks={blocks} componentRegistry={registry} className="markdown-v2-output" />
    </div>
  );
}
