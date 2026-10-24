declare const __STREAM_MDX_COUNTERS__: boolean;

import type { Block, FootnoteItem, HtmlTreeNode, InlineNode, NodeSnapshot, ParagraphSpanChildSnapshot, PreparedNestedSnapshot, SourceSnapshot } from "@stream-mdx/core";
import { generateBlockId } from "@stream-mdx/core";
import type {
  DocumentPlugin,
  DocumentPluginRegistry,
  FootnoteParagraphSpanTarget,
  FootnoteParagraphTargetDelta,
  FootnoteParagraphTargetBridge,
  FootnoteParagraphTargetUpdate,
} from "../document";
type WorkerFootnoteParagraphTargetBridge = FootnoteParagraphTargetBridge & {
  readonly noFootnoteArtifactsForSource?: SourceSnapshot;
  readonly retainedGenericSourceBefore?: number;
  readonly hasNativeTargets?: boolean;
  readonly recordDocumentRecordsVisited?: (count: number) => void;
};
type DocumentRecordVisit = NonNullable<WorkerFootnoteParagraphTargetBridge["recordDocumentRecordsVisited"]>;

/**
 * Footnotes document plugin
 * - Detects footnote definitions of the form:  [^label]: text... (with indented continuations)
 * - Detects inline refs of the form: [^label]
 * - Assigns numbers by first reference order (stable across updates)
 * - Retags definition paragraphs as 'footnote-def' (hidden)
 * - Appends a final 'footnotes' block with an ordered list of items
 */
export const FootnotesPlugin: DocumentPlugin = {
  name: "footnotes",

  onBegin(ctx) {
    if (!ctx.state.footnotes) {
      const initialState: FootnoteState = {
        labelToNumber: new Map<string, number>(),
        definitions: new Map<string, string>(),
        definitionOrigins: new Map<string, number>(),
        referenceCounts: new Map<string, number>(),
        definitionInlines: new Map<string, InlineNode[]>(),
        inlineParser: ctx.state.inlineParser,
        paragraphTargets: new Map<string, FootnoteParagraphOwnerState>(),
        paragraphDependents: new Map<string, Map<string, Set<number>>>(),
        paragraphTargetEvents: [],
        publishedNumbers: new Map<string, number>(),
        retiredParagraphGenerations: new Map<string, number>(),
      };
      ctx.state.footnotes = initialState;
    } else {
      const existing = ctx.state.footnotes as FootnoteState;
      if (!existing.inlineParser && ctx.state.inlineParser) {
        existing.inlineParser = ctx.state.inlineParser;
      }
    }
  },

  process(ctx) {
    const state = ctx.state.footnotes as FootnoteState;
    const bridge: WorkerFootnoteParagraphTargetBridge | undefined = ctx.footnoteParagraphTargets;
    const recordVisited = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? bridge?.recordDocumentRecordsVisited
      : undefined;
    if (bridge?.noFootnoteArtifactsForSource === ctx.source) {
      for (const ownerId of bridge.removedOwnerIds ?? []) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        retireParagraphOwnerWithoutReferences(state, ownerId);
      }
      mergeParagraphTargetDeltasWithoutReferences(state, bridge.deltas ?? [], recordVisited);
      // This fast path receives only the changed root suffix; HTML-declined quotes retain a consumer-visible root inline field.
      // Native container paths remain child-patch-only and are excluded by the prepared HTML-content guard below.
      const retainedBefore = bridge.retainedGenericSourceBefore;
      if (typeof retainedBefore === "number"
        && Number.isSafeInteger(retainedBefore)
        && retainedBefore >= 0
        && retainedBefore <= ctx.source.length) {
        for (const block of ctx.blocks) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
          const range = block.payload.range;
          if (block.type !== "blockquote"
            || !range
            || !Number.isSafeInteger(range.from)
            || !Number.isSafeInteger(range.to)
            || range.from < 0
            || range.to <= range.from
            || range.to <= retainedBefore
            || range.to > ctx.source.length) continue;
          const prepared = block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
          if (!prepared || !hasPreparedHtmlContent(prepared.children, recordVisited)) continue;
          const inline = collectPreparedInlineNodes(prepared.children, recordVisited);
          const currentInline = block.payload.inline;
          if (Array.isArray(currentInline)
            && currentInline.length === inline.length
            && currentInline.every((node, index) => node === inline[index])) continue;
          block.payload.inline = inline;
        }
      }
      state.hasProvisionalTail = ctx.hasProvisionalTail;
      state.noFootnoteArtifactsSource = ctx.source;
      return undefined;
    }
    for (const ownerId of bridge?.removedOwnerIds ?? []) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      retireParagraphOwner(state, ownerId);
    }
    const targetChanges = mergeParagraphTargetDeltas(state, bridge?.deltas ?? [], recordVisited);
    const changedTargets = targetChanges.targets;
    const changedReferenceLabels = targetChanges.referenceLabels;
    const changedDefinitions = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? collectDefinitionsFromBlocks(ctx.blocks, state, recordVisited)
      : collectDefinitionsFromBlocks(ctx.blocks, state);
    const publicationChanged = state.hasProvisionalTail !== ctx.hasProvisionalTail;
    state.hasProvisionalTail = ctx.hasProvisionalTail;
    const rebuildAllTargets = Boolean(bridge?.rebuild)
      || (bridge?.removedOwnerIds?.length ?? 0) > 0
      || publicationChanged;
    const affectedTargets = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? collectAffectedParagraphTargets(
          state,
          changedTargets,
          changedDefinitions,
          rebuildAllTargets,
          changedReferenceLabels,
          recordVisited,
        )
      : collectAffectedParagraphTargets(
          state,
          changedTargets,
          changedDefinitions,
          rebuildAllTargets,
          changedReferenceLabels,
        );
    const shouldRebuild = !bridge
      || (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && bridge.hasNativeTargets === false)
      || Boolean(bridge.rebuild)
      || (bridge.removedOwnerIds?.length ?? 0) > 0
      || publicationChanged
      || changedDefinitions.size > 0
      || changedReferenceLabels.size > 0;
    let numbers: Map<string, number>;
    if (shouldRebuild) {
      const scopes = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? assignNumbersFromReferencesInBlocks(ctx.blocks, state, state.paragraphTargetEvents, recordVisited)
        : assignNumbersFromReferencesInBlocks(ctx.blocks, state, state.paragraphTargetEvents);
      numbers = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? numberInlineReferences(ctx.blocks, state, scopes, ctx.hasProvisionalTail, recordVisited)
        : numberInlineReferences(ctx.blocks, state, scopes, ctx.hasProvisionalTail);
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        addChangedFootnoteNumberTargets(state, numbers, affectedTargets, recordVisited);
      } else {
        addChangedFootnoteNumberTargets(state, numbers, affectedTargets);
      }
      const paragraphUpdates = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? numberParagraphTargets(
            state,
            scopes,
            numbers,
            ctx.hasProvisionalTail,
            affectedTargets,
            recordVisited,
          )
        : numberParagraphTargets(state, scopes, numbers, ctx.hasProvisionalTail, affectedTargets);
      if (paragraphUpdates.length > 0) bridge?.applyUpdates(paragraphUpdates);
    } else {
      numbers = new Map<string, number>();
      for (const label of state.labelToNumber.keys()) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        if (state.definitions.has(label) && (state.referenceCounts.get(label) ?? 0) > 0) {
          numbers.set(label, numbers.size + 1);
        }
      }
      for (const refresh of bridge?.inlineRefreshes ?? []) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        reapplyCachedFootnoteAnnotations(refresh.previous, refresh.current);
      }
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        addChangedFootnoteNumberTargets(state, numbers, affectedTargets, recordVisited);
      } else {
        addChangedFootnoteNumberTargets(state, numbers, affectedTargets);
      }
    }

    // Build the synthetic footer after the current pass has updated definitions and references.
    const items = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? buildFootnoteItems(state, numbers, recordVisited)
      : buildFootnoteItems(state, numbers);
    state.noFootnoteArtifactsSource = state.labelToNumber.size === 0
      && state.definitions.size === 0
      && state.definitionOrigins.size === 0
      && state.referenceCounts.size === 0
      && state.definitionInlines.size === 0
      && state.publishedNumbers.size === 0
      && state.paragraphTargetEvents.length === 0
      && state.paragraphDependents.size === 0
      ? ctx.source
      : undefined;
    if (items.length === 0) return undefined;
    const rawSignature = JSON.stringify(items.map((item) => {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      return { n: item.number, l: item.label };
    }));
    const id = generateBlockId(`FOOTNOTES:${rawSignature}`, "footnotes");

    const footnotesBlock: Block = {
      id,
      type: "footnotes",
      isFinalized: true,
      payload: {
        raw: "",
        meta: { items },
      },
    };
    return { syntheticBlocks: [footnotesBlock] };
  },
};

type InlineParserAdapter = { parse: (input: string) => InlineNode[] };

type FootnoteState = {
  labelToNumber: Map<string, number>;
  definitions: Map<string, string>;
  definitionOrigins: Map<string, number>;
  referenceCounts: Map<string, number>;
  definitionInlines: Map<string, InlineNode[]>;
  inlineParser?: InlineParserAdapter;
  paragraphTargets: Map<string, FootnoteParagraphOwnerState>;
  paragraphDependents: Map<string, Map<string, Set<number>>>;
  paragraphTargetEvents: ParagraphTargetReferenceEvent[];
  publishedNumbers: Map<string, number>;
  retiredParagraphGenerations: Map<string, number>;
  hasProvisionalTail?: boolean;
  noFootnoteArtifactsSource?: SourceSnapshot;
};

interface FootnoteParagraphSpanState extends FootnoteParagraphSpanTarget {
  readonly references: readonly string[];
  readonly positions: ReadonlyMap<string, number>;
  readonly childReferences?: ReadonlyMap<string, readonly string[]>;
}
const EMPTY_FOOTNOTE_REFERENCES: readonly string[] = Object.freeze([]);
const EMPTY_FOOTNOTE_POSITIONS: ReadonlyMap<string, number> = new Map();


interface FootnoteParagraphOwnerState {
  readonly generation: number;
  readonly spans: Map<number, FootnoteParagraphSpanState>;
  readonly referenceCounts: Map<string, number>;
  readonly eventsBySpan: Map<number, readonly ParagraphTargetReferenceEvent[]>;
  maxSpanIndex: number;
}

type ParagraphTargetReferenceEvent = {
  readonly ownerId: string;
  readonly from: number;
  readonly index: number;
  readonly references: readonly string[];
  readonly snapshot?: ParagraphSpanChildSnapshot;
};

function compareParagraphTargetEvents(
  left: ParagraphTargetReferenceEvent,
  right: ParagraphTargetReferenceEvent,
): number {
  if (left.from !== right.from) return left.from - right.from;
  if (left.index !== right.index) return left.index - right.index;
  return left.ownerId < right.ownerId ? -1 : left.ownerId > right.ownerId ? 1 : 0;
}

function paragraphTargetEventIndex(
  events: readonly ParagraphTargetReferenceEvent[],
  target: ParagraphTargetReferenceEvent,
): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compareParagraphTargetEvents(events[middle]!, target) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function removeParagraphTargetEvents(state: FootnoteState, ownerId: string, spanIndex: number): void {
  const owner = state.paragraphTargets.get(ownerId);
  const events = owner?.eventsBySpan.get(spanIndex);
  if (!owner || !events) return;
  for (const target of events) {
    const insertion = paragraphTargetEventIndex(state.paragraphTargetEvents, target);
    for (let index = insertion; index < state.paragraphTargetEvents.length
      && compareParagraphTargetEvents(state.paragraphTargetEvents[index]!, target) === 0; index += 1) {
      if (state.paragraphTargetEvents[index] !== target) continue;
      state.paragraphTargetEvents.splice(index, 1);
      break;
    }
  }
  owner.eventsBySpan.delete(spanIndex);
}

function addParagraphTargetEvents(
  state: FootnoteState,
  owner: FootnoteParagraphOwnerState,
  ownerId: string,
  span: FootnoteParagraphSpanState,
): void {
  const events: ParagraphTargetReferenceEvent[] = [];
  if (span.children?.length) {
    for (const child of span.children) {
      const references = span.childReferences?.get(child.id);
      if (references?.length) events.push({ ownerId, from: child.range.from, index: span.index, references, snapshot: child });
    }
  } else if (span.references.length > 0) {
    events.push({ ownerId, from: span.sourceRange.from, index: span.index, references: span.references });
  }
  if (events.length === 0) return;
  const frozenEvents = Object.freeze(events);
  owner.eventsBySpan.set(span.index, frozenEvents);
  for (const target of frozenEvents) {
    const insertion = paragraphTargetEventIndex(state.paragraphTargetEvents, target);
    state.paragraphTargetEvents.splice(insertion, 0, target);
  }
}

function collectParagraphHtmlReferences(tree: readonly HtmlTreeNode[], references: string[]): void {
  for (const node of tree) {
    if (node.kind === "text") {
      if (node.inline) collectParagraphReferences(node.inline, references);
    } else if (node.kind === "element" || node.kind === "component") {
      if (node.kind === "element" && node.inlineNode?.kind === "footnote-ref") collectParagraphReferences([node.inlineNode], references);
      collectParagraphHtmlReferences(node.children, references);
    } else if (node.block.payload.inline) {
      collectParagraphReferences(node.block.payload.inline, references);
    }
  }
}

function collectParagraphSnapshotReferences(snapshot: NodeSnapshot, references: string[]): void {
  const block = snapshot.props?.block as Block | undefined;
  const tree = (snapshot.props?.htmlParagraphTree ?? snapshot.props?.htmlTree
    ?? block?.payload.meta?.htmlParagraphTree ?? block?.payload.meta?.htmlTree) as HtmlTreeNode[] | undefined;
  if (Array.isArray(tree)) {
    collectParagraphHtmlReferences(tree, references);
  } else if (Array.isArray(snapshot.props?.inline)) {
    collectParagraphReferences(snapshot.props.inline as InlineNode[], references);
  } else if (block?.payload.inline) {
    collectParagraphReferences(block.payload.inline, references);
  }
  for (const child of snapshot.children ?? []) collectParagraphSnapshotReferences(child, references);
}

function collectParagraphReferences(nodes: readonly InlineNode[], references: string[]): void {
  for (const node of nodes) {
    if (node.kind === "footnote-ref") references.push(node.label);
    if (hasInlineChildren(node)) collectParagraphReferences(node.children, references);
  }
}

function removeParagraphSpanDependencies(
  state: FootnoteState,
  ownerId: string,
  span: FootnoteParagraphSpanState,
): void {
  for (const label of span.references) {
    const owners = state.paragraphDependents.get(label);
    const indices = owners?.get(ownerId);
    indices?.delete(span.index);
    if (indices?.size === 0) owners?.delete(ownerId);
    if (owners?.size === 0) state.paragraphDependents.delete(label);
  }
}

function addParagraphSpanDependencies(
  state: FootnoteState,
  ownerId: string,
  span: FootnoteParagraphSpanState,
): void {
  for (const label of span.references) {
    let owners = state.paragraphDependents.get(label);
    if (!owners) {
      owners = new Map();
      state.paragraphDependents.set(label, owners);
    }
    let indices = owners.get(ownerId);
    if (!indices) {
      indices = new Set<number>();
      owners.set(ownerId, indices);
    }
    indices.add(span.index);
  }
}

function removeParagraphOwner(state: FootnoteState, ownerId: string): void {
  const owner = state.paragraphTargets.get(ownerId);
  if (!owner) return;
  for (const index of owner.eventsBySpan.keys()) removeParagraphTargetEvents(state, ownerId, index);
  for (const span of owner.spans.values()) removeParagraphSpanDependencies(state, ownerId, span);
  state.paragraphTargets.delete(ownerId);
}

function retireParagraphOwner(state: FootnoteState, ownerId: string): void {
  const owner = state.paragraphTargets.get(ownerId);
  if (owner) {
    const retiredGeneration = state.retiredParagraphGenerations.get(ownerId) ?? -1;
    state.retiredParagraphGenerations.set(ownerId, Math.max(retiredGeneration, owner.generation));
  }
  removeParagraphOwner(state, ownerId);
}
function retireParagraphOwnerWithoutReferences(state: FootnoteState, ownerId: string): void {
  const owner = state.paragraphTargets.get(ownerId);
  if (!owner) return;
  const retiredGeneration = state.retiredParagraphGenerations.get(ownerId) ?? -1;
  state.retiredParagraphGenerations.set(ownerId, Math.max(retiredGeneration, owner.generation));
  state.paragraphTargets.delete(ownerId);
}


function rebuildParagraphOwnerPositions(owner: FootnoteParagraphOwnerState): void {
  const counts = new Map<string, number>();
  const spans = Array.from(owner.spans.values()).sort((left, right) => left.index - right.index);
  for (const span of spans) {
    const positions = new Map<string, number>();
    for (const label of span.references) {
      const count = counts.get(label) ?? 0;
      if (!positions.has(label)) positions.set(label, count);
      counts.set(label, count + 1);
    }
    owner.spans.set(span.index, { ...span, positions });
  }
  owner.referenceCounts.clear();
  for (const [label, count] of counts) owner.referenceCounts.set(label, count);
}

function mergeParagraphTargetDeltas(
  state: FootnoteState,
  deltas: readonly FootnoteParagraphTargetDelta[],
  recordVisited?: DocumentRecordVisit,
): { targets: Map<string, Set<number>>; referenceLabels: Set<string> } {
  const changed = new Map<string, Set<number>>();
  const referenceLabels = new Set<string>();
  for (const delta of deltas) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const retiredGeneration = state.retiredParagraphGenerations.get(delta.ownerId);
    if (retiredGeneration !== undefined) {
      if (delta.generation <= retiredGeneration) continue;
      state.retiredParagraphGenerations.delete(delta.ownerId);
    }
    let owner = state.paragraphTargets.get(delta.ownerId);
    if (owner && delta.generation < owner.generation) continue;
    if (owner && owner.generation !== delta.generation) {
      for (const span of owner.spans.values()) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        for (const label of span.references) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
          referenceLabels.add(label);
        }
      }
      removeParagraphOwner(state, delta.ownerId);
      owner = undefined;
    }
    if (!owner) {
      owner = {
        generation: delta.generation,
        spans: new Map(),
        referenceCounts: new Map(),
        eventsBySpan: new Map(),
        maxSpanIndex: -1,
      };
      state.paragraphTargets.set(delta.ownerId, owner);
    }
    let indices = changed.get(delta.ownerId);
    if (!indices) {
      indices = new Set<number>();
      changed.set(delta.ownerId, indices);
    }
    for (const target of delta.spans) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      const outOfOrder = target.index < owner.maxSpanIndex;
      const previous = owner.spans.get(target.index);
      if (previous && target.sourceRevision < previous.sourceRevision) continue;
      if (previous) {
        removeParagraphTargetEvents(state, delta.ownerId, target.index);
        removeParagraphSpanDependencies(state, delta.ownerId, previous);
        for (const label of previous.references) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
          referenceLabels.add(label);
          const count = owner.referenceCounts.get(label) ?? 0;
          if (count <= 1) owner.referenceCounts.delete(label);
          else owner.referenceCounts.set(label, count - 1);
        }
      }
      const references: string[] = [];
      const childReferences = new Map<string, readonly string[]>();
      if (target.children?.length) {
        for (const child of target.children) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
          const childLabels: string[] = [];
          collectParagraphSnapshotReferences(child, childLabels);
          childReferences.set(child.id, Object.freeze(childLabels));
          references.push(...childLabels);
        }
      } else {
        collectParagraphReferences(target.nodes, references);
      }
      for (const label of references) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        referenceLabels.add(label);
      }
      const positions = new Map<string, number>();
      for (const label of references) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        const count = owner.referenceCounts.get(label) ?? 0;
        if (!positions.has(label)) positions.set(label, count);
        owner.referenceCounts.set(label, count + 1);
      }
      const span: FootnoteParagraphSpanState = {
        ...target,
        references: Object.freeze(references),
        positions,
        ...(childReferences.size > 0 ? { childReferences } : {}),
      };
      owner.spans.set(target.index, span);
      addParagraphTargetEvents(state, owner, delta.ownerId, span);
      addParagraphSpanDependencies(state, delta.ownerId, span);
      if (outOfOrder) rebuildParagraphOwnerPositions(owner);
      owner.maxSpanIndex = Math.max(owner.maxSpanIndex, target.index);
      indices.add(target.index);
    }
  }
  return { targets: changed, referenceLabels };
}
function mergeParagraphTargetDeltasWithoutReferences(
  state: FootnoteState,
  deltas: readonly FootnoteParagraphTargetDelta[],
  recordVisited?: DocumentRecordVisit,
): void {
  for (const delta of deltas) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const retiredGeneration = state.retiredParagraphGenerations.get(delta.ownerId);
    if (retiredGeneration !== undefined) {
      if (delta.generation <= retiredGeneration) continue;
      state.retiredParagraphGenerations.delete(delta.ownerId);
    }
    let owner = state.paragraphTargets.get(delta.ownerId);
    if (owner && delta.generation < owner.generation) continue;
    if (owner && owner.generation !== delta.generation) {
      state.paragraphTargets.delete(delta.ownerId);
      owner = undefined;
    }
    if (!owner) {
      owner = {
        generation: delta.generation,
        spans: new Map(),
        referenceCounts: new Map(),
        eventsBySpan: new Map(),
        maxSpanIndex: -1,
      };
      state.paragraphTargets.set(delta.ownerId, owner);
    }
    for (const target of delta.spans) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      const previous = owner.spans.get(target.index);
      if (previous && target.sourceRevision < previous.sourceRevision) continue;
      owner.eventsBySpan.delete(target.index);
      owner.spans.set(target.index, {
        ...target,
        references: EMPTY_FOOTNOTE_REFERENCES,
        positions: EMPTY_FOOTNOTE_POSITIONS,
      });
      owner.maxSpanIndex = Math.max(owner.maxSpanIndex, target.index);
    }
  }
}



function collectAffectedParagraphTargets(
  state: FootnoteState,
  changedTargets: Map<string, Set<number>>,
  changedDefinitions: ReadonlySet<string>,
  rebuildAll: boolean,
  changedReferenceLabels: ReadonlySet<string>,
  recordVisited?: DocumentRecordVisit,
): Map<string, Set<number>> {
  const affected = new Map<string, Set<number>>();
  const add = (ownerId: string, index: number) => {
    let indices = affected.get(ownerId);
    if (!indices) {
      indices = new Set<number>();
      affected.set(ownerId, indices);
    }
    indices.add(index);
  };
  if (rebuildAll) {
    for (const [ownerId, owner] of state.paragraphTargets) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      for (const span of owner.spans.values()) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        if (span.references.length > 0) add(ownerId, span.index);
      }
    }
    return affected;
  }
  for (const [ownerId, indices] of changedTargets) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const owner = state.paragraphTargets.get(ownerId);
    if (!owner) continue;
    for (const index of indices) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      if ((owner.spans.get(index)?.references.length ?? 0) > 0) add(ownerId, index);
    }
  }
  for (const label of changedDefinitions) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const owners = state.paragraphDependents.get(label);
    if (!owners) continue;
    for (const [ownerId, indices] of owners) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      for (const index of indices) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        add(ownerId, index);
      }
    }
  }
  for (const label of changedReferenceLabels) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const owners = state.paragraphDependents.get(label);
    if (!owners) continue;
    for (const [ownerId, indices] of owners) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      for (const index of indices) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        add(ownerId, index);
      }
    }
  }
  return affected;
}

function addChangedFootnoteNumberTargets(
  state: FootnoteState,
  numbers: Map<string, number>,
  affected: Map<string, Set<number>>,
  recordVisited?: DocumentRecordVisit,
): void {
  const current = new Map<string, number>();
  for (const [label, referenceNumber] of state.labelToNumber) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const number = numbers.get(label) ?? referenceNumber;
    current.set(label, number);
    if (state.publishedNumbers.get(label) === number) continue;
    const owners = state.paragraphDependents.get(label);
    if (!owners) continue;
    for (const [ownerId, indices] of owners) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      let targets = affected.get(ownerId);
      if (!targets) {
        targets = new Set<number>();
        affected.set(ownerId, targets);
      }
      for (const index of indices) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        targets.add(index);
      }
    }
  }
  for (const label of state.publishedNumbers.keys()) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    if (current.has(label)) continue;
    const owners = state.paragraphDependents.get(label);
    if (!owners) continue;
    for (const [ownerId, indices] of owners) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      let targets = affected.get(ownerId);
      if (!targets) {
        targets = new Set<number>();
        affected.set(ownerId, targets);
      }
      for (const index of indices) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        targets.add(index);
      }
    }
  }
  state.publishedNumbers.clear();
  for (const [label, number] of current) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    state.publishedNumbers.set(label, number);
  }
}

function numberParagraphTargets(
  state: FootnoteState,
  scopes: Map<string, FootnoteReferenceScope>,
  numbers: Map<string, number>,
  hasProvisionalTail: boolean,
  affectedTargets: Map<string, Set<number>>,
  recordVisited?: DocumentRecordVisit,
): FootnoteParagraphTargetUpdate[] {
  const updates: FootnoteParagraphTargetUpdate[] = [];
  for (const [ownerId, indices] of affectedTargets) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const owner = state.paragraphTargets.get(ownerId);
    if (!owner) continue;
    const scope = scopes.get(ownerId);
    const ownerUpdates: FootnoteParagraphTargetUpdate["updates"][number][] = [];
    for (const index of Array.from(indices).sort((left, right) => left - right)) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      const span = owner.spans.get(index);
      if (!span) continue;
      if (span.children?.length) {
        const children = mapChanged(span.children, (child) => numberParagraphTargetChild(
          child,
          scopes,
          scope,
          numbers,
          state,
          hasProvisionalTail,
        ));
        if (children === span.children) continue;
        owner.spans.set(index, { ...span, children });
        ownerUpdates.push({
          index,
          expectedSourceRevision: span.sourceRevision,
          nodes: span.nodes,
          children,
          attemptedReferences: span.attemptedReferences,
        });
        continue;
      }
      const nodes = numberParagraphInline(
        span.nodes,
        scope,
        numbers,
        state,
        hasProvisionalTail,
        new Map(span.positions),
      );
      if (nodes === span.nodes) continue;
      owner.spans.set(index, { ...span, nodes });
      ownerUpdates.push({
        index,
        expectedSourceRevision: span.sourceRevision,
        nodes,
        attemptedReferences: span.attemptedReferences,
      });
    }
    if (ownerUpdates.length > 0) updates.push({ ownerId, generation: owner.generation, updates: ownerUpdates });
  }
  return updates;
}

function numberParagraphInline(
  nodes: readonly InlineNode[],
  scope: FootnoteReferenceScope | undefined,
  numbers: Map<string, number>,
  state: FootnoteState,
  hasProvisionalTail: boolean,
  positions: Map<string, number>,
): readonly InlineNode[] {
  if (!scope?.references.size) return nodes;
  const numberNode = (node: InlineNode): InlineNode => {
    let result = node;
    if (hasInlineChildren(node)) {
      const children = mapChanged(node.children, numberNode);
      if (children !== node.children) result = { ...node, children } as InlineNode;
    }
    if (result.kind !== "footnote-ref") return result;
    const position = positions.get(result.label) ?? 0;
    positions.set(result.label, position + 1);
    const occurrence = scope.references.get(result.label)?.[position];
    const number = numbers.get(result.label) ?? state.labelToNumber.get(result.label);
    const defined = !hasProvisionalTail && state.definitions.has(result.label) && occurrence !== undefined;
    if (result.number === number && result.occurrence === occurrence && result.defined === defined) return result;
    const updated = { ...result, defined };
    if (number === undefined) delete updated.number;
    else updated.number = number;
    if (occurrence === undefined) delete updated.occurrence;
    else updated.occurrence = occurrence;
    return updated;
  };
  return mapChanged(nodes, numberNode);
}

function numberParagraphTargetHtmlTree(
  tree: readonly HtmlTreeNode[],
  scope: FootnoteReferenceScope | undefined,
  numbers: Map<string, number>,
  state: FootnoteState,
  hasProvisionalTail: boolean,
): readonly HtmlTreeNode[] {
  return mapChanged(tree, (node, index) => {
    const nodeScope = scope?.html?.[index] ?? scope;
    if (node.kind === "text") {
      const inline = node.inline
        ? numberParagraphInline(node.inline, nodeScope, numbers, state, hasProvisionalTail, new Map())
        : node.inline;
      return inline === node.inline ? node : { ...node, inline: inline ? Array.from(inline) : inline };
    }
    if (node.kind === "element") {
      const children = numberParagraphTargetHtmlTree(node.children, nodeScope, numbers, state, hasProvisionalTail);
      const inlineNode = node.inlineNode
        ? numberParagraphInline([node.inlineNode], nodeScope, numbers, state, hasProvisionalTail, new Map())[0]
        : node.inlineNode;
      return children === node.children && inlineNode === node.inlineNode
        ? node
        : { ...node, children: Array.from(children), ...(inlineNode !== node.inlineNode ? { inlineNode } : {}) };
    }
    return node;
  });
}

function numberParagraphTargetChild(
  child: ParagraphSpanChildSnapshot,
  scopes: Map<string, FootnoteReferenceScope>,
  parentScope: FootnoteReferenceScope | undefined,
  numbers: Map<string, number>,
  state: FootnoteState,
  hasProvisionalTail: boolean,
): ParagraphSpanChildSnapshot {
  const scope = scopes.get(child.id) ?? parentScope;
  const props = child.props ? { ...child.props } : undefined;
  let changed = false;
  if (props && Array.isArray(props.inline)) {
    const inline = numberParagraphInline(props.inline as InlineNode[], scope, numbers, state, hasProvisionalTail, new Map());
    if (inline !== props.inline) {
      props.inline = inline;
      changed = true;
    }
  }
  if (props) {
    for (const key of ["htmlTree", "htmlParagraphTree"]) {
      const tree = props[key];
      if (!Array.isArray(tree)) continue;
      const numbered = numberParagraphTargetHtmlTree(tree as HtmlTreeNode[], scope, numbers, state, hasProvisionalTail);
      if (numbered !== tree) {
        props[key] = numbered;
        changed = true;
      }
    }
  }
  return changed ? { ...child, ...(props ? { props } : {}) } : child;
}

function collectDefinitionsFromBlocks(
  blocks: Block[],
  state: FootnoteState,
  recordVisited?: DocumentRecordVisit,
): Set<string> {
  const changedLabels = new Set<string>();
  const defStartRe = /^\[\^([A-Za-z0-9_-]+)\]:[ \t]*(.*)$/;

  for (let i = 0; i < blocks.length; i++) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const block = blocks[i];
    if (block.type !== "paragraph") continue;
    // Definitions start the paragraph; reject the common case before splitting the whole raw into lines.
    if (!block.payload.raw.startsWith("[^")) continue;
    const lines = block.payload.raw.split("\n");
    if (!defStartRe.test(lines[0])) continue;

    // Every `[^label]:` line starts a definition (GFM allows consecutive definitions without blank lines);
    // other lines continue the current one, indented or lazily.
    const blockFrom = block.payload.range?.from ?? 0;
    const definitions: Array<{ label: string; origin: number; parts: string[] }> = [];
    let lineOffset = 0;
    for (const line of lines) {
      const match = line.match(defStartRe);
      if (match) {
        definitions.push({ label: match[1], origin: blockFrom + lineOffset, parts: [match[2] || ""] });
      } else {
        const current = definitions[definitions.length - 1];
        current.parts.push(line.trim() === "" ? "" : line.replace(/^\s{4}|^\t/, ""));
      }
      lineOffset += line.length + 1;
    }
    const last = definitions[definitions.length - 1];

    // Cross-paragraph continuation: subsequent paragraphs fully indented (or blank)
    let j = i + 1;
    while (j < blocks.length) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      const continuation = blocks[j];
      if (continuation.type !== "paragraph") break;
      const continuationLines = continuation.payload.raw.split("\n");
      const allIndented = continuationLines.filter((line) => line.trim() !== "").every((line) => /^(?:\s{4}|\t).*/.test(line));
      if (!allIndented && continuationLines.some((line) => line.trim() !== "")) break;
      for (const line of continuationLines) {
        if (line.trim() === "") last.parts.push("");
        else last.parts.push(line.replace(/^\s{4}|^\t/, ""));
      }
      continuation.type = "footnote-def";
      continuation.payload.inline = [];
      const continuationFrom = continuation.payload.range?.from ?? 0;
      continuation.id = generateBlockId(`${continuationFrom}:${continuation.type}`, continuation.type);
      j++;
    }
    i = j - 1;

    for (const definition of definitions) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      const content = definition.parts.join("\n").trim();
      const previousOrigin = state.definitionOrigins.get(definition.label);
      if (previousOrigin === undefined) {
        state.definitionOrigins.set(definition.label, definition.origin);
        if (state.definitions.get(definition.label) !== content) changedLabels.add(definition.label);
        state.definitions.set(definition.label, content);
      } else if (previousOrigin === definition.origin) {
        if (state.definitions.get(definition.label) !== content) changedLabels.add(definition.label);
        state.definitions.set(definition.label, content);
      }
    }
    block.type = "footnote-def";
    block.payload.inline = [];
    block.id = generateBlockId(`${blockFrom}:${block.type}`, block.type);
  }
  return changedLabels;
}

interface FootnoteReferenceScope {
  references: Map<string, number[]>;
  items?: FootnoteReferenceScope[];
  header?: FootnoteReferenceScope[];
  rows?: FootnoteReferenceScope[][];
  segments?: FootnoteReferenceScope[];
  html?: FootnoteReferenceScope[];
}

function getActiveHtmlTreeKey(
  meta: Record<string, unknown> | undefined,
): "trustedMdxNativeChildren" | "htmlTree" | "htmlParagraphTree" | undefined {
  if (Array.isArray(meta?.trustedMdxNativeChildren)) return "trustedMdxNativeChildren";
  if (meta?.htmlOwnership === true && Array.isArray(meta.htmlTree)) return "htmlTree";
  if (Array.isArray(meta?.htmlParagraphTree)) return "htmlParagraphTree";
  if (Array.isArray(meta?.htmlTree)) return "htmlTree";
}

function snapshotHtmlTree(snapshot: NodeSnapshot): HtmlTreeNode[] | undefined {
  const props = snapshot.props;
  const propsKey = getActiveHtmlTreeKey(props);
  if (propsKey) return props?.[propsKey] as HtmlTreeNode[];
  const meta = (props?.block as Block | undefined)?.payload.meta;
  const key = getActiveHtmlTreeKey(meta);
  return key ? meta?.[key] as HtmlTreeNode[] : undefined;
}

function assignNumbersFromReferencesInBlocks(
  blocks: Block[],
  state: FootnoteState,
  paragraphTargets: readonly ParagraphTargetReferenceEvent[],
  recordVisited?: DocumentRecordVisit,
) {
  const scopes = new Map<string, FootnoteReferenceScope>();
  state.labelToNumber.clear();
  state.referenceCounts.clear();
  state.definitionInlines.clear();
  const pendingDefinitions: string[] = [];
  const scopeFor = (id: string) => {
    let scope = scopes.get(id);
    if (!scope) {
      scope = { references: new Map() };
      scopes.set(id, scope);
    }
    return scope;
  };
  const recordReference = (label: string, parents: FootnoteReferenceScope[]): void => {
    if (!state.labelToNumber.has(label)) state.labelToNumber.set(label, state.labelToNumber.size + 1);
    const occurrence = (state.referenceCounts.get(label) ?? 0) + 1;
    state.referenceCounts.set(label, occurrence);
    if (occurrence === 1 && state.definitions.has(label) && !state.definitionInlines.has(label)) pendingDefinitions.push(label);
    for (const scope of parents) {
      const occurrences = scope.references.get(label);
      if (occurrences) occurrences.push(occurrence);
      else scope.references.set(label, [occurrence]);
    }
  };
  const scanInline = (nodes: InlineNode[], parents: FootnoteReferenceScope[]) => {
    for (const node of nodes) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      if (node.kind === "footnote-ref") recordReference(node.label, parents);
      if (hasInlineChildren(node)) scanInline(node.children, parents);
    }
  };
  const visitHtml = (tree: HtmlTreeNode[], parents: FootnoteReferenceScope[]): FootnoteReferenceScope[] => tree.map((node) => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const scope: FootnoteReferenceScope = { references: new Map() };
    const owners = [...parents, scope];
    if (node.kind === "text") {
      if (node.inline) scanInline(node.inline, owners);
    } else if (node.kind === "element") {
      // The HAST children own the rendered children; inlineNode.children is a shadow.
      if (node.inlineNode?.kind === "footnote-ref") scanInline([node.inlineNode], owners);
      scope.html = visitHtml(node.children, owners);
    } else if (node.kind === "component") {
      scope.html = visitHtml(node.children, owners);
    } else {
      visitBlock(node.block, owners);
    }
    return scope;
  });
  const visitSnapshot = (snapshot: NodeSnapshot, parents: FootnoteReferenceScope[]): void => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    if (snapshot.type === "code" || snapshot.type === "footnote-def") return;
    const scope = scopeFor(snapshot.id);
    const owners = parents.includes(scope) ? parents : [...parents, scope];
    const block = snapshot.props?.block as Block | undefined;
    const tree = snapshotHtmlTree(snapshot);
    if (Array.isArray(tree)) {
      scope.html = visitHtml(tree, owners);
      return;
    }
    if (snapshot.type === "html") return;
    const children = snapshot.children ?? [];
    const segmented = children.some((child) => child.type.startsWith("list-item-") || child.type.startsWith("paragraph-"));
    if (snapshot.type !== "list" && snapshot.type !== "blockquote" && !segmented) {
      const inline = snapshot.props?.inline ?? block?.payload.inline;
      if (Array.isArray(inline)) scanInline(inline as InlineNode[], owners);
    }
    for (const child of children) visitSnapshot(child, owners);
    if (snapshot.type === "list") scope.items = children.map((child) => scopeFor(child.id));
    if (segmented) scope.segments = children.map((child) => scopeFor(child.id));
    if (snapshot.type === "table") {
      scope.header = children.find((child) => child.type === "table-header")?.children?.map((cell) => scopeFor(cell.id));
      scope.rows = children.find((child) => child.type === "table-body")?.children?.map((row) => (row.children ?? []).map((cell) => scopeFor(cell.id)));
    }
  };
  const visitBlock = (block: Block, parents: FootnoteReferenceScope[]): void => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    if (block.type === "code" || block.type === "footnote-def" || block.type === "footnotes") return;
    const scope = scopeFor(block.id);
    const owners = parents.includes(scope) ? parents : [...parents, scope];
    const meta = block.payload.meta;
    const treeKey = getActiveHtmlTreeKey(meta);
    const tree = treeKey ? (meta?.[treeKey] as HtmlTreeNode[] | undefined) : undefined;
    if (Array.isArray(tree)) {
      scope.html = visitHtml(tree, owners);
      return;
    }
    const prepared = meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (prepared) {
      for (const child of prepared.children) visitSnapshot(child, owners);
      if (block.type === "list") scope.items = prepared.children.map((child) => scopeFor(child.id));
    } else if (block.type === "table") {
      const header = Array.isArray(meta?.header) ? meta.header as InlineNode[][] : [];
      const rows = Array.isArray(meta?.rows) ? meta.rows as InlineNode[][][] : [];
      scope.header = header.map((cell, index) => {
        const cellScope = scopeFor(`${block.id}::th:${index}`);
        scanInline(cell, [...owners, cellScope]);
        return cellScope;
      });
      scope.rows = rows.map((row, rowIndex) => row.map((cell, index) => {
        const cellScope = scopeFor(`${block.id}::td:${rowIndex}:${index}`);
        scanInline(cell, [...owners, cellScope]);
        return cellScope;
      }));
    } else if (Array.isArray(meta?.mixedSegments)) {
      scope.segments = meta.mixedSegments.map((segment: { inline?: InlineNode[] }, index) => {
        const segmentScope = scopeFor(`${block.id}::segment:${index}`);
        if (segment.inline) scanInline(segment.inline, [...owners, segmentScope]);
        return segmentScope;
      });
    } else if (block.type !== "html" && block.payload.inline) {
      scanInline(block.payload.inline, owners);
    }
  };
  const orderedEvents: Array<{ readonly from: number; readonly block: Block } | { readonly from: number; readonly target: ParagraphTargetReferenceEvent }> = [
    ...blocks.map((block) => {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      return { from: block.payload.range?.from ?? Number.POSITIVE_INFINITY, block };
    }),
    ...paragraphTargets.map((target) => {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      return { from: target.from, target };
    }),
  ];
  orderedEvents.sort((left, right) => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(2);
    return left.from - right.from;
  });
  for (const event of orderedEvents) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    if ("block" in event) {
      if (mayReferenceFootnotes(event.block)) visitBlock(event.block, []);
    } else {
      const scope = scopeFor(event.target.ownerId);
      if (event.target.snapshot) visitSnapshot(event.target.snapshot, [scope]);
      else {
        for (const label of event.target.references) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
          recordReference(label, [scope]);
        }
      }
    }
  }
  const queuedDefinitions = new Set(pendingDefinitions);
  const discoverDefinitions = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      if (node.kind === "footnote-ref" && state.definitions.has(node.label) && !queuedDefinitions.has(node.label)) {
        queuedDefinitions.add(node.label);
        pendingDefinitions.push(node.label);
      }
      if (hasInlineChildren(node)) discoverDefinitions(node.children);
    }
  };
  for (let index = 0; index < pendingDefinitions.length; index++) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const label = pendingDefinitions[index];
    const raw = state.definitions.get(label) ?? "";
    let inline: InlineNode[];
    try {
      inline = state.inlineParser?.parse(raw) ?? [{ kind: "text", text: raw }];
    } catch {
      inline = [{ kind: "text", text: raw }];
    }
    state.definitionInlines.set(label, inline);
    discoverDefinitions(inline);
  }
  // Count bodies in the current canonical footer order, not definition discovery order.
  for (const label of state.labelToNumber.keys()) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const inline = state.definitionInlines.get(label);
    if (inline) scanInline(inline, [scopeFor(`footnote-definition:${label}`)]);
  }
  return scopes;
}

function numberInlineReferences(
  blocks: Block[],
  state: FootnoteState,
  scopes: Map<string, FootnoteReferenceScope>,
  hasProvisionalTail: boolean,
  recordVisited?: DocumentRecordVisit,
): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const label of state.labelToNumber.keys()) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    if (state.definitions.has(label) && (state.referenceCounts.get(label) ?? 0) > 0) numbers.set(label, numbers.size + 1);
  }
  const definitionsPublished = !hasProvisionalTail;
  const numberInlineNode = (node: InlineNode, scope: FootnoteReferenceScope, positions: Map<string, number>): InlineNode => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    let result = node;
    if (hasInlineChildren(node)) {
      const children = mapChanged(node.children, (child) => numberInlineNode(child, scope, positions));
      if (children !== node.children) result = { ...node, children } as InlineNode;
    }
    if (result.kind !== "footnote-ref") return result;
    const position = positions.get(result.label) ?? 0;
    positions.set(result.label, position + 1);
    const occurrence = scope.references.get(result.label)?.[position];
    const number = numbers.get(result.label) ?? state.labelToNumber.get(result.label);
    const defined = definitionsPublished && state.definitions.has(result.label) && occurrence !== undefined;
    if (result.number === number && result.occurrence === occurrence && result.defined === defined) return result;
    const updated = { ...result, defined };
    if (number === undefined) delete updated.number;
    else updated.number = number;
    if (occurrence === undefined) delete updated.occurrence;
    else updated.occurrence = occurrence;
    return updated;
  };
  const applyNumbers = (inline: InlineNode[] | undefined, scope: FootnoteReferenceScope | undefined): InlineNode[] | undefined => {
    if (!inline || !scope?.references.size) return inline;
    const positions = new Map<string, number>();
    return mapChanged(inline, (node) => numberInlineNode(node, scope, positions));
  };
  const numbered = new WeakMap<object, object>();
  const numberProps = (props: Record<string, unknown>, scope: FootnoteReferenceScope | undefined): Record<string, unknown> => {
    const fields = numberMeta(props, scope);
    const inline = Array.isArray(props.inline) ? applyNumbers(props.inline as InlineNode[], scope) : props.inline;
    const block = props.block ? numberBlock(props.block as Block) : props.block;
    if (fields === props && inline === props.inline && block === props.block) return props;
    return { ...fields, ...(inline !== props.inline ? { inline } : {}), ...(block !== props.block ? { block } : {}) };
  };
  const numberSnapshot = (snapshot: NodeSnapshot, parentScope?: FootnoteReferenceScope): NodeSnapshot => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const cached = numbered.get(snapshot) as NodeSnapshot | undefined;
    if (cached) return cached;
    const scope = scopes.get(snapshot.id) ?? parentScope;
    const props = snapshot.props ? numberProps(snapshot.props, scope) : snapshot.props;
    const meta = snapshot.meta ? numberMeta(snapshot.meta, scope) : snapshot.meta;
    const children = snapshot.children ? mapChanged(snapshot.children, (child, index) => numberSnapshot(child, scope?.segments?.[index] ?? scope)) : snapshot.children;
    const result = props === snapshot.props && meta === snapshot.meta && children === snapshot.children
      ? snapshot : { ...snapshot, ...(props !== snapshot.props ? { props } : {}), ...(meta !== snapshot.meta ? { meta } : {}), ...(children !== snapshot.children ? { children } : {}) };
    numbered.set(snapshot, result);
    return result;
  };
  const numberHtmlNode = (node: HtmlTreeNode, scope: FootnoteReferenceScope | undefined): HtmlTreeNode => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const cached = numbered.get(node) as HtmlTreeNode | undefined;
    if (cached) return cached;
    let result = node;
    if (node.kind === "text") {
      const inline = applyNumbers(node.inline, scope);
      if (inline !== node.inline) result = { ...node, inline };
    } else if (node.kind === "element") {
      const children = mapChanged(node.children, (child, index) => numberHtmlNode(child, scope?.html?.[index]));
      const inlineNode = node.inlineNode && scope?.references.size ? numberInlineNode(node.inlineNode, scope, new Map()) : node.inlineNode;
      if (children !== node.children || inlineNode !== node.inlineNode) {
        result = { ...node, children, ...(inlineNode !== node.inlineNode ? { inlineNode } : {}) };
      }
    } else if (node.kind === "component") {
      const children = mapChanged(node.children, (child, index) => numberHtmlNode(child, scope?.html?.[index]));
      if (children !== node.children) result = { ...node, children };
    } else {
      const block = numberBlock(node.block);
      if (block !== node.block) result = { ...node, block };
    }
    numbered.set(node, result);
    return result;
  };
  const numberMeta = (meta: Record<string, unknown>, scope: FootnoteReferenceScope | undefined): Record<string, unknown> => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const cached = numbered.get(meta) as Record<string, unknown> | undefined;
    if (cached) return cached;
    let result = meta;
    const set = (key: string, value: unknown) => {
      if (value === meta[key]) return;
      if (result === meta) result = { ...meta };
      result[key] = value;
    };
    if (Array.isArray(meta.mixedSegments)) {
      set("mixedSegments", mapChanged(meta.mixedSegments, (segment: unknown, index) => {
        if (!segment || typeof segment !== "object") return segment;
        const record = segment as Record<string, unknown>;
        if (!Array.isArray(record.inline)) return segment;
        const inline = applyNumbers(record.inline as InlineNode[], scope?.segments?.[index] ?? scope);
        return inline === record.inline ? segment : { ...record, inline };
      }));
    }
    for (const key of ["items", "header"]) {
      const cells = meta[key];
      if (Array.isArray(cells) && cells.every((cell) => Array.isArray(cell))) {
        const cellsScopes = key === "items" ? scope?.items : scope?.header;
        set(key, mapChanged(cells as InlineNode[][], (cell, index) => applyNumbers(cell, cellsScopes?.[index] ?? scope) ?? cell));
      }
    }
    if (Array.isArray(meta.rows) && meta.rows.every((row) => Array.isArray(row))) {
      set("rows", mapChanged(meta.rows as InlineNode[][][], (row, rowIndex) => mapChanged(row, (cell, index) => applyNumbers(cell, scope?.rows?.[rowIndex]?.[index] ?? scope) ?? cell)));
    }
    const treeKey = getActiveHtmlTreeKey(meta);
    if (treeKey) {
      const tree = meta[treeKey];
      if (Array.isArray(tree)) set(treeKey, mapChanged(tree as HtmlTreeNode[], (node, index) => numberHtmlNode(node, scope?.html?.[index])));
    }
    const prepared = meta.preparedNested as PreparedNestedSnapshot | undefined;
    if (prepared) {
      const props = numberProps(prepared.props, scope);
      const children = mapChanged(prepared.children, (child) => numberSnapshot(child, scope));
      set("preparedNested", props === prepared.props && children === prepared.children ? prepared : { ...prepared, props, children });
    }
    numbered.set(meta, result);
    return result;
  };
  const numberBlock = (block: Block): Block => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const cached = numbered.get(block) as Block | undefined;
    if (cached) return cached;
    const scope = scopes.get(block.id);
    let inline = applyNumbers(block.payload.inline, scope);
    const meta = block.payload.meta ? numberMeta(block.payload.meta, scope) : block.payload.meta;
    const prepared = meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (block.type === "blockquote" && prepared
      && (meta !== block.payload.meta || !inline)) {
      inline = collectPreparedInlineNodes(prepared.children, recordVisited);
    }
    const result = inline === block.payload.inline && meta === block.payload.meta
      ? block : { ...block, payload: { ...block.payload, ...(inline !== block.payload.inline ? { inline } : {}), ...(meta !== block.payload.meta ? { meta } : {}) } };
    numbered.set(block, result);
    return result;
  };
  for (let index = 0; index < blocks.length; index++) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const block = blocks[index];
    if (mayReferenceFootnotes(block) || mayContainBlockquote(block)) blocks[index] = numberBlock(block);
  }
  for (const [label, inline] of state.definitionInlines) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    state.definitionInlines.set(label, applyNumbers(inline, scopes.get(`footnote-definition:${label}`)) ?? inline);
  }
  return numbers;
}



/** Detect HTML-bearing generic child views without treating ordinary native quote children as fallback content. */
function hasPreparedHtmlContent(children: NodeSnapshot[], recordVisited?: DocumentRecordVisit): boolean {
  for (const snapshot of children) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const nested = snapshot.props?.block as Block | undefined;
    const meta = nested?.payload.meta;
    if (snapshot.type === "html"
      || snapshot.type.endsWith("-html")
      || Array.isArray(meta?.htmlTree)
      || Array.isArray(meta?.htmlParagraphTree)
      || (meta?.mixedHtmlTrees !== undefined && meta.mixedHtmlTrees !== null)) return true;
    if (Array.isArray(meta?.mixedSegments)) {
      for (const segment of meta.mixedSegments) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        if (!segment || typeof segment !== "object") continue;
        const kind = (segment as Record<string, unknown>).kind;
        if (kind === "html" || kind === "mdx") return true;
      }
    }
    if (snapshot.children && hasPreparedHtmlContent(snapshot.children, recordVisited)) return true;
  }
  return false;
}

function collectPreparedInlineNodes(
  children: NodeSnapshot[],
  recordVisited?: DocumentRecordVisit,
): InlineNode[] {
  const collected: InlineNode[] = [];
  const visitNodes = (nodes: InlineNode[]) => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(nodes.length);
    collected.push(...nodes);
  };
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    visitPreparedInline(children, visitNodes, recordVisited);
  } else {
    visitPreparedInline(children, visitNodes);
  }
  return collected;
}

/** Visit the inline nodes consumed by prepared child views, once and in source order. */
function visitPreparedInline(
  children: NodeSnapshot[],
  visit: (nodes: InlineNode[]) => void,
  recordVisited?: DocumentRecordVisit,
): void {
  const visitBlock = (block: Block): void => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    if (block.type === "code" || block.type === "footnote-def" || block.type === "footnotes") return;
    const meta = block.payload.meta;
    const treeKey = getActiveHtmlTreeKey(meta);
    const tree = treeKey ? (meta?.[treeKey] as HtmlTreeNode[] | undefined) : undefined;
    if (Array.isArray(tree)) {
      visitHtml(tree);
      return;
    }
    const prepared = meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (prepared) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        visitPreparedInline(prepared.children, visit, recordVisited);
      } else {
        visitPreparedInline(prepared.children, visit);
      }
    }
    else if (block.type === "table") {
      for (const cell of (meta?.header as InlineNode[][] | undefined) ?? []) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        visit(cell);
      }
      for (const row of (meta?.rows as InlineNode[][][] | undefined) ?? []) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        for (const cell of row) {
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
          visit(cell);
        }
      }
    } else if (Array.isArray(meta?.mixedSegments)) {
      for (const segment of meta.mixedSegments as { inline?: InlineNode[] }[]) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
        if (segment.inline) visit(segment.inline);
      }
    } else if (block.type !== "html" && block.payload.inline) visit(block.payload.inline);
  };
  const visitHtml = (tree: HtmlTreeNode[]): void => {
    for (const node of tree) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      if (node.kind === "block") visitBlock(node.block);
      else if (node.kind === "text") {
        if (node.inline) visit(node.inline);
      } else if (node.kind === "component") {
        visitHtml(node.children);
      } else if (node.kind === "element" && !["code", "pre", "textarea"].includes(node.tagName.toLowerCase())) {
        if (node.inlineNode?.kind === "footnote-ref") visit([node.inlineNode]);
        visitHtml(node.children);
      }
    }
  };
  for (const snapshot of children) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    if (snapshot.type === "code" || snapshot.type === "footnote-def") continue;
    const nestedChildren = snapshot.children ?? [];
    const segmented = nestedChildren.some((child) => {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
      return child.type.startsWith("list-item-") || child.type.startsWith("paragraph-");
    });
    const block = snapshot.props?.block as Block | undefined;
    const tree = snapshotHtmlTree(snapshot);
    if (Array.isArray(tree)) {
      visitHtml(tree);
      continue;
    }
    if (snapshot.type === "html") {
      if (block) visitBlock(block);
      continue;
    }
    if (snapshot.type !== "list" && snapshot.type !== "blockquote" && !segmented) {
      const inline = snapshot.props?.inline ?? block?.payload.inline;
      if (Array.isArray(inline)) visit(inline as InlineNode[]);
    }
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      visitPreparedInline(nestedChildren, visit, recordVisited);
    } else {
      visitPreparedInline(nestedChildren, visit);
    }
  }
}

/**
 * Footnote-ref inline nodes are only parsed from literal `[^label]` text, and every nested view of a block
 * (prepared children, table cells, segments, HTML ownership trees) is parsed from its own raw. Container
 * marker stripping cannot join `[` and `^`; only HTML entity decoding (`&#91;^1]`) can, which needs `&`.
 * A block whose raw contains neither cannot change numbering state or be renumbered, so whole-document
 * passes skip it.
 */
function mayReferenceFootnotes(block: Block): boolean {
  const raw = block.payload.raw;
  return raw.includes("[^") || raw.includes("&");
}

/**
 * `numberBlock` also rebuilds the missing `inline` of every prepared blockquote it reaches, references or not,
 * including blockquotes nested in lists or HTML ownership trees. Any blockquote's source starts with `>`, and a
 * container's raw includes its nested blocks' source, so a block without `>` holds no blockquote.
 */
function mayContainBlockquote(block: Block): boolean {
  return block.payload.raw.includes(">");
}

/** Copy only a changed array, leaving unrelated prepared code/HTML artifacts shared. */
function mapChanged<T>(values: T[], map: (value: T, index: number) => T): T[];
function mapChanged<T>(values: readonly T[], map: (value: T, index: number) => T): readonly T[];
function mapChanged<T>(values: readonly T[], map: (value: T, index: number) => T): readonly T[] {
  let result: T[] | undefined;
  for (let index = 0; index < values.length; index++) {
    const value = map(values[index], index);
    if (value === values[index]) continue;
    if (!result) result = values.slice();
    result[index] = value;
  }
  return result ?? values;
}

function hasInlineChildren(node: InlineNode): node is InlineNode & { children: InlineNode[] } {
  return Array.isArray((node as { children?: InlineNode[] }).children);
}

type CachedFootnoteReference = {
  readonly number?: number;
  readonly occurrence?: number;
  readonly defined: boolean;
};

function reapplyCachedFootnoteAnnotations(previous: Block, current: Block): boolean {
  if (previous.type !== current.type || previous.payload.raw !== current.payload.raw) return false;
  const inline = reapplyCachedInlineAnnotations(previous.payload.inline, current.payload.inline);
  const previousMeta = previous.payload.meta;
  const currentMeta = current.payload.meta;
  const previousTreeKey = getActiveHtmlTreeKey(previousMeta);
  const currentTreeKey = getActiveHtmlTreeKey(currentMeta);
  let meta = currentMeta;
  if (previousTreeKey && previousTreeKey === currentTreeKey) {
    const previousTree = previousMeta?.[previousTreeKey];
    const currentTree = currentMeta?.[currentTreeKey];
    if (Array.isArray(previousTree) && Array.isArray(currentTree)) {
      const tree = reapplyCachedHtmlTreeAnnotations(previousTree as HtmlTreeNode[], currentTree as HtmlTreeNode[]);
      if (tree !== currentTree) meta = { ...(currentMeta ?? {}), [currentTreeKey]: tree };
    }
  }
  const changed = inline !== current.payload.inline || meta !== currentMeta;
  if (changed) {
    current.payload.inline = inline;
    current.payload.meta = meta;
  }
  return changed;
}

function reapplyCachedInlineAnnotations(
  previous: readonly InlineNode[] | undefined,
  current: InlineNode[] | undefined,
): InlineNode[] | undefined {
  if (!previous || !current) return current;
  const annotations = new Map<string, CachedFootnoteReference[]>();
  let valid = true;
  const collect = (nodes: readonly InlineNode[]) => {
    for (const node of nodes) {
      if (node.kind === "footnote-ref") {
        if (typeof node.defined !== "boolean") {
          valid = false;
          return;
        }
        let entries = annotations.get(node.label);
        if (!entries) {
          entries = [];
          annotations.set(node.label, entries);
        }
        entries.push({ number: node.number, occurrence: node.occurrence, defined: node.defined });
      }
      if (hasInlineChildren(node)) collect(node.children);
      if (!valid) return;
    }
  };
  collect(previous);
  if (!valid || annotations.size === 0) return current;
  const positions = new Map<string, number>();
  const restore = (node: InlineNode): InlineNode => {
    let result = node;
    if (hasInlineChildren(node)) {
      const children = mapChanged(node.children, restore);
      if (children !== node.children) result = { ...node, children } as InlineNode;
    }
    if (result.kind !== "footnote-ref") return result;
    const index = positions.get(result.label) ?? 0;
    positions.set(result.label, index + 1);
    const annotation = annotations.get(result.label)?.[index];
    if (!annotation
      || (result.number === annotation.number
        && result.occurrence === annotation.occurrence
        && result.defined === annotation.defined)) return result;
    const updated = { ...result, defined: annotation.defined };
    if (annotation.number === undefined) delete updated.number;
    else updated.number = annotation.number;
    if (annotation.occurrence === undefined) delete updated.occurrence;
    else updated.occurrence = annotation.occurrence;
    return updated;
  };
  return mapChanged(current, restore);
}

function reapplyCachedHtmlTreeAnnotations(previous: HtmlTreeNode[], current: HtmlTreeNode[]): HtmlTreeNode[] {
  return mapChanged(current, (node, index) => {
    const oldNode = previous[index];
    if (!oldNode || oldNode.kind !== node.kind) return node;
    if (node.kind === "text" && oldNode.kind === "text") {
      const inline = reapplyCachedInlineAnnotations(oldNode.inline, node.inline);
      return inline === node.inline ? node : { ...node, inline };
    }
    if (node.kind === "element" && oldNode.kind === "element") {
      const inlineNode = oldNode.inlineNode && node.inlineNode
        ? reapplyCachedInlineAnnotations([oldNode.inlineNode], [node.inlineNode])?.[0]
        : node.inlineNode;
      const children = reapplyCachedHtmlTreeAnnotations(oldNode.children, node.children);
      if (inlineNode === node.inlineNode && children === node.children) return node;
      return { ...node, children, ...(inlineNode !== node.inlineNode ? { inlineNode } : {}) };
    }
    if (node.kind === "component" && oldNode.kind === "component") {
      const children = reapplyCachedHtmlTreeAnnotations(oldNode.children, node.children);
      return children === node.children ? node : { ...node, children };
    }
    if (node.kind === "block" && oldNode.kind === "block"
      && reapplyCachedFootnoteAnnotations(oldNode.block, node.block)) {
      return { ...node, block: node.block };
    }
    return node;
  });
}

function buildFootnoteItems(
  state: FootnoteState,
  numbers: Map<string, number>,
  recordVisited?: DocumentRecordVisit,
): FootnoteItem[] {
  const items: FootnoteItem[] = [];
  for (const [label, number] of numbers) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) recordVisited?.(1);
    const refCount = state.referenceCounts.get(label) ?? 0;
    const inlines = state.definitionInlines.get(label) ?? [];
    items.push({ number, inlines, label, refCount });
  }
  return items;
}

export function registerFootnotesPlugin(registry: DocumentPluginRegistry) {
  registry.register(FootnotesPlugin);
}
