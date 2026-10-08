import type {
  Block,
  DiffKind,
  NodeSnapshot,
  Patch,
  PatchKind,
  TokenLineV1,
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
    if (patch.op === "setProps") {
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
  const prevLength = prevChildren.length;
  const nextLength = nextChildren.length;

  if (prevLength === 0 && nextLength === 0) {
    return;
  }

  const commonLength = Math.min(prevLength, nextLength);

  // Diff shared prefix first to propagate nested updates.
  let prefix = 0;
  while (prefix < commonLength && prevChildren[prefix].id === nextChildren[prefix].id) {
    diffNodeSnapshot(blockId, prevChildren[prefix], nextChildren[prefix], patches, metrics);
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
  while (suffix < commonLength - prefix && prevChildren[prevLength - 1 - suffix].id === nextChildren[nextLength - 1 - suffix].id) {
    const prevIdx = prevLength - 1 - suffix;
    const nextIdx = nextLength - 1 - suffix;
    diffNodeSnapshot(blockId, prevChildren[prevIdx], nextChildren[nextIdx], patches, metrics);
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
    diffNodeSnapshot(blockId, prevMid[midPrefix], nextMid[midPrefix], patches, metrics);
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
      diffNodeSnapshot(blockId, remainingPrevMid[idx], remainingNextMid[idx], patches, metrics);
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
): void {
  const prevProps = prevNode.props ?? {};
  const nextProps = nextNode.props ?? {};
  const propsChanged = !shallowEqual(prevProps, nextProps);

  const emitSetProps = () => {
    if (!propsChanged) return;
    patches.push({
      op: "setProps",
      at: { blockId, nodeId: prevNode.id },
      props: nextProps ?? {},
    });
  };

  const prevChildren = prevNode.children ?? [];
  const nextChildren = nextNode.children ?? [];

  if (prevNode.type === "list" && nextNode.type === "list") {
    emitSetProps();
    diffListChildren(blockId, prevNode, prevChildren, nextChildren, patches, metrics);
    return;
  }

  // Special handling for code blocks: detect pure append and emit appendLines.
  // Defer the code-block setProps until after child mutations so the renderer
  // store does not normalize the code subtree before an appendLines patch lands.
  if (prevNode.type === "code" && nextNode.type === "code") {
    const commonLength = Math.min(prevChildren.length, nextChildren.length);
    let divergeIndex = 0;
    while (divergeIndex < commonLength && prevChildren[divergeIndex].id === nextChildren[divergeIndex].id) {
      diffNodeSnapshot(blockId, prevChildren[divergeIndex], nextChildren[divergeIndex], patches, metrics);
      divergeIndex++;
    }

    const onlyAppend =
      divergeIndex === prevChildren.length &&
      nextChildren.length >= prevChildren.length &&
      prevChildren.every((child, idx) => child.id === nextChildren[idx].id);

    if (onlyAppend && nextChildren.length > prevChildren.length && canEmitAppendLinesPatch(prevNode, nextNode, divergeIndex)) {
      const startIndex = prevChildren.length;
      const appended = nextChildren.slice(startIndex);
      const hasTokenLines = appended.some((child) => Object.prototype.hasOwnProperty.call(child.props ?? {}, "tokens"));
      const hasDiffKind = appended.some((child) => Object.prototype.hasOwnProperty.call(child.props ?? {}, "diffKind"));
      const hasOldNo = appended.some((child) => Object.prototype.hasOwnProperty.call(child.props ?? {}, "oldNo"));
      const hasNewNo = appended.some((child) => Object.prototype.hasOwnProperty.call(child.props ?? {}, "newNo"));
      patches.push({
        op: "appendLines",
        at: { blockId, nodeId: prevNode.id },
        startIndex,
        lines: appended.map((child) => {
          const text = typeof child.props?.text === "string" ? (child.props?.text as string) : "";
          return text;
        }),
        highlight: appended.map((child) => (typeof child.props?.html === "string" ? (child.props?.html as string) : null)),
        ...(hasTokenLines
          ? {
              tokens: appended.map((child) =>
                Object.prototype.hasOwnProperty.call(child.props ?? {}, "tokens") ? (child.props?.tokens as TokenLineV1 | null) : null,
              ),
            }
          : {}),
        ...(hasDiffKind
          ? {
              diffKind: appended.map((child) =>
                Object.prototype.hasOwnProperty.call(child.props ?? {}, "diffKind") ? (child.props?.diffKind as DiffKind | null) : null,
              ),
            }
          : {}),
        ...(hasOldNo
          ? {
              oldNo: appended.map((child) =>
                Object.prototype.hasOwnProperty.call(child.props ?? {}, "oldNo") ? (child.props?.oldNo as number | null) : null,
              ),
            }
          : {}),
        ...(hasNewNo
          ? {
              newNo: appended.map((child) =>
                Object.prototype.hasOwnProperty.call(child.props ?? {}, "newNo") ? (child.props?.newNo as number | null) : null,
              ),
            }
          : {}),
      });
      metrics?.recordAppendLines(appended.length);
      emitSetProps();
      return;
    }

    // Fall through to generic handling for other mutations (edits/deletes)
  } else {
    emitSetProps();
  }

  const minLen = Math.min(prevChildren.length, nextChildren.length);
  let prefix = 0;
  while (prefix < minLen && prevChildren[prefix].id === nextChildren[prefix].id) {
    diffNodeSnapshot(blockId, prevChildren[prefix], nextChildren[prefix], patches, metrics);
    prefix++;
  }

  let suffix = 0;
  while (suffix < minLen - prefix && prevChildren[prevChildren.length - 1 - suffix].id === nextChildren[nextChildren.length - 1 - suffix].id) {
    const prevIdx = prevChildren.length - 1 - suffix;
    const nextIdx = nextChildren.length - 1 - suffix;
    diffNodeSnapshot(blockId, prevChildren[prevIdx], nextChildren[nextIdx], patches, metrics);
    suffix++;
  }

  const prevMid = prevChildren.slice(prefix, prevChildren.length - suffix);
  const nextMid = nextChildren.slice(prefix, nextChildren.length - suffix);

  if (prevMid.length === 0 && nextMid.length === 0) {
    if (prevNode.type === "code" && nextNode.type === "code") {
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
      for (const child of nextMid) {
        const previous = prevMap.get(child.id);
        if (previous) {
          diffNodeSnapshot(blockId, previous, child, patches, metrics);
        }
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

  if (prevNode.type === "code" && nextNode.type === "code") {
    emitSetProps();
  }
}

