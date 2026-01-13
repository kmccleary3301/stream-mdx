"use client";

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import React, { createElement } from "react";

import {
  ComponentRegistry,
  renderInlineNodes,
  type HtmlElements,
  type InlineNode,
  type TableElements,
} from "@stream-mdx/react";

import { BlockMath, InlineMath } from "@/components/markdown/Math";
import { ScrollAreaHorizontal } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export function createDemoTableElements(): TableElements {
  return {
    Table,
    Thead: TableHeader,
    Tbody: TableBody,
    Tr: TableRow,
    Th: TableHead,
    Td: TableCell,
  };
}

export function createDemoHtmlElements(): Partial<HtmlElements> {
  return {
    table: ({ className, children, ...props }: HTMLAttributes<HTMLTableElement>) => (
      <div className="my-6 w-full overflow-hidden overflow-y-auto">
        <Table className={className} {...props}>
          {children}
        </Table>
      </div>
    ),
    thead: ({ className, children, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
      <TableHeader className={className} {...props}>
        {children}
      </TableHeader>
    ),
    tbody: ({ className, children, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
      <TableBody className={cn("border border-border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right", className)} {...props}>
        {children}
      </TableBody>
    ),
    tr: ({ className, children, ...props }: HTMLAttributes<HTMLTableRowElement>) => (
      <TableRow className={cn("border border-border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right", className)} {...props}>
        {children}
      </TableRow>
    ),
    th: ({ className, children, ...props }: HTMLAttributes<HTMLTableCellElement>) => (
      <TableHead
        className={cn("border border-border px-4 py-2 text-left font-bold [&[align=center]]:text-center [&[align=right]]:text-right", className)}
        {...props}
      >
        {children}
      </TableHead>
    ),
    td: ({ className, children, ...props }: HTMLAttributes<HTMLTableCellElement>) => (
      <TableCell className={cn("border border-border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right", className)} {...props}>
        {children}
      </TableCell>
    ),
  };
}

function parseStyleAttribute(value: string): CSSProperties & Record<string, string> {
  const style: Record<string, string> = {};
  if (!value) return style;
  const parts = value.split(";");
  for (const part of parts) {
    if (!part.trim()) continue;
    const [prop, val] = part.split(":");
    if (!prop || !val) continue;
    const property = prop.trim();
    const trimmedValue = val.trim();
    if (property.startsWith("--")) {
      style[property] = trimmedValue;
    } else {
      const camelProp = property.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
      style[camelProp] = trimmedValue;
    }
  }
  return style as CSSProperties & Record<string, string>;
}

function attrsToProps(attrs?: Record<string, string>): HTMLAttributes<HTMLElement> & Record<string, unknown> {
  if (!attrs) return {} as HTMLAttributes<HTMLElement> & Record<string, unknown>;
  const out: HTMLAttributes<HTMLElement> & Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") {
      out.className = value;
    } else if (key === "style") {
      out.style = parseStyleAttribute(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function configureDemoRegistry(options: {
  registry: ComponentRegistry;
  tableElements: TableElements;
  htmlElements: Partial<HtmlElements>;
  showCodeMeta?: boolean;
}): void {
  const { registry, tableElements, htmlElements, showCodeMeta = false } = options;

  registry.setInlineComponents({
    mention: ({ handle }: { handle: string }) => (
      <a href={`https://x.com/${handle}`} className="text-[#A68AEB] underline-offset-4 hover:underline">
        @{handle}
      </a>
    ),
    "math-inline": ({ tex }: { tex: string }) => <InlineMath math={tex} />,
    "math-display": ({ tex }: { tex: string }) => <BlockMath math={tex} />,
  });

  const renderWithInline = (nodes: InlineNode[]) => renderInlineNodes(nodes, registry.getInlineComponents());

  registry.setBlockComponents({
    paragraph: ({ inlines, raw }: { inlines: InlineNode[]; raw?: string }) => {
      const filteredInlines = inlines.length > 0 && raw ? inlines.filter((node) => !(node.kind === "text" && node.text === raw)) : inlines;
      const baseInlines: InlineNode[] = filteredInlines.length > 0 ? filteredInlines : raw ? ([{ kind: "text", text: raw }] as InlineNode[]) : [];
      let hasDisplayMath = false;
      let key = 0;
      const segments: ReactNode[] = [];
      let buffer: InlineNode[] = [];

      const flushBuffer = () => {
        if (buffer.length === 0) return;
        segments.push(
          <p key={`segment-${key++}`} className="markdown-paragraph">
            {renderWithInline(buffer)}
          </p>,
        );
        buffer = [];
      };

      for (const node of baseInlines) {
        if (node.kind === "math-display") {
          hasDisplayMath = true;
          flushBuffer();
          segments.push(<BlockMath key={`math-${key++}`} math={node.tex} />);
        } else {
          buffer.push(node);
        }
      }
      flushBuffer();

      if (!hasDisplayMath) {
        return <p className="markdown-paragraph">{renderWithInline(baseInlines)}</p>;
      }

      return <div className="markdown-paragraph">{segments}</div>;
    },
    heading: ({ level, inlines, text }: { level: 1 | 2 | 3 | 4 | 5 | 6; inlines: InlineNode[]; text?: string }) => {
      const Tag = `h${level}` as const;
      const headingProps: Record<string, unknown> = {
        className: `markdown-heading markdown-h${level}`,
      };
      if (text && text.length > 0) {
        headingProps["data-heading-text"] = text;
      }
      return <Tag {...headingProps}>{renderWithInline(inlines)}</Tag>;
    },
    blockquote: ({ inlines, renderedContent }: { inlines: InlineNode[]; renderedContent?: ReactNode }) => (
      <blockquote className="markdown-blockquote">{renderedContent ?? renderWithInline(inlines)}</blockquote>
    ),
    list: ({ ordered, items }: { ordered: boolean; items: InlineNode[][] }) => {
      const Tag = ordered ? "ol" : "ul";
      return (
        <Tag className={`markdown-list ${ordered ? "ordered" : "unordered"}`}>
          {items.map((item, index) => {
            const synthesizedKey = item
              .map((node) => {
                switch (node.kind) {
                  case "text":
                  case "code":
                    return `${node.kind}:${node.text}`;
                  case "link":
                    return `${node.kind}:${node.href ?? ""}:${node.title ?? ""}`;
                  case "image":
                    return `${node.kind}:${node.src}`;
                  case "mention":
                    return `${node.kind}:${node.handle}`;
                  default:
                    return node.kind;
                }
              })
              .join("|");
            const key = synthesizedKey.length > 0 ? synthesizedKey : `list-item-${index}`;
            return (
              <li key={key} className="markdown-list-item">
                {renderWithInline(item)}
              </li>
            );
          })}
        </Tag>
      );
    },
    code: ({
      html,
      raw,
      meta,
      lang,
      lines,
      preAttrs,
      codeAttrs,
    }: {
      html: string;
      raw?: string;
      meta?: Record<string, unknown>;
      lang?: string;
      lines?: ReadonlyArray<{ id: string; index: number; text: string; html?: string | null }>;
      preAttrs?: Record<string, string>;
      codeAttrs?: Record<string, string>;
    }) => {
      const fenced = typeof meta?.code === "string" && meta.code.length > 0 ? meta.code : raw ?? "";
      const stripFence = (value: string): string => {
        if (!value) return "";
        const trimmed = value.trimStart();
        if (!trimmed.startsWith("```")) return value;
        const parts = trimmed.split("\n");
        if (parts.length <= 1) return value;
        if (parts[parts.length - 1].trim().startsWith("```")) {
          return parts.slice(1, -1).join("\n");
        }
        return parts.slice(1).join("\n");
      };
      const rawCode = stripFence(fenced);
      const rawCodeLines = rawCode ? rawCode.split("\n") : [];
      const incomingLines = Array.isArray(lines) ? lines.map((l) => l.text ?? "") : [];
      const effectiveLines = rawCodeLines.length > 0 ? rawCodeLines : incomingLines;
      const languageLabel = typeof (lang ?? meta?.lang) === "string" && String(lang ?? meta?.lang).length > 0 ? String(lang ?? meta?.lang) : null;
      const showLabel = Boolean(showCodeMeta && languageLabel);

      return (
        <div className="flex flex-col">
          {showLabel ? (
            <div className="border-border/60 border-b bg-muted/40 px-3 py-1 font-mono text-muted-foreground text-xs">{languageLabel}</div>
          ) : null}
          <ScrollAreaHorizontal className="min-w-auto">
            <div className="min-w-max p-4">
              {html ? (
                <div
                  className="[&_pre]:m-0 [&_pre]:overflow-x-visible [&_pre]:bg-transparent [&_pre]:p-0"
                  /* biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized upstream */
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              ) : effectiveLines.length > 0 ? (
                <pre className="m-0" {...attrsToProps(preAttrs)}>
                  <code {...attrsToProps(codeAttrs)}>
                    {effectiveLines.map((text, idx) => (
                      <span
                        key={`line-${idx}`}
                        className="line"
                        dangerouslySetInnerHTML={{
                          __html: text
                            .replace(/&/g, "&amp;")
                            .replace(/</g, "&lt;")
                            .replace(/>/g, "&gt;")
                            .replace(/\"/g, "&quot;")
                            .replace(/'/g, "&#39;"),
                        }}
                      />
                    ))}
                  </code>
                </pre>
              ) : null}
            </div>
          </ScrollAreaHorizontal>
        </div>
      );
    },
    table: ({
      header,
      rows,
      align,
      elements,
    }: {
      header?: InlineNode[][];
      rows: InlineNode[][][];
      align?: Array<"left" | "center" | "right" | null>;
      elements?: Partial<TableElements>;
    }) => {
      const El: TableElements = { ...tableElements, ...(elements || {}) } as TableElements;
      const renderCells = (cells: InlineNode[][], tag: "th" | "td", rowIdx: number) =>
        cells.map((cell, i) => {
          const columnAlign = align?.[i] ?? undefined;
          const cellStyle = columnAlign ? ({ textAlign: columnAlign } satisfies CSSProperties) : undefined;
          const Comp = tag === "th" ? El.Th : El.Td;
          return (
            <Comp key={`${rowIdx}-${i}`} style={cellStyle} align={columnAlign ?? undefined}>
              {renderWithInline(cell)}
            </Comp>
          );
        });

      return (
        <ScrollAreaHorizontal className="my-6 w-full rounded border border-border">
          <div className="min-w-max">
            <El.Table className="w-full caption-bottom text-base">
              {header && header.length > 0 ? <El.Thead>{<El.Tr>{renderCells(header, "th", -1)}</El.Tr>}</El.Thead> : null}
              <El.Tbody>{rows.map((row, r) => createElement(El.Tr, { key: r }, renderCells(row, "td", r)))}</El.Tbody>
            </El.Table>
          </div>
        </ScrollAreaHorizontal>
      );
    },
  });

  registry.setTableElements(tableElements);
  registry.setHtmlElements(htmlElements);
}
