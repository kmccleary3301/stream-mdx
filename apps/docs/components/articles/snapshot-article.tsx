"use client";

import type { Block } from "@stream-mdx/core";
import { MarkdownBlocksRenderer } from "@stream-mdx/react";
import { createMermaidEngine } from "@stream-mdx/mermaid";

const mermaidEngine = createMermaidEngine();

export function SnapshotArticle({ blocks }: { blocks: Block[] }) {
  return (
    <div
      id="article-content-wrapper"
      className="prose flex w-full max-w-3xl flex-col space-y-3 text-theme-primary"
    >
      <MarkdownBlocksRenderer
        blocks={blocks}
        engines={{ mermaid: mermaidEngine }}
        className="markdown-v2-output"
      />
    </div>
  );
}
