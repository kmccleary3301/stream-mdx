"use client";

import type { Block } from "@stream-mdx/core";
import { ComponentRegistry, MarkdownBlocksRenderer, type BlockComponents } from "@stream-mdx/react";
import { MermaidBlock } from "@stream-mdx/mermaid";
import { useMemo } from "react";

import { DocsCodeBlock } from "@/components/markdown/docs-code-block";

type CodeProps = Parameters<BlockComponents["code"]>[0];

function normalizeLanguage(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().toLowerCase();
  }
  return "text";
}

function getCodeText(props: CodeProps): string {
  if (props.meta && typeof props.meta.code === "string" && props.meta.code.length > 0) {
    return props.meta.code;
  }
  if (Array.isArray(props.lines) && props.lines.length > 0) {
    return props.lines.map((line) => line.text).join("\n");
  }
  return "";
}

function SnapshotCodeBlock(props: CodeProps) {
  const language = normalizeLanguage(props.lang ?? props.meta?.lang);
  if (language === "mermaid") {
    const code = getCodeText(props);
    return <MermaidBlock code={code} renderCode={<DocsCodeBlock {...props} />} />;
  }
  return <DocsCodeBlock {...props} />;
}

export function SnapshotArticle({ blocks }: { blocks: Block[] }) {
  const registry = useMemo(() => {
    const next = new ComponentRegistry();
    next.setBlockComponents({
      code: SnapshotCodeBlock,
      mermaid: MermaidBlock,
    } as Partial<BlockComponents>);
    return next;
  }, []);

  return (
    <div
      id="article-content-wrapper"
      className="prose markdown flex w-full max-w-3xl flex-col space-y-3 text-theme-primary"
    >
      <MarkdownBlocksRenderer blocks={blocks} componentRegistry={registry} className="markdown-v2-output" />
    </div>
  );
}
