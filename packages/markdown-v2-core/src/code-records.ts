import type { DiffLineKind, TokenStyle } from "./types";


export type CodeTokenSpan = {
  readonly t: string;
  readonly v?: {
    readonly dark?: Readonly<TokenStyle>;
    readonly light?: Readonly<TokenStyle>;
  };
  readonly s?: Readonly<TokenStyle>;
};

export type CodeDiffTokenLine = {
  readonly old: CodeTokenLine | null;
  readonly new: CodeTokenLine | null;
};

export type CodeTokenLine = {
  readonly spans: readonly CodeTokenSpan[];
};

interface CodeLineDecorationBase {
  readonly index: number;
  readonly lineId: string;
  readonly sourceRevision: number;
  readonly configurationRevision: number;
}

export type HighlightUnavailableReason =
  | "missing_context"
  | "stale_generation"
  | "evicted_checkpoint_no_source"
  | "source_mismatch";

export type CodeLineDecoration = CodeLineDecorationBase & (
  | {
      readonly exactness: "exact" | "isolated";
      readonly tokens: CodeTokenLine;
      readonly diffTokens?: CodeDiffTokenLine;
    }
  | {
      readonly exactness: "unavailable";
      readonly tokens: null;
      readonly reason: HighlightUnavailableReason;
    }
);


export type CodeLineDecorationUpdate =
  | CodeLineDecoration
  | {
      readonly index: number;
      readonly lineId: string;
      readonly sourceRevision: number;
      readonly configurationRevision: number;
      readonly tokens: null;
    };

export interface CodeLineRecord {
  readonly id: string;
  readonly index: number;
  readonly text: string;
  readonly ending: "" | "\n" | "\r\n" | "\r";
  readonly sourceRange: {
    readonly from: number;
    readonly to: number;
  };
  readonly sourceRevision: number;
  readonly isProvisional: boolean;
  readonly decoration?: CodeLineDecoration;
  readonly diffKind?: DiffLineKind;
  readonly oldNo?: number | null;
  readonly newNo?: number | null;
}

export interface CodeLineIndex {
  readonly length: number;
  readonly completeLineCount: number;
  readonly revision: number;
  get(index: number): CodeLineRecord | undefined;
  readRange(from: number, to: number): readonly CodeLineRecord[];
  replaceTail(from: number, lines: readonly CodeLineRecord[]): CodeLineIndex;
  decorate(records: readonly CodeLineDecorationUpdate[]): CodeLineIndex;
  materialize(): string;
}

type CodeRecordCounterStage = "engine" | "snapshot" | "patch" | "store" | "view";

interface CodeRecordWorkCounters {
  recordRecordSlotsAllocated(count: number, stage?: CodeRecordCounterStage): void;
  recordPrefixComparisons?(count: number): void;
}

interface CodeLineIndexOptions {
  readonly lines?: readonly CodeLineRecord[];
}

interface CodeLineIndexDiagnosticOptions {
  readonly campaignCounters?: CodeRecordWorkCounters;
  readonly counterStage?: CodeRecordCounterStage;
}

declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

const LEAF_CAPACITY = 64;
const DIRECTORY_CAPACITY = 32;
const EMPTY_RECORDS: readonly CodeLineRecord[] = Object.freeze([]);
const VALID_ENDINGS: Readonly<Record<CodeLineRecord["ending"], true>> = {
  "": true,
  "\n": true,
  "\r\n": true,
  "\r": true,
};
const VALID_DIFF_KINDS: Readonly<Record<DiffLineKind, true>> = {
  meta: true,
  hunk: true,
  add: true,
  del: true,
  context: true,
};

interface CodeLineLeaf {
  readonly kind: "leaf";
  readonly height: 0;
  readonly rows: readonly (CodeLineRecord | undefined)[];
  readonly used: number;
  readonly revisionStamp: number;
}

interface CodeLineDirectory {
  readonly kind: "directory";
  readonly height: number;
  readonly children: readonly (CodeLineTreeNode | undefined)[];
  readonly revisionStamp: number;
}

type CodeLineTreeNode = CodeLineLeaf | CodeLineDirectory;

function nextRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError("Code line index revision exceeds the safe integer range");
  }
  return next;
}

function assertRecord(record: CodeLineRecord, expectedIndex: number): void {
  if (typeof record !== "object" || record === null) {
    throw new TypeError("Code line records must be objects");
  }
  if (!Number.isSafeInteger(record.index) || record.index !== expectedIndex) {
    throw new RangeError(`Code line record index must be ${expectedIndex}`);
  }
  if (typeof record.id !== "string" || typeof record.text !== "string") {
    throw new TypeError("Code line record id and text must be strings");
  }
  if (record.text.includes("\n") || record.text.includes("\r")) {
    throw new TypeError("Code line text must not contain a line terminator");
  }
  if (VALID_ENDINGS[record.ending] !== true) {
    throw new TypeError("Code line ending must be empty, LF, CRLF, or CR");
  }
  if (typeof record.sourceRange !== "object" || record.sourceRange === null) {
    throw new TypeError("Code line sourceRange must be an object");
  }
  if (
    !Number.isSafeInteger(record.sourceRange.from) ||
    !Number.isSafeInteger(record.sourceRange.to) ||
    record.sourceRange.from < 0 ||
    record.sourceRange.to < record.sourceRange.from
  ) {
    throw new RangeError("Code line sourceRange must be an ordered UTF-16 range");
  }
  if (!Number.isSafeInteger(record.sourceRevision) || record.sourceRevision < 0) {
    throw new RangeError("Code line sourceRevision must be a non-negative safe integer");
  }
  if (typeof record.isProvisional !== "boolean") {
    throw new TypeError("Code line isProvisional must be a boolean");
  }
  if (record.diffKind != null && VALID_DIFF_KINDS[record.diffKind] !== true) {
    throw new TypeError("Code line diffKind is invalid");
  }
}

function treeHeightForPageCount(pageCount: number): number {
  let height = 0;
  let capacity = 1;
  while (capacity < pageCount) {
    capacity *= DIRECTORY_CAPACITY;
    height += 1;
  }
  return height;
}


function buildInitialTree(
  lines: readonly CodeLineRecord[],
  totalPages: number,
  height: number,
  basePage: number,
  revision: number,
  counters?: CodeRecordWorkCounters,
  counterStage?: CodeRecordCounterStage,
): CodeLineTreeNode {
  if (height === 0) {
    const start = basePage * LEAF_CAPACITY;
    const used = Math.min(LEAF_CAPACITY, lines.length - start);
    const rows = new Array<CodeLineRecord | undefined>(LEAF_CAPACITY).fill(undefined);
    for (let offset = 0; offset < used; offset += 1) {
      rows[offset] = lines[start + offset];
    }
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
      counters.recordRecordSlotsAllocated(LEAF_CAPACITY, counterStage);
    }
    return { kind: "leaf", height: 0, rows, used, revisionStamp: revision };
  }

  const children = new Array<CodeLineTreeNode | undefined>(DIRECTORY_CAPACITY).fill(undefined);
  const childPageCapacity = DIRECTORY_CAPACITY ** (height - 1);
  for (let slot = 0; slot < DIRECTORY_CAPACITY; slot += 1) {
    const childBasePage = basePage + slot * childPageCapacity;
    if (childBasePage >= totalPages) break;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      children[slot] = buildInitialTree(
        lines,
        totalPages,
        height - 1,
        childBasePage,
        revision,
        counters,
        counterStage,
      );
    } else {
      children[slot] = buildInitialTree(
        lines,
        totalPages,
        height - 1,
        childBasePage,
        revision,
      );
    }
  }
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(DIRECTORY_CAPACITY, counterStage);
  }
  return { kind: "directory", height, children, revisionStamp: revision };
}

function getLeaf(root: CodeLineTreeNode | undefined, rootHeight: number, pageIndex: number): CodeLineLeaf | undefined {
  if (root === undefined) return undefined;
  let node: CodeLineTreeNode = root;
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

function getRecord(
  root: CodeLineTreeNode | undefined,
  rootHeight: number,
  index: number,
): CodeLineRecord | undefined {
  if (root === undefined) return undefined;
  const leaf = getLeaf(root, rootHeight, Math.floor(index / LEAF_CAPACITY));
  return leaf?.rows[index % LEAF_CAPACITY];
}

function copyRangeFromNode(
  node: CodeLineTreeNode,
  height: number,
  basePage: number,
  from: number,
  to: number,
  output: CodeLineRecord[],
  outputOffset: number,
): number {
  if (node.kind === "leaf") {
    const baseIndex = basePage * LEAF_CAPACITY;
    const first = Math.max(from, baseIndex) - baseIndex;
    const last = Math.min(to, baseIndex + node.used) - baseIndex;
    for (let offset = first; offset < last; offset += 1) {
      const row = node.rows[offset];
      if (row !== undefined) output[outputOffset++] = row;
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

function fillMaterializedParts(
  node: CodeLineTreeNode,
  output: string[],
  outputOffset: number,
): number {
  if (node.kind === "leaf") {
    for (let slot = 0; slot < node.used; slot += 1) {
      const row = node.rows[slot];
      if (row !== undefined) output[outputOffset++] = row.text + row.ending;
    }
    return outputOffset;
  }

  for (let slot = 0; slot < DIRECTORY_CAPACITY; slot += 1) {
    const child = node.children[slot];
    if (child !== undefined) outputOffset = fillMaterializedParts(child, output, outputOffset);
  }
  return outputOffset;
}

function createTailLeaf(
  oldLeaf: CodeLineLeaf | undefined,
  basePage: number,
  from: number,
  finalLength: number,
  lines: readonly CodeLineRecord[],
  firstChangedPage: number,
  revision: number,
  counters?: CodeRecordWorkCounters,
  counterStage?: CodeRecordCounterStage,
): CodeLineLeaf {
  const baseIndex = basePage * LEAF_CAPACITY;
  const prefixCount = basePage === firstChangedPage ? from % LEAF_CAPACITY : 0;
  const used = Math.min(LEAF_CAPACITY, finalLength - baseIndex);
  const rows = new Array<CodeLineRecord | undefined>(LEAF_CAPACITY).fill(undefined);

  if (prefixCount > 0) {
    if (oldLeaf === undefined) throw new Error("Missing existing code line page for preserved tail prefix");
    for (let offset = 0; offset < prefixCount; offset += 1) {
      rows[offset] = oldLeaf.rows[offset];
    }
  }

  let replacementOffset = baseIndex + prefixCount - from;
  for (let offset = prefixCount; offset < used; offset += 1) {
    rows[offset] = lines[replacementOffset];
    replacementOffset += 1;
  }
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(LEAF_CAPACITY, counterStage);
  }
  return { kind: "leaf", height: 0, rows, used, revisionStamp: revision };
}

function pagesWithinSubtree(totalPages: number, basePage: number, capacity: number): number {
  return Math.min(capacity, Math.max(0, totalPages - basePage));
}

function buildTailTreeNode(
  oldNode: CodeLineTreeNode | undefined,
  oldTail: CodeLineLeaf | undefined,
  totalOldPages: number,
  totalPrefixPages: number,
  totalFinalPages: number,
  height: number,
  basePage: number,
  from: number,
  finalLength: number,
  lines: readonly CodeLineRecord[],
  firstChangedPage: number,
  revision: number,
  counters?: CodeRecordWorkCounters,
  counterStage?: CodeRecordCounterStage,
): CodeLineTreeNode | undefined {
  const subtreePageCapacity = DIRECTORY_CAPACITY ** height;
  const oldCount = pagesWithinSubtree(totalOldPages, basePage, subtreePageCapacity);
  const prefixCount = pagesWithinSubtree(totalPrefixPages, basePage, subtreePageCapacity);
  const finalCount = pagesWithinSubtree(totalFinalPages, basePage, subtreePageCapacity);
  if (finalCount === 0) return undefined;
  if (
    oldNode !== undefined &&
    oldNode.height === height &&
    prefixCount === oldCount &&
    finalCount === oldCount
  ) {
    return oldNode;
  }

  if (height === 0) {
    if (prefixCount === 1) {
      if (oldNode?.kind !== "leaf") throw new Error("Missing preserved code line page");
      return oldNode;
    }
    const oldLeaf = oldNode?.kind === "leaf"
      ? oldNode
      : basePage === firstChangedPage
        ? oldTail
        : undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      return createTailLeaf(
        oldLeaf,
        basePage,
        from,
        finalLength,
        lines,
        firstChangedPage,
        revision,
        counters,
        counterStage,
      );
    }
    return createTailLeaf(
      oldLeaf,
      basePage,
      from,
      finalLength,
      lines,
      firstChangedPage,
      revision,
    );
  }

  const canReuseDirectory = oldNode?.kind === "directory" && oldNode.height === height;
  const children = canReuseDirectory
    ? oldNode.children.slice()
    : new Array<CodeLineTreeNode | undefined>(DIRECTORY_CAPACITY).fill(undefined);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(DIRECTORY_CAPACITY, counterStage);
  }

  const childPageCapacity = DIRECTORY_CAPACITY ** (height - 1);
  for (let slot = 0; slot < DIRECTORY_CAPACITY; slot += 1) {
    const childBasePage = basePage + slot * childPageCapacity;
    const childFinalCount = pagesWithinSubtree(totalFinalPages, childBasePage, childPageCapacity);
    if (childFinalCount === 0) {
      children[slot] = undefined;
      continue;
    }

    let oldChild: CodeLineTreeNode | undefined;
    if (canReuseDirectory) {
      oldChild = oldNode.children[slot];
    } else if (oldNode !== undefined && oldNode.height < height && slot === 0) {
      oldChild = oldNode;
    }

    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      children[slot] = buildTailTreeNode(
        oldChild,
        oldTail,
        totalOldPages,
        totalPrefixPages,
        totalFinalPages,
        height - 1,
        childBasePage,
        from,
        finalLength,
        lines,
        firstChangedPage,
        revision,
        counters,
        counterStage,
      );
    } else {
      children[slot] = buildTailTreeNode(
        oldChild,
        oldTail,
        totalOldPages,
        totalPrefixPages,
        totalFinalPages,
        height - 1,
        childBasePage,
        from,
        finalLength,
        lines,
        firstChangedPage,
        revision,
      );
    }
  }
  return { kind: "directory", height, children, revisionStamp: revision };
}

function rebuildDecoratedNode(
  node: CodeLineTreeNode,
  height: number,
  basePage: number,
  pageIndexes: readonly number[],
  firstUpdate: number,
  lastUpdate: number,
  updatedRows: ReadonlyMap<number, (CodeLineRecord | undefined)[]>,
  revision: number,
  counters?: CodeRecordWorkCounters,
  counterStage?: CodeRecordCounterStage,
): CodeLineTreeNode {
  if (height === 0) {
    const rows = updatedRows.get(pageIndexes[firstUpdate]);
    if (rows === undefined || node.kind !== "leaf") {
      throw new Error("Missing decorated code line page");
    }
    return { kind: "leaf", height: 0, rows, used: node.used, revisionStamp: revision };
  }

  if (node.kind !== "directory") throw new Error("Invalid code line directory height");
  const children = node.children.slice();
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(DIRECTORY_CAPACITY, counterStage);
  }
  const childPageCapacity = DIRECTORY_CAPACITY ** (height - 1);
  let nextUpdate = firstUpdate;

  for (let slot = 0; slot < DIRECTORY_CAPACITY; slot += 1) {
    const childBasePage = basePage + slot * childPageCapacity;
    const childEndPage = childBasePage + childPageCapacity;
    const childFirstUpdate = nextUpdate;
    while (nextUpdate < lastUpdate && pageIndexes[nextUpdate] < childEndPage) {
      nextUpdate += 1;
    }
    if (childFirstUpdate === nextUpdate) continue;

    const child = node.children[slot];
    if (child === undefined) throw new Error("Missing decorated code line directory child");
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      children[slot] = rebuildDecoratedNode(
        child,
        height - 1,
        childBasePage,
        pageIndexes,
        childFirstUpdate,
        nextUpdate,
        updatedRows,
        revision,
        counters,
        counterStage,
      );
    } else {
      children[slot] = rebuildDecoratedNode(
        child,
        height - 1,
        childBasePage,
        pageIndexes,
        childFirstUpdate,
        nextUpdate,
        updatedRows,
        revision,
      );
    }
  }
  return { kind: "directory", height, children, revisionStamp: revision };
}

function assertReadRange(from: number, to: number): void {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0 || from > to) {
    throw new RangeError("Code line read range must be ordered non-negative safe integers");
  }
}

class PersistentCodeLineIndex implements CodeLineIndex {
  declare private readonly root: CodeLineTreeNode | undefined;
  declare private readonly rootHeight: number;
  declare private readonly prefixLength: number;
  declare private readonly tail: CodeLineLeaf | undefined;
  declare private readonly campaignCounters: CodeRecordWorkCounters | undefined;
  declare private readonly campaignCounterStage: CodeRecordCounterStage | undefined;
  declare private materializedBody: string | undefined;

  readonly length: number;
  readonly completeLineCount: number;
  readonly revision: number;

  constructor(
    root: CodeLineTreeNode | undefined,
    rootHeight: number,
    prefixLength: number,
    tail: CodeLineLeaf | undefined,
    length: number,
    completeLineCount: number,
    revision: number,
    campaignCounters?: CodeRecordWorkCounters,
    counterStage?: CodeRecordCounterStage,
  ) {
    this.root = root;
    this.rootHeight = rootHeight;
    this.prefixLength = prefixLength;
    this.tail = tail;
    this.length = length;
    this.completeLineCount = completeLineCount;
    this.revision = revision;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && campaignCounters !== undefined) {
      this.campaignCounters = campaignCounters;
      if (counterStage !== undefined) this.campaignCounterStage = counterStage;
    }
  }

  get(index: number): CodeLineRecord | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) return undefined;
    if (index >= this.prefixLength) return this.tail?.rows[index - this.prefixLength];
    return getRecord(this.root, this.rootHeight, index);
  }

  readRange(from: number, to: number): readonly CodeLineRecord[] {
    assertReadRange(from, to);
    const start = Math.min(from, this.length);
    const end = Math.min(to, this.length);
    if (start >= end) return EMPTY_RECORDS;

    const output = new Array<CodeLineRecord>(end - start);
    let outputOffset = 0;
    const prefixEnd = Math.min(end, this.prefixLength);
    if (start < prefixEnd && this.root !== undefined) {
      outputOffset = copyRangeFromNode(
        this.root,
        this.rootHeight,
        0,
        start,
        prefixEnd,
        output,
        outputOffset,
      );
    }
    if (this.tail !== undefined) {
      const tailStart = Math.max(start, this.prefixLength);
      for (let index = tailStart; index < end; index += 1) {
        const row = this.tail.rows[index - this.prefixLength];
        if (row !== undefined) output[outputOffset++] = row;
      }
    }
    return output;
  }

  replaceTail(from: number, lines: readonly CodeLineRecord[]): CodeLineIndex {
    let campaignCounters: CodeRecordWorkCounters | undefined;
    let campaignCounterStage: CodeRecordCounterStage | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      campaignCounters = this.campaignCounters;
      campaignCounterStage = this.campaignCounterStage;
    }
    if (!Number.isSafeInteger(from) || from < this.completeLineCount || from > this.length) {
      throw new RangeError("Code line tail replacement must start at or after completeLineCount and within the index");
    }
    if (!Array.isArray(lines)) throw new TypeError("Code line tail replacement must be an array");

    for (let offset = 0; offset < lines.length; offset += 1) {
      const index = from + offset;
      if (!Number.isSafeInteger(index)) throw new RangeError("Code line replacement index exceeds the safe integer range");
      const line = lines[offset];
      assertRecord(line, index);
      if (line.isProvisional && offset !== lines.length - 1) {
        throw new RangeError("Only the final code line may be provisional");
      }
    }

    const finalLength = from + lines.length;
    if (!Number.isSafeInteger(finalLength)) throw new RangeError("Code line index length exceeds the safe integer range");
    const preservedLast = from > 0 ? this.get(from - 1) : undefined;
    if (preservedLast?.isProvisional && lines.length > 0) {
      throw new RangeError("A provisional code line cannot be followed by another line");
    }

    if (from === this.length && lines.length === 0) return this;
    const revision = nextRevision(this.revision);

    const finalLast = lines.length > 0 ? lines[lines.length - 1] : preservedLast;
    const completeLineCount = finalLength - (finalLast?.isProvisional ? 1 : 0);
    const oldPageCount = this.prefixLength / LEAF_CAPACITY;
    const prefixPageCount = Math.floor(from / LEAF_CAPACITY);
    const finalPageCount = Math.floor(completeLineCount / LEAF_CAPACITY);
    const firstChangedPage = prefixPageCount;
    const rootHeight = finalPageCount === 0
      ? 0
      : Math.max(this.rootHeight, treeHeightForPageCount(finalPageCount));
    const root = finalPageCount === 0
      ? undefined
      : typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? buildTailTreeNode(
            this.root,
            this.tail,
            oldPageCount,
            prefixPageCount,
            finalPageCount,
            rootHeight,
            0,
            from,
            finalLength,
            lines,
            firstChangedPage,
            revision,
            campaignCounters,
            campaignCounterStage,
          )
        : buildTailTreeNode(
            this.root,
            this.tail,
            oldPageCount,
            prefixPageCount,
            finalPageCount,
            rootHeight,
            0,
            from,
            finalLength,
            lines,
            firstChangedPage,
            revision,
          );
    const prefixLength = finalPageCount * LEAF_CAPACITY;
    const tail = finalLength > prefixLength
      ? typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? createTailLeaf(
            this.tail,
            finalPageCount,
            from,
            finalLength,
            lines,
            firstChangedPage,
            revision,
            campaignCounters,
            campaignCounterStage,
          )
        : createTailLeaf(
            this.tail,
            finalPageCount,
            from,
            finalLength,
            lines,
            firstChangedPage,
            revision,
          )
      : undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      return new PersistentCodeLineIndex(
        root,
        rootHeight,
        prefixLength,
        tail,
        finalLength,
        completeLineCount,
        revision,
        campaignCounters,
        campaignCounterStage,
      );
    }
    return new PersistentCodeLineIndex(
      root,
      rootHeight,
      prefixLength,
      tail,
      finalLength,
      completeLineCount,
      revision,
    );
  }

  decorate(records: readonly CodeLineDecorationUpdate[]): CodeLineIndex {
    let campaignCounters: CodeRecordWorkCounters | undefined;
    let campaignCounterStage: CodeRecordCounterStage | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      campaignCounters = this.campaignCounters;
      campaignCounterStage = this.campaignCounterStage;
    }
    let updatedRows: Map<number, (CodeLineRecord | undefined)[]> | undefined;

    for (const decoration of records) {
      const index = decoration.index;
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) continue;
      const pageIndex = Math.floor(index / LEAF_CAPACITY);
      const rowOffset = index % LEAF_CAPACITY;
      let pageRows = updatedRows?.get(pageIndex);
      const current = pageRows?.[rowOffset] ?? this.get(index);
      if (current === undefined || current.id !== decoration.lineId || current.sourceRevision !== decoration.sourceRevision) {
        continue;
      }
      const clearDecoration = decoration.tokens === null && !("exactness" in decoration);
      if (clearDecoration) {
        if (
          current.decoration === undefined ||
          current.decoration.configurationRevision !== decoration.configurationRevision
        ) {
          continue;
        }
      } else if (current.decoration === decoration) {
        continue;
      }

      if (pageRows === undefined) {
        const prefixPageCount = this.prefixLength / LEAF_CAPACITY;
        const leaf = pageIndex < prefixPageCount
          ? getLeaf(this.root, this.rootHeight, pageIndex)
          : this.tail;
        if (leaf === undefined) continue;
        pageRows = leaf.rows.slice();
        if (updatedRows === undefined) updatedRows = new Map();
        updatedRows.set(pageIndex, pageRows);
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && campaignCounters !== undefined) {
          campaignCounters.recordRecordSlotsAllocated(LEAF_CAPACITY, campaignCounterStage);
        }
      }
      if (clearDecoration) {
        const { decoration: currentDecoration, ...undecorated } = current;
        if (currentDecoration !== undefined) pageRows[rowOffset] = undecorated;
      } else {
        pageRows[rowOffset] = { ...current, decoration };
      }
    }

    if (updatedRows === undefined || updatedRows.size === 0) return this;
    const revision = nextRevision(this.revision);

    const pageIndexes = Array.from(updatedRows.keys());
    pageIndexes.sort((left, right) => left - right);
    const prefixPageCount = this.prefixLength / LEAF_CAPACITY;
    let prefixUpdateEnd = 0;
    while (prefixUpdateEnd < pageIndexes.length && pageIndexes[prefixUpdateEnd] < prefixPageCount) {
      prefixUpdateEnd += 1;
    }
    const root = prefixUpdateEnd === 0 || this.root === undefined
      ? this.root
      : typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? rebuildDecoratedNode(
            this.root,
            this.rootHeight,
            0,
            pageIndexes,
            0,
            prefixUpdateEnd,
            updatedRows,
            revision,
            campaignCounters,
            campaignCounterStage,
          )
        : rebuildDecoratedNode(
            this.root,
            this.rootHeight,
            0,
            pageIndexes,
            0,
            prefixUpdateEnd,
            updatedRows,
            revision,
          );
    const updatedTailRows = updatedRows.get(prefixPageCount);
    const tail = updatedTailRows === undefined || this.tail === undefined
      ? this.tail
      : { ...this.tail, rows: updatedTailRows, revisionStamp: revision };
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      return new PersistentCodeLineIndex(
        root,
        this.rootHeight,
        this.prefixLength,
        tail,
        this.length,
        this.completeLineCount,
        revision,
        campaignCounters,
        campaignCounterStage,
      );
    }
    return new PersistentCodeLineIndex(
      root,
      this.rootHeight,
      this.prefixLength,
      tail,
      this.length,
      this.completeLineCount,
      revision,
    );
  }

  materialize(): string {
    if (this.materializedBody !== undefined) return this.materializedBody;
    if (this.length === 0) {
      this.materializedBody = "";
      return this.materializedBody;
    }

    const parts = new Array<string>(this.length);
    let outputOffset = this.root === undefined
      ? 0
      : fillMaterializedParts(this.root, parts, 0);
    if (this.tail !== undefined) {
      for (let slot = 0; slot < this.tail.used; slot += 1) {
        const row = this.tail.rows[slot];
        if (row !== undefined) parts[outputOffset++] = row.text + row.ending;
      }
    }
    this.materializedBody = parts.join("");
    return this.materializedBody;
  }
}

export function createCodeLineIndex(options?: CodeLineIndexOptions): CodeLineIndex {
  let campaignCounters: CodeRecordWorkCounters | undefined;
  let campaignCounterStage: CodeRecordCounterStage | undefined;
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    // Private diagnostic-entry injection; only the instrumented stage passes these structural extras.
    const diagnosticOptions = options as (CodeLineIndexOptions & CodeLineIndexDiagnosticOptions) | undefined;
    campaignCounters = diagnosticOptions?.campaignCounters;
    campaignCounterStage = diagnosticOptions?.counterStage;
  }
  const lines = options?.lines === undefined ? EMPTY_RECORDS : options.lines;
  if (!Array.isArray(lines)) throw new TypeError("Code line index lines must be an array");
  let provisionalSeen = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    assertRecord(line, index);
    if (line.isProvisional) {
      if (provisionalSeen || index !== lines.length - 1) {
        throw new RangeError("Only the final code line may be provisional");
      }
      provisionalSeen = true;
    }
  }

  const completeLineCount = lines.length - (provisionalSeen ? 1 : 0);
  const totalPages = Math.floor(completeLineCount / LEAF_CAPACITY);
  const prefixLength = totalPages * LEAF_CAPACITY;
  const height = treeHeightForPageCount(totalPages);
  const root = totalPages === 0
    ? undefined
    : typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? buildInitialTree(lines, totalPages, height, 0, 0, campaignCounters, campaignCounterStage)
      : buildInitialTree(lines, totalPages, height, 0, 0);
  const tail = lines.length > prefixLength
    ? typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? createTailLeaf(
          undefined,
          totalPages,
          0,
          lines.length,
          lines,
          totalPages,
          0,
          campaignCounters,
          campaignCounterStage,
        )
      : createTailLeaf(
          undefined,
          totalPages,
          0,
          lines.length,
          lines,
          totalPages,
          0,
        )
    : undefined;
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    return new PersistentCodeLineIndex(
      root,
      height,
      prefixLength,
      tail,
      lines.length,
      completeLineCount,
      0,
      campaignCounters,
      campaignCounterStage,
    );
  }
  return new PersistentCodeLineIndex(
    root,
    height,
    prefixLength,
    tail,
    lines.length,
    completeLineCount,
    0,
  );
}
