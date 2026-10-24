"use client";

import type { Block } from "@stream-mdx/core";
import { MarkdownBlocksRenderer } from "@stream-mdx/react";

import { MermaidCodePresentation } from "@/components/markdown/docs-code-block";

export function SnapshotArticle({ blocks }: { blocks: Block[] }) {
  return (
    <div
      id="article-content-wrapper"
      className="prose flex w-full max-w-3xl flex-col space-y-3 text-theme-primary"
    >
      <MarkdownBlocksRenderer
        blocks={blocks}
        components={{ code: { wrapper: MermaidCodePresentation } }}
        className="markdown-v2-output"
      />
    </div>
  );
}
