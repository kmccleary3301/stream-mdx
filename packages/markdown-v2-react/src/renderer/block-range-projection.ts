import React from "react";

declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

export interface BlockRangeProjectionCounterSink {
  recordBlockRangeProjectionVisits?(
    family: "code" | "table",
    branchVisits: number,
    descriptorVisits: number,
  ): void;
}

export interface BlockRangeProjectionViewCounterSink {
  recordStoreRecordsTouched?(count: number, stage: "view"): void;
  recordRecordSlotsAllocated?(count: number, stage: "view"): void;
}

export interface BlockRangeProjectionRange {
  readonly chunkStart: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly visibleStart: number;
  readonly visibleEnd: number;
}

export interface BlockRangeProjectionTreeProps {
  readonly node: BlockRangeProjectionNode;
  readonly nodeStart: number;
  readonly rangeSize: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly visibleStart: number;
  readonly visibleEnd: number;
  readonly renderRange: (range: BlockRangeProjectionRange) => React.ReactNode;
  readonly fullContent?: boolean;
  readonly counterFamily?: "code" | "table";
  readonly counters?: BlockRangeProjectionCounterSink;
  readonly viewCounters?: BlockRangeProjectionViewCounterSink;
}

export interface BlockRangeProjectionLeaf {
  readonly kind: "leaf";
  readonly level: 0;
  readonly rangeCount: number;
  readonly starts: readonly number[];
}

export interface BlockRangeProjectionBranch {
  readonly kind: "branch";
  /** -1 identifies the permanent root anchor; its children may have different levels. */
  readonly level: number;
  readonly rangeCount: number;
  readonly children: readonly BlockRangeProjectionNode[];
}

export type BlockRangeProjectionNode = BlockRangeProjectionLeaf | BlockRangeProjectionBranch;

export interface BlockRangeProjection {
  readonly rangeCount: number;
  readonly rangeSize: number;
  readonly root: BlockRangeProjectionBranch;
}

const PREFIX_PROJECTION_FANOUT = 32;

export interface AnchoredPrefixChildPlan {
  readonly level: number;
  readonly firstIndex: number;
  readonly count: number;
}

/** Capacity of a completed subtree whose leaves contain up to 32 items. */
export function prefixProjectionCapacity(level: number): number {
  return PREFIX_PROJECTION_FANOUT ** (level + 1);
}

/** Partition a prefix into full left subtrees followed by one right-spine subtree. */
export function createAnchoredPrefixPlan(itemCount: number): AnchoredPrefixChildPlan[] {
  const plan: AnchoredPrefixChildPlan[] = [];
  let remaining = Math.max(0, itemCount);
  let firstIndex = 0;
  let level = 0;
  while (remaining > 0) {
    const count = Math.min(prefixProjectionCapacity(level), remaining);
    plan.push({ level, firstIndex, count });
    remaining -= count;
    firstIndex += count;
    level += 1;
  }
  return plan;
}

/** Append one item under an anchor without reparenting any published child. */
export function appendAnchoredPrefixChild<T extends { readonly level: number }>(
  children: readonly T[],
  nextIndex: number,
  getCount: (node: T) => number,
  createPath: (level: number, index: number) => T,
  appendRightmost: (node: T, index: number) => T,
): T[] {
  const next = children.slice();
  const lastIndex = next.length - 1;
  const last = next[lastIndex];
  if (!last) {
    next.push(createPath(0, nextIndex));
  } else if (getCount(last) >= prefixProjectionCapacity(last.level)) {
    next.push(createPath(last.level + 1, nextIndex));
  } else {
    next[lastIndex] = appendRightmost(last, nextIndex);
  }
  return next;
}

/** Preserve complete prefix children by identity and truncate only the active tail. */
export function truncateAnchoredPrefixChildren<T>(
  children: readonly T[],
  keepCount: number,
  getCount: (node: T) => number,
  truncateChild: (node: T, count: number) => T | undefined,
): T[] {
  const kept: T[] = [];
  let remaining = keepCount;
  for (const child of children) {
    if (remaining <= 0) break;
    const childCount = getCount(child);
    if (remaining >= childCount) {
      kept.push(child);
      remaining -= childCount;
    } else {
      const truncated = truncateChild(child, remaining);
      if (truncated) kept.push(truncated);
      remaining = 0;
    }
  }
  return kept;
}

function allocatedRangeCount(node: BlockRangeProjectionNode): number {
  if (node.kind === "leaf") return prefixProjectionCapacity(0);
  if (node.level >= 0) return prefixProjectionCapacity(node.level);
  let capacity = 0;
  for (const child of node.children) capacity += prefixProjectionCapacity(child.level);
  return capacity;
}

const BlockRangeProjectionTreeNode = React.memo(function BlockRangeProjectionTreeNode(
  props: BlockRangeProjectionTreeProps,
): React.ReactElement | null {
  const {
    node,
    nodeStart,
    rangeSize,
    rangeStart,
    rangeEnd,
    visibleStart,
    visibleEnd,
    renderRange,
    fullContent = false,
  } = props;
  let counterFamily: BlockRangeProjectionTreeProps["counterFamily"];
  let counters: BlockRangeProjectionTreeProps["counters"];
  let viewCounters: BlockRangeProjectionTreeProps["viewCounters"];
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    counterFamily = props.counterFamily;
    counters = props.counters;
    viewCounters = props.viewCounters;
  }
  const nodeEnd = nodeStart + (fullContent ? allocatedRangeCount(node) : node.rangeCount) * rangeSize;
  const localRangeStart = Math.max(rangeStart, nodeStart);
  const localRangeEnd = fullContent ? nodeEnd : Math.min(rangeEnd, nodeEnd);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    viewCounters?.recordStoreRecordsTouched?.(1, "view");
  }
  if (localRangeEnd <= localRangeStart) return null;

  const localVisibleStart = Math.max(visibleStart, nodeStart);
  const localVisibleEnd = fullContent ? nodeEnd : Math.min(visibleEnd, nodeEnd);
  if (node.kind === "leaf") {
    if (
      typeof __STREAM_MDX_COUNTERS__ !== "undefined" &&
      __STREAM_MDX_COUNTERS__ &&
      counterFamily !== undefined
    ) {
      counters?.recordBlockRangeProjectionVisits?.(counterFamily, 0, node.starts.length);
    }
    const ranges: React.ReactNode[] = [];
    for (const chunkStart of node.starts) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        viewCounters?.recordStoreRecordsTouched?.(1, "view");
      }
      const chunkEnd = chunkStart + rangeSize;
      const mountedStart = Math.max(localRangeStart, chunkStart);
      const mountedEnd = Math.min(localRangeEnd, chunkEnd);
      if (mountedEnd <= mountedStart) continue;
      ranges.push(renderRange({
        chunkStart,
        rangeStart: mountedStart,
        rangeEnd: mountedEnd,
        visibleStart: Math.max(localVisibleStart, chunkStart),
        visibleEnd: Math.min(localVisibleEnd, chunkEnd),
      }));
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        viewCounters?.recordRecordSlotsAllocated?.(1, "view");
      }
    }
    return React.createElement(React.Fragment, null, ...ranges);
  }

  if (
    typeof __STREAM_MDX_COUNTERS__ !== "undefined" &&
    __STREAM_MDX_COUNTERS__ &&
    counterFamily !== undefined
  ) {
    counters?.recordBlockRangeProjectionVisits?.(counterFamily, 1, 0);
  }
  const children: React.ReactElement[] = [];
  let childStart = nodeStart;
  for (const child of node.children) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      viewCounters?.recordStoreRecordsTouched?.(1, "view");
    }
    const childRangeCount = fullContent ? prefixProjectionCapacity(child.level) : child.rangeCount;
    const childEnd = childStart + childRangeCount * rangeSize;
    const childRangeStart = Math.max(localRangeStart, childStart);
    const childRangeEnd = Math.min(localRangeEnd, childEnd);
    if (childRangeEnd > childRangeStart) {
      const childProps: Omit<BlockRangeProjectionTreeProps, "counterFamily" | "counters" | "viewCounters"> = {
        node: child,
        nodeStart: childStart,
        rangeSize,
        rangeStart: childRangeStart,
        rangeEnd: childRangeEnd,
        visibleStart: Math.max(localVisibleStart, childStart),
        visibleEnd: Math.min(localVisibleEnd, childEnd),
        renderRange,
        fullContent,
      };
      const key = `${childStart}:${child.level}`;
      if (
        typeof __STREAM_MDX_COUNTERS__ !== "undefined" &&
        __STREAM_MDX_COUNTERS__ &&
        counterFamily !== undefined &&
        viewCounters !== undefined
      ) {
        children.push(React.createElement(BlockRangeProjectionTreeNode, {
          ...childProps,
          key,
          counterFamily,
          counters,
          viewCounters,
        }));
      } else if (
        typeof __STREAM_MDX_COUNTERS__ !== "undefined" &&
        __STREAM_MDX_COUNTERS__ &&
        counterFamily !== undefined
      ) {
        children.push(React.createElement(BlockRangeProjectionTreeNode, {
          ...childProps,
          key,
          counterFamily,
          counters,
        }));
      } else if (
        typeof __STREAM_MDX_COUNTERS__ !== "undefined" &&
        __STREAM_MDX_COUNTERS__ &&
        viewCounters !== undefined
      ) {
        children.push(React.createElement(BlockRangeProjectionTreeNode, {
          ...childProps,
          key,
          viewCounters,
        }));
      } else {
        children.push(React.createElement(BlockRangeProjectionTreeNode, { ...childProps, key }));
      }
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        viewCounters?.recordRecordSlotsAllocated?.(1, "view");
      }
    }
    childStart = childEnd;
  }
  return React.createElement(React.Fragment, null, ...children);
});

BlockRangeProjectionTreeNode.displayName = "BlockRangeProjectionTreeNode";

export const BlockRangeProjectionTree = BlockRangeProjectionTreeNode;

function buildNode(
  level: number,
  firstRange: number,
  rangeCount: number,
  rangeSize: number,
): BlockRangeProjectionNode {
  if (level === 0) {
    const starts = new Array<number>(rangeCount);
    for (let offset = 0; offset < rangeCount; offset += 1) {
      starts[offset] = (firstRange + offset) * rangeSize;
    }
    return { kind: "leaf", level: 0, rangeCount, starts };
  }

  const childCapacity = prefixProjectionCapacity(level - 1);
  const children: BlockRangeProjectionNode[] = [];
  let remaining = rangeCount;
  let nextRange = firstRange;
  while (remaining > 0) {
    const childCount = Math.min(childCapacity, remaining);
    children.push(buildNode(level - 1, nextRange, childCount, rangeSize));
    remaining -= childCount;
    nextRange += childCount;
  }
  return { kind: "branch", level, rangeCount, children };
}

function buildRoot(rangeCount: number, rangeSize: number): BlockRangeProjectionBranch {
  const children = createAnchoredPrefixPlan(rangeCount).map(({ level, firstIndex, count }) =>
    buildNode(level, firstIndex, count, rangeSize));
  return { kind: "branch", level: -1, rangeCount, children };
}

function pathToRange(level: number, rangeIndex: number, rangeSize: number): BlockRangeProjectionNode {
  if (level === 0) {
    return { kind: "leaf", level: 0, rangeCount: 1, starts: [rangeIndex * rangeSize] };
  }
  return {
    kind: "branch",
    level,
    rangeCount: 1,
    children: [pathToRange(level - 1, rangeIndex, rangeSize)],
  };
}

function appendNode(
  node: BlockRangeProjectionNode,
  rangeIndex: number,
  rangeSize: number,
): BlockRangeProjectionNode {
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      level: 0,
      rangeCount: node.rangeCount + 1,
      starts: [...node.starts, rangeIndex * rangeSize],
    };
  }

  const lastIndex = node.children.length - 1;
  const last = node.children[lastIndex];
  if (!last) throw new RangeError("Block range projection branch cannot be empty");
  const children = node.children.slice();
  if (last.rangeCount < prefixProjectionCapacity(last.level)) {
    children[lastIndex] = appendNode(last, rangeIndex, rangeSize);
  } else {
    children.push(pathToRange(node.level - 1, rangeIndex, rangeSize));
  }
  return {
    kind: "branch",
    level: node.level,
    rangeCount: node.rangeCount + 1,
    children,
  };
}

function truncateNode(
  node: BlockRangeProjectionNode,
  keepCount: number,
): BlockRangeProjectionNode | undefined {
  if (keepCount <= 0) return undefined;
  if (keepCount >= node.rangeCount) return node;
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      level: 0,
      rangeCount: keepCount,
      starts: node.starts.slice(0, keepCount),
    };
  }

  const children = truncateAnchoredPrefixChildren(
    node.children,
    keepCount,
    (child) => child.rangeCount,
    truncateNode,
  );
  return { kind: "branch", level: node.level, rangeCount: keepCount, children };
}

function createEmptyProjection(rangeSize: number): BlockRangeProjection {
  return { rangeCount: 0, rangeSize, root: { kind: "branch", level: -1, rangeCount: 0, children: [] } };
}

function truncateProjection(current: BlockRangeProjection, rangeCount: number): BlockRangeProjection {
  if (rangeCount === 0) return createEmptyProjection(current.rangeSize);
  const children = truncateAnchoredPrefixChildren(
    current.root.children,
    rangeCount,
    (child) => child.rangeCount,
    truncateNode,
  );
  return {
    rangeCount,
    rangeSize: current.rangeSize,
    root: { kind: "branch", level: -1, rangeCount, children },
  };
}

function rangeCountFor(recordCount: number, rangeSize: number): number {
  return Math.ceil(Math.max(0, recordCount) / rangeSize);
}

function assertRangeSize(rangeSize: number): void {
  if (!Number.isSafeInteger(rangeSize) || rangeSize <= 0) {
    throw new RangeError("Block range projection size must be a positive integer");
  }
}

/** Create a minimal persistent prefix with a permanent root anchor. */
export function createBlockRangeProjection(recordCount: number, rangeSize: number): BlockRangeProjection {
  assertRangeSize(rangeSize);
  const rangeCount = rangeCountFor(recordCount, rangeSize);
  return { rangeCount, rangeSize, root: buildRoot(rangeCount, rangeSize) };
}

/** Append persistent range descriptors; completed subtrees keep their identities. */
export function appendBlockRangeProjection(
  current: BlockRangeProjection,
  recordCount: number,
): BlockRangeProjection {
  const nextCount = rangeCountFor(recordCount, current.rangeSize);
  if (nextCount === current.rangeCount) return current;
  if (nextCount < current.rangeCount) return truncateProjection(current, nextCount);

  let root = current.root;
  for (let rangeIndex = current.rangeCount; rangeIndex < nextCount; rangeIndex += 1) {
    const children = appendAnchoredPrefixChild(
      root.children,
      rangeIndex,
      (child) => child.rangeCount,
      (level, index) => pathToRange(level, index, current.rangeSize),
      (child, index) => appendNode(child, index, current.rangeSize),
    );
    root = { kind: "branch", level: -1, rangeCount: rangeIndex + 1, children };
  }
  return { rangeCount: nextCount, rangeSize: current.rangeSize, root };
}
