import {
  cloneBlock,
  createBlockSnapshot,
  extractCodeWrapperAttributes,
  getDefaultCodeWrapperAttributes,
  sanitizeCodeHTML,
  sanitizeHTML,
  type Block,
  type NodePath,
  type NodeSnapshot,
  PATCH_ROOT_ID,
  type Patch,
  type SetPropsBatchEntry,
  type TokenLineV1,
} from "@stream-mdx/core";
import { getPatchKind } from "@stream-mdx/core/perf/patch-batching";
import { normalizeAllListDepths, normalizeListDepthsForIds } from "./list-utils";
import { type CoalescingMetrics, DEFAULT_COALESCE_CONFIG, coalescePatchesWithMetrics } from "./patch-coalescing";

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

export interface ApplyPatchesOptions {
  coalesced?: boolean;
  metrics?: CoalescingMetrics | null;
  captureMetrics?: boolean;
  allowEmpty?: boolean;
}

export interface RendererStore {
  reset(blocks: Block[]): void;
  applyPatches(patches: Patch[], options?: ApplyPatchesOptions): Set<string>;
  getBlocks(): ReadonlyArray<Block>;
  getVersion(): number;
  getNode(id: string): NodeRecord | undefined;
  getNodeWithVersion(id: string): { version: number; node?: NodeRecord };
  getChildren(id: string): ReadonlyArray<string>;
  getChildrenWithVersion(id: string): { version: number; children: ReadonlyArray<string> };
  getInvariantViolations(): string[];
  getDebugCounters(): Readonly<Record<string, number>>;
  subscribe(listener: () => void): () => void;
  getLastCoalescingMetrics(): CoalescingMetrics | null;
}

function snapshotToBlock(node: NodeSnapshot): Block | null {
  const candidate = node.props?.block;
  if (candidate && typeof candidate === "object") {
    return cloneBlock(candidate as Block);
  }
  return null;
}

type NodeMap = Map<string, NodeRecord>;

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
}

function clearSnapshotCaches(map: NodeMap) {
  getNodeSnapshotCacheForMap(map).clear();
  getChildrenSnapshotCacheForMap(map).clear();
}
const EMPTY_CHILDREN: ReadonlyArray<string> = Object.freeze([]);
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
};

type StoreDebugCounters = {
  appendLineGuardRejected: number;
  staleEpochRejected: number;
  storeInvariantViolationCount: number;
};

const PATCH_PERF_HISTORY_LIMIT = 120;
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
  if (typeof payload.compiledMdxModule?.code === "string") size += payload.compiledMdxModule.code.length;
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

function assignSubtreeBlockEpoch(map: NodeMap, rootId: string, blockEpoch: number, touched?: Set<string>) {
  const root = map.get(rootId);
  if (!root) return;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.blockEpoch !== blockEpoch) {
      node.blockEpoch = blockEpoch;
      node.version += 1;
      touched?.add(node.id);
    }
    for (const childId of node.children) {
      const child = map.get(childId);
      if (child) {
        stack.push(child);
      }
    }
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

function ensureUniqueChildren(parent: NodeRecord, touched?: Set<string>) {
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
    deduped.push(childId);
  }
  if (mutated) {
    parent.children = deduped;
    parent.version++;
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
  if (parent.type !== "code") return;

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
      node.version++;
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
      touched.add(desiredId);
      mutated = true;
    } else if (!nodes.has(desiredId)) {
      nodes.set(desiredId, node);
    }

    if (node.parentId !== parent.id) {
      node.parentId = parent.id;
      node.version++;
      touched.add(node.id);
      mutated = true;
    }

    const incoming: Record<string, unknown> = { index: idx, text: node.props?.text, html: node.props?.html };
    if (Object.prototype.hasOwnProperty.call(node.props ?? {}, "tokens")) {
      incoming.tokens = (node.props as Record<string, unknown>).tokens;
    }
    const normalizedProps = normalizeCodeLineProps(incoming, node.props);
    if (normalizedProps !== node.props) {
      node.props = normalizedProps;
      node.version++;
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
    parent.version++;
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
  const hasIncomingHtml = typeof incoming.html === "string";
  const hasIncomingTokens = Object.prototype.hasOwnProperty.call(incoming, "tokens");
  const incomingTokens = hasIncomingTokens ? (incoming.tokens as TokenLineV1 | null) : undefined;
  const rawText = hasIncomingText ? (incoming.text as string) : previousText;

  if (previous && !hasIncomingHtml && !hasIncomingTokens && index === previousIndex && (!hasIncomingText || rawText === previousText)) {
    return previous;
  }
  if (
    previous &&
    hasIncomingHtml &&
    !hasIncomingTokens &&
    incoming.html === previousHtml &&
    index === previousIndex &&
    (!hasIncomingText || rawText === previousText)
  ) {
    return previous;
  }

  let highlight: string | null = null;
  if (hasIncomingHtml) {
    highlight = incoming.html as string;
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
  return createCodeLineProps(index, rawText, highlight, tokens);
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

function applyCodeBlockMetadata(record: NodeRecord) {
  const block = record.block;
  const highlightedHtml = block?.payload.highlightedHtml ?? "";
  const lang = typeof block?.payload.meta?.lang === "string" ? (block?.payload.meta?.lang as string) : record.props?.lang;
  let { preAttrs, codeAttrs } = extractCodeWrapperAttributes(highlightedHtml);
  if (!preAttrs || !codeAttrs) {
    const defaults = getDefaultCodeWrapperAttributes(typeof lang === "string" ? lang : undefined);
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
    return createCodeLineProps(index, text, html, tokens);
  }

  if (isInlineSegmentType(snapshot.type)) {
    const incoming = snapshot.props ? { ...snapshot.props } : {};
    return mergeInlineSegmentProps(undefined, incoming);
  }

  return snapshot.props ? { ...snapshot.props } : {};
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
  ancestor.version++;
  touched.add(ancestor.id);
  console.warn("[renderer-store] rebuilt code block from snapshot", {
    parentId: parent.id,
    issues,
  });
  return true;
}

function arraysEqual<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function expectedCodeLineId(parentId: string, index: number): string {
  return `${parentId}::line:${index}`;
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
function buildNodeFromSnapshot(map: NodeMap, snapshot: NodeSnapshot, parentId: string | null, blockEpoch: number): NodeRecord {
  const record: NodeRecord = {
    id: snapshot.id,
    type: snapshot.type,
    parentId,
    children: [],
    props: normalizeNodeProps(snapshot),
    meta: snapshot.meta ? { ...snapshot.meta } : undefined,
    range: snapshot.range ? { ...snapshot.range } : undefined,
    version: 0,
    blockEpoch,
    block: snapshotToBlock(snapshot) ?? undefined,
  };

  if (record.type === "code") {
    applyCodeBlockMetadata(record);
  }

  map.set(record.id, record);

  const childSnapshots = ensureArray(snapshot.children);
  for (const child of childSnapshots) {
    const childRecord = buildNodeFromSnapshot(map, child, record.id, blockEpoch);
    record.children.push(childRecord.id);
  }

  return record;
}

function removeSubtree(map: NodeMap, id: string, touched: Set<string>) {
  const record = map.get(id);
  if (!record) return;
  const stack = [record];
  const affectedParents = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.parentId) {
      const parent = map.get(node.parentId);
      if (parent) {
        const idx = parent.children.indexOf(node.id);
        if (idx !== -1) {
          parent.children.splice(idx, 1);
          parent.version++;
          touched.add(parent.id);
          affectedParents.add(parent.id);
        }
      }
    }
    map.delete(node.id);
    deleteSnapshotCacheEntry(map, node.id);
    touched.add(node.id);
    for (const childId of node.children) {
      const child = map.get(childId);
      if (child) stack.push(child);
    }
  }
  for (const parentId of affectedParents) {
    const parent = map.get(parentId);
    if (parent && parent.type === "code") {
      normalizeCodeBlockChildren(map, parent, touched);
    }
  }
}

function convertNodeToBlocks(map: NodeMap, root: NodeRecord): Block[] {
  const result: Block[] = [];
  for (const childId of root.children) {
    const child = map.get(childId);
    if (!child || !child.block) continue;
    result.push(cloneBlock(child.block));
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
): { record: NodeRecord; insertedIds: string[] } | null {
  if (!parent) return null;
  const existingIndex = parent.children.indexOf(snapshot.id);
  if (existingIndex !== -1) {
    removeSubtree(map, parent.children[existingIndex], touched ?? new Set<string>());
  }
  const record = buildNodeFromSnapshot(map, snapshot, parent.id, blockEpoch ?? readSnapshotBlockEpoch(snapshot) ?? parent.blockEpoch);
  const insertedIds: string[] = [];

  const queue = [record];
  while (queue.length > 0) {
    const node = queue.pop();
    if (!node) continue;
    insertedIds.push(node.id);
    for (const childId of node.children) {
      const child = map.get(childId);
      if (child) queue.push(child);
    }
  }

  const clampedIndex = Math.min(Math.max(index, 0), parent.children.length);
  parent.children.splice(clampedIndex, 0, record.id);
  parent.version++;
  ensureUniqueChildren(parent, touched);
  return { record, insertedIds };
}

function replaceSnapshotAt(
  map: NodeMap,
  parent: NodeRecord | undefined,
  index: number,
  snapshot: NodeSnapshot,
  touched: Set<string>,
  blockEpoch?: number,
) {
  if (!parent) return;
  if (index < 0 || index >= parent.children.length) return;
  const targetId = parent.children[index];
  parent.children.splice(index, 1);
  removeSubtree(map, targetId, touched);
  const inserted = insertSnapshotAt(map, parent, index, snapshot, touched, blockEpoch);
  if (inserted) {
    for (const id of inserted.insertedIds) {
      touched.add(id);
    }
  }
  if (parent.type === "code") {
    normalizeCodeBlockChildren(map, parent, touched);
  } else {
    ensureUniqueChildren(parent, touched);
  }
}

export function createRendererStore(initialBlocks: Block[] = []): RendererStore {
  let nodes: NodeMap = new Map();
  let version = 0;
  let blocksCache: Block[] = [];
  let blocksDirty = true;
  const listeners = new Set<() => void>();
  let notifyScheduled = false;
  let lastCoalescingMetrics: CoalescingMetrics | null = null;
  let invariantViolations: string[] = [];
  let transientDiagnostics: string[] = [];
  let nextBlockEpoch = 1;
  const debugCounters: StoreDebugCounters = {
    appendLineGuardRejected: 0,
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

  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error("RendererStore listener failed", error);
      }
    }
  }

  function appendDiagnostic(message: string) {
    transientDiagnostics = [...transientDiagnostics, message];
    invariantViolations = [...invariantViolations, message];
  }

  function rebuildFromBlocks(blocks: Block[]) {
    clearSnapshotCaches(nodes);
    nodes = new Map();
    const root = createRootRecord();
    nodes.set(root.id, root);
    root.children = [];
    lastCoalescingMetrics = null;
    for (let i = 0; i < blocks.length; i++) {
      const block = cloneBlock(blocks[i]);
      const snapshot = createBlockSnapshot(block);
      insertSnapshotAt(nodes, root, root.children.length, snapshot, undefined, allocateBlockEpoch(readSnapshotBlockEpoch(snapshot)));
    }
    normalizeAllListDepths(nodes, new Set<string>(), PATCH_ROOT_ID);
    transientDiagnostics = [];
    invariantViolations = collectStoreInvariantViolations(nodes);
    debugCounters.storeInvariantViolationCount += invariantViolations.length;
    version++;
    blocksDirty = true;
    // Defer notification to avoid React "Cannot update a component while rendering" warning
    // Use rAF (or fallback) to align with frame updates
    scheduleNotify();
  }

  rebuildFromBlocks(initialBlocks);

  const store: RendererStore = {
    reset(nextBlocks: Block[]) {
      rebuildFromBlocks(nextBlocks);
    },

    applyPatches(patches: Patch[], options?: ApplyPatchesOptions) {
      const touched = new Set<string>();
      if (!patches || patches.length === 0) {
        lastCoalescingMetrics = options?.metrics ?? null;
        return touched;
      }

      const perfEnabled = isPatchPerfDebugEnabled();
      const perfStart = perfEnabled ? getPerfNow() : 0;
      const opStats: Record<string, PatchPerfOpSummary> = perfEnabled ? {} : {};
      const setPropsByType: Record<string, PatchPerfOpSummary> = perfEnabled ? {} : {};
      const setPropsBySize: Record<string, PatchPerfOpSummary> = perfEnabled ? {} : {};
      let applyMs = 0;
      let listNormalizeMs = 0;

      let coalescedPatches = patches;
      let metrics: CoalescingMetrics | null = options?.metrics ?? null;

      if (!options?.coalesced) {
        const result = coalescePatchesWithMetrics(patches, DEFAULT_COALESCE_CONFIG);
        coalescedPatches = result.patches;
        metrics = result.metrics;
      }

      lastCoalescingMetrics = metrics;

      const root = nodes.get(PATCH_ROOT_ID);
      if (!root) {
        nodes.set(PATCH_ROOT_ID, createRootRecord());
      }

      let mutatedBlocks = false;
      let listDepthDirty = false;
      const listDepthDirtyNodes = new Set<string>();
      const debugListPatches = isListPatchDebugEnabled();

      const isListRelated = (type: string | undefined) => type === "list" || type === "list-item";
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
        if (!target || target.blockEpoch === expectedBlockEpoch) {
          return false;
        }
        const txEpoch = at.blockId && patchTx !== undefined ? semanticTxEpochs.get(at.blockId) : undefined;
        if (txEpoch && txEpoch.tx === patchTx && txEpoch.blockEpoch === target.blockEpoch) {
          return false;
        }
        debugCounters.staleEpochRejected += 1;
        appendDiagnostic(
          `stale epoch rejected:${patch.op}:${target.id}:expected=${expectedBlockEpoch}:actual=${target.blockEpoch}`,
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
        assignSubtreeBlockEpoch(nodes, blockRoot.id, nextEpoch, touchedSet);
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
          const incoming: Record<string, unknown> = {
            index: props?.index,
            text: props?.text,
            html: props?.html,
          };
          if (Object.prototype.hasOwnProperty.call(props ?? {}, "tokens")) {
            incoming.tokens = (props as Record<string, unknown>).tokens;
          }
          const normalized = normalizeCodeLineProps(incoming, target.props);
          if (normalized !== target.props) {
            target.props = normalized;
            propsChanged = true;
          }
          if (propsChanged) {
            if (semanticUpdate) {
              advanceBlockEpoch(at.blockId, touched, preferredEpoch, tx);
            }
            target.version++;
            touched.add(target.id);
            const parent = target.parentId ? nodes.get(target.parentId) : undefined;
            if (parent) {
              parent.version++;
              touched.add(parent.id);
              if (parent.type === "code") {
                normalizeCodeBlockChildren(nodes, parent, touched);
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
          const nextProps = props ? { ...props } : {};
          if ("block" in nextProps) {
            delete (nextProps as Record<string, unknown>).block;
          }
          const mergedSegments = mergeInlineSegmentProps(target.props, nextProps);
          if (!shallowEqualRecords(target.props as Record<string, unknown> | undefined, mergedSegments)) {
            target.props = mergedSegments;
            propsChanged = true;
          }
        } else {
          const nextProps = props ? { ...props } : {};
          if ("block" in nextProps) {
            delete (nextProps as Record<string, unknown>).block;
          }
          const base = target.props ? { ...target.props } : {};
          let localChanged = false;
          if (Object.prototype.hasOwnProperty.call(base, "block")) {
            delete (base as Record<string, unknown>).block;
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
        }

        let blockChanged = false;
        let typeChanged = false;
        let rebuiltFromFinalizedBlock = false;
        let blockEpochAdvanced = false;
        const incomingBlock = props?.block as Block | undefined;
        if (incomingBlock && typeof incomingBlock === "object") {
          target.block = cloneBlock(incomingBlock as Block);
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
            applyCodeBlockMetadata(target);
          }
          if (semanticUpdate) {
            advanceBlockEpoch(at.blockId, touched, preferredEpoch, tx);
            blockEpochAdvanced = true;
          }
          const shouldRebuildFinalizedTree =
            !at.nodeId &&
            target.id === at.blockId &&
            Boolean(target.block?.isFinalized) &&
            target.type !== "code" &&
            Boolean(target.parentId);
          if (shouldRebuildFinalizedTree) {
            const parent = target.parentId ? nodes.get(target.parentId) : undefined;
            const index = parent ? parent.children.indexOf(target.id) : -1;
            if (parent && index !== -1) {
              const snapshot = createBlockSnapshot(cloneBlock(target.block as Block));
              replaceSnapshotAt(nodes, parent, index, snapshot, touched, target.blockEpoch);
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
        }

        if (rebuiltFromFinalizedBlock) {
          return;
        }

        if (propsChanged || blockChanged || typeChanged) {
          if (semanticUpdate && !blockEpochAdvanced) {
            advanceBlockEpoch(at.blockId, touched, preferredEpoch, tx);
            blockEpochAdvanced = true;
          }
          target.version++;
          touched.add(target.id);

          let parentForNormalization: NodeRecord | undefined;
          if (target.parentId) {
            const parent = nodes.get(target.parentId);
            if (parent) {
              if (target.type === "code-line") {
                parent.version++;
                touched.add(parent.id);
              }
              if (parent.type === "code") {
                parentForNormalization = parent;
              }
            }
          }

          if (target.type === "code") {
            normalizeCodeBlockChildren(nodes, target, touched);
          } else if (parentForNormalization) {
            normalizeCodeBlockChildren(nodes, parentForNormalization, touched);
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

      const applyPatch = (patch: Patch) => {
        switch (patch.op) {
          case "insertChild": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const parent = resolveParent(nodes, patch.at);
            const inserted = insertSnapshotAt(
              nodes,
              parent,
              patch.index,
              patch.node,
              touched,
              allocateBlockEpoch(readPatchParseEpoch(patch) ?? readSnapshotBlockEpoch(patch.node)),
            );
            if (inserted) {
              for (const id of inserted.insertedIds) {
                touched.add(id);
              }
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
            const childId = parent.children.splice(patch.index, 1)[0];
            if (childId) {
              const removedNode = nodes.get(childId);
              removeSubtree(nodes, childId, touched);
              parent.version++;
              touched.add(parent.id);
              ensureUniqueChildren(parent, touched);
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
            replaceSnapshotAt(
              nodes,
              parent,
              patch.index,
              patch.node,
              touched,
              allocateBlockEpoch(readPatchParseEpoch(patch) ?? readSnapshotBlockEpoch(patch.node)),
            );
            touched.add(parent.id);
            mutatedBlocks = true;
            advanceBlockEpoch(patch.at.blockId, touched, readPatchParseEpoch(patch), readPatchTx(patch));
            if (isListRelated(parent.type)) {
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
            applyPropsUpdate(patch.at, patch.props, readPatchParseEpoch(patch), readPatchTx(patch), getPatchKind(patch) === "semantic");
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
              applyPropsUpdate(
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
            if (!target || !target.block) break;
            if (!target.block.isFinalized) {
              target.block = cloneBlock(target.block);
              target.block.isFinalized = true;
              target.version++;
              touched.add(target.id);
              mutatedBlocks = true;

              if (!patch.at.nodeId && target.id === patch.at.blockId && target.type !== "code" && target.parentId) {
                const parent = nodes.get(target.parentId);
                const index = parent ? parent.children.indexOf(target.id) : -1;
                if (parent && index !== -1) {
                  const snapshot = createBlockSnapshot(cloneBlock(target.block));
                  replaceSnapshotAt(nodes, parent, index, snapshot, touched, target.blockEpoch);
                  if (isListRelated(target.type) || isListRelated(snapshot.type)) {
                    markListDepthDirty(target.id);
                  }
                }
              }
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
            const moved = parent.children.splice(from, count);
            parent.children.splice(to, 0, ...moved);
            parent.version++;
            touched.add(parent.id);
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

          case "appendLines": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const parent = resolveParent(nodes, patch.at);
            if (!parent) break;
            if (parent.type !== "code") {
              debugCounters.appendLineGuardRejected += 1;
              appendDiagnostic(`appendLines target not code:${parent.id}:${parent.type}`);
              break;
            }
            const requestedStartIndex = Math.max(0, patch.startIndex);
            const startIndex = Math.max(0, Math.min(requestedStartIndex, parent.children.length));
            const lineCount = patch.lines?.length ?? 0;
            if (lineCount === 0) break;

            const prefixMatches = parent.children.every((childId, index) => childId === expectedCodeLineId(parent.id, index));
            const isStrictTailAppend = requestedStartIndex === parent.children.length;
            if (!isStrictTailAppend || !prefixMatches) {
              debugCounters.appendLineGuardRejected += 1;
              appendDiagnostic(
                `appendLines guard rejected:${parent.id}:requestedStart=${requestedStartIndex}:childCount=${parent.children.length}:prefixMatches=${prefixMatches}`,
              );
              break;
            }

            const originalChildren = parent.children.slice();
            const insertedIds: string[] = [];
            const insertedSet = new Set<string>();
            const isTrailingAppend = true;
            let parentChildrenChanged = false;
            let codeLinesMutated = false;

            for (let offset = 0; offset < lineCount; offset++) {
              const absoluteIndex = startIndex + offset;
              const lineId = `${parent.id}::line:${absoluteIndex}`;
              insertedIds.push(lineId);
              insertedSet.add(lineId);

              const hasTokens = Object.prototype.hasOwnProperty.call(patch, "tokens");
              const nextTokens = hasTokens ? (patch.tokens?.[offset] ?? null) : undefined;
              const nextLineProps = createCodeLineProps(
                absoluteIndex,
                patch.lines[offset] ?? "",
                patch.highlight?.[offset] ?? null,
                nextTokens,
              );
              const existing = nodes.get(lineId);
              if (existing && existing.type === "code-line") {
                const existingIndex = parent.children.indexOf(lineId);
                if (existingIndex !== -1) {
                  parent.children.splice(existingIndex, 1);
                  parentChildrenChanged = true;
                }
                if (existing.parentId !== parent.id) {
                  existing.parentId = parent.id;
                  existing.version++;
                  touched.add(lineId);
                  codeLinesMutated = true;
                }
                if (!shallowEqualRecords(existing.props as Record<string, unknown> | undefined, nextLineProps)) {
                  existing.props = nextLineProps;
                  existing.version++;
                  touched.add(lineId);
                  codeLinesMutated = true;
                }
              } else {
                const record: NodeRecord = {
                  id: lineId,
                  type: "code-line",
                  parentId: parent.id,
                  children: [],
                  props: nextLineProps,
                  version: 0,
                  blockEpoch: parent.blockEpoch,
                };
                nodes.set(lineId, record);
                touched.add(lineId);
                codeLinesMutated = true;
              }
            }

            if (insertedIds.length > 0) {
              let nextChildren: string[];
              if (isTrailingAppend) {
                nextChildren = [...originalChildren, ...insertedIds];
              } else {
                const cleanedChildren = originalChildren.filter((childId) => !insertedSet.has(childId));
                const clampedStart = Math.max(0, Math.min(startIndex, cleanedChildren.length));
                nextChildren = [...cleanedChildren.slice(0, clampedStart), ...insertedIds, ...cleanedChildren.slice(clampedStart)];
              }
              if (!arraysEqual(originalChildren, nextChildren)) {
                parent.children = nextChildren;
                parentChildrenChanged = true;
              }
            }

            if (!isTrailingAppend) {
              for (let idx = 0; idx < parent.children.length; idx++) {
                const childId = parent.children[idx];
                const child = nodes.get(childId);
                if (child && child.type === "code-line") {
                  const incoming: Record<string, unknown> = { index: idx, text: child.props?.text, html: child.props?.html };
                  if (Object.prototype.hasOwnProperty.call(child.props ?? {}, "tokens")) {
                    incoming.tokens = (child.props as Record<string, unknown>).tokens;
                  }
                  const normalized = normalizeCodeLineProps(incoming, child.props);
                  if (normalized !== child.props) {
                    child.props = normalized;
                    child.version++;
                    touched.add(child.id);
                    codeLinesMutated = true;
                  }
                }
              }
            }

            if (parentChildrenChanged || codeLinesMutated) {
              parent.version++;
              touched.add(parent.id);
              if (!isTrailingAppend) {
                normalizeCodeBlockChildren(nodes, parent, touched);
              }
            }
            break;
          }

          case "setHTML": {
            if (rejectStaleEpochPatch(patch, patch.at)) break;
            const target = nodes.get(patch.at.nodeId ?? patch.at.blockId);
            if (!target) break;
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

            target.version++;
            touched.add(target.id);
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

      const finalizedTableRoots = new Set<string>();
      for (const touchedId of touched) {
        let cursor = nodes.get(touchedId);
        while (cursor && cursor.id !== PATCH_ROOT_ID) {
          if (cursor.type === "table" && cursor.block?.isFinalized && cursor.parentId) {
            finalizedTableRoots.add(cursor.id);
            break;
          }
          cursor = cursor.parentId ? nodes.get(cursor.parentId) : undefined;
        }
      }
      if (finalizedTableRoots.size > 0) {
        for (const tableId of finalizedTableRoots) {
          const tableNode = nodes.get(tableId);
          if (!tableNode || !tableNode.block || !tableNode.parentId) continue;
          const parent = nodes.get(tableNode.parentId);
          if (!parent) continue;
          const index = parent.children.indexOf(tableNode.id);
          if (index === -1) continue;
          const snapshot = createBlockSnapshot(cloneBlock(tableNode.block));
          replaceSnapshotAt(nodes, parent, index, snapshot, touched, tableNode.blockEpoch);
          mutatedBlocks = true;
        }
      }

      if (mutatedBlocks) {
        blocksDirty = true;
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

      invariantViolations = [...collectStoreInvariantViolations(nodes), ...transientDiagnostics];
      debugCounters.storeInvariantViolationCount += invariantViolations.length;

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
        });
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
        blocksCache = convertNodeToBlocks(nodes, root);
      }
      blocksDirty = false;
      return blocksCache;
    },

    getVersion() {
      return version;
    },

    getNode(id: string) {
      return nodes.get(id);
    },

    getNodeWithVersion(id: string) {
      const record = nodes.get(id);
      if (!record) {
        return EMPTY_NODE_SNAPSHOT;
      }
      const nodeSnapshotCache = getNodeSnapshotCacheForMap(nodes);
      const cached = nodeSnapshotCache.get(id);
      if (cached && cached.version === record.version && cached.node === record) {
        return cached;
      }
      const snapshot = { version: record.version, node: record } as { version: number; node?: NodeRecord };
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
      const snapshot = { version: record.version, children: record.children.slice() } as {
        version: number;
        children: ReadonlyArray<string>;
      };
      childrenSnapshotCache.set(id, snapshot);
      pruneCache(childrenSnapshotCache, CHILDREN_SNAPSHOT_CACHE_LIMIT, CHILDREN_SNAPSHOT_CACHE_BUFFER);
      return snapshot;
    },

    getInvariantViolations() {
      return invariantViolations.slice();
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
  };

  return store;
}
