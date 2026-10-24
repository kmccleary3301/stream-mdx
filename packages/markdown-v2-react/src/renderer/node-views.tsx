declare const __STREAM_MDX_COUNTERS__: boolean;

import { normalizeBlockquoteText, PATCH_ROOT_ID, type Block, type HtmlTreeNode, type InlineNode, type MixedContentSegment, type TrustedMdxFlowChildSpan, type UrlTransform } from "@stream-mdx/core";
import React from "react";
import type { CodeNodeHandle, TableNodeHandle } from "@stream-mdx/core";
import type { CodeNodeViewProps, InlineComponents, NodeHandle, NodePresentationKey, NodeViewActions, NodeViewMetadata, TableElements } from "../types";
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
import {
  RenderConfigVersionContext,
  useRendererChildren,
  useRendererNode,
  useRendererNodeSnapshot,
} from "./hooks";
import { subscribeRendererNode } from "./node-subscriptions";
import { StreamingActivityContext } from "./streaming-activity-context";
import { createRendererStore, isListPatchDebugEnabled, type RendererStore } from "./store";
import { useVirtualizedTable, type TableVirtualizationProps } from "./virtualized-table";
import { CodeBlockView } from "./code-block-view";
import { ManagedParagraphBlockView, ManagedParagraphContentView } from "./paragraph-block-view";
import { ManagedTableBlockView, TableFullContentToggle, useTableFullContentMode } from "./table-block-view";
import { TrustedMdxProjectionContext } from "../trusted-mdx-boundary";
import { renderTrustedMdxInlineChild, TrustedMdxInlineBlockView } from "./trusted-mdx-inline-child";
import {
  assertTrustedMdxNativeChildContinuations,
  type TrustedMdxDocumentSnapshot,
  type TrustedMdxNativeChildOwner,
} from "../trusted-mdx-contract";
import { getStoreResetVersion } from "./store-reset-version";
import { NativeCodeViewContext } from "./code-highlight-context";
import { mergeNodePresentationProps } from "./node-presentations";

const HeadlessNativeCodeView: React.FC<{
  blockId: string;
  handle: CodeNodeHandle;
  view: React.ComponentType<CodeNodeViewProps>;
}> = ({ blockId, handle, view: CodeView }) => {
  const context = React.useMemo(() => ({ blockId, handle }), [blockId, handle]);
  return (
    <NativeCodeViewContext.Provider value={context}>
      <CodeView handle={handle} />
    </NativeCodeViewContext.Provider>
  );
};
const NodeViewRenderContext = React.createContext<{
  readonly store: RendererStore;
  readonly registry: ComponentRegistry;
} | null>(null);
type NodePresentationRenderer = (nativeView: React.ReactNode) => React.ReactNode;
export function renderNodePresentation(
  block: Block | undefined,
  nativeView: React.ReactNode,
  store: RendererStore,
  registry: ComponentRegistry,
  nodeId?: string,
  bypassPresentation = false,
): React.ReactNode {
  if (block?.isFinalized) registry.releaseFinalizedBlockAnimations(block.id);
  const type = (block?.type ?? "code") as NodePresentationKey;
  const id = block?.id ?? nodeId;
  if (id === undefined) return nativeView;
  const presentation = registry.getNodePresentation(type);
  if (!presentation || bypassPresentation) return nativeView;
  if (type === "table" && "view" in presentation && presentation.view) {
    const handle = store.getTableNodeHandle(id);
    if (!handle) return null;
    const HeadlessView = presentation.view as React.ComponentType<{ readonly handle: TableNodeHandle }>;
    return (
      <NodeViewRenderContext.Provider value={{ store, registry }}>
        <HeadlessView handle={handle} />
      </NodeViewRenderContext.Provider>
    );
  }
  if (type !== "code" && "view" in presentation && presentation.view) {
    const handle = store.getNodeHandle(id);
    if (!handle) return null;
    const HeadlessView = presentation.view as React.ComponentType<{ readonly handle: NodeHandle }>;
    return (
      <NodeViewRenderContext.Provider value={{ store, registry }}>
        <HeadlessView handle={handle} />
      </NodeViewRenderContext.Provider>
    );
  }
  let children = nativeView;
  if (presentation.props && React.isValidElement(nativeView) && typeof nativeView.type === "string") {
    children = React.cloneElement(
      nativeView,
      mergeNodePresentationProps(nativeView.props as Record<string, unknown>, presentation.props),
    );
  }
  if (!("wrapper" in presentation) || !presentation.wrapper) return children;

  const codeHandle = type === "code" ? store.getCodeNodeHandle(id) : undefined;
  const tableState = type === "table" ? store.getTableBlock(id) : undefined;
  const codeMetadata = codeHandle?.readMetadata();
  const blockLanguage = block?.payload.meta?.lang;
  const language = codeMetadata?.language ??
    (typeof blockLanguage === "string" ? blockLanguage : undefined);
  const metadata: NodeViewMetadata = Object.freeze({
    id,
    type,
    isFinalized: block?.isFinalized ?? (codeMetadata !== undefined && codeMetadata.state !== "open"),
    ...(language === undefined ? {} : { language }),
    ...(codeMetadata === undefined ? {} : { lineCount: codeMetadata.lineCount }),
    ...(tableState === undefined ? {} : {
      rowCount: tableState.source.rowCount,
      columnCount: tableState.header.cells.length,
      align: tableState.header.align,
    }),
  });
  const readSource = () => {
    if (codeHandle) return codeHandle.readSource();
    if (tableState) return store.getTableBlock(id)?.sourceSnapshot.materialize() ?? block?.payload.raw ?? "";
    const raw = block?.payload.raw;
    return typeof raw === "string" ? raw : "";
  };
  const actions: NodeViewActions = Object.freeze({
    copy: () => copyToClipboard(readSource()),
    download: () => downloadFile(readSource(), `${type}.txt`),
  });
  return React.createElement(presentation.wrapper, { children, metadata, actions, block });
}



function recordViewRecords(store: RendererStore, count: number): void {
  const counterStore = store as RendererStore & {
    campaignCounters?: {
      recordStoreRecordsTouched?(count: number, stage: string): void;
    };
  };
  counterStore.campaignCounters?.recordStoreRecordsTouched?.(count, "view");
}

function recordViewSlots(store: RendererStore, count: number): void {
  const counterStore = store as RendererStore & {
    campaignCounters?: {
      recordRecordSlotsAllocated?(count: number, stage: "view"): void;
    };
  };
  counterStore.campaignCounters?.recordRecordSlotsAllocated?.(count, "view");
}
const LIST_PROJECTION_CHUNK_SIZE = 64;

/** Null once the list can no longer grow: a nested node's block is synthesized, so only its top-level owner records finalization. */
function readListProjectionFrontier(store: RendererStore, parentId: string): number | null {
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewRecords(store, 1);
  }
  const parent = store.getNode(parentId);
  let owner = parent;
  while (owner?.parentId && owner.parentId !== PATCH_ROOT_ID) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      recordViewRecords(store, 1);
    }
    owner = store.getNode(owner.parentId);
  }
  if (!parent || !owner || owner.block?.isFinalized) return null;
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewRecords(store, 1);
  }
  return store.getChildren(parentId).length;
}

function useListProjectionFrontier(
  store: RendererStore,
  parentId: string,
  chunkEnd: number,
): number | null {
  const getFrontier = React.useCallback(
    () => readListProjectionFrontier(store, parentId),
    [parentId, store],
  );
  const subscribe = React.useCallback((listener: () => void) => {
    let active = true;
    let unsubscribe = () => {};
    let lastFrontier = getFrontier();
    const onParentChanged = () => {
      if (!active) return;
      const nextFrontier = getFrontier();
      if (nextFrontier === lastFrontier) return;
      lastFrontier = nextFrontier;
      if (nextFrontier === null || nextFrontier >= chunkEnd) {
        active = false;
        unsubscribe();
      }
      listener();
    };
    unsubscribe = subscribeRendererNode(store, parentId, onParentChanged);
    lastFrontier = getFrontier();
    if (lastFrontier === null || lastFrontier >= chunkEnd) {
      active = false;
      unsubscribe();
    }
    return () => {
      active = false;
      unsubscribe();
    };
  }, [chunkEnd, getFrontier, parentId, store]);
  return React.useSyncExternalStore(subscribe, getFrontier, getFrontier);
}


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
  bypassPresentationFor?: string;
}> = ({ store, blockId, registry, nativeFlowChild = false, parentTagName, bypassPresentationFor }) => {
  const node = useRendererNode(store, blockId);
  const renderPresentation = React.useCallback(
    (nativeView: React.ReactNode) => renderNodePresentation(
      node?.block,
      nativeView,
      store,
      registry,
      blockId,
      bypassPresentationFor === blockId,
    ),
    [blockId, bypassPresentationFor, node?.block, registry, store],
  );
  const renderParagraphChild = React.useCallback(
    (nodeId: string) => (
      <MixedSegmentView
        key={nodeId}
        store={store}
        nodeId={nodeId}
        inlineComponents={registry.getInlineComponents()}
        urlTransform={registry.getUrlTransform()}
        registry={registry}
        parentTagName="p"
      />
    ),
    [registry, store],
  );
  const trustedSnapshot = React.useContext(TrustedMdxProjectionContext);
  if (!node) return null;
  // Trusted projections apply before any native owner view, including managed paragraphs.
  const projection = trustedSnapshot?.projections[blockId];
  if (projection?.kind === "module") return null;
  if (!nativeFlowChild && projection?.nativeFlowParent === true) return null;
  if (
    node.type !== "mdx" &&
    (projection?.kind === "render" || projection?.kind === "server-content") &&
    projection.wholeBlockFlowRoot === true
  ) {
    return <MdxBlockView store={store} blockId={blockId} registry={registry} />;
  }
  if (node.type === "code" && bypassPresentationFor !== blockId) {
    const HeadlessCodeView = registry.getCodeNodeView();
    if (HeadlessCodeView) {
      const handle = store.getCodeNodeHandle(blockId);
      if (!handle) return null;
      const nativeView = <HeadlessNativeCodeView blockId={blockId} handle={handle} view={HeadlessCodeView} />;
      if (!registry.hasElementFilters()) return nativeView;
      return registry.filterElement(
        { tagName: "pre", properties: {}, blockType: "code" },
        { source: "markdown" },
        () => nativeView,
        () => handle.readSource(),
      );
    }
  }

  if (node.type === "paragraph" && store.getParagraphBlock(blockId)) {
    const block = node.block;
    if (!block) return null;
    const ownerState = store.getParagraphBlock(blockId);
    const presentation = registry.getNodePresentation("paragraph");
    const needsSource = presentation !== undefined && "wrapper" in presentation && presentation.wrapper !== undefined;
    const rendererBlock = needsSource && ownerState?.source.state !== "open"
      ? store.getParagraphColdBlock(blockId) ?? block
      : block;
    return (
      <ManagedParagraphBlockView
        store={store}
        blockId={blockId}
        registry={registry}
        renderNested={renderParagraphChild}
        renderPresentation={(nativeView) => renderNodePresentation(
          rendererBlock,
          nativeView,
          store,
          registry,
          blockId,
          bypassPresentationFor === blockId,
        )}
      />
    );
  }

  const block = node.block;
  if (!block && node.type === "code" && store.getCodeBlock(blockId)) {
    return <CodeBlockView store={store} blockId={blockId} registry={registry} renderPresentation={renderPresentation} />;
  }
  if (!block) {
    const parentTagName = node.type.startsWith("list-item-") ? "li" : node.type.startsWith("blockquote-") ? "blockquote" : "p";
    return <MixedSegmentView store={store} nodeId={blockId} inlineComponents={registry.getInlineComponents()} urlTransform={registry.getUrlTransform()} registry={registry} parentTagName={parentTagName} />;
  }

  const hasPreparedMdxInline = block.type === "paragraph" && hasTrustedMdxInline(block.payload.inline ?? []);
  const mixedParagraph = block.type === "paragraph" && Array.isArray(block.payload.meta?.mixedSegments) && !hasPreparedMdxInline;
  if (mixedParagraph) {
    return <>{registry.renderBlock(block, renderPresentation)}</>;
  }

  let element: React.ReactElement | null;
  let presentationHandled = true;
  switch (block.type) {
    case "paragraph":
      element = <ParagraphBlockView store={store} blockId={block.id} registry={registry} renderPresentation={renderPresentation} />;
      break;
    case "blockquote":
      element = <BlockquoteBlockView store={store} blockId={block.id} registry={registry} renderPresentation={renderPresentation} />;
      break;
    case "list":
      element = <ListBlockView store={store} blockId={block.id} registry={registry} depth={0} renderPresentation={renderPresentation} />;
      break;
    case "table":
      element = store.getTableBlock(block.id)
        ? <ManagedTableBlockView store={store} blockId={block.id} registry={registry} renderPresentation={renderPresentation} />
        : <TableBlockView store={store} blockId={block.id} registry={registry} renderPresentation={renderPresentation} />;
      break;
    case "code":
      element = <CodeBlockView store={store} blockId={block.id} registry={registry} renderPresentation={renderPresentation} />;
      break;
    case "html":
      element = <HtmlBlockView store={store} blockId={block.id} registry={registry} parentTagName={parentTagName} />;
      presentationHandled = false;
      break;
    case "mdx":
      element = <MdxBlockView store={store} blockId={block.id} registry={registry} />;
      presentationHandled = false;
      break;
    default:
      element = registry.renderBlock(block, renderPresentation);
      break;
  }

  if (element === null) return null;
  return presentationHandled
    ? <>{element}</>
    : <>{renderNodePresentation(block, element, store, registry, undefined, bypassPresentationFor === blockId)}</>;
};
export const NativeNodeView: React.FC<{ readonly handle: NodeHandle }> = ({ handle }) => {
  const context = React.useContext(NodeViewRenderContext);
  if (!context) {
    throw new Error("NativeNodeView must be rendered inside a headless node presentation view");
  }
  if (context.store.getNodeHandle(handle.id) !== handle) return null;
  return (
    <BlockNodeRenderer
      store={context.store}
      blockId={handle.id}
      registry={context.registry}
      bypassPresentationFor={handle.id}
    />
  );
};

const ParagraphBlockView: React.FC<{
  store: RendererStore;
  blockId: string;
  registry: ComponentRegistry;
  renderPresentation: NodePresentationRenderer;
}> = React.memo(({ store, blockId, registry, renderPresentation }) => {
  const trustedSnapshot = React.useContext(TrustedMdxProjectionContext);
  const node = useRendererNode(store, blockId);
  const block = node?.block;
  const childIds = useRendererChildren(store, blockId);
  if (!node || !block) {
    return null;
  }
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewRecords(store, 1);
  }

  const includesTrustedMdx = hasTrustedMdxInline(block.payload.inline ?? []);
  const inlineComponents = registry.getInlineComponents();
  const htmlElements = registry.getHtmlElements();
  const literalTagContent = registry.getLiteralTagContent();
  const renderFilteredParagraph = (
    nativeView: React.ReactNode,
    renderChildren: () => React.ReactNode,
    className = "markdown-paragraph",
  ): React.ReactNode => {
    if (!registry.hasElementFilters()) return renderPresentation(nativeView);
    let hostAllowed = false;
    const filtered = registry.filterElement(
      { tagName: "p", properties: { className }, blockType: "paragraph" },
      { source: "markdown" },
      () => {
        hostAllowed = true;
        return nativeView;
      },
      renderChildren,
    );
    return hostAllowed ? renderPresentation(filtered) : filtered;
  };
  const meta = block.payload.meta;
  const sourceOwnedHtmlTree = meta?.htmlOwnership === true && Array.isArray(meta.htmlTree) ? meta.htmlTree : undefined;
  if (sourceOwnedHtmlTree) {
    return <>{registry.renderHtmlTree(sourceOwnedHtmlTree, undefined, block, undefined, renderPresentation)}</>;
  }
  if (meta?.htmlParagraphTree) {
    return <>{registry.renderHtmlTree(meta.htmlParagraphTree, undefined, block, undefined, renderPresentation)}</>;
  }

  if (block.isFinalized && trustedSnapshot) {
    const flowSegments = splitTrustedFlowNodes(block.payload.inline ?? [], trustedSnapshot);
    if (flowSegments) {
      const ParagraphComponent = registry.getBlockComponent("paragraph");
      let hasParagraphHost = false;
      const renderedSegments = flowSegments.map((segment, index) => {
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
        if (!registry.hasElementFilters()) {
          hasParagraphHost = true;
          return paragraph;
        }
        return registry.filterElement(
          { tagName: "p", properties: { className: "markdown-paragraph" }, blockType: "paragraph" },
          { source: "markdown" },
          () => {
            hasParagraphHost = true;
            return paragraph;
          },
          () => children,
        );
      });
      const nativeView = <>{renderedSegments}</>;
      return hasParagraphHost ? renderPresentation(nativeView) : nativeView;
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
        return renderFilteredParagraph(<p className="markdown-paragraph streaming-partial">{raw}</p>, () => raw, "markdown-paragraph streaming-partial");
      }
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, segments.length);
      }
      const structured = renderParagraphMixedSegments(segments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS, htmlElements, literalTagContent, registry.getUrlTransform());
      if (structured.length === 1) {
        const [single] = structured;
        return renderPresentation(single);
      }
      return renderPresentation(structured);
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
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          recordViewRecords(store, derivedSegments.length + inlineNodes.length);
        }
        const structured = renderParagraphMixedSegments(derivedSegments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS, htmlElements, literalTagContent, registry.getUrlTransform());
        if (structured.length === 1) {
          const [single] = structured;
          return renderPresentation(single);
        }
        return renderPresentation(structured);
      }

      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, inlineNodes.length);
      }
      const partialInline = renderInlineNodes(inlineNodes, inlineComponents, registry.getUrlTransform(), registry, "p", registry.getRenderInlineContext(block.isFinalized, block.id));
      return renderFilteredParagraph(
        <p className="markdown-paragraph streaming-partial">{partialInline}</p>,
        () => partialInline,
        "markdown-paragraph streaming-partial",
      );
    }

    return renderFilteredParagraph(
      <p className="markdown-paragraph streaming-partial">{raw}</p>,
      () => raw,
      "markdown-paragraph streaming-partial",
    );
  }

  const propsBlock = node.props?.block as Block | undefined;
  const inlineStatus =
    (propsBlock?.payload?.meta as { inlineStatus?: string } | undefined)?.inlineStatus ??
    (block.payload.meta as { inlineStatus?: string } | undefined)?.inlineStatus ??
    (node.props?.inlineStatus as string | undefined);
  if (inlineStatus && inlineStatus !== "complete") {
    const raw = typeof block.payload.raw === "string" ? block.payload.raw : "";
    return renderFilteredParagraph(<p className="markdown-paragraph">{raw}</p>, () => raw);
  }

  const segments = Array.isArray((block.payload.meta as { mixedSegments?: MixedContentSegment[] } | undefined)?.mixedSegments)
    ? ((block.payload.meta as { mixedSegments?: MixedContentSegment[] }).mixedSegments as MixedContentSegment[])
    : undefined;

  if (segments && segments.length > 0 && !includesTrustedMdx) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      recordViewRecords(store, segments.length);
    }
    const structured = renderParagraphMixedSegments(segments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS, htmlElements, literalTagContent);
    if (structured.length === 1) {
      const [single] = structured;
      return renderPresentation(single);
    }
    return renderPresentation(structured);
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
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      recordViewRecords(store, derivedSegments.length + inlineNodes.length);
    }
    const structured = renderParagraphMixedSegments(derivedSegments, inlineComponents, DEFAULT_INLINE_HTML_RENDERERS, htmlElements, literalTagContent, registry.getUrlTransform());
    if (structured.length === 1) {
      const [single] = structured;
      return renderPresentation(single);
    }
    return renderPresentation(structured);
  }

  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewRecords(store, block.payload.inline?.length ?? 0);
  }
  const inlines = renderInlineNodes(block.payload.inline ?? [], inlineComponents, registry.getUrlTransform(), registry, "p", registry.getRenderInlineContext(block.isFinalized, block.id));
  const ParagraphComponent = registry.getBlockComponent("paragraph");
  const baseElement = React.createElement(ParagraphComponent, {
    inlines: block.payload.inline ?? [],
    raw: block.payload.raw,
    meta: block.payload.meta,
    children: inlines,
  });

  const renderParagraph = () => {
    if (childIds.length > 0) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, childIds.length);
      }
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
  const renderChildren = () => {
    if (childIds.length > 0) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, childIds.length);
      }
      return childIds.map((childId) => <MixedSegmentView key={childId} store={store} nodeId={childId} inlineComponents={inlineComponents} urlTransform={registry.getUrlTransform()} registry={registry} parentTagName="p" />);
    }
    return inlines;
  };
  return renderFilteredParagraph(renderParagraph(), renderChildren);
});

const BlockquoteBlockView: React.FC<{
  store: RendererStore;
  blockId: string;
  registry: ComponentRegistry;
  renderPresentation: NodePresentationRenderer;
}> = React.memo(({ store, blockId, registry, renderPresentation }) => {
  const node = useRendererNode(store, blockId);
  const block = node?.block;
  const childIds = useRendererChildren(store, blockId);
  if (!node || !block) {
    return null;
  }
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewRecords(store, 1);
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
    : childIds.length === 0
      ? normalizeBlockquoteText(typeof block.payload.raw === "string" ? block.payload.raw : "")
      : "";
  const inlineComponents = registry.getInlineComponents();
  const renderFilteredBlockquote = (
    nativeView: React.ReactNode,
    renderChildren: () => React.ReactNode,
    className = "markdown-blockquote",
  ): React.ReactNode => {
    if (!registry.hasElementFilters()) return renderPresentation(nativeView);
    let hostAllowed = false;
    const filtered = registry.filterElement(
      { tagName: "blockquote", properties: { className }, blockType: "blockquote" },
      { source: "markdown" },
      () => {
        hostAllowed = true;
        return nativeView;
      },
      renderChildren,
    );
    return hostAllowed ? renderPresentation(filtered) : filtered;
  };

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
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, inline.length);
      }
      return renderInlineNodes(inline, inlineComponents, registry.getUrlTransform(), registry, "div", registry.getRenderInlineContext(block.isFinalized, `${block.id}:${keyPrefix}`));
    }
    return null;
  };

  const renderMixedSegments = () => {
    if (!mixedSegments.length) {
      return [] as React.ReactNode[];
    }
    const elements: React.ReactNode[] = [];
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      recordViewRecords(store, mixedSegments.length);
    }
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
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewRecords(store, inlineNodes.length);
  }
  const inlineElements = inlineNodes.length > 0 ? renderInlineNodes(inlineNodes, inlineComponents, registry.getUrlTransform(), registry, "blockquote", registry.getRenderInlineContext(block.isFinalized, block.id)) : null;

  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewRecords(store, childIds.length);
  }
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
    const emptyQuote = <blockquote className="markdown-blockquote" />;
    return renderFilteredBlockquote(emptyQuote, () => null);
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
    const streamingQuote = <blockquote className={className}>{streamingContent}</blockquote>;
    return renderFilteredBlockquote(streamingQuote, () => streamingContent, className);
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

  const base = <blockquote className="markdown-blockquote">{renderedContent}</blockquote>;
  return renderFilteredBlockquote(base, () => renderedContent);
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
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewRecords(store, 1);
  }

  switch (node.type) {
    case "paragraph-text":
    case "blockquote-text":
    case "list-item-text": {
      const inline = (node.props?.inline as InlineNode[] | undefined) ?? [];
      if (inline.length > 0) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          recordViewRecords(store, inline.length);
        }
        const inlineContext = registry?.getRenderInlineContext(Boolean(node.block?.isFinalized), node.id);
        return renderInlineNodes(inline, inlineComponents, urlTransform, registry, parentTagName, inlineContext);
      }
      const text = typeof node.props?.text === "string" ? (node.props?.text as string) : "";
      if (!text) return null;
      return text;
    }
    case "paragraph-html":
    case "blockquote-html":
    case "list-item-html": {
      const htmlTree = node.props?.htmlTree as HtmlTreeNode[] | undefined;
      const isFinalized = Boolean(node.block?.isFinalized);
      const inlineContext = registry?.getRenderInlineContext(isFinalized, node.id);
      if (registry && htmlTree !== undefined) {
        return <>{renderOwnedHtmlTree(htmlTree, {
          elements: registry.getHtmlElements(),
          renderBlock: (block) => <OwnedHtmlBlock key={block.id} block={block} registry={registry} />,
          renderInline: (nodes, parentTagName) => renderInlineNodes(nodes, inlineComponents, urlTransform, registry, parentTagName, inlineContext),
          inlineComponents,
          urlTransform,
          isAutolinkProtocolDisabled: (href) => registry.isAutolinkProtocolDisabled(href),
          filterElement: registry.hasElementFilters()
            ? (element, context, renderElement, renderChildren) => registry.filterElement(element, context, renderElement, renderChildren)
            : undefined,
          parentTagName,
          contentComponents: registry.getContentComponents(),
          renderInlinePresentation: (inlineNode, nativeView, key) =>
            registry.renderInlinePresentation(inlineNode, nativeView, key, inlineContext),
          renderHtmlPresentation: (tagName, properties, nativeView, children, key) =>
            registry.renderHtmlPresentation(tagName, properties, nativeView, children, key, node.id, inlineContext?.isFinalized ?? isFinalized),
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
      node.block,
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


type ListItemLayout = {
  inlineComponents: InlineComponents;
  registry: ComponentRegistry;
  ordered: boolean;
  listLoose?: boolean;
  listStart?: number;
  depth: number;
  renderConfigVersion: number;
};

const ListItemLayoutContext = React.createContext<ListItemLayout | null>(null);
const EMPTY_LIST_CHILDREN: ReadonlyArray<string> = Object.freeze([]);

type ListProjectionCache = {
  children: ReadonlyArray<string>;
  rawLength: number;
  baseElements: ReadonlyArray<React.ReactElement>;
  baseRawLength: number;
  baseItemCount: number;
  itemCount: number;
  markerDigits: number;
  hasElementFilters: boolean;
  needsListItemIds: boolean;
  token: number;
};
const ListBlockView: React.FC<{
  store: RendererStore;
  blockId: string;
  registry: ComponentRegistry;
  depth?: number;
  renderPresentation?: NodePresentationRenderer;
}> = React.memo(
  ({ store, blockId, registry, depth = 0, renderPresentation }) => {
    const nodeSnapshot = useRendererNodeSnapshot(store, blockId);
    const node = nodeSnapshot.node;
    const block = node?.block;
    const childIds = node?.children ?? EMPTY_LIST_CHILDREN;
    const renderConfigVersion = React.useContext(RenderConfigVersionContext);
    const inlineComponents = registry.getInlineComponents();
    const ordered = Boolean(node?.props?.ordered ?? block?.payload.meta?.ordered);
    const listLoose = typeof node?.props?.loose === "boolean"
      ? node.props.loose
      : typeof block?.payload.meta?.loose === "boolean"
        ? block.payload.meta.loose
        : undefined;
    const start = typeof node?.props?.start === "number" ? node.props.start : undefined;
    const Tag = ordered ? "ol" : "ul";
    const listDebugEnabled = isListPatchDebugEnabled();
    const hasElementFilters = registry.hasElementFilters();
    const itemLayout = React.useMemo<ListItemLayout>(
      () => ({ inlineComponents, registry, ordered, listLoose, listStart: start, depth, renderConfigVersion }),
      [depth, inlineComponents, listLoose, ordered, registry, renderConfigVersion, start],
    );
    const projectionCacheRef = React.useRef<ListProjectionCache | null>(null);
    const previousProjection = projectionCacheRef.current;
    const needsListItemIds = hasElementFilters || listDebugEnabled;
    const listItemIds: Array<ListProjectionCache["children"][number]> | null = needsListItemIds ? [] : null;
    let projectionCache: ListProjectionCache;
    let rebuiltProjection = false;

    if (
      !previousProjection ||
      previousProjection.children !== childIds ||
      childIds.length < previousProjection.rawLength ||
      previousProjection.hasElementFilters !== hasElementFilters ||
      previousProjection.needsListItemIds !== needsListItemIds
    ) {
      const baseElements: React.ReactElement[] = [];
      let itemCount = 0;
      let markerDigits = 1;
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, childIds.length);
      }
      for (const childId of childIds) {
        const childNode = store.getNode(childId);
        if (childNode?.type !== "list-item") continue;
        listItemIds?.push(childId);
        if (!hasElementFilters) {
          baseElements.push(
            <ListItemView key={childId} store={store} nodeId={childId} index={itemCount} />,
          );
        }
        if (ordered) {
          const digits = String((start ?? 1) + itemCount).length;
          if (digits > markerDigits) markerDigits = digits;
        }
        itemCount += 1;
      }
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        if (listItemIds) recordViewSlots(store, listItemIds.length);
        if (!hasElementFilters) recordViewSlots(store, baseElements.length);
      }
      projectionCache = {
        children: childIds,
        rawLength: childIds.length,
        baseElements: Object.freeze(baseElements),
        baseRawLength: childIds.length,
        baseItemCount: itemCount,
        itemCount,
        markerDigits,
        hasElementFilters,
        needsListItemIds,
        token: (previousProjection?.token ?? 0) + 1,
      };
      rebuiltProjection = true;
    } else {
      projectionCache = previousProjection;
      let itemCount = projectionCache.itemCount;
      let markerDigits = projectionCache.markerDigits;
      const firstNewChild = projectionCache.rawLength;
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, childIds.length - firstNewChild);
      }
      for (let index = firstNewChild; index < childIds.length; index += 1) {
        const childNode = store.getNode(childIds[index]!);
        if (childNode?.type !== "list-item") continue;
        if (ordered) {
          const digits = String((start ?? 1) + itemCount).length;
          if (digits > markerDigits) markerDigits = digits;
        }
        itemCount += 1;
      }
      projectionCache.rawLength = childIds.length;
      projectionCache.itemCount = itemCount;
      projectionCache.markerDigits = markerDigits;
    }
    projectionCache.markerDigits = ordered && projectionCache.itemCount > 0
      ? Math.max(
        String(start ?? 1).length,
        String((start ?? 1) + projectionCache.itemCount - 1).length,
      )
      : 1;
    projectionCacheRef.current = projectionCache;

    if (listItemIds && !rebuiltProjection) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, childIds.length);
      }
      for (const childId of childIds) {
        if (store.getNode(childId)?.type === "list-item") listItemIds.push(childId);
      }
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewSlots(store, listItemIds.length);
      }
    }
    const childListItemIds = listItemIds ?? EMPTY_LIST_CHILDREN;
    React.useEffect(() => {
      if (!listDebugEnabled) return;
      const childTypes = childIds.map((childId) => store.getNode(childId)?.type ?? "missing");
      console.info("[stream-mdx:list-render]", {
        listId: blockId,
        depth,
        ordered,
        childIds,
        childTypes,
        listItemIds: childListItemIds,
        listItems: childListItemIds.length,
        totalChildren: childIds.length,
        isFinalized: block?.isFinalized ?? false,
      });
    }, [block?.isFinalized, blockId, childIds, childListItemIds, depth, listDebugEnabled, nodeSnapshot.version, ordered, store]);

    const markerDigits = ordered && projectionCache.itemCount > 0 ? projectionCache.markerDigits : 1;
    const listStyle = React.useMemo(() => {
      if (!ordered || projectionCache.itemCount === 0) return undefined;
      const baseIndent = depth === 0 ? "2rem" : depth === 1 ? "1.75rem" : "1.5rem";
      const extraDigits = Math.max(0, markerDigits - 1);
      return {
        ["--list-indent" as const]: extraDigits > 0 ? `calc(${baseIndent} + ${extraDigits}ch)` : baseIndent,
        ["--list-marker-digits" as const]: String(markerDigits),
      } as React.CSSProperties;
    }, [depth, markerDigits, ordered, projectionCache.itemCount]);

    if (!node || projectionCache.itemCount === 0) return null;

    const renderChildren = () => {
      if (!hasElementFilters) {
        return (
          <ListProjectionRoot
            key={projectionCache.token}
            store={store}
            parentId={blockId}
            baseElements={projectionCache.baseElements}
            firstDynamicIndex={projectionCache.baseRawLength}
            firstDynamicItemIndex={projectionCache.baseItemCount}
          />
        );
      }
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, childListItemIds.length);
        recordViewSlots(store, childListItemIds.length);
      }
      return (
        <>
          {childListItemIds.map((childId, index) => (
            <ListItemView key={childId} store={store} nodeId={childId} index={index} />
          ))}
        </>
      );
    };
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
    let hostAllowed = false;
    let renderedList: React.ReactNode;
    if (!hasElementFilters) {
      hostAllowed = true;
      renderedList = renderElement();
    } else {
      const filtered = registry.filterElement(
        { tagName: Tag, properties: { className: `markdown-list ${ordered ? "ordered" : "unordered"}` }, blockType: "list" },
        { source: "markdown" },
        () => {
          hostAllowed = true;
          return renderElement();
        },
        renderChildren,
      );
      if (filtered === null || filtered === undefined) return null;
      renderedList = React.isValidElement(filtered) ? filtered : <>{filtered}</>;
    }
    const nativeView = (
      <ListItemLayoutContext.Provider value={itemLayout}>
        {renderedList}
      </ListItemLayoutContext.Provider>
    );
    if (!hostAllowed) return nativeView;
    return renderPresentation
      ? renderPresentation(nativeView)
      : renderNodePresentation(block, nativeView, store, registry, blockId);
  },
);

ListBlockView.displayName = "ListBlockView";

const ListItemView: React.FC<{ store: RendererStore; nodeId: string; index: number }> = React.memo(({ store, nodeId, index }) => {
  const itemLayout = React.useContext(ListItemLayoutContext);
  if (!itemLayout) throw new Error("List item view requires its parent list layout");
  const { inlineComponents, registry, ordered, listLoose, listStart, depth } = itemLayout;
  const node = useRendererNode(store, nodeId);
  const childIds = useRendererChildren(store, nodeId);
  const childClassificationVersion = store.getNodeWithVersion(nodeId).version;
  const inline = (node?.props?.inline as InlineNode[] | undefined) ?? [];
  const isTask = Boolean(node?.props?.task);
  const isChecked = Boolean(node?.props?.checked);
  const block = node?.block;
  const inferredIndex = typeof node?.props?.index === "number" ? Number(node.props.index) : index;
  const isOrdered = ordered;
  const start = listStart ?? 1;
  const itemNumber = start + inferredIndex;
  const counterText = !isTask ? (isOrdered ? `${itemNumber}.` : "\u2022") : undefined;
  const listDebugEnabled = isListPatchDebugEnabled();
  const inlineLength = inline.length;
  const animCtx = registry.getRenderInlineContext(Boolean(block?.isFinalized), nodeId);
  // Inline output below is memoized on registry identity; filter/URL changes bump this version instead.
  const renderConfigVersion = React.useContext(RenderConfigVersionContext);
  const isLoose = listLoose ?? Boolean(node?.props?.loose);
  const paragraphParentTagName = isLoose ? "p" : "li";
  const renderParagraphNested = React.useCallback(
    (childId: string) => (
      <MixedSegmentView
        key={childId}
        store={store}
        nodeId={childId}
        inlineComponents={inlineComponents}
        urlTransform={registry.getUrlTransform()}
        registry={registry}
        parentTagName={paragraphParentTagName}
      />
    ),
    [store, inlineComponents, registry, paragraphParentTagName, renderConfigVersion],
  );
  const { segmentChildIds, contentChildIds, primaryParagraphId } = React.useMemo(() => {
    const segments: string[] = [];
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      recordViewRecords(store, childIds.length);
    }
    const structural: string[] = [];
    let primaryParagraphId: string | undefined;
    for (const childId of childIds) {
      const childNode = store.getNode(childId);
      if (!childNode) continue;
      if (childNode.type === "paragraph" && childNode.props?.listItemPrimary === true) {
        primaryParagraphId = childId;
      } else if (childNode.type?.startsWith("list-item-")) {
        segments.push(childId);
      } else {
        structural.push(childId);
      }
    }
    return { segmentChildIds: segments, contentChildIds: structural, primaryParagraphId };
  }, [childIds, childClassificationVersion, store]);

  const segmentElements = React.useMemo(() => {
    return segmentChildIds.map((childId) => {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, 1);
      }
      return <MixedSegmentView key={childId} store={store} nodeId={childId} inlineComponents={inlineComponents} urlTransform={registry.getUrlTransform()} registry={registry} parentTagName="li" />;
    });
  }, [segmentChildIds, store, inlineComponents, registry]);

  const primaryContent = React.useMemo(() => {
    if (primaryParagraphId !== undefined) {
      return (
        <ManagedParagraphContentView
          key={primaryParagraphId}
          store={store}
          blockId={primaryParagraphId}
          registry={registry}
          renderNested={renderParagraphNested}
          parentTagName={paragraphParentTagName}
        />
      );
    }
    if (segmentChildIds.length > 0) {
      return segmentElements;
    }
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      recordViewRecords(store, inline.length);
    }
    return renderInlineNodes(inline, inlineComponents, registry.getUrlTransform(), registry, "li", animCtx);
  }, [primaryParagraphId, renderParagraphNested, paragraphParentTagName, segmentChildIds, segmentElements, inline, inlineComponents, registry, renderConfigVersion]);

  const trailingChildren = React.useMemo(() => {
    return contentChildIds.map((childId) => {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, 1);
      }
      const childNode = store.getNode(childId);
      if (!childNode) return null;
      switch (childNode.type) {
        case "paragraph": {
          const childIsLoose = listLoose ?? !Boolean(childNode.props?.tight);
          const childParentTagName = childIsLoose ? "p" : "li";
          let childContent: React.ReactNode;
          if (store.getParagraphBlock(childId)) {
            childContent = (
              <ManagedParagraphContentView
                key={childId}
                store={store}
                blockId={childId}
                registry={registry}
                renderNested={(nestedId) => (
                  <MixedSegmentView
                    key={nestedId}
                    store={store}
                    nodeId={nestedId}
                    inlineComponents={inlineComponents}
                    urlTransform={registry.getUrlTransform()}
                    registry={registry}
                    parentTagName={childParentTagName}
                  />
                )}
                parentTagName={childParentTagName}
              />
            );
          } else {
            const childInline = childNode.block?.payload.inline ?? (childNode.props?.inline as InlineNode[] | undefined) ?? [];
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
              recordViewRecords(store, childInline.length);
            }
            childContent = renderInlineNodes(
              childInline,
              inlineComponents,
              registry.getUrlTransform(),
              registry,
              childParentTagName,
              registry.getRenderInlineContext(Boolean(childNode.block?.isFinalized), childId),
            );
          }
          if (!childIsLoose) {
            return <React.Fragment key={childId}>{childContent}</React.Fragment>;
          }
          if (!registry.hasElementFilters()) {
            return (
              <p key={childId} className="markdown-list-item-paragraph">
                {childContent}
              </p>
            );
          }
          return registry.filterElement(
            { tagName: "p", properties: { className: "markdown-list-item-paragraph" }, blockType: "paragraph" },
            { source: "markdown", parentTagName: "li" },
            () => (
              <p key={childId} className="markdown-list-item-paragraph">
                {childContent}
              </p>
            ),
            () => childContent,
          );
        }
        case "list":
          return <ListBlockView key={childId} store={store} blockId={childId} registry={registry} depth={depth + 1} />;
        default:
          return <BlockNodeRenderer key={childId} store={store} blockId={childId} registry={registry} parentTagName="li" />;
      }
    });
  }, [contentChildIds, store, inlineComponents, registry, depth, listLoose, renderConfigVersion]);

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

  const hasPrimaryContent = primaryParagraphId !== undefined || isTask || segmentChildIds.length > 0 || inline.length > 0;
  const primaryChildren = (
    <>
      {isTask ? (
        <input type="checkbox" className="markdown-task-checkbox" checked={isChecked} readOnly disabled tabIndex={-1} />
      ) : null}
      {isTask ? " " : null}
      {primaryContent}
    </>
  );
  let renderedPrimary: React.ReactNode = null;
  if (hasPrimaryContent) {
    if (!isLoose) {
      renderedPrimary = primaryChildren;
    } else if (primaryParagraphId === undefined || !registry.hasElementFilters()) {
      renderedPrimary = <p className="markdown-paragraph">{primaryChildren}</p>;
    } else {
      const filtered = registry.filterElement(
        { tagName: "p", properties: { className: "markdown-paragraph" }, blockType: "paragraph" },
        { source: "markdown", parentTagName: "li" },
        () => <p className="markdown-paragraph">{primaryChildren}</p>,
        () => primaryChildren,
      );
      if (filtered !== null && filtered !== undefined) {
        renderedPrimary = React.isValidElement(filtered) ? filtered : <>{filtered}</>;
      }
    }
  }

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

const ListProjectionTail: React.FC<{
  store: RendererStore;
  parentId: string;
  firstChildIndex: number;
  firstItemIndex: number;
}> = React.memo(({ store, parentId, firstChildIndex, firstItemIndex }) => {
  const chunkEndIndex = firstChildIndex + LIST_PROJECTION_CHUNK_SIZE;
  const frontier = useListProjectionFrontier(store, parentId, chunkEndIndex);
  const isSealed = frontier === null;
  const childIds = store.getChildren(parentId);
  const childEnd = Math.max(firstChildIndex, Math.min(childIds.length, chunkEndIndex));
  const chunkItems: React.ReactElement[] = [];
  let itemIndex = firstItemIndex;
  for (let index = firstChildIndex; index < childEnd; index += 1) {
    const childId = childIds[index]!;
    if (store.getNode(childId)?.type !== "list-item") continue;
    chunkItems.push(
      <ListItemView key={childId} store={store} nodeId={childId} index={itemIndex} />,
    );
    itemIndex += 1;
  }
  const hasMoreChildren = childIds.length > childEnd;
  const chunkIsFull = childIds.length >= chunkEndIndex;
  const shouldRenderTail = hasMoreChildren || (chunkIsFull && !isSealed);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewRecords(store, childEnd - firstChildIndex);
    recordViewSlots(store, chunkItems.length + (shouldRenderTail ? 1 : 0));
  }
  return (
    <>
      {chunkItems}
      {shouldRenderTail ? (
        <ListProjectionTail
          key={chunkEndIndex}
          store={store}
          parentId={parentId}
          firstChildIndex={chunkEndIndex}
          firstItemIndex={itemIndex}
        />
      ) : null}
    </>
  );
});

ListProjectionTail.displayName = "ListProjectionTail";

const ListProjectionRoot: React.FC<{
  store: RendererStore;
  parentId: string;
  baseElements: ReadonlyArray<React.ReactElement>;
  firstDynamicIndex: number;
  firstDynamicItemIndex: number;
}> = React.memo(({ store, parentId, baseElements, firstDynamicIndex, firstDynamicItemIndex }) => {
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewSlots(store, 1);
  }
  return (
    <>
      {baseElements}
      <ListProjectionTail
        key={firstDynamicIndex}
        store={store}
        parentId={parentId}
        firstChildIndex={firstDynamicIndex}
        firstItemIndex={firstDynamicItemIndex}
      />
    </>
  );
});

ListProjectionRoot.displayName = "ListProjectionRoot";

const TableBlockView: React.FC<{
  store: RendererStore;
  blockId: string;
  registry: ComponentRegistry;
  renderPresentation: NodePresentationRenderer;
}> = React.memo(({ store, blockId, registry, renderPresentation }) => {
  const node = useRendererNode(store, blockId);
  const [fullContentMode, toggleFullContentMode] = useTableFullContentMode(
    store,
    blockId,
    undefined,
    node?.blockEpoch,
    getStoreResetVersion(store),
  );
  const viewportId = React.useId();
  const streamingActive = React.useContext(StreamingActivityContext);
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
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, 1);
      }
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
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, 1);
      }
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

  const isFinalized = Boolean(node?.block?.isFinalized);
  const canVirtualize = mounted && typeof window !== "undefined" && !virtualizationDisabled && isFinalized && !streamingActive;

  const virtualization = useVirtualizedTable(rowIds, virtualizationConfig, canVirtualize);
  const { isEligible, isVirtualized, containerRef, handleScroll, window: virtualWindow, config, naturalLayout, headerBackgroundColor } = virtualization;
  const renderAllRows = isVirtualized && fullContentMode;
  const fullContentRowRanges = React.useMemo(
    () => [{ startIndex: 0, endIndex: rowCount, spacerBeforeHeight: 0 }],
    [rowCount],
  );
  const displayedRowRanges = renderAllRows ? fullContentRowRanges : virtualWindow.rowRanges;
  const bottomSpacerHeight = renderAllRows ? 0 : virtualWindow.bottomSpacerHeight;
  const virtualizationProps: TableVirtualizationProps | undefined = React.useMemo(() => {
    if (!isVirtualized) return undefined;
    return {
      isVirtualized: true,
      rowRanges: displayedRowRanges,
      bottomSpacerHeight,
      columnCount,
      headerBackgroundColor,
    };
  }, [isVirtualized, renderAllRows, displayedRowRanges, bottomSpacerHeight, columnCount, headerBackgroundColor]);

  const tableAttrs = {
    "data-table-block": "true",
    "data-block-id": blockId,
    "data-table-virtualized": isVirtualized ? "true" : "false",
    "data-table-total-rows": String(rowCount),
    "data-table-mounted-rows": String(renderAllRows ? rowCount : isVirtualized ? virtualWindow.mountedRows : rowCount),
    "data-table-start-index": String(renderAllRows ? 0 : isVirtualized ? virtualWindow.startIndex : 0),
    "data-table-end-index": String(renderAllRows ? rowCount : isVirtualized ? virtualWindow.endIndex : rowCount),
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
      {childIds.map((sectionId) => {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          recordViewRecords(store, 1);
        }
        return (
          <TableSectionView
            key={sectionId}
            store={store}
            nodeId={sectionId}
            registry={registry}
            tableElements={tableElements}
            virtualization={virtualizationProps}
            indexRows={isEligible}
          />
        );
      })}
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

  let hostAllowed = !registry.hasElementFilters();
  const filteredTable = registry.hasElementFilters()
    ? registry.filterElement(
        { tagName: "table", properties: { className: "markdown-table" }, blockType: "table" },
        { source: "markdown" },
        () => {
          hostAllowed = true;
          return tableElement;
        },
        () => (
          <>
            {childIds.map((sectionId) => {
              if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
                recordViewRecords(store, 1);
              }
              return (
                <TableSectionView
                  key={sectionId}
                  store={store}
                  nodeId={sectionId}
                  registry={registry}
                  tableElements={tableElements}
                  virtualization={virtualizationProps}
                  indexRows={isEligible}
                />
              );
            })}
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
      id={viewportId}
      {...tableAttrs}
    >
      {filteredTable}
    </div>
  ) : React.isValidElement(filteredTable) ? (
    filteredTable
  ) : (
    <>{filteredTable}</>
  );

  const fullContentToggle = isVirtualized ? (
    <TableFullContentToggle controlId={viewportId} pressed={renderAllRows} onClick={toggleFullContentMode} />
  ) : null;
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

    const nativeView = (
      <div className="stream-mdx-table-wrapper relative">
        {tableControlsElement}
        {fullContentToggle}
        {renderedContent}
      </div>
    );
    return hostAllowed ? renderPresentation(nativeView) : nativeView;
  }

  const nativeView = <>{fullContentToggle}{renderedContent}</>;
  return hostAllowed ? renderPresentation(nativeView) : nativeView;
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
  indexRows: boolean;
}> = React.memo(({ store, nodeId, registry, tableElements, virtualization, indexRows }) => {
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
          {childIds.map((cellId) => {
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
              recordViewRecords(store, 1);
            }
            return <TableCellView key={cellId} store={store} nodeId={cellId} registry={registry} tableElements={tableElements} />;
          })}
        </tableElements.Tr>
      </tableElements.Thead>
    );
  }
  if (node.type === "table-body") {
    const rowIds = useRendererChildren(store, nodeId);
    // GFM: a table without rows has no body; this view re-renders when the first row is inserted.
    if (rowIds.length === 0) return null;
    if (!virtualization?.isVirtualized) {
      return (
        <tableElements.Tbody>
          {rowIds.map((rowId, rowIndex) => {
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
              recordViewRecords(store, 1);
            }
            return (
              <TableRowView
                key={rowId}
                store={store}
                nodeId={rowId}
                registry={registry}
                rowIndex={indexRows ? rowIndex : undefined}
                tableElements={tableElements}
              />
            );
          })}
        </tableElements.Tbody>
      );
    }

    const { rowRanges, bottomSpacerHeight, columnCount } = virtualization;
    const renderedRows: React.ReactElement[] = [];
    const appendRow = (rowId: string, rowIndex: number) => {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        recordViewRecords(store, 1);
      }
      renderedRows.push(
        <TableRowView
          key={rowId}
          store={store}
          nodeId={rowId}
          registry={registry}
          rowIndex={rowIndex}
          tableElements={tableElements}
        />,
      );
    };
    for (let rangeIndex = 0; rangeIndex < rowRanges.length; rangeIndex++) {
      const range = rowRanges[rangeIndex];
      if (range.spacerBeforeHeight > 0) {
        renderedRows.push(
          <tableElements.Tr
            key={`${nodeId}::spacer-before-${range.startIndex}`}
            aria-hidden="true"
            className={`markdown-table-spacer markdown-table-spacer-${rangeIndex === 0 ? "top" : "focus"}`}
            style={{ height: `${range.spacerBeforeHeight}px`, padding: 0, border: 0 }}
          >
            <tableElements.Td
              colSpan={columnCount}
              style={{ height: `${range.spacerBeforeHeight}px`, padding: 0, border: 0, margin: 0, lineHeight: 0 }}
            />
          </tableElements.Tr>,
        );
      }
      for (let rowIndex = range.startIndex; rowIndex < range.endIndex; rowIndex++) {
        const rowId = rowIds[rowIndex];
        if (rowId !== undefined) appendRow(rowId, rowIndex);
      }
    }
    return (
      <tableElements.Tbody>
        <React.Fragment key={`${nodeId}::rows`}>{renderedRows}</React.Fragment>
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
      {cellIds.map((cellId) => {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          recordViewRecords(store, 1);
        }
        return <TableCellView key={cellId} store={store} nodeId={cellId} registry={registry} tableElements={tableElements} />;
      })}
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
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    recordViewRecords(store, inline.length);
  }
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

