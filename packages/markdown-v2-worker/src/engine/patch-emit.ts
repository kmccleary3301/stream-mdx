declare const __STREAM_MDX_COUNTERS__: boolean;

import type {
  NodeSnapshot,
  Patch,
  PatchKind,
} from "@stream-mdx/core";
import {
  PATCH_ROOT_ID,
  computeHeavyPatchBudget,
} from "@stream-mdx/core";
import { getPatchKind, isHeavyPatch } from "@stream-mdx/core/perf/patch-batching";
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
  const candidate = patch.op === "setHTML" ? patch.patchMeta : patch.meta;
  if (!candidate || (candidate.kind !== "semantic" && candidate.kind !== "enrichment")) return null;
  return {
    kind: candidate.kind,
    streamSeq: candidate.streamSeq,
    parseEpoch: candidate.parseEpoch,
  };
}

export function targetBlockIdsForPatch(patch: Patch): string[] {
  if (patch.op === "setPropsBatch") {
    const ids = new Set<string>();
    for (const entry of patch.entries ?? []) {
      if (entry?.at?.blockId && entry.at.blockId !== PATCH_ROOT_ID) {
        ids.add(entry.at.blockId);
      }
    }
    return Array.from(ids);
  }

  const ids = new Set<string>();
  if (patch.at?.blockId && patch.at.blockId !== PATCH_ROOT_ID) {
    ids.add(patch.at.blockId);
  }
  if ((patch.op === "insertChild" || patch.op === "replaceChild") && patch.at?.blockId === PATCH_ROOT_ID && patch.node?.id) {
    ids.add(patch.node.id);
  }
  return Array.from(ids);
}

export function withPatchControlMeta(
  patch: Patch,
  meta: {
    kind: PatchKind;
    streamSeq?: number;
    parseEpoch?: number;
    tx?: number;
    blockEpoch?: number;
  },
): Patch {
  if (patch.op === "setHTML") {
    return {
      ...patch,
      patchMeta: {
        ...(patch.patchMeta ?? {}),
        ...meta,
      },
    };
  }
  return {
    ...patch,
    meta: {
      ...(patch.meta ?? {}),
      ...meta,
    },
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
      ...(patch.meta || {}),
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
  emittedBlockEpochs?: Map<string, number>,
): Patch[] {
  streamSeqCounter.value += 1;
  const streamSeq = streamSeqCounter.value;
  return patches.map((patch) => {
    const kind = getPatchKind(patch);
    const blockIds = targetBlockIdsForPatch(patch);
    const expectedBlockEpoch = blockIds.length === 1 && emittedBlockEpochs ? emittedBlockEpochs.get(blockIds[0]) : undefined;
    return withPatchControlMeta(patch, {
      kind,
      streamSeq,
      parseEpoch,
      tx,
      ...(expectedBlockEpoch !== undefined ? { blockEpoch: expectedBlockEpoch } : {}),
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
  emittedBlockEpochs?: Map<string, number>,
): { patches: Patch[]; parseEpoch: number } {
  const effectiveEpoch = parseEpoch ?? (parseEpochCounter.value += 1);
  return {
    patches: annotatePatchBatch(patches, tx, effectiveEpoch, streamSeqCounter, emittedBlockEpochs),
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
  const seen = new Set<string>();
  const dedupedReversed: Patch[] = [];
  for (let i = patches.length - 1; i >= 0; i--) {
    const patch = patches[i];
    if (patch.op === "appendInputSource") {
      seen.clear();
    } else if (patch.op === "setProps") {
      const target = patch.at.nodeId ?? patch.at.blockId;
      const key = `${patch.at.blockId}::${target}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    dedupedReversed.push(patch);
  }
  dedupedReversed.reverse();
  return dedupedReversed;
}
export function partitionPatchesForCredits(
  patches: Patch[],
  workerCredits: number,
  deferredPatchQueue: Patch[],
  maxImmediate?: number,
  options?: {
    ignoreCredits?: boolean;
    maxDeferred?: number;
  },
): Patch[] {
  const maxDeferred = options?.maxDeferred ?? 400;
  let combined: Patch[] = patches;
  if (deferredPatchQueue.length > 0) {
    combined = deferredPatchQueue.concat(patches);
    deferredPatchQueue.length = 0;
  }
  combined = dedupeSetPropsByTargetKeepingLatest(combined);
  if (combined.length === 0) {
    return [];
  }

  let immediate: Patch[] = [];
  const deferred: Patch[] = [];

  const bypassCreditBudget = options?.ignoreCredits || workerCredits >= 0.999;
  let heavyBudget = computeHeavyPatchBudget(workerCredits);

  for (const patch of combined) {
    const kind = getPatchKind(patch);
    const heavy = isHeavyPatch(patch);
    const priorityImmediate = isPriorityImmediatePatch(patch);
    if (heavy && kind !== "semantic" && !bypassCreditBudget && !priorityImmediate) {
      if (heavyBudget <= 0) {
        if (deferred.length < maxDeferred) {
          deferred.push(patch);
          continue;
        }
      } else {
        heavyBudget -= 1;
      }
    }

    immediate.push(patch);
  }

  if (typeof maxImmediate === "number" && immediate.length > maxImmediate) {
    const requiredCount = immediate.reduce(
      (count, patch) => count + (isPriorityImmediatePatch(patch) || getPatchKind(patch) === "semantic" ? 1 : 0),
      0,
    );
    const maxDeferrable = Math.max(0, maxImmediate - requiredCount);
    const kept: Patch[] = [];
    const overflow: Patch[] = [];
    let deferrableKept = 0;
    for (const patch of immediate) {
      if (isPriorityImmediatePatch(patch) || getPatchKind(patch) === "semantic") {
        kept.push(patch);
        continue;
      }
      if (deferrableKept < maxDeferrable) {
        kept.push(patch);
        deferrableKept += 1;
      } else {
        overflow.push(patch);
      }
    }
    immediate = kept;
    deferredPatchQueue.push(...overflow.concat(deferred));
  } else {
    deferredPatchQueue.push(...deferred);
  }
  return immediate;
}
export function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const valA = a[key];
    const valB = b[key];
    if (typeof valA === "object" || typeof valB === "object") {
      if (JSON.stringify(valA) !== JSON.stringify(valB)) return false;
    } else if (valA !== valB) {
      return false;
    }
  }
  return true;
}
// Owner records carry their own source updates, as do the code and table families, which consumers refuse
// generic range/meta updates for. A bare paragraph has no owner channel, so its range and metadata travel in setProps.
function isManagedSourceSnapshot(node: NodeSnapshot): boolean {
  return Boolean(node.code || node.table || node.paragraph) ||
    node.type === "code" ||
    node.type === "table" ||
    node.type.startsWith("code-") ||
    node.type.startsWith("table-") ||
    node.type.startsWith("paragraph-");
}

// A child that gains, loses, or changes its source owner record cannot be patched in place: the consumer
// keys owner state to the record, so the node must be replaced.
function sourceOwnershipChanged(prev: NodeSnapshot, next: NodeSnapshot): boolean {
  return Boolean(prev.code) !== Boolean(next.code) ||
    Boolean(prev.table) !== Boolean(next.table) ||
    prev.paragraph?.paragraphOwnerId !== next.paragraph?.paragraphOwnerId ||
    Boolean(prev.paragraph) !== Boolean(next.paragraph);
}

function diffOrReplaceChild(
  blockId: string,
  parent: NodeSnapshot,
  index: number,
  prevChild: NodeSnapshot,
  nextChild: NodeSnapshot,
  patches: Patch[],
  metrics: WorkerMetricsCollector | null | undefined,
  managedSourceOwner: boolean,
  counters?: { recordPrefixComparisons?(count?: number, stage?: string): void },
): void {
  if (sourceOwnershipChanged(prevChild, nextChild)) {
    patches.push({ op: "replaceChild", at: { blockId, nodeId: parent.id }, index, node: nextChild });
    return;
  }
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    diffNodeSnapshotWithOwner(blockId, prevChild, nextChild, patches, metrics, managedSourceOwner, counters);
  } else {
    diffNodeSnapshotWithOwner(blockId, prevChild, nextChild, patches, metrics, managedSourceOwner);
  }
}

function canonicalSnapshotMeta(node: NodeSnapshot): Record<string, unknown> | undefined {
  const meta = node.meta;
  const nativeContainer = node.type === "list" || node.type === "blockquote" || node.type === "list-item";
  if (!meta || !nativeContainer || !Object.prototype.hasOwnProperty.call(meta, "preparedNested")) {
    return meta;
  }
  const { preparedNested: _preparedNested, ...canonicalMeta } = meta;
  return canonicalMeta;
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


export function diffListChildren(
  blockId: string,
  listNode: NodeSnapshot,
  prevChildren: NodeSnapshot[],
  nextChildren: NodeSnapshot[],
  patches: Patch[],
  metrics?: WorkerMetricsCollector | null,
  counters?: { recordPrefixComparisons?(count?: number, stage?: string): void },
): void {
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    diffListChildrenWithOwner(blockId, listNode, prevChildren, nextChildren, patches, metrics, false, counters);
  } else {
    diffListChildrenWithOwner(blockId, listNode, prevChildren, nextChildren, patches, metrics, false);
  }
}

function diffListChildrenWithOwner(
  blockId: string,
  listNode: NodeSnapshot,
  prevChildren: NodeSnapshot[],
  nextChildren: NodeSnapshot[],
  patches: Patch[],
  metrics: WorkerMetricsCollector | null | undefined,
  managedSourceOwner: boolean,
  counters?: { recordPrefixComparisons?(count?: number, stage?: string): void },
): void {
  const prevLength = prevChildren.length;
  const nextLength = nextChildren.length;

  if (prevLength === 0 && nextLength === 0) {
    return;
  }

  const commonLength = Math.min(prevLength, nextLength);

  // Diff shared prefix first to propagate nested updates.
  let prefix = 0;
  while (prefix < commonLength) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "patch");
    }
    if (prevChildren[prefix].id !== nextChildren[prefix].id) break;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      diffNodeSnapshotWithOwner(blockId, prevChildren[prefix], nextChildren[prefix], patches, metrics, managedSourceOwner, counters);
    } else {
      diffNodeSnapshotWithOwner(blockId, prevChildren[prefix], nextChildren[prefix], patches, metrics, managedSourceOwner);
    }
    prefix++;
  }

  if (prefix === prevLength && prefix === nextLength) {
    return;
  }

  // Pure append: existing prefix matches and prev length exhausted.
  if (prefix === prevLength && nextLength > prevLength) {
    for (let i = prefix; i < nextLength; i++) {
      patches.push({
        op: "insertChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
        node: nextChildren[i],
      });
    }
    return;
  }

  // Pure truncate from tail.
  if (prefix === nextLength && prevLength > nextLength) {
    for (let i = prevLength - 1; i >= nextLength; i--) {
      patches.push({
        op: "deleteChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
      });
    }
    return;
  }

  // Compute suffix after trimming already handled prefix.
  let suffix = 0;
  while (suffix < commonLength - prefix) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "patch");
    }
    const prevIdx = prevLength - 1 - suffix;
    const nextIdx = nextLength - 1 - suffix;
    if (prevChildren[prevIdx].id !== nextChildren[nextIdx].id) break;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      diffNodeSnapshotWithOwner(blockId, prevChildren[prevIdx], nextChildren[nextIdx], patches, metrics, managedSourceOwner, counters);
    } else {
      diffNodeSnapshotWithOwner(blockId, prevChildren[prevIdx], nextChildren[nextIdx], patches, metrics, managedSourceOwner);
    }
    suffix++;
  }

  const prevMidStart = prefix;
  const prevMidEnd = prevLength - suffix;
  const nextMidStart = prefix;
  const nextMidEnd = nextLength - suffix;

  const prevMidLen = Math.max(0, prevMidEnd - prevMidStart);
  const nextMidLen = Math.max(0, nextMidEnd - nextMidStart);

  if (prevMidLen === 0 && nextMidLen === 0) {
    return;
  }

  if (prevMidLen === 0 && nextMidLen > 0) {
    for (let i = nextMidStart; i < nextMidEnd; i++) {
      patches.push({
        op: "insertChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
        node: nextChildren[i],
      });
    }
    return;
  }

  if (prevMidLen > 0 && nextMidLen === 0) {
    for (let i = prevMidEnd - 1; i >= prevMidStart; i--) {
      patches.push({
        op: "deleteChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
      });
    }
    return;
  }

  // When both sides have mid-ranges, fall back to generic handling to account for true reorders/edits.
  const prevMid = prevChildren.slice(prevMidStart, prevMidEnd);
  const nextMid = nextChildren.slice(nextMidStart, nextMidEnd);

  const sharedMid = Math.min(prevMid.length, nextMid.length);
  let midPrefix = 0;
  while (midPrefix < sharedMid && prevMid[midPrefix].id === nextMid[midPrefix].id) {
    diffNodeSnapshotWithOwner(blockId, prevMid[midPrefix], nextMid[midPrefix], patches, metrics, managedSourceOwner);
    midPrefix++;
  }

  if (midPrefix === prevMid.length && midPrefix === nextMid.length) {
    return;
  }

  if (midPrefix === prevMid.length && nextMid.length > prevMid.length) {
    for (let i = nextMidStart + midPrefix; i < nextMidEnd; i++) {
      patches.push({
        op: "insertChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
        node: nextChildren[i],
      });
    }
    return;
  }

  if (midPrefix === nextMid.length && prevMid.length > nextMid.length) {
    for (let i = prevMidEnd - 1; i >= prevMidStart + midPrefix; i--) {
      patches.push({
        op: "deleteChild",
        at: { blockId, nodeId: listNode.id },
        index: i,
      });
    }
    return;
  }

  const remainingPrevMid = prevMid.slice(midPrefix);
  const remainingNextMid = nextMid.slice(midPrefix);

  if (remainingPrevMid.length === remainingNextMid.length && remainingPrevMid.every((child, idx) => child.id === remainingNextMid[idx].id)) {
    for (let idx = 0; idx < remainingPrevMid.length; idx++) {
      diffNodeSnapshotWithOwner(blockId, remainingPrevMid[idx], remainingNextMid[idx], patches, metrics, managedSourceOwner);
    }
    return;
  }

  // Otherwise leverage delete/insert to reflect structural moves without reorder.
  for (let i = prevMidEnd - 1; i >= prevMidStart + midPrefix; i--) {
    patches.push({
      op: "deleteChild",
      at: { blockId, nodeId: listNode.id },
      index: i,
    });
  }

  for (let i = nextMidStart + midPrefix; i < nextMidEnd; i++) {
    patches.push({
      op: "insertChild",
      at: { blockId, nodeId: listNode.id },
      index: i,
      node: nextChildren[i],
    });
  }
}

export function diffNodeSnapshot(
  blockId: string,
  prevNode: NodeSnapshot,
  nextNode: NodeSnapshot,
  patches: Patch[],
  metrics?: WorkerMetricsCollector | null,
  counters?: { recordPrefixComparisons?(count?: number, stage?: string): void },
): void {
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    diffNodeSnapshotWithOwner(blockId, prevNode, nextNode, patches, metrics, false, counters);
  } else {
    diffNodeSnapshotWithOwner(blockId, prevNode, nextNode, patches, metrics, false);
  }
}

function diffNodeSnapshotWithOwner(
  blockId: string,
  prevNode: NodeSnapshot,
  nextNode: NodeSnapshot,
  patches: Patch[],
  metrics: WorkerMetricsCollector | null | undefined,
  inheritedManagedSourceOwner: boolean,
  counters?: { recordPrefixComparisons?(count?: number, stage?: string): void },
): void {
  const managedSourceOwner = inheritedManagedSourceOwner || isManagedSourceSnapshot(prevNode) || isManagedSourceSnapshot(nextNode);
  const prevProps = prevNode.props ?? {};
  const nextProps = nextNode.props ?? {};
  const propsChanged = !shallowEqual(prevProps, nextProps);
  const prevMeta = managedSourceOwner ? undefined : canonicalSnapshotMeta(prevNode);
  const nextMeta = managedSourceOwner ? undefined : canonicalSnapshotMeta(nextNode);
  const metadataChanged = !managedSourceOwner &&
    ((prevMeta === undefined) !== (nextMeta === undefined) ||
      (prevMeta !== undefined && nextMeta !== undefined && !shallowEqual(prevMeta, nextMeta)));
  const rangeChanged = !managedSourceOwner && nextNode.range !== undefined &&
    (prevNode.range?.from !== nextNode.range.from || prevNode.range?.to !== nextNode.range.to);

  const emitSetProps = () => {
    if (!propsChanged && (managedSourceOwner || (!metadataChanged && !rangeChanged))) return;
    const patchProps: Record<string, unknown> = propsChanged ? { ...nextProps } : {};
    if (managedSourceOwner) {
      delete patchProps.meta;
      delete patchProps.range;
    } else {
      if (nextNode.range) patchProps.range = { ...nextNode.range };
      patchProps.meta = nextMeta ?? null;
    }
    patches.push({
      op: "setProps",
      at: { blockId, nodeId: prevNode.id },
      props: patchProps,
    });
  };

  const prevChildren = prevNode.children ?? [];
  const nextChildren = nextNode.children ?? [];

  if (prevNode.type === "list" && nextNode.type === "list") {
    emitSetProps();
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      diffListChildrenWithOwner(blockId, prevNode, prevChildren, nextChildren, patches, metrics, managedSourceOwner, counters);
    } else {
      diffListChildrenWithOwner(blockId, prevNode, prevChildren, nextChildren, patches, metrics, managedSourceOwner);
    }
    return;
  }


  // Code snapshots use generic child operations; apply container props after
  // their line structure is updated.
  const isCodeNode = prevNode.type === "code" && nextNode.type === "code";
  if (!isCodeNode) {
    emitSetProps();
  }

  const minLen = Math.min(prevChildren.length, nextChildren.length);
  let prefix = 0;
  while (prefix < minLen) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "patch");
    }
    if (prevChildren[prefix].id !== nextChildren[prefix].id) break;
    diffOrReplaceChild(blockId, prevNode, prefix, prevChildren[prefix], nextChildren[prefix], patches, metrics, managedSourceOwner, counters);
    prefix++;
  }

  let suffix = 0;
  while (suffix < minLen - prefix) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "patch");
    }
    const prevIdx = prevChildren.length - 1 - suffix;
    const nextIdx = nextChildren.length - 1 - suffix;
    if (prevChildren[prevIdx].id !== nextChildren[nextIdx].id) break;
    diffOrReplaceChild(blockId, prevNode, prevIdx, prevChildren[prevIdx], nextChildren[nextIdx], patches, metrics, managedSourceOwner, counters);
    suffix++;
  }

  const prevMid = prevChildren.slice(prefix, prevChildren.length - suffix);
  const nextMid = nextChildren.slice(prefix, nextChildren.length - suffix);

  if (prevMid.length === 0 && nextMid.length === 0) {
    if (isCodeNode) {
      emitSetProps();
    }
    return;
  }

  if (prevMid.length === nextMid.length && prevMid.length > 0) {
    const prevIds = prevMid.map((child) => child.id);
    const nextIds = nextMid.map((child) => child.id);
    if (haveSameMultiset(prevIds, nextIds)) {
      const currentOrder = prevIds.slice();
      const reorderOps: Array<{ from: number; to: number }> = [];
      for (let targetIdx = 0; targetIdx < nextIds.length; targetIdx++) {
        const desiredId = nextIds[targetIdx];
        if (currentOrder[targetIdx] === desiredId) {
          continue;
        }
        const sourceIdx = currentOrder.indexOf(desiredId);
        if (sourceIdx === -1) continue;
        reorderOps.push({
          from: prefix + sourceIdx,
          to: prefix + targetIdx,
        });
        const [moved] = currentOrder.splice(sourceIdx, 1);
        currentOrder.splice(targetIdx, 0, moved);
      }

      for (const op of reorderOps) {
        patches.push({
          op: "reorder",
          at: { blockId, nodeId: prevNode.id },
          from: op.from,
          to: op.to,
          count: 1,
        });
      }

      const prevMap = new Map(prevMid.map((child) => [child.id, child]));
      for (let index = 0; index < nextMid.length; index++) {
        const child = nextMid[index];
        const previous = prevMap.get(child.id);
        if (previous) {
          diffOrReplaceChild(blockId, prevNode, prefix + index, previous, child, patches, metrics, managedSourceOwner, counters);
        }
      }
      if (isCodeNode) {
        emitSetProps();
      }
      return;
    }
  }

  for (let i = prevChildren.length - 1 - suffix; i >= prefix; i--) {
    patches.push({
      op: "deleteChild",
      at: { blockId, nodeId: prevNode.id },
      index: i,
    });
  }

  for (let i = prefix; i < nextChildren.length - suffix; i++) {
    patches.push({
      op: "insertChild",
      at: { blockId, nodeId: prevNode.id },
      index: i,
      node: nextChildren[i],
    });
  }

  if (isCodeNode) {
    emitSetProps();
  }
}

