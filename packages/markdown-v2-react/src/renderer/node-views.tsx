import { getDefaultCodeWrapperAttributes, stripCodeFence, type Block, type InlineNode, type MixedContentSegment, type TokenLineV1 } from "@stream-mdx/core";
import React from "react";
import { renderInlineNodes, renderParagraphMixedSegments } from "../components";
import type { ComponentRegistry } from "../components";
import { DEFAULT_INLINE_HTML_RENDERERS, renderInlineHtmlSegment } from "../utils/inline-html";
import { useRendererChildren, useRendererNode } from "./hooks";
import { useCodeHighlightRequester } from "./code-highlight-context";
import { DeferredRenderContext } from "./deferred-render-context";
import { isListPatchDebugEnabled, type RendererStore } from "./store";
import { useDeferredRender } from "./use-deferred-render";
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
      const allowMixedStreaming = Boolean((meta as { allowMixedStreaming?: boolean }).allowMixedStreaming);
      if (!allowMixedStreaming) {
        return <p className="markdown-paragraph streaming-partial">{raw}</p>;
      }
      const structured = renderParagraphMixedSegments(segments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS);
      if (structured.length === 1) {
        const [single] = structured;
        return React.isValidElement(single) ? single : single;
      }
      return structured;
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
    const listDebugEnabled = isListPatchDebugEnabled();
    const listItemIds = React.useMemo(() => {
      const ids: string[] = [];
      for (const childId of childIds) {
        const childNode = store.getNode(childId);
        if (childNode?.type === "list-item") {
          ids.push(childId);
        }
      }
      return ids;
    }, [childIds, store]);
    React.useEffect(() => {
      if (!listDebugEnabled) return;
      const childTypes = childIds.map((childId) => store.getNode(childId)?.type ?? "missing");
      console.info("[stream-mdx:list-render]", {
        listId: blockId,
        depth,
        ordered,
        childIds,
        childTypes,
        listItemIds,
        listItems: listItemIds.length,
        totalChildren: childIds.length,
        isFinalized: block?.isFinalized ?? false,
      });
    }, [listDebugEnabled, blockId, depth, ordered, childIds, listItemIds, store, block?.isFinalized]);
    const { listStyle, markerDigits } = React.useMemo(() => {
      if (!ordered || listItemIds.length === 0) {
        return { listStyle: undefined, markerDigits: 1 };
      }
      let maxDigits = 1;
      listItemIds.forEach((childId, index) => {
        const childNode = store.getNode(childId);
        const raw = typeof childNode?.block?.payload?.raw === "string" ? childNode.block.payload.raw : undefined;
        const markerMatch = raw ? raw.match(/^([^\s]+)\s+/) : null;
        const marker = markerMatch?.[1]?.trim();
        const text = marker ?? `${index + 1}.`;
        const digitMatch = text.match(/\d/g);
        const digits = digitMatch ? digitMatch.length : text.length;
        if (digits > maxDigits) maxDigits = digits;
      });
      const baseIndent = depth === 0 ? "2rem" : depth === 1 ? "1.75rem" : "1.5rem";
      const extraDigits = Math.max(0, maxDigits - 1);
      return {
        markerDigits: maxDigits,
        listStyle: {
          ["--list-indent" as const]: extraDigits > 0 ? `calc(${baseIndent} + ${extraDigits}ch)` : baseIndent,
          ["--list-marker-digits" as const]: String(maxDigits),
        } as React.CSSProperties,
      };
    }, [ordered, listItemIds, store, depth]);
    if (listItemIds.length === 0) return null;
    return (
      <Tag
        className={`markdown-list ${ordered ? "ordered" : "unordered"}`}
        data-list-depth={depth}
        data-marker-digits={ordered ? markerDigits : undefined}
        data-list-id={listDebugEnabled ? blockId : undefined}
        style={listStyle}
      >
        {listItemIds.map((childId, index) => (
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
  const listDebugEnabled = isListPatchDebugEnabled();
  const inlineLength = inline.length;

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
  React.useEffect(() => {
    if (!listDebugEnabled) return;
    const childTypes = childIds.map((childId) => store.getNode(childId)?.type ?? "missing");
    console.info("[stream-mdx:list-item-render]", {
      itemId: nodeId,
      depth,
      ordered: isOrdered,
      inferredIndex,
      marker,
      isTask,
      isChecked,
      childIds,
      childTypes,
      segmentChildIds,
      contentChildIds,
      inlineLength,
      hasChildren,
      isFinalized: block?.isFinalized ?? false,
    });
  }, [
    listDebugEnabled,
    nodeId,
    depth,
    isOrdered,
    inferredIndex,
    marker,
    isTask,
    isChecked,
    childIds,
    segmentChildIds,
    contentChildIds,
    inlineLength,
    hasChildren,
    store,
    block?.isFinalized,
  ]);

  return (
    <li
      className={`markdown-list-item${isTask ? " markdown-list-item-task" : ""}`}
      data-counter-text={counterText}
      data-list-depth={depth}
      data-list-item-id={listDebugEnabled ? nodeId : undefined}
    >
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
  const deferredConfig = React.useContext(DeferredRenderContext);
  const deferredRef = React.useRef<HTMLDivElement | null>(null);
  const shouldRenderDeferred = useDeferredRender(
    deferredRef,
    deferredConfig ? { ...deferredConfig, enabled: true } : { enabled: false },
  );

  if (!node || !node.block) return null;

  const blockIsFinalized = node.block.isFinalized;
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
      const tokens = Object.prototype.hasOwnProperty.call(child.props ?? {}, "tokens") ? (child.props?.tokens as TokenLineV1 | null) : undefined;

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
      deduped.push({ id: child.id, index, text, html, tokens });
    }

    // Sort by index to ensure correct line order (important for streaming)
    deduped.sort((a, b) => a.index - b.index);

    return deduped;
  }, [childIds, store, blockId, nodeVersion]);

  const lang = typeof node.props?.lang === "string" ? (node.props?.lang as string) : (node.block.payload.meta?.lang as string | undefined);
  const preAttrs = (node.props?.preAttrs as Record<string, string> | undefined) ?? undefined;
  const codeAttrs = (node.props?.codeAttrs as Record<string, string> | undefined) ?? undefined;
  const blockMeta = (node.block.payload.meta as Record<string, unknown> | undefined) ?? undefined;
  const lazyEnabled = Boolean(blockMeta?.lazyTokenization);
  const lazyTokenizedUntil =
    typeof blockMeta?.lazyTokenizedUntil === "number"
      ? (blockMeta.lazyTokenizedUntil as number)
      : 0;
  const lazyHighlightedLines = Array.isArray(blockMeta?.highlightedLines) ? blockMeta.highlightedLines.length : 0;
  const lazyTokenLines = Array.isArray(blockMeta?.tokenLines) ? blockMeta.tokenLines.length : 0;
  const lazySourceTextLineCount = React.useMemo(() => {
    const raw = typeof node.block?.payload.raw === "string" ? node.block.payload.raw : "";
    const metaCode = typeof blockMeta?.code === "string" ? (blockMeta.code as string) : null;
    const sourceText = resolveCodeSourceText(raw, metaCode);
    if (sourceText.length === 0) return 0;
    return sourceText.split("\n").length;
  }, [blockMeta, node.block?.payload.raw]);
  const totalLazyLineCount = Math.max(lines.length, lazyHighlightedLines, lazyTokenLines, lazySourceTextLineCount);

  // Use virtualization if enabled and lines exceed threshold
  const virtualizationConfig = DEFAULT_VIRTUALIZED_CODE_CONFIG;
  const virtualizationDisabled =
    typeof process !== "undefined" && typeof process.env === "object" && process.env.STREAM_MDX_DISABLE_VIRTUALIZED_CODE === "true";
  // Keep the full streamed code visible while content is still arriving or while
  // lazy tokenization is progressively filling line metadata. Switching into a
  // windowed view mid-stream causes visible line loss and non-deterministic DOM.
  const canVirtualize = node.block.isFinalized && !lazyEnabled;
  const shouldVirtualize =
    canVirtualize && !virtualizationDisabled && virtualizationConfig.enabled && lines.length >= virtualizationConfig.virtualizeThreshold;
  const virtualization = useVirtualizedCode(lines, shouldVirtualize ? virtualizationConfig : { ...virtualizationConfig, enabled: false });
  const highlightRequester = useCodeHighlightRequester();
  const lastRangeRef = React.useRef<{
    visibleStart: number;
    visibleEnd: number;
    prefetchStart: number;
    prefetchEnd: number;
    tokenizedUntil: number;
  } | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const idleRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!shouldVirtualize || !lazyEnabled || !highlightRequester) return;
    const { visibleStart, visibleEnd, startIndex, endIndex } = virtualization.window;
    if (endIndex <= lazyTokenizedUntil) return;
    const nextRange = {
      visibleStart,
      visibleEnd,
      prefetchStart: startIndex,
      prefetchEnd: endIndex,
      tokenizedUntil: lazyTokenizedUntil,
    };
    const last = lastRangeRef.current;
    if (
      last &&
      last.visibleStart === nextRange.visibleStart &&
      last.visibleEnd === nextRange.visibleEnd &&
      last.prefetchStart === nextRange.prefetchStart &&
      last.prefetchEnd === nextRange.prefetchEnd &&
      last.tokenizedUntil === nextRange.tokenizedUntil
    ) {
      return;
    }
    lastRangeRef.current = nextRange;

    if (rafRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafRef.current);
    }
    if (typeof requestAnimationFrame === "function") {
      rafRef.current = requestAnimationFrame(() => {
        highlightRequester({
          blockId,
          startLine: visibleStart,
          endLine: visibleEnd,
          priority: "visible",
          reason: "scroll",
        });
        rafRef.current = null;
      });
    } else {
      highlightRequester({
        blockId,
        startLine: visibleStart,
        endLine: visibleEnd,
        priority: "visible",
        reason: "scroll",
      });
    }

    const prefetchNeeded = startIndex < visibleStart || endIndex > visibleEnd;
    if (prefetchNeeded) {
      const idleCallback = (globalThis as { requestIdleCallback?: (cb: (deadline: { didTimeout: boolean }) => void) => number })
        .requestIdleCallback;
      const cancelIdle = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (idleRef.current !== null) {
        if (typeof cancelIdle === "function") {
          cancelIdle(idleRef.current);
        } else if (typeof clearTimeout === "function") {
          clearTimeout(idleRef.current);
        }
      }
      const schedule = () => {
        highlightRequester({
          blockId,
          startLine: startIndex,
          endLine: endIndex,
          priority: "prefetch",
          reason: "buffer",
        });
        idleRef.current = null;
      };
      if (typeof idleCallback === "function") {
        idleRef.current = idleCallback(() => schedule());
      } else if (typeof setTimeout === "function") {
        idleRef.current = setTimeout(schedule, 80) as unknown as number;
      }
    }
  }, [
    blockId,
    highlightRequester,
    lazyEnabled,
    lazyTokenizedUntil,
    shouldVirtualize,
    virtualization.window.visibleStart,
    virtualization.window.visibleEnd,
    virtualization.window.startIndex,
    virtualization.window.endIndex,
  ]);

  React.useEffect(() => {
    if (shouldVirtualize || !blockIsFinalized || !lazyEnabled || !highlightRequester) return;
    if (totalLazyLineCount <= 0 || lazyTokenizedUntil >= totalLazyLineCount) return;
    const nextRange = {
      visibleStart: 0,
      visibleEnd: totalLazyLineCount,
      prefetchStart: 0,
      prefetchEnd: totalLazyLineCount,
      tokenizedUntil: lazyTokenizedUntil,
    };
    const last = lastRangeRef.current;
    if (
      last &&
      last.visibleStart === nextRange.visibleStart &&
      last.visibleEnd === nextRange.visibleEnd &&
      last.prefetchStart === nextRange.prefetchStart &&
      last.prefetchEnd === nextRange.prefetchEnd &&
      last.tokenizedUntil === nextRange.tokenizedUntil
    ) {
      return;
    }
    lastRangeRef.current = nextRange;
    if (rafRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafRef.current);
    }
    const requestFullHighlight = () => {
      highlightRequester({
        blockId,
        startLine: 0,
        endLine: totalLazyLineCount,
        priority: "visible",
        reason: "finalize-full",
      });
      rafRef.current = null;
    };
    if (typeof requestAnimationFrame === "function") {
      rafRef.current = requestAnimationFrame(requestFullHighlight);
    } else {
      requestFullHighlight();
    }
  }, [blockId, blockIsFinalized, highlightRequester, lazyEnabled, lazyTokenizedUntil, shouldVirtualize, totalLazyLineCount]);

  // Render virtualized or non-virtualized code
  const highlightedHtml = React.useMemo(() => {
    const blockHtml = node.block?.payload.highlightedHtml ?? "";
    const raw = typeof node.block?.payload.raw === "string" ? node.block.payload.raw : "";
    const metaCode =
      typeof (node.block?.payload.meta as Record<string, unknown> | undefined)?.code === "string"
        ? ((node.block?.payload.meta as Record<string, unknown>).code as string)
        : null;
    const sourceText = resolveCodeSourceText(raw, metaCode);
    const sourceEndsWithNewline = sourceText.endsWith("\n");
    const sourceLines = sourceText.length > 0 ? sourceText.split("\n") : [];
    const rawFallbackLines = buildCodeFallbackLines(raw);
    const deterministicWrapperAttrs = getDefaultCodeWrapperAttributes(lang);
    const composedPreAttrs = deterministicWrapperAttrs.preAttrs;
    const composedCodeAttrs = deterministicWrapperAttrs.codeAttrs;
    const shouldAppendTerminalNewline = (
      renderedLines: ReadonlyArray<{ index: number; text: string; html?: string | null; id?: string }>,
    ) => {
      if (!sourceEndsWithNewline || renderedLines.length === 0 || lines.length === 0) {
        return false;
      }
      const lastRendered = renderedLines[renderedLines.length - 1];
      const lastKnown = lines[lines.length - 1];
      if (!lastRendered || !lastKnown || lastRendered.index !== lastKnown.index || lastRendered.text === "") {
        return false;
      }

      // Only synthesize the missing terminal newline when the rendered line
      // frontier is aligned with the parent source frontier. During streaming,
      // code-line children can briefly advance ahead of the parent block raw/meta
      // state; trusting the stale parent newline in that window breaks prefix
      // monotonicity by inserting a premature trailing newline.
      const expectedRenderedLineCount = Math.max(0, sourceLines.length - 1);
      const expectedLastRenderedLine = sourceLines.length >= 2 ? sourceLines[sourceLines.length - 2] ?? "" : "";
      return renderedLines.length === expectedRenderedLineCount && lastRendered.text === expectedLastRenderedLine;
    };

    // Always prefer composing from line children if they exist.
    // This keeps streaming and finalized projections on the same code path.
    if (lines.length > 0) {
      const hasLineHtml = lines.some((line) => typeof line.html === "string" && line.html.length > 0);
      if (!hasLineHtml && blockHtml) {
        // If line HTML is missing (e.g. static render with finalized blocks),
        // fall back to the finalized block HTML to preserve deterministic syntax styling.
        return blockHtml;
      }
      if (shouldVirtualize) {
        // Only compose visible lines for virtualized code
        return composeHighlightedHtml(
          virtualization.window.visibleLines,
          composedPreAttrs,
          composedCodeAttrs,
          shouldAppendTerminalNewline(virtualization.window.visibleLines),
        );
      }
      return composeHighlightedHtml(lines, composedPreAttrs, composedCodeAttrs, shouldAppendTerminalNewline(lines));
    }
    if (!shouldVirtualize && blockHtml) {
      const hasHighlightedLines = blockHtml.includes('class="line"');
      if (!hasHighlightedLines && rawFallbackLines.length > 0) {
        return composeHighlightedHtml(
          rawFallbackLines,
          composedPreAttrs,
          composedCodeAttrs,
          sourceEndsWithNewline && rawFallbackLines[rawFallbackLines.length - 1]?.text !== "",
        );
      }
      return blockHtml;
    }
    // Fallback to block's highlightedHtml only if no line children exist yet
    // This handles the initial state before appendLines patches arrive
    if (blockHtml?.trim().match(/^```[\w-]*\s*$/)) {
      if (rawFallbackLines.length > 0) {
        // Return minimal HTML structure with raw text until lines are available.
        return composeHighlightedHtml(
          rawFallbackLines,
          composedPreAttrs,
          composedCodeAttrs,
          sourceEndsWithNewline && rawFallbackLines[rawFallbackLines.length - 1]?.text !== "",
        );
      }
    }
    if (!blockHtml && rawFallbackLines.length > 0) {
      return composeHighlightedHtml(
        rawFallbackLines,
        composedPreAttrs,
        composedCodeAttrs,
        sourceEndsWithNewline && rawFallbackLines[rawFallbackLines.length - 1]?.text !== "",
      );
    }
    return blockHtml;
  }, [blockIsFinalized, shouldVirtualize, node.block?.payload.highlightedHtml, node.block?.payload.meta, lines, lang, virtualization.window.visibleLines, node.block?.payload.raw]);

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

  const effectiveLineCount = React.useMemo(() => {
    if (lines.length > 0) {
      return lines.length;
    }
    // Preserve a stable metadata contract during early streaming checkpoints:
    // once a code block shell exists, report one line until concrete line nodes arrive.
    return 1;
  }, [lines.length]);

  const codeFrameClass = "not-prose flex flex-col rounded-lg border border-input pt-1 font-mono text-sm";
  const codeMetricsAttrs = {
    "data-code-block": "true",
    "data-block-id": blockId,
    "data-code-virtualized": shouldVirtualize ? "true" : "false",
    "data-code-total-lines": String(effectiveLineCount),
    "data-code-mounted-lines": String(shouldVirtualize ? virtualization.window.mountedLines : effectiveLineCount),
    "data-code-window-size": String(virtualization.config.windowSize),
  };

  const codeView = shouldVirtualize ? (
    (() => {
      const { containerRef, window, handleScroll, lineHeight } = virtualization;
      const spacerTop = window.startIndex * lineHeight;
      const spacerBottom = (window.totalLines - window.endIndex) * lineHeight;
      return (
        <pre className={codeFrameClass} {...codeMetricsAttrs}>
          <div
            ref={containerRef}
            className="markdown-code-block-container relative"
            style={{ overflowY: "auto", overflowX: "hidden", maxHeight: "600px" }}
            onScroll={handleScroll}
          >
            <div style={{ height: spacerTop }} aria-hidden="true" />
            {rendered}
            <div style={{ height: spacerBottom }} aria-hidden="true" />
          </div>
        </pre>
      );
    })()
  ) : (
    <pre className={codeFrameClass} {...codeMetricsAttrs}>
      {rendered}
    </pre>
  );

  const blockComponentMap = registry.getBlockComponentMap() as Record<string, unknown>;
  const MermaidComponent = Object.prototype.hasOwnProperty.call(blockComponentMap, "mermaid") ? (blockComponentMap as any).mermaid : null;
  if ((lang ?? "").toLowerCase() === "mermaid" && MermaidComponent) {
    const raw = typeof node.block.payload.raw === "string" ? node.block.payload.raw : "";
    const fenced = stripCodeFence(raw);
    const code = fenced.hadFence ? fenced.code : raw;
    if (deferredConfig) {
      return (
        <div ref={deferredRef}>
          {shouldRenderDeferred
            ? React.createElement(MermaidComponent as React.ComponentType<any>, {
                code,
                renderCode: codeView,
                meta: node.block.payload.meta,
                isFinalized: node.block.isFinalized,
              })
            : codeView}
        </div>
      );
    }
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
  appendTerminalNewline = false,
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
  return `<pre${preAttr}><code${codeAttr}>${lineMarkup}${appendTerminalNewline ? "\n" : ""}</code></pre>`;
}

function resolveCodeSourceText(raw: string, metaCode: string | null): string {
  if (metaCode !== null) {
    return metaCode.replace(/\r\n?/g, "\n");
  }
  if (!raw) return "";
  const normalized = raw.replace(/\r\n?/g, "\n");
  const fenced = stripCodeFence(normalized);
  return fenced.hadFence ? fenced.code : normalized;
}

function attrsToString(attrs?: Record<string, string>): string {
  if (!attrs) return "";
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join("");
}

function buildCodeFallbackLines(raw: string): Array<{ index: number; text: string; html: null; id: string }> {
  const normalized = normalizeCodeFallbackRaw(raw);
  if (normalized.length === 0) {
    // When only an opening fence is available (e.g. "```lang\\n"), keep one
    // placeholder line so incremental snapshots do not render an empty code shell.
    if (/^\s*```[^\n]*\n?\s*$/.test(raw)) {
      return [{ id: "temp-0", index: 0, text: "", html: null }];
    }
    return [];
  }
  return normalized.split("\n").map((line, index) => ({
    id: `temp-${index}`,
    index,
    text: line,
    html: null,
  }));
}

function normalizeCodeFallbackRaw(raw: string): string {
  if (!raw) return "";
  let normalized = raw.replace(/\r\n?/g, "\n");
  normalized = normalized.replace(/^```[^\n]*\n?/, "");
  normalized = normalized.replace(/\n?```[\t ]*$/, "");
  normalized = normalized.replace(/\n+$/, "");
  return normalized;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;");
}
