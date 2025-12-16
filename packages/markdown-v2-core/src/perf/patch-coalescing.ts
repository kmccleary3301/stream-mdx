import type { CoalescingMetrics, NodePath, NodeSnapshot, Patch, SetPropsBatchEntry } from "../types";
export type { CoalescingMetrics } from "../types";

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

  if (result.length > 1) {
    const dedup: Patch[] = [];
    const seenSetProps = new Set<string>();
    for (let idx = result.length - 1; idx >= 0; idx--) {
      const current = result[idx];
      if (current.op === "setProps") {
        const key = `${current.at.blockId}::$${current.at.nodeId ?? ""}`;
        if (seenSetProps.has(key)) {
          continue;
        }
        seenSetProps.add(key);
      }
      dedup.push(current);
    }
    dedup.reverse();
    result.length = 0;
    result.push(...dedup);
  }

  return [...result, ...rest];
}

function mergeAppendLines(window: Patch[], startIndex: number): { patch: Patch; nextIndex: number } {
  const base = window[startIndex];
  if (!base || base.op !== "appendLines") {
    return { patch: base, nextIndex: startIndex + 1 };
  }

  const lines = [...(base.lines ?? [])];
  const highlight: Array<string | null> = Array.isArray(base.highlight) ? [...base.highlight] : [];
  const baseStart = base.startIndex;
  let expectedStart = baseStart + lines.length;
  let j = startIndex + 1;
  let mergedCount = 0;

  while (j < window.length && mergedCount < APPEND_MERGE_LIMIT) {
    const next = window[j];
    if (
      next.op === "appendLines" &&
      next.at.blockId === base.at.blockId &&
      next.at.nodeId === base.at.nodeId &&
      typeof next.startIndex === "number" &&
      next.startIndex === expectedStart
    ) {
      lines.push(...(next.lines ?? []));
      const nextHighlights = Array.isArray(next.highlight) ? next.highlight : [];
      const appendedCount = next.lines?.length ?? 0;
      if (nextHighlights.length > 0) {
        for (let idx = 0; idx < appendedCount; idx++) {
          const highlightValue = idx < nextHighlights.length ? (nextHighlights[idx] ?? null) : null;
          highlight.push(highlightValue);
        }
      } else {
        for (let idx = 0; idx < appendedCount; idx++) {
          highlight.push(null);
        }
      }
      expectedStart = baseStart + lines.length;
      mergedCount++;
      j++;
      continue;
    }
    break;
  }

  const combined: Patch = {
    ...base,
    lines,
    highlight: highlight.length > 0 ? highlight : undefined,
  };

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
 * Coalesce adjacent patches that target the same parent and can be batched together.
 * This reduces the number of DOM operations and React re-renders.
 *
 * Currently coalesces:
 * - Multiple `appendLines` for the same code block → single `appendLines` with combined lines
 * - Multiple `insertChild` for the same parent at consecutive indices → single batch insert
 * - Multiple `setProps` for the same node → single `setProps` with merged props
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
      // Coalesce multiple appendLines for the same block
      const lines: string[] = [...current.lines];
      const highlights: Array<string | null> = current.highlight ? [...current.highlight] : [];
      let j = i + 1;

      while (j < window.length && coalescedCount < 10) {
        const next = window[j];
        if (
          next.op === "appendLines" &&
          next.at.blockId === current.at.blockId &&
          next.at.nodeId === current.at.nodeId &&
          typeof next.startIndex === "number" &&
          typeof current.startIndex === "number" &&
          next.startIndex === (current.startIndex ?? 0) + lines.length
        ) {
          lines.push(...next.lines);
          if (next.highlight) {
            highlights.push(...next.highlight);
          } else {
            highlights.push(...new Array(next.lines.length).fill(null));
          }
          coalescedCount++;
          j++;
        } else {
          break;
        }
      }

      if (coalescedCount > 0) {
        coalesced.push({
          ...current,
          lines,
          highlight: highlights.length > 0 ? highlights : undefined,
        });
        i = j;
        continue;
      }
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
        });
        k = m;
      }

      if (batchEntries.length > 1) {
        coalesced.push({
          op: "setPropsBatch",
          entries: batchEntries,
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

  // Deduplicate sequential setProps so only the latest per node survives within the window
  if (coalesced.length > 1) {
    const deduped: Patch[] = [];
    const seenSetProps = new Set<string>();
    for (let idx = coalesced.length - 1; idx >= 0; idx--) {
      const patch = coalesced[idx];
      if (patch.op === "setProps") {
        const key = `${patch.at.blockId}::$${patch.at.nodeId ?? ""}`;
        if (seenSetProps.has(key)) {
          continue;
        }
        seenSetProps.add(key);
      }
      deduped.push(patch);
    }
    deduped.reverse();
    coalesced.length = 0;
    coalesced.push(...deduped);
  }

  // Add remaining patches that weren't in the coalescing window
  return [...coalesced, ...rest];
}
