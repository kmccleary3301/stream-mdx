import type { CoalescingMetrics, NodePath, NodeSnapshot, Patch, SetPropsBatchEntry } from "../types";
export type { CoalescingMetrics } from "../types";

type AppendLinesPatch = Extract<Patch, { op: "appendLines" }>;

export interface CoalesceConfig {
  enabled: boolean;
  maxCoalesceWindow: number; // Maximum patches to consider for coalescing (for performance)
  coalesceableOps: Set<Patch["op"]>; // Operations that can be coalesced
}

export const DEFAULT_COALESCE_CONFIG: CoalesceConfig = {
  enabled: true,
  maxCoalesceWindow: 50, // Look at up to 50 patches for coalescing opportunities
  coalesceableOps: new Set(["appendLines", "insertChild", "setProps"]),
};

const MAX_BATCHED_SET_PROPS = 24;
const APPEND_MERGE_LIMIT = 10;
const INSERT_MERGE_LIMIT = 20;
const SET_PROPS_MERGE_LIMIT = 10;
const USE_LINEAR_COALESCING = typeof process === "undefined" ? true : process.env.V2_USE_LINEAR_COALESCING !== "false" && process.env.NODE_ENV !== "test";

function cloneNodePath(path: NodePath): NodePath {
  return {
    blockId: path.blockId,
    nodeId: path.nodeId,
    indexPath: path.indexPath ? [...path.indexPath] : undefined,
  };
}

function nodePathKey(path: NodePath): string {
  const nodePart = path.nodeId ?? "";
  const indexPart = path.indexPath && path.indexPath.length > 0 ? `::${path.indexPath.join(".")}` : "";
  return `${path.blockId}::${nodePart}${indexPart}`;
}

// An owned metadata array affects every line in its patch; mixed ownership cannot be merged losslessly.
const APPEND_LINE_METADATA_KEYS = ["tokens", "diffKind", "oldNo", "newNo"] as const;

function hasSameAppendLineMetadataPresence(base: AppendLinesPatch, next: AppendLinesPatch): boolean {
  return APPEND_LINE_METADATA_KEYS.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(base, key) === Object.prototype.hasOwnProperty.call(next, key),
  );
}
function alignAppendLineMetadata<T>(values: ReadonlyArray<T | null>, lineCount: number): Array<T | null> {
  const aligned = new Array<T | null>(lineCount);
  for (let index = 0; index < lineCount; index++) {
    aligned[index] = values[index] ?? null;
  }
  return aligned;
}

function runCoalescer(patches: Patch[], config: CoalesceConfig = DEFAULT_COALESCE_CONFIG): Patch[] {
  if (USE_LINEAR_COALESCING) {
    return coalescePatchesLinear(patches, config);
  }
  return coalescePatchesQuadratic(patches, config);
}

export function coalescePatches(patches: Patch[], config: CoalesceConfig = DEFAULT_COALESCE_CONFIG): Patch[] {
  return runCoalescer(patches, config);
}

export function coalescePatchesWithMetrics(
  patches: Patch[],
  config: CoalesceConfig = DEFAULT_COALESCE_CONFIG,
): { patches: Patch[]; metrics: CoalescingMetrics } {
  const start = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

  const output = runCoalescer(patches, config);
  const durationMs = (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now()) - start;

  const inputCounts = countOps(patches);
  const outputCounts = countOps(output);

  const metrics: CoalescingMetrics = {
    inputPatchCount: patches.length,
    outputPatchCount: output.length,
    coalescedCount: Math.max(0, patches.length - output.length),
    durationMs,
    appendLinesCoalesced: Math.max(0, (inputCounts.appendLines ?? 0) - (outputCounts.appendLines ?? 0)),
    setPropsCoalesced: Math.max(0, (inputCounts.setProps ?? 0) - (outputCounts.setProps ?? 0)),
    insertChildCoalesced: Math.max(0, (inputCounts.insertChild ?? 0) - (outputCounts.insertChild ?? 0)),
  };

  return { patches: output, metrics };
}

export function coalescePatchesLinear(patches: Patch[], config: CoalesceConfig = DEFAULT_COALESCE_CONFIG): Patch[] {
  if (!config.enabled || patches.length === 0) {
    return patches;
  }

  const windowSize = Math.min(patches.length, config.maxCoalesceWindow);
  const window = patches.slice(0, windowSize);
  const rest = patches.slice(windowSize);

  const result: Patch[] = [];

  let i = 0;
  while (i < window.length) {
    const patch = window[i];
    if (!config.coalesceableOps.has(patch.op)) {
      result.push(patch);
      i++;
      continue;
    }

    if (patch.op === "appendLines") {
      const merged = mergeAppendLines(window, i);
      result.push(merged.patch);
      i = merged.nextIndex;
      continue;
    }

    if (patch.op === "insertChild") {
      const merged = collectInsertChildren(window, i);
      result.push(...merged.patches);
      i = merged.nextIndex;
      continue;
    }

    if (patch.op === "setProps") {
      const merged = collectSetProps(window, i);
      result.push(...merged.patches);
      i = merged.nextIndex;
      continue;
    }

    result.push(patch);
    i++;
  }

  return [...result, ...rest];
}

function mergeAppendLines(window: Patch[], startIndex: number): { patch: Patch; nextIndex: number } {
  const base = window[startIndex];
  if (!base || base.op !== "appendLines") {
    return { patch: base, nextIndex: startIndex + 1 };
  }

  const lines = [...(base.lines ?? [])];
  const highlight: Array<string | null> = Array.isArray(base.highlight)
    ? alignAppendLineMetadata(base.highlight, lines.length)
    : [];
  const tokens: Array<unknown> = Array.isArray(base.tokens) ? alignAppendLineMetadata(base.tokens, lines.length) : [];
  const diffKind: Array<unknown> = Array.isArray(base.diffKind) ? alignAppendLineMetadata(base.diffKind, lines.length) : [];
  const oldNo: Array<unknown> = Array.isArray(base.oldNo) ? alignAppendLineMetadata(base.oldNo, lines.length) : [];
  const newNo: Array<unknown> = Array.isArray(base.newNo) ? alignAppendLineMetadata(base.newNo, lines.length) : [];
  let includeTokens = Array.isArray(base.tokens);
  let includeDiffKind = Array.isArray(base.diffKind);
  let includeOldNo = Array.isArray(base.oldNo);
  let includeNewNo = Array.isArray(base.newNo);
  const baseStart = base.startIndex;
  let expectedStart = baseStart + lines.length;
  let j = startIndex + 1;
  let mergedCount = 0;

  while (j < window.length && mergedCount < APPEND_MERGE_LIMIT) {
    const next = window[j];
    if (
      next.op === "appendLines" &&
      hasSameAppendLineMetadataPresence(base, next) &&
      next.at.blockId === base.at.blockId &&
      next.at.nodeId === base.at.nodeId &&
      typeof next.startIndex === "number" &&
      next.startIndex === expectedStart
    ) {
      const priorLineCount = lines.length;
      lines.push(...(next.lines ?? []));
      const nextHighlights = Array.isArray(next.highlight) ? next.highlight : [];
      const appendedCount = next.lines?.length ?? 0;
      while (highlight.length < priorLineCount) {
        highlight.push(null);
      }
      for (let idx = 0; idx < appendedCount; idx++) {
        highlight.push(idx < nextHighlights.length ? (nextHighlights[idx] ?? null) : null);
      }
      if (Array.isArray(next.tokens)) {
        if (!includeTokens) {
          tokens.push(...new Array(priorLineCount).fill(null));
          includeTokens = true;
        }
        for (let idx = 0; idx < appendedCount; idx++) {
          tokens.push(idx < next.tokens.length ? (next.tokens[idx] ?? null) : null);
        }
      } else if (includeTokens) {
        tokens.push(...new Array(appendedCount).fill(null));
      }
      if (Array.isArray(next.diffKind)) {
        if (!includeDiffKind) {
          diffKind.push(...new Array(priorLineCount).fill(null));
          includeDiffKind = true;
        }
        for (let idx = 0; idx < appendedCount; idx++) {
          diffKind.push(idx < next.diffKind.length ? (next.diffKind[idx] ?? null) : null);
        }
      } else if (includeDiffKind) {
        diffKind.push(...new Array(appendedCount).fill(null));
      }
      if (Array.isArray(next.oldNo)) {
        if (!includeOldNo) {
          oldNo.push(...new Array(priorLineCount).fill(null));
          includeOldNo = true;
        }
        for (let idx = 0; idx < appendedCount; idx++) {
          oldNo.push(idx < next.oldNo.length ? (next.oldNo[idx] ?? null) : null);
        }
      } else if (includeOldNo) {
        oldNo.push(...new Array(appendedCount).fill(null));
      }
      if (Array.isArray(next.newNo)) {
        if (!includeNewNo) {
          newNo.push(...new Array(priorLineCount).fill(null));
          includeNewNo = true;
        }
        for (let idx = 0; idx < appendedCount; idx++) {
          newNo.push(idx < next.newNo.length ? (next.newNo[idx] ?? null) : null);
        }
      } else if (includeNewNo) {
        newNo.push(...new Array(appendedCount).fill(null));
      }
      expectedStart = baseStart + lines.length;
      mergedCount++;
      j++;
      continue;
    }
    break;
  }

  const combined: AppendLinesPatch = {
    ...base,
    lines,
    highlight: highlight.length > 0 ? highlight : undefined,
  };
  // Preserve absent keys: the renderer treats an owned `tokens` field as explicit null per line.
  if (includeTokens && tokens.length > 0) combined.tokens = tokens as AppendLinesPatch["tokens"];
  if (includeDiffKind && diffKind.length > 0) combined.diffKind = diffKind as AppendLinesPatch["diffKind"];
  if (includeOldNo && oldNo.length > 0) combined.oldNo = oldNo as AppendLinesPatch["oldNo"];
  if (includeNewNo && newNo.length > 0) combined.newNo = newNo as AppendLinesPatch["newNo"];

  return { patch: combined, nextIndex: j };
}

function collectInsertChildren(window: Patch[], startIndex: number): { patches: Patch[]; nextIndex: number } {
  const base = window[startIndex];
  if (!base || base.op !== "insertChild") {
    return { patches: [base], nextIndex: startIndex + 1 };
  }
  const inserts: Array<{ index: number; node: NodeSnapshot }> = [];
  if (typeof base.index === "number") {
    inserts.push({ index: base.index, node: base.node });
  }
  let j = startIndex + 1;
  let mergedCount = 0;

  while (j < window.length && mergedCount < INSERT_MERGE_LIMIT) {
    const next = window[j];
    if (
      next.op === "insertChild" &&
      next.at.blockId === base.at.blockId &&
      next.at.nodeId === base.at.nodeId &&
      typeof next.index === "number" &&
      typeof base.index === "number" &&
      next.index === (base.index ?? 0) + inserts.length
    ) {
      inserts.push({ index: next.index, node: next.node });
      mergedCount++;
      j++;
      continue;
    }
    break;
  }

  if (inserts.length <= 1) {
    return { patches: [base], nextIndex: j };
  }

  const clones = inserts.map((entry) => ({
    ...base,
    index: entry.index,
    node: entry.node,
  })) as Patch[];

  return { patches: clones, nextIndex: j };
}

function collectSetProps(window: Patch[], startIndex: number): { patches: Patch[]; nextIndex: number } {
  const first = window[startIndex];
  if (!first || first.op !== "setProps") {
    return { patches: [first], nextIndex: startIndex + 1 };
  }
  const entries: SetPropsBatchEntry[] = [];
  let j = startIndex;

  while (j < window.length && entries.length < MAX_BATCHED_SET_PROPS) {
    const current = window[j];
    if (current.op !== "setProps") {
      break;
    }
    const mergedProps = { ...(current.props ?? {}) };
    let k = j + 1;
    let mergedCount = 0;

    while (k < window.length && mergedCount < SET_PROPS_MERGE_LIMIT) {
      const next = window[k];
      if (next.op === "setProps" && nodePathKey(next.at) === nodePathKey(current.at)) {
        Object.assign(mergedProps, next.props ?? {});
        mergedCount++;
        k++;
      } else {
        break;
      }
    }

    entries.push({
      at: cloneNodePath(current.at),
      props: mergedProps,
      meta: current.meta ? { ...current.meta } : undefined,
    });

    j = k;
  }

  if (entries.length === 0) {
    return { patches: [window[startIndex]], nextIndex: startIndex + 1 };
  }

  if (entries.length === 1) {
    const single = entries[0];
    const patch: Patch = {
      ...(first as Patch),
      op: "setProps",
      props: single.props,
    } as Patch;
    return { patches: [patch], nextIndex: j };
  }

  const batchPatch: Patch = {
    op: "setPropsBatch",
    entries,
    meta: first.meta ? { ...first.meta } : undefined,
  } as Patch;

  return { patches: [batchPatch], nextIndex: j };
}

function countOps(patches: Patch[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const patch of patches) {
    counts[patch.op] = (counts[patch.op] ?? 0) + 1;
  }
  return counts;
}

/**
 * Coalesce adjacent compatible patches without moving operations across barriers.
 *
 * Currently coalesces:
 * - Consecutive `appendLines` for the same code block into one patch with combined lines
 * - Consecutive `insertChild` operations for the same parent at consecutive indices, while preserving
 *   individual inserts because the patch protocol has no batch-insert operation
 * - Consecutive `setProps` operations for the same node into one merged update or `setPropsBatch`
 */
export function coalescePatchesQuadratic(patches: Patch[], config: CoalesceConfig = DEFAULT_COALESCE_CONFIG): Patch[] {
  if (!config.enabled || patches.length === 0) {
    return patches;
  }

  // Limit the window for performance (coalescing is O(n²) worst case)
  const windowSize = Math.min(patches.length, config.maxCoalesceWindow);
  const window = patches.slice(0, windowSize);
  const rest = patches.slice(windowSize);

  const coalesced: Patch[] = [];
  let i = 0;

  while (i < window.length) {
    const current = window[i];
    if (!config.coalesceableOps.has(current.op)) {
      coalesced.push(current);
      i++;
      continue;
    }

    // Try to coalesce current patch with following patches
    let coalescedCount = 0;

    if (current.op === "appendLines") {
      const merged = mergeAppendLines(window, i);
      if (merged.nextIndex > i + 1) {
        coalesced.push(merged.patch);
        i = merged.nextIndex;
      } else {
        coalesced.push(current);
        i++;
      }
      continue;
    } else if (current.op === "insertChild") {
      // Coalesce multiple insertChild for the same parent at consecutive indices
      const inserts: Array<{ index: number; node: typeof current.node }> = [{ index: current.index, node: current.node }];
      let j = i + 1;
      let lastIndex = current.index;

      while (j < window.length && coalescedCount < 20) {
        const next = window[j];
        if (next.op === "insertChild" && next.at.blockId === current.at.blockId && next.at.nodeId === current.at.nodeId && next.index === lastIndex + 1) {
          inserts.push({ index: next.index, node: next.node });
          lastIndex = next.index;
          coalescedCount++;
          j++;
        } else {
          break;
        }
      }

      // For now, keep individual inserts (batching would require a new patch op)
      // Future: could add `insertChildren` batch op
      if (coalescedCount === 0) {
        coalesced.push(current);
        i++;
        continue;
      }
      // Add all inserts individually for now (coalescing helped us skip some processing)
      coalesced.push(...inserts.map((ins) => ({ ...current, index: ins.index, node: ins.node })));
      i = j;
      continue;
    } else if (current.op === "setProps") {
      // Coalesce multiple setProps for the same node
      const mergedProps = { ...(current.props ?? {}) };
      let j = i + 1;

      while (j < window.length && coalescedCount < 10) {
        const next = window[j];
        if (next.op === "setProps" && next.at.blockId === current.at.blockId && next.at.nodeId === current.at.nodeId) {
          Object.assign(mergedProps, next.props ?? {});
          coalescedCount++;
          j++;
        } else {
          break;
        }
      }

      const batchEntries = [
        {
          at: cloneNodePath(current.at),
          props: mergedProps,
          meta: current.meta ? { ...current.meta } : undefined,
        },
      ];

      let k = j;
      while (k < window.length && batchEntries.length < MAX_BATCHED_SET_PROPS) {
        const candidate = window[k];
        if (candidate.op !== "setProps") {
          break;
        }

        const candidateMergedProps = { ...(candidate.props ?? {}) };
        let m = k + 1;
        let localMerged = 0;

        while (m < window.length && localMerged < 10) {
          const follow = window[m];
          if (follow.op === "setProps" && nodePathKey(follow.at) === nodePathKey(candidate.at)) {
            Object.assign(candidateMergedProps, follow.props ?? {});
            m++;
            localMerged++;
          } else {
            break;
          }
        }

        batchEntries.push({
          at: cloneNodePath(candidate.at),
          props: candidateMergedProps,
          meta: candidate.meta ? { ...candidate.meta } : undefined,
        });
        k = m;
      }

      if (batchEntries.length > 1) {
        coalesced.push({
          op: "setPropsBatch",
          entries: batchEntries,
          meta: current.meta ? { ...current.meta } : undefined,
        } as Patch);
        i = k;
        continue;
      }

      if (coalescedCount > 0) {
        coalesced.push({
          ...current,
          props: mergedProps,
        });
        i = j;
        continue;
      }

      coalesced.push({
        ...current,
        props: mergedProps,
      });
      i++;
      continue;
    }

    // No coalescing found, add current patch
    coalesced.push(current);
    i++;
  }

  // Add remaining patches that weren't in the coalescing window
  return [...coalesced, ...rest];
}
