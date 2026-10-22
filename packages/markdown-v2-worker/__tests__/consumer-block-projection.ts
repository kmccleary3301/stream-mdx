import type { Block } from "@stream-mdx/core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { createRendererStore } from "@stream-mdx/react/renderer/store";

export type ConsumerBlockProjection = {
  id: string;
  type: string;
  isFinalized: boolean;
  raw: string | null;
  range: { from: number; to: number } | null;
  markup: string;
};

export function projectConsumerBlocks(blocks: ReadonlyArray<Block>): ConsumerBlockProjection[] {
  return blocks.map((block) => {
    const coldExport = [block];
    const store = createRendererStore(coldExport);
    return {
      id: block.id,
      type: block.type,
      isFinalized: block.isFinalized,
      raw: block.payload.raw ?? null,
      range: block.payload.range ? { from: block.payload.range.from, to: block.payload.range.to } : null,
      markup: renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: coldExport, store })),
    };
  });
}
