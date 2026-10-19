import { normalizeBlockquoteText, type Block, type HtmlTreeNode, type InlineNode, type MixedContentSegment, type TrustedMdxFlowChildSpan, type UrlTransform } from "@stream-mdx/core";
import React from "react";
import type { InlineComponents, TableElements } from "../types";
import {
  TableControlsBar,
  copyToClipboard,
  downloadFile,
  inlineToPlainText,
  renderInlineNodes,
  renderParagraphMixedSegments,
  resolveTableControls,
  tableToCsv,
  tableToMarkdown,
  tableToTsv,
} from "../components";
import type { ComponentRegistry } from "../components";
import { DEFAULT_INLINE_HTML_RENDERERS, renderInlineHtmlSegment } from "../utils/inline-html";
import { renderOwnedHtmlTree } from "../components/owned-html";
import { RenderConfigVersionContext, useRendererChildren, useRendererNode } from "./hooks";
import { createRendererStore, isListPatchDebugEnabled, type RendererStore } from "./store";
import { useVirtualizedTable, type TableVirtualizationProps } from "./virtualized-table";
import { StreamingActivityContext } from "./streaming-activity-context";
import { CodeBlockView } from "./code-block-view";
import { TrustedMdxProjectionContext } from "../trusted-mdx-boundary";
import { renderTrustedMdxInlineChild, TrustedMdxInlineBlockView } from "./trusted-mdx-inline-child";
import {
  assertTrustedMdxNativeChildContinuations,
  type TrustedMdxDocumentSnapshot,
  type TrustedMdxNativeChildOwner,
} from "../trusted-mdx-contract";

import { renderTrustedMdxOwner } from "../trusted-mdx/native-inline";
import { getActiveTrustedMdxNativeTree } from "../trusted-mdx/projection";

function hasTrustedMdxInline(nodes: readonly InlineNode[]): boolean {
  return nodes.some((node) =>
    node.kind === "trusted-mdx-inline" ||
    ("children" in node && Array.isArray(node.children) && hasTrustedMdxInline(node.children)),
  );
}

type TrustedMdxFlowNode = Extract<InlineNode, { readonly kind: "trusted-mdx-inline" }>;
type TrustedMdxParagraphSegment =
  | { readonly kind: "flow"; readonly node: TrustedMdxFlowNode }
  | { readonly kind: "paragraph"; readonly nodes: InlineNode[] };

function hasFlowPlacement(ownerId: string, snapshot: TrustedMdxDocumentSnapshot): boolean {
  const projection = snapshot.projections[ownerId];
  return (
    projection?.kind === "render" ||
    projection?.kind === "server-content" ||
    projection?.kind === "unmapped"
  ) && projection.placement === "flow";
}

function hasTrustedFlowNodes(
  nodes: readonly InlineNode[],
  snapshot: TrustedMdxDocumentSnapshot,
): boolean {
  for (const node of nodes) {
    if (node.kind === "trusted-mdx-inline" && hasFlowPlacement(node.ownerId, snapshot)) return true;
    if ("children" in node && Array.isArray(node.children) && hasTrustedFlowNodes(node.children, snapshot)) return true;
  }
  return false;
}

function splitTrustedFlowNode(
  node: InlineNode,
  snapshot: TrustedMdxDocumentSnapshot,
): TrustedMdxParagraphSegment[] | null {
  if (node.kind === "trusted-mdx-inline" && hasFlowPlacement(node.ownerId, snapshot)) {
    return [{ kind: "flow", node }];
  }
  if (!("children" in node) || !Array.isArray(node.children) || !hasTrustedFlowNodes(node.children, snapshot)) return null;
  const children = splitTrustedFlowNodes(node.children, snapshot);
  if (!children) return null;
  return children.map((segment) =>
    segment.kind === "flow"
      ? segment
      : { kind: "paragraph", nodes: [{ ...node, children: [...segment.nodes] } as InlineNode] },
  );
}

function splitTrustedFlowNodes(
  nodes: readonly InlineNode[],
  snapshot: TrustedMdxDocumentSnapshot,
): TrustedMdxParagraphSegment[] | null {
  if (!hasTrustedFlowNodes(nodes, snapshot)) return null;
  const segments: TrustedMdxParagraphSegment[] = [];
  let paragraph: InlineNode[] = [];
  let foundFlow = false;
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    segments.push({ kind: "paragraph", nodes: paragraph });
    paragraph = [];
  };

  for (const node of nodes) {
    const split = splitTrustedFlowNode(node, snapshot);
    if (!split) {
      paragraph.push(node);
      continue;
    }
    foundFlow = true;
    flushParagraph();
    segments.push(...split);
  }

  flushParagraph();
  return foundFlow ? segments : null;
}

export const BlockNodeRenderer: React.FC<{
  store: RendererStore;
  blockId: string;
  registry: ComponentRegistry;
  nativeFlowChild?: boolean;
  parentTagName?: string;
}> = ({ store, blockId, registry, nativeFlowChild = false, parentTagName }) => {
  const node = useRendererNode(store, blockId);
  const trustedSnapshot = React.useContext(TrustedMdxProjectionContext);
  const block = node?.block;
  if (!node) return null;
  if (!block) {
    const parentTagName = node.type.startsWith("list-item-") ? "li" : node.type.startsWith("blockquote-") ? "blockquote" : "p";
    return <MixedSegmentView store={store} nodeId={blockId} inlineComponents={registry.getInlineComponents()} urlTransform={registry.getUrlTransform()} registry={registry} parentTagName={parentTagName} />;
  }

  const projection = trustedSnapshot?.projections[block.id];
  if (projection?.kind === "module") return null;
  if (!nativeFlowChild && projection?.nativeFlowParent === true) return null;
  if (
    block.type !== "mdx" &&
    (projection?.kind === "render" || projection?.kind === "server-content") &&
    projection.wholeBlockFlowRoot === true
  ) {
    return <MdxBlockView store={store} blockId={block.id} registry={registry} />;
  }

  // The native quote view still invokes the registered wrapper, but supplies its prepared children.
  const preparedQuote = block.type === "blockquote" && Boolean(block.payload.meta?.preparedNested);
  const hasPreparedMdxInline = block.type === "paragraph" && hasTrustedMdxInline(block.payload.inline ?? []);
  const mixedParagraph = block.type === "paragraph" && Array.isArray(block.payload.meta?.mixedSegments) && !hasPreparedMdxInline;
  if ((registry.hasCustomBlockComponent(block.type) || mixedParagraph) && !preparedQuote) {
    return <>{registry.renderFinalizedBlock(block, registry.renderBlock(block))}</>;
  }

  let element: React.ReactElement | null;
  switch (block.type) {
    case "paragraph":
      element = <ParagraphBlockView store={store} blockId={block.id} registry={registry} />;
      break;
    case "blockquote":
      element = <BlockquoteBlockView store={store} blockId={block.id} registry={registry} />;
      break;
    case "list":
      element = <ListBlockView store={store} blockId={block.id} registry={registry} depth={0} />;
      break;
    case "table":
      element = <TableBlockView store={store} blockId={block.id} registry={registry} />;
      break;
    case "code":
      element = <CodeBlockView store={store} blockId={block.id} registry={registry} />;
      break;
    case "html":
      element = <HtmlBlockView store={store} blockId={block.id} registry={registry} parentTagName={parentTagName} />;
      break;
    case "mdx":
      element = <MdxBlockView store={store} blockId={block.id} registry={registry} />;
      break;
    default:
      element = registry.renderBlock(block);
      break;
  }

  if (element === null) return null;
  return <>{registry.renderFinalizedBlock(block, element)}</>;
};

const ParagraphBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const trustedSnapshot = React.useContext(TrustedMdxProjectionContext);
  const node = useRendererNode(store, blockId);
  const block = node?.block;
  const childIds = useRendererChildren(store, blockId);
  if (!node || !block) {
    return null;
  }

  const includesTrustedMdx = hasTrustedMdxInline(block.payload.inline ?? []);
  const inlineComponents = registry.getInlineComponents();
  const htmlElements = registry.getHtmlElements();
  const literalTagContent = registry.getLiteralTagContent();
  const meta = block.payload.meta;
  const sourceOwnedHtmlTree = meta?.htmlOwnership === true && Array.isArray(meta.htmlTree) ? meta.htmlTree : undefined;
  if (sourceOwnedHtmlTree) {
    return <>{registry.renderHtmlTree(sourceOwnedHtmlTree, undefined, block)}</>;
  }
  if (meta?.htmlParagraphTree) {
    return <>{registry.renderHtmlTree(meta.htmlParagraphTree, undefined, block)}</>;
  }

  if (block.isFinalized && trustedSnapshot) {
    const flowSegments = splitTrustedFlowNodes(block.payload.inline ?? [], trustedSnapshot);
    if (flowSegments) {
      const ParagraphComponent = registry.getBlockComponent("paragraph");
      return (
        <>
          {flowSegments.map((segment, index) => {
            const key = `${block.id}:trusted-flow:${index}`;
            if (segment.kind === "flow") {
              const flowProjection = trustedSnapshot.projections[segment.node.ownerId];
              const nativeChildren =
                flowProjection !== undefined &&
                (flowProjection.kind === "render" || flowProjection.kind === "server-content") &&
                flowProjection.nativeChildren === true
                  ? renderTrustedMdxNativeChildren(block, flowProjection.rootElementName, registry, store, flowProjection.nativeChildOwners, flowProjection.flowChildren)
                  : undefined;
              return (
                <React.Fragment key={key}>
                  {renderTrustedMdxOwner(segment.node.ownerId, trustedSnapshot, segment.node.raw, true, nativeChildren)}
                </React.Fragment>
              );
            }
            const children = renderInlineNodes(
              segment.nodes,
              inlineComponents,
              registry.getUrlTransform(),
              registry,
              "p",
              registry.getRenderInlineContext(block.isFinalized, key),
            );
            const paragraph = React.createElement(ParagraphComponent, {
              key,
              inlines: segment.nodes,
              raw: block.payload.raw,
              meta: block.payload.meta,
              children,
            });
            if (!registry.hasElementFilters()) return paragraph;
            return registry.filterElement(
              { tagName: "p", properties: { className: "markdown-paragraph" }, blockType: "paragraph" },
              { source: "markdown" },
              () => paragraph,
              () => children,
            );
          })}
        </>
      );
    }
  }

  if (!block.isFinalized) {
    const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
    const meta = (block.payload.meta ?? {}) as { inlineStatus?: string; mixedSegments?: MixedContentSegment[] };
    const segments = Array.isArray(meta.mixedSegments) ? meta.mixedSegments : [];
    // Preserve the existing behavior for MDX/HTML-mixed paragraphs while streaming.
    if (segments.length > 0 && !includesTrustedMdx) {
      const allowMixedStreaming = Boolean((meta as { allowMixedStreaming?: boolean }).allowMixedStreaming);
      if (!allowMixedStreaming) {
        return <p className="markdown-paragraph streaming-partial">{raw}</p>;
      }
      const structured = renderParagraphMixedSegments(segments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS, htmlElements, literalTagContent, registry.getUrlTransform());
      if (structured.length === 1) {
        const [single] = structured;
        return React.isValidElement(single) ? single : single;
      }
      return structured;
    }

    if (meta.inlineStatus === "complete" || meta.inlineStatus === "anticipated" || registry.getAnimatedOptions()) {
      const inlineNodes = Array.isArray(block.payload.inline) && block.payload.inline.length > 0 ? block.payload.inline : (raw ? [{ kind: "text" as const, text: raw }] : []);
      const containsDisplayMath = inlineNodes.some((node) => node.kind === "math-display");
      if (containsDisplayMath) {
        const derivedSegments: MixedContentSegment[] = [
          {
            kind: "text",
            value: raw,
            inline: inlineNodes,
          },
        ];
        const structured = renderParagraphMixedSegments(derivedSegments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS, htmlElements, literalTagContent, registry.getUrlTransform());
        if (structured.length === 1) {
          const [single] = structured;
          return React.isValidElement(single) ? single : single;
        }
        return structured;
      }

      const partialInline = renderInlineNodes(inlineNodes, inlineComponents, registry.getUrlTransform(), registry, "p", registry.getRenderInlineContext(block.isFinalized, block.id));
      if (!registry.hasElementFilters()) {
        return <p className="markdown-paragraph streaming-partial">{partialInline}</p>;
      }
      return registry.filterElement(
        { tagName: "p", properties: { className: "markdown-paragraph streaming-partial" }, blockType: "paragraph" },
        { source: "markdown" },
        () => <p className="markdown-paragraph streaming-partial">{partialInline}</p>,
        () => partialInline,
      ) as React.ReactElement | null;
    }

    if (!registry.hasElementFilters()) {
      return <p className="markdown-paragraph streaming-partial">{raw}</p>;
    }
    return registry.filterElement(
      { tagName: "p", properties: { className: "markdown-paragraph streaming-partial" }, blockType: "paragraph" },
      { source: "markdown" },
      () => <p className="markdown-paragraph streaming-partial">{raw}</p>,
      () => raw,
    ) as React.ReactElement | null;
  }

  const propsBlock = node.props?.block as Block | undefined;
  const inlineStatus =
    (propsBlock?.payload?.meta as { inlineStatus?: string } | undefined)?.inlineStatus ??
    (block.payload.meta as { inlineStatus?: string } | undefined)?.inlineStatus ??
    (node.props?.inlineStatus as string | undefined);
  if (inlineStatus && inlineStatus !== "complete") {
    const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
    if (!registry.hasElementFilters()) {
      return <p className="markdown-paragraph">{raw}</p>;
    }
    return registry.filterElement(
      { tagName: "p", properties: { className: "markdown-paragraph" }, blockType: "paragraph" },
      { source: "markdown" },
      () => <p className="markdown-paragraph">{raw}</p>,
      () => raw,
    ) as React.ReactElement | null;
  }

  const segments = Array.isArray((block.payload.meta as { mixedSegments?: MixedContentSegment[] } | undefined)?.mixedSegments)
    ? ((block.payload.meta as { mixedSegments?: MixedContentSegment[] }).mixedSegments as MixedContentSegment[])
    : undefined;

  if (segments && segments.length > 0 && !includesTrustedMdx) {
    const structured = renderParagraphMixedSegments(segments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS, htmlElements, literalTagContent);
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
    const structured = renderParagraphMixedSegments(derivedSegments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS, htmlElements, literalTagContent, registry.getUrlTransform());
    if (structured.length === 1) {
      const [single] = structured;
      return React.isValidElement(single) ? single : single;
    }
    return structured;
  }

  const inlines = renderInlineNodes(block.payload.inline ?? [], inlineComponents, registry.getUrlTransform(), registry, "p");
  const ParagraphComponent = registry.getBlockComponent("paragraph");
  const baseElement = React.createElement(ParagraphComponent, {
    inlines: block.payload.inline ?? [],
    raw: block.payload.raw,
    meta: block.payload.meta,
    children: inlines,
  });

  const renderParagraph = () => {
    if (childIds.length > 0) {
      const renderedChildren = childIds.map((childId) => <MixedSegmentView key={childId} store={store} nodeId={childId} inlineComponents={inlineComponents} urlTransform={registry.getUrlTransform()} registry={registry} parentTagName="p" />);
      if (React.isValidElement(baseElement)) {
        const { children: _ignored, className = "markdown-paragraph", inlines: _inlines, raw: _raw, meta: _meta, ...rest } = (baseElement.props as Record<string, unknown>) ?? {};
        return React.createElement("p", { ...rest, className }, renderedChildren);
      }
      return <p className="markdown-paragraph">{renderedChildren}</p>;
    }
    if (React.isValidElement(baseElement)) {
      return baseElement;
    }
    return <p className="markdown-paragraph">{inlines}</p>;
  };
  if (!registry.hasElementFilters()) {
    return renderParagraph();
  }
  const renderChildren = () => {
    if (childIds.length > 0) {
      return childIds.map((childId) => <MixedSegmentView key={childId} store={store} nodeId={childId} inlineComponents={inlineComponents} urlTransform={registry.getUrlTransform()} registry={registry} parentTagName="p" />);
    }
    return inlines;
  };
  const filtered = registry.filterElement(
    { tagName: "p", properties: { className: "markdown-paragraph" }, blockType: "paragraph" },
    { source: "markdown" },
    renderParagraph,
    renderChildren,
  );
  if (filtered === null || filtered === undefined) return null;
  return React.isValidElement(filtered) ? filtered : <>{filtered}</>;
});

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
    typeof meta.normalizedText === "string"
      ? meta.normalizedText
    : normalizeBlockquoteText(typeof block.payload.raw === "string" ? block.payload.raw : "");
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
      return renderInlineNodes(inline, inlineComponents, registry.getUrlTransform(), registry, "div", registry.getRenderInlineContext(block.isFinalized, `${block.id}:${keyPrefix}`));
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
            urlTransform: registry.getUrlTransform(),
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
            <span key={`blockquote-mdx-${block.id}-${segmentIndex}`}>
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
  const inlineElements = inlineNodes.length > 0 ? renderInlineNodes(inlineNodes, inlineComponents, registry.getUrlTransform(), registry, "blockquote", registry.getRenderInlineContext(block.isFinalized, block.id)) : null;

  const childContent = childIds.map((childId) => {
    const childNode = store.getNode(childId);
    if (!childNode) return null;
    if (childNode.type?.startsWith("blockquote-")) {
      return <MixedSegmentView key={childId} store={store} nodeId={childId} inlineComponents={inlineComponents} urlTransform={registry.getUrlTransform()} registry={registry} parentTagName="blockquote" />;
    }
    if (childNode.type === "list") {
      return <ListBlockView key={childId} store={store} blockId={childId} registry={registry} depth={0} />;
    }
    return <BlockNodeRenderer key={childId} store={store} blockId={childId} registry={registry} parentTagName="blockquote" />;
  });

  if (block.payload.meta?.preparedNested && childIds.length === 0) {
    const emptyQuote = registry.hasCustomBlockComponent("blockquote")
      ? React.createElement(registry.getBlockComponent("blockquote"), { inlines: block.payload.inline ?? [], renderedContent: null })
      : <blockquote className="markdown-blockquote" />;
    if (!registry.hasElementFilters()) {
      return emptyQuote;
    }
    return registry.filterElement(
      { tagName: "blockquote", properties: { className: "markdown-blockquote" }, blockType: "blockquote" },
      { source: "markdown" },
      () => emptyQuote,
      () => null,
    ) as React.ReactElement | null;
  }
  if (!block.isFinalized) {
    const streamingContent = childIds.length
      ? childContent.filter((c) => c !== null)
      : mixedSegmentElements.length
        ? mixedSegmentElements
        : inlineElements
          ? inlineElements
          : fallbackElements;
    const shouldShowStreaming = !block.isFinalized && (!streamingContent || (Array.isArray(streamingContent) && streamingContent.length === 0));
    const className = shouldShowStreaming ? "markdown-blockquote streaming-partial" : "markdown-blockquote";
    const streamingQuote = registry.hasCustomBlockComponent("blockquote")
      ? React.createElement(registry.getBlockComponent("blockquote"), { inlines: block.payload.inline ?? [], renderedContent: streamingContent }, streamingContent)
      : <blockquote className={className}>{streamingContent}</blockquote>;
    if (!registry.hasElementFilters()) {
      return streamingQuote;
    }
    return registry.filterElement(
      { tagName: "blockquote", properties: { className }, blockType: "blockquote" },
      { source: "markdown" },
      () => streamingQuote,
      () => streamingContent,
    ) as React.ReactElement | null;
  }
  const renderedContent = (() => {
    if (childIds.length > 0) {
      const resolved = childContent.filter((child) => child !== null);
      if (resolved.length > 0) {
        return resolved;
      }
    }
    if (mixedSegmentElements.length > 0) {
      return mixedSegmentElements;
    }
    if (normalizedText.trim().length === 0) {
      return null;
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

  const base = React.isValidElement(baseElement) ? baseElement : <blockquote className="markdown-blockquote">{renderedContent}</blockquote>;
  if (!registry.hasElementFilters()) {
    return base;
  }
  const filtered = registry.filterElement(
    { tagName: "blockquote", properties: { className: "markdown-blockquote" }, blockType: "blockquote" },
    { source: "markdown" },
    () => base,
    () => renderedContent,
  );
  if (filtered === null || filtered === undefined) return null;
  return React.isValidElement(filtered) ? filtered : <>{filtered}</>;
});

BlockquoteBlockView.displayName = "BlockquoteBlockView";

const MixedSegmentView: React.FC<{
  store: RendererStore;
  nodeId: string;
  inlineComponents: InlineComponents;
  urlTransform?: UrlTransform;
  registry?: ComponentRegistry;
  parentTagName?: string;
}> = React.memo(({ store, nodeId, inlineComponents, urlTransform, registry, parentTagName }) => {
  const trustedSnapshot = React.useContext(TrustedMdxProjectionContext);
  const node = useRendererNode(store, nodeId);
  if (!node) return null;

  switch (node.type) {
    case "paragraph-text":
    case "blockquote-text":
    case "list-item-text": {
      const inline = (node.props?.inline as InlineNode[] | undefined) ?? [];
      if (inline.length > 0) {
        return renderInlineNodes(inline, inlineComponents, urlTransform, registry, parentTagName);
      }
      const text = typeof node.props?.text === "string" ? (node.props?.text as string) : "";
      if (!text) return null;
      return text;
    }
    case "paragraph-html":
    case "blockquote-html":
    case "list-item-html": {
      const htmlTree = node.props?.htmlTree as HtmlTreeNode[] | undefined;
      if (registry && htmlTree !== undefined) {
        return <>{renderOwnedHtmlTree(htmlTree, {
          elements: registry.getHtmlElements(),
          renderBlock: (block) => registry.renderBlock(block),
          renderInline: (nodes, parentTagName) => renderInlineNodes(nodes, inlineComponents, urlTransform, registry, parentTagName),
          inlineComponents,
          urlTransform,
          isAutolinkProtocolDisabled: (href) => registry.isAutolinkProtocolDisabled(href),
          filterElement: registry.hasElementFilters()
            ? (element, context, renderElement, renderChildren) => registry.filterElement(element, context, renderElement, renderChildren)
            : undefined,
          parentTagName,
          contentComponents: registry.getContentComponents(),
        })}</>;
      }
      const raw = typeof node.props?.raw === "string" ? (node.props.raw as string) : undefined;
      const html = typeof node.props?.html === "string" ? (node.props?.html as string) : "";
      const rendered = renderInlineHtmlSegment(raw, html, {
        key: node.id,
        renderers: DEFAULT_INLINE_HTML_RENDERERS,
        urlTransform,
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
      const raw = typeof node.props?.raw === "string" ? node.props.raw : "";
      if (trustedSnapshot) {
        return renderTrustedMdxOwner(node.id, trustedSnapshot, raw, true);
      }
      return <span className="markdown-mdx-inline">{raw}</span>;
    }
    default:
      return null;
  }
});

MixedSegmentView.displayName = "MixedSegmentView";

const HtmlBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry; parentTagName?: string }> = React.memo(({ store, blockId, registry, parentTagName }) => {
  const node = useRendererNode(store, blockId);
  if (!node || !node.block) return null;
  const tree = node.block.payload.meta?.htmlTree as HtmlTreeNode[] | undefined;
  if (tree) {
    return <>{registry.renderHtmlTree(
      tree,
      (block, blockParentTagName) => (
        <OwnedHtmlBlock key={block.id} block={block} registry={registry} parentTagName={blockParentTagName} />
      ),
      undefined,
      parentTagName,
    )}</>;
  }
  return registry.renderBlock(node.block);
});

HtmlBlockView.displayName = "HtmlBlockView";

const OwnedHtmlBlock: React.FC<{
  block: Block;
  registry: ComponentRegistry;
  nativeFlowChild?: boolean;
  parentTagName?: string;
}> = ({ block, registry, nativeFlowChild = false, parentTagName }) => {
  const store = React.useMemo(() => createRendererStore([block]), [block]);
  return <BlockNodeRenderer store={store} blockId={block.id} registry={registry} nativeFlowChild={nativeFlowChild} parentTagName={parentTagName} />;
};

function findPreparedTreeBlock(
  tree: readonly HtmlTreeNode[] | undefined,
  blockId: string,
): Block | undefined {
  if (!tree) return undefined;
  const pending: HtmlTreeNode[] = [...tree];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.kind === "block") {
      if (node.block.id === blockId) return node.block;
    } else if (node.kind === "element" || node.kind === "component") {
      pending.push(...node.children);
    }
  }
  return undefined;
}

function renderTrustedMdxNativeChildren(
  block: Block,
  rootElementName: string | null | undefined,
  registry: ComponentRegistry,
  store: RendererStore,
  childOwners?: readonly TrustedMdxNativeChildOwner[],
  flowChildren?: readonly TrustedMdxFlowChildSpan[],
): React.ReactNode | undefined {
  if (rootElementName === undefined) return undefined;
  if (!childOwners || !flowChildren || childOwners.length !== flowChildren.length) {
    throw new Error(`Trusted MDX flow owner "${block.id}" has misaligned compiler child spans and native owners.`);
  }
  assertTrustedMdxNativeChildContinuations(childOwners, flowChildren);
  const preparedTree = getActiveTrustedMdxNativeTree(block.payload.meta);
  return childOwners.map((owner, index) => {
    if (owner === null) return undefined;
    if (owner.kind === "continuation") {
      return undefined;
    }
    if (owner.kind === "block") {
      if (flowChildren[index]?.kind === "inline") {
        return (
          <TrustedMdxInlineBlockView
            key={`${owner.blockId}:${index}`}
            store={store}
            blockId={owner.blockId}
            registry={registry}
            parentTagName={rootElementName ?? undefined}
          />
        );
      }
      return (
        <BlockNodeRenderer
          key={`${owner.blockId}:${index}`}
          store={store}
          blockId={owner.blockId}
          registry={registry}
          nativeFlowChild
          parentTagName={rootElementName ?? undefined}
        />
      );
    }
    const child = findPreparedTreeBlock(preparedTree, owner.blockId);
    if (!child) {
      throw new Error(`Trusted MDX flow owner "${block.id}" has no prepared tree block "${owner.blockId}".`);
    }
    if (flowChildren[index]?.kind === "inline") {
      return (
        <React.Fragment key={`${owner.blockId}:${index}`}>
          {renderTrustedMdxInlineChild(child, registry, rootElementName ?? undefined)}
        </React.Fragment>
      );
    }
    return <OwnedHtmlBlock key={`${owner.blockId}:${index}`} block={child} registry={registry} nativeFlowChild parentTagName={rootElementName ?? undefined} />;
  });
}


const MdxBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  const trustedSnapshot = React.useContext(TrustedMdxProjectionContext);
  if (!node || !node.block) return null;
  const projection = trustedSnapshot?.projections[node.id];
  const nativeChildren =
    projection !== undefined &&
    (projection.kind === "render" || projection.kind === "server-content") &&
    projection.nativeChildren === true
      ? renderTrustedMdxNativeChildren(node.block, projection.rootElementName, registry, store, projection.nativeChildOwners, projection.flowChildren)
      : undefined;
  const projected = trustedSnapshot
    ? renderTrustedMdxOwner(node.id, trustedSnapshot, node.block.payload.raw ?? "", false, nativeChildren)
    : undefined;
  if (projected !== undefined) return projected;
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
      const startNum = typeof node?.props?.start === "number" ? node.props.start : 1;
      listItemIds.forEach((childId, index) => {
        const childNode = store.getNode(childId);
        const raw = typeof childNode?.block?.payload?.raw === "string" ? childNode.block.payload.raw : undefined;
        const markerMatch = raw ? raw.match(/^(\d+)[.)]\s+/) : null;
        let digits: number;
        if (markerMatch) {
          digits = markerMatch[1].length;
        } else {
          digits = String(startNum + index).length;
        }
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
    const start = typeof node?.props?.start === "number" ? node.props.start : undefined;
    const renderChildren = () => (
      <>
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
      </>
    );
    const renderElement = () => (
      <Tag
        className={`markdown-list ${ordered ? "ordered" : "unordered"}`}
        data-list-depth={depth}
        data-marker-digits={ordered ? markerDigits : undefined}
        data-list-id={listDebugEnabled ? blockId : undefined}
        style={listStyle}
        start={ordered && start !== undefined && start !== 1 ? start : undefined}
      >
        {renderChildren()}
      </Tag>
    );
    if (!registry.hasElementFilters()) {
      return renderElement();
    }
    const filtered = registry.filterElement(
      { tagName: Tag, properties: { className: `markdown-list ${ordered ? "ordered" : "unordered"}` }, blockType: "list" },
      { source: "markdown" },
      renderElement,
      renderChildren,
    );
    if (filtered === null || filtered === undefined) return null;
    return React.isValidElement(filtered) ? filtered : <>{filtered}</>;
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
  const start = typeof node?.props?.start === "number" ? node.props.start : 1;
  const itemNumber = start + inferredIndex;
  const counterText = !isTask ? (isOrdered ? `${itemNumber}.` : "\u2022") : undefined;
  const listDebugEnabled = isListPatchDebugEnabled();
  const inlineLength = inline.length;
  const animCtx = registry.getRenderInlineContext(Boolean(block?.isFinalized), nodeId);
  // Inline output below is memoized on registry identity; filter/URL changes bump this version instead.
  const renderConfigVersion = React.useContext(RenderConfigVersionContext);
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
    return segmentChildIds.map((childId) => <MixedSegmentView key={childId} store={store} nodeId={childId} inlineComponents={inlineComponents} urlTransform={registry.getUrlTransform()} registry={registry} parentTagName="li" />);
  }, [segmentChildIds, store, inlineComponents, registry]);

  const primaryContent = React.useMemo(() => {
    if (segmentChildIds.length > 0) {
      return segmentElements;
    }
    return renderInlineNodes(inline, inlineComponents, registry.getUrlTransform(), registry, "li", animCtx);
  }, [segmentChildIds, segmentElements, inline, inlineComponents, registry, renderConfigVersion]);

  const trailingChildren = React.useMemo(() => {
    return contentChildIds.map((childId) => {
      const childNode = store.getNode(childId);
      if (!childNode) return null;
      switch (childNode.type) {
        case "paragraph": {
          const childInline = childNode.block?.payload.inline ?? (childNode.props?.inline as InlineNode[] | undefined) ?? [];
          const childAnimCtx = registry.getRenderInlineContext(Boolean(childNode.block?.isFinalized), childId);
          const childInlines = renderInlineNodes(childInline, inlineComponents, registry.getUrlTransform(), registry, "p", childAnimCtx);
          if (childNode.props?.tight) {
            return <React.Fragment key={childId}>{childInlines}</React.Fragment>;
          }
          if (!registry.hasElementFilters()) {
            return (
              <p key={childId} className="markdown-list-item-paragraph">
                {childInlines}
              </p>
            );
          }
          return registry.filterElement(
            { tagName: "p", properties: { className: "markdown-list-item-paragraph" }, blockType: "paragraph" },
            { source: "markdown", parentTagName: "li" },
            () => (
              <p key={childId} className="markdown-list-item-paragraph">
                {childInlines}
              </p>
            ),
            () => childInlines,
          );
        }
        case "list":
          return <ListBlockView key={childId} store={store} blockId={childId} registry={registry} depth={depth + 1} />;
        default:
          return <BlockNodeRenderer key={childId} store={store} blockId={childId} registry={registry} parentTagName="li" />;
      }
    });
  }, [contentChildIds, store, inlineComponents, registry, depth, renderConfigVersion]);

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

  const isLoose = Boolean(node?.props?.loose);
  const hasPrimaryContent = isTask || segmentChildIds.length > 0 || inline.length > 0;
  const renderedPrimary = !hasPrimaryContent ? null : isLoose ? (
    <p className="markdown-paragraph">
      {isTask ? (
        <input type="checkbox" className="markdown-task-checkbox" checked={isChecked} readOnly disabled tabIndex={-1} />
      ) : null}
      {isTask ? " " : null}
      {primaryContent}
    </p>
  ) : (
    <>
      {isTask ? (
        <input type="checkbox" className="markdown-task-checkbox" checked={isChecked} readOnly disabled tabIndex={-1} />
      ) : null}
      {isTask ? " " : null}
      {primaryContent}
    </>
  );

  const renderChildren = () => (
    <>
      {renderedPrimary}
      {hasChildren ? <div className="markdown-list-item-children">{filteredChildren}</div> : null}
    </>
  );
  const renderElement = () => (
    <li
      className={`markdown-list-item${isTask ? " markdown-list-item-task" : ""}`}
      data-counter-text={counterText}
      data-list-depth={depth}
      data-list-item-id={listDebugEnabled ? nodeId : undefined}
    >
      {renderChildren()}
    </li>
  );
  if (!registry.hasElementFilters()) {
    return renderElement();
  }
  const filtered = registry.filterElement(
    { tagName: "li", properties: { className: `markdown-list-item${isTask ? " markdown-list-item-task" : ""}` } },
    { source: "markdown", parentTagName: ordered ? "ol" : "ul" },
    renderElement,
    renderChildren,
  );
  if (filtered === null || filtered === undefined) return null;
  return React.isValidElement(filtered) ? filtered : <>{filtered}</>;
});

ListItemView.displayName = "ListItemView";

const TableBlockView: React.FC<{ store: RendererStore; blockId: string; registry: ComponentRegistry }> = React.memo(({ store, blockId, registry }) => {
  const node = useRendererNode(store, blockId);
  const tableElements = registry.getTableElements();
  const childIds = useRendererChildren(store, blockId);

  const subscribeVirtualization = React.useCallback(
    (listener: () => void) => registry.subscribeTableVirtualization(listener),
    [registry],
  );
  const getVirtualization = React.useCallback(() => registry.getTableVirtualization(), [registry]);
  const virtualizationConfig = React.useSyncExternalStore(subscribeVirtualization, getVirtualization, getVirtualization);
  const virtualizationDisabled =
    typeof process !== "undefined" && typeof process.env === "object" && process.env.STREAM_MDX_DISABLE_VIRTUALIZED_TABLE === "true";

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);

  const tbodyId = React.useMemo(() => {
    for (const childId of childIds) {
      const childNode = store.getNode(childId);
      if (childNode?.type === "table-body") {
        return childId;
      }
    }
    return null;
  }, [childIds, store]);

  const rowIds = useRendererChildren(store, tbodyId ?? "");
  const rowCount = rowIds.length;

  const theadId = React.useMemo(() => {
    for (const childId of childIds) {
      const childNode = store.getNode(childId);
      if (childNode?.type === "table-header") {
        return childId;
      }
    }
    return null;
  }, [childIds, store]);

  const theadCellIds = useRendererChildren(store, theadId ?? "");
  const columnCount = React.useMemo(() => {
    if (theadCellIds.length > 0) return theadCellIds.length;
    if (rowIds.length > 0) {
      const firstRowCells = store.getChildren(rowIds[0]);
      if (firstRowCells.length > 0) return firstRowCells.length;
    }
    return 1;
  }, [theadCellIds.length, rowIds, store]);

  const sessionActive = React.useContext(StreamingActivityContext);
  const isFinalized = Boolean(node?.block?.isFinalized);
  const canVirtualize = mounted && typeof window !== "undefined" && isFinalized && !sessionActive && !virtualizationDisabled;

  const virtualization = useVirtualizedTable(rowIds, virtualizationConfig, canVirtualize);
  const { isEligible, isVirtualized, containerRef, handleScroll, window: virtualWindow, config, naturalLayout, headerBackgroundColor } = virtualization;

  const virtualizationProps: TableVirtualizationProps | undefined = React.useMemo(() => {
    if (!isVirtualized) return undefined;
    return {
      isVirtualized: true,
      startIndex: virtualWindow.startIndex,
      endIndex: virtualWindow.endIndex,
      topSpacerHeight: virtualWindow.topSpacerHeight,
      bottomSpacerHeight: virtualWindow.bottomSpacerHeight,
      columnCount,
      headerBackgroundColor,
    };
  }, [isVirtualized, virtualWindow, columnCount, headerBackgroundColor]);

  const tableAttrs = {
    "data-table-block": "true",
    "data-block-id": blockId,
    "data-table-virtualized": isVirtualized ? "true" : "false",
    "data-table-total-rows": String(rowCount),
    "data-table-mounted-rows": String(isVirtualized ? virtualWindow.mountedRows : rowCount),
    "data-table-start-index": String(isVirtualized ? virtualWindow.startIndex : 0),
    "data-table-end-index": String(isVirtualized ? virtualWindow.endIndex : rowCount),
  };

  const tableElement = (
    <tableElements.Table
      className="markdown-table w-full caption-bottom text-base"
      style={isVirtualized && naturalLayout?.columnWidths.length
        ? { tableLayout: "fixed", width: naturalLayout.tableWidth }
        : undefined}
      {...(!isEligible ? tableAttrs : {})}
    >
      {isVirtualized && naturalLayout?.columnWidths.length ? (
        <colgroup>
          {naturalLayout.columnWidths.map((width, index) => <col key={index} style={{ width }} />)}
        </colgroup>
      ) : null}
      {childIds.map((sectionId) => (
        <TableSectionView
          key={sectionId}
          store={store}
          nodeId={sectionId}
          registry={registry}
          tableElements={tableElements}
          virtualization={virtualizationProps}
        />
      ))}
    </tableElements.Table>
  );

  const resolvedTableControls = resolveTableControls(registry.getControls());
  const ControlsComponent = registry.getControlsComponent();
  const tableMeta = node?.block?.payload?.meta;
  // Cell text is only needed for copy/download; skip the walk on the streaming hot path when controls are off.
  const tableData = React.useMemo(
    () => (resolvedTableControls.enabled ? collectTableText(tableMeta, theadCellIds, rowIds, store) : null),
    [resolvedTableControls.enabled, tableMeta, theadCellIds, rowIds, store],
  );

  const filteredTable = registry.hasElementFilters()
    ? registry.filterElement(
        { tagName: "table", properties: { className: "markdown-table" }, blockType: "table" },
        { source: "markdown" },
        () => tableElement,
        () => (
          <>
            {childIds.map((sectionId) => (
              <TableSectionView
                key={sectionId}
                store={store}
                nodeId={sectionId}
                registry={registry}
                tableElements={tableElements}
                virtualization={virtualizationProps}
              />
            ))}
          </>
        ),
      )
    : tableElement;
  if (filteredTable === null || filteredTable === undefined) return null;

  const renderedContent = isEligible ? (
    <div
      ref={containerRef}
      className="markdown-table-container relative w-full"
      style={{
        overflowY: "auto",
        overflowX: "auto",
        maxHeight: typeof config.maxHeight === "number" ? `${config.maxHeight}px` : config.maxHeight,
        overflowAnchor: "none",
      }}
      onScroll={handleScroll}
      tabIndex={0}
      role="region"
      aria-label="Scrollable table"
      {...tableAttrs}
    >
      {filteredTable}
    </div>
  ) : React.isValidElement(filteredTable) ? (
    filteredTable
  ) : (
    <>{filteredTable}</>
  );

  if (tableData) {
    const tableControlsElement = ControlsComponent ? (
      <ControlsComponent
        type="table"
        blockId={blockId}
        headers={tableData.headers}
        rows={tableData.rows}
        align={tableData.align}
        isFinalized={isFinalized}
        onCopy={(format) => {
          if (!isFinalized) return;
          const text = format === "markdown" ? tableToMarkdown(tableData.headers, tableData.rows, tableData.align) : tableToTsv(tableData.headers, tableData.rows);
          return copyToClipboard(text);
        }}
        onDownload={(format) => {
          if (!isFinalized) return;
          if (format === "tsv") {
            downloadFile(tableToTsv(tableData.headers, tableData.rows), "table.tsv", "text/tab-separated-values;charset=utf-8");
          } else if (format === "markdown") {
            downloadFile(tableToMarkdown(tableData.headers, tableData.rows, tableData.align), "table.md", "text/markdown;charset=utf-8");
          } else {
            downloadFile(tableToCsv(tableData.headers, tableData.rows), "table.csv", "text/csv;charset=utf-8");
          }
        }}
        labels={resolvedTableControls.labels}
      />
    ) : (
      <TableControlsBar
        headers={tableData.headers}
        rows={tableData.rows}
        align={tableData.align}
        isFinalized={isFinalized}
        config={resolvedTableControls}
      />
    );

    return (
      <div className="stream-mdx-table-wrapper relative">
        {tableControlsElement}
        {renderedContent}
      </div>
    );
  }

  return renderedContent;
});

TableBlockView.displayName = "TableBlockView";

type TableText = { headers: string[]; rows: string[][]; align?: Array<"left" | "center" | "right" | null> };

function cellNodeText(store: RendererStore, cellId: string): string {
  const cellProps = store.getNode(cellId)?.props;
  if (cellProps && typeof cellProps === "object") {
    if ("inline" in cellProps && Array.isArray(cellProps.inline)) {
      return inlineToPlainText(cellProps.inline as InlineNode[]);
    }
    if ("text" in cellProps && typeof cellProps.text === "string") {
      return cellProps.text;
    }
  }
  return "";
}

function collectTableText(rawMeta: unknown, theadCellIds: readonly string[], rowIds: readonly string[], store: RendererStore): TableText {
  const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as {
    header?: InlineNode[][];
    rows?: InlineNode[][][];
    align?: Array<"left" | "center" | "right" | null>;
  };
  const headers =
    Array.isArray(meta.header) && meta.header.length > 0
      ? meta.header.map((cell) => inlineToPlainText(cell))
      : theadCellIds.map((cellId) => cellNodeText(store, cellId));
  const rows =
    Array.isArray(meta.rows) && meta.rows.length > 0
      ? meta.rows.map((row) => row.map((cell) => inlineToPlainText(cell)))
      : rowIds.map((rowId) => store.getChildren(rowId).map((cellId) => cellNodeText(store, cellId)));
  return { headers, rows, align: Array.isArray(meta.align) ? meta.align : undefined };
}

const TableSectionView: React.FC<{
  store: RendererStore;
  nodeId: string;
  registry: ComponentRegistry;
  tableElements: TableElements;
  virtualization?: TableVirtualizationProps;
}> = React.memo(({ store, nodeId, registry, tableElements, virtualization }) => {
  const node = useRendererNode(store, nodeId);
  if (!node) return null;
  if (node.type === "table-header") {
    const childIds = useRendererChildren(store, nodeId);
    return (
      <tableElements.Thead
        className={virtualization?.isVirtualized ? "sticky top-0 z-10" : undefined}
        style={virtualization?.isVirtualized ? {
          position: "sticky",
          top: 0,
          zIndex: 10,
          backgroundColor: `var(--stream-mdx-table-header-background, ${virtualization.headerBackgroundColor})`,
        } : undefined}
      >
        <tableElements.Tr>
          {childIds.map((cellId) => (
            <TableCellView key={cellId} store={store} nodeId={cellId} registry={registry} tableElements={tableElements} />
          ))}
        </tableElements.Tr>
      </tableElements.Thead>
    );
  }
  if (node.type === "table-body") {
    const rowIds = useRendererChildren(store, nodeId);
    if (!virtualization?.isVirtualized) {
      return (
        <tableElements.Tbody>
          {rowIds.map((rowId) => (
            <TableRowView key={rowId} store={store} nodeId={rowId} registry={registry} tableElements={tableElements} />
          ))}
        </tableElements.Tbody>
      );
    }

    const { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight, columnCount } = virtualization;
    const visibleRowIds = rowIds.slice(startIndex, endIndex);

    return (
      <tableElements.Tbody>
        {topSpacerHeight > 0 && (
          <tableElements.Tr
            key={`${nodeId}::spacer-top`}
            aria-hidden="true"
            className="markdown-table-spacer markdown-table-spacer-top"
            style={{ height: `${topSpacerHeight}px`, padding: 0, border: 0 }}
          >
            <tableElements.Td
              colSpan={columnCount}
              style={{ height: `${topSpacerHeight}px`, padding: 0, border: 0, margin: 0, lineHeight: 0 }}
            />
          </tableElements.Tr>
        )}
        {visibleRowIds.map((rowId, offset) => (
          <TableRowView key={rowId}
          store={store}
          nodeId={rowId}
          registry={registry}
          rowIndex={startIndex + offset} tableElements={tableElements} />
        ))}
        {bottomSpacerHeight > 0 && (
          <tableElements.Tr
            key={`${nodeId}::spacer-bottom`}
            aria-hidden="true"
            className="markdown-table-spacer markdown-table-spacer-bottom"
            style={{ height: `${bottomSpacerHeight}px`, padding: 0, border: 0 }}
          >
            <tableElements.Td
              colSpan={columnCount}
              style={{ height: `${bottomSpacerHeight}px`, padding: 0, border: 0, margin: 0, lineHeight: 0 }}
            />
          </tableElements.Tr>
        )}
      </tableElements.Tbody>
    );
  }
  return null;
});

TableSectionView.displayName = "TableSectionView";

const TableRowView: React.FC<{
  store: RendererStore;
  nodeId: string;
  registry: ComponentRegistry;
  tableElements: TableElements;
  rowIndex?: number;
}> = React.memo(({ store, nodeId, registry, tableElements, rowIndex }) => {
  const cellIds = useRendererChildren(store, nodeId);
  return (
    <tableElements.Tr
      data-row-id={nodeId}
      {...(rowIndex !== undefined ? { "data-row-index": rowIndex } : {})}
    >
      {cellIds.map((cellId) => (
        <TableCellView key={cellId} store={store} nodeId={cellId} registry={registry} tableElements={tableElements} />
      ))}
    </tableElements.Tr>
  );
});

TableRowView.displayName = "TableRowView";

const TableCellView: React.FC<{ store: RendererStore; nodeId: string; registry: ComponentRegistry; tableElements: TableElements }> = React.memo(({ store, nodeId, registry, tableElements }) => {
  const node = useRendererNode(store, nodeId);
  const inlineComponents = registry.getInlineComponents();
  if (!node) return null;
  const isHeader = node.type === "table-header-cell";
  const Tag = isHeader ? tableElements.Th : tableElements.Td;
  const tag = isHeader ? "th" : "td";
  const inline = (node.props?.inline as InlineNode[] | undefined) ?? [];
  const align = node.props?.align as string | undefined;
  const animCtx = registry.getRenderInlineContext(Boolean(node.block?.isFinalized), nodeId);
  const content = renderInlineNodes(inline, inlineComponents, registry.getUrlTransform(), registry, tag, animCtx);
  const alignProps = align ? { align } : undefined;
  const renderElement = () => <Tag {...alignProps}>{content}</Tag>;
  if (!registry.hasElementFilters()) {
    return renderElement();
  }
  const filtered = registry.filterElement(
    { tagName: tag, properties: alignProps ?? {} },
    { source: "markdown", parentTagName: "tr" },
    renderElement,
    () => content,
  );
  if (filtered === null || filtered === undefined) return null;
  return React.isValidElement(filtered) ? filtered : <>{filtered}</>;
});
TableCellView.displayName = "TableCellView";

