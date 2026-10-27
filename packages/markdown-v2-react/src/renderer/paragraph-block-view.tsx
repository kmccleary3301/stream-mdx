declare const __STREAM_MDX_COUNTERS__: boolean;
import { type InlineNode, type ManagedParagraphViewState, type ParagraphSpanRecord } from "@stream-mdx/core";
import React from "react";
import { renderInlineNodes } from "../components";
import type { ComponentRegistry } from "../components";
import { containsSingleImage, isStandaloneImageContainer } from "../components/inline-image-context";
import { MathExpressionCompletenessContext } from "../components/katex-math";
import { RenderConfigVersionContext, useRendererNode } from "./hooks";
import { BlockRangeProjectionTree, type BlockRangeProjection, type BlockRangeProjectionRange } from "./block-range-projection";
import { PARAGRAPH_SPAN_RANGE_SIZE } from "./paragraph-span-range";
import type {
  ParagraphSegmentPlanEvent,
  ParagraphSegmentProjectionNode,
  RendererStore,
} from "./store";

import { captureNodeSourceGuard } from "./store-reset-version";
type ParagraphSourceRange = { readonly from: number; readonly to: number };

function recordViewRecords(store: RendererStore, count: number): void {
  const counterStore = store as RendererStore & {
    campaignCounters?: {
      recordStoreRecordsTouched?(count: number, stage: string): void;
    };
  };
  counterStore.campaignCounters?.recordStoreRecordsTouched?.(count, "view");
}

type ParagraphProjectionViewCounters = {
  recordStoreRecordsTouched?(count: number, stage: "view"): void;
  recordRecordSlotsAllocated?(count: number, stage: "view"): void;
};

function recordViewSlots(store: RendererStore, count: number): void {
  const counterStore = store as RendererStore & {
    campaignCounters?: {
      recordRecordSlotsAllocated?(count: number, stage: string): void;
    };
  };
  counterStore.campaignCounters?.recordRecordSlotsAllocated?.(count, "view");
}

function paragraphProjectionViewCounters(store: RendererStore): ParagraphProjectionViewCounters | undefined {
  return (store as RendererStore & { campaignCounters?: ParagraphProjectionViewCounters }).campaignCounters;
}

function firstSpanEndingAfter(state: ManagedParagraphViewState, sourceOffset: number, store: RendererStore): number {
  let low = 0;
  let high = state.spans.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
    const span = state.spans.get(middle);
    if (!span) throw new RangeError("Paragraph span index is incomplete");
    if (span.sourceRange.to <= sourceOffset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstSpanStartingAtOrAfter(state: ManagedParagraphViewState, sourceOffset: number, store: RendererStore): number {
  let low = 0;
  let high = state.spans.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
    const span = state.spans.get(middle);
    if (!span) throw new RangeError("Paragraph span index is incomplete");
    if (span.sourceRange.from < sourceOffset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function paragraphTextSpanRange(
  state: ManagedParagraphViewState,
  sourceRange: ParagraphSourceRange,
  store: RendererStore,
): { readonly from: number; readonly to: number } {
  const from = firstSpanEndingAfter(state, sourceRange.from, store);
  const to = firstSpanStartingAtOrAfter(state, sourceRange.to, store);
  if (from < to) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
    const first = state.spans.get(from);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
    const last = state.spans.get(to - 1);
    if (!first || !last || first.sourceRange.from < sourceRange.from || last.sourceRange.to > sourceRange.to) {
      throw new RangeError("Prepared paragraph span crosses a mixed text segment boundary");
    }
  }
  return { from, to };
}


function readParagraphSource(state: ManagedParagraphViewState, from: number, to: number): string {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < state.source.sourceRange.from ||
    to < from ||
    to > state.source.sourceRange.to
  ) throw new RangeError("Paragraph source slice is outside its owner range");
  const base = state.source.sourceRange.from;
  return state.sourceSnapshot.read(from - base, to - base);
}

function appendSourceGap(
  nodes: React.ReactNode[],
  state: ManagedParagraphViewState,
  segmentKey: string,
  from: number,
  to: number,
  store: RendererStore,
): void {
  if (to < from) throw new RangeError("Paragraph source spans overlap or regress");
  if (to === from) return;
  const source = readParagraphSource(state, from, to);
  if (source) {
    nodes.push(<React.Fragment key={`${segmentKey}:source:${from}:${to}`}>{source}</React.Fragment>);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewSlots(store, 1);
  }
}
function renderPlainParagraphRange(
  state: ManagedParagraphViewState,
  store: RendererStore,
  blockId: string,
  generation: number,
  registry: ComponentRegistry,
  segmentKey: string,
  from: number,
  to: number,
  parentTagName: string,
): React.ReactNode[] {
  const rendered: React.ReactNode[] = [];
  if (to <= from) return rendered;
  let cursor = from;
  let index = firstSpanEndingAfter(state, from, store);
  while (index < state.spans.length) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
    const span = state.spans.get(index);
    if (!span || span.sourceRange.from >= to) break;
    const spanFrom = Math.max(from, span.sourceRange.from);
    const spanTo = Math.min(to, span.sourceRange.to);
    appendSourceGap(rendered, state, segmentKey, cursor, spanFrom, store);
    if (span.children?.length) {
      cursor = Math.max(cursor, spanTo);
      index += 1;
      continue;
    }
    if (spanFrom !== span.sourceRange.from || spanTo !== span.sourceRange.to) {
      throw new RangeError("Paragraph child boundary crosses a prepared plain span");
    }
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
    rendered.push(
      <React.Fragment key={span.id}>
        <MathExpressionCompletenessContext.Provider value={!span.isProvisional}>
        {renderInlineNodes(
          span.nodes,
          registry.getInlineComponents(),
          registry.getUrlTransform(),
          registry,
          parentTagName,
          registry.getRenderInlineContext(!span.isProvisional, `${blockId}:${span.id}`, captureNodeSourceGuard(store, blockId)),
        )}
        </MathExpressionCompletenessContext.Provider>
      </React.Fragment>,
    );
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewSlots(store, 1);
    cursor = spanTo;
    index += 1;
  }
  appendSourceGap(rendered, state, segmentKey, cursor, to, store);
  return rendered;
}

const ParagraphSpanRangeView: React.FC<{
  store: RendererStore;
  blockId: string;
  generation: number;
  from: number;
  spanFrom: number;
  spanTo: number;
  sourceStart?: number;
  sourceEnd?: number;
  segmentKey: string;
  registry: ComponentRegistry;
  parentTagName: string;
}> = React.memo(({ store, blockId, generation, from, spanFrom, spanTo, sourceStart, sourceEnd, segmentKey, registry, parentTagName }) => {
  React.useContext(RenderConfigVersionContext);
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribeParagraphSpans(blockId, generation, from, listener),
    [store, blockId, generation, from],
  );
  const getSnapshot = React.useCallback(
    () => store.getParagraphSpans(blockId, generation, from, from + PARAGRAPH_SPAN_RANGE_SIZE),
    [store, blockId, generation, from],
  );
  const spans = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const state = store.getParagraphBlock(blockId);
  if (!state || state.source.generation !== generation) return null;

  const visibleFrom = Math.max(spanFrom, from);
  const visibleTo = Math.min(spanTo, from + spans.length, state.spans.length);
  const visibleCount = Math.max(0, visibleTo - visibleFrom);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && visibleCount > 0) {
    recordViewRecords(store, visibleCount);
  }

  const previous = visibleFrom > 0 ? state.spans.get(visibleFrom - 1) : undefined;
  let cursor = sourceStart ?? previous?.sourceRange.to ?? state.source.sourceRange.from;
  const rendered: React.ReactNode[] = [];
  const inlineComponents = registry.getInlineComponents();
  const urlTransform = registry.getUrlTransform();
  const allSpans = state.spans.materialize();
  const allInlineNodes: InlineNode[] = [];
  let hasNestedChildren = false;
  for (const span of allSpans) {
    if (span.children?.length) hasNestedChildren = true;
    allInlineNodes.push(...span.nodes);
  }
  const paragraphIsStandalone = !hasNestedChildren &&
    isStandaloneImageContainer(parentTagName) &&
    containsSingleImage(allInlineNodes);
  for (let index = visibleFrom; index < visibleTo; index += 1) {
    const span: ParagraphSpanRecord | undefined = spans[index - from];
    if (!span) throw new RangeError("Paragraph span range cache is incomplete");
    if (span.sourceRange.from < cursor) throw new RangeError("Prepared paragraph spans overlap or regress");
    appendSourceGap(rendered, state, segmentKey, cursor, span.sourceRange.from, store);
    if (span.children?.length) {
      cursor = span.sourceRange.to;
      continue;
    }
    rendered.push(
      <React.Fragment key={span.id}>
        <MathExpressionCompletenessContext.Provider value={!span.isProvisional}>
        {renderInlineNodes(
          span.nodes,
          inlineComponents,
          urlTransform,
          registry,
          parentTagName,
          {
            ...registry.getRenderInlineContext(!span.isProvisional, `${blockId}:${span.id}`, captureNodeSourceGuard(store, blockId)),
            isStandalone: paragraphIsStandalone,
          },
        )}
        </MathExpressionCompletenessContext.Provider>
      </React.Fragment>,
    );
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewSlots(store, 1);
    cursor = span.sourceRange.to;
  }

  const next = visibleTo < state.spans.length ? state.spans.get(visibleTo) : undefined;
  const end = sourceEnd ?? next?.sourceRange.from ?? state.source.sourceRange.to;
  appendSourceGap(rendered, state, segmentKey, cursor, end, store);
  return <>{rendered}</>;
});

const ParagraphSpanProjectionNodeView: React.FC<{
  rangeSize: number;
  root: BlockRangeProjection["root"];
  spanFrom: number;
  spanTo: number;
  sourceStart: number;
  sourceEnd: number;
  segmentKey: string;
  store: RendererStore;
  blockId: string;
  generation: number;
  registry: ComponentRegistry;
  parentTagName: string;
}> = React.memo(({ root, rangeSize, spanFrom, spanTo, sourceStart, sourceEnd, segmentKey, store, blockId, generation, registry, parentTagName }) => {
  const firstRange = Math.floor(spanFrom / rangeSize);
  const lastRange = Math.ceil(spanTo / rangeSize) - 1;
  const renderRange = React.useCallback(({ chunkStart }: BlockRangeProjectionRange) => {
    const pageSpanFrom = Math.max(spanFrom, chunkStart);
    const pageSpanTo = Math.min(spanTo, chunkStart + rangeSize);
    if (pageSpanFrom >= pageSpanTo) return null;
    const rangeIndex = chunkStart / rangeSize;
    return (
      <ParagraphSpanRangeView
        key={`${segmentKey}:range:${rangeIndex}`}
        store={store}
        blockId={blockId}
        generation={generation}
        from={chunkStart}
        spanFrom={pageSpanFrom}
        spanTo={pageSpanTo}
        sourceStart={rangeIndex === firstRange ? sourceStart : undefined}
        sourceEnd={rangeIndex === lastRange ? sourceEnd : undefined}
        segmentKey={`${segmentKey}:range:${rangeIndex}`}
        registry={registry}
        parentTagName={parentTagName}
      />
    );
  }, [blockId, firstRange, generation, parentTagName, rangeSize, registry, segmentKey, sourceEnd, sourceStart, spanFrom, spanTo, store, lastRange]);

  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    return (
      <BlockRangeProjectionTree
        node={root}
        nodeStart={0}
        rangeSize={rangeSize}
        rangeStart={spanFrom}
        rangeEnd={spanTo}
        visibleStart={spanFrom}
        visibleEnd={spanTo}
        renderRange={renderRange}
        viewCounters={paragraphProjectionViewCounters(store)}
      />
    );
  }
  return (
    <BlockRangeProjectionTree
      node={root}
      nodeStart={0}
      rangeSize={rangeSize}
      rangeStart={spanFrom}
      rangeEnd={spanTo}
      visibleStart={spanFrom}
      visibleEnd={spanTo}
      renderRange={renderRange}
    />
  );
});

const ParagraphSegmentProjectionNodeView: React.FC<{
  node: ParagraphSegmentProjectionNode;
  base: number;
  previousEvent?: ParagraphSegmentPlanEvent;
  sourceStart?: number;
  sourceEnd?: number;
  segmentKey: string;
  store: RendererStore;
  blockId: string;
  generation: number;
  tailSpanOwnerIndex?: number;
  spanCount?: number;
  registry: ComponentRegistry;
  parentTagName: string;
  renderNested: (nodeId: string) => React.ReactNode;
}> = React.memo(({ node, base, previousEvent, sourceStart, sourceEnd, tailSpanOwnerIndex, spanCount, segmentKey, store, blockId, generation, registry, renderNested, parentTagName }) => {
  const state = store.getParagraphBlock(blockId);
  if (!state || state.source.generation !== generation) return null;
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
  if (node.kind === "branch") {
    const children: React.ReactNode[] = [];
    let childBase = base;
    let previous = previousEvent;
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index];
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
      if (!child) throw new RangeError("Paragraph segment projection branch is incomplete");
      const childEnd = childBase + child.eventCount;
      const containsTailSpanOwner = tailSpanOwnerIndex !== undefined &&
        tailSpanOwnerIndex >= childBase &&
        tailSpanOwnerIndex < childEnd;
      children.push(
        <ParagraphSegmentProjectionNodeView
          key={`${segmentKey}:node:${node.level}:${index}`}
          node={child}
          base={childBase}
          previousEvent={previous}
          sourceStart={index === 0 ? sourceStart : undefined}
          sourceEnd={index === node.children.length - 1 ? sourceEnd : undefined}
          tailSpanOwnerIndex={containsTailSpanOwner ? tailSpanOwnerIndex : undefined}
          spanCount={containsTailSpanOwner ? spanCount : undefined}
          segmentKey={segmentKey}
          store={store}
          blockId={blockId}
          generation={generation}
          registry={registry}
          parentTagName={parentTagName}
          renderNested={renderNested}
        />,
      );
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewSlots(store, 1);
      childBase = childEnd;
      previous = child.lastEvent;
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
    }
    return <>{children}</>;
  }

  const rendered: React.ReactNode[] = [];
  for (let offset = 0; offset < node.events.length; offset += 1) {
    const event = node.events[offset];
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
    if (!event) throw new RangeError("Paragraph segment projection leaf is incomplete");
    let prior = previousEvent;
    if (offset > 0) {
      prior = node.events[offset - 1];
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
    }
    const gapStart = prior?.range.to ?? sourceStart ?? state.source.sourceRange.from;
    const gapFrom = Math.max(state.source.sourceRange.from, Math.min(gapStart, state.source.sourceRange.to));
    const gapTo = Math.max(gapFrom, Math.min(event.range.from, state.source.sourceRange.to));
    const eventIndex = base + offset;
    const tailSpanCount = tailSpanOwnerIndex === eventIndex ? spanCount : undefined;
    const isTail = sourceEnd !== undefined && offset === node.events.length - 1;
    let eventContent: React.ReactNode;
    if (event.nativeChild) {
      eventContent = renderNested(event.id);
    } else if (event.type === "paragraph-text") {
      const end = isTail
        ? Math.min(state.source.sourceRange.to, Math.max(event.range.from, sourceEnd ?? state.source.sourceRange.to))
        : Math.min(event.range.to, state.source.sourceRange.to);
      const range = { from: Math.min(event.range.from, end), to: end };
      const spanRange = paragraphTextSpanRange(state, range, store);
      if (tailSpanCount === 0 || spanRange.from === spanRange.to) {
        eventContent = readParagraphSource(state, range.from, range.to);
      } else {
        const projection = store.getParagraphSpanProjection(blockId);
        eventContent = (
          <ParagraphSpanProjectionNodeView
            root={projection.root}
            rangeSize={projection.rangeSize}
            spanFrom={spanRange.from}
            spanTo={spanRange.to}
            sourceStart={range.from}
            sourceEnd={range.to}
            segmentKey={event.id}
            store={store}
            blockId={blockId}
            generation={generation}
            registry={registry}
            parentTagName={parentTagName}
          />
        );
      }
    } else {
      eventContent = event.range.from < state.source.sourceRange.to ? renderNested(event.id) : null;
    }
    rendered.push(
      <React.Fragment key={`${segmentKey}:event:${eventIndex}`}>
        {gapFrom < gapTo
          ? renderPlainParagraphRange(state, store, blockId, generation, registry, `${segmentKey}:gap:${eventIndex}`, gapFrom, gapTo, parentTagName)
          : null}
        {eventContent}
      </React.Fragment>,
    );
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewSlots(store, 1);
  }
  return <>{rendered}</>;
});

function renderManagedParagraphContent(
  store: RendererStore,
  blockId: string,
  state: ManagedParagraphViewState,
  registry: ComponentRegistry,
  renderNested: (nodeId: string) => React.ReactNode,
  parentTagName: string,
): React.ReactElement {
  const projection = store.getParagraphSegmentProjection(blockId);
  if (!projection?.root || projection.eventCount === 0) {
    throw new RangeError("Paragraph segment projection is unavailable");
  }
  const lastEvent = projection.root.lastEvent;
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordViewRecords(store, 1);
  const trailingFrom = lastEvent.type === "paragraph-text"
    ? state.source.sourceRange.to
    : Math.min(lastEvent.range.to, state.source.sourceRange.to);
  const trailing = trailingFrom < state.source.sourceRange.to
    ? renderPlainParagraphRange(
        state,
        store,
        blockId,
        state.source.generation,
        registry,
        `${blockId}:source-tail`,
        trailingFrom,
        state.source.sourceRange.to,
        parentTagName,
      )
    : [];
  return (
    <>
      <ParagraphSegmentProjectionNodeView
        key={`${blockId}:segment-plan`}
        node={projection.root}
        base={0}
        sourceStart={state.source.sourceRange.from}
        sourceEnd={state.source.sourceRange.to}
        segmentKey={blockId}
        store={store}
        blockId={blockId}
        generation={state.source.generation}
        registry={registry}
        parentTagName={parentTagName}
        tailSpanOwnerIndex={projection.tailSpanOwnerIndex}
        spanCount={state.spans.length}
        renderNested={renderNested}
      />
      {trailing ? <React.Fragment key={`${blockId}:source-tail`}>{trailing}</React.Fragment> : null}
    </>
  );
}

export const ManagedParagraphContentView: React.FC<{
  store: RendererStore;
  blockId: string;
  registry: ComponentRegistry;
  renderNested: (nodeId: string) => React.ReactNode;
  parentTagName: string;
}> = React.memo(({ store, blockId, registry, renderNested, parentTagName }) => {
  const node = useRendererNode(store, blockId);
  const state = store.getParagraphBlock(blockId);
  const isFinalized = Boolean(state && state.source.state !== "open");
  React.useEffect(() => {
    if (isFinalized) registry.getRenderInlineContext(true, blockId);
  }, [registry, blockId, isFinalized]);
  if (!node || !state || !node.block) return null;
  return renderManagedParagraphContent(store, blockId, state, registry, renderNested, parentTagName);
});


export const ManagedParagraphBlockView: React.FC<{
  store: RendererStore;
  blockId: string;
  registry: ComponentRegistry;
  renderNested: (nodeId: string) => React.ReactNode;
  renderPresentation?: (nativeView: React.ReactNode) => React.ReactNode;
}> = React.memo(({ store, blockId, registry, renderNested, renderPresentation }) => {
  const node = useRendererNode(store, blockId);
  const state = store.getParagraphBlock(blockId);
  const isFinalized = Boolean(state && state.source.state !== "open");
  React.useEffect(() => {
    if (isFinalized) registry.getRenderInlineContext(true, blockId);
  }, [registry, blockId, isFinalized]);
  if (!node || !state || !node.block) return null;

  const content = renderManagedParagraphContent(store, blockId, state, registry, renderNested, "p");

  const element = <p className="markdown-paragraph">{content}</p>;
  if (!registry.hasElementFilters()) {
    const nativeView = <>{element}</>;
    return renderPresentation ? renderPresentation(nativeView) : nativeView;
  }
  let hostAllowed = false;
  const filtered = registry.filterElement(
    { tagName: "p", properties: { className: "markdown-paragraph" }, blockType: "paragraph" },
    { source: "markdown" },
    () => {
      hostAllowed = true;
      return element;
    },
    () => content,
  );
  if (filtered === null || filtered === undefined) return null;
  const nativeView = React.isValidElement(filtered) ? filtered : <>{filtered}</>;
  return hostAllowed && renderPresentation ? renderPresentation(nativeView) : nativeView;
});
