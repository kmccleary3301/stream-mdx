"use client";

import type { NodeViewProps } from "@stream-mdx/react";
import { MermaidBlock } from "@stream-mdx/mermaid";

import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
type DocsCodeBlockProps = Pick<NodeViewProps, "children" | "metadata" | "block">;

function normalizeLanguage(language: unknown): string {
  if (typeof language === "string" && language.trim().length > 0) return language.trim();
  return "text";
}

function resolveCodeText(block: NodeViewProps["block"]): string | null {
  const code = block?.payload.meta?.code;
  if (typeof code === "string" && code.trim().length > 0) return code;
  const raw = block?.payload.raw;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trimStart();
  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd < 0 || !/^(`{3,}|~{3,})/.test(trimmed)) return raw;
  const lines = trimmed.split("\n");
  if (lines[lines.length - 1]?.trim().startsWith("```")) return lines.slice(1, -1).join("\n");
  if (lines[lines.length - 1]?.trim().startsWith("~~~")) return lines.slice(1, -1).join("\n");
  return lines.slice(1).join("\n");
}

export function DocsCodeBlock({ children, metadata, block }: DocsCodeBlockProps) {
  const language = normalizeLanguage(metadata.language);
  const copyText = resolveCodeText(block);
  const languageLabel = language === "text" ? "plain text" : language;

  return (
    <div className={cn("docs-code-block markdown-code-block", `language-${language}`)}>
      <div className="docs-code-block__header">
        <span className="docs-code-block__lang">{languageLabel}</span>
        {copyText ? <CopyButton className="docs-code-block__copy" iconOnly text={copyText} /> : null}
      </div>
      <div className="docs-code-block__body">{children}</div>
    </div>
  );
}

export function MermaidCodePresentation({ children, metadata, actions, block }: NodeViewProps) {
  if (metadata.language?.toLowerCase() !== "mermaid") return children;
  const code = block?.payload.meta?.code;
  return (
    <MermaidBlock
      code={typeof code === "string" ? code : ""}
      renderCode={children}
      language={metadata.language ?? "mermaid"}
      blockId={metadata.id}
      controls={{ copy: true }}
      copy={actions.copy}
    />
  );
}
