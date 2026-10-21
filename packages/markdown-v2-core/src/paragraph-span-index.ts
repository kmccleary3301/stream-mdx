import {
  freezeParagraphSpanRecord,
  type ParagraphSpanIndex,
  type ParagraphSpanRecord,
  type ParagraphSpanUpdate,
} from "./paragraph-records";

export type ParagraphRecordCounterStage = "engine" | "snapshot" | "patch" | "store" | "view";

export interface ParagraphRecordWorkCounters {
  recordRecordSlotsAllocated(count: number, stage?: ParagraphRecordCounterStage): void;
  recordPrefixComparisons?(count: number, stage?: ParagraphRecordCounterStage): void;
}

export interface ParagraphSpanIndexOptions {
  readonly spans?: readonly ParagraphSpanRecord[];
  readonly campaignCounters?: ParagraphRecordWorkCounters;
  readonly counterStage?: ParagraphRecordCounterStage;
}

declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

const LEAF_CAPACITY = 64;
const DIRECTORY_CAPACITY = 32;
const EMPTY_SPANS: readonly ParagraphSpanRecord[] = Object.freeze([]);

interface ParagraphSpanLeaf {
  readonly kind: "leaf";
  readonly height: 0;
  readonly records: readonly (ParagraphSpanRecord | undefined)[];
  readonly used: number;
  readonly pageCount: 1;
  readonly revisionStamp: number;
}

interface ParagraphSpanDirectory {
  readonly kind: "directory";
  readonly height: number;
  readonly children: readonly (ParagraphSpanTreeNode | undefined)[];
  readonly pageCount: number;
  readonly revisionStamp: number;
}

type ParagraphSpanTreeNode = ParagraphSpanLeaf | ParagraphSpanDirectory;

function treeHeightForPageCount(pageCount: number): number {
  let height = 0;
  let capacity = 1;
  while (capacity < pageCount) {
    capacity *= DIRECTORY_CAPACITY;
    height += 1;
  }
  return height;
}

function pagesWithinSubtree(totalPages: number, basePage: number, capacity: number): number {
  return Math.min(capacity, Math.max(0, totalPages - basePage));
}

function buildInitialTree(
  spans: readonly ParagraphSpanRecord[],
  totalPages: number,
  height: number,
  basePage: number,
  revision: number,
  counters?: ParagraphRecordWorkCounters,
  counterStage?: ParagraphRecordCounterStage,
): ParagraphSpanTreeNode {
  if (height === 0) {
    const start = basePage * LEAF_CAPACITY;
    const used = Math.min(LEAF_CAPACITY, spans.length - start);
    const records = new Array<ParagraphSpanRecord | undefined>(LEAF_CAPACITY).fill(undefined);
    for (let offset = 0; offset < used; offset += 1) {
      records[offset] = spans[start + offset];
    }
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
      counters.recordRecordSlotsAllocated(LEAF_CAPACITY, counterStage);
    }
    return { kind: "leaf", height: 0, records, used, pageCount: 1, revisionStamp: revision };
  }

  const children = new Array<ParagraphSpanTreeNode | undefined>(DIRECTORY_CAPACITY).fill(undefined);
  const childPageCapacity = DIRECTORY_CAPACITY ** (height - 1);
  for (let slot = 0; slot < DIRECTORY_CAPACITY; slot += 1) {
    const childBasePage = basePage + slot * childPageCapacity;
    if (childBasePage >= totalPages) break;
    children[slot] = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined
      ? buildInitialTree(spans, totalPages, height - 1, childBasePage, revision, counters, counterStage)
      : buildInitialTree(spans, totalPages, height - 1, childBasePage, revision);
  }
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(DIRECTORY_CAPACITY, counterStage);
  }
  return { kind: "directory", height, children, pageCount: totalPages - basePage, revisionStamp: revision };
}

function getLeaf(root: ParagraphSpanTreeNode | undefined, rootHeight: number, pageIndex: number): ParagraphSpanLeaf | undefined {
  if (root === undefined) return undefined;
  let node = root;
  for (let height = rootHeight; height > 0; height -= 1) {
    if (node.kind !== "directory") return undefined;
    const childPageCapacity = DIRECTORY_CAPACITY ** (height - 1);
    const slot = Math.floor(pageIndex / childPageCapacity) % DIRECTORY_CAPACITY;
    const child = node.children[slot];
    if (child === undefined) return undefined;
    node = child;
  }
  return node.kind === "leaf" ? node : undefined;
}

function getRecord(root: ParagraphSpanTreeNode | undefined, rootHeight: number, index: number): ParagraphSpanRecord | undefined {
  if (root === undefined) return undefined;
  const leaf = getLeaf(root, rootHeight, Math.floor(index / LEAF_CAPACITY));
  return leaf?.records[index % LEAF_CAPACITY];
}

function copyRangeFromNode(
  node: ParagraphSpanTreeNode,
  height: number,
  basePage: number,
  from: number,
  to: number,
  output: ParagraphSpanRecord[],
  outputOffset: number,
): number {
  if (node.kind === "leaf") {
    const baseIndex = basePage * LEAF_CAPACITY;
    const first = Math.max(from, baseIndex) - baseIndex;
    const last = Math.min(to, baseIndex + node.used) - baseIndex;
    for (let offset = first; offset < last; offset += 1) {
      const record = node.records[offset];
      if (record !== undefined) output[outputOffset++] = record;
    }
    return outputOffset;
  }

  const childPageCapacity = DIRECTORY_CAPACITY ** (height - 1);
  const firstChild = Math.max(0, Math.floor((from / LEAF_CAPACITY - basePage) / childPageCapacity));
  const lastChild = Math.min(
    DIRECTORY_CAPACITY - 1,
    Math.floor(((to - 1) / LEAF_CAPACITY - basePage) / childPageCapacity),
  );
  for (let slot = firstChild; slot <= lastChild; slot += 1) {
    const child = node.children[slot];
    if (child !== undefined) {
      outputOffset = copyRangeFromNode(
        child,
        height - 1,
        basePage + slot * childPageCapacity,
        from,
        to,
        output,
        outputOffset,
      );
    }
  }
  return outputOffset;
}

function growRoot(
  root: ParagraphSpanTreeNode,
  targetHeight: number,
  oldPageCount: number,
  counters?: ParagraphRecordWorkCounters,
  counterStage?: ParagraphRecordCounterStage,
): ParagraphSpanTreeNode {
  let grown = root;
  while (grown.height < targetHeight) {
    const children = new Array<ParagraphSpanTreeNode | undefined>(DIRECTORY_CAPACITY).fill(undefined);
    children[0] = grown;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
      counters.recordRecordSlotsAllocated(DIRECTORY_CAPACITY, counterStage);
    }
    grown = {
      kind: "directory",
      height: grown.height + 1,
      children,
      pageCount: oldPageCount,
      revisionStamp: grown.revisionStamp,
    };
  }
  return grown;
}

function createTailLeaf(
  oldLeaf: ParagraphSpanLeaf | undefined,
  basePage: number,
  from: number,
  finalLength: number,
  spans: readonly ParagraphSpanRecord[],
  revision: number,
  counters?: ParagraphRecordWorkCounters,
  counterStage?: ParagraphRecordCounterStage,
): ParagraphSpanLeaf {
  const baseIndex = basePage * LEAF_CAPACITY;
  const prefixCount = Math.max(0, Math.min(LEAF_CAPACITY, from - baseIndex));
  const used = Math.min(LEAF_CAPACITY, finalLength - baseIndex);
  const records = new Array<ParagraphSpanRecord | undefined>(LEAF_CAPACITY).fill(undefined);

  if (prefixCount > 0) {
    if (oldLeaf === undefined || prefixCount > oldLeaf.used) {
      throw new Error("Missing preserved paragraph span prefix page");
    }
    for (let offset = 0; offset < prefixCount; offset += 1) records[offset] = oldLeaf.records[offset];
  }

  for (let offset = prefixCount; offset < used; offset += 1) {
    const replacementIndex = baseIndex + offset - from;
    const record = spans[replacementIndex];
    if (record === undefined) throw new Error("Paragraph span replacement is missing an indexed record");
    records[offset] = record;
  }
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(LEAF_CAPACITY, counterStage);
  }
  return { kind: "leaf", height: 0, records, used, pageCount: 1, revisionStamp: revision };
}

function buildTailTreeNode(
  oldNode: ParagraphSpanTreeNode | undefined,
  oldTotalPages: number,
  finalTotalPages: number,
  height: number,
  basePage: number,
  prefixPageCount: number,
  from: number,
  finalLength: number,
  spans: readonly ParagraphSpanRecord[],
  revision: number,
  counters?: ParagraphRecordWorkCounters,
  counterStage?: ParagraphRecordCounterStage,
): ParagraphSpanTreeNode | undefined {
  const capacity = DIRECTORY_CAPACITY ** height;
  const oldCount = pagesWithinSubtree(oldTotalPages, basePage, capacity);
  const finalCount = pagesWithinSubtree(finalTotalPages, basePage, capacity);
  if (finalCount === 0) return undefined;

  if (oldNode !== undefined
    && oldNode.height === height
    && oldCount === finalCount
    && basePage + oldCount <= prefixPageCount) {
    return oldNode;
  }

  if (height === 0) {
    const oldLeaf = oldNode?.kind === "leaf" ? oldNode : undefined;
    if (oldLeaf !== undefined && basePage < prefixPageCount && oldCount === finalCount) return oldLeaf;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
      return createTailLeaf(oldLeaf, basePage, from, finalLength, spans, revision, counters, counterStage);
    }
    return createTailLeaf(oldLeaf, basePage, from, finalLength, spans, revision);
  }

  const children = oldNode?.kind === "directory" && oldNode.height === height
    ? oldNode.children.slice()
    : new Array<ParagraphSpanTreeNode | undefined>(DIRECTORY_CAPACITY).fill(undefined);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(DIRECTORY_CAPACITY, counterStage);
  }

  const childPageCapacity = DIRECTORY_CAPACITY ** (height - 1);
  for (let slot = 0; slot < DIRECTORY_CAPACITY; slot += 1) {
    const childBasePage = basePage + slot * childPageCapacity;
    if (childBasePage >= basePage + finalCount) break;
    const oldChild = oldNode?.kind === "directory" && oldNode.height === height
      ? oldNode.children[slot]
      : undefined;
    const child = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined
      ? buildTailTreeNode(
          oldChild, oldTotalPages, finalTotalPages, height - 1, childBasePage,
          prefixPageCount, from, finalLength, spans, revision, counters, counterStage,
        )
      : buildTailTreeNode(
          oldChild, oldTotalPages, finalTotalPages, height - 1, childBasePage,
          prefixPageCount, from, finalLength, spans, revision,
        );
    children[slot] = child;
  }
  return { kind: "directory", height, children, pageCount: finalCount, revisionStamp: revision };
}

function lowerBoundPage(
  pages: readonly number[],
  target: number,
  from: number,
  to: number,
  counters?: ParagraphRecordWorkCounters,
  counterStage?: ParagraphRecordCounterStage,
): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = low + ((high - low) >>> 1);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, counterStage);
    }
    if ((pages[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function replaceUpdatedNode(
  node: ParagraphSpanTreeNode,
  height: number,
  basePage: number,
  pageIndexes: readonly number[],
  firstUpdate: number,
  endUpdate: number,
  updatedPages: ReadonlyMap<number, readonly (ParagraphSpanRecord | undefined)[]>,
  revision: number,
  counters?: ParagraphRecordWorkCounters,
  counterStage?: ParagraphRecordCounterStage,
): ParagraphSpanTreeNode {
  if (height === 0) {
    const updated = updatedPages.get(basePage);
    if (!updated || node.kind !== "leaf") throw new Error("Missing updated paragraph span leaf");
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
      counters.recordRecordSlotsAllocated(LEAF_CAPACITY, counterStage);
    }
    return { kind: "leaf", height: 0, records: updated, used: node.used, pageCount: 1, revisionStamp: revision };
  }
  if (node.kind !== "directory") throw new Error("Paragraph span directory invariant violated");

  const children = node.children.slice();
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(DIRECTORY_CAPACITY, counterStage);
  }
  const childPageCapacity = DIRECTORY_CAPACITY ** (height - 1);
  for (let slot = 0; slot < DIRECTORY_CAPACITY; slot += 1) {
    const childBasePage = basePage + slot * childPageCapacity;
    const childEndPage = childBasePage + childPageCapacity;
    const first = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined
      ? lowerBoundPage(pageIndexes, childBasePage, firstUpdate, endUpdate, counters, counterStage)
      : lowerBoundPage(pageIndexes, childBasePage, firstUpdate, endUpdate);
    const end = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined
      ? lowerBoundPage(pageIndexes, childEndPage, first, endUpdate, counters, counterStage)
      : lowerBoundPage(pageIndexes, childEndPage, first, endUpdate);
    if (first === end) continue;
    const child = children[slot];
    if (!child) throw new Error("Missing paragraph span child page for an update");
    children[slot] = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined
      ? replaceUpdatedNode(child, height - 1, childBasePage, pageIndexes, first, end, updatedPages, revision, counters, counterStage)
      : replaceUpdatedNode(child, height - 1, childBasePage, pageIndexes, first, end, updatedPages, revision);
  }
  return { kind: "directory", height, children, pageCount: node.pageCount, revisionStamp: revision };
}

function assertReadRange(from: number, to: number): void {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0 || from > to) {
    throw new RangeError("Paragraph span read range must be ordered non-negative safe integers");
  }
}

function assertSourceProjection(current: ParagraphSpanRecord, replacement: ParagraphSpanRecord): void {
  if (current.id !== replacement.id
    || current.index !== replacement.index
    || current.sourceRange.from !== replacement.sourceRange.from
    || current.sourceRange.to !== replacement.sourceRange.to
    || current.sourceRevision !== replacement.sourceRevision
    || current.isProvisional !== replacement.isProvisional) {
    throw new RangeError("Paragraph span semantic updates cannot change source identity");
  }
}

function nextRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) throw new RangeError("Paragraph span index revision exceeds the safe integer range");
  return next;
}

class PersistentParagraphSpanIndex implements ParagraphSpanIndex {
  declare private readonly root: ParagraphSpanTreeNode | undefined;
  declare private readonly rootHeight: number;
  declare private readonly counters?: ParagraphRecordWorkCounters;
  declare private readonly counterStage?: ParagraphRecordCounterStage;

  readonly length: number;
  readonly completeSpanCount: number;
  readonly revision: number;

  constructor(
    root: ParagraphSpanTreeNode | undefined,
    rootHeight: number,
    length: number,
    completeSpanCount: number,
    revision: number,
    counters?: ParagraphRecordWorkCounters,
    counterStage?: ParagraphRecordCounterStage,
  ) {
    this.root = root;
    this.rootHeight = rootHeight;
    this.length = length;
    this.completeSpanCount = completeSpanCount;
    this.revision = revision;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
      this.counters = counters;
      if (counterStage !== undefined) this.counterStage = counterStage;
    }
  }

  get(index: number): ParagraphSpanRecord | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) return undefined;
    return getRecord(this.root, this.rootHeight, index);
  }

  readRange(from: number, to: number): readonly ParagraphSpanRecord[] {
    assertReadRange(from, to);
    const start = Math.min(from, this.length);
    const end = Math.min(to, this.length);
    if (start >= end) return EMPTY_SPANS;
    const output = new Array<ParagraphSpanRecord>(end - start);
    const copied = this.root === undefined ? 0 : copyRangeFromNode(this.root, this.rootHeight, 0, start, end, output, 0);
    if (copied !== output.length) throw new Error("Paragraph span index range invariant violated");
    return Object.freeze(output);
  }

  replaceTail(from: number, spans: readonly ParagraphSpanRecord[]): ParagraphSpanIndex {
    let counters: ParagraphRecordWorkCounters | undefined;
    let counterStage: ParagraphRecordCounterStage | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters = this.counters;
      counterStage = this.counterStage;
    }
    if (!Number.isSafeInteger(from) || from < this.completeSpanCount || from > this.length) {
      throw new RangeError("Paragraph span tail replacement must begin at or after completeSpanCount and within the index");
    }
    if (!Array.isArray(spans)) throw new TypeError("Paragraph span tail replacement must be an array");
    if (from === this.length && spans.length === 0) return this;

    const nextSpans = new Array<ParagraphSpanRecord>(spans.length);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
      counters.recordRecordSlotsAllocated(nextSpans.length, counterStage);
    }
    const replacedTail = from < this.length ? this.get(from) : undefined;
    let prior = from > 0 ? this.get(from - 1) : undefined;
    for (let offset = 0; offset < spans.length; offset += 1) {
      const expectedIndex = from + offset;
      if (!Number.isSafeInteger(expectedIndex)) throw new RangeError("Paragraph span index exceeds the safe integer range");
      const candidate = spans[offset];
      if (!candidate || candidate.index !== expectedIndex) throw new RangeError(`Paragraph span index must be ${expectedIndex}`);
      if (offset === 0 && replacedTail) {
        const expectedSourceRevision = replacedTail.sourceRevision + 1;
        if (!Number.isSafeInteger(expectedSourceRevision) || candidate.sourceRevision !== expectedSourceRevision) {
          throw new RangeError("Replacing a provisional paragraph span must advance its source revision");
        }
      }
      if (candidate.isProvisional && offset !== spans.length - 1) {
        throw new RangeError("Only the final paragraph span may be provisional");
      }
      const span = freezeParagraphSpanRecord(candidate);
      if (prior && span.sourceRange.from !== prior.sourceRange.to) {
        throw new RangeError("Paragraph span source ranges must be contiguous");
      }
      nextSpans[offset] = span;
      prior = span;
    }

    const finalLength = from + nextSpans.length;
    if (!Number.isSafeInteger(finalLength)) throw new RangeError("Paragraph span index length exceeds the safe integer range");
    const preserved = from > 0 ? this.get(from - 1) : undefined;
    if (preserved?.isProvisional && nextSpans.length > 0) {
      throw new RangeError("A provisional paragraph span cannot be followed by another span");
    }
    const finalLast = nextSpans.length > 0 ? nextSpans[nextSpans.length - 1] : preserved;
    const completeSpanCount = finalLength - (finalLast?.isProvisional ? 1 : 0);
    const oldPageCount = Math.ceil(this.length / LEAF_CAPACITY);
    const prefixPageCount = Math.floor(from / LEAF_CAPACITY);
    const finalPageCount = Math.ceil(finalLength / LEAF_CAPACITY);
    const requestedHeight = finalPageCount === 0 ? 0 : treeHeightForPageCount(finalPageCount);
    const rootHeight = Math.max(this.rootHeight, requestedHeight);
    let oldRoot = this.root;
    if (oldRoot !== undefined && oldRoot.height < rootHeight) {
      oldRoot = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined
        ? growRoot(oldRoot, rootHeight, oldPageCount, counters, counterStage)
        : growRoot(oldRoot, rootHeight, oldPageCount);
    }
    const revision = nextRevision(this.revision);
    let root: ParagraphSpanTreeNode | undefined;
    if (finalPageCount > 0) {
      root = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined
        ? buildTailTreeNode(
            oldRoot, oldPageCount, finalPageCount, rootHeight, 0, prefixPageCount,
            from, finalLength, nextSpans, revision, counters, counterStage,
          )
        : buildTailTreeNode(
            oldRoot, oldPageCount, finalPageCount, rootHeight, 0, prefixPageCount,
            from, finalLength, nextSpans, revision,
          );
      while (root?.kind === "directory" && root.pageCount <= DIRECTORY_CAPACITY ** (root.height - 1)) {
        const firstChild = root.children[0];
        if (firstChild === undefined) break;
        root = firstChild;
      }
    }

    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      return new PersistentParagraphSpanIndex(root, root?.height ?? 0, finalLength, completeSpanCount, revision, counters, counterStage);
    }
    return new PersistentParagraphSpanIndex(root, root?.height ?? 0, finalLength, completeSpanCount, revision);
  }

  updateSpans(updates: readonly ParagraphSpanUpdate[]): ParagraphSpanIndex {
    let counters: ParagraphRecordWorkCounters | undefined;
    let counterStage: ParagraphRecordCounterStage | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters = this.counters;
      counterStage = this.counterStage;
    }
    if (!Array.isArray(updates)) throw new TypeError("Paragraph span updates must be an array");
    if (updates.length === 0) return this;

    const updatedPages = new Map<number, (ParagraphSpanRecord | undefined)[]>();
    let previousIndex = -1;
    for (const update of updates) {
      const current = Number.isSafeInteger(update?.index) && update.index >= 0 ? this.get(update.index) : undefined;
      if (!current
        || update.index <= previousIndex
        || update.expectedSourceRevision !== current.sourceRevision
        || !update.span) {
        throw new RangeError("Paragraph span update is stale or not in ascending unique order");
      }
      assertSourceProjection(current, update.span);
      const replacement = freezeParagraphSpanRecord(update.span);
      const pageIndex = Math.floor(update.index / LEAF_CAPACITY);
      let page = updatedPages.get(pageIndex);
      if (!page) {
        const leaf = getLeaf(this.root, this.rootHeight, pageIndex);
        if (!leaf) throw new Error("Paragraph span index page invariant violated");
        page = leaf.records.slice();
        updatedPages.set(pageIndex, page);
      }
      page[update.index % LEAF_CAPACITY] = replacement;
      previousIndex = update.index;
    }

    const pageIndexes = Array.from(updatedPages.keys());
    const revision = nextRevision(this.revision);
    const root = this.root;
    if (!root) throw new Error("Paragraph span update has no backing tree");
    const nextRoot = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined
      ? replaceUpdatedNode(root, this.rootHeight, 0, pageIndexes, 0, pageIndexes.length, updatedPages, revision, counters, counterStage)
      : replaceUpdatedNode(root, this.rootHeight, 0, pageIndexes, 0, pageIndexes.length, updatedPages, revision);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      return new PersistentParagraphSpanIndex(nextRoot, this.rootHeight, this.length, this.completeSpanCount, revision, counters, counterStage);
    }
    return new PersistentParagraphSpanIndex(nextRoot, this.rootHeight, this.length, this.completeSpanCount, revision);
  }

  materialize(): readonly ParagraphSpanRecord[] {
    return this.length === 0 ? EMPTY_SPANS : this.readRange(0, this.length);
  }
}

export function createParagraphSpanIndex(options?: ParagraphSpanIndexOptions): ParagraphSpanIndex {
  let counters: ParagraphRecordWorkCounters | undefined;
  let counterStage: ParagraphRecordCounterStage | undefined;
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    counters = options?.campaignCounters;
    counterStage = options?.counterStage;
  }
  const input = options?.spans ?? EMPTY_SPANS;
  if (!Array.isArray(input)) throw new TypeError("Paragraph span index spans must be an array");
  const spans = new Array<ParagraphSpanRecord>(input.length);
  let previous: ParagraphSpanRecord | undefined;
  let provisionalSeen = false;
  for (let index = 0; index < input.length; index += 1) {
    const candidate = input[index];
    if (!candidate || candidate.index !== index) throw new RangeError(`Paragraph span index must be ${index}`);
    if (candidate.isProvisional) {
      if (provisionalSeen || index !== input.length - 1) {
        throw new RangeError("Only the final paragraph span may be provisional");
      }
      provisionalSeen = true;
    }
    const span = freezeParagraphSpanRecord(candidate);
    if (previous && span.sourceRange.from !== previous.sourceRange.to) {
      throw new RangeError("Paragraph span source ranges must be contiguous");
    }
    spans[index] = span;
    previous = span;
  }

  const completeSpanCount = spans.length - Number(Boolean(spans[spans.length - 1]?.isProvisional));
  const totalPages = Math.ceil(spans.length / LEAF_CAPACITY);
  const height = treeHeightForPageCount(totalPages);
  const root = totalPages === 0
    ? undefined
    : typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined
      ? buildInitialTree(spans, totalPages, height, 0, 0, counters, counterStage)
      : buildInitialTree(spans, totalPages, height, 0, 0);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    return new PersistentParagraphSpanIndex(root, height, spans.length, completeSpanCount, 0, counters, counterStage);
  }
  return new PersistentParagraphSpanIndex(root, height, spans.length, completeSpanCount, 0);
}
