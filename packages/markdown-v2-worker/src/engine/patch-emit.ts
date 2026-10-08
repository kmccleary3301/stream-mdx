import type {
  Block,
  NodeSnapshot,
  Patch,
  PatchKind,
} from "@stream-mdx/core";
import {
  cloneBlock,
  createBlockSnapshot,
} from "@stream-mdx/core";
import { getPatchKind, isHeavyPatch } from "@stream-mdx/core/perf/patch-batching";
import type { SharedHighlighter } from "./highlight";
import type { WorkerMetricsCollector } from "./metrics";

const sharedTextEncoder: TextEncoder | null = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export function estimatePatchSize(patches: Patch[]): number {
  if (!sharedTextEncoder) return 0;
  try {
    return sharedTextEncoder.encode(JSON.stringify(patches)).length;
  } catch {
    return 0;
  }
}

export function readPatchControlMeta(
  patch: Patch,
): { kind: PatchKind; streamSeq?: number; parseEpoch?: number } | null {
  const candidate = (patch as { meta?: unknown }).meta;
  if (!candidate || typeof candidate !== "object") return null;
  const kind = (candidate as { kind?: unknown }).kind;
  if (kind !== "semantic" && kind !== "transient" && kind !== "coalescing") {
    return null;
  }
  const streamSeq = (candidate as { streamSeq?: unknown }).streamSeq;
  const parseEpoch = (candidate as { parseEpoch?: unknown }).parseEpoch;
  return {
    kind,
    streamSeq: typeof streamSeq === "number" ? streamSeq : undefined,
    parseEpoch: typeof parseEpoch === "number" ? parseEpoch : undefined,
  };
}

export function targetBlockIdsForPatch(patch: Patch): string[] {
  if (patch.op === "setPropsBatch") {
    const ids = new Set<string>();
    for (const entry of patch.entries ?? []) {
      if (entry?.at?.blockId) {
        ids.add(entry.at.blockId);
      }
    }
    return Array.from(ids);
  }
  if (patch.at?.blockId) {
    return [patch.at.blockId];
  }
  return [];
}

export function withPatchControlMeta(
  patch: Patch,
  meta: {
    kind: PatchKind;
    streamSeq?: number;
    parseEpoch?: number;
  },
): Patch {
  const existing = (patch as { meta?: unknown }).meta;
  const merged =
    existing && typeof existing === "object"
      ? { ...(existing as Record<string, unknown>), ...meta }
      : { ...meta };
  return {
    ...patch,
    meta: merged,
  };
}

export function withPatchKind(patch: Patch, kind: PatchKind): Patch {
  if (patch.op === "setHTML") {
    return {
      ...patch,
      meta: {
        ...(patch.meta || {}),
        kind,
      },
    };
  }
  return {
    ...patch,
    meta: {
      ...((patch as { meta?: Record<string, unknown> }).meta || {}),
      kind,
    },
  };
}

export function withPatchKindBatch(patches: Patch[], kind: PatchKind): Patch[] {
  return patches.map((patch) => withPatchKind(patch, kind));
}

export function annotatePatchBatch(
  patches: Patch[],
  tx: number,
  parseEpoch: number,
  streamSeqCounter: { value: number },
): Patch[] {
  return patches.map((patch) => {
    streamSeqCounter.value += 1;
    const streamSeq = streamSeqCounter.value;
    const kind = getPatchKind(patch);
    return withPatchControlMeta(patch, {
      kind,
      streamSeq,
      parseEpoch,
    });
  });
}

export function syncEmittedBlockEpochsFromPatches(
  patches: Patch[],
  parseEpoch: number,
  emittedBlockEpochs: Map<string, number>,
): void {
  for (const patch of patches) {
    if (getPatchKind(patch) !== "semantic") {
      continue;
    }
    const blockIds = targetBlockIdsForPatch(patch);
    for (const blockId of blockIds) {
      emittedBlockEpochs.set(blockId, parseEpoch);
    }
  }
}

export function ensureAnnotatedPatchBatch(
  patches: Patch[],
  tx: number,
  parseEpochCounter: { value: number },
  streamSeqCounter: { value: number },
  parseEpoch?: number,
): { patches: Patch[]; parseEpoch: number } {
  const effectiveEpoch = parseEpoch ?? (parseEpochCounter.value += 1);
  return {
    patches: annotatePatchBatch(patches, tx, effectiveEpoch, streamSeqCounter),
    parseEpoch: effectiveEpoch,
  };
}

export function countChangedBlocksFromPatches(patches: Patch[]): number {
  if (!patches || patches.length === 0) return 0;
  const ids = new Set<string>();
  for (const patch of patches) {
    for (const blockId of targetBlockIdsForPatch(patch)) {
      ids.add(blockId);
    }
  }
  return ids.size;
}

export function isPriorityImmediatePatch(patch: Patch): boolean {
  if (patch.op === "finalize") {
    return true;
  }
  if (patch.op === "setProps" && patch.props && "isFinalized" in patch.props && patch.props.isFinalized === true) {
    return true;
  }
  if (patch.op === "setPropsBatch") {
    for (const entry of patch.entries ?? []) {
      if (entry?.props && "isFinalized" in entry.props && entry.props.isFinalized === true) {
        return true;
      }
    }
  }
  return false;
}

export function dedupeSetPropsByTargetKeepingLatest(patches: Patch[]): Patch[] {
  if (patches.length < 2) {
    return patches;
  }
  const lastIndexByBlockId = new Map<string, number>();
  for (let i = 0; i < patches.length; i += 1) {
    const patch = patches[i];
    if (patch.op === "setProps" && patch.at?.blockId) {
      lastIndexByBlockId.set(patch.at.blockId, i);
    }
  }
  if (lastIndexByBlockId.size === 0) {
    return patches;
  }
  const result: Patch[] = [];
  for (let i = 0; i < patches.length; i += 1) {
    const patch = patches[i];
    if (patch.op === "setProps" && patch.at?.blockId) {
      const targetId = patch.at.blockId;
      const latest = lastIndexByBlockId.get(targetId);
      if (latest !== undefined && latest !== i) {
        continue;
      }
    }
    result.push(patch);
  }
  return result;
}

export function partitionPatchesForCredits(
  patches: Patch[],
  credits: number,
  deferredQueue: Patch[],
  maxImmediate?: number,
  options?: { maxDeferred?: number },
): Patch[] {
  const maxDeferred = options?.maxDeferred ?? 400;
  if (credits >= 1 && (maxImmediate === undefined || maxImmediate <= 0)) {
    return patches;
  }

  const immediate: Patch[] = [];
  const deferred: Patch[] = [];

  for (const patch of patches) {
    const isPriority = isPriorityImmediatePatch(patch);
    if (isPriority) {
      immediate.push(patch);
      continue;
    }

    if (maxImmediate !== undefined && maxImmediate > 0 && immediate.length >= maxImmediate) {
      deferred.push(patch);
      continue;
    }

    if (credits < 1 && isHeavyPatch(patch)) {
      deferred.push(patch);
    } else {
      immediate.push(patch);
    }
  }

  if (deferred.length > 0) {
    deferredQueue.push(...deferred);
    if (deferredQueue.length > maxDeferred) {
      const deduped = dedupeSetPropsByTargetKeepingLatest(deferredQueue);
      deferredQueue.length = 0;
      deferredQueue.push(...deduped);
      if (deferredQueue.length > maxDeferred) {
        const excess = deferredQueue.length - maxDeferred;
        deferredQueue.splice(0, excess);
      }
    }
  }

  return immediate;
}

export function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

export function haveSameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const id of a) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const id of b) {
    const current = counts.get(id);
    if (!current) return false;
    if (current === 1) counts.delete(id);
    else counts.set(id, current - 1);
  }
  return counts.size === 0;
}

export function expectedCodeLineSnapshotId(parentId: string, index: number): string {
  return `${parentId}::line:${index}`;
}

export function isStrictCodeLineSnapshot(parentId: string, child: NodeSnapshot, index: number): boolean {
  if (child.type !== "code-line") return false;
  if (child.id !== expectedCodeLineSnapshotId(parentId, index)) return false;
  const childIndex = typeof child.props?.index === "number" ? (child.props.index as number) : null;
  return childIndex === index;
}

export function canEmitAppendLinesPatch(prevNode: NodeSnapshot, nextNode: NodeSnapshot, divergeIndex: number): boolean {
  if (prevNode.type !== "code" || nextNode.type !== "code") return false;
  const prevChildren = prevNode.children ?? [];
  const nextChildren = nextNode.children ?? [];
  if (divergeIndex !== prevChildren.length || nextChildren.length < prevChildren.length) {
    return false;
  }
  for (let index = 0; index < prevChildren.length; index += 1) {
    if (!isStrictCodeLineSnapshot(prevNode.id, prevChildren[index], index)) {
      return false;
    }
    if (!isStrictCodeLineSnapshot(nextNode.id, nextChildren[index], index)) {
      return false;
    }
  }
  for (let index = divergeIndex; index < nextChildren.length; index += 1) {
    if (!isStrictCodeLineSnapshot(nextNode.id, nextChildren[index], index)) {
      return false;
    }
  }
  return true;
}

export function diffListChildren(
  blockId: string,
  listNode: NodeSnapshot,
  prevChildren: NodeSnapshot[],
  nextChildren: NodeSnapshot[],
  patches: Patch[],
  metrics?: WorkerMetricsCollector | null,
): void {
  const prevIds = prevChildren.map((c) => c.id);
  const nextIds = nextChildren.map((c) => c.id);

  if (prevIds.length === nextIds.length && haveSameMultiset(prevIds, nextIds)) {
    const isDifferentOrder = prevIds.some((id, index) => id !== nextIds[index]);
    if (isDifferentOrder) {
      patches.push({
        op: "reorder",
        at: { blockId },
        order: nextIds,
      });
      for (let i = 0; i < nextChildren.length; i += 1) {
        const nextChild = nextChildren[i];
        const prevChild = prevChildren.find((c) => c.id === nextChild.id);
        if (prevChild) {
          diffNodeSnapshot(nextChild.id, prevChild, nextChild, patches, metrics);
        }
      }
      return;
    }
  }

  let prefix = 0;
  const maxPrefix = Math.min(prevChildren.length, nextChildren.length);
  while (prefix < maxPrefix && prevChildren[prefix].id === nextChildren[prefix].id) {
    prefix += 1;
  }

  let prevTail = prevChildren.length - 1;
  let nextTail = nextChildren.length - 1;
  while (prevTail >= prefix && nextTail >= prefix && prevChildren[prevTail].id === nextChildren[nextTail].id) {
    prevTail -= 1;
    nextTail -= 1;
  }

  const removeCount = prevTail >= prefix ? prevTail - prefix + 1 : 0;
  const addCount = nextTail >= prefix ? nextTail - prefix + 1 : 0;

  if (removeCount === addCount) {
    for (let offset = 0; offset < addCount; offset += 1) {
      const targetIndex = prefix + offset;
      patches.push({
        op: "replaceChild",
        at: { blockId },
        index: targetIndex,
        node: nextChildren[targetIndex],
      });
    }
  } else {
    for (let i = removeCount - 1; i >= 0; i -= 1) {
      patches.push({
        op: "deleteChild",
        at: { blockId },
        index: prefix + i,
      });
    }
    for (let offset = 0; offset < addCount; offset += 1) {
      const insertIndex = prefix + offset;
      patches.push({
        op: "insertChild",
        at: { blockId },
        index: insertIndex,
        node: nextChildren[insertIndex],
      });
    }
  }

  for (let i = 0; i < prefix; i += 1) {
    diffNodeSnapshot(prevChildren[i].id, prevChildren[i], nextChildren[i], patches, metrics);
  }
  const prevTailStart = prevTail + 1;
  const nextTailStart = nextTail + 1;
  const tailCount = prevChildren.length - prevTailStart;
  for (let offset = 0; offset < tailCount; offset += 1) {
    const prevChild = prevChildren[prevTailStart + offset];
    const nextChild = nextChildren[nextTailStart + offset];
    diffNodeSnapshot(nextChild.id, prevChild, nextChild, patches, metrics);
  }
}

export function diffNodeSnapshot(
  blockId: string,
  prevNode: NodeSnapshot,
  nextNode: NodeSnapshot,
  patches: Patch[],
  metrics?: WorkerMetricsCollector | null,
): void {
  const prevProps = prevNode.props ?? {};
  const nextProps = nextNode.props ?? {};
  const propsChanged = !shallowEqual(prevProps, nextProps);

  if (propsChanged) {
    const isTrans =
      Boolean(nextProps.allowMixedStreaming) ||
      Boolean(prevProps.allowMixedStreaming) ||
      Boolean(nextProps.inlineStatus) ||
      Boolean(prevProps.inlineStatus);
    const kind: PatchKind = isTrans ? "transient" : "semantic";
    patches.push(
      withPatchKind(
        {
          op: "setProps",
          at: { blockId },
          props: nextProps,
        },
        kind,
      ),
    );
  }

  const prevChildren = prevNode.children ?? [];
  const nextChildren = nextNode.children ?? [];

  if (prevChildren.length === 0 && nextChildren.length === 0) {
    return;
  }

  if (prevNode.type === "list" && nextNode.type === "list") {
    diffListChildren(blockId, nextNode, prevChildren, nextChildren, patches, metrics);
    return;
  }

  let divergeIndex = 0;
  const minLength = Math.min(prevChildren.length, nextChildren.length);
  while (divergeIndex < minLength && prevChildren[divergeIndex].id === nextChildren[divergeIndex].id) {
    divergeIndex += 1;
  }

  if (canEmitAppendLinesPatch(prevNode, nextNode, divergeIndex)) {
    const appendLines = nextChildren.slice(divergeIndex);
    if (appendLines.length > 0) {
      metrics?.recordAppendLines(appendLines.length);
      patches.push({
        op: "appendLines",
        at: { blockId },
        lines: appendLines,
        startIndex: divergeIndex,
      });
      return;
    }
  }

  for (let i = 0; i < divergeIndex; i += 1) {
    diffNodeSnapshot(prevChildren[i].id, prevChildren[i], nextChildren[i], patches, metrics);
  }

  const removeCount = prevChildren.length - divergeIndex;
  for (let i = removeCount - 1; i >= 0; i -= 1) {
    patches.push({
      op: "deleteChild",
      at: { blockId },
      index: divergeIndex + i,
    });
  }

  for (let i = divergeIndex; i < nextChildren.length; i += 1) {
    patches.push({
      op: "insertChild",
      at: { blockId },
      index: i,
      node: nextChildren[i],
    });
  }
}

function isBlockLike(value: unknown): value is Block {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; type?: unknown; payload?: unknown };
  if (typeof candidate.id !== "string" || typeof candidate.type !== "string") return false;
  return typeof candidate.payload === "object" && candidate.payload !== null;
}

export async function enrichNestedCodeBlocks(
  snapshot: NodeSnapshot,
  allowHighlight: boolean,
  highlighter: SharedHighlighter | null,
  enrichCodeFn: (block: Block) => Promise<void>,
): Promise<void> {
  if (!allowHighlight || !highlighter) {
    return;
  }
  const stack: NodeSnapshot[] = [snapshot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const props = (current.props ?? {}) as Record<string, unknown>;
    const maybeBlock = props.block;
    if (isBlockLike(maybeBlock) && maybeBlock.type === "code") {
      const block = cloneBlock(maybeBlock);
      const hasHighlight = typeof block.payload.highlightedHtml === "string" && block.payload.highlightedHtml.trim().length > 0;
      if (!hasHighlight) {
        await enrichCodeFn(block);
        const updated = createBlockSnapshot(block);
        current.type = updated.type;
        current.props = updated.props;
        current.meta = updated.meta;
        current.range = updated.range;
        current.children = updated.children;
        continue;
      }
    }

    const children = current.children ?? [];
    for (let idx = children.length - 1; idx >= 0; idx -= 1) {
      const child = children[idx];
      if (child) {
        stack.push(child);
      }
    }
  }
}

export async function blockToNodeSnapshot(
  block: Block,
  highlighter: SharedHighlighter | null,
  enrichCodeFn: (block: Block) => Promise<void>,
): Promise<NodeSnapshot> {
  const snapshot = createBlockSnapshot(cloneBlock(block));
  await enrichNestedCodeBlocks(snapshot, Boolean(block.isFinalized), highlighter, enrichCodeFn);
  return snapshot;
}
