import { stripCodeFence, type Block, type InlineNode, type MixedContentSegment } from "@stream-mdx/core";
import React from "react";
import { renderInlineNodes, renderParagraphMixedSegments } from "../components";
import type { ComponentRegistry } from "../components";
import { DEFAULT_INLINE_HTML_RENDERERS, renderInlineHtmlSegment } from "../utils/inline-html";
import { useRendererChildren, useRendererNode } from "./hooks";
import type { RendererStore } from "./store";
import { DEFAULT_VIRTUALIZED_CODE_CONFIG, type VirtualizedLine, useVirtualizedCode } from "./virtualized-code";

export const BlockNodeRenderer: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = ({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  const block = node?.block;
  if (!node || !block) return null;

  switch (block.type) {
    case "paragraph":
      return <ParagraphBlockView store={store} blockId={block.id} registry={registry} />;
    case "blockquote":
      return <BlockquoteBlockView store={store} blockId={block.id} registry={registry} />;
    case "list":
      return <ListBlockView store={store} blockId={block.id} registry={registry} depth={0} />;
    case "table":
      return <TableBlockView store={store} blockId={block.id} registry={registry} />;
    case "code":
      return <CodeBlockView store={store} blockId={block.id} registry={registry} />;
    case "html":
      return <HtmlBlockView store={store} blockId={block.id} registry={registry} />;
    case "mdx":
      return <MdxBlockView store={store} blockId={block.id} registry={registry} />;
    default:
      return registry.renderBlock(block);
  }
};

const ParagraphBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  const block = node?.block;
  const childIds = useRendererChildren(store, blockId);
  if (!node || !block) {
    return null;
  }

  const inlineComponents = registry.getInlineComponents();

  if (!block.isFinalized) {
    const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
    const meta = (block.payload.meta ?? {}) as { inlineStatus?: string; mixedSegments?: MixedContentSegment[] };
    const segments = Array.isArray(meta.mixedSegments) ? meta.mixedSegments : [];
    // Preserve the existing behavior for MDX/HTML-mixed paragraphs while streaming.
    if (segments.length > 0) {
      return <p className="markdown-paragraph streaming-partial">{raw}</p>;
    }

    if (meta.inlineStatus === "complete" || meta.inlineStatus === "anticipated") {
      const inlineNodes = block.payload.inline ?? [];
      const containsDisplayMath = inlineNodes.some((node) => node.kind === "math-display");
      if (containsDisplayMath) {
        const derivedSegments: MixedContentSegment[] = [
          {
            kind: "text",
            value: raw,
            inline: inlineNodes,
          },
        ];
        const structured = renderParagraphMixedSegments(derivedSegments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS);
        if (structured.length === 1) {
          const [single] = structured;
          return React.isValidElement(single) ? single : single;
        }
        return structured;
      }

      return <p className="markdown-paragraph streaming-partial">{renderInlineNodes(inlineNodes, inlineComponents)}</p>;
    }

    return <p className="markdown-paragraph streaming-partial">{raw}</p>;
  }

  const propsBlock = node.props?.block as Block | undefined;
  const inlineStatus =
    (propsBlock?.payload?.meta as { inlineStatus?: string } | undefined)?.inlineStatus ??
    (block.payload.meta as { inlineStatus?: string } | undefined)?.inlineStatus ??
    (node.props?.inlineStatus as string | undefined);
  if (inlineStatus && inlineStatus !== "complete") {
    const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
    return <p className="markdown-paragraph">{raw}</p>;
  }

  const segments = Array.isArray((block.payload.meta as { mixedSegments?: MixedContentSegment[] } | undefined)?.mixedSegments)
    ? ((block.payload.meta as { mixedSegments?: MixedContentSegment[] }).mixedSegments as MixedContentSegment[])
    : undefined;

  if (segments && segments.length > 0) {
    const structured = renderParagraphMixedSegments(segments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS);
    if (structured.length === 1) {
      const [single] = structured;
      return React.isValidElement(single) ? single : single;
    }
    return structured;
  }

  const inlineNodes = block.payload.inline ?? [];
  const containsDisplayMath = inlineNodes.some((node) => node.kind === "math-display");
  if (containsDisplayMath) {
    const derivedSegments: MixedContentSegment[] = [
      {
        kind: "text",
        value: typeof block.payload.raw === "string" ? block.payload.raw : "",
        inline: inlineNodes,
      },
    ];
    const structured = renderParagraphMixedSegments(derivedSegments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS);
    if (structured.length === 1) {
      const [single] = structured;
      return React.isValidElement(single) ? single : single;
    }
    return structured;
  }

  const ParagraphComponent = registry.getBlockComponent("paragraph");
  const baseElement = React.createElement(ParagraphComponent, {
    inlines: block.payload.inline ?? [],
    raw: block.payload.raw,
    meta: block.payload.meta,
  });

  if (childIds.length > 0) {
    const renderedChildren = childIds.map((childId) => <MixedSegmentView key={childId} store={store} nodeId={childId} inlineComponents={inlineComponents} />);
    if (React.isValidElement(baseElement)) {
      const { children: _ignored, className = "markdown-paragraph", inlines: _inlines, raw: _raw, meta: _meta, ...rest } = baseElement.props ?? {};
      return React.createElement("p", { ...rest, className }, renderedChildren);
    }
    return <p className="markdown-paragraph">{renderedChildren}</p>;
  }

  if (React.isValidElement(baseElement)) {
    return baseElement;
  }

  return <p className="markdown-paragraph">{renderInlineNodes(block.payload.inline ?? [], inlineComponents)}</p>;
});

ParagraphBlockView.displayName = "ParagraphBlockView";

const BlockquoteBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  const block = node?.block;
  const childIds = useRendererChildren(store, blockId);
  if (!node || !block) {
    return null;
  }

  const meta = (block.payload.meta ?? {}) as {
    mixedSegments?: Array<{
      kind: string;
      value: string;
      sanitized?: string;
      status?: string;
      inline?: InlineNode[];
    }>;
    normalizedText?: string;
  };
  const mixedSegments = Array.isArray(meta.mixedSegments) ? meta.mixedSegments : [];
  const normalizedText =
    typeof meta.normalizedText === "string" && meta.normalizedText.length > 0
      ? meta.normalizedText
      : typeof block.payload.raw === "string"
        ? block.payload.raw
        : "";

  const inlineComponents = registry.getInlineComponents();

  const renderTextWithBreaks = (text: string, keyPrefix: string) => {
    const lines = text.split("\n");
    const lastIndex = lines.length - 1;
    let offset = 0;
    return lines.map((line, idx) => {
      const key = `${keyPrefix}${offset}`;
      offset += line.length + 1;
      return (
        <span key={key} className="markdown-blockquote-line">
          {line}
          {idx < lastIndex ? <br /> : null}
        </span>
      );
    });
  };

  const renderInlineContent = (inline: InlineNode[] | undefined, keyPrefix: string) => {
    if (inline && inline.length > 0) {
      return renderInlineNodes(inline, inlineComponents);
    }
    return null;
  };

  const renderMixedSegments = () => {
    if (!mixedSegments.length) {
      return [] as React.ReactNode[];
    }
    const elements: React.ReactNode[] = [];
    mixedSegments.forEach((segment, segmentIndex) => {
      switch (segment.kind) {
        case "html": {
          const htmlNode = renderInlineHtmlSegment(segment.value, segment.sanitized ?? segment.value, {
            key: `blockquote-html-${block.id}-${segmentIndex}`,
            renderers: DEFAULT_INLINE_HTML_RENDERERS,
          });
          if (htmlNode) {
            elements.push(htmlNode);
          } else {
            elements.push(
              React.createElement("span", {
                key: `blockquote-html-${block.id}-${segmentIndex}`,
                className: "markdown-inline-html",
                /* biome-ignore lint/security/noDangerouslySetInnerHtml: segment content is sanitized by the worker before streaming */
                dangerouslySetInnerHTML: { __html: segment.sanitized ?? segment.value },
              }),
            );
          }
          break;
        }
        case "mdx":
          elements.push(
            <span key={`blockquote-mdx-${block.id}-${segmentIndex}`} data-mdx-status={segment.status ?? "pending"}>
              {segment.value}
            </span>,
          );
          break;
        default: {
          const inline = renderInlineContent(segment.inline, `blockquote-text-inline-${block.id}-${segmentIndex}-`);
          if (inline) {
            elements.push(<React.Fragment key={`blockquote-inline-${block.id}-${segmentIndex}`}>{inline}</React.Fragment>);
          } else {
            elements.push(
              <React.Fragment key={`blockquote-text-${block.id}-${segmentIndex}`}>
                {renderTextWithBreaks(segment.value, `blockquote-text-${block.id}-${segmentIndex}-`)}
              </React.Fragment>,
            );
          }
          break;
        }
      }
    });
    return elements;
  };

  const mixedSegmentElements = renderMixedSegments();

  const fallbackElements = normalizedText ? renderTextWithBreaks(normalizedText, `blockquote-fallback-${block.id}-`) : null;

  const inlineNodes = block.payload.inline ?? [];
  const inlineElements = inlineNodes.length > 0 ? renderInlineNodes(inlineNodes, inlineComponents) : null;

  if (!block.isFinalized) {
    const streamingContent = mixedSegmentElements.length ? mixedSegmentElements : inlineElements ? inlineElements : fallbackElements;
    const shouldShowStreaming = !block.isFinalized && (!streamingContent || (Array.isArray(streamingContent) && streamingContent.length === 0));
    const className = shouldShowStreaming ? "markdown-blockquote streaming-partial" : "markdown-blockquote";
    return <blockquote className={className}>{streamingContent}</blockquote>;
  }

  const childContent = childIds.map((childId) => <MixedSegmentView key={childId} store={store} nodeId={childId} inlineComponents={inlineComponents} />);

  const renderedContent = (() => {
    if (mixedSegmentElements.length > 0) {
      return mixedSegmentElements;
    }
    if (childIds.length > 0) {
      const resolved = childContent.filter((child) => child !== null);
      if (resolved.length > 0) {
        return resolved;
      }
    }
    if (inlineElements) {
      return inlineElements;
    }
    if (fallbackElements && fallbackElements.length > 0) {
      return fallbackElements;
    }
    return null;
  })();

  const BlockquoteComponent = registry.getBlockComponent("blockquote");
  const baseElement = React.createElement(
    BlockquoteComponent,
    {
      inlines: block.payload.inline ?? [],
      renderedContent,
    },
    renderedContent,
  );

  if (React.isValidElement(baseElement)) {
    return baseElement;
  }

  return <blockquote className="markdown-blockquote">{renderedContent}</blockquote>;
});

BlockquoteBlockView.displayName = "BlockquoteBlockView";

const MixedSegmentView: React.FC<{
  store: RendererStore;
  nodeId: string;
  inlineComponents: ReturnType<ComponentRegistry["getInlineComponents"]>;
}> = React.memo(({ store, nodeId, inlineComponents }) => {
  const node = useRendererNode(store, nodeId);
  if (!node) return null;

  switch (node.type) {
    case "paragraph-text":
    case "blockquote-text":
    case "list-item-text": {
      const inline = (node.props?.inline as InlineNode[] | undefined) ?? [];
      if (inline.length > 0) {
        return renderInlineNodes(inline, inlineComponents);
      }
      const text = typeof node.props?.text === "string" ? (node.props?.text as string) : "";
      if (!text) return null;
      return text;
    }
    case "paragraph-html":
    case "blockquote-html":
    case "list-item-html": {
      const raw = typeof node.props?.raw === "string" ? (node.props.raw as string) : undefined;
      const html = typeof node.props?.html === "string" ? (node.props?.html as string) : "";
      const rendered = renderInlineHtmlSegment(raw, html, {
        key: node.id,
        renderers: DEFAULT_INLINE_HTML_RENDERERS,
      });
      if (rendered) {
        return rendered;
      }
      if (!html) return null;
      return React.createElement("span", {
        className: "markdown-inline-html",
        /* biome-ignore lint/security/noDangerouslySetInnerHtml: html is sanitized upstream before reaching the renderer */
        dangerouslySetInnerHTML: { __html: html },
      });
    }
    case "paragraph-mdx":
    case "blockquote-mdx":
    case "list-item-mdx": {
      const status = (node.props?.status as string) ?? "pending";
      const raw = typeof node.props?.raw === "string" ? (node.props?.raw as string) : "";
      if (status === "compiled") {
        return <span className="markdown-mdx-inline" data-mdx-status="compiled" />;
      }
      if (status === "error") {
        const message = raw || "MDX error";
        return (
          <span className="markdown-mdx-inline text-destructive" data-mdx-status="error">
            {message}
          </span>
        );
      }
      return (
        <span className="markdown-mdx-inline" data-mdx-status={status}>
          {status === "compiled" ? "" : raw}
        </span>
      );
    }
    default:
      return null;
  }
});

MixedSegmentView.displayName = "MixedSegmentView";

const HtmlBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  if (!node || !node.block) return null;
  return registry.renderBlock(node.block);
});

HtmlBlockView.displayName = "HtmlBlockView";

const MdxBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  if (!node || !node.block) return null;
  return registry.renderBlock(node.block);
});

MdxBlockView.displayName = "MdxBlockView";

const ListBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry; depth?: number }> = React.memo(
  ({ store, blockId, registry, depth = 0 }) => {
    const node = useRendererNode(store, blockId);
    const block = node?.block;
    const childIds = useRendererChildren(store, blockId);
    const inlineComponents = registry.getInlineComponents();
    const ordered = Boolean(node?.props?.ordered ?? block?.payload.meta?.ordered);
    const Tag = ordered ? "ol" : "ul";
    return (
      <Tag className={`markdown-list ${ordered ? "ordered" : "unordered"}`} data-list-depth={depth}>
        {childIds.map((childId, index) => (
          <ListItemView
            key={childId}
            store={store}
            nodeId={childId}
            inlineComponents={inlineComponents}
            registry={registry}
            ordered={ordered}
            index={index}
            depth={depth}
          />
        ))}
      </Tag>
    );
  },
);

ListBlockView.displayName = "ListBlockView";

const ListItemView: React.FC<{
  store: RendererStore;
  nodeId: string;
  inlineComponents: ReturnType<ComponentRegistry["getInlineComponents"]>;
  registry: ComponentRegistry;
  ordered: boolean;
  index: number;
  depth: number;
}> = React.memo(({ store, nodeId, inlineComponents, registry, ordered, index, depth }) => {
  const node = useRendererNode(store, nodeId);
  const childIds = useRendererChildren(store, nodeId);
  const inline = (node?.props?.inline as InlineNode[] | undefined) ?? [];
  const isTask = Boolean(node?.props?.task);
  const isChecked = Boolean(node?.props?.checked);
  const block = node?.block;
  const raw = typeof block?.payload?.raw === "string" ? block.payload.raw : undefined;
  const markerMatch = raw ? raw.match(/^([^\s]+)\s+/) : null;
  const marker = markerMatch?.[1]?.trim();
  const inferredIndex = typeof node?.props?.index === "number" ? Number(node?.props?.index) : index;
  const isOrdered = Boolean(node?.props?.ordered ?? ordered);
  const counterText = !isTask ? (isOrdered ? (marker ? marker : `${inferredIndex + 1}.`) : "\u2022") : undefined;

  const [segmentChildIds, contentChildIds] = React.useMemo(() => {
    const segments: string[] = [];
    const structural: string[] = [];
    for (const childId of childIds) {
      const childNode = store.getNode(childId);
      if (!childNode) continue;
      if (childNode.type?.startsWith("list-item-")) {
        segments.push(childId);
      } else {
        structural.push(childId);
      }
    }
    return [segments, structural];
  }, [childIds, store]);

  const segmentElements = React.useMemo(() => {
    return segmentChildIds.map((childId) => <MixedSegmentView key={childId} store={store} nodeId={childId} inlineComponents={inlineComponents} />);
  }, [segmentChildIds, store, inlineComponents]);

  const primaryContent = React.useMemo(() => {
    if (segmentChildIds.length > 0) {
      return segmentElements;
    }
    return renderInlineNodes(inline, inlineComponents);
  }, [segmentChildIds, segmentElements, inline, inlineComponents]);

  const trailingChildren = React.useMemo(() => {
    return contentChildIds.map((childId) => {
      const childNode = store.getNode(childId);
      if (!childNode) return null;
      switch (childNode.type) {
        case "paragraph": {
          const childInline = (childNode.props?.inline as InlineNode[] | undefined) ?? [];
          return (
            <p key={childId} className="markdown-list-item-paragraph">
              {renderInlineNodes(childInline, inlineComponents)}
            </p>
          );
        }
        case "list":
          return <ListBlockView key={childId} store={store} blockId={childId} registry={registry} depth={depth + 1} />;
        default:
          return <BlockNodeRenderer key={childId} store={store} blockId={childId} registry={registry} />;
      }
    });
  }, [contentChildIds, store, inlineComponents, registry, depth]);

  const filteredChildren = trailingChildren.filter((child): child is NonNullable<typeof child> => Boolean(child));
  const hasChildren = filteredChildren.length > 0;

  return (
    <li className={`markdown-list-item${isTask ? " markdown-list-item-task" : ""}`} data-counter-text={counterText} data-list-depth={depth}>
      {isTask ? (
        <div className="markdown-task">
          <input type="checkbox" className="markdown-task-checkbox" checked={isChecked} readOnly disabled tabIndex={-1} aria-checked={isChecked} />
          <span className="markdown-task-content">{primaryContent}</span>
        </div>
      ) : (
        primaryContent
      )}
      {hasChildren ? <div className="markdown-list-item-children">{filteredChildren}</div> : null}
    </li>
  );
});

ListItemView.displayName = "ListItemView";

const TableBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const tableElements = registry.getTableElements();
  const childIds = useRendererChildren(store, blockId);
  return (
    <tableElements.Table className="markdown-table w-full caption-bottom text-base">
      {childIds.map((sectionId) => (
        <TableSectionView key={sectionId} store={store} nodeId={sectionId} registry={registry} />
      ))}
    </tableElements.Table>
  );
});

TableBlockView.displayName = "TableBlockView";

const TableSectionView: React.FC<{ store: RendererStore; nodeId: string; registry: ComponentRegistry }> = React.memo(({ store, nodeId, registry }) => {
  const node = useRendererNode(store, nodeId);
  if (!node) return null;
  const tableElements = registry.getTableElements();
  if (node.type === "table-header") {
    const childIds = useRendererChildren(store, nodeId);
    return (
      <tableElements.Thead>
        <tableElements.Tr>
          {childIds.map((cellId) => (
            <TableCellView key={cellId} store={store} nodeId={cellId} registry={registry} />
          ))}
        </tableElements.Tr>
      </tableElements.Thead>
    );
  }
  if (node.type === "table-body") {
    const rowIds = useRendererChildren(store, nodeId);
    return (
      <tableElements.Tbody>
        {rowIds.map((rowId) => (
          <TableRowView key={rowId} store={store} nodeId={rowId} registry={registry} />
        ))}
      </tableElements.Tbody>
    );
  }
  return null;
});

TableSectionView.displayName = "TableSectionView";

const TableRowView: React.FC<{ store: RendererStore; nodeId: string; registry: ComponentRegistry }> = React.memo(({ store, nodeId, registry }) => {
  const tableElements = registry.getTableElements();
  const cellIds = useRendererChildren(store, nodeId);
  return (
    <tableElements.Tr>
      {cellIds.map((cellId) => (
        <TableCellView key={cellId} store={store} nodeId={cellId} registry={registry} />
      ))}
    </tableElements.Tr>
  );
});

TableRowView.displayName = "TableRowView";

const TableCellView: React.FC<{ store: RendererStore; nodeId: string; registry: ComponentRegistry }> = React.memo(({ store, nodeId, registry }) => {
  const node = useRendererNode(store, nodeId);
  const inlineComponents = registry.getInlineComponents();
  const tableElements = registry.getTableElements();
  if (!node) return null;
  const Tag = node.type === "table-header-cell" ? tableElements.Th : tableElements.Td;
  const inline = (node.props?.inline as InlineNode[] | undefined) ?? [];
  const align = node.props?.align as string | undefined;
  const content = renderInlineNodes(inline, inlineComponents);
  const alignProps = align ? { align } : undefined;
  return <Tag {...alignProps}>{content}</Tag>;
});

TableCellView.displayName = "TableCellView";

const CodeBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  const childIds = useRendererChildren(store, blockId);
  const CodeComponent = registry.getBlockComponent("code");

  if (!node || !node.block) return null;

  const nodeVersion = node.version;

  const lines = React.useMemo(() => {
    const seenIds = new Set<string>();
    const seenIndices = new Set<number>();
    const deduped: VirtualizedLine[] = [];

    for (const childId of childIds) {
      const child = store.getNode(childId);
      if (!child) continue;
      const index = typeof child.props?.index === "number" ? (child.props?.index as number) : deduped.length;
      const text = typeof child.props?.text === "string" ? (child.props?.text as string) : "";
      const html = typeof child.props?.html === "string" ? (child.props?.html as string) : null;

      if (seenIds.has(child.id) || seenIndices.has(index)) {
        console.warn("[renderer-view] duplicate code line detected", {
          blockId,
          childId: child.id,
          index,
        });
        continue;
      }

      seenIds.add(child.id);
      seenIndices.add(index);
      deduped.push({ id: child.id, index, text, html });
    }

    // Sort by index to ensure correct line order (important for streaming)
    deduped.sort((a, b) => a.index - b.index);

    return deduped;
  }, [childIds, store, blockId, nodeVersion]);

  const lang = typeof node.props?.lang === "string" ? (node.props?.lang as string) : (node.block.payload.meta?.lang as string | undefined);
  const preAttrs = (node.props?.preAttrs as Record<string, string> | undefined) ?? undefined;
  const codeAttrs = (node.props?.codeAttrs as Record<string, string> | undefined) ?? undefined;

  // Use virtualization if enabled and lines exceed threshold
  const virtualizationConfig = DEFAULT_VIRTUALIZED_CODE_CONFIG;
  const shouldVirtualize = virtualizationConfig.enabled && lines.length >= virtualizationConfig.virtualizeThreshold;
  const virtualization = useVirtualizedCode(lines, shouldVirtualize ? virtualizationConfig : { ...virtualizationConfig, enabled: false });

  // Render virtualized or non-virtualized code
  const highlightedHtml = React.useMemo(() => {
    if (!shouldVirtualize && node.block?.payload.highlightedHtml) {
      return node.block.payload.highlightedHtml;
    }
    // Always prefer composing from line children if they exist (even during streaming)
    // This ensures we show incremental updates as lines arrive via appendLines patches
    if (lines.length > 0) {
      if (shouldVirtualize) {
        // Only compose visible lines for virtualized code
        return composeHighlightedHtml(virtualization.window.visibleLines, preAttrs, codeAttrs);
      }
      return composeHighlightedHtml(lines, preAttrs, codeAttrs);
    }
    // Fallback to block's highlightedHtml only if no line children exist yet
    // This handles the initial state before appendLines patches arrive
    const blockHtml = node.block?.payload.highlightedHtml ?? "";
    if (blockHtml?.trim().match(/^```[\w-]*\s*$/)) {
      const raw = node.block?.payload.raw ?? "";
      if (raw.trim().length > 0) {
        // Return minimal HTML structure with raw text until lines are available
        return composeHighlightedHtml([{ index: 0, text: raw, html: null, id: "temp" }], preAttrs, codeAttrs);
      }
    }
    return blockHtml;
  }, [shouldVirtualize, node.block?.payload.highlightedHtml, lines, preAttrs, codeAttrs, virtualization.window.visibleLines, node.block?.payload.raw]);

  const rendered = (
    <CodeComponent
      html={highlightedHtml}
      meta={node.block.payload.meta}
      lines={shouldVirtualize ? virtualization.window.visibleLines : lines}
      lang={lang}
      preAttrs={preAttrs}
      codeAttrs={codeAttrs}
    />
  );

  const codeFrameClass = "not-prose my-3 flex flex-col rounded-lg border border-input pt-1 font-mono text-sm";
  const scrollShimStyle = { minWidth: "100%", display: "table" } as const;

  const codeView = shouldVirtualize ? (
    (() => {
      const { containerRef, window, handleScroll, lineHeight } = virtualization;
      const spacerTop = window.startIndex * lineHeight;
      const spacerBottom = (window.totalLines - window.endIndex) * lineHeight;
      return (
        <pre className={codeFrameClass}>
          <div
            ref={containerRef}
            className="markdown-code-block-container relative"
            style={{ overflowY: "auto", overflowX: "auto", maxHeight: "600px" }}
            onScroll={handleScroll}
          >
            <div style={{ height: spacerTop }} aria-hidden="true" />
            <div style={scrollShimStyle}>{rendered}</div>
            <div style={{ height: spacerBottom }} aria-hidden="true" />
          </div>
        </pre>
      );
    })()
  ) : (
    <pre className={codeFrameClass}>
      <div className="markdown-code-block-container relative min-w-0 overflow-x-auto">
        <div style={scrollShimStyle}>{rendered}</div>
      </div>
    </pre>
  );

  const blockComponentMap = registry.getBlockComponentMap() as Record<string, unknown>;
  const MermaidComponent = Object.prototype.hasOwnProperty.call(blockComponentMap, "mermaid") ? (blockComponentMap as any).mermaid : null;
  if ((lang ?? "").toLowerCase() === "mermaid" && MermaidComponent) {
    const raw = typeof node.block.payload.raw === "string" ? node.block.payload.raw : "";
    const fenced = stripCodeFence(raw);
    const code = fenced.hadFence ? fenced.code : raw;
    return React.createElement(MermaidComponent as React.ComponentType<any>, {
      code,
      renderCode: codeView,
      meta: node.block.payload.meta,
      isFinalized: node.block.isFinalized,
    });
  }

  return codeView;
});

CodeBlockView.displayName = "CodeBlockView";

function composeHighlightedHtml(
  lines: ReadonlyArray<{ index: number; text: string; html?: string | null; id?: string }>,
  preAttrs?: Record<string, string>,
  codeAttrs?: Record<string, string>,
): string {
  const lineMarkup = lines
    .map((line) => {
      const content = line.html ?? escapeHtml(line.text);
      const dataLine = Number.isFinite(line.index) ? ` data-line="${line.index + 1}"` : "";
      return `<span class="line"${dataLine}>${content}</span>`;
    })
    .join("\n");
  const preAttr = attrsToString(preAttrs);
  const codeAttr = attrsToString(codeAttrs);
  return `<pre${preAttr}><code${codeAttr}>${lineMarkup}\n</code></pre>`;
}

function attrsToString(attrs?: Record<string, string>): string {
  if (!attrs) return "";
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join("");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;");
}
