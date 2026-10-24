"use client";

import type { ComponentType, ReactNode } from "react";
import { cloneElement, isValidElement } from "react";

import type { InlineNodeViewProps, NodePresentations, NodeViewProps } from "@stream-mdx/react";

import { BlockMath, InlineMath } from "@/components/markdown/Math";
import { ScrollAreaHorizontal } from "@/components/ui/scroll-area";
import { TablePresentationWrapper } from "@/components/ui/table";
import { cn } from "@/lib/utils";

function HeadingPresentation({ children }: NodeViewProps): ReactNode {
  if (!isValidElement<{ className?: string }>(children) || typeof children.type !== "string") return children;
  const level = /^h[1-6]$/.test(children.type) ? children.type.slice(1) : undefined;
  return cloneElement(children, {
    className: cn(children.props.className, "markdown-heading", level && `markdown-h${level}`),
  });
}

function InlinePresentation({ node, children }: InlineNodeViewProps): ReactNode {
  if (node.kind === "math-inline") return <InlineMath math={node.tex} />;
  if (node.kind === "math-display") return <BlockMath math={node.tex} />;
  if (node.kind === "mention") {
    return (
      <a href={`https://x.com/${node.handle}`} className="text-[#A68AEB] underline-offset-4 hover:underline">
        @{node.handle}
      </a>
    );
  }
  return children;
}

function createDemoCodePresentation(showCodeMeta: boolean): ComponentType<NodeViewProps> {
  return function DemoCodePresentation({ children, metadata }: NodeViewProps) {
    const language = metadata.language ?? "";
    return (
      <div className="flex flex-col">
        {showCodeMeta && language ? (
          <div className="border-border/60 border-b bg-muted/40 px-3 py-1 font-mono text-muted-foreground text-xs">{language}</div>
        ) : null}
        <ScrollAreaHorizontal className="min-w-auto">
          <div className="min-w-max p-4">{children}</div>
        </ScrollAreaHorizontal>
      </div>
    );
  };
}

function DemoTablePresentation({ children }: NodeViewProps): ReactNode {
  return (
    <TablePresentationWrapper className="my-6 w-full rounded border border-border">
      <div className="min-w-max">{children}</div>
    </TablePresentationWrapper>
  );
}

function HtmlTablePresentation({ children }: NodeViewProps): ReactNode {
  return (
    <TablePresentationWrapper className="my-6 w-full overflow-hidden overflow-y-auto">
      {children}
    </TablePresentationWrapper>
  );
}

export function createDemoComponents(showCodeMeta = false): NodePresentations {
  const cellClass = "border border-border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right";
  return {
    paragraph: { props: { className: "markdown-paragraph" } },
    heading: { wrapper: HeadingPresentation },
    blockquote: { props: { className: "markdown-blockquote" } },
    code: { wrapper: createDemoCodePresentation(showCodeMeta) },
    table: { wrapper: DemoTablePresentation },
    "inline:math": { view: InlinePresentation },
    "inline:mention": { view: InlinePresentation },
    "html:table": { wrapper: HtmlTablePresentation, props: { className: "w-full text-sm" } },
    "html:thead": { props: { className: "[&_tr]:border-b" } },
    "html:tbody": { props: { className: "border border-border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right" } },
    "html:tr": { props: { className: cellClass } },
    "html:th": { props: { className: cn("h-12 px-4 text-left align-middle font-medium text-muted-foreground", cellClass) } },
    "html:td": { props: { className: cn("p-4 align-middle", cellClass) } },
  };
}
