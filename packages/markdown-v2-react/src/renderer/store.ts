declare const __STREAM_MDX_COUNTERS__: boolean;

import type { CodeBlockSnapshot } from "@stream-mdx/core";
import {
  AppendSourceDocument,
  appendManagedParagraphSpans,
  appendManagedTableRows,
  cloneBlock,
  createBlockSnapshot,
  createManagedParagraphState,
  createManagedTableState,
  extractCodeWrapperAttributes,
  getDefaultCodeWrapperAttributes,
  materializeManagedParagraphBlock,
  materializeManagedTableBlock,
  sanitizeCodeHTML,
  sanitizeHTML,
  updateManagedParagraphSpans,
  updateManagedTableRows,
  type Block,
  type CodeLineRecord,
  type InlineNode,
  type ManagedParagraphPatchResult,
  type ManagedParagraphViewState,
  type ManagedTablePatchResult,
  type ManagedTableViewState,
  type NodePath,
  PATCH_ROOT_ID,
  type NodeSnapshot,
  type ParagraphSpanRecord,
  type ParagraphBlockSnapshot,
  type HtmlTreeNode,
  type Patch,
  type PreparedNestedSnapshot,
  type SetPropsBatchEntry,
  type SourceSnapshot,
  type TableRowRecord,
  type TokenLineV1,
  type MixedContentSegment,
} from "@stream-mdx/core";
import { getPatchKind } from "@stream-mdx/core/perf/patch-batching";
import {
  appendAnchoredPrefixChild,
  appendBlockRangeProjection,
  createAnchoredPrefixPlan,
  createBlockRangeProjection,
  prefixProjectionCapacity,
  truncateAnchoredPrefixChildren,
  type BlockRangeProjection,
} from "./block-range-projection";
import { PARAGRAPH_SPAN_RANGE_SIZE } from "./paragraph-span-range";
import {
  CODE_LINE_RANGE_SIZE,
  appendStoredCodeState,
  createStoredCodeBlockState,
  decorateStoredCodeState,
  finalizeStoredCodeState,
  materializeStoredCodeBlock,
  readStoredCodeLines,
  refreshLegacyCodeSource,
  updateLegacyCodeLineState,
  updateStoredDiffBlockDecorations,
  type CodeBlockViewState,
  type StoreCodeCounters,
  type StoredCodeBlockState,
} from "./code-state";
import { normalizeAllListDepths, normalizeListDepthsForIds } from "./list-utils";
import { registerNodeSubscriptions } from "./node-subscriptions";
import { type CoalescingMetrics, DEFAULT_COALESCE_CONFIG, coalescePatchesWithMetrics } from "./patch-coalescing";
import { TABLE_ROW_RANGE_SIZE } from "./table-row-range";
import type { PrivateRendererStore } from "./store-reset-version";
export interface ParagraphSegmentPlanEvent {
  readonly id: string;
  readonly type: string;
  readonly range: { readonly from: number; readonly to: number };
  readonly order: number;
  readonly nativeChild?: boolean;
  readonly spanFrom?: number;
  readonly spanTo?: number;
}

export interface ParagraphSegmentProjectionLeaf {
  readonly kind: "leaf";
  readonly level: 0;
  readonly eventCount: number;
  readonly events: readonly ParagraphSegmentPlanEvent[];
  readonly firstEvent: ParagraphSegmentPlanEvent;
  readonly lastEvent: ParagraphSegmentPlanEvent;
}

export interface ParagraphSegmentProjectionBranch {
  readonly kind: "branch";
  readonly level: number;
  readonly eventCount: number;
  readonly children: readonly ParagraphSegmentProjectionNode[];
  readonly firstEvent: ParagraphSegmentPlanEvent;
  readonly lastEvent: ParagraphSegmentPlanEvent;
}

export type ParagraphSegmentProjectionNode = ParagraphSegmentProjectionLeaf | ParagraphSegmentProjectionBranch;

export interface ParagraphSegmentProjection {
  readonly root?: ParagraphSegmentProjectionNode;
  readonly eventCount: number;
  readonly tailSpanOwnerIndex?: number;
}


export type { CodeBlockViewState } from "./code-state";

export interface NodeRecord {
  id: string;
  type: string;
  parentId: string | null;
  children: string[];
  props: Record<string, unknown>;
  meta?: Record<string, unknown>;
  range?: { from: number; to: number };
  version: number;
  blockEpoch: number;
  block?: Block;
}
const serializedBlockOwnership = Symbol("serializedBlockOwnership");
type NodeRecordWithSerializedBlock = NodeRecord & { [serializedBlockOwnership]?: boolean };
function hasSerializedBlock(record: NodeRecord): boolean {
  return (record as NodeRecordWithSerializedBlock)[serializedBlockOwnership] === true;
}

export interface ApplyPatchesOptions {
  coalesced?: boolean;
  metrics?: CoalescingMetrics | null;
  captureMetrics?: boolean;
  allowEmpty?: boolean;
}

export interface RendererStoreOptions {
  themes?: { light: string; dark: string };
}

export interface RendererStore {
  reset(blocks: Block[]): void;
  resetSnapshot(snapshot: NodeSnapshot): void;
  applyPatches(patches: Patch[], options?: ApplyPatchesOptions): Set<string>;
  getBlocks(): ReadonlyArray<Block>;
  hasProvisionalBlocks(): boolean;
  getCodeBlock(id: string): CodeBlockViewState | undefined;
  subscribeCodeLines(id: string, from: number, to: number, listener: () => void): () => void;
  getCodeLines(id: string, from: number, to: number): ReadonlyArray<CodeLineRecord>;
  getTableBlock(id: string): ManagedTableViewState | undefined;
  getTableColdBlock(id: string): Block | undefined;
  getTableRows(id: string, from: number, to: number): ReadonlyArray<TableRowRecord>;
  subscribeTableRows(id: string, from: number, to: number, listener: () => void): () => void;
  getParagraphBlock(id: string): ManagedParagraphViewState | undefined;
  getParagraphColdBlock(id: string): Block | undefined;
  getParagraphSpanProjection(id: string): BlockRangeProjection;
  getParagraphSegmentProjection(id: string): ParagraphSegmentProjection | undefined;
  getParagraphSpans(id: string, generation: number, from: number, to: number): ReadonlyArray<ParagraphSpanRecord>;
  subscribeParagraphSpans(id: string, generation: number, from: number, listener: () => void): () => void;
  getVersion(): number;
  getNode(id: string): NodeRecord | undefined;
  getNodeWithVersion(id: string): { version: number; node?: NodeRecord };
  getChildren(id: string): ReadonlyArray<string>;
  getChildrenWithVersion(id: string): { version: number; children: ReadonlyArray<string> };
  getInvariantViolations(): string[];
  getDebugCounters(): Readonly<Record<string, number>>;
  subscribe(listener: () => void): () => void;
  getLastCoalescingMetrics(): CoalescingMetrics | null;
  getThemes(): { light: string; dark: string } | undefined;
  setThemes(themes?: { light: string; dark: string }): void;
}

function snapshotToBlock(node: NodeSnapshot): Block | null {
  const managedSourceNode =
    Boolean(node.code || node.table || node.paragraph) ||
    isManagedSourceFamily(node.type);
  const candidate = node.props?.block;
  if (candidate && typeof candidate === "object") {
    const block = cloneBlock(isNativeContainerType(node.type) ? blockWithoutPreparedNested(candidate as Block) : candidate as Block);
    if (!managedSourceNode) {
      block.payload.range = node.range ? { ...node.range } : undefined;
      const meta = node.meta ? { ...node.meta } : undefined;
      if (isNativeContainerType(node.type) && meta) delete meta.preparedNested;
      block.payload.meta = meta;
    }
    return block;
  }
  if (node.type === "code") {
    return null;
  }
  if (node.type && node.id) {
    const meta = managedSourceNode ? { ...(node.props ?? {}) } : { ...(node.props ?? {}), ...(node.meta ?? {}) };
    if (isNativeContainerType(node.type)) delete meta.preparedNested;
    return {
      id: node.id,
      type: node.type as Block["type"],
      isFinalized: true,
      payload: {
        raw: typeof node.props?.raw === "string" ? node.props.raw : typeof node.props?.text === "string" ? node.props.text : "",
        inline: Array.isArray(node.props?.inline) ? (node.props.inline as InlineNode[]) : undefined,
        range: !managedSourceNode && node.range ? { ...node.range } : undefined,
        meta,
      },
    };
  }
  return null;
}
function normalizeParagraphNodeProps(snapshot: NodeSnapshot): Record<string, unknown> {
  const props = snapshot.props ?? {};
  const { block: _block, raw: _raw, inline: _inline, ...paragraphProps } = props;
  return paragraphProps;
}
function normalizeParagraphNodeMeta(snapshot: NodeSnapshot): Record<string, unknown> | undefined {
  const blockMeta = (snapshot.props?.block as Block | undefined)?.payload?.meta;
  if (snapshot.meta !== undefined || blockMeta !== undefined) {
    const meta = { ...(snapshot.meta ?? {}), ...(blockMeta ?? {}) };
    return snapshot.meta !== undefined || Object.keys(meta).length > 0 ? meta : undefined;
  }
  const props = normalizeParagraphNodeProps(snapshot);
  return Object.keys(props).length > 0 ? props : undefined;
}



interface ParagraphSpanRangeSubscription {
  readonly from: number;
  readonly to: number;
  readonly listeners: Set<() => void>;
  readonly listenerGenerations: Map<() => void, number>;
  spans?: ReadonlyArray<ParagraphSpanRecord>;
  generation?: number;
}



type NodeMap = Map<string, NodeRecord>;
interface RendererInputSource {
  readonly generation: number;
  readonly document: AppendSourceDocument;
}

const inputSourceByNodeMap = new WeakMap<ReadonlyMap<string, NodeRecord>, RendererInputSource>();

function inputSourceSnapshotForMap(map: ReadonlyMap<string, NodeRecord>): SourceSnapshot | undefined {
  return inputSourceByNodeMap.get(map)?.document.snapshot();
}

/**
 * Source-projected record views. They close over the map and input source they were projected from, so
 * `buildNodeFromSnapshot` drops them whenever it carries a record into a (possibly new) map; see `forgetSourceProjections`.
 */
interface SourceProjectedRecordView {
  readonly version: number;
  readonly view: NodeRecord;
}
const nativeContainerNodeRecordViews = new WeakMap<NodeRecord, SourceProjectedRecordView>();
const unmanagedLeafRecordViews = new WeakMap<NodeRecord, SourceProjectedRecordView>();
const coldNativeContainerBlocks = new WeakMap<NodeRecord, { readonly version: number; readonly block: Block }>();
interface EffectiveEpochRecordView {
  readonly version: number;
  readonly effectiveEpoch: number;
  readonly baseView: NodeRecord;
  readonly view: NodeRecord;
}
const effectiveEpochNodeRecordViews = new WeakMap<NodeRecord, EffectiveEpochRecordView>();

/** A reused record must neither read nor keep alive a projection over its previous map and source. */
function forgetSourceProjections(record: NodeRecord): void {
  nativeContainerNodeRecordViews.delete(record);
  unmanagedLeafRecordViews.delete(record);
  coldNativeContainerBlocks.delete(record);
  effectiveEpochNodeRecordViews.delete(record);
}
/**
 * Where a native container's producer supplied a `preparedNested` layout: on its block, its snapshot meta, or both.
 * The tree itself is not retained: generic children own the hierarchy, and live reads project the current tree from
 * them on demand. Admitted meta never changes afterwards, so only the block flag follows later block updates.
 */
interface NativePreparedLayout {
  readonly block: boolean;
  readonly meta: boolean;
}
const nativePreparedLayoutByRecord = new WeakMap<NodeRecord, NativePreparedLayout>();

function isNativeContainerType(type: string): boolean {
  return type === "list" || type === "blockquote" || type === "list-item";
}

function isManagedSourceFamily(type: string): boolean {
  return type === "code" ||
    type.startsWith("code-") ||
    type === "table" ||
    type.startsWith("table-") ||
    type.startsWith("paragraph-");
}

function blockWithExactCanonicalMetadata(block: Block, meta: Record<string, unknown> | undefined): Block {
  if (plainDataEqual(block.payload.meta, meta)) return block;
  const payloadDescriptors = Object.getOwnPropertyDescriptors(block.payload);
  payloadDescriptors.meta = {
    configurable: true,
    enumerable: true,
    writable: true,
    value: meta ? { ...meta } : undefined,
  };
  return { ...block, payload: Object.defineProperties({}, payloadDescriptors) as Block["payload"] };
}

/** Drops a producer's prepared tree by shallow copy, so the tree is never cloned into a private record. */
function blockWithoutPreparedNested(block: Block): Block {
  const meta = block.payload.meta;
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, "preparedNested")) return block;
  const { preparedNested: _preparedNested, ...rest } = meta;
  return { ...block, payload: { ...block.payload, meta: rest } };
}
/** Adds canonical node metadata omitted by the producer's generic Block projection. */
function blockWithCanonicalMetadata(block: Block, canonicalMeta?: Record<string, unknown>): Block {
  if (!canonicalMeta) return block;
  const blockMeta = block.payload.meta;
  for (const key in canonicalMeta) {
    if (
      Object.prototype.hasOwnProperty.call(canonicalMeta, key) &&
      (!blockMeta || !Object.prototype.hasOwnProperty.call(blockMeta, key))
    ) {
      const payloadDescriptors = Object.getOwnPropertyDescriptors(block.payload);
      payloadDescriptors.meta = {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { ...canonicalMeta, ...(blockMeta ?? {}) },
      };
      return { ...block, payload: Object.defineProperties({}, payloadDescriptors) as Block["payload"] };
    }
  }
  return block;
}
function blockWithCanonicalInline(block: Block, value: unknown): Block {
  if (!Array.isArray(value)) return block;
  const inline = value as InlineNode[];
  const blockMeta = block.payload.meta;
  const updatePayloadInline = block.payload.inline !== inline;
  const updateMetaInline = Boolean(
    blockMeta &&
    Object.prototype.hasOwnProperty.call(blockMeta, "inline") &&
    blockMeta.inline !== inline,
  );
  if (!updatePayloadInline && !updateMetaInline) return block;
  const payloadDescriptors = Object.getOwnPropertyDescriptors(block.payload);
  if (updatePayloadInline) {
    payloadDescriptors.inline = {
      configurable: true,
      enumerable: true,
      writable: true,
      value: inline,
    };
  }
  if (updateMetaInline) {
    payloadDescriptors.meta = {
      configurable: true,
      enumerable: true,
      writable: true,
      value: { ...blockMeta, inline },
    };
  }
  return { ...block, payload: Object.defineProperties({}, payloadDescriptors) as Block["payload"] };
}


interface LegacyListLayout {
  readonly ordered: boolean;
  readonly loose: boolean;
  readonly start?: number;
}

interface LegacyPrimaryParagraph {
  readonly record: NodeRecord;
  readonly block: Block;
  readonly inline: InlineNode[];
}

function legacyListLayout(record: NodeRecord): LegacyListLayout {
  const blockMeta = record.block?.payload.meta;
  const value = (key: "ordered" | "loose" | "start"): unknown => {
    if (Object.prototype.hasOwnProperty.call(record.props, key)) return record.props[key];
    if (record.meta && Object.prototype.hasOwnProperty.call(record.meta, key)) return record.meta[key];
    return blockMeta?.[key];
  };
  const ordered = Boolean(value("ordered"));
  const start = value("start");
  return {
    ordered,
    loose: Boolean(value("loose")),
    start: ordered && typeof start === "number" && start !== 1 ? start : undefined,
  };
}

function copyInlineNodes(nodes: readonly InlineNode[]): InlineNode[] {
  return nodes.map((node) => {
    if ("children" in node && Array.isArray(node.children)) {
      return { ...node, children: copyInlineNodes(node.children) };
    }
    return { ...node };
  });
}

function legacyInlineText(nodes: readonly InlineNode[]): string {
  let text = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
      case "code":
        text += node.text;
        break;
      case "strong":
      case "em":
      case "strike":
      case "link":
        text += legacyInlineText(node.children);
        break;
      case "html":
        if (node.children) text += legacyInlineText(node.children);
        break;
      case "plugin":
        text += node.children ? legacyInlineText(node.children) : node.raw;
        break;
      case "footnote-ref":
        text += `[^${node.label}]`;
        break;
      case "image":
        text += node.alt ?? "";
        break;
      default:
        break;
    }
  }
  return text;
}

function managedParagraphLegacyInline(paragraph: ParagraphBlockSnapshot): InlineNode[] {
  const inline: InlineNode[] = [];
  for (const span of paragraph.spans) {
    if (!span.children?.length) {
      inline.push(...copyInlineNodes(span.nodes));
      continue;
    }
    for (const child of span.children) {
      const props = child.props ?? {};
      if (child.type === "paragraph-text") {
        if (Array.isArray(props.inline)) inline.push(...copyInlineNodes(props.inline as InlineNode[]));
        else if (typeof props.text === "string") inline.push({ kind: "text", text: props.text });
      } else if (child.type === "paragraph-html" && typeof props.raw === "string") {
        inline.push({
          kind: "html",
          raw: props.raw,
          ...(child.meta?.sanitized === true && typeof props.html === "string" ? { sanitized: props.html } : {}),
        });
      }
    }
  }
  return inline;
}

function legacyPrimaryParagraph(
  map: NodeMap,
  item: NodeRecord,
  source?: SourceSnapshot,
): LegacyPrimaryParagraph | undefined {
  if (item.type !== "list-item") return undefined;
  for (const childId of item.children) {
    const record = map.get(childId);
    const state = record?.type === "paragraph" && record.props.listItemPrimary === true
      ? paragraphStateByRecord.get(record)
      : undefined;
    if (!record || !state) continue;
    const block = coldBlockForStoreNode(map, record, source);
    const paragraph = block?.payload.meta?.paragraph as ParagraphBlockSnapshot | undefined;
    if (!block || !paragraph) return undefined;
    return { record, block, inline: managedParagraphLegacyInline(paragraph) };
  }
  return undefined;
}

function listItemSegmentSnapshot(
  parentId: string,
  segment: MixedContentSegment,
  index: number,
  htmlTree?: HtmlTreeNode[],
): NodeSnapshot {
  const id = `${parentId}::list-item:segment:${index}`;
  const range = segment.range ? { ...segment.range } : undefined;
  if (segment.kind === "text") {
    return {
      id,
      type: "list-item-text",
      props: { text: segment.value, inline: segment.inline ? copyInlineNodes(segment.inline) : undefined },
      ...(range ? { range } : {}),
      children: [],
    };
  }
  if (segment.kind === "html") {
    return {
      id,
      type: "list-item-html",
      props: {
        raw: segment.value,
        html: segment.sanitized ?? segment.value,
        ...(htmlTree !== undefined ? { htmlTree } : {}),
      },
      ...(segment.sanitized ? { meta: { sanitized: true } } : {}),
      ...(range ? { range } : {}),
      children: [],
    };
  }
  return {
    id,
    type: "list-item-mdx",
    props: { raw: segment.value },
    ...(range ? { range } : {}),
    children: [],
  };
}

function hasManagedPrimaryListChild(map: NodeMap, list: NodeRecord): boolean {
  for (const itemId of list.children) {
    const item = map.get(itemId);
    if (item?.type !== "list-item") continue;
    for (const childId of item.children) {
      const child = map.get(childId);
      if (child?.type === "paragraph" && child.props.listItemPrimary === true && paragraphStateByRecord.has(child)) return true;
    }
  }
  return false;
}

function projectLegacyListItemBlock(block: Block, paragraph: Block, inline: InlineNode[]): Block {
  const result = cloneBlock(block);
  const meta = { ...(result.payload.meta ?? {}) };
  delete meta.paragraph;
  delete meta.mixedSegments;
  delete meta.mixedHtmlTrees;
  const paragraphMeta = paragraph.payload.meta;
  if (Array.isArray(paragraphMeta?.mixedSegments)) {
    meta.mixedSegments = paragraphMeta.mixedSegments;
    if (paragraphMeta.mixedHtmlTrees !== undefined) meta.mixedHtmlTrees = paragraphMeta.mixedHtmlTrees;
  }
  result.payload.inline = copyInlineNodes(inline);
  result.payload.meta = meta;
  return result;
}

function storePreparedNested(
  map: NodeMap,
  record: NodeRecord,
  source?: SourceSnapshot,
  legacyProjection = false,
  inheritedListLayout?: LegacyListLayout,
  primaryParagraph?: LegacyPrimaryParagraph,
): PreparedNestedSnapshot {
  const listLayout = record.type === "list" ? legacyListLayout(record) : inheritedListLayout;
  const itemLayout = record.type === "list-item"
    ? listLayout ?? { ordered: false, loose: false }
    : listLayout;
  const primary = legacyProjection && record.type === "list-item"
    ? primaryParagraph ?? legacyPrimaryParagraph(map, record, source)
    : undefined;
  const props = nodePropsForSnapshot(record, source);
  if (legacyProjection && record.type === "list-item") {
    props.ordered = itemLayout?.ordered ?? false;
    props.loose = itemLayout?.loose ?? false;
    props.start = itemLayout?.start;
    if (primary) {
      props.inline = copyInlineNodes(primary.inline);
      props.text = legacyInlineText(primary.inline);
    }
  }
  const children: NodeSnapshot[] = [];
  const mixedSegments = primary?.block.payload.meta?.mixedSegments;
  const mixedHtmlTrees = primary?.block.payload.meta?.mixedHtmlTrees as Record<number, HtmlTreeNode[]> | undefined;
  if (legacyProjection && Array.isArray(mixedSegments)) {
    for (let index = 0; index < mixedSegments.length; index += 1) {
      const segment = mixedSegments[index] as MixedContentSegment | undefined;
      if (segment) children.push(listItemSegmentSnapshot(record.id, segment, index, mixedHtmlTrees?.[index]));
    }
  }
  for (const childId of record.children) {
    if (legacyProjection && primary?.record.id === childId) continue;
    const child = map.get(childId);
    if (!child) continue;
    if (legacyProjection && primary && child.id.startsWith(`${record.id}::list-item:segment:`)) continue;
    const snapshot = storeNodeSnapshot(map, child, source, legacyProjection, itemLayout);
    if (snapshot) {
      if (legacyProjection && record.type === "list-item" && child.type === "paragraph" && child.props.listItemPrimary !== true) {
        snapshot.props = { ...snapshot.props, tight: !itemLayout?.loose };
      }
      children.push(snapshot);
    }
  }
  return { props, children };
}


/** Exposes the record's current generic hierarchy as `preparedNested`, projected only when a reader asks for it. */
function blockWithCurrentPreparedNested(map: NodeMap, record: NodeRecord, block: Block): Block {
  const prepared = Object.defineProperties({}, {
    props: { enumerable: true, get: () => nodePropsForSnapshot(record, inputSourceSnapshotForMap(map)) },
    children: { enumerable: true, get: () => storePreparedNested(map, record, inputSourceSnapshotForMap(map)).children },
  }) as PreparedNestedSnapshot;
  const payloadDescriptors = Object.getOwnPropertyDescriptors(block.payload);
  payloadDescriptors.meta = {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { ...(block.payload.meta ?? {}), preparedNested: prepared },
  };
  return { ...block, payload: Object.defineProperties({}, payloadDescriptors) as Block["payload"] };
}

function parseSourceRange(value: unknown, sourceLength?: number): { from: number; to: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("from" in value) || !("to" in value)) {
    return null;
  }
  const { from, to } = value;
  if (
    typeof from !== "number" ||
    typeof to !== "number" ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    (sourceLength !== undefined && (from > sourceLength || to > sourceLength))
  ) {
    return null;
  }
  return { from, to };
}

function blockWithSourceRange(
  block: Block,
  range: { readonly from: number; readonly to: number },
  source?: SourceSnapshot,
): Block {
  const payloadDescriptors = Object.getOwnPropertyDescriptors(block.payload);
  payloadDescriptors.range = {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { from: range.from, to: range.to },
  };
  if (source) {
    payloadDescriptors.raw = {
      configurable: true,
      enumerable: true,
      get: () => source.read(range.from, range.to),
    };
  }
  const payload = Object.defineProperties({}, payloadDescriptors) as Block["payload"];
  return { ...block, payload };
}

function propsWithSourceRange(
  props: Record<string, unknown>,
  range: { readonly from: number; readonly to: number },
  source: SourceSnapshot,
): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(props);
  if (Object.prototype.hasOwnProperty.call(props, "raw")) {
    descriptors.raw = {
      configurable: true,
      enumerable: true,
      get: () => source.read(range.from, range.to),
    };
  }
  return Object.defineProperties({}, descriptors) as Record<string, unknown>;
}

function nativeContainerProjectionRoot(map: NodeMap, id: string): NodeRecord | undefined {
  let record = map.get(id);
  while (record && record.parentId && record.parentId !== PATCH_ROOT_ID) {
    record = map.get(record.parentId);
  }
  return record && isNativeContainerType(record.type) ? record : undefined;
}

function invalidateNativeContainerProjection(map: NodeMap, id: string): void {
  const root = nativeContainerProjectionRoot(map, id);
  if (root) coldNativeContainerBlocks.delete(root);
}

const paragraphStateByRecord = new WeakMap<NodeRecord, ManagedParagraphViewState>();
const retiredParagraphGenerationsByMap = new WeakMap<ReadonlyMap<string, NodeRecord>, Map<string, number>>();
const coldParagraphBlocksByView = new WeakMap<ManagedParagraphViewState, Block>();
const paragraphNodeRecordViews = new WeakMap<NodeRecord, {
  readonly version: number;
  readonly state: ManagedParagraphViewState;
  readonly meta?: Record<string, unknown>;
  readonly view: NodeRecord;
}>();

function paragraphNodeBlock(record: NodeRecord, state: ManagedParagraphViewState): Block {
  const payload = Object.defineProperties(
    {
      range: { ...state.source.sourceRange },
      meta: record.meta as Block["payload"]["meta"],
    },
    {
      raw: {
        enumerable: true,
        get: () => state.sourceSnapshot.materialize(),
      },
      inline: {
        enumerable: true,
        get: () => {
          const inline: InlineNode[] = [];
          for (let index = 0; index < state.spans.length; index += 1) {
            const span = state.spans.get(index);
            if (span) inline.push(...span.nodes);
          }
          return inline;
        },
      },
    },
  ) as unknown as Block["payload"];
  return {
    id: record.id,
    type: "paragraph",
    isFinalized: state.source.state !== "open",
    payload,
  };
}
const canonicalBlockNodeRecordViews = new WeakMap<NodeRecord, {
  readonly version: number;
  readonly props: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
  readonly block: Block;
  readonly view: NodeRecord;
}>();

function nodeRecordWithCanonicalBlock(record: NodeRecord): NodeRecord {
  const block = record.block;
  const props = record.props;
  const meta = record.meta;
  if (!block) return record;
  const cached = canonicalBlockNodeRecordViews.get(record);
  if (
    cached?.version === record.version &&
    cached.props === props &&
    cached.meta === meta &&
    cached.block === block
  ) return cached.view;
  const projectedBlock = blockWithCanonicalInline(
    blockWithCanonicalMetadata(block, meta),
    props.inline,
  );
  if (projectedBlock === block) return record;
  const view = { ...record, block: projectedBlock };
  canonicalBlockNodeRecordViews.set(record, { version: record.version, props, meta, block, view });
  return view;
}


function nodeRecordWithEffectiveEpoch(
  record: NodeRecord,
  view: NodeRecord,
  effectiveEpoch: number,
): NodeRecord {
  const cached = effectiveEpochNodeRecordViews.get(record);
  if (
    cached?.version === record.version &&
    cached.effectiveEpoch === effectiveEpoch &&
    cached.baseView === view
  ) return cached.view;
  // Capture the epoch so later direct writes do not mutate an earlier published read.
  const projected = { ...view, blockEpoch: effectiveEpoch };
  effectiveEpochNodeRecordViews.set(record, {
    version: record.version,
    effectiveEpoch,
    baseView: view,
    view: projected,
  });
  return projected;
}

function nodeRecordForRead(map: NodeMap, record: NodeRecord): NodeRecord {
  const effectiveEpoch = effectiveBlockEpoch(map, record);
  let view: NodeRecord;
  const state = paragraphStateByRecord.get(record);
  if (state) {
    const cached = paragraphNodeRecordViews.get(record);
    if (cached && cached.version === record.version && cached.state === state && cached.meta === record.meta) {
      view = cached.view;
    } else {
      view = { ...record, block: paragraphNodeBlock(record, state) };
      paragraphNodeRecordViews.set(record, { version: record.version, state, meta: record.meta, view });
    }
  } else if (!isManagedSourceFamily(record.type) && !isNativeContainerType(record.type) && record.block && record.range) {
    // An unmanaged leaf's admitted range is its physical source; live reads bind raw to the canonical input.
    const source = inputSourceSnapshotForMap(map);
    if (!source || record.range.to > source.length) {
      view = record;
    } else {
      const cached = unmanagedLeafRecordViews.get(record);
      if (cached?.version === record.version) {
        view = cached.view;
      } else {
        const sourceBlock = blockWithSourceRange(record.block, record.range, source);
        const projectedBlock = blockWithCanonicalInline(
          blockWithCanonicalMetadata(sourceBlock, record.meta),
          record.props.inline,
        );
        view = { ...record, block: projectedBlock };
        unmanagedLeafRecordViews.set(record, { version: record.version, view });
      }
    }
  } else if (!isNativeContainerType(record.type)) {
    view = nodeRecordWithCanonicalBlock(record);
  } else {
    const exposesPreparedNested = nativePreparedLayoutByRecord.has(record) && record.block !== undefined;
    if (!record.range && !exposesPreparedNested) {
      view = record;
    } else {
      const cached = nativeContainerNodeRecordViews.get(record);
      if (cached?.version === record.version) {
        view = cached.view;
      } else {
        const source = inputSourceSnapshotForMap(map);
        const range = record.range ? { ...record.range } : undefined;
        const validSource = source && range && range.to <= source.length ? source : undefined;
        let block = record.block && range ? blockWithSourceRange(record.block, range, validSource) : record.block;
        if (block && exposesPreparedNested) block = blockWithCurrentPreparedNested(map, record, block);
        const props = validSource && range ? propsWithSourceRange(record.props, range, validSource) : record.props;
        view = { ...record, range, props, ...(block ? { block } : {}) };
        nativeContainerNodeRecordViews.set(record, { version: record.version, view });
      }
    }
  }
  return nodeRecordWithEffectiveEpoch(record, view, effectiveEpoch);
}

function paragraphColdBlockBase(record: NodeRecord, state: ManagedParagraphViewState): Block {
  return {
    id: record.id,
    type: "paragraph",
    isFinalized: state.source.state !== "open",
    payload: {
      raw: state.sourceSnapshot.materialize(),
      range: { ...state.source.sourceRange },
      meta: (record.block?.payload.meta ?? record.meta) as Block["payload"]["meta"],
    },
  };
}
const paragraphProjectionByRecord = new WeakMap<NodeRecord, {
  generation: number;
  spanCount: number;
  projection: BlockRangeProjection;
}>();

interface StoredParagraphSegmentProjection extends ParagraphSegmentProjection {
  readonly generation: number;
  readonly childCount: number;
  readonly spanCount?: number;
  readonly lastEvent?: ParagraphSegmentPlanEvent;
  readonly error?: string;
  readonly validatedSpanCount: number;
  readonly synthetic: boolean;
  readonly tailSpanOwnerIndex?: number;
}

const paragraphSegmentProjectionByRecord = new WeakMap<NodeRecord, StoredParagraphSegmentProjection>();
const paragraphCountersByMap: WeakMap<NodeMap, StoreParagraphCounters | undefined> | undefined =
  typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? new WeakMap<NodeMap, StoreParagraphCounters | undefined>()
    : undefined;
const EMPTY_PARAGRAPH_SPANS: ReadonlyArray<ParagraphSpanRecord> = Object.freeze([]);

interface StoreParagraphCounters {
  recordRecordSlotsAllocated(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordPrefixComparisons?(count: number, stage?: "store"): void;
  recordSourceUnitsRead?(count: number, stage?: "store"): void;
  recordSourceUnitsMaterialized?(count: number, stage?: "store"): void;
  recordSourceDirectoryEntriesCopied?(count: number, stage?: "store"): void;
  recordStoreRecordsTouched?(count: number, stage?: "store" | "view"): void;
}
function paragraphSegmentLeaf(events: readonly ParagraphSegmentPlanEvent[]): ParagraphSegmentProjectionLeaf {
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  if (!firstEvent || !lastEvent) throw new RangeError("Paragraph segment projection leaf cannot be empty");
  return {
    kind: "leaf",
    level: 0,
    eventCount: events.length,
    events,
    firstEvent,
    lastEvent,
  };
}

function paragraphSegmentBranch(
  level: number,
  children: readonly ParagraphSegmentProjectionNode[],
): ParagraphSegmentProjectionBranch {
  const first = children[0];
  const last = children[children.length - 1];
  if (!first || !last) throw new RangeError("Paragraph segment projection branch cannot be empty");
  return {
    kind: "branch",
    level,
    eventCount: children.reduce((count, child) => count + child.eventCount, 0),
    children,
    firstEvent: first.firstEvent,
    lastEvent: last.lastEvent,
  };
}

function paragraphSegmentPath(level: number, event: ParagraphSegmentPlanEvent): ParagraphSegmentProjectionNode {
  return level === 0
    ? paragraphSegmentLeaf([event])
    : paragraphSegmentBranch(level, [paragraphSegmentPath(level - 1, event)]);
}

function appendParagraphSegmentNode(
  node: ParagraphSegmentProjectionNode,
  event: ParagraphSegmentPlanEvent,
): ParagraphSegmentProjectionNode | undefined {
  if (node.kind === "leaf") {
    if (node.eventCount >= prefixProjectionCapacity(0)) return undefined;
    return paragraphSegmentLeaf([...node.events, event]);
  }
  const children = [...node.children];
  const lastIndex = children.length - 1;
  const last = children[lastIndex];
  if (!last) return undefined;
  if (last.eventCount < prefixProjectionCapacity(last.level)) {
    const appended = appendParagraphSegmentNode(last, event);
    if (appended) {
      children[lastIndex] = appended;
      return paragraphSegmentBranch(node.level, children);
    }
  }
  if (children.length >= prefixProjectionCapacity(0)) return undefined;
  children.push(paragraphSegmentPath(node.level - 1, event));
  return paragraphSegmentBranch(node.level, children);
}

function appendParagraphSegmentProjection(
  current: ParagraphSegmentProjection,
  event: ParagraphSegmentPlanEvent,
): ParagraphSegmentProjection {
  const root = current.root;
  if (!root) return { root: paragraphSegmentBranch(-1, [paragraphSegmentLeaf([event])]), eventCount: 1 };
  if (root.kind !== "branch" || root.level !== -1) {
    throw new RangeError("Paragraph segment projection root must remain anchored");
  }
  const children = appendAnchoredPrefixChild(
    root.children,
    current.eventCount,
    (node) => node.eventCount,
    (level) => paragraphSegmentPath(level, event),
    (node) => {
      const appended = appendParagraphSegmentNode(node, event);
      if (!appended) throw new RangeError("Paragraph segment projection tail is unexpectedly full");
      return appended;
    },
  );
  return { root: paragraphSegmentBranch(-1, children), eventCount: current.eventCount + 1 };
}

function buildParagraphSegmentNode(
  level: number,
  firstEventIndex: number,
  eventCount: number,
  events: readonly ParagraphSegmentPlanEvent[],
): ParagraphSegmentProjectionNode {
  if (level === 0) return paragraphSegmentLeaf(events.slice(firstEventIndex, firstEventIndex + eventCount));
  const childCapacity = prefixProjectionCapacity(level - 1);
  const children: ParagraphSegmentProjectionNode[] = [];
  let remaining = eventCount;
  let nextEventIndex = firstEventIndex;
  while (remaining > 0) {
    const childCount = Math.min(childCapacity, remaining);
    children.push(buildParagraphSegmentNode(level - 1, nextEventIndex, childCount, events));
    remaining -= childCount;
    nextEventIndex += childCount;
  }
  return paragraphSegmentBranch(level, children);
}

function truncateParagraphSegmentNode(
  node: ParagraphSegmentProjectionNode,
  keepCount: number,
): ParagraphSegmentProjectionNode | undefined {
  if (keepCount <= 0) return undefined;
  if (keepCount >= node.eventCount) return node;
  if (node.kind === "leaf") return paragraphSegmentLeaf(node.events.slice(0, keepCount));
  const children = truncateAnchoredPrefixChildren(
    node.children,
    keepCount,
    (child) => child.eventCount,
    truncateParagraphSegmentNode,
  );
  return children.length > 0 ? paragraphSegmentBranch(node.level, children) : undefined;
}

function truncateParagraphSegmentProjection(
  current: ParagraphSegmentProjection,
  keepCount: number,
): ParagraphSegmentProjection {
  if (keepCount >= current.eventCount) return current;
  if (keepCount <= 0 || !current.root) return { eventCount: 0 };
  if (current.root.kind !== "branch" || current.root.level !== -1) {
    throw new RangeError("Paragraph segment projection root must remain anchored");
  }
  const children = truncateAnchoredPrefixChildren(
    current.root.children,
    keepCount,
    (child) => child.eventCount,
    truncateParagraphSegmentNode,
  );
  return { root: paragraphSegmentBranch(-1, children), eventCount: keepCount };
}

function paragraphSegmentEventAt(
  projection: ParagraphSegmentProjection,
  index: number,
): ParagraphSegmentPlanEvent | undefined {
  if (!projection.root || index < 0 || index >= projection.eventCount) return undefined;
  let node = projection.root;
  let remaining = index;
  while (node.kind === "branch") {
    let found = false;
    for (const child of node.children) {
      if (remaining < child.eventCount) {
        node = child;
        found = true;
        break;
      }
      remaining -= child.eventCount;
    }
    if (!found) return undefined;
  }
  return node.events[remaining];
}

function paragraphSegmentEvents(events: readonly ParagraphSegmentPlanEvent[]): ParagraphSegmentProjection {
  if (events.length === 0) return { eventCount: 0 };
  const children = createAnchoredPrefixPlan(events.length).map(({ level, firstIndex, count }) =>
    buildParagraphSegmentNode(level, firstIndex, count, events));
  return { root: paragraphSegmentBranch(-1, children), eventCount: events.length };
}

function paragraphSegmentOwnerIndex(
  projection: ParagraphSegmentProjection,
  state: ManagedParagraphViewState,
  span: ParagraphSpanRecord,
): number {
  if (span.children?.length) return -1;
  let low = 0;
  let high = projection.eventCount;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const event = paragraphSegmentEventAt(projection, middle);
    if (!event) return -1;
    if (event.range.to <= span.sourceRange.from) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < projection.eventCount; index += 1) {
    const event = paragraphSegmentEventAt(projection, index);
    if (!event || event.nativeChild || event.range.from > span.sourceRange.from) break;
    const end = index === projection.eventCount - 1 && event.type === "paragraph-text"
      ? state.source.sourceRange.to
      : event.range.to;
    if (event.type === "paragraph-text" && event.range.from <= span.sourceRange.from && span.sourceRange.to <= end) return index;
  }
  return -1;
}
function paragraphSegmentEvent(
  map: NodeMap,
  childId: string,
  order: number,
  sourceRange: { readonly from: number; readonly to: number },
  spanIndex?: number,
): ParagraphSegmentPlanEvent | undefined {
  const child = map.get(childId);
  const range = child?.range;
  if (
    !child ||
    !range ||
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < sourceRange.from ||
    range.to < range.from ||
    range.to > sourceRange.to
  ) return undefined;
  return {
    id: child.id,
    type: child.type,
    range: { from: range.from, to: range.to },
    order,
    nativeChild: spanIndex !== undefined,
    spanFrom: spanIndex,
    spanTo: spanIndex,
  };
}

function validateParagraphSegmentSpans(
  projection: ParagraphSegmentProjection,
  state: ManagedParagraphViewState,
  fromSpan: number,
): number {
  for (let index = fromSpan; index < state.spans.length; index += 1) {
    const span = state.spans.get(index);
    if (!span) return index;
    if (span.children?.length) {
      if (span.nodes.length !== 0) return index;
      let previousEnd = span.sourceRange.from;
      for (const child of span.children) {
        if (
          (child.type !== "paragraph-text" && child.type !== "paragraph-html" && child.type !== "paragraph-mdx") ||
          child.range.from < previousEnd ||
          child.range.to < child.range.from ||
          child.range.to > span.sourceRange.to
        ) return index;
        previousEnd = child.range.to;
      }
    } else if (paragraphSegmentOwnerIndex(projection, state, span) === -1) {
      return index;
    }
  }
  return state.spans.length;
}

function buildParagraphSegmentPlan(
  map: NodeMap,
  record: NodeRecord,
  state: ManagedParagraphViewState,
): StoredParagraphSegmentProjection {
  const events: ParagraphSegmentPlanEvent[] = [];
  let plainFrom: number | undefined;
  let plainTo = 0;
  let plainSpanFrom = 0;
  let plainSpanTo = -1;
  const flushPlain = (): void => {
    if (plainFrom === undefined) return;
    events.push({
      id: `${record.id}::paragraph-text:${plainSpanFrom}`,
      type: "paragraph-text",
      range: { from: plainFrom, to: plainTo },
      order: events.length,
      nativeChild: false,
      spanFrom: plainSpanFrom,
      spanTo: plainSpanTo,
    });
    plainFrom = undefined;
  };
  let previousSpanEnd = state.source.sourceRange.from;
  for (let index = 0; index < state.spans.length; index += 1) {
    const span = state.spans.get(index);
    if (
      !span ||
      span.sourceRange.from < previousSpanEnd ||
      span.sourceRange.to < span.sourceRange.from ||
      span.sourceRange.to > state.source.sourceRange.to
    ) {
      return {
        root: undefined, eventCount: 0, generation: state.source.generation, childCount: record.children.length,
        spanCount: state.spans.length, error: "Managed paragraph span source order is invalid",
        validatedSpanCount: index, synthetic: false,
      };
    }
    if (!span.children?.length) {
      if (plainFrom === undefined) {
        plainFrom = span.sourceRange.from;
        plainSpanFrom = index;
      }
      plainTo = span.sourceRange.to;
      plainSpanTo = index;
      previousSpanEnd = span.sourceRange.to;
      continue;
    }
    flushPlain();
    if (span.nodes.length !== 0) {
      return {
        root: undefined, eventCount: 0, generation: state.source.generation, childCount: record.children.length,
        spanCount: state.spans.length, error: `Mixed paragraph span ${index} contains duplicate inline meaning`,
        validatedSpanCount: index, synthetic: false,
      };
    }
    let previousChildEnd = span.sourceRange.from;
    for (const child of span.children) {
      if (
        (child.type !== "paragraph-text" && child.type !== "paragraph-html" && child.type !== "paragraph-mdx") ||
        child.range.from < previousChildEnd ||
        child.range.to < child.range.from ||
        child.range.to > span.sourceRange.to
      ) {
        return {
          root: undefined, eventCount: 0, generation: state.source.generation, childCount: record.children.length,
          spanCount: state.spans.length, error: `Prepared paragraph child range is invalid in span ${index}`,
          validatedSpanCount: index, synthetic: false,
        };
      }
      const event = paragraphSegmentEvent(map, child.id, events.length, state.source.sourceRange, index);
      if (!event || event.type !== child.type || event.range.from !== child.range.from || event.range.to !== child.range.to) {
        return {
          root: undefined, eventCount: 0, generation: state.source.generation, childCount: record.children.length,
          spanCount: state.spans.length, error: `Prepared paragraph child ${child.id} is unavailable or stale`,
          validatedSpanCount: index, synthetic: false,
        };
      }
      events.push(event);
      previousChildEnd = child.range.to;
    }
    previousSpanEnd = span.sourceRange.to;
  }
  flushPlain();
  const synthetic = events.length === 0;
  if (synthetic) {
    events.push({
      id: record.id,
      type: "paragraph-text",
      range: { ...state.source.sourceRange },
      order: 0,
      nativeChild: false,
      spanFrom: 0,
      spanTo: -1,
    });
  }
  const last = events[events.length - 1];
  let previousEnd = state.source.sourceRange.from;
  for (const event of events) {
    if (event.range.from < previousEnd) {
      return {
        root: undefined, eventCount: 0, generation: state.source.generation, childCount: record.children.length,
        spanCount: state.spans.length, error: "Managed paragraph children overlap or regress",
        validatedSpanCount: 0, synthetic,
      };
    }
    previousEnd = event.range.to;
  }
  const projection = paragraphSegmentEvents(events);
  const invalidSpan = validateParagraphSegmentSpans(projection, state, 0);
  if (invalidSpan !== state.spans.length) {
    return {
      ...projection, generation: state.source.generation, childCount: record.children.length,
      spanCount: state.spans.length, error: `Prepared paragraph span ${invalidSpan} has no unique text owner`,
      validatedSpanCount: invalidSpan, synthetic,
    };
  }
  const lastSpan = state.spans.length > 0 ? state.spans.get(state.spans.length - 1) : undefined;
  return {
    ...projection,
    generation: state.source.generation,
    childCount: record.children.length,
    spanCount: state.spans.length,
    lastEvent: last,
    tailSpanOwnerIndex: synthetic ? 0 : lastSpan ? paragraphSegmentOwnerIndex(projection, state, lastSpan) : undefined,
    validatedSpanCount: state.spans.length,
    synthetic,
  };
}
function updateParagraphSegmentPlanAfterAppend(
  map: NodeMap,
  parent: NodeRecord,
  previous: ManagedParagraphViewState,
  next: ManagedParagraphViewState,
  fromSpan: number,
): void {
  const cache = paragraphSegmentProjectionByRecord.get(parent);
  if (!cache || cache.error || cache.spanCount !== previous.spans.length) return;
  const oldTail = previous.spans.get(fromSpan);
  let projection: ParagraphSegmentProjection;
  if (oldTail?.children?.length) {
    projection = truncateParagraphSegmentProjection(cache, cache.eventCount - oldTail.children.length);
  } else if (oldTail) {
    let low = 0;
    let high = cache.eventCount;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const event = paragraphSegmentEventAt(cache, middle);
      if (!event || (event.spanTo ?? -1) >= fromSpan) high = middle;
      else low = middle + 1;
    }
    const priorText = paragraphSegmentEventAt(cache, low);
    projection = truncateParagraphSegmentProjection(cache, low);
    if (
      priorText &&
      !priorText.nativeChild &&
      (priorText.spanFrom ?? fromSpan) < fromSpan &&
      oldTail.sourceRange.from > priorText.range.from
    ) {
      projection = appendParagraphSegmentProjection(projection, {
        ...priorText,
        range: { from: priorText.range.from, to: oldTail.sourceRange.from },
        spanTo: fromSpan - 1,
      });
    }
  } else if (cache.synthetic) {
    projection = truncateParagraphSegmentProjection(cache, 0);
  } else {
    projection = cache;
  }
  let plainFrom: number | undefined;
  let plainTo = 0;
  let plainSpanFrom = fromSpan;
  let plainSpanTo = fromSpan - 1;
  const flushPlain = (): void => {
    if (plainFrom === undefined) return;
    const previousEvent = projection.root?.lastEvent;
    if (previousEvent && plainFrom < previousEvent.range.to) {
      paragraphSegmentProjectionByRecord.set(parent, {
        ...cache, root: undefined, eventCount: 0, generation: next.source.generation,
        spanCount: next.spans.length, error: "Managed paragraph children overlap or regress",
        validatedSpanCount: fromSpan, synthetic: false,
      });
      return;
    }
    projection = appendParagraphSegmentProjection(projection, {
      id: `${parent.id}::paragraph-text:${plainSpanFrom}`,
      type: "paragraph-text",
      range: { from: plainFrom, to: plainTo },
      order: projection.eventCount,
      nativeChild: false,
      spanFrom: plainSpanFrom,
      spanTo: plainSpanTo,
    });
    plainFrom = undefined;
  };
  for (let index = fromSpan; index < next.spans.length; index += 1) {
    const span = next.spans.get(index);
    if (!span) continue;
    if (!span.children?.length) {
      if (plainFrom === undefined) {
        plainFrom = oldTail && index === fromSpan
          ? span.sourceRange.from
          : cache.synthetic && index === fromSpan
            ? previous.source.sourceRange.from
            : span.sourceRange.from;
        plainSpanFrom = index;
      }
      plainTo = span.sourceRange.to;
      plainSpanTo = index;
      continue;
    }
    flushPlain();
    for (const child of span.children) {
      const event = paragraphSegmentEvent(map, child.id, projection.eventCount, next.source.sourceRange, index);
      if (!event || event.type !== child.type || event.range.from !== child.range.from || event.range.to !== child.range.to) {
        paragraphSegmentProjectionByRecord.set(parent, {
          ...cache, root: undefined, eventCount: 0, generation: next.source.generation,
          spanCount: next.spans.length, error: `Prepared paragraph child ${child.id} is unavailable or stale`,
          validatedSpanCount: fromSpan, synthetic: false,
        });
        return;
      }
      const previousEvent = projection.root?.lastEvent;
      if (previousEvent && event.range.from < previousEvent.range.to) {
        paragraphSegmentProjectionByRecord.set(parent, {
          ...cache, root: undefined, eventCount: 0, generation: next.source.generation,
          spanCount: next.spans.length, error: "Managed paragraph children overlap or regress",
          validatedSpanCount: fromSpan, synthetic: false,
        });
        return;
      }
      projection = appendParagraphSegmentProjection(projection, event);
    }
  }
  flushPlain();
  const synthetic = projection.eventCount === 0;
  if (synthetic) {
    projection = appendParagraphSegmentProjection(projection, {
      id: parent.id,
      type: "paragraph-text",
      range: { ...next.source.sourceRange },
      order: 0,
      nativeChild: false,
      spanFrom: 0,
      spanTo: -1,
    });
  }
  const lastSpan = next.spans.length > 0 ? next.spans.get(next.spans.length - 1) : undefined;
  paragraphSegmentProjectionByRecord.set(parent, {
    ...projection,
    generation: next.source.generation,
    childCount: parent.children.length,
    spanCount: next.spans.length,
    lastEvent: projection.root?.lastEvent,
    tailSpanOwnerIndex: synthetic ? 0 : lastSpan ? paragraphSegmentOwnerIndex(projection, next, lastSpan) : undefined,
    validatedSpanCount: next.spans.length,
    synthetic,
  });
}

// Retired owner generations are scoped to one NodeMap/document baseline; reset builds a fresh map.
const codeStateByRecord = new WeakMap<NodeRecord, StoredCodeBlockState>();
const codeCountersByMap: WeakMap<NodeMap, StoreCodeCounters | undefined> | undefined =
  typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? new WeakMap<NodeMap, StoreCodeCounters | undefined>()
    : undefined;
const retiredCodeGenerationsByMap = new WeakMap<NodeMap, Map<string, number>>();
const coldCodeBlocksByView = new WeakMap<CodeBlockViewState, Block>();
const tableStateByRecord = new WeakMap<NodeRecord, ManagedTableViewState>();
const retiredTableGenerationsByMap = new WeakMap<NodeMap, Map<string, number>>();
const coldTableBlocksByView = new WeakMap<ManagedTableViewState, Block>();
const EMPTY_TABLE_ROWS: ReadonlyArray<TableRowRecord> = Object.freeze([]);

function tableColdBlock(record: NodeRecord, state: ManagedTableViewState): Block {
  let block = coldTableBlocksByView.get(state);
  if (!block) {
    block = materializeManagedTableBlock(record.block ?? {
      id: record.id,
      type: "table",
      isFinalized: true,
      payload: { raw: "", range: { ...state.source.sourceRange }, meta: {} },
    }, state);
    coldTableBlocksByView.set(state, block);
  }
  return block;
}

interface TableRowRangeSubscription {
  readonly from: number;
  readonly to: number;
  readonly listeners: Set<() => void>;
  rows?: ReadonlyArray<TableRowRecord>;
  generation?: number;
}
interface CodeLineRangeSubscription {
  readonly listeners: Set<() => void>;
}
function createFreshNodeMap(): NodeMap {
  const map: NodeMap = new Map();
  retiredCodeGenerationsByMap.set(map, new Map<string, number>());
  retiredTableGenerationsByMap.set(map, new Map<string, number>());
  retiredParagraphGenerationsByMap.set(map, new Map<string, number>());
  return map;
}
function retiredCodeGenerations(map: NodeMap): Map<string, number> {
  let generations = retiredCodeGenerationsByMap.get(map);
  if (!generations) {
    generations = new Map<string, number>();
    retiredCodeGenerationsByMap.set(map, generations);
  }
  return generations;
}
function retiredTableGenerations(map: NodeMap): Map<string, number> {
  let generations = retiredTableGenerationsByMap.get(map);
  if (!generations) {
    generations = new Map<string, number>();
    retiredTableGenerationsByMap.set(map, generations);
  }
  return generations;
}
function retiredParagraphGenerations(map: ReadonlyMap<string, NodeRecord>): Map<string, number> {
  let generations = retiredParagraphGenerationsByMap.get(map);
  if (!generations) {
    generations = new Map<string, number>();
    retiredParagraphGenerationsByMap.set(map, generations);
  }
  return generations;
}

function rememberRetiredParagraphOwner(map: NodeMap, record: NodeRecord): void {
  const state = paragraphStateByRecord.get(record);
  if (!state) return;
  const generations = retiredParagraphGenerations(map);
  generations.set(record.id, Math.max(generations.get(record.id) ?? -1, state.source.generation));
}


function rememberRetiredTableOwner(map: NodeMap, record: NodeRecord): void {
  const state = tableStateByRecord.get(record);
  if (!state) return;
  const generations = retiredTableGenerations(map);
  generations.set(record.id, Math.max(generations.get(record.id) ?? -1, state.source.generation));
}

function rememberRetiredCodeOwner(map: NodeMap, record: NodeRecord): void {
  const state = codeStateByRecord.get(record);
  if (!state?.managed) return;
  const generations = retiredCodeGenerations(map);
  const generation = state.view.source.generation;
  generations.set(record.id, Math.max(generations.get(record.id) ?? -1, generation));
}

function codeSnapshotGenerationAllowed(map: NodeMap, snapshot: NodeSnapshot): boolean {
  if (snapshot.code) {
    const current = map.get(snapshot.id);
    const currentState = current && codeStateByRecord.get(current);
    const retired = retiredCodeGenerations(map).get(snapshot.id) ?? -1;
    const generationFloor = Math.max(retired, currentState?.managed ? currentState.view.source.generation : -1);
    if (snapshot.code.codeOwnerId !== snapshot.id || snapshot.code.generation <= generationFloor) return false;
  }
  if (snapshot.table) {
    const current = map.get(snapshot.id);
    const currentState = current && tableStateByRecord.get(current);
    const retired = retiredTableGenerations(map).get(snapshot.id) ?? -1;
    const generationFloor = Math.max(retired, currentState?.source.generation ?? -1);
    // The current owner may be replaced atomically at the same revision; retired generations stay blocked below.
    const replacesActiveOwner = currentState?.source.generation === snapshot.table.generation &&
      snapshot.table.generation > retired &&
      snapshot.table.revision >= currentState.source.revision;
    if (
      snapshot.type !== "table" ||
      snapshot.table.tableOwnerId !== snapshot.id ||
      (snapshot.table.generation <= generationFloor && !replacesActiveOwner) ||
      (snapshot.children?.length ?? 0) > 0
    ) return false;
  }
  if (snapshot.paragraph) {
    const current = map.get(snapshot.id);
    const currentState = current && paragraphStateByRecord.get(current);
    const retired = retiredParagraphGenerations(map).get(snapshot.id) ?? -1;
    const generationFloor = Math.max(retired, currentState?.source.generation ?? -1);
    const replacesActiveOwner = currentState !== undefined &&
      snapshot.paragraph.generation > retired &&
      paragraphSnapshotPreservesActiveOwner(currentState, snapshot);
    if (
      snapshot.type !== "paragraph" ||
      snapshot.paragraph.paragraphOwnerId !== snapshot.id ||
      (snapshot.paragraph.generation <= generationFloor && !replacesActiveOwner) ||
      (snapshot.children?.length ?? 0) > 0
    ) return false;
  }
  return (snapshot.children ?? []).every((child) => codeSnapshotGenerationAllowed(map, child));
}

type RetiredOwnerFloor = readonly [generations: Map<string, number>, id: string, floor: number | undefined];

// Owners a replacement carries forward from the removed subtree (same id and generation) must not stay retired by
// the removal that precedes the rebuild, or the insert rejects its own subtree and the block is lost.
function continuedOwnerFloors(
  map: NodeMap,
  previous: ReadonlyMap<string, NodeRecord>,
  snapshot: NodeSnapshot,
  floors: RetiredOwnerFloor[] = [],
): RetiredOwnerFloor[] {
  const record = previous.get(snapshot.id);
  const tableState = record && tableStateByRecord.get(record);
  if (tableState && snapshot.table) {
    const generations = retiredTableGenerations(map);
    const floor = generations.get(snapshot.id);
    if (
      tableState.source.generation === snapshot.table.generation &&
      snapshot.table.generation > (floor ?? -1) &&
      snapshot.table.revision >= tableState.source.revision
    ) floors.push([generations, snapshot.id, floor]);
  }
  const paragraphState = record && paragraphStateByRecord.get(record);
  if (paragraphState && snapshot.paragraph) {
    const generations = retiredParagraphGenerations(map);
    const floor = generations.get(snapshot.id);
    if (
      snapshot.paragraph.generation > (floor ?? -1) &&
      paragraphSnapshotPreservesActiveOwner(paragraphState, snapshot)
    ) floors.push([generations, snapshot.id, floor]);
  }
  for (const child of snapshot.children ?? []) continuedOwnerFloors(map, previous, child, floors);
  return floors;
}

function sameCompletedParagraphSpanSources(
  current: ManagedParagraphViewState,
  next: ParagraphBlockSnapshot,
): boolean {
  const completeSpanCount = current.source.completeSpanCount;
  if (
    typeof next.raw !== "string" ||
    !Array.isArray(next.spans) ||
    next.completeSpanCount < completeSpanCount ||
    next.spans.length < completeSpanCount
  ) return false;
  for (let index = 0; index < completeSpanCount; index += 1) {
    const prior = current.spans.get(index);
    const replacement = next.spans[index];
    if (
      !prior ||
      !replacement?.sourceRange ||
      prior.id !== replacement.id ||
      prior.index !== replacement.index ||
      prior.sourceRevision !== replacement.sourceRevision ||
      prior.isProvisional !== replacement.isProvisional ||
      prior.sourceRange.from !== replacement.sourceRange.from ||
      prior.sourceRange.to !== replacement.sourceRange.to
    ) return false;
  }

  const source = current.source;
  const provisional = source.spanCount > completeSpanCount
    ? current.spans.get(completeSpanCount)
    : undefined;
  if (source.spanCount > completeSpanCount && !provisional) return false;
  const completedLength = (provisional?.sourceRange.from ?? source.sourceRange.to) - source.sourceRange.from;
  if (!Number.isSafeInteger(completedLength) || completedLength < 0 || next.raw.length < completedLength) return false;
  for (let from = 0; from < completedLength; from += 4096) {
    const to = Math.min(completedLength, from + 4096);
    const retained = current.sourceSnapshot.read(from, to);
    if (retained.length !== to - from) return false;
    for (let offset = 0; offset < retained.length; offset += 1) {
      if (retained.charCodeAt(offset) !== next.raw.charCodeAt(from + offset)) return false;
    }
  }
  return true;
}

function paragraphSnapshotPreservesActiveOwner(
  current: ManagedParagraphViewState,
  snapshot: NodeSnapshot,
): boolean {
  const next = snapshot.paragraph;
  if (
    !next ||
    snapshot.type !== "paragraph" ||
    (snapshot.children?.length ?? 0) > 0 ||
    typeof next.raw !== "string" ||
    !next.sourceRange ||
    !Number.isSafeInteger(next.sourceRange.from) ||
    !Number.isSafeInteger(next.sourceRange.to) ||
    next.sourceRange.from < 0 ||
    next.sourceRange.to < next.sourceRange.from ||
    next.sourceRange.to - next.sourceRange.from !== next.raw.length ||
    !Number.isSafeInteger(next.revision) ||
    !Number.isSafeInteger(next.processedTo) ||
    !Number.isSafeInteger(next.completeSpanCount) ||
    !Number.isSafeInteger(next.spanCount) ||
    (next.state !== "open" && next.state !== "closed" && next.state !== "finalized")
  ) return false;
  const source = current.source;
  return next.paragraphOwnerId === snapshot.id &&
    next.generation === source.generation &&
    next.revision >= source.revision &&
    next.processedTo >= source.processedTo &&
    next.completeSpanCount >= source.completeSpanCount &&
    next.spanCount >= source.spanCount &&
    next.sourceRange.from === source.sourceRange.from &&
    next.sourceRange.to >= source.sourceRange.to &&
    (source.state !== "closed" || next.state !== "open") &&
    (source.state !== "finalized" || (
      next.state === "finalized" &&
      next.sourceRange.to === source.sourceRange.to &&
      next.spanCount === source.spanCount
    )) &&
    sameCompletedParagraphSpanSources(current, next);
}

function carryStoreCounters(previous: NodeMap, next: NodeMap): void {
  if (typeof __STREAM_MDX_COUNTERS__ === "undefined" || !__STREAM_MDX_COUNTERS__) return;
  paragraphCountersByMap!.set(next, paragraphCountersByMap!.get(previous));
  const counters = codeCountersByMap!.get(previous);
  if (counters) codeCountersByMap!.set(next, counters);
}

const preparedStoreCaptureByStore = new WeakMap<RendererStore, () => RendererStore>();

export function capturePreparedRendererStore(store: RendererStore): RendererStore {
  const capture = preparedStoreCaptureByStore.get(store);
  if (!capture) throw new Error("RendererStore was not created by createRendererStore.");
  return capture();
}

// Ids whose record object or version changed during the current synchronous store mutation. Keyed node
// subscriptions wake exactly these ids: the same condition `getNodeWithVersion` snapshots change on.
let activeChangedIds: Set<string> | null = null;

function markRecordChanged(id: string): void {
  activeChangedIds?.add(id);
}

function bumpVersion(record: NodeRecord): void {
  record.version++;
  activeChangedIds?.add(record.id);
}

const nodeSnapshotCacheByMap = new WeakMap<NodeMap, Map<string, { version: number; node?: NodeRecord }>>();
const childrenSnapshotCacheByMap = new WeakMap<NodeMap, Map<string, { version: number; children: ReadonlyArray<string> }>>();
const NODE_SNAPSHOT_CACHE_LIMIT = 50000;
const CHILDREN_SNAPSHOT_CACHE_LIMIT = 50000;
const NODE_SNAPSHOT_CACHE_BUFFER = Math.max(200, Math.floor(NODE_SNAPSHOT_CACHE_LIMIT * 0.1));
const CHILDREN_SNAPSHOT_CACHE_BUFFER = Math.max(200, Math.floor(CHILDREN_SNAPSHOT_CACHE_LIMIT * 0.1));

function getNodeSnapshotCacheForMap(map: NodeMap): Map<string, { version: number; node?: NodeRecord }> {
  let cache = nodeSnapshotCacheByMap.get(map);
  if (!cache) {
    cache = new Map<string, { version: number; node?: NodeRecord }>();
    nodeSnapshotCacheByMap.set(map, cache);
  }
  return cache;
}

function getChildrenSnapshotCacheForMap(map: NodeMap): Map<string, { version: number; children: ReadonlyArray<string> }> {
  let cache = childrenSnapshotCacheByMap.get(map);
  if (!cache) {
    cache = new Map<string, { version: number; children: ReadonlyArray<string> }>();
    childrenSnapshotCacheByMap.set(map, cache);
  }
  return cache;
}

function pruneCache<T>(cache: Map<string, T>, max: number, buffer: number) {
  if (cache.size <= max + buffer) return;
  let remaining = cache.size - max;
  for (const key of cache.keys()) {
    cache.delete(key);
    remaining -= 1;
    if (remaining <= 0) break;
  }
}

function deleteSnapshotCacheEntry(map: NodeMap, id: string) {
  getNodeSnapshotCacheForMap(map).delete(id);
  getChildrenSnapshotCacheForMap(map).delete(id);
  markRecordChanged(id);
}

function clearSnapshotCaches(map: NodeMap) {
  getNodeSnapshotCacheForMap(map).clear();
  getChildrenSnapshotCacheForMap(map).clear();
}
const EMPTY_CHILDREN: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_CODE_LINES: ReadonlyArray<CodeLineRecord> = Object.freeze([]);
const EMPTY_NODE_SNAPSHOT = Object.freeze<{ version: number; node?: NodeRecord }>({ version: -1, node: undefined });
const EMPTY_CHILDREN_SNAPSHOT = Object.freeze<{ version: number; children: ReadonlyArray<string> }>({
  version: -1,
  children: EMPTY_CHILDREN,
});

export function isListPatchDebugEnabled(): boolean {
  if (typeof globalThis !== "undefined") {
    const flag = (globalThis as { __STREAMING_LIST_DEBUG__?: boolean }).__STREAMING_LIST_DEBUG__;
    if (flag === true) return true;
  }
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_STREAMING_LIST_DEBUG === "true") {
    return true;
  }
  return false;
}

const CODE_BLOCK_DEBUG_ENABLED =
  (() => {
    try {
      if (typeof process !== "undefined" && process.env && process.env.NEXT_PUBLIC_STREAMING_DEBUG_CODELINES === "1") {
        return true;
      }
      if (typeof globalThis !== "undefined") {
        const debug = (globalThis as { __STREAMING_DEBUG__?: { codeLines?: boolean } })?.__STREAMING_DEBUG__;
        if (debug?.codeLines) {
          return true;
        }
      }
    } catch {
      // ignore detection errors
    }
    return false;
  })() || false;

const CODE_BLOCK_VALIDATION_ENABLED =
  typeof process !== "undefined" && process.env ? process.env.NODE_ENV !== "production" : true;

type PatchPerfOpSummary = {
  count: number;
  durationMs: number;
};

type PatchPerfSummary = {
  timestamp: string;
  totalMs: number;
  applyMs: number;
  coalesceMs: number;
  listNormalizeMs: number;
  patches: number;
  coalescedPatches: number;
  touchedCount: number;
  mutatedBlocks: boolean;
  ops: Record<string, PatchPerfOpSummary>;
  setPropsByType?: Record<string, PatchPerfOpSummary>;
  setPropsBySize?: Record<string, PatchPerfOpSummary>;
  setPropsStages?: Record<string, PatchPerfOpSummary>;
};

type PatchPerfTotals = {
  calls: number;
  totalMs: number;
  applyMs: number;
  coalesceMs: number;
  listNormalizeMs: number;
  patches: number;
  coalescedPatches: number;
  ops: Record<string, PatchPerfOpSummary>;
  setPropsByType: Record<string, PatchPerfOpSummary>;
  setPropsBySize: Record<string, PatchPerfOpSummary>;
  setPropsStages: Record<string, PatchPerfOpSummary>;
};

type StoreDebugCounters = {
  staleEpochRejected: number;
  storeInvariantViolationCount: number;
};

const PATCH_PERF_HISTORY_LIMIT = 120;
const CODE_WRAPPER_ATTR_PROBE_CHARS = 2048;
const getPerfNow = (() => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return () => performance.now();
  }
  return () => Date.now();
})();

function isPatchPerfDebugEnabled(): boolean {
  try {
    if (typeof process !== "undefined" && process.env) {
      const value = process.env.NEXT_PUBLIC_STREAMING_DEBUG_PATCH_PERF;
      if (value === "1" || value === "true") {
        return true;
      }
    }
  } catch {
    // ignore env read errors
  }
  try {
    const debug = (globalThis as { __STREAMING_DEBUG__?: { patchPerf?: boolean } }).__STREAMING_DEBUG__;
    if (debug?.patchPerf) {
      return true;
    }
  } catch {
    // ignore global read errors
  }
  return false;
}

function recordPatchPerf(summary: PatchPerfSummary): void {
  try {
    if (typeof globalThis === "undefined") return;
    const root = globalThis as {
      __STREAM_MDX_PATCH_STATS__?: PatchPerfSummary[];
      __STREAM_MDX_PATCH_STATS_LAST__?: PatchPerfSummary;
      __STREAM_MDX_PATCH_STATS_TOTALS__?: PatchPerfTotals;
    };
    const history = root.__STREAM_MDX_PATCH_STATS__ ?? [];
    history.push(summary);
    if (history.length > PATCH_PERF_HISTORY_LIMIT) {
      history.splice(0, history.length - PATCH_PERF_HISTORY_LIMIT);
    }
    root.__STREAM_MDX_PATCH_STATS__ = history;
    root.__STREAM_MDX_PATCH_STATS_LAST__ = summary;

    const totals = root.__STREAM_MDX_PATCH_STATS_TOTALS__ ?? {
      calls: 0,
      totalMs: 0,
      applyMs: 0,
      coalesceMs: 0,
      listNormalizeMs: 0,
      patches: 0,
      coalescedPatches: 0,
      ops: {},
      setPropsByType: {},
      setPropsBySize: {},
      setPropsStages: {},
    };

    totals.calls += 1;
    totals.totalMs += summary.totalMs;
    totals.applyMs += summary.applyMs;
    totals.coalesceMs += summary.coalesceMs;
    totals.listNormalizeMs += summary.listNormalizeMs;
    totals.patches += summary.patches;
    totals.coalescedPatches += summary.coalescedPatches;

    for (const [op, stats] of Object.entries(summary.ops)) {
      const entry = totals.ops[op] ?? { count: 0, durationMs: 0 };
      entry.count += stats.count;
      entry.durationMs += stats.durationMs;
      totals.ops[op] = entry;
    }

    if (summary.setPropsByType) {
      for (const [key, stats] of Object.entries(summary.setPropsByType)) {
        const entry = totals.setPropsByType[key] ?? { count: 0, durationMs: 0 };
        entry.count += stats.count;
        entry.durationMs += stats.durationMs;
        totals.setPropsByType[key] = entry;
      }
    }

    if (summary.setPropsBySize) {
      for (const [key, stats] of Object.entries(summary.setPropsBySize)) {
        const entry = totals.setPropsBySize[key] ?? { count: 0, durationMs: 0 };
        entry.count += stats.count;
        entry.durationMs += stats.durationMs;
        totals.setPropsBySize[key] = entry;
      }
    }

    if (summary.setPropsStages) {
      for (const [key, stats] of Object.entries(summary.setPropsStages)) {
        const entry = totals.setPropsStages[key] ?? { count: 0, durationMs: 0 };
        entry.count += stats.count;
        entry.durationMs += stats.durationMs;
        totals.setPropsStages[key] = entry;
      }
    }

    root.__STREAM_MDX_PATCH_STATS_TOTALS__ = totals;
  } catch {
    // ignore perf recording failures
  }
}

function estimateBlockPayloadSize(block: Block): number {
  if (!block || !block.payload) return 0;
  let size = 0;
  const payload = block.payload;
  if (typeof payload.raw === "string") size += payload.raw.length;
  if (typeof payload.highlightedHtml === "string") size += payload.highlightedHtml.length;
  if (typeof payload.sanitizedHtml === "string") size += payload.sanitizedHtml.length;
  if (Array.isArray(payload.inline)) size += payload.inline.length * 8;
  return size;
}

function estimatePropsSize(props?: Record<string, unknown>, block?: Block): number {
  let size = 0;
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === "block") continue;
      if (typeof value === "string") {
        size += value.length;
      } else if (typeof value === "number") {
        size += 8;
      } else if (typeof value === "boolean") {
        size += 4;
      } else if (Array.isArray(value)) {
        size += value.length * 4;
      }
    }
  }
  if (block) {
    size += estimateBlockPayloadSize(block);
  }
  return size;
}

function bucketBySize(size: number): string {
  if (size < 1024) return "<1k";
  if (size < 10 * 1024) return "1-10k";
  if (size < 50 * 1024) return "10-50k";
  if (size < 200 * 1024) return "50-200k";
  return ">=200k";
}

function debugCodeBlock(event: string, payload: Record<string, unknown>) {
  if (!CODE_BLOCK_DEBUG_ENABLED) return;
  try {
    // eslint-disable-next-line no-console
    console.debug(`[renderer-store][code-block] ${event}`, payload);
  } catch {
    // ignore logging errors
  }
}

function createRootRecord(): NodeRecord {
  return {
    id: PATCH_ROOT_ID,
    type: "__root__",
    parentId: null,
    children: [],
    props: {},
    version: 0,
    blockEpoch: 0,
  };
}

function readNumericEpoch(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function readSnapshotBlockEpoch(snapshot: NodeSnapshot): number | undefined {
  return readNumericEpoch(snapshot.meta?.blockEpoch);
}

function readPatchBlockEpoch(patch: Patch): number | undefined {
  if (patch.op === "setHTML") {
    return readNumericEpoch(patch.patchMeta?.blockEpoch);
  }
  return readNumericEpoch(patch.meta?.blockEpoch);
}

function readPatchParseEpoch(patch: Patch): number | undefined {
  if (patch.op === "setHTML") {
    return readNumericEpoch(patch.patchMeta?.parseEpoch);
  }
  return readNumericEpoch(patch.meta?.parseEpoch);
}

function readPatchTx(patch: Patch): number | undefined {
  if (patch.op === "setHTML") {
    return readNumericEpoch(patch.patchMeta?.tx);
  }
  return readNumericEpoch(patch.meta?.tx);
}

interface SemanticEnvelopeTuple {
  streamSeq: number;
  parseEpoch: number;
  tx: number;
}

function readSemanticEnvelopeTuple(patch: Patch): SemanticEnvelopeTuple | undefined {
  if (getPatchKind(patch) !== "semantic") return undefined;
  const meta = patch.op === "setHTML" ? patch.patchMeta : patch.meta;
  const streamSeq = readNumericEpoch(meta?.streamSeq);
  const parseEpoch = readNumericEpoch(meta?.parseEpoch);
  const tx = readNumericEpoch(meta?.tx);
  if (streamSeq === undefined || parseEpoch === undefined || tx === undefined) return undefined;
  return { streamSeq, parseEpoch, tx };
}


function compareSemanticEnvelopeTuples(left: SemanticEnvelopeTuple, right: SemanticEnvelopeTuple): number {
  if (left.streamSeq !== right.streamSeq) return left.streamSeq > right.streamSeq ? 1 : -1;
  if (left.parseEpoch !== right.parseEpoch) return left.parseEpoch > right.parseEpoch ? 1 : -1;
  if (left.tx !== right.tx) return left.tx > right.tx ? 1 : -1;
  return 0;
}


const blockEpochWriteSerials = new WeakMap<NodeRecord, number>();
let nextBlockEpochWriteSerial = 1;

function effectiveBlockEpoch(map: NodeMap, record: NodeRecord): number {
  let epoch = record.blockEpoch;
  let latestSerial = blockEpochWriteSerials.get(record) ?? 0;
  let ancestor = record.parentId ? map.get(record.parentId) : undefined;
  while (ancestor) {
    const serial = blockEpochWriteSerials.get(ancestor) ?? 0;
    if (serial > latestSerial) {
      epoch = ancestor.blockEpoch;
      latestSerial = serial;
    }
    ancestor = ancestor.parentId ? map.get(ancestor.parentId) : undefined;
  }
  return epoch;
}

function assignBlockEpoch(map: NodeMap, rootId: string, blockEpoch: number, touched?: Set<string>) {
  const root = map.get(rootId);
  if (!root) return;
  blockEpochWriteSerials.set(root, nextBlockEpochWriteSerial++);
  if (root.blockEpoch !== blockEpoch) {
    root.blockEpoch = blockEpoch;
    bumpVersion(root);
    touched?.add(root.id);
  }
}

function ensureArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function shallowEqualRecords(a?: Record<string, unknown>, b?: Record<string, unknown>): boolean {
  if (a === b) return true;
  if (!a || !b) {
    return !a && !b;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      return false;
    }
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

function ensureUniqueChildren(map: NodeMap, parent: NodeRecord, touched?: Set<string>) {
  if (!parent || parent.children.length <= 1) {
    return;
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  let mutated = false;
  for (const childId of parent.children) {
    if (seen.has(childId)) {
      mutated = true;
      continue;
    }
    seen.add(childId);
    // Count the explicit destination write, not JS Set or array backing-store growth.
    deduped.push(childId);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      paragraphCountersByMap!.get(map)?.recordRecordSlotsAllocated(1, "store");
    }
  }
  if (mutated) {
    parent.children = deduped;
    bumpVersion(parent);
    if (touched) {
      touched.add(parent.id);
    }
    console.error("[renderer-store] removed duplicate children", {
      parentId: parent.id,
      deduped: parent.children.slice(),
    });
  }
}

function logDuplicateCodeChildren(parent: NodeRecord) {
  if (parent.type !== "code") return;
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const childId of parent.children) {
    if (seen.has(childId)) {
      duplicates.push(childId);
    } else {
      seen.add(childId);
    }
  }
  if (duplicates.length > 0) {
    console.warn("[renderer-store] duplicate code-line ids detected", {
      parentId: parent.id,
      duplicateCount: duplicates.length,
      duplicates,
      children: parent.children.slice(),
    });
  }
}

function parseLineIndexFromId(id: string): number {
  const match = id.match(/::line:(\d+)$/);
  if (!match) return Number.NaN;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : Number.NaN;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function stripOuterLineSpan(html: string): string | null {
  if (!html) return null;
  const openTagMatch = html.match(/<span[^>]*class="[^"]*\bline\b[^"]*"[^>]*>/i);
  if (!openTagMatch) {
    return null;
  }
  const openTag = openTagMatch[0];
  const startIndex = html.indexOf(openTag);
  if (startIndex === -1) {
    return null;
  }
  const contentStart = startIndex + openTag.length;
  const endIndex = html.lastIndexOf("</span>");
  if (endIndex === -1 || endIndex < contentStart) {
    return null;
  }
  return html.slice(contentStart, endIndex);
}

function sanitizeLineInnerHtml(innerHtml: string | null, fallbackText: string): string {
  if (innerHtml && innerHtml.trim().length > 0) {
    const wrapped = `<span class="line">${innerHtml}</span>`;
    const sanitized = sanitizeCodeHTML(wrapped);
    const inner = stripOuterLineSpan(typeof sanitized === "string" ? sanitized : String(sanitized));
    if (inner !== null) {
      return inner;
    }
  }
  return escapeHtml(fallbackText);
}

function normalizeCodeBlockChildren(nodes: NodeMap, parent: NodeRecord, touched: Set<string>) {
  if (parent.type !== "code" || codeStateByRecord.get(parent)?.managed) return;

  const previousChildren = parent.children.slice();
  const originalOrder = new Map<string, number>();
  const seenIds = new Set<string>();
  const codeLineNodes: NodeRecord[] = [];
  const anomalies: string[] = [];

  for (let idx = 0; idx < previousChildren.length; idx++) {
    const childId = previousChildren[idx];
    const node = nodes.get(childId);
    if (!node) {
      anomalies.push(`missing:${childId}`);
      continue;
    }
    if (node.parentId !== parent.id) {
      node.parentId = parent.id;
      bumpVersion(node);
      touched.add(node.id);
    }
    if (node.type !== "code-line") {
      anomalies.push(`type-mismatch:${node.id}:${node.type}`);
      nodes.delete(node.id);
      deleteSnapshotCacheEntry(nodes, node.id);
      touched.add(node.id);
      continue;
    }
    if (seenIds.has(childId)) {
      anomalies.push(`duplicate-id:${childId}`);
      continue;
    }
    seenIds.add(childId);
    codeLineNodes.push(node);
    originalOrder.set(node.id, idx);
  }

  if (anomalies.length > 0) {
    debugCodeBlock("code-block-anomalies", {
      parentId: parent.id,
      anomalies,
      children: previousChildren,
    });
    if (anomalies.some((entry) => entry.startsWith("duplicate-id"))) {
      console.warn("[renderer-store] duplicate code-line ids detected", {
        parentId: parent.id,
        anomalies,
        children: previousChildren,
      });
    }
  }

  const sorted = codeLineNodes.slice().sort((a, b) => {
    const ai = typeof a.props?.index === "number" ? (a.props.index as number) : parseLineIndexFromId(a.id);
    const bi = typeof b.props?.index === "number" ? (b.props.index as number) : parseLineIndexFromId(b.id);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) {
      return ai - bi;
    }
    const ao = originalOrder.get(a.id) ?? 0;
    const bo = originalOrder.get(b.id) ?? 0;
    return ao - bo;
  });

  const nextChildren: string[] = [];
  let mutated = false;

  for (let idx = 0; idx < sorted.length; idx++) {
    const node = sorted[idx];
    const desiredId = `${parent.id}::line:${idx}`;
    const existing = nodes.get(desiredId);
    if (existing && existing !== node) {
      nodes.delete(desiredId);
      deleteSnapshotCacheEntry(nodes, desiredId);
      touched.add(desiredId);
      mutated = true;
    }

    if (node.id !== desiredId) {
      const previousId = node.id;
      nodes.delete(node.id);
      deleteSnapshotCacheEntry(nodes, previousId);
      node.id = desiredId;
      nodes.set(desiredId, node);
      markRecordChanged(desiredId);
      touched.add(desiredId);
      mutated = true;
    } else if (!nodes.has(desiredId)) {
      nodes.set(desiredId, node);
      markRecordChanged(desiredId);
    }

    if (node.parentId !== parent.id) {
      node.parentId = parent.id;
      bumpVersion(node);
      touched.add(node.id);
      mutated = true;
    }

    const incoming: Record<string, unknown> = { index: idx, text: node.props?.text, html: node.props?.html };
    if (Object.prototype.hasOwnProperty.call(node.props ?? {}, "tokens")) {
      incoming.tokens = (node.props as Record<string, unknown>).tokens;
    }
    if (Object.prototype.hasOwnProperty.call(node.props ?? {}, "isProvisional")) {
      incoming.isProvisional = node.props?.isProvisional;
    }
    const normalizedProps = normalizeCodeLineProps(incoming, node.props);
    if (normalizedProps !== node.props) {
      node.props = normalizedProps;
      bumpVersion(node);
      touched.add(node.id);
      mutated = true;
    }

    nextChildren.push(desiredId);
  }

  const allowed = new Set(nextChildren);
  for (const [id, record] of nodes) {
    if (record.parentId === parent.id && record.type === "code-line" && !allowed.has(id)) {
      nodes.delete(id);
      deleteSnapshotCacheEntry(nodes, id);
      touched.add(id);
      mutated = true;
    }
  }

  if (!arraysEqual(previousChildren, nextChildren)) {
    parent.children = nextChildren;
    bumpVersion(parent);
    touched.add(parent.id);
    mutated = true;
  }

  const duplicateIds: string[] = [];
  const postSeenIds = new Set<string>();
  for (const childId of parent.children) {
    if (postSeenIds.has(childId)) {
      duplicateIds.push(childId);
    } else {
      postSeenIds.add(childId);
    }
  }
  if (duplicateIds.length > 0) {
    console.error("[renderer-store] duplicate code-line children detected post-normalize", {
      parentId: parent.id,
      duplicates: duplicateIds,
      children: parent.children.slice(),
    });
  }

  if (mutated) {
    debugCodeBlock("code-block-normalized", {
      parentId: parent.id,
      children: parent.children.slice(),
    });
  }

  if (CODE_BLOCK_VALIDATION_ENABLED) {
    const validation = validateCodeBlockChildren(nodes, parent);
    if (!validation.ok) {
      debugCodeBlock("code-block-validation-failed", {
        parentId: parent.id,
        issues: validation.issues,
      });
      if (!rebuildCodeBlockFromSnapshot(nodes, parent, touched, validation.issues)) {
        console.warn("[renderer-store] unable to fully normalize code block", {
          parentId: parent.id,
          issues: validation.issues,
        });
      }
    }
  }
}

function normalizeCodeLineProps(incoming: Record<string, unknown>, previous?: Record<string, unknown>): Record<string, unknown> {
  const previousIndex = typeof previous?.index === "number" ? (previous?.index as number) : 0;
  const index = typeof incoming.index === "number" ? (incoming.index as number) : previousIndex;
  const previousText = typeof previous?.text === "string" ? (previous?.text as string) : "";
  const previousHtml = typeof previous?.html === "string" ? (previous?.html as string) : null;
  const previousTokens = Object.prototype.hasOwnProperty.call(previous ?? {}, "tokens") ? (previous?.tokens as TokenLineV1 | null) : undefined;
  const hasIncomingText = typeof incoming.text === "string";
  const hasIncomingHtml = typeof incoming.html === "string" || incoming.html === null;
  const hasIncomingTokens = Object.prototype.hasOwnProperty.call(incoming, "tokens");
  const hasIncomingProvisional = typeof incoming.isProvisional === "boolean";
  const incomingTokens = hasIncomingTokens ? (incoming.tokens as TokenLineV1 | null) : undefined;
  const previousIsProvisional = typeof previous?.isProvisional === "boolean" ? previous.isProvisional : undefined;
  const isProvisional = hasIncomingProvisional
    ? incoming.isProvisional as boolean
    : previousIsProvisional;
  const provisionalUnchanged = !hasIncomingProvisional || incoming.isProvisional === previousIsProvisional;
  const rawText = hasIncomingText ? (incoming.text as string) : previousText;
  // Re-normalizing a line with its own props (code-block normalization) must keep the props object: re-running
  // the sanitizer on already-sanitized html cannot change it, and a new object re-renders every line.
  const tokensUnchanged = !hasIncomingTokens || incomingTokens === previousTokens;

  if (previous && provisionalUnchanged && !hasIncomingHtml && tokensUnchanged && index === previousIndex && (!hasIncomingText || rawText === previousText)) {
    return previous;
  }
  if (
    previous &&
    provisionalUnchanged &&
    hasIncomingHtml &&
    tokensUnchanged &&
    incoming.html === previousHtml &&
    index === previousIndex &&
    (!hasIncomingText || rawText === previousText)
  ) {
    return previous;
  }

  let highlight: string | null = null;
  if (hasIncomingHtml) {
    highlight = incoming.html as string | null;
  } else if (!hasIncomingText || rawText === previousText) {
    highlight = previousHtml;
  }

  // Always re-derive html when text changes; highlight updates are best-effort and may arrive later.
  // If we keep a shorter stale `html` string, the renderer can show truncated lines even when `text` is complete.
  let tokens: TokenLineV1 | null | undefined = undefined;
  if (hasIncomingTokens) {
    tokens = incomingTokens ?? null;
  } else if (!hasIncomingText || rawText === previousText) {
    tokens = previousTokens;
  } else {
    tokens = null;
  }
  const normalized = createCodeLineProps(index, rawText, highlight, tokens);
  if (isProvisional !== undefined) normalized.isProvisional = isProvisional;
  return previous && shallowEqualRecords(previous, normalized) ? previous : normalized;
}

function createCodeLineProps(index: number, text: string, highlight: string | null, tokens?: TokenLineV1 | null): Record<string, unknown> {
  const safeText = typeof text === "string" ? text : "";
  const hasIncomingHighlight = typeof highlight === "string" && highlight.trim().length > 0;
  const sanitized = hasIncomingHighlight ? sanitizeLineInnerHtml(highlight, safeText) : null;
  const hasRenderableTokens = tokens !== undefined && tokens !== null;
  const html = sanitized && sanitized.length >= safeText.length ? sanitized : hasRenderableTokens ? null : escapeHtml(safeText);
  const props: Record<string, unknown> = {
    index,
    text: safeText,
    html,
  };
  if (tokens !== undefined) {
    props.tokens = tokens;
  }
  return props;
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length));
}

const INLINE_SEGMENT_TYPES = new Set(["paragraph-text", "blockquote-text", "list-item-text"]);

function isInlineSegmentType(type: string): boolean {
  return INLINE_SEGMENT_TYPES.has(type);
}

function mergeInlineSegmentProps(previous: Record<string, unknown> | undefined, incoming: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = previous ? { ...previous } : {};

  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }

  const inlineProvided = Object.prototype.hasOwnProperty.call(incoming, "inline");
  if (inlineProvided) {
    const inlineValue = Array.isArray(incoming.inline) ? incoming.inline : undefined;
    if (inlineValue) {
      result.inline = inlineValue;
    } else {
      result.inline = undefined;
    }
  } else if (previous && Array.isArray(previous.inline) && !Array.isArray(result.inline)) {
    result.inline = previous.inline;
  }

  const textProvided = Object.prototype.hasOwnProperty.call(incoming, "text");
  if (textProvided) {
    result.text = typeof incoming.text === "string" ? incoming.text : "";
  } else if (previous && typeof previous.text === "string" && typeof result.text !== "string") {
    result.text = previous.text;
  }

  return result;
}

function applyCodeBlockMetadata(record: NodeRecord, themes?: { light?: string; dark?: string }) {
  const block = record.block;
  const highlightedHtml = block?.payload.highlightedHtml ?? "";
  const lang =
    typeof block?.payload.meta?.lang === "string"
      ? block.payload.meta.lang
      : typeof record.props?.language === "string"
        ? record.props.language
        : record.props?.lang;
  const wrapperProbe =
    highlightedHtml.length > CODE_WRAPPER_ATTR_PROBE_CHARS
      ? highlightedHtml.slice(0, CODE_WRAPPER_ATTR_PROBE_CHARS)
      : highlightedHtml;
  let { preAttrs, codeAttrs } = extractCodeWrapperAttributes(wrapperProbe);
  if (!preAttrs || !codeAttrs) {
    const defaults = getDefaultCodeWrapperAttributes(typeof lang === "string" ? lang : undefined, themes);
    preAttrs = preAttrs ?? defaults.preAttrs;
    codeAttrs = codeAttrs ?? defaults.codeAttrs;
  }

  record.props = {
    ...(record.props ?? {}),
    lang,
    preAttrs,
    codeAttrs,
  };
}

function normalizeNodeProps(snapshot: NodeSnapshot): Record<string, unknown> {
  if (snapshot.type === "code-line") {
    const index = typeof snapshot.props?.index === "number" ? (snapshot.props?.index as number) : 0;
    const text = typeof snapshot.props?.text === "string" ? (snapshot.props?.text as string) : "";
    const html = typeof snapshot.props?.html === "string" ? (snapshot.props?.html as string) : null;
    const tokens = Object.prototype.hasOwnProperty.call(snapshot.props ?? {}, "tokens")
      ? (snapshot.props?.tokens as TokenLineV1 | null)
      : undefined;
    const normalized = createCodeLineProps(index, text, html, tokens);
    if (typeof snapshot.props?.isProvisional === "boolean") normalized.isProvisional = snapshot.props.isProvisional;
    return normalized;
  }

  if (isInlineSegmentType(snapshot.type)) {
    const incoming = snapshot.props ? { ...snapshot.props } : {};
    return mergeInlineSegmentProps(undefined, incoming);
  }

  const normalized = snapshot.props ? { ...snapshot.props } : {};
  if (isNativeContainerType(snapshot.type)) {
    // `record.block` is the one block carrier and generic children own the hierarchy.
    delete normalized.block;
    delete normalized.range;
  }
  return normalized;
}

interface CodeBlockValidationIssue {
  kind: string;
  id: string;
  expected?: unknown;
  actual?: unknown;
}

interface CodeBlockValidationResult {
  ok: boolean;
  issues: CodeBlockValidationIssue[];
}

function validateCodeBlockChildren(nodes: NodeMap, parent: NodeRecord): CodeBlockValidationResult {
  const issues: CodeBlockValidationIssue[] = [];
  const expectedPrefix = `${parent.id}::line:`;
  const allowed = new Set<string>();

  for (let idx = 0; idx < parent.children.length; idx++) {
    const childId = parent.children[idx];
    allowed.add(childId);
    const node = nodes.get(childId);
    if (!node) {
      issues.push({ kind: "missing-node", id: childId, expected: `${expectedPrefix}${idx}` });
      continue;
    }
    if (node.parentId !== parent.id) {
      issues.push({ kind: "parent-mismatch", id: childId, expected: parent.id, actual: node.parentId });
    }
    if (node.type !== "code-line") {
      issues.push({ kind: "unexpected-type", id: childId, expected: "code-line", actual: node.type });
    }
    const expectedId = `${expectedPrefix}${idx}`;
    if (childId !== expectedId) {
      issues.push({ kind: "id-mismatch", id: childId, expected: expectedId, actual: childId });
    }
    const indexProp = typeof node.props?.index === "number" ? (node.props.index as number) : null;
    if (indexProp !== idx) {
      issues.push({ kind: "index-mismatch", id: childId, expected: idx, actual: indexProp });
    }
  }

  for (const [id, record] of nodes) {
    if (record.parentId === parent.id && record.type === "code-line" && !allowed.has(id)) {
      issues.push({ kind: "dangling-node", id });
    }
  }

  if (parent.block?.isFinalized) {
    const snapshot = createBlockSnapshot(cloneBlock(parent.block));
    const expectedChildren = ensureArray(snapshot.children).filter((child) => child.type === "code-line");
    if (expectedChildren.length !== parent.children.length) {
      issues.push({
        kind: "line-count-mismatch",
        id: parent.id,
        expected: expectedChildren.length,
        actual: parent.children.length,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

function rebuildCodeBlockFromSnapshot(nodes: NodeMap, parent: NodeRecord, touched: Set<string>, issues: CodeBlockValidationIssue[]): boolean {
  if (!parent.block) {
    return false;
  }
  const ancestor = parent.parentId ? nodes.get(parent.parentId) : undefined;
  if (!ancestor) {
    return false;
  }
  const index = ancestor.children.indexOf(parent.id);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    paragraphCountersByMap!.get(nodes)?.recordPrefixComparisons?.(
      index === -1 ? ancestor.children.length : index + 1,
      "store",
    );
  }
  if (index === -1) {
    return false;
  }
  const snapshot = createBlockSnapshot(cloneBlock(parent.block));
  removeSubtree(nodes, parent.id, touched);
  const inserted = insertSnapshotAt(nodes, ancestor, index, snapshot, touched, parent.blockEpoch);
  if (!inserted) {
    return false;
  }
  for (const id of inserted.insertedIds) {
    touched.add(id);
  }
  bumpVersion(ancestor);
  touched.add(ancestor.id);
  console.warn("[renderer-store] rebuilt code block from snapshot", {
    parentId: parent.id,
    issues,
  });
  return true;
}

function expectedCodeLineId(parentId: string, index: number): string {
  return `${parentId}::line:${index}`;
}

function arraysEqual<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}



function collectStoreInvariantViolations(nodes: NodeMap): string[] {
  const violations: string[] = [];

  for (const [id, node] of nodes) {
    if (node.type === "__root__") continue;

    if (node.children.length > 1) {
      const seen = new Set<string>();
      for (const childId of node.children) {
        if (seen.has(childId)) {
          violations.push(`duplicate child id:${id}:${childId}`);
        } else {
          seen.add(childId);
        }
      }
    }

    if (node.type === "list") {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      if (parent?.type === "list-item" && node.children.length === 0) {
        violations.push(`empty nested list:${id}`);
      }
    }

    if (node.type === "code") {
      for (let index = 0; index < node.children.length; index += 1) {
        const childId = node.children[index];
        const child = nodes.get(childId);
        if (!child) {
          violations.push(`missing code-line node:${node.id}:${childId}`);
          continue;
        }
        if (child.type !== "code-line") {
          violations.push(`non-code child in code block:${node.id}:${child.id}:${child.type}`);
          continue;
        }
        const expectedId = expectedCodeLineId(node.id, index);
        if (child.id !== expectedId) {
          violations.push(`code-line id mismatch:${node.id}:${child.id}:${expectedId}`);
        }
        const indexProp = typeof child.props?.index === "number" ? (child.props.index as number) : null;
        if (indexProp !== index) {
          violations.push(`code-line index mismatch:${node.id}:${child.id}:${indexProp}:${index}`);
        }
      }
    }
  }

  return violations;
}
function buildNodeFromSnapshot(
  map: NodeMap,
  snapshot: NodeSnapshot,
  parentId: string | null,
  blockEpoch: number,
  themes?: { light?: string; dark?: string },
  previous?: ReadonlyMap<string, NodeRecord>,
): NodeRecord {
  if (
    snapshot.range !== undefined &&
    parseSourceRange(snapshot.range, inputSourceSnapshotForMap(map)?.length) === null
  ) {
    throw new RangeError("Node snapshot range must be an ordered UTF-16 interval inside canonical input");
  }
  if (snapshot.inputSource !== undefined) {
    throw new TypeError("Input source baseline is only valid on the document root");
  }
  if (snapshot.code && snapshot.type !== "code") {
    throw new TypeError("Code source metadata is only valid on code nodes");
  }
  if (snapshot.table && snapshot.type !== "table") {
    throw new TypeError("Table source metadata is only valid on table nodes");
  }
  if (snapshot.table && (snapshot.children?.length ?? 0) > 0) {
    throw new TypeError("Managed table snapshots cannot carry a synthetic child tree");
  }
  if (snapshot.paragraph && snapshot.type !== "paragraph") {
    throw new TypeError("Paragraph source metadata is only valid on paragraph nodes");
  }
  if (snapshot.paragraph && (snapshot.code || snapshot.table)) {
    throw new TypeError("A snapshot node cannot own multiple managed source families");
  }
  if (snapshot.paragraph && (snapshot.children?.length ?? 0) > 0) {
    throw new TypeError("Managed paragraph children must be sourced from span records");
  }
  const prior = previous?.get(snapshot.id);
  const canonicalSource = inputSourceSnapshotForMap(map);
  let tableState: ManagedTableViewState | undefined;
  if (snapshot.table) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      const tableCounters = codeCountersByMap!.get(map);
      tableState = createManagedTableState(
        snapshot.table,
        snapshot.id,
        tableCounters ? { counters: tableCounters } as never : undefined,
        canonicalSource,
      );
    } else {
      tableState = createManagedTableState(snapshot.table, snapshot.id, undefined, canonicalSource);
    }
  }
  let paragraphState: ManagedParagraphViewState | undefined;
  if (snapshot.paragraph) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      const paragraphCounters = paragraphCountersByMap!.get(map);
      paragraphState = createManagedParagraphState(
        snapshot.paragraph,
        snapshot.id,
        paragraphCounters ? { counters: paragraphCounters, counterStage: "store" } : undefined,
        canonicalSource,
      );
    } else {
      paragraphState = createManagedParagraphState(snapshot.paragraph, snapshot.id, undefined, canonicalSource);
    }
  }
  const nativeContainer = isNativeContainerType(snapshot.type);
  let admittedMeta = snapshot.meta;
  const metaPrepared = nativeContainer && admittedMeta?.preparedNested !== undefined;
  if (nativeContainer && admittedMeta && Object.prototype.hasOwnProperty.call(admittedMeta, "preparedNested")) {
    const { preparedNested: _preparedNested, ...rest } = admittedMeta;
    admittedMeta = rest;
  }
  const record: NodeRecord = {
    id: snapshot.id,
    type: snapshot.type,
    parentId,
    children: [],
    props: snapshot.paragraph ? normalizeParagraphNodeProps(snapshot) : prior && codeLineSnapshotMatches(snapshot, prior) ? prior.props : normalizeNodeProps(snapshot),
    meta: snapshot.paragraph ? normalizeParagraphNodeMeta(snapshot) : admittedMeta ? { ...admittedMeta } : undefined,
    range: snapshot.range ? { ...snapshot.range } : undefined,
    version: 0,
    blockEpoch,
    block: snapshot.paragraph
      ? snapshot.props?.block && typeof snapshot.props.block === "object"
        ? snapshotToBlock(snapshot) ?? undefined
        : undefined
      : snapshotToBlock(snapshot) ?? undefined,
  };
  (record as NodeRecordWithSerializedBlock)[serializedBlockOwnership] =
    typeof snapshot.props?.block === "object" && snapshot.props.block !== null;
  const incomingBlock = snapshot.props?.block as Block | undefined;
  const blockPrepared = nativeContainer && incomingBlock?.payload?.meta?.preparedNested !== undefined;
  if (blockPrepared || metaPrepared) {
    nativePreparedLayoutByRecord.set(record, { block: blockPrepared, meta: metaPrepared });
  }
  if (tableState && record.block) record.block.isFinalized = tableState.source.state !== "open";

  let codeState: StoredCodeBlockState | undefined;
  if (record.type === "code") {
    applyCodeBlockMetadata(record, themes);
    const codeCounters = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? codeCountersByMap!.get(map)
      : undefined;
    codeState = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? createStoredCodeBlockState(snapshot, record.block, canonicalSource, codeCounters)
      : createStoredCodeBlockState(snapshot, record.block, canonicalSource);
  }

  map.set(record.id, record);
  if (codeState) codeStateByRecord.set(record, codeState);
  if (tableState) tableStateByRecord.set(record, tableState);
  markRecordChanged(record.id);
  if (paragraphState) paragraphStateByRecord.set(record, paragraphState);

  if (paragraphState) {
    for (let spanIndex = 0; spanIndex < paragraphState.spans.length; spanIndex += 1) {
      const span = paragraphState.spans.get(spanIndex);
      for (const child of span?.children ?? []) {
        buildNodeFromSnapshot(map, child as NodeSnapshot, record.id, blockEpoch, themes, previous);
      }
    }
  } else {
    const childSnapshots = tableState ? [] : ensureArray(snapshot.children);
    for (const child of childSnapshots) {
      if (snapshot.code && child.type === "code-line") {
        const index = typeof child.props?.index === "number" ? child.props.index : -1;
        const line = Number.isSafeInteger(index) && index >= 0 ? snapshot.code.lines[index] : undefined;
        if (line?.id === child.id && line.index === index) continue;
      }
      const childRecord = buildNodeFromSnapshot(map, child, record.id, blockEpoch, themes, previous);
      record.children.push(childRecord.id);
    }
  }

  if (prior && previous && recordMatchesPrior(map, record, prior, previous)) {
    // Same derived content as the record being replaced: keep its identity so views bail out.
    prior.blockEpoch = blockEpoch;
    forgetSourceProjections(prior);
    map.set(prior.id, prior);
    return prior;
  }
  if (prior) {
    // Share unchanged leaves of a changed record (props and block are replaced wholesale, never mutated).
    if (plainDataEqual(record.props, prior.props)) record.props = prior.props;
    if (record.block && prior.block && plainDataEqual(record.block, prior.block)) record.block = prior.block;
  }
  return record;
}
function updateParagraphSpanChildRecords(
  map: NodeMap,
  parent: NodeRecord,
  previousSpan: ParagraphSpanRecord | undefined,
  nextSpan: ParagraphSpanRecord | undefined,
  touched: Set<string>,
): boolean {
  const oldChildren = previousSpan?.children ?? [];
  const nextChildren = nextSpan?.children ?? [];
  const nextIds = new Set(nextChildren.map((child) => child.id));
  let stableTopology = oldChildren.length === nextChildren.length;
  for (const child of oldChildren) {
    if (!nextIds.has(child.id)) removeSubtree(map, child.id, touched);
  }
  for (let index = 0; index < nextChildren.length; index += 1) {
    const child = nextChildren[index];
    const previousChild = oldChildren[index];
    if (
      !previousChild ||
      previousChild.id !== child.id ||
      previousChild.type !== child.type ||
      previousChild.range.from !== child.range.from ||
      previousChild.range.to !== child.range.to
    ) stableTopology = false;
    const prior = map.get(child.id);
    const previous = prior ? new Map([[prior.id, prior]]) : undefined;
    const next = buildNodeFromSnapshot(map, child as NodeSnapshot, parent.id, parent.blockEpoch, undefined, previous);
    if (prior && next !== prior) {
      next.version = prior.version + 1;
      markRecordChanged(next.id);
      touched.add(next.id);
    }
  }
  return stableTopology;
}

/** Current legacy code record as the snapshot shape the legacy code state is derived from; the block supplies range and raw. */
function legacyCodeSnapshot(map: NodeMap, record: NodeRecord): NodeSnapshot {
  return {
    id: record.id,
    type: record.type,
    props: record.props,
    children: record.children.map((childId) => {
      const child = map.get(childId);
      return { id: childId, type: child?.type ?? "code-line", props: child?.props };
    }),
  };
}

/**
 * Mirrors `normalizeCodeLineProps`: a line whose text, index, tokens and html are unchanged keeps its props.
 * Streamed lines store `tokens: null` where a snapshot omits the key; views read tokens by truthiness only.
 */
function codeLineSnapshotMatches(snapshot: NodeSnapshot, prior: NodeRecord): boolean {
  if (snapshot.type !== "code-line" || prior.type !== "code-line") return false;
  const props = snapshot.props ?? {};
  const priorProps = prior.props;
  const index = typeof props.index === "number" ? props.index : 0;
  if (index !== priorProps.index || props.text !== priorProps.text) return false;
  if (typeof props.html !== "string" || props.html !== priorProps.html) return false;
  return plainDataEqual(props.tokens ?? null, priorProps.tokens ?? null);
}

/**
 * A rebuilt record equals the record it replaces when every derived field matches and every child resolved to
 * the prior child object. List `depth` is the only store-derived prop: list normalization recomputes it after
 * the replace, so it is ignored here. Code lines are rendered from props alone (a snapshot also attaches a
 * per-line `block` that streamed lines never carry), so their props decide.
 */
function recordMatchesPrior(map: NodeMap, record: NodeRecord, prior: NodeRecord, previous: ReadonlyMap<string, NodeRecord>): boolean {
  if (prior.type !== record.type || prior.parentId !== record.parentId) return false;
  if (hasSerializedBlock(record) !== hasSerializedBlock(prior)) return false;
  if (record.type === "code") return false;
  if (tableStateByRecord.has(record)) return false;
  if (paragraphStateByRecord.has(record)) return false;
  if (!arraysEqual(prior.children, record.children)) return false;
  for (const childId of record.children) {
    if (map.get(childId) !== previous.get(childId)) return false;
  }
  if (!plainDataEqual(record.meta, prior.meta) || !plainDataEqual(record.range, prior.range)) return false;
  if (!plainDataEqual(record.block, prior.block)) return false;
  if (!plainDataEqual(nativePreparedLayoutByRecord.get(record), nativePreparedLayoutByRecord.get(prior))) return false;
  if (record.type === "list" || record.type === "list-item") {
    const { depth: _priorDepth, ...priorProps } = prior.props;
    return plainDataEqual(record.props, priorProps);
  }
  return plainDataEqual(record.props, prior.props);
}

/** Strict structural equality for structured-clone data (snapshot props, blocks, meta). */
function plainDataEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!plainDataEqual(a[index], b[index])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keys = Object.keys(recordA);
  if (keys.length !== Object.keys(recordB).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(recordB, key) || !plainDataEqual(recordA[key], recordB[key])) return false;
  }
  return true;
}

function collectSubtreeRecords(map: NodeMap, rootId: string): Map<string, NodeRecord> {
  const records = new Map<string, NodeRecord>();
  const stack = [rootId];
  while (stack.length > 0) {
    const record = map.get(stack.pop() as string);
    if (!record || records.has(record.id)) continue;
    records.set(record.id, record);
    for (const childId of record.children) stack.push(childId);
    const paragraph = paragraphStateByRecord.get(record);
    if (paragraph) {
      for (let index = 0; index < paragraph.spans.length; index += 1) {
        for (const child of paragraph.spans.get(index)?.children ?? []) stack.push(child.id);
      }
    }
  }
  return records;
}

function removeSubtree(
  map: NodeMap,
  id: string,
  touched: Set<string>,
  skipRootUnlink = false,
  onRemovedNode?: (record: NodeRecord) => void,
) {
  const record = map.get(id);
  if (!record) return;
  const stack = [record];
  const affectedParents = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.parentId && !(skipRootUnlink && node === record)) {
      const parent = map.get(node.parentId);
      if (parent) {
        const idx = parent.children.indexOf(node.id);
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          paragraphCountersByMap!.get(map)?.recordPrefixComparisons?.(
            idx === -1 ? parent.children.length : idx + 1,
            "store",
          );
        }
        if (idx !== -1) {
          const children = parent.children.slice();
          children.splice(idx, 1);
          parent.children = children;
          bumpVersion(parent);
          touched.add(parent.id);
          affectedParents.add(parent.id);
        }
      }
    }
    rememberRetiredCodeOwner(map, node);
    rememberRetiredTableOwner(map, node);
    rememberRetiredParagraphOwner(map, node);
    onRemovedNode?.(node);
    map.delete(node.id);
    deleteSnapshotCacheEntry(map, node.id);
    touched.add(node.id);
    for (const childId of node.children) {
      const child = map.get(childId);
      if (child) stack.push(child);
    }
    const paragraph = paragraphStateByRecord.get(node);
    if (paragraph) {
      for (let index = 0; index < paragraph.spans.length; index += 1) {
        for (const child of paragraph.spans.get(index)?.children ?? []) {
          const childRecord = map.get(child.id);
          if (childRecord) stack.push(childRecord);
        }
      }
    }
  }
  for (const parentId of affectedParents) {
    const parent = map.get(parentId);
    if (parent && parent.type === "code") {
      normalizeCodeBlockChildren(map, parent, touched);
    }
  }
}

// Internal records are copy-on-write (every block change assigns a new `record.block`), so one public clone per
// internal block object stays valid until that record changes; unchanged blocks keep their identity across reads.
function codeLineTokensForSnapshot(line: CodeLineRecord): TokenLineV1 | undefined {
  const decoration = line.decoration;
  if (!decoration) return undefined;
  return {
    spans: decoration.tokens.spans.map((span) => ({
      t: span.t,
      ...(span.v ? { v: {
        ...(span.v.dark ? { dark: { ...span.v.dark } } : {}),
        ...(span.v.light ? { light: { ...span.v.light } } : {}),
      } } : {}),
      ...(span.s ? { s: { ...span.s } } : {}),
    })),
  };
}

function managedCodeLineSnapshots(ownerId: string, lines: readonly CodeLineRecord[]): NodeSnapshot[] {
  const children: NodeSnapshot[] = [];
  for (const line of lines) {
    const props: Record<string, unknown> = {
      index: line.index,
      text: line.text,
      html: line.text,
      isProvisional: line.isProvisional,
    };
    const tokens = codeLineTokensForSnapshot(line);
    if (tokens) props.tokens = tokens;
    if (line.diffKind !== undefined) props.diffKind = line.diffKind;
    if (line.oldNo !== undefined) props.oldNo = line.oldNo;
    if (line.newNo !== undefined) props.newNo = line.newNo;
    children.push({
      id: `${ownerId}::line:${line.index}`,
      type: "code-line",
      props,
      children: [],
    });
  }
  return children;
}
function blockWithCodeTokenLines(block: Block, lines: readonly CodeLineRecord[]): Block {
  const tokenLines: (TokenLineV1 | null)[] = [];
  let hasTokens = false;
  for (const line of lines) {
    const tokens = codeLineTokensForSnapshot(line);
    tokenLines.push(tokens ?? null);
    hasTokens = hasTokens || tokens !== undefined;
  }
  const blockMeta = block.payload.meta;
  if (!hasTokens && !blockMeta?.tokenLines) return block;
  const payloadDescriptors = Object.getOwnPropertyDescriptors(block.payload);
  const meta = { ...(blockMeta ?? {}) };
  if (hasTokens) meta.tokenLines = tokenLines;
  else delete meta.tokenLines;
  payloadDescriptors.meta = { configurable: true, enumerable: true, writable: true, value: meta };
  return { ...block, payload: Object.defineProperties({}, payloadDescriptors) as Block["payload"] };
}

function nodePropsForSnapshot(record: NodeRecord, source?: SourceSnapshot): Record<string, unknown> {
  const props = { ...record.props };
  const codeState = codeStateByRecord.get(record);
  delete props.block;
  delete props.range;
  const codeRange = codeState?.managed ? codeState.view.source.sourceRange : undefined;
  const range = paragraphStateByRecord.get(record)?.source.sourceRange
    ?? tableStateByRecord.get(record)?.source.sourceRange
    ?? codeRange
    ?? (source && record.range ? parseSourceRange(record.range, source.length) : null);
  if (source && range && typeof props.raw === "string") props.raw = source.read(range.from, range.to);
  if (codeState) {
    delete props.lang;
    delete props.preAttrs;
    delete props.codeAttrs;
  }
  if (record.type === "list" || record.type === "list-item") delete props.depth;
  return props;
}

function coldBlockForStoreNode(
  map: NodeMap,
  record: NodeRecord,
  source?: SourceSnapshot,
  legacyProjection = false,
  inheritedListLayout?: LegacyListLayout,
  primaryParagraph?: LegacyPrimaryParagraph,
): Block | undefined {
  const paragraphState = paragraphStateByRecord.get(record);
  if (paragraphState) {
    let block = coldParagraphBlocksByView.get(paragraphState);
    if (!block) {
      block = materializeManagedParagraphBlock(paragraphColdBlockBase(record, paragraphState), paragraphState);
      coldParagraphBlocksByView.set(paragraphState, block);
    }
    return block;
  }
  const tableState = tableStateByRecord.get(record);
  if (tableState) return tableColdBlock(record, tableState);
  const codeState = codeStateByRecord.get(record);
  if (codeState) {
    let block = coldCodeBlocksByView.get(codeState.view);
    if (!block) {
      block = materializeStoredCodeBlock(codeState, record.block, record.id, record.props, record.range);
      coldCodeBlocksByView.set(codeState.view, block);
    }
    return block;
  }
  const base = record.block ?? snapshotToBlock({
    id: record.id,
    type: record.type,
    props: record.props,
    range: record.range,
    meta: record.meta,
  });
  if (!base) return undefined;
  const range = record.range ?? base.payload.range;
  const sourceRange = source && range ? parseSourceRange(range, source.length) : null;
  let projected = sourceRange
    ? blockWithSourceRange(base, sourceRange, source)
    : record.range
      ? blockWithSourceRange(base, record.range)
      : base;
  if (!isNativeContainerType(record.type)) {
    return blockWithCanonicalInline(
      blockWithCanonicalMetadata(projected, record.meta),
      record.props.inline,
    );
  }

  const listLayout = record.type === "list" ? legacyListLayout(record) : inheritedListLayout;
  const itemPrimary = legacyProjection && record.type === "list-item"
    ? primaryParagraph ?? legacyPrimaryParagraph(map, record, source)
    : undefined;
  if (legacyProjection && record.type === "list-item" && itemPrimary) {
    projected = projectLegacyListItemBlock(projected, itemPrimary.block, itemPrimary.inline);
  }
  const meta: Record<string, unknown> = {
    ...(record.meta ?? {}),
    ...(projected.payload.meta ?? {}),
  };
  const prepared = storePreparedNested(map, record, source, legacyProjection, listLayout, itemPrimary);
  meta.preparedNested = prepared;
  if (legacyProjection && record.type === "list" && hasManagedPrimaryListChild(map, record)) {
    const existingItems = Array.isArray(meta.items) ? meta.items as InlineNode[][] : [];
    const currentItems = prepared.children
      .filter((child) => child.type === "list-item")
      .map((child, index) => Array.isArray(child.props?.inline)
        ? copyInlineNodes(child.props.inline as InlineNode[])
        : copyInlineNodes(existingItems[index] ?? []));
    meta.items = currentItems;
    // The prepared list props mirror the same items; a stale record copy must not survive beside them.
    if ("items" in prepared.props) prepared.props = { ...prepared.props, items: currentItems.map(copyInlineNodes) };
  }
  const payloadDescriptors = Object.getOwnPropertyDescriptors(projected.payload);
  payloadDescriptors.meta = { configurable: true, enumerable: true, writable: true, value: meta };
  const payload = Object.defineProperties({}, payloadDescriptors) as Block["payload"];
  projected = { ...projected, payload };
  return projected;
}

function storeNodeSnapshot(
  map: NodeMap,
  record: NodeRecord,
  source?: SourceSnapshot,
  legacyProjection = false,
  inheritedListLayout?: LegacyListLayout,
  primaryParagraph?: LegacyPrimaryParagraph,
): NodeSnapshot | undefined {
  const itemPrimary = legacyProjection && record.type === "list-item"
    ? primaryParagraph ?? legacyPrimaryParagraph(map, record, source)
    : undefined;
  const block = coldBlockForStoreNode(map, record, source, legacyProjection, inheritedListLayout, itemPrimary);
  if (!block) return undefined;
  const codeState = codeStateByRecord.get(record);
  const codeLines = codeState ? readStoredCodeLines(codeState, 0, codeState.view.lines.length) : undefined;
  const snapshotBlock = codeState?.managed && codeLines ? blockWithCodeTokenLines(block, codeLines) : block;
  const snapshot = createBlockSnapshot(snapshotBlock);
  const paragraphState = paragraphStateByRecord.get(record);
  const tableState = tableStateByRecord.get(record);
  const props = nodePropsForSnapshot(record, source);
  if (legacyProjection && record.type === "list-item") {
    const layout = inheritedListLayout ?? { ordered: false, loose: false };
    props.ordered = layout.ordered;
    props.loose = layout.loose;
    props.start = layout.start;
    if (itemPrimary) {
      props.inline = copyInlineNodes(itemPrimary.inline);
      props.text = legacyInlineText(itemPrimary.inline);
    }
  }
  snapshot.props = props;
  if (hasSerializedBlock(record) || paragraphState || tableState || codeState?.managed) {
    snapshot.props.block = snapshotBlock;
  }
  if (codeState && (codeState.managed || hasSerializedBlock(record))) {
    const view = codeState.view;
    const lines = codeLines ?? readStoredCodeLines(codeState, 0, view.lines.length);
    const code: CodeBlockSnapshot = {
      ...view.source,
      configurationRevision: view.configurationRevision,
      info: view.info,
      language: view.language,
      lines,
      raw: codeState.sourceSnapshot.materialize(),
    };
    snapshot.code = code;
    if (codeState.managed) snapshot.children = managedCodeLineSnapshots(record.id, lines);
  } else {
    delete snapshot.code;
  }
  if (!paragraphState) delete snapshot.paragraph;
  if (!tableState) delete snapshot.table;
  const range = paragraphState?.source.sourceRange
    ?? tableState?.source.sourceRange
    ?? (codeState?.managed ? codeState.view.source.sourceRange : undefined)
    ?? record.range;
  if (range) snapshot.range = { from: range.from, to: range.to };
  else delete snapshot.range;
  const preparedLayout = nativePreparedLayoutByRecord.get(record);
  const preparedNested = preparedLayout?.meta
    ? block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined
    : undefined;
  if (record.meta || preparedNested) {
    const meta = { ...(record.meta ?? {}) };
    const blockMeta = snapshotBlock.payload.meta;
    if (record.meta && blockMeta) {
      for (const key of Object.keys(meta)) {
        if (Object.prototype.hasOwnProperty.call(blockMeta, key)) meta[key] = blockMeta[key];
      }
    }
    if (preparedNested) meta.preparedNested = preparedNested;
    snapshot.meta = meta;
  } else {
    delete snapshot.meta;
  }
  if (
    record.type !== "code" &&
    !isNativeContainerType(record.type) &&
    record.children.length > 0 &&
    !tableStateByRecord.has(record) &&
    !paragraphStateByRecord.has(record) &&
    (!codeState || codeState.managed)
  ) {
    const children = record.children.flatMap((childId) => {
      const child = map.get(childId);
      if (!child) return [];
      const childSnapshot = storeNodeSnapshot(map, child, source, legacyProjection, inheritedListLayout);
      return childSnapshot ? [childSnapshot] : [];
    });
    // Keep block-derived HTML descendants until they have standalone store records.
    if (
      record.type === "html" &&
      Array.isArray(snapshotBlock.payload.meta?.htmlTree) &&
      children.length === 0
    ) {
      const pending = [...(snapshot.children ?? [])];
      while (pending.length > 0) {
        const childSnapshot = pending.pop();
        if (!childSnapshot) continue;
        for (const key of Object.keys(childSnapshot)) {
          if (Reflect.get(childSnapshot, key) === undefined) Reflect.deleteProperty(childSnapshot, key);
        }
        for (const descendant of childSnapshot.children ?? []) pending.push(descendant);
      }
    } else {
      snapshot.children = children;
    }
  } else if (record.type === "code" && !codeState?.managed) {
    snapshot.children = [];
  }
  return snapshot;
}


// Internal records are copy-on-write (every block change assigns a new `record.block`), so one public clone per
// internal block object stays valid until that record changes; unchanged blocks keep their identity across reads.
function convertNodeToBlocks(map: NodeMap, root: NodeRecord, publicBlocks: WeakMap<Block, Block>): Block[] {
  const result: Block[] = [];
  const source = inputSourceSnapshotForMap(map);
  for (const childId of root.children) {
    const child = map.get(childId);
    if (!child) continue;
    const paragraphState = paragraphStateByRecord.get(child);
    if (paragraphState) {
      let materialized = coldParagraphBlocksByView.get(paragraphState);
      if (!materialized) {
        materialized = materializeManagedParagraphBlock(paragraphColdBlockBase(child, paragraphState), paragraphState);
        coldParagraphBlocksByView.set(paragraphState, materialized);
      }
      let block = publicBlocks.get(materialized);
      if (!block) {
        block = cloneBlock(materialized);
        publicBlocks.set(materialized, block);
      }
      result.push(block);
      continue;
    }
    if (isNativeContainerType(child.type)) {
      const cachedCold = coldNativeContainerBlocks.get(child);
      let materialized = cachedCold?.version === child.version ? cachedCold.block : undefined;
      if (!materialized) {
        materialized = coldBlockForStoreNode(map, child, source, true);
        if (materialized) coldNativeContainerBlocks.set(child, { version: child.version, block: materialized });
      }
      if (!materialized) continue;
      let block = publicBlocks.get(materialized);
      if (!block) {
        block = cloneBlock(materialized);
        publicBlocks.set(materialized, block);
      }
      result.push(block);
      continue;
    }
    const codeState = codeStateByRecord.get(child);
    const tableState = tableStateByRecord.get(child);
    if (tableState) {
      const materialized = tableColdBlock(child, tableState);
      let block = publicBlocks.get(materialized);
      if (!block) {
        block = cloneBlock(materialized);
        publicBlocks.set(materialized, block);
      }
      result.push(block);
      continue;
    }
    if (codeState) {
      let materialized = coldCodeBlocksByView.get(codeState.view);
      if (!materialized) {
        materialized = materializeStoredCodeBlock(codeState, child.block, child.id, child.props, child.range);
        coldCodeBlocksByView.set(codeState.view, materialized);
      }
      let block = publicBlocks.get(materialized);
      if (!block) {
        block = cloneBlock(materialized);
        publicBlocks.set(materialized, block);
      }
      result.push(block);
      continue;
    }
    // Unmanaged blocks export the same canonical record projection live reads use; the public clone captures
    // its raw as a plain value, so a published export keeps its historical window.
    const exportedBlock = nodeRecordForRead(map, child).block;
    if (!exportedBlock) continue;
    let block = publicBlocks.get(exportedBlock);
    if (!block) {
      block = cloneBlock(exportedBlock);
      publicBlocks.set(exportedBlock, block);
    }
    result.push(block);
  }
  return result;
}

function resolveParent(map: NodeMap, path: { blockId: string; nodeId?: string; indexPath?: number[] }): NodeRecord | undefined {
  if (path.nodeId) {
    return map.get(path.nodeId);
  }
  if (path.blockId === PATCH_ROOT_ID) {
    return map.get(PATCH_ROOT_ID);
  }
  return map.get(path.blockId);
}

function insertSnapshotAt(
  map: NodeMap,
  parent: NodeRecord | undefined,
  index: number,
  snapshot: NodeSnapshot,
  touched?: Set<string>,
  blockEpoch?: number,
  themes?: { light?: string; dark?: string },
  previous?: ReadonlyMap<string, NodeRecord>,
  onCodeOwnerInserted?: (id: string) => void,
  retainedParentSlot = false,
): { record: NodeRecord; insertedIds: string[] } | null {
  if (!parent) return null;
  const previousRecord = previous?.get(snapshot.id);
  const previousParagraph = previousRecord && paragraphStateByRecord.get(previousRecord);
  const previousRetiredParagraphGeneration = previous
    ? retiredParagraphGenerations(previous).get(snapshot.id) ?? -1
    : -1;
  const currentRecord = map.get(snapshot.id);
  const currentParagraph = currentRecord && paragraphStateByRecord.get(currentRecord);
  const currentRetiredParagraphGeneration = retiredParagraphGenerations(map).get(snapshot.id) ?? -1;
  const replacesPreviousActiveParagraph = Boolean(
    snapshot.paragraph &&
      previousParagraph &&
      snapshot.paragraph.generation > previousRetiredParagraphGeneration &&
      paragraphSnapshotPreservesActiveOwner(previousParagraph, snapshot)
  );
  const replacesCurrentActiveParagraph = Boolean(
    snapshot.paragraph &&
      currentParagraph &&
      snapshot.paragraph.generation > currentRetiredParagraphGeneration &&
      paragraphSnapshotPreservesActiveOwner(currentParagraph, snapshot)
  );
  if (
    !codeSnapshotGenerationAllowed(map, snapshot) &&
    !replacesPreviousActiveParagraph &&
    !replacesCurrentActiveParagraph
  ) return null;
  if (replacesPreviousActiveParagraph) {
    const generations = retiredParagraphGenerations(map);
    if (previousRetiredParagraphGeneration < 0) generations.delete(snapshot.id);
    else generations.set(snapshot.id, previousRetiredParagraphGeneration);
  }
  const existingIndex = currentRecord ? parent.children.indexOf(snapshot.id) : -1;
  // Search only when this ID already has a record; a new tail append cannot duplicate an existing child.
  if (currentRecord && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    paragraphCountersByMap!.get(map)?.recordPrefixComparisons?.(
      existingIndex === -1 ? parent.children.length : existingIndex + 1,
      "store",
    );
  }
  if (existingIndex !== -1) {
    removeSubtree(map, parent.children[existingIndex], touched ?? new Set<string>());
  }
  if (replacesCurrentActiveParagraph) {
    const generations = retiredParagraphGenerations(map);
    if (currentRetiredParagraphGeneration < 0) generations.delete(snapshot.id);
    else generations.set(snapshot.id, currentRetiredParagraphGeneration);
  }
  const record = buildNodeFromSnapshot(map, snapshot, parent.id, blockEpoch ?? readSnapshotBlockEpoch(snapshot) ?? parent.blockEpoch, themes, previous);
  const insertedIds: string[] = [];

  const queue = [record];
  while (queue.length > 0) {
    const node = queue.pop();
    if (!node) continue;
    insertedIds.push(node.id);
    if (node.type === "code" && previous?.get(node.id) !== node) onCodeOwnerInserted?.(node.id);
    for (const childId of node.children) {
      const child = map.get(childId);
      if (child) queue.push(child);
    }
    const paragraph = paragraphStateByRecord.get(node);
    if (paragraph) {
      for (let index = 0; index < paragraph.spans.length; index += 1) {
        for (const child of paragraph.spans.get(index)?.children ?? []) {
          const childRecord = map.get(child.id);
          if (childRecord) queue.push(childRecord);
        }
      }
    }
  }

  if (!retainedParentSlot) {
    const clampedIndex = Math.min(Math.max(index, 0), parent.children.length);
    const tailAppend = currentRecord === undefined && clampedIndex === parent.children.length;
    if (tailAppend) {
      parent.children.push(record.id);
    } else {
      const children = parent.children.slice();
      children.splice(clampedIndex, 0, record.id);
      parent.children = children;
    }
    bumpVersion(parent);
    if (!tailAppend) ensureUniqueChildren(map, parent, touched);
    // Count the inserted reference slot only; Array#splice relocation is runtime-internal.
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      paragraphCountersByMap!.get(map)?.recordRecordSlotsAllocated(1, "store");
    }
  }
  return { record, insertedIds };
}

function replaceSnapshotAt(
  map: NodeMap,
  parent: NodeRecord | undefined,
  index: number,
  snapshot: NodeSnapshot,
  touched: Set<string>,
  blockEpoch?: number,
  themes?: { light?: string; dark?: string },
  onParagraphOwnerReplaced?: (id: string) => void,
  onCodeOwnerReplaced?: (id: string) => void,
) {
  if (!parent || index < 0 || index >= parent.children.length) return;
  const targetId = parent.children[index];
  const current = map.get(targetId);
  const currentParagraphState = current && paragraphStateByRecord.get(current);
  if (!codeSnapshotGenerationAllowed(map, snapshot)) return;
  // Rebuild from the snapshot, but let unchanged records keep their identity (and their React snapshots), so a
  // canonical replace of an already-correct block re-renders nothing.
  const previous = collectSubtreeRecords(map, targetId);
  const nodeSnapshots = getNodeSnapshotCacheForMap(map);
  const childrenSnapshots = getChildrenSnapshotCacheForMap(map);
  const previousNodeSnapshots = new Map<string, { version: number; node?: NodeRecord }>();
  const previousChildrenSnapshots = new Map<string, { version: number; children: ReadonlyArray<string> }>();
  for (const id of previous.keys()) {
    const nodeSnapshot = nodeSnapshots.get(id);
    if (nodeSnapshot) previousNodeSnapshots.set(id, nodeSnapshot);
    const childrenSnapshot = childrenSnapshots.get(id);
    if (childrenSnapshot) previousChildrenSnapshots.set(id, childrenSnapshot);
  }
  const retainParentSlot = snapshot.id === targetId;
  if (!retainParentSlot) {
    const parentChildren = parent.children.slice();
    parentChildren.splice(index, 1);
    parent.children = parentChildren;
  }
  const continuedOwners = continuedOwnerFloors(map, previous, snapshot);
  removeSubtree(map, targetId, touched, true);
  for (const [generations, id, floor] of continuedOwners) {
    if (floor === undefined) generations.delete(id);
    else generations.set(id, floor);
  }
  const inserted = insertSnapshotAt(map, parent, index, snapshot, touched, blockEpoch, themes, previous, onCodeOwnerReplaced, retainParentSlot);
  if (inserted && onParagraphOwnerReplaced && (currentParagraphState || snapshot.paragraph)) {
    onParagraphOwnerReplaced(targetId);
    if (snapshot.paragraph && snapshot.id !== targetId) onParagraphOwnerReplaced(snapshot.id);
  }
  if (inserted && onCodeOwnerReplaced) {
    for (const [id, record] of previous) {
      if (record.type === "code" && map.get(id) !== record) onCodeOwnerReplaced(id);
    }
  }
  for (const [id, record] of previous) {
    if (map.get(id) !== record) continue;
    const nodeSnapshot = previousNodeSnapshots.get(id);
    if (nodeSnapshot) nodeSnapshots.set(id, nodeSnapshot);
    const childrenSnapshot = previousChildrenSnapshots.get(id);
    if (childrenSnapshot) childrenSnapshots.set(id, childrenSnapshot);
  }
  if (inserted) {
    for (const id of inserted.insertedIds) {
      touched.add(id);
    }
  }
  if (parent.type === "code") {
    normalizeCodeBlockChildren(map, parent, touched);
  } else if (!retainParentSlot) {
    ensureUniqueChildren(map, parent, touched);
  }
}

// Only the counter-enabled diagnostic entry supplies this sink; normal builds erase its guarded accesses.
interface RendererCampaignCounters {
  recordRecordSlotsAllocated?(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordPrefixComparisons?(count?: number, stage?: string): void;
  recordStoreRecordsTouched?(count?: number, stage?: string): void;
  recordSnapshotNodes?(count?: number, stage?: string): void;
  recordSourceUnitsRead?(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordSourceUnitsMaterialized?(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordSourceDirectoryEntriesCopied?(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  reset?(): void;
}

type CampaignRendererStore = RendererStore & { campaignCounters?: RendererCampaignCounters };

function resolveStoreCodeCounters(options?: RendererStoreOptions): StoreCodeCounters | undefined {
  if (typeof __STREAM_MDX_COUNTERS__ === "undefined" || !__STREAM_MDX_COUNTERS__) return undefined;
  const counters = (options as RendererStoreOptions & { campaignCounters?: RendererCampaignCounters } | undefined)?.campaignCounters;
  if (!counters?.recordRecordSlotsAllocated) return undefined;
  return {
    recordRecordSlotsAllocated(count, stage) {
      counters.recordRecordSlotsAllocated?.(count, stage);
    },
    recordPrefixComparisons(count) {
      counters.recordPrefixComparisons?.(count, "store");
    },
    recordSourceUnitsRead(count) {
      counters.recordSourceUnitsRead?.(count, "store");
    },
    recordSourceUnitsMaterialized(count) {
      counters.recordSourceUnitsMaterialized?.(count, "store");
    },
    recordSourceDirectoryEntriesCopied(count) {
      counters.recordSourceDirectoryEntriesCopied?.(count, "store");
    },
  };
}
function resolveStoreParagraphCounters(options?: RendererStoreOptions): StoreParagraphCounters | undefined {
  if (typeof __STREAM_MDX_COUNTERS__ === "undefined" || !__STREAM_MDX_COUNTERS__) return undefined;
  const counters = (options as RendererStoreOptions & { campaignCounters?: RendererCampaignCounters } | undefined)?.campaignCounters;
  if (!counters?.recordRecordSlotsAllocated) return undefined;
  return {
    recordRecordSlotsAllocated(count, stage) {
      counters.recordRecordSlotsAllocated?.(count, stage);
    },
    recordPrefixComparisons(count) {
      counters.recordPrefixComparisons?.(count, "store");
    },
    recordSourceUnitsRead(count) {
      counters.recordSourceUnitsRead?.(count, "store");
    },
    recordSourceUnitsMaterialized(count) {
      counters.recordSourceUnitsMaterialized?.(count, "store");
    },
    recordSourceDirectoryEntriesCopied(count) {
      counters.recordSourceDirectoryEntriesCopied?.(count, "store");
    },
    recordStoreRecordsTouched(count, stage) {
      counters.recordStoreRecordsTouched?.(count, stage);
    },
  };
}


/** Read-only native frame rebuilt from cold blocks, which carry their managed owner snapshots. */
function createPreparedRendererStoreSnapshot(
  blocks: ReadonlyArray<Block>,
  themes?: { light: string; dark: string },
): RendererStore {
  const prepared = createRendererStore(blocks.map((block) => cloneBlock(block)), themes ? { themes: { ...themes } } : undefined);
  const readOnly = (): never => {
    throw new Error("Prepared renderer snapshots are read-only.");
  };
  const snapshot: RendererStore = {
    ...prepared,
    reset: readOnly,
    resetSnapshot: readOnly,
    applyPatches: readOnly,
    setThemes: readOnly,
  };
  registerNodeSubscriptions(snapshot, () => () => {});
  return snapshot;
}
export function createRendererStore(initialBlocks: Block[] = [], options?: RendererStoreOptions): RendererStore {
  let currentThemes = options?.themes;
  let nodes: NodeMap = createFreshNodeMap();
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    codeCountersByMap!.set(nodes, resolveStoreCodeCounters(options));
    paragraphCountersByMap!.set(nodes, resolveStoreParagraphCounters(options));
  }
  let version = 0;
  // Owner generations and worker input generations are independent; this version identifies a store baseline.
  let resetVersion = 0;
  let blocksCache: Block[] = [];
  let blocksDirty = true;
  const publicBlocks = new WeakMap<Block, Block>();
  const listeners = new Set<() => void>();
  const nodeListeners = new Map<string, Set<() => void>>();
  const tableRowRangesByBlock = new Map<string, Map<number, TableRowRangeSubscription>>();
  const codeLineRangesByBlock = new Map<string, Map<number, CodeLineRangeSubscription>>();
  const paragraphSpanRangesByBlock = new Map<string, Map<number, ParagraphSpanRangeSubscription>>();
  let pendingChangedIds = new Set<string>();
  let pendingTableRowRanges = new Map<string, Set<number>>();
  let pendingCodeLineRanges = new Map<string, Set<number>>();
  let pendingParagraphSpanRanges = new Map<string, Set<number>>();
  let notifyAllNodes = true;
  let notifyScheduled = false;
  let lastCoalescingMetrics: CoalescingMetrics | null = null;
  // Structural invariants are scanned lazily on read; `null` marks the tree changed since the last scan.
  let structuralViolations: string[] | null = null;
  let transientDiagnostics: string[] = [];
  let nextBlockEpoch = 1;
  let lastSemanticEnvelope: SemanticEnvelopeTuple | undefined;
  let provisionalBlockCount = 0;
  const isProvisionalRootBlock = (record: NodeRecord | undefined): boolean => {
    if (!record || record.parentId !== PATCH_ROOT_ID) return false;
    const state = codeStateByRecord.get(record);
    const tableState = tableStateByRecord.get(record);
    if (tableState) return tableState.source.state === "open";
    const paragraphState = paragraphStateByRecord.get(record);
    if (paragraphState) return paragraphState.source.state === "open";
    if (state?.managed) return state.view.source.state === "open";
    if (state) return record.block ? !record.block.isFinalized : state.view.source.state === "open";
    return Boolean(record.block && !record.block.isFinalized);
  };
  const updateRootProvisionalCount = (record: NodeRecord | undefined, wasProvisional: boolean): void => {
    if (!record || record.parentId !== PATCH_ROOT_ID) return;
    const isProvisional = isProvisionalRootBlock(record);
    if (wasProvisional !== isProvisional) provisionalBlockCount += isProvisional ? 1 : -1;
  };
  const recountRootProvisionalBlocks = (map: NodeMap): void => {
    const root = map.get(PATCH_ROOT_ID);
    let count = 0;
    for (const id of root?.children ?? []) {
      if (isProvisionalRootBlock(map.get(id))) count += 1;
    }
    provisionalBlockCount = count;
  };
  const debugCounters: StoreDebugCounters = {
    staleEpochRejected: 0,
    storeInvariantViolationCount: 0,
  };

  const allocateBlockEpoch = (preferred?: number): number => {
    const resolved = readNumericEpoch(preferred);
    if (resolved !== undefined) {
      nextBlockEpoch = Math.max(nextBlockEpoch, resolved + 1);
      return resolved;
    }
    const epoch = nextBlockEpoch;
    nextBlockEpoch += 1;
    return epoch;
  };

  const getRaf = () => {
    if (
      typeof globalThis !== "undefined" &&
      typeof (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame === "function"
    ) {
      return (globalThis as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame;
    }
    return null;
  };

  function scheduleNotify() {
    if (notifyScheduled) return;
    notifyScheduled = true;
    const raf = getRaf();
    if (raf) {
      raf(() => {
        notifyScheduled = false;
        notify();
      });
    } else {
      setTimeout(() => {
        notifyScheduled = false;
        notify();
      }, 0);
    }
  }

  function callListener(listener: () => void) {
    try {
      listener();
    } catch (error) {
      console.error("RendererStore listener failed", error);
    }
  }
  function notify() {
    const changedIds = pendingChangedIds;
    const changedTableRanges = pendingTableRowRanges;
    const changedCodeLineRanges = pendingCodeLineRanges;
    const changedParagraphRanges = pendingParagraphSpanRanges;
    const wakeAllNodes = notifyAllNodes;
    pendingChangedIds = new Set();
    pendingTableRowRanges = new Map();
    pendingCodeLineRanges = new Map();
    pendingParagraphSpanRanges = new Map();
    notifyAllNodes = false;
    if (wakeAllNodes) {
      for (const ranges of tableRowRangesByBlock.values()) {
        for (const range of ranges.values()) {
          range.rows = undefined;
          range.generation = undefined;
        }
      }
      for (const ranges of paragraphSpanRangesByBlock.values()) {
        for (const range of ranges.values()) {
          range.spans = undefined;
          range.generation = undefined;
        }
      }
    }
    for (const listener of listeners) callListener(listener);
    if (wakeAllNodes) {
      for (const nodeSet of nodeListeners.values()) {
        for (const listener of nodeSet) callListener(listener);
      }
    } else {
      for (const id of changedIds) {
        const nodeSet = nodeListeners.get(id);
        if (!nodeSet) continue;
        for (const listener of nodeSet) callListener(listener);
      }
      for (const id of changedIds) {
        const ranges = paragraphSpanRangesByBlock.get(id);
        if (!ranges) continue;
        const record = nodes.get(id);
        const currentGeneration = record ? paragraphStateByRecord.get(record)?.source.generation : undefined;
        const changedStarts = changedParagraphRanges.get(id);
        for (const range of ranges.values()) {
          let staleGeneration = false;
          for (const generation of range.listenerGenerations.values()) {
            if (generation !== currentGeneration) {
              staleGeneration = true;
              break;
            }
          }
          if (!staleGeneration) continue;
          range.spans = undefined;
          range.generation = undefined;
          if (changedStarts?.has(range.from)) continue;
          for (const listener of range.listeners) callListener(listener);
        }
      }
    }
    if (wakeAllNodes) {
      for (const ranges of tableRowRangesByBlock.values()) {
        for (const range of ranges.values()) {
          for (const listener of range.listeners) callListener(listener);
        }
      }
      for (const ranges of paragraphSpanRangesByBlock.values()) {
        for (const range of ranges.values()) {
          for (const listener of range.listeners) callListener(listener);
        }
      }
      for (const ranges of codeLineRangesByBlock.values()) {
        for (const range of ranges.values()) {
          for (const listener of range.listeners) callListener(listener);
        }
      }
      return;
    }
    for (const [blockId, starts] of changedTableRanges) {
      const ranges = tableRowRangesByBlock.get(blockId);
      if (!ranges) continue;
      for (const rangeStart of starts) {
        const range = ranges.get(rangeStart);
        if (!range) continue;
        for (const listener of range.listeners) callListener(listener);
      }
    }
    for (const [blockId, starts] of changedParagraphRanges) {
      const ranges = paragraphSpanRangesByBlock.get(blockId);
      if (!ranges) continue;
      for (const rangeStart of starts) {
        const range = ranges.get(rangeStart);
        if (!range) continue;
        for (const listener of range.listeners) callListener(listener);
      }
    }
    for (const [blockId, starts] of changedCodeLineRanges) {
      const ranges = codeLineRangesByBlock.get(blockId);
      if (!ranges) continue;
      for (const rangeStart of starts) {
        const range = ranges.get(rangeStart);
        if (!range) continue;
        for (const listener of range.listeners) callListener(listener);
      }
    }
  }

  function queueTableRowRange(blockId: string, rangeStart: number): void {
    let starts = pendingTableRowRanges.get(blockId);
    if (!starts) {
      starts = new Set<number>();
      pendingTableRowRanges.set(blockId, starts);
    }
    starts.add(rangeStart);
  }
  function queueCodeLineRange(blockId: string, rangeStart: number): void {
    let starts = pendingCodeLineRanges.get(blockId);
    if (!starts) {
      starts = new Set<number>();
      pendingCodeLineRanges.set(blockId, starts);
    }
    starts.add(rangeStart);
  }
  function invalidateCodeLineRange(blockId: string, from: number, to: number): void {
    if (from >= to) return;
    const ranges = codeLineRangesByBlock.get(blockId);
    if (!ranges) return;
    const firstRange = Math.floor(from / CODE_LINE_RANGE_SIZE) * CODE_LINE_RANGE_SIZE;
    const lastRange = Math.floor((to - 1) / CODE_LINE_RANGE_SIZE) * CODE_LINE_RANGE_SIZE;
    for (let rangeStart = firstRange; rangeStart <= lastRange; rangeStart += CODE_LINE_RANGE_SIZE) {
      if (ranges.has(rangeStart)) queueCodeLineRange(blockId, rangeStart);
    }
  }
  function invalidateCodeLineIndex(blockId: string, index: number): void {
    if (!Number.isSafeInteger(index) || index < 0) return;
    const rangeStart = Math.floor(index / CODE_LINE_RANGE_SIZE) * CODE_LINE_RANGE_SIZE;
    if (codeLineRangesByBlock.get(blockId)?.has(rangeStart)) queueCodeLineRange(blockId, rangeStart);
  }
  function invalidateCodeLineIndices(blockId: string, indices: Iterable<number>): void {
    for (const index of indices) invalidateCodeLineIndex(blockId, index);
  }
  function invalidateAllCodeLineRanges(blockId: string): void {
    const ranges = codeLineRangesByBlock.get(blockId);
    if (!ranges) return;
    for (const rangeStart of ranges.keys()) queueCodeLineRange(blockId, rangeStart);
  }
  function getOrCreateCodeLineRange(blockId: string, from: number): CodeLineRangeSubscription {
    let ranges = codeLineRangesByBlock.get(blockId);
    if (!ranges) {
      ranges = new Map<number, CodeLineRangeSubscription>();
      codeLineRangesByBlock.set(blockId, ranges);
    }
    let range = ranges.get(from);
    if (!range) {
      range = { listeners: new Set() };
      ranges.set(from, range);
    }
    return range;
  }
  function queueParagraphSpanRange(blockId: string, rangeStart: number): void {
    let starts = pendingParagraphSpanRanges.get(blockId);
    if (!starts) {
      starts = new Set<number>();
      pendingParagraphSpanRanges.set(blockId, starts);
    }
    starts.add(rangeStart);
  }

  function invalidateParagraphSpanRange(blockId: string, from: number, to: number): void {
    if (from >= to) return;
    const ranges = paragraphSpanRangesByBlock.get(blockId);
    if (!ranges) return;
    const firstRange = Math.floor(from / PARAGRAPH_SPAN_RANGE_SIZE) * PARAGRAPH_SPAN_RANGE_SIZE;
    const lastRange = Math.floor((to - 1) / PARAGRAPH_SPAN_RANGE_SIZE) * PARAGRAPH_SPAN_RANGE_SIZE;
    for (let rangeStart = firstRange; rangeStart <= lastRange; rangeStart += PARAGRAPH_SPAN_RANGE_SIZE) {
      const range = ranges.get(rangeStart);
      if (!range) continue;
      range.spans = undefined;
      queueParagraphSpanRange(blockId, rangeStart);
    }
  }
  function invalidateAllParagraphSpanRanges(blockId: string): void {
    const ranges = paragraphSpanRangesByBlock.get(blockId);
    if (!ranges) return;
    for (const [rangeStart, range] of ranges) {
      range.spans = undefined;
      queueParagraphSpanRange(blockId, rangeStart);
    }
  }

  function getOrCreateParagraphSpanRange(blockId: string, from: number): ParagraphSpanRangeSubscription {
    let ranges = paragraphSpanRangesByBlock.get(blockId);
    if (!ranges) {
      ranges = new Map<number, ParagraphSpanRangeSubscription>();
      paragraphSpanRangesByBlock.set(blockId, ranges);
    }
    let range = ranges.get(from);
    if (!range) {
      range = {
        from,
        to: from + PARAGRAPH_SPAN_RANGE_SIZE,
        listeners: new Set(),
        listenerGenerations: new Map(),
      };
      ranges.set(from, range);
    }
    return range;
  }

  function invalidateTableRowRange(blockId: string, from: number, to: number): void {
    if (from >= to) return;
    const ranges = tableRowRangesByBlock.get(blockId);
    if (!ranges) return;
    const firstRange = Math.floor(from / TABLE_ROW_RANGE_SIZE) * TABLE_ROW_RANGE_SIZE;
    const lastRange = Math.floor((to - 1) / TABLE_ROW_RANGE_SIZE) * TABLE_ROW_RANGE_SIZE;
    for (let rangeStart = firstRange; rangeStart <= lastRange; rangeStart += TABLE_ROW_RANGE_SIZE) {
      const range = ranges.get(rangeStart);
      if (!range) continue;
      range.rows = undefined;
      queueTableRowRange(blockId, rangeStart);
    }
  }

  function invalidateTableRowIndices(blockId: string, indices: ReadonlyArray<number>): void {
    if (indices.length === 0) return;
    const ranges = tableRowRangesByBlock.get(blockId);
    if (!ranges) return;
    const changedRanges = new Set<number>();
    for (const index of indices) changedRanges.add(Math.floor(index / TABLE_ROW_RANGE_SIZE) * TABLE_ROW_RANGE_SIZE);
    for (const rangeStart of changedRanges) {
      const range = ranges.get(rangeStart);
      if (!range) continue;
      range.rows = undefined;
      queueTableRowRange(blockId, rangeStart);
    }
  }

  function getOrCreateTableRowRange(blockId: string, from: number, to: number): TableRowRangeSubscription {
    let ranges = tableRowRangesByBlock.get(blockId);
    if (!ranges) {
      ranges = new Map<number, TableRowRangeSubscription>();
      tableRowRangesByBlock.set(blockId, ranges);
    }
    let range = ranges.get(from);
    if (!range) {
      range = { from, to, listeners: new Set() };
      ranges.set(from, range);
    }
    return range;
  }


  function appendDiagnostic(message: string) {
    transientDiagnostics = [...transientDiagnostics, message];
    debugCounters.storeInvariantViolationCount += 1;
  }

  function rebuildFromBlocks(blocks: Block[], resetsBaseline = false) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      (store as CampaignRendererStore).campaignCounters?.reset?.();
    }
    const previousNodes = nodes;
    const nextNodes = createFreshNodeMap();
    carryStoreCounters(previousNodes, nextNodes);
    const root = createRootRecord();
    nextNodes.set(root.id, root);
    root.children = [];
    lastCoalescingMetrics = null;
    for (let i = 0; i < blocks.length; i++) {
      const block = cloneBlock(blocks[i]);
      const snapshot = createBlockSnapshot(block);
      insertSnapshotAt(
        nextNodes,
        root,
        root.children.length,
        snapshot,
        undefined,
        allocateBlockEpoch(readSnapshotBlockEpoch(snapshot)),
      );
    }
    recountRootProvisionalBlocks(nextNodes);
    normalizeAllListDepths(nextNodes, new Set<string>(), PATCH_ROOT_ID);
    for (const record of previousNodes.values()) blockEpochWriteSerials.delete(record);
    clearSnapshotCaches(previousNodes);
    nodes = nextNodes;
    if (resetsBaseline) lastSemanticEnvelope = undefined;
    if (resetsBaseline) resetVersion++;
    transientDiagnostics = [];
    structuralViolations = null;
    version++;
    blocksDirty = true;
    notifyAllNodes = true;
    // Defer notification to avoid React "Cannot update a component while rendering" warning
    // Use rAF (or fallback) to align with frame updates
    scheduleNotify();
  }
  function rebuildFromSnapshot(rootSnapshot: NodeSnapshot, resetsBaseline = false) {
    if (rootSnapshot.id !== PATCH_ROOT_ID || rootSnapshot.type !== "__root__" || !Array.isArray(rootSnapshot.children)) {
      throw new TypeError("Renderer snapshot root must be the __root__ node");
    }
    let nextInputSource: RendererInputSource | undefined;
    if (rootSnapshot.inputSource !== undefined) {
      const baseline = rootSnapshot.inputSource;
      if (
        !Number.isSafeInteger(baseline.generation) ||
        baseline.generation < 0 ||
        typeof baseline.raw !== "string" ||
        (rootSnapshot.range !== undefined && (
          rootSnapshot.range.from !== 0 ||
          rootSnapshot.range.to !== baseline.raw.length
        ))
      ) {
        throw new TypeError("Renderer input source baseline is invalid");
      }
      const document = new AppendSourceDocument();
      document.append(baseline.raw);
      nextInputSource = { generation: baseline.generation, document };
    }
    const previousNodes = nodes;
    const nextNodes = createFreshNodeMap();
    carryStoreCounters(previousNodes, nextNodes);
    const stack = [...rootSnapshot.children];
    while (stack.length > 0) {
      const snapshot = stack.pop();
      if (!snapshot) continue;
      if (
        (snapshot.type === "code" && snapshot.code) ||
        (snapshot.type === "paragraph" && snapshot.paragraph)
      ) {
        if (!codeSnapshotGenerationAllowed(nextNodes, snapshot)) {
          const owner = snapshot.paragraph ? "Paragraph" : "Code";
          throw new RangeError(`${owner} owner generation or revision is invalid:${snapshot.id}`);
        }
      }
      for (const child of snapshot.children ?? []) stack.push(child);
    }
    if (nextInputSource) inputSourceByNodeMap.set(nextNodes, nextInputSource);
    const root = createRootRecord();
    nextNodes.set(root.id, root);
    for (const child of rootSnapshot.children) {
      insertSnapshotAt(
        nextNodes,
        root,
        root.children.length,
        child,
        undefined,
        allocateBlockEpoch(readSnapshotBlockEpoch(child)),
        currentThemes,
      );
    }
    recountRootProvisionalBlocks(nextNodes);
    normalizeAllListDepths(nextNodes, new Set<string>(), PATCH_ROOT_ID);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      (store as CampaignRendererStore).campaignCounters?.reset?.();
    }
    for (const record of previousNodes.values()) blockEpochWriteSerials.delete(record);
    clearSnapshotCaches(previousNodes);
    nodes = nextNodes;
    if (resetsBaseline) lastSemanticEnvelope = undefined;
    if (resetsBaseline) resetVersion++;
    lastCoalescingMetrics = null;
    transientDiagnostics = [];
    structuralViolations = null;
    version++;
    blocksDirty = true;
    notifyAllNodes = true;
    scheduleNotify();
  }


  const store: PrivateRendererStore = {
    reset(nextBlocks: Block[]) {
      rebuildFromBlocks(nextBlocks, true);
    },

    resetSnapshot(snapshot: NodeSnapshot) {
      rebuildFromSnapshot(snapshot, true);
    },

    getResetVersion() {
      return resetVersion;
    },

    applyPatches(patches: Patch[], options?: ApplyPatchesOptions) {
      const touched = new Set<string>();
      if (!patches || patches.length === 0) {
        lastCoalescingMetrics = options?.metrics ?? null;
        return touched;
      }
      const admittedPatches: Patch[] = [];
      const semanticEnvelopeDecisions = new Map<string, boolean>();
      let admissionFrontier = lastSemanticEnvelope;
      let newestAdmittedEnvelope: SemanticEnvelopeTuple | undefined;
      let hasUnsequencedSemanticPatch = false;
      let hasEnrichmentPatch = false;

      const admitSemanticEnvelope = (tuple: SemanticEnvelopeTuple): boolean => {
        const key = `${tuple.streamSeq}/${tuple.parseEpoch}/${tuple.tx}`;
        const existingDecision = semanticEnvelopeDecisions.get(key);
        if (existingDecision !== undefined) return existingDecision;

        const accepted = !admissionFrontier || (
          tuple.parseEpoch >= admissionFrontier.parseEpoch &&
          compareSemanticEnvelopeTuples(tuple, admissionFrontier) > 0
        );
        semanticEnvelopeDecisions.set(key, accepted);
        if (!accepted) {
          debugCounters.staleEpochRejected += 1;
          return false;
        }
        admissionFrontier = tuple;
        newestAdmittedEnvelope = tuple;
        return true;
      };

      for (const patch of patches) {
        if (patch.op === "setPropsBatch") {
          const entries = Array.isArray(patch.entries) ? patch.entries : [];
          const admittedEntries: SetPropsBatchEntry[] = [];
          for (const entry of entries) {
            if (!entry || !entry.at) continue;
            const entryPatch: Patch = {
              op: "setProps",
              at: entry.at,
              props: entry.props,
              meta: { ...(patch.meta ?? {}), ...(entry.meta ?? {}) },
            };
            const kind = getPatchKind(entryPatch);
            const tuple = readSemanticEnvelopeTuple(entryPatch);
            if (tuple) {
              if (admitSemanticEnvelope(tuple)) admittedEntries.push(entry);
            } else {
              if (kind === "semantic") hasUnsequencedSemanticPatch = true;
              else hasEnrichmentPatch = true;
              admittedEntries.push(entry);
            }
          }
          if (admittedEntries.length === entries.length) admittedPatches.push(patch);
          else if (admittedEntries.length > 0) admittedPatches.push({ ...patch, entries: admittedEntries });
          continue;
        }

        const kind = getPatchKind(patch);
        const tuple = readSemanticEnvelopeTuple(patch);
        if (tuple) {
          if (admitSemanticEnvelope(tuple)) admittedPatches.push(patch);
        } else {
          if (kind === "semantic") hasUnsequencedSemanticPatch = true;
          else hasEnrichmentPatch = true;
          admittedPatches.push(patch);
        }
      }

      if (admittedPatches.length === 0) {
        lastCoalescingMetrics = options?.metrics ?? null;
        return touched;
      }

      const preserveEnvelopeGroups =
        semanticEnvelopeDecisions.size > 1 ||
        (semanticEnvelopeDecisions.size > 0 && (hasUnsequencedSemanticPatch || hasEnrichmentPatch));

      activeChangedIds = pendingChangedIds;
      let coalescedPatches = admittedPatches;
      let metrics: CoalescingMetrics | null = options?.metrics ?? null;

      if (!options?.coalesced && !preserveEnvelopeGroups) {
        const result = coalescePatchesWithMetrics(admittedPatches, DEFAULT_COALESCE_CONFIG);
        coalescedPatches = result.patches;
        metrics = result.metrics;
      }
      const perfEnabled = isPatchPerfDebugEnabled();
      const perfStart = perfEnabled ? getPerfNow() : 0;
      const opStats: Record<string, PatchPerfOpSummary> = perfEnabled ? {} : {};
      const setPropsByType: Record<string, PatchPerfOpSummary> = perfEnabled ? {} : {};
      const setPropsBySize: Record<string, PatchPerfOpSummary> = perfEnabled ? {} : {};
      const setPropsStages: Record<string, PatchPerfOpSummary> = perfEnabled ? {} : {};
      let applyMs = 0;
      let listNormalizeMs = 0;


      lastCoalescingMetrics = metrics;

      const root = nodes.get(PATCH_ROOT_ID);
      if (!root) {
        nodes.set(PATCH_ROOT_ID, createRootRecord());
        markRecordChanged(PATCH_ROOT_ID);
      }

      let mutatedBlocks = false;
      let listDepthDirty = false;
      const listDepthDirtyNodes = new Set<string>();
      const debugListPatches = isListPatchDebugEnabled();

      const isListRelated = (type: string | undefined) => type === "list" || type === "list-item";

      const recordSetPropsStage = (stage: string, duration: number) => {
        if (!perfEnabled) return;
        const entry = setPropsStages[stage] ?? { count: 0, durationMs: 0 };
        entry.count += 1;
        entry.durationMs += duration;
        setPropsStages[stage] = entry;
      };
      const logListPatch = (label: string, details: Record<string, unknown>) => {
        if (!debugListPatches) return;
        try {
          console.debug(`[list-patch] ${label}`, details);
        } catch {
          // ignore logging errors
        }
      };

      const findNearestListNode = (nodeId: string | undefined): NodeRecord | undefined => {
        if (!nodeId) return undefined;
        let current = nodes.get(nodeId);
        while (current) {
          if (current.type === "list") return current;
          if (!current.parentId) return undefined;
          current = nodes.get(current.parentId);
        }
        return undefined;
      };

      const markListDepthDirty = (nodeId: string | undefined) => {
        const listNode = findNearestListNode(nodeId);
        if (listNode) {
          listDepthDirtyNodes.add(listNode.id);
        } else {
          listDepthDirty = true;
        }
      };
      const semanticTxEpochs = new Map<string, { tx: number; blockEpoch: number }>();

      const resolveBlockEpochTarget = (patch: Patch, at: NodePath): NodeRecord | undefined => {
        if ((patch.op === "insertChild" || patch.op === "replaceChild") && at.blockId === PATCH_ROOT_ID) {
          const nodeId = patch.node?.id;
          return nodeId ? nodes.get(nodeId) : undefined;
        }
        return nodes.get(at.blockId) ?? (at.nodeId ? nodes.get(at.nodeId) : undefined);
      };

      const rejectStaleEpochPatch = (patch: Patch, at: NodePath | undefined): boolean => {
        const expectedBlockEpoch = readPatchBlockEpoch(patch);
        const patchTx = readPatchTx(patch);
        if (expectedBlockEpoch === undefined) {
          return false;
        }
        if (getPatchKind(patch) !== "semantic" || !at) {
          return false;
        }
        const target = resolveBlockEpochTarget(patch, at);
        if (!target) return false;
        const actualBlockEpoch = effectiveBlockEpoch(nodes, target);
        if (actualBlockEpoch === expectedBlockEpoch) return false;
        // A root insert/replace targets the block it carries, which is where its transaction's epoch was recorded.
        const epochBlockId = at.blockId === PATCH_ROOT_ID ? target.id : at.blockId;
        const txEpoch = epochBlockId && patchTx !== undefined ? semanticTxEpochs.get(epochBlockId) : undefined;
        if (txEpoch && txEpoch.tx === patchTx && txEpoch.blockEpoch === actualBlockEpoch) {
          return false;
        }
        debugCounters.staleEpochRejected += 1;
        appendDiagnostic(
          `stale epoch rejected:${patch.op}:${target.id}:expected=${expectedBlockEpoch}:actual=${actualBlockEpoch}`,
        );
        return true;
      };

      const advanceBlockEpoch = (
        blockId: string | undefined,
        touchedSet: Set<string>,
        preferredEpoch?: number,
        tx?: number,
      ): number | null => {
        if (!blockId || blockId === PATCH_ROOT_ID) {
          return null;
        }
        const blockRoot = nodes.get(blockId);
        if (!blockRoot) {
          return null;
        }
        const nextEpoch = allocateBlockEpoch(preferredEpoch);
        assignBlockEpoch(nodes, blockRoot.id, nextEpoch, touchedSet);
        if (tx !== undefined) {
          semanticTxEpochs.set(blockRoot.id, { tx, blockEpoch: nextEpoch });
        }
        return nextEpoch;
      };

      const applyPropsUpdate = (
        at: NodePath,
        props: Record<string, unknown> | undefined,
        preferredEpoch?: number,
        tx?: number,
        semanticUpdate = false,
      ) => {
        const perfStartLocal = perfEnabled ? getPerfNow() : 0;
        const targetId = at.nodeId ?? at.blockId;
        if (!targetId) return;
        let target = nodes.get(targetId);
        if (!target) return;
        const hasRangeUpdate = Object.prototype.hasOwnProperty.call(props ?? {}, "range");
        const hasMetaUpdate = Object.prototype.hasOwnProperty.call(props ?? {}, "meta");
        const hasFinalityUpdate = Object.prototype.hasOwnProperty.call(props ?? {}, "isFinalized");
        const finalityValue = props?.isFinalized;
        const codeProgressMeta = props?.meta;
        const codeProgressCandidate =
          target.type === "code" &&
          codeStateByRecord.get(target)?.managed &&
          typeof codeProgressMeta === "object" &&
          codeProgressMeta !== null &&
          !Array.isArray(codeProgressMeta)
            ? (codeProgressMeta as Record<string, unknown>).lazyTokenizedUntil
            : undefined;
        const lazyTokenizedUntil =
          typeof codeProgressCandidate === "number" &&
          Number.isSafeInteger(codeProgressCandidate) &&
          codeProgressCandidate >= 0
            ? codeProgressCandidate
            : undefined;
        const sourceForRangeUpdate = hasRangeUpdate ? inputSourceSnapshotForMap(nodes) : undefined;
        const rangeUpdate = hasRangeUpdate && sourceForRangeUpdate
          ? parseSourceRange(props?.range, sourceForRangeUpdate.length)
          : null;
        let hasManagedSourceOwner = false;
        if (hasRangeUpdate || hasMetaUpdate || hasFinalityUpdate) {
          let sourceOwner: NodeRecord | undefined = target;
          while (sourceOwner) {
            if (
              paragraphStateByRecord.has(sourceOwner) ||
              tableStateByRecord.has(sourceOwner) ||
              codeStateByRecord.has(sourceOwner) ||
              isManagedSourceFamily(sourceOwner.type)
            ) {
              hasManagedSourceOwner = true;
              break;
            }
            sourceOwner = sourceOwner.parentId ? nodes.get(sourceOwner.parentId) : undefined;
          }
        }
        const managedSourceFamily = isManagedSourceFamily(target.type);
        if (hasRangeUpdate) {
          const genericRangeTargetSupported =
            !hasManagedSourceOwner &&
            !managedSourceFamily &&
            target.type !== "paragraph" &&
            target.type !== "__root__";
          const rangeTargetSupported = !hasManagedSourceOwner && (
            isNativeContainerType(target.type) ||
            target.type === "list-item-text" ||
            target.type === "list-item-html" ||
            target.type === "list-item-mdx" ||
            (target.type === "paragraph" && !paragraphStateByRecord.has(target)) ||
            genericRangeTargetSupported
          );
          if (!rangeTargetSupported || !rangeUpdate) return;
        }
        const metadataType =
          props?.block && typeof props.block === "object" && typeof (props.block as Block).type === "string"
            ? (props.block as Block).type
            : target.type;
        const canUpdateGenericMeta =
          hasMetaUpdate &&
          !hasManagedSourceOwner &&
          !isManagedSourceFamily(metadataType);
        const canUpdateRootFinality =
          hasFinalityUpdate &&
          typeof finalityValue === "boolean" &&
          !hasManagedSourceOwner &&
          target.parentId === PATCH_ROOT_ID &&
          (target.type === "list" || target.type === "blockquote");
        let applyMetaUpdate = false;
        let nextMeta: Record<string, unknown> | undefined;
        if (canUpdateGenericMeta) {
          const candidate = props?.meta;
          if (candidate === null) {
            applyMetaUpdate = true;
          } else if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
            nextMeta = { ...(candidate as Record<string, unknown>) };
            if (isNativeContainerType(metadataType)) delete nextMeta.preparedNested;
            applyMetaUpdate = true;
          }
        }
        const metadataValue = nextMeta ? { ...nextMeta } : undefined;
        const metaChanged = applyMetaUpdate && !plainDataEqual(target.meta, metadataValue);
        if (metaChanged) {
          target.meta = metadataValue;
          mutatedBlocks = true;
          blocksDirty = true;
        }
        const rangeChanged = Boolean(
          rangeUpdate &&
            (target.range?.from !== rangeUpdate.from || target.range?.to !== rangeUpdate.to),
        );
        if (rangeChanged && rangeUpdate) target.range = { ...rangeUpdate };
        const parentType = target.parentId ? nodes.get(target.parentId)?.type : undefined;
        if (debugListPatches && (isListRelated(target.type) || isListRelated(parentType))) {
          logListPatch("setProps", {
            id: target.id,
            type: target.type,
            parentType,
            keys: props ? Object.keys(props) : [],
          });
        }

        let propsChanged = false;
        if (target.type === "code-line") {
          const normalizeStart = perfEnabled ? getPerfNow() : 0;
          const incoming: Record<string, unknown> = {
            index: props?.index,
            text: props?.text,
            html: props?.html,
          };
          if (Object.prototype.hasOwnProperty.call(props ?? {}, "tokens")) {
            incoming.tokens = (props as Record<string, unknown>).tokens;
          }
          if (Object.prototype.hasOwnProperty.call(props ?? {}, "isProvisional")) {
            incoming.isProvisional = (props as Record<string, unknown>).isProvisional;
          }
          const normalized = normalizeCodeLineProps(incoming, target.props);
          const updatedLineIndex = typeof normalized.index === "number" ? normalized.index : Number.NaN;
          if (perfEnabled) {
            recordSetPropsStage("code-line:normalize-props", getPerfNow() - normalizeStart);
          }
          const parent = target.parentId ? nodes.get(target.parentId) : undefined;
          let nextLegacyCodeState: StoredCodeBlockState | undefined;
          if (normalized !== target.props) {
            if (parent?.type === "code") {
              const currentCodeState = codeStateByRecord.get(parent);
              if (currentCodeState && !currentCodeState.managed) {
                const updatedLine = {
                  id: target.id,
                  index: updatedLineIndex,
                  props: normalized,
                };
                nextLegacyCodeState = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
                  ? updateLegacyCodeLineState(
                      currentCodeState,
                      updatedLine,
                      semanticUpdate,
                      inputSourceSnapshotForMap(nodes),
                      codeCountersByMap!.get(nodes),
                    )
                  : updateLegacyCodeLineState(
                      currentCodeState,
                      updatedLine,
                      semanticUpdate,
                      inputSourceSnapshotForMap(nodes),
                    );
                if (!nextLegacyCodeState) {
                  appendDiagnostic(`code line state update rejected:${parent.id}:${target.id}`);
                  return;
                }
              }
            }
            target.props = normalized;
            propsChanged = true;
          }
          if (propsChanged) {
            if (semanticUpdate) {
              advanceBlockEpoch(at.blockId, touched, preferredEpoch, tx);
            }
            bumpVersion(target);
            touched.add(target.id);
            if (parent) {
              bumpVersion(parent);
              touched.add(parent.id);
              if (parent.type === "code") {
                const parentNormalizeStart = perfEnabled ? getPerfNow() : 0;
                normalizeCodeBlockChildren(nodes, parent, touched);
                if (perfEnabled) {
                  recordSetPropsStage("code-line:normalize-parent-code", getPerfNow() - parentNormalizeStart);
                }
                if (nextLegacyCodeState) {
                  codeStateByRecord.set(parent, nextLegacyCodeState);
                  invalidateCodeLineIndex(parent.id, updatedLineIndex);
                  mutatedBlocks = true;
                  blocksDirty = true;
                }
              }
            }
          }
          if (perfEnabled) {
            const duration = getPerfNow() - perfStartLocal;
            const typeKey = target.type || "unknown";
            const sizeKey = bucketBySize(estimatePropsSize(props, undefined));
            const typeEntry = setPropsByType[typeKey] ?? { count: 0, durationMs: 0 };
            typeEntry.count += 1;
            typeEntry.durationMs += duration;
            setPropsByType[typeKey] = typeEntry;
            const sizeEntry = setPropsBySize[sizeKey] ?? { count: 0, durationMs: 0 };
            sizeEntry.count += 1;
            sizeEntry.durationMs += duration;
            setPropsBySize[sizeKey] = sizeEntry;
          }
          return;
        } else if (isInlineSegmentType(target.type)) {
          const mergeStart = perfEnabled ? getPerfNow() : 0;
          const nextProps = props ? { ...props } : {};
          delete nextProps.range;
          delete nextProps.meta;
          delete nextProps.isFinalized;
          if ("block" in nextProps) {
            delete (nextProps as Record<string, unknown>).block;
          }
          const mergedSegments = mergeInlineSegmentProps(target.props, nextProps);
          if (perfEnabled) {
            recordSetPropsStage("inline:merge-segment-props", getPerfNow() - mergeStart);
          }
          if (!shallowEqualRecords(target.props as Record<string, unknown> | undefined, mergedSegments)) {
            target.props = mergedSegments;
            propsChanged = true;
          }
        } else {
          const mergeStart = perfEnabled ? getPerfNow() : 0;
          const nextProps = props ? { ...props } : {};
          delete nextProps.range;
          delete nextProps.meta;
          delete nextProps.isFinalized;
          if ("block" in nextProps) {
            delete (nextProps as Record<string, unknown>).block;
          }
          const base = target.props ? { ...target.props } : {};
          let localChanged = false;
          if (Object.prototype.hasOwnProperty.call(base, "block")) {
            delete (base as Record<string, unknown>).block;
            localChanged = true;
          }
          if (Object.prototype.hasOwnProperty.call(base, "range")) {
            delete base.range;
            localChanged = true;
          }
          for (const [key, value] of Object.entries(nextProps)) {
            if (value === undefined) {
              if (Object.prototype.hasOwnProperty.call(base, key)) {
                delete base[key];
                localChanged = true;
              }
            } else if (base[key] !== value) {
              base[key] = value;
              localChanged = true;
            }
          }
          if (localChanged) {
            target.props = base;
            propsChanged = true;
          }
          if (perfEnabled) {
            recordSetPropsStage(`${target.type || "unknown"}:merge-props`, getPerfNow() - mergeStart);
          }
        }

        let blockChanged = false;
        let typeChanged = false;
        let rebuiltFromFinalizedBlock = false;
        let blockEpochAdvanced = false;
        const incomingBlock = props?.block as Block | undefined;
        if (incomingBlock && typeof incomingBlock === "object") {
          const cloneStart = perfEnabled ? getPerfNow() : 0;
          const incomingNativeContainer = isNativeContainerType(
            typeof incomingBlock.type === "string" ? incomingBlock.type : target.type,
          );
          const incomingPrepared = incomingNativeContainer ? incomingBlock.payload?.meta?.preparedNested : undefined;
          target.block = cloneBlock(incomingNativeContainer ? blockWithoutPreparedNested(incomingBlock) : incomingBlock);
          (target as NodeRecordWithSerializedBlock)[serializedBlockOwnership] = true;
          const paragraphState = paragraphStateByRecord.get(target);
          if (paragraphState) coldParagraphBlocksByView.delete(paragraphState);
          const metaPrepared = incomingNativeContainer && nativePreparedLayoutByRecord.get(target)?.meta === true;
          if (incomingPrepared !== undefined || metaPrepared) {
            nativePreparedLayoutByRecord.set(target, { block: incomingPrepared !== undefined, meta: metaPrepared });
          } else {
            nativePreparedLayoutByRecord.delete(target);
          }
          if (rangeChanged && rangeUpdate) {
            target.block = blockWithSourceRange(target.block, rangeUpdate);
          } else if (!incomingNativeContainer && target.range && !paragraphStateByRecord.has(target) && !isManagedSourceFamily(target.type)) {
            // Live reads bind an unmanaged leaf's raw to its range, so a replacement block brings its own authored range.
            const source = inputSourceSnapshotForMap(nodes);
            const blockRange = source ? parseSourceRange(incomingBlock.payload?.range, source.length) : null;
            if (blockRange) target.range = { ...blockRange };
          }
          if (applyMetaUpdate && target.block && !hasManagedSourceOwner && !isManagedSourceFamily(metadataType)) {
            target.block = blockWithExactCanonicalMetadata(target.block, metadataValue);
          }
          const existingCodeState = codeStateByRecord.get(target);
          if (target.type === "code" && existingCodeState && !existingCodeState.managed) {
            const canonicalSource = inputSourceSnapshotForMap(nodes);
            // The legacy diff inserts and deletes code-line children before re-sending the block; re-derive the lines then.
            const linesChanged = target.children.length !== existingCodeState.view.lines.length;
            let nextCodeState: StoredCodeBlockState;
            if (linesChanged) {
              const snapshot = legacyCodeSnapshot(nodes, target);
              nextCodeState = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
                ? createStoredCodeBlockState(snapshot, target.block, canonicalSource, codeCountersByMap!.get(nodes))
                : createStoredCodeBlockState(snapshot, target.block, canonicalSource);
            } else {
              nextCodeState = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
                ? refreshLegacyCodeSource(existingCodeState, target.block, canonicalSource, codeCountersByMap!.get(nodes))
                : refreshLegacyCodeSource(existingCodeState, target.block, canonicalSource);
            }
            codeStateByRecord.set(target, nextCodeState);
            if (linesChanged || (target.block?.isFinalized && existingCodeState.view.source.state !== "finalized")) {
              invalidateAllCodeLineRanges(target.id);
            }
          }
          if (perfEnabled) {
            recordSetPropsStage(`${target.type || "unknown"}:clone-block`, getPerfNow() - cloneStart);
          }
          const previousType = target.type;
          const incomingType = typeof target.block.type === "string" ? target.block.type : target.type;
          if (incomingType !== target.type) {
            target.type = incomingType;
            typeChanged = true;
            if (isListRelated(previousType) || isListRelated(target.type)) {
              markListDepthDirty(target.id);
            }
          }
          if (target.type === "code") {
            const metadataStart = perfEnabled ? getPerfNow() : 0;
            applyCodeBlockMetadata(target, currentThemes);
            if (perfEnabled) {
              recordSetPropsStage("code:apply-metadata", getPerfNow() - metadataStart);
            }
          }
          if (semanticUpdate) {
            advanceBlockEpoch(at.blockId, touched, preferredEpoch, tx);
            blockEpochAdvanced = true;
          }

          const shouldRebuildFinalizedTree =
            (at.nodeId === undefined || at.nodeId === at.blockId) &&
            target.id === at.blockId &&
            Boolean(target.block?.isFinalized) &&
            target.type !== "code" &&
            !nativePreparedLayoutByRecord.has(target) &&
            Boolean(target.parentId);
          if (shouldRebuildFinalizedTree) {
            const parent = target.parentId ? nodes.get(target.parentId) : undefined;
            const lastIndex = (parent?.children.length ?? 0) - 1;
            const isTailChild = Boolean(parent && lastIndex >= 0 && parent.children[lastIndex] === target.id);
            const index = isTailChild ? lastIndex : parent ? parent.children.indexOf(target.id) : -1;
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && parent) {
              paragraphCountersByMap!.get(nodes)?.recordPrefixComparisons?.(
                isTailChild ? 1 : index === -1 ? parent.children.length : index + 1,
                "store",
              );
            }
            if (parent && index !== -1) {
              // The incoming producer tree seeds the rebuilt generic children; it is not retained on the record.
              const finalizedBlock = target.block as Block;
              const blockForRebuild: Block = incomingPrepared === undefined
                ? cloneBlock(finalizedBlock)
                : {
                    ...finalizedBlock,
                    payload: { ...finalizedBlock.payload, meta: { ...finalizedBlock.payload.meta, preparedNested: incomingPrepared } },
                  };
              const snapshot = createBlockSnapshot(blockForRebuild);
              replaceSnapshotAt(nodes, parent, index, snapshot, touched, effectiveBlockEpoch(nodes, target), undefined, invalidateAllParagraphSpanRanges, invalidateAllCodeLineRanges);
              mutatedBlocks = true;
              blockChanged = true;
              rebuiltFromFinalizedBlock = true;
              const rebuilt = nodes.get(target.id);
              if (isListRelated(previousType) || isListRelated(rebuilt?.type)) {
                markListDepthDirty(target.id);
              }
              target = rebuilt ?? target;
            }
          }
          mutatedBlocks = true;
          blockChanged = true;
        } else if (rangeChanged && rangeUpdate && target.block && !isNativeContainerType(target.type)) {
          // A range-only update on an unmanaged generic leaf moves its block onto the admitted canonical source window.
          target.block = blockWithSourceRange(target.block, rangeUpdate, sourceForRangeUpdate);
          mutatedBlocks = true;
          blockChanged = true;

        }
        if (lazyTokenizedUntil !== undefined && target.type === "code" && target.block) {
          const currentMeta = target.block.payload.meta;
          if (currentMeta?.lazyTokenizedUntil !== lazyTokenizedUntil) {
            target.block = {
              ...target.block,
              payload: {
                ...target.block.payload,
                meta: { ...(currentMeta ?? {}), lazyTokenizedUntil },
              },
            };
            blockChanged = true;
            mutatedBlocks = true;
            blocksDirty = true;
          }
        }
        if (applyMetaUpdate && target.block && !hasManagedSourceOwner && !isManagedSourceFamily(target.type)) {
          const updatedBlock = blockWithExactCanonicalMetadata(target.block, metadataValue);
          if (updatedBlock !== target.block) {
            target.block = updatedBlock;
            blockChanged = true;
            mutatedBlocks = true;
            blocksDirty = true;
          }
        }
        if (
          canUpdateRootFinality &&
          target.block &&
          typeof finalityValue === "boolean" &&
          target.block.isFinalized !== finalityValue
        ) {
          target.block = { ...target.block, isFinalized: finalityValue };
          blockChanged = true;
          mutatedBlocks = true;
          blocksDirty = true;
        }

        if (
          (propsChanged || metaChanged || rangeChanged || blockChanged || typeChanged) &&
          nativeContainerProjectionRoot(nodes, target.id)
        ) {
          mutatedBlocks = true;
        }
        if (rebuiltFromFinalizedBlock) {
          return;
        }

        if (propsChanged || metaChanged || blockChanged || typeChanged || rangeChanged) {
          if (semanticUpdate && !blockEpochAdvanced) {
            advanceBlockEpoch(at.blockId, touched, preferredEpoch, tx);
            blockEpochAdvanced = true;
          }
          bumpVersion(target);
          touched.add(target.id);

          let parentForNormalization: NodeRecord | undefined;
          if (target.parentId) {
            const parent = nodes.get(target.parentId);
            if (parent) {
              if (target.type === "code-line") {
                bumpVersion(parent);
                touched.add(parent.id);
              }
              if (parent.type === "code") {
                parentForNormalization = parent;
              }
            }
          }

          if (target.type === "code") {
            const normalizeChildrenStart = perfEnabled ? getPerfNow() : 0;
            normalizeCodeBlockChildren(nodes, target, touched);
            if (perfEnabled) {
              recordSetPropsStage("code:normalize-children", getPerfNow() - normalizeChildrenStart);
            }
          } else if (parentForNormalization) {
            const normalizeParentStart = perfEnabled ? getPerfNow() : 0;
            normalizeCodeBlockChildren(nodes, parentForNormalization, touched);
            if (perfEnabled) {
              recordSetPropsStage("code-line:normalize-parent-code-post", getPerfNow() - normalizeParentStart);
            }
          }
          const parentType = target.parentId ? nodes.get(target.parentId)?.type : undefined;
          if (isListRelated(target.type) || isListRelated(parentType)) {
            markListDepthDirty(target.id);
          }
        }

        if (perfEnabled) {
          const duration = getPerfNow() - perfStartLocal;
          const typeKey = target.type || "unknown";
          const sizeKey = bucketBySize(estimatePropsSize(props, incomingBlock && typeof incomingBlock === "object" ? (incomingBlock as Block) : undefined));
          const typeEntry = setPropsByType[typeKey] ?? { count: 0, durationMs: 0 };
          typeEntry.count += 1;
          typeEntry.durationMs += duration;
          setPropsByType[typeKey] = typeEntry;
          const sizeEntry = setPropsBySize[sizeKey] ?? { count: 0, durationMs: 0 };
          sizeEntry.count += 1;
          sizeEntry.durationMs += duration;
          setPropsBySize[sizeKey] = sizeEntry;
        }
      };
      const applyPropsUpdateTracked = (
        at: NodePath,
        props: Record<string, unknown> | undefined,
        preferredEpoch?: number,
        tx?: number,
        semanticUpdate = false,
      ) => {
        const targetId = at.nodeId ?? at.blockId;
        const record = nodes.get(targetId);
        const wasProvisional = isProvisionalRootBlock(record);
        applyPropsUpdate(at, props, preferredEpoch, tx, semanticUpdate);
        const updated = nodes.get(targetId);
        if (record?.parentId === PATCH_ROOT_ID && updated !== record) {
          if (wasProvisional) provisionalBlockCount -= 1;
          if (isProvisionalRootBlock(updated)) provisionalBlockCount += 1;
        } else {
          updateRootProvisionalCount(updated, wasProvisional);
        }

      };
      const applyPatch = (patch: Patch) => {
        switch (patch.op) {
          case "appendInputSource": {
            const source = inputSourceByNodeMap.get(nodes);
            if (
              !source ||
              patch.at.blockId !== PATCH_ROOT_ID ||
              patch.at.nodeId !== undefined ||
              patch.at.indexPath !== undefined ||
              patch.generation !== source.generation ||
              patch.from !== source.document.length ||
              typeof patch.text !== "string"
            ) break;
            source.document.append(patch.text);
            break;
          }

          case "insertChild": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const parent = resolveParent(nodes, patch.at);
            const previousRootRecord = parent?.id === PATCH_ROOT_ID ? nodes.get(patch.node.id) : undefined;
            const previousWasProvisional = isProvisionalRootBlock(previousRootRecord);
            const previousParagraphRecord = nodes.get(patch.node.id);
            const inserted = insertSnapshotAt(
              nodes,
              parent,
              patch.index,
              patch.node,
              touched,
              allocateBlockEpoch(readPatchParseEpoch(patch) ?? readSnapshotBlockEpoch(patch.node)),
              undefined,
              undefined,
              invalidateAllCodeLineRanges,
            );
            if (inserted) {
              if (parent?.id === PATCH_ROOT_ID) {
                if (previousWasProvisional) provisionalBlockCount -= 1;
                if (isProvisionalRootBlock(inserted.record)) provisionalBlockCount += 1;
              }
              if (
                previousParagraphRecord &&
                previousParagraphRecord !== inserted.record &&
                (paragraphStateByRecord.has(previousParagraphRecord) || paragraphStateByRecord.has(inserted.record))
              ) invalidateAllParagraphSpanRanges(patch.node.id);
              for (const id of inserted.insertedIds) touched.add(id);
              mutatedBlocks = true;
              advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
              if (isListRelated(inserted.record.type) || isListRelated(parent?.type)) {
                markListDepthDirty(inserted.record.id);
                if (parent) {
                  markListDepthDirty(parent.id);
                }
              }
              if (debugListPatches && (isListRelated(inserted.record.type) || isListRelated(parent?.type))) {
                logListPatch("insertChild", {
                  id: inserted.record.id,
                  type: inserted.record.type,
                  parentId: parent?.id,
                  parentType: parent?.type,
                  index: patch.index,
                });
              }
            }
            break;
          }

          case "deleteChild": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const parent = resolveParent(nodes, patch.at);
            if (!parent) break;
            if (patch.index < 0 || patch.index >= parent.children.length) break;
            const parentChildren = parent.children.slice();
            const childId = parentChildren.splice(patch.index, 1)[0];
            parent.children = parentChildren;
            if (childId) {
              const removedNode = nodes.get(childId);
              if (parent.id === PATCH_ROOT_ID && isProvisionalRootBlock(removedNode)) {
                provisionalBlockCount -= 1;
              }
              removeSubtree(nodes, childId, touched, true, (record) => {
                if (record.type === "code") invalidateAllCodeLineRanges(record.id);
              });
              bumpVersion(parent);
              touched.add(parent.id);
              ensureUniqueChildren(nodes, parent, touched);
              mutatedBlocks = true;
              advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
              if (isListRelated(parent.type) || isListRelated(removedNode?.type)) {
                markListDepthDirty(parent.id);
              }
              if (debugListPatches && (isListRelated(parent.type) || isListRelated(removedNode?.type))) {
                logListPatch("deleteChild", {
                  id: childId,
                  type: removedNode?.type,
                  parentId: parent.id,
                  parentType: parent.type,
                  index: patch.index,
                });
              }
            }
            break;
          }

          case "replaceChild": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const parent = resolveParent(nodes, patch.at);
            if (!parent) break;
            if (!codeSnapshotGenerationAllowed(nodes, patch.node)) break;
            const previousRecord = nodes.get(parent.children[patch.index]);
            const previousWasProvisional = parent.id === PATCH_ROOT_ID && isProvisionalRootBlock(previousRecord);
            replaceSnapshotAt(
              nodes,
              parent,
              patch.index,
              patch.node,
              touched,
              allocateBlockEpoch(readPatchParseEpoch(patch) ?? readSnapshotBlockEpoch(patch.node)),
              undefined,
              invalidateAllParagraphSpanRanges,
              invalidateAllCodeLineRanges,
            );
            if (parent.id === PATCH_ROOT_ID && nodes.get(parent.children[patch.index]) !== previousRecord) {
              if (previousWasProvisional) provisionalBlockCount -= 1;
              if (isProvisionalRootBlock(nodes.get(parent.children[patch.index]))) provisionalBlockCount += 1;
            }
            touched.add(parent.id);
            mutatedBlocks = true;
            advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
            if (isListRelated(parent.type) || isListRelated(patch.node.type)) {
              markListDepthDirty(patch.node.id);
              markListDepthDirty(parent.id);
            }
            if (debugListPatches && isListRelated(parent.type)) {
              logListPatch("replaceChild", {
                parentId: parent.id,
                parentType: parent.type,
                index: patch.index,
              });
            }
            break;
          }

          case "setProps": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            applyPropsUpdateTracked(patch.at, patch.props, readPatchParseEpoch(patch), readPatchTx(patch), getPatchKind(patch) === "semantic");
            break;
          }

          case "setPropsBatch": {
            const entries = Array.isArray(patch.entries) ? (patch.entries as SetPropsBatchEntry[]) : [];
            for (const entry of entries) {
              if (!entry || !entry.at) continue;
              const entryPatch: Patch = {
                op: "setProps",
                at: entry.at,
                props: entry.props,
                meta: entry.meta ?? patch.meta,
              };
              if (rejectStaleEpochPatch(entryPatch, entry.at)) continue;
              applyPropsUpdateTracked(
                entry.at,
                entry.props,
                readPatchParseEpoch(entryPatch),
                readPatchTx(entryPatch),
                getPatchKind(entryPatch) === "semantic",
              );
            }
            break;
          }

          case "finalize": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const target = nodes.get(patch.at.nodeId ?? patch.at.blockId);
            if (!target) break;
            const wasProvisional = isProvisionalRootBlock(target);
            let changed = false;
            const codeState = codeStateByRecord.get(target);
            const tableState = tableStateByRecord.get(target);
            const paragraphState = paragraphStateByRecord.get(target);
            if (paragraphState && paragraphState.source.state !== "finalized") {
              const source = paragraphState.source;
              const fromSpan = source.completeSpanCount;
              const provisionalTail = paragraphState.spans.readRange(fromSpan, source.spanCount);
              const finalizedTail = provisionalTail.map((span, index) => ({
                ...span,
                sourceRevision: span.sourceRevision + (index === 0 ? 1 : 0),
                isProvisional: false,
              }));
              const revision = source.revision + 1;
              const finalizePatch: Extract<Patch, { op: "appendParagraph" }> = {
                op: "appendParagraph",
                at: patch.at,
                paragraphOwnerId: source.paragraphOwnerId,
                generation: source.generation,
                expectedRevision: source.revision,
                revision,
                sourceAppend: "",
                fromSpan,
                spans: finalizedTail,
                paragraph: {
                  ...source,
                  revision,
                  state: "finalized",
                  completeSpanCount: source.spanCount,
                },
              };
              let finalized: ManagedParagraphPatchResult;
              try {
                finalized = appendManagedParagraphSpans(paragraphState, target.id, finalizePatch);
              } catch {
                appendDiagnostic(`finalize paragraph guard rejected:${target.id}:invalid paragraph record`);
                break;
              }
              if ("reason" in finalized) {
                appendDiagnostic(`finalize paragraph guard rejected:${target.id}:${finalized.reason}`);
                break;
              }
              const changedSpanEnd = Math.max(paragraphState.spans.length, finalized.state.spans.length);
              for (let index = fromSpan; index < changedSpanEnd; index += 1) {
                updateParagraphSpanChildRecords(
                  nodes,
                  target,
                  paragraphState.spans.get(index),
                  finalized.state.spans.get(index),
                  touched,
                );
              }
              if (fromSpan < paragraphState.spans.length || finalizedTail.length > 0) {
                updateParagraphSegmentPlanAfterAppend(nodes, target, paragraphState, finalized.state, fromSpan);
              }
              paragraphStateByRecord.set(target, finalized.state);
              if (fromSpan < changedSpanEnd) invalidateParagraphSpanRange(target.id, fromSpan, changedSpanEnd);
              changed = true;
            }
            if (codeState && codeState.view.source.state !== "finalized") {
              codeStateByRecord.set(target, finalizeStoredCodeState(codeState));
              invalidateAllCodeLineRanges(target.id);
              changed = true;
            }
            if (!paragraphState && !tableState && target.block && !target.block.isFinalized) {
              target.block = cloneBlock(target.block);
              target.block.isFinalized = true;
              changed = true;
            }
            if (changed) {
              updateRootProvisionalCount(target, wasProvisional);
              bumpVersion(target);
              touched.add(target.id);
              mutatedBlocks = true;
              blocksDirty = true;
              // Containers admitted with a producer tree already own their current hierarchy as generic children.
              if (
                !paragraphState &&
                !patch.at.nodeId &&
                target.id === patch.at.blockId &&
                target.type !== "code" &&
                target.block &&
                target.parentId &&
                !nativePreparedLayoutByRecord.has(target)
              ) {
                const parent = nodes.get(target.parentId);
                const index = parent ? parent.children.indexOf(target.id) : -1;
                if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && parent) {
                  paragraphCountersByMap!.get(nodes)?.recordPrefixComparisons?.(
                    index === -1 ? parent.children.length : index + 1,
                    "store",
                  );
                }
                if (parent && index !== -1) {
                  const snapshot = createBlockSnapshot(cloneBlock(target.block));
                  replaceSnapshotAt(nodes, parent, index, snapshot, touched, effectiveBlockEpoch(nodes, target), undefined, invalidateAllParagraphSpanRanges, invalidateAllCodeLineRanges);
                  if (isListRelated(target.type) || isListRelated(snapshot.type)) {
                    markListDepthDirty(target.id);
                  }
                }
              }
            }
            // Like every semantic op, finalize moves the block to the patch's epoch; the worker counts it as emitted.
            if (getPatchKind(patch) === "semantic") {
              advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
            }
            if (isListRelated(target.type)) {
              markListDepthDirty(target.id);
            }
            if (debugListPatches && isListRelated(target.type)) {
              logListPatch("finalize", {
                id: target.id,
                type: target.type,
              });
            }
            break;
          }

          case "reorder": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const parent = resolveParent(nodes, patch.at);
            if (!parent) break;
            const length = parent.children.length;
            if (length === 0 || patch.count <= 0) break;
            const from = clampIndex(patch.from, length - 1);
            const count = Math.max(1, Math.min(patch.count, length - from));
            let to = clampIndex(patch.to, length);
            if (to > from) {
              to = Math.max(0, to - count);
            }
            const children = parent.children.slice();
            const moved = children.splice(from, count);
            children.splice(to, 0, ...moved);
            parent.children = children;
            bumpVersion(parent);
            touched.add(parent.id);
            mutatedBlocks = true;
            if (getPatchKind(patch) === "semantic") {
              advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
            }
            if (isListRelated(parent.type)) {
              markListDepthDirty(parent.id);
            }
            if (debugListPatches && isListRelated(parent.type)) {
              logListPatch("reorder", {
                parentId: parent.id,
                parentType: parent.type,
                from: patch.from,
                to: patch.to,
                count: patch.count,
              });
            }
            break;
          }

          case "appendCode": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const target = resolveParent(nodes, patch.at);
            if (!target) {
              appendDiagnostic(`appendCode target missing:${patch.at.blockId}`);
              break;
            }
            if (target.type !== "code") {
              appendDiagnostic(`appendCode target not code:${target.id}:${target.type}`);
              break;
            }
            const codeState = codeStateByRecord.get(target);
            if (!codeState) {
              appendDiagnostic(`appendCode owner unavailable:${target.id}`);
              break;
            }
            const wasProvisional = isProvisionalRootBlock(target);
            const appended = appendStoredCodeState(codeState, patch, inputSourceSnapshotForMap(nodes));
            if (!appended.state) {
              appendDiagnostic(`appendCode guard rejected:${target.id}:${appended.reason ?? "invalid source tail"}`);
              break;
            }
            codeStateByRecord.set(target, appended.state);
            if (appended.state.view.source.state === "finalized") {
              invalidateAllCodeLineRanges(target.id);
            } else {
              invalidateCodeLineRange(target.id, patch.fromLine, appended.state.view.lines.length);
            }
            updateRootProvisionalCount(target, wasProvisional);
            bumpVersion(target);
            touched.add(target.id);
            mutatedBlocks = true;
            blocksDirty = true;
            if (getPatchKind(patch) === "semantic") {
              advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
            }
            break;
          }

          case "appendTableRows": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const target = resolveParent(nodes, patch.at);
            if (!target || target.type !== "table") {
              appendDiagnostic(`appendTableRows target unavailable:${patch.at.blockId}`);
              break;
            }
            const current = tableStateByRecord.get(target);
            if (!current) {
              appendDiagnostic(`appendTableRows owner unavailable:${target.id}`);
              break;
            }
            let appended: ManagedTablePatchResult;
            try {
              appended = appendManagedTableRows(current, target.id, patch, inputSourceSnapshotForMap(nodes));
            } catch {
              appendDiagnostic(`appendTableRows guard rejected:${target.id}:invalid table record`);
              break;
            }
            if ("reason" in appended) {
              appendDiagnostic(`appendTableRows guard rejected:${target.id}:${appended.reason}`);
              break;
            }
            const isFinalized = appended.state.source.state !== "open";
            if (target.block) {
              const range = appended.state.source.sourceRange;
              if (
                target.block.isFinalized !== isFinalized ||
                target.block.payload.range?.from !== range.from ||
                target.block.payload.range?.to !== range.to
              ) {
                target.block = cloneBlock(target.block);
                target.block.isFinalized = isFinalized;
                target.block.payload.range = { ...range };
              }
            }
            const wasProvisional = isProvisionalRootBlock(target);
            tableStateByRecord.set(target, appended.state);
            invalidateTableRowRange(target.id, patch.fromRow, Math.max(current.rows.length, appended.state.rows.length));
            updateRootProvisionalCount(target, wasProvisional);
            bumpVersion(target);
            touched.add(target.id);
            mutatedBlocks = true;
            blocksDirty = true;
            if (getPatchKind(patch) === "semantic") {
              advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
            }
            break;
          }

          case "updateTableRows": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const target = resolveParent(nodes, patch.at);
            if (!target || target.type !== "table") {
              appendDiagnostic(`updateTableRows target unavailable:${patch.at.blockId}`);
              break;
            }
            const current = tableStateByRecord.get(target);
            if (!current) {
              appendDiagnostic(`updateTableRows owner unavailable:${target.id}`);
              break;
            }
            let updated: ManagedTablePatchResult;
            try {
              updated = updateManagedTableRows(current, target.id, patch);
            } catch {
              appendDiagnostic(`updateTableRows guard rejected:${target.id}:invalid table record`);
              break;
            }
            if ("reason" in updated) {
              appendDiagnostic(`updateTableRows guard rejected:${target.id}:${updated.reason}`);
              break;
            }
            tableStateByRecord.set(target, updated.state);
            invalidateTableRowIndices(target.id, patch.updates.map((update) => update.index));
            bumpVersion(target);
            touched.add(target.id);
            mutatedBlocks = true;
            blocksDirty = true;
            if (getPatchKind(patch) === "semantic") {
              advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
            }
            break;
          }

          case "appendParagraph": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const target = resolveParent(nodes, patch.at);
            if (!target || target.type !== "paragraph") {
              appendDiagnostic(`appendParagraph target unavailable:${patch.at.blockId}`);
              break;
            }
            const current = paragraphStateByRecord.get(target);
            if (!current) {
              appendDiagnostic(`appendParagraph owner unavailable:${target.id}`);
              break;
            }
            let appended: ManagedParagraphPatchResult;
            try {
              appended = appendManagedParagraphSpans(current, target.id, patch, inputSourceSnapshotForMap(nodes));
            } catch {
              appendDiagnostic(`appendParagraph guard rejected:${target.id}:invalid paragraph record`);
              break;
            }
            if ("reason" in appended) {
              appendDiagnostic(`appendParagraph guard rejected:${target.id}:${appended.reason}`);
              break;
            }
            const wasProvisional = isProvisionalRootBlock(target);
            const source = appended.state.source;
            if (
              target.range?.from !== source.sourceRange.from ||
              target.range?.to !== source.sourceRange.to
            ) target.range = { ...source.sourceRange };
            const changedSpanEnd = Math.max(current.spans.length, appended.state.spans.length);
            for (let index = patch.fromSpan; index < changedSpanEnd; index += 1) {
              updateParagraphSpanChildRecords(
                nodes,
                target,
                current.spans.get(index),
                appended.state.spans.get(index),
                touched,
              );
            }
            if (patch.fromSpan < current.spans.length || patch.spans.length > 0) {
              updateParagraphSegmentPlanAfterAppend(nodes, target, current, appended.state, patch.fromSpan);
            }
            paragraphStateByRecord.set(target, appended.state);
            if (patch.fromSpan < changedSpanEnd) {
              invalidateParagraphSpanRange(target.id, patch.fromSpan, changedSpanEnd);
            }
            updateRootProvisionalCount(target, wasProvisional);
            bumpVersion(target);
            touched.add(target.id);
            mutatedBlocks = true;
            blocksDirty = true;
            if (getPatchKind(patch) === "semantic") {
              advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
            }
            break;
          }

          case "updateParagraphSpans": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const target = resolveParent(nodes, patch.at);
            if (!target || target.type !== "paragraph") {
              appendDiagnostic(`updateParagraphSpans target unavailable:${patch.at.blockId}`);
              break;
            }
            const current = paragraphStateByRecord.get(target);
            if (!current) {
              appendDiagnostic(`updateParagraphSpans owner unavailable:${target.id}`);
              break;
            }
            let updated: ManagedParagraphPatchResult;
            try {
              updated = updateManagedParagraphSpans(current, target.id, patch);
            } catch {
              appendDiagnostic(`updateParagraphSpans guard rejected:${target.id}:invalid paragraph record`);
              break;
            }
            if ("reason" in updated) {
              appendDiagnostic(`updateParagraphSpans guard rejected:${target.id}:${updated.reason}`);
              break;
            }
            let stableChildTopology = true;
            for (const update of patch.updates) {
              const stable = updateParagraphSpanChildRecords(
                nodes,
                target,
                current.spans.get(update.index),
                updated.state.spans.get(update.index),
                touched,
              );
              stableChildTopology = stableChildTopology && stable;
              invalidateParagraphSpanRange(target.id, update.index, update.index + 1);
            }
            if (!stableChildTopology) paragraphSegmentProjectionByRecord.delete(target);
            paragraphStateByRecord.set(target, updated.state);
            bumpVersion(target);
            touched.add(target.id);
            mutatedBlocks = true;
            blocksDirty = true;
            if (getPatchKind(patch) === "semantic") {
              advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
            }
            break;
          }
          case "decorateCode": {
            const target = resolveParent(nodes, patch.at);
            if (!target || target.type !== "code") {
              appendDiagnostic(`decorateCode target unavailable:${patch.at.blockId}`);
              break;
            }
            const codeState = codeStateByRecord.get(target);
            if (!codeState) {
              appendDiagnostic(`decorateCode owner unavailable:${target.id}`);
              break;
            }
            const decorated = decorateStoredCodeState(codeState, patch);
            if (decorated.reason) {
              appendDiagnostic(`decorateCode guard rejected:${target.id}:${decorated.reason}`);
              break;
            }
            if (!decorated.changed || !decorated.state) break;
            const decoratedBlock = updateStoredDiffBlockDecorations(
              target.block,
              decorated.state,
              decorated.changedIndices,
            );
            if (decoratedBlock !== target.block) target.block = decoratedBlock;
            codeStateByRecord.set(target, decorated.state);
            if (decorated.changedIndices) invalidateCodeLineIndices(target.id, decorated.changedIndices);
            bumpVersion(target);
            touched.add(target.id);
            mutatedBlocks = true;
            blocksDirty = true;
            break;
          }

          case "setHTML": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const target = nodes.get(patch.at.nodeId ?? patch.at.blockId);
            if (!target) break;
            const wasProvisional = isProvisionalRootBlock(target);
            const sanitized = patch.sanitized ? patch.html : sanitizeHTML(patch.html);
            target.props = {
              ...(target.props ?? {}),
              html: sanitized,
              policy: patch.policy || "markdown-renderer-v2",
              meta: patch.meta ? { ...patch.meta } : (target.props?.meta as Record<string, unknown> | undefined),
            };

            if (patch.block) {
              target.block = cloneBlock(patch.block);
              if (!target.block.payload.meta) {
                target.block.payload.meta = {};
              }
              target.block.payload.sanitizedHtml = sanitized;
              mutatedBlocks = true;
            }
              updateRootProvisionalCount(target, wasProvisional);

            bumpVersion(target);
            touched.add(target.id);
            // Like semantic setProps: the next patch for this block expects the epoch this one establishes.
            if (getPatchKind(patch) === "semantic") {
              advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
            }
            break;
          }
          default:
            break;
        }
      };

      if (perfEnabled) {
        const loopStart = getPerfNow();
        for (const patch of coalescedPatches) {
          const opStart = getPerfNow();
          applyPatch(patch);
          const opDuration = getPerfNow() - opStart;
          const entry = opStats[patch.op] ?? { count: 0, durationMs: 0 };
          entry.count += 1;
          entry.durationMs += opDuration;
          opStats[patch.op] = entry;
        }
        applyMs = getPerfNow() - loopStart;
      } else {
        for (const patch of coalescedPatches) {
          applyPatch(patch);
        }
      }


      if (mutatedBlocks) {
        blocksDirty = true;
        for (const id of touched) invalidateNativeContainerProjection(nodes, id);
      }

      if (listDepthDirty) {
        if (perfEnabled) {
          const start = getPerfNow();
          normalizeAllListDepths(nodes, touched, PATCH_ROOT_ID);
          listNormalizeMs = getPerfNow() - start;
        } else {
          normalizeAllListDepths(nodes, touched, PATCH_ROOT_ID);
        }
      } else if (listDepthDirtyNodes.size > 0) {
        if (perfEnabled) {
          const start = getPerfNow();
          normalizeListDepthsForIds(nodes, touched, listDepthDirtyNodes, PATCH_ROOT_ID);
          listNormalizeMs = getPerfNow() - start;
        } else {
          normalizeListDepthsForIds(nodes, touched, listDepthDirtyNodes, PATCH_ROOT_ID);
        }
      }

      structuralViolations = null;

      for (const id of touched) pendingChangedIds.add(id);
      activeChangedIds = null;
      if (newestAdmittedEnvelope) lastSemanticEnvelope = newestAdmittedEnvelope;

      if (touched.size > 0 || mutatedBlocks) {
        version++;
        // Defer notification to avoid React "Cannot update a component while rendering" warning
        // Use rAF (or fallback) to align with frame updates
        scheduleNotify();
      }

      if (perfEnabled) {
        const totalMs = getPerfNow() - perfStart;
        const coalesceMs = typeof metrics?.durationMs === "number" ? metrics.durationMs : 0;
        recordPatchPerf({
          timestamp: new Date().toISOString(),
          totalMs,
          applyMs,
          coalesceMs,
          listNormalizeMs,
          patches: patches.length,
          coalescedPatches: coalescedPatches.length,
          touchedCount: touched.size,
          mutatedBlocks,
          ops: opStats,
          setPropsByType,
          setPropsBySize,
          setPropsStages,
        });
      }

      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        (store as CampaignRendererStore).campaignCounters?.recordStoreRecordsTouched?.(touched.size, "store");
      }
      return touched;
    },

    getBlocks() {
      if (!blocksDirty) {
        return blocksCache;
      }
      const root = nodes.get(PATCH_ROOT_ID);
      if (!root) {
        blocksCache = [];
      } else {
        blocksCache = convertNodeToBlocks(nodes, root, publicBlocks);
      }
      blocksDirty = false;
      return blocksCache;
    },
    hasProvisionalBlocks() {
      return provisionalBlockCount > 0;
    },
    getCodeBlock(id: string) {
      const record = nodes.get(id);
      return record?.type === "code" ? codeStateByRecord.get(record)?.view : undefined;
    },

    getCodeLines(id: string, from: number, to: number) {
      const record = nodes.get(id);
      const codeState = record?.type === "code" ? codeStateByRecord.get(record) : undefined;
      return codeState ? readStoredCodeLines(codeState, from, to) : EMPTY_CODE_LINES;
    },
    subscribeCodeLines(id: string, from: number, to: number, listener: () => void) {
      if (
        !Number.isSafeInteger(from) ||
        from < 0 ||
        !Number.isSafeInteger(from + CODE_LINE_RANGE_SIZE) ||
        from % CODE_LINE_RANGE_SIZE !== 0 ||
        to !== from + CODE_LINE_RANGE_SIZE
      ) throw new RangeError("Code line subscriptions must use fixed aligned ranges");
      const range = getOrCreateCodeLineRange(id, from);
      range.listeners.add(listener);
      return () => {
        range.listeners.delete(listener);
        if (range.listeners.size === 0) {
          const ranges = codeLineRangesByBlock.get(id);
          ranges?.delete(from);
          if (ranges?.size === 0) codeLineRangesByBlock.delete(id);
        }
      };
    },
    getTableBlock(id: string) {
      const record = nodes.get(id);
      return record?.type === "table" ? tableStateByRecord.get(record) : undefined;
    },
    getTableColdBlock(id: string) {
      const record = nodes.get(id);
      const state = record?.type === "table" ? tableStateByRecord.get(record) : undefined;
      if (!record || !state) return undefined;
      const materialized = tableColdBlock(record, state);
      let block = publicBlocks.get(materialized);
      if (!block) {
        block = cloneBlock(materialized);
        publicBlocks.set(materialized, block);
      }
      return block;
    },
    getParagraphBlock(id: string) {
      const record = nodes.get(id);
      return record?.type === "paragraph" ? paragraphStateByRecord.get(record) : undefined;
    },

    getParagraphColdBlock(id: string) {
      const record = nodes.get(id);
      const state = record?.type === "paragraph" ? paragraphStateByRecord.get(record) : undefined;
      if (!record || !state) return undefined;
      let materialized = coldParagraphBlocksByView.get(state);
      if (!materialized) {
        materialized = materializeManagedParagraphBlock(paragraphColdBlockBase(record, state), state);
        coldParagraphBlocksByView.set(state, materialized);
      }
      let block = publicBlocks.get(materialized);
      if (!block) {
        block = cloneBlock(materialized);
        publicBlocks.set(materialized, block);
      }
      return block;
    },

    getParagraphSpanProjection(id: string) {
      const record = nodes.get(id);
      const state = record?.type === "paragraph" ? paragraphStateByRecord.get(record) : undefined;
      if (!record || !state) return createBlockRangeProjection(0, PARAGRAPH_SPAN_RANGE_SIZE);
      const cached = paragraphProjectionByRecord.get(record);
      if (cached && cached.generation === state.source.generation && cached.spanCount === state.spans.length) {
        return cached.projection;
      }
      const projection = cached && cached.generation === state.source.generation
        ? appendBlockRangeProjection(cached.projection, state.spans.length)
        : createBlockRangeProjection(state.spans.length, PARAGRAPH_SPAN_RANGE_SIZE);
      paragraphProjectionByRecord.set(record, {
        generation: state.source.generation,
        spanCount: state.spans.length,
        projection,
      });
      return projection;
    },

    getParagraphSegmentProjection(id: string) {
      const record = nodes.get(id);
      const state = record?.type === "paragraph" ? paragraphStateByRecord.get(record) : undefined;
      if (!record || !state) return undefined;
      let cached = paragraphSegmentProjectionByRecord.get(record);
      if (!cached || cached.generation !== state.source.generation || cached.spanCount !== state.spans.length) {
        cached = buildParagraphSegmentPlan(nodes, record, state);
        paragraphSegmentProjectionByRecord.set(record, cached);
      }
      if (cached.error) throw new RangeError(cached.error);
      if (cached.validatedSpanCount !== state.spans.length) {
        const fromSpan = Math.min(cached.validatedSpanCount, state.spans.length);
        const invalidSpan = validateParagraphSegmentSpans(cached, state, fromSpan);
        if (invalidSpan !== state.spans.length) {
          cached = { ...cached, error: `Prepared paragraph span ${invalidSpan} has no unique text-segment owner` };
          paragraphSegmentProjectionByRecord.set(record, cached);
          throw new RangeError(cached.error);
        }
        const lastSpan = state.spans.get(state.spans.length - 1);
        const tailSpanOwnerIndex = lastSpan
          ? paragraphSegmentOwnerIndex(cached, state, lastSpan)
          : undefined;
        cached = {
          ...cached,
          validatedSpanCount: state.spans.length,
          tailSpanOwnerIndex: tailSpanOwnerIndex !== undefined && tailSpanOwnerIndex >= 0 ? tailSpanOwnerIndex : undefined,
        };
        paragraphSegmentProjectionByRecord.set(record, cached);
      }
      return {
        root: cached.root,
        eventCount: cached.eventCount,
        tailSpanOwnerIndex: cached.tailSpanOwnerIndex,
      };
    },

    getParagraphSpans(id: string, generation: number, from: number, to: number) {
      if (
        !Number.isSafeInteger(to) ||
        !Number.isSafeInteger(from) ||
        from < 0 ||
        !Number.isSafeInteger(from + PARAGRAPH_SPAN_RANGE_SIZE) ||
        from % PARAGRAPH_SPAN_RANGE_SIZE !== 0 ||
        to !== from + PARAGRAPH_SPAN_RANGE_SIZE
      ) return EMPTY_PARAGRAPH_SPANS;
      const record = nodes.get(id);
      const state = record?.type === "paragraph" ? paragraphStateByRecord.get(record) : undefined;
      if (!state || state.source.generation !== generation) return EMPTY_PARAGRAPH_SPANS;
      const range = getOrCreateParagraphSpanRange(id, from);
      if (range.generation !== generation) {
        range.spans = undefined;
        range.generation = generation;
      }
      if (range.spans) return range.spans;
      range.spans = Object.freeze(state.spans.readRange(from, to));
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        paragraphCountersByMap!.get(nodes)?.recordStoreRecordsTouched?.(range.spans.length, "store");
      }
      return range.spans;
    },

    subscribeParagraphSpans(id: string, generation: number, from: number, listener: () => void) {
      if (
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        !Number.isSafeInteger(from + PARAGRAPH_SPAN_RANGE_SIZE) ||
        !Number.isSafeInteger(from) ||
        from < 0 ||
        from % PARAGRAPH_SPAN_RANGE_SIZE !== 0
      ) throw new RangeError("Paragraph span subscriptions must use fixed aligned ranges");
      const range = getOrCreateParagraphSpanRange(id, from);
      const rangeListener = () => listener();
      range.listeners.add(rangeListener);
      range.listenerGenerations.set(rangeListener, generation);
      return () => {
        range.listeners.delete(rangeListener);
        range.listenerGenerations.delete(rangeListener);
        if (range.listeners.size === 0) {
          const ranges = paragraphSpanRangesByBlock.get(id);
          ranges?.delete(from);
          if (ranges?.size === 0) paragraphSpanRangesByBlock.delete(id);
        }
      };
    },

    getTableRows(id: string, from: number, to: number) {
      const record = nodes.get(id);
      const tableState = record?.type === "table" ? tableStateByRecord.get(record) : undefined;
      if (!tableState) return EMPTY_TABLE_ROWS;
      if (Number.isSafeInteger(from) && from >= 0 && from % TABLE_ROW_RANGE_SIZE === 0 && to === from + TABLE_ROW_RANGE_SIZE) {
        const range = getOrCreateTableRowRange(id, from, to);
        if (range.generation !== tableState.source.generation) {
          range.rows = undefined;
          range.generation = tableState.source.generation;
        }
        if (range.rows) return range.rows;
        range.rows = tableState.rows.readRange(from, to);
        return range.rows;
      }
      return tableState.rows.readRange(from, to);
    },

    subscribeTableRows(id: string, from: number, to: number, listener: () => void) {
      if (
        !Number.isSafeInteger(from) ||
        from < 0 ||
        from % TABLE_ROW_RANGE_SIZE !== 0 ||
        to !== from + TABLE_ROW_RANGE_SIZE
      ) throw new RangeError("Table row subscriptions must use fixed aligned ranges");
      const range = getOrCreateTableRowRange(id, from, to);
      range.listeners.add(listener);
      return () => {
        range.listeners.delete(listener);
        if (range.listeners.size === 0) {
          const ranges = tableRowRangesByBlock.get(id);
          ranges?.delete(from);
          if (ranges?.size === 0) tableRowRangesByBlock.delete(id);
        }
      };
    },

    getVersion() {
      return version;
    },

    getNode(id: string) {
      const record = nodes.get(id);
      return record ? nodeRecordForRead(nodes, record) : undefined;
    },

    getNodeWithVersion(id: string) {
      const record = nodes.get(id);
      if (!record) {
        return EMPTY_NODE_SNAPSHOT;
      }
      const nodeSnapshotCache = getNodeSnapshotCacheForMap(nodes);
      const cached = nodeSnapshotCache.get(id);
      const node = nodeRecordForRead(nodes, record);
      if (cached && cached.version === record.version && cached.node === node) {
        return cached;
      }
      const snapshot = { version: record.version, node } as { version: number; node?: NodeRecord };
      nodeSnapshotCache.set(id, snapshot);
      pruneCache(nodeSnapshotCache, NODE_SNAPSHOT_CACHE_LIMIT, NODE_SNAPSHOT_CACHE_BUFFER);
      return snapshot;
    },

    getChildren(id: string) {
      const record = nodes.get(id);
      if (!record) return EMPTY_CHILDREN;
      return record.children;
    },

    getChildrenWithVersion(id: string) {
      const record = nodes.get(id);
      if (!record) {
        return EMPTY_CHILDREN_SNAPSHOT;
      }
      const childrenSnapshotCache = getChildrenSnapshotCacheForMap(nodes);
      const cached = childrenSnapshotCache.get(id);
      if (cached && cached.version === record.version) {
        return cached;
      }
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        (store as CampaignRendererStore).campaignCounters?.recordRecordSlotsAllocated?.(record.children.length, "store");
      }
      const snapshot = { version: record.version, children: record.children.slice() } as {
        version: number;
        children: ReadonlyArray<string>;
      };
      childrenSnapshotCache.set(id, snapshot);
      pruneCache(childrenSnapshotCache, CHILDREN_SNAPSHOT_CACHE_LIMIT, CHILDREN_SNAPSHOT_CACHE_BUFFER);
      return snapshot;
    },

    getInvariantViolations() {
      if (structuralViolations === null) {
        structuralViolations = collectStoreInvariantViolations(nodes);
        debugCounters.storeInvariantViolationCount += structuralViolations.length;
      }
      return [...structuralViolations, ...transientDiagnostics];
    },

    getDebugCounters() {
      return { ...debugCounters };
    },

    getLastCoalescingMetrics() {
      return lastCoalescingMetrics;
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getThemes() {
      return currentThemes;
    },

    setThemes(themes?: { light: string; dark: string }) {
      currentThemes = themes;
    },
  };

  registerNodeSubscriptions(store, (id, listener) => {
    let nodeSet = nodeListeners.get(id);
    if (!nodeSet) {
      nodeSet = new Set();
      nodeListeners.set(id, nodeSet);
    }
    nodeSet.add(listener);
    return () => {
      const current = nodeListeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) nodeListeners.delete(id);
    };
  });

  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    const internalStore = store as CampaignRendererStore;
    internalStore.campaignCounters = (options as RendererStoreOptions & { campaignCounters?: RendererCampaignCounters })?.campaignCounters;
  }
  rebuildFromBlocks(initialBlocks);
  preparedStoreCaptureByStore.set(store, () => createPreparedRendererStoreSnapshot(store.getBlocks(), currentThemes));
  return store;
}
