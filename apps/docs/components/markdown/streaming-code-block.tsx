"use client";

import type { Block } from "@stream-mdx/core";
import type { NodeViewMetadata } from "@stream-mdx/react";

import { cn } from "@/lib/utils";
import { DocsCodeBlock } from "@/components/markdown/docs-code-block";

export function StreamingCodeBlock({
  code,
  language = "text",
  className,
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  const block: Block = {
    id: "streaming-code-block",
    type: "code",
    isFinalized: true,
    payload: { raw: code, meta: { code, lang: language } },
  };
  const metadata: NodeViewMetadata = {
    id: block.id,
    type: "code",
    isFinalized: true,
    language,
  };
  const content = (
    <pre className="markdown-code-block">
      <code>{code}</code>
    </pre>
  );

  return (
    <div className={cn("prose-stream max-w-none text-sm text-foreground", className)}>
      <div className="markdown-v2-output">
        <DocsCodeBlock children={content} metadata={metadata} block={block} />
      </div>
    </div>
  );
}
