import { freezeTableRowRecord, type TableRowRecord } from "./table-records";

type TableRowCounterStage = "engine" | "snapshot" | "patch" | "store" | "view";

interface TableRowIndexCounters {
  recordRecordSlotsAllocated(count: number, stage?: TableRowCounterStage): void;
}

export interface TableRowIndexUpdate {
  readonly index: number;
  readonly expectedSourceRevision: number;
  readonly row: TableRowRecord;
}


interface TableRowIndexDiagnosticOptions {
  readonly campaignCounters?: TableRowIndexCounters;
  readonly counterStage?: TableRowCounterStage;
}

export interface TableRowIndex {
  readonly length: number;
  readonly completeRowCount: number;
  readonly revision: number;
  get(index: number): TableRowRecord | undefined;
  readRange(from: number, to: number): readonly TableRowRecord[];
  replaceTail(from: number, rows: readonly TableRowRecord[]): TableRowIndex;
  updateRows(updates: readonly TableRowIndexUpdate[]): TableRowIndex;
  materialize(): readonly TableRowRecord[];
}

declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

const LEAF_CAPACITY = 64;
const DIRECTORY_CAPACITY = 32;
const EMPTY_ROWS: readonly TableRowRecord[] = Object.freeze([]);

interface TableRowLeaf {
  readonly kind: "leaf";
  readonly height: 0;
  readonly rows: readonly (TableRowRecord | undefined)[];
  readonly used: number;
}

interface TableRowDirectory {
  readonly kind: "directory";
  readonly height: number;
  readonly children: readonly (TableRowTreeNode | undefined)[];
}

type TableRowTreeNode = TableRowLeaf | TableRowDirectory;

function nextRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) throw new RangeError("Table row index revision exceeds the safe integer range");
  return next;
}

function assertRange(range: { readonly from: number; readonly to: number }): void {
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
    || range.from < 0 || range.to < range.from) {
    throw new RangeError("Table source ranges must be ordered non-negative UTF-16 offsets");
  }
}

function normalizeAndAssertRow(input: TableRowRecord, expectedIndex: number): TableRowRecord {
  const row = freezeTableRowRecord(input);
  if (!Number.isSafeInteger(row.index) || row.index !== expectedIndex) {
    throw new RangeError(`Table row index must be ${expectedIndex}`);
  }
  const rowSuffix = `::row:${expectedIndex}`;
  if (typeof row.id !== "string" || !row.id.endsWith(rowSuffix)) {
    throw new TypeError("Table row id must end with its stable row index");
  }
  assertRange(row.sourceRange);
  if (!Number.isSafeInteger(row.sourceRevision) || row.sourceRevision < 0) {
    throw new RangeError("Table row sourceRevision must be a non-negative safe integer");
  }
  if (typeof row.isProvisional !== "boolean" || !Array.isArray(row.cells)) {
    throw new TypeError("Table row provisional state and cells are invalid");
  }
  for (let column = 0; column < row.cells.length; column += 1) {
    const cell = row.cells[column];
    if (!cell || cell.index !== column || cell.id !== `${row.id}::cell:${column}`) {
      throw new RangeError(`Table row cell identity must match column ${column}`);
    }
    assertRange(cell.sourceRange);
    if (typeof cell.raw !== "string" || !Array.isArray(cell.inline)) {
      throw new TypeError(`Table row cell ${column} raw source and inline data are invalid`);
    }
    if (cell.sourceRange.from < row.sourceRange.from || cell.sourceRange.to > row.sourceRange.to
      || cell.raw.length !== cell.sourceRange.to - cell.sourceRange.from) {
      throw new RangeError(`Table row cell ${column} has inconsistent authored source data`);
    }
  }
  return row;
}

function sameSourceProjection(previous: TableRowRecord, next: TableRowRecord): boolean {
  if (previous.id !== next.id || previous.index !== next.index
    || previous.sourceRevision !== next.sourceRevision || previous.isProvisional !== next.isProvisional
    || previous.sourceRange.from !== next.sourceRange.from || previous.sourceRange.to !== next.sourceRange.to
    || previous.cells.length !== next.cells.length) return false;
  for (let column = 0; column < previous.cells.length; column += 1) {
    const left = previous.cells[column];
    const right = next.cells[column];
    if (!left || !right || left.id !== right.id || left.index !== right.index
      || left.raw !== right.raw || left.sourceRange.from !== right.sourceRange.from
      || left.sourceRange.to !== right.sourceRange.to) return false;
  }
  return true;
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


function makeLeaf(rows: readonly (TableRowRecord | undefined)[], used: number): TableRowLeaf {
  return Object.freeze({ kind: "leaf", height: 0, rows: Object.freeze(rows), used });
}

function buildInitialTree(
  rows: readonly TableRowRecord[],
  totalPages: number,
  height: number,
  basePage: number,
  counters?: TableRowIndexCounters,
  stage?: TableRowCounterStage,
): TableRowTreeNode {
  if (height === 0) {
    const baseIndex = basePage * LEAF_CAPACITY;
    const used = Math.min(LEAF_CAPACITY, rows.length - baseIndex);
    const page = new Array<TableRowRecord | undefined>(LEAF_CAPACITY).fill(undefined);
    for (let offset = 0; offset < used; offset += 1) page[offset] = rows[baseIndex + offset];
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
      counters.recordRecordSlotsAllocated(LEAF_CAPACITY, stage);
    }
    return makeLeaf(page, used);
  }

  const children = new Array<TableRowTreeNode | undefined>(DIRECTORY_CAPACITY).fill(undefined);
  const childPageCapacity = DIRECTORY_CAPACITY ** (height - 1);
  for (let slot = 0; slot < DIRECTORY_CAPACITY; slot += 1) {
    const childBasePage = basePage + slot * childPageCapacity;
    if (childBasePage >= totalPages) break;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      children[slot] = buildInitialTree(rows, totalPages, height - 1, childBasePage, counters, stage);
    } else {
      children[slot] = buildInitialTree(rows, totalPages, height - 1, childBasePage);
    }
  }
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(DIRECTORY_CAPACITY, stage);
  }
  return Object.freeze({ kind: "directory", height, children: Object.freeze(children) });
}
function pagesWithinSubtree(totalPages: number, basePage: number, capacity: number): number {
  return Math.min(capacity, Math.max(0, totalPages - basePage));
}

function createTailLeaf(
  oldLeaf: TableRowLeaf | undefined,
  basePage: number,
  from: number,
  finalLength: number,
  rows: readonly TableRowRecord[],
  firstChangedPage: number,
  counters?: TableRowIndexCounters,
  stage?: TableRowCounterStage,
): TableRowLeaf {
  const baseIndex = basePage * LEAF_CAPACITY;
  const prefixCount = basePage === firstChangedPage ? from % LEAF_CAPACITY : 0;
  const used = Math.min(LEAF_CAPACITY, finalLength - baseIndex);
  const leafRows = new Array<TableRowRecord | undefined>(LEAF_CAPACITY).fill(undefined);

  if (prefixCount > 0) {
    if (oldLeaf === undefined) throw new Error("Missing existing table row page for preserved tail prefix");
    for (let offset = 0; offset < prefixCount; offset += 1) leafRows[offset] = oldLeaf.rows[offset];
  }

  let replacementOffset = baseIndex + prefixCount - from;
  for (let offset = prefixCount; offset < used; offset += 1) {
    leafRows[offset] = rows[replacementOffset];
    replacementOffset += 1;
  }
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(LEAF_CAPACITY, stage);
  }
  return makeLeaf(leafRows, used);
}

function buildTailTreeNode(
  oldNode: TableRowTreeNode | undefined,
  oldTail: TableRowLeaf | undefined,
  totalOldPages: number,
  totalPrefixPages: number,
  totalFinalPages: number,
  height: number,
  basePage: number,
  from: number,
  finalLength: number,
  rows: readonly TableRowRecord[],
  firstChangedPage: number,
  counters?: TableRowIndexCounters,
  stage?: TableRowCounterStage,
): TableRowTreeNode | undefined {
  const subtreePageCapacity = DIRECTORY_CAPACITY ** height;
  const oldCount = pagesWithinSubtree(totalOldPages, basePage, subtreePageCapacity);
  const prefixCount = pagesWithinSubtree(totalPrefixPages, basePage, subtreePageCapacity);
  const finalCount = pagesWithinSubtree(totalFinalPages, basePage, subtreePageCapacity);
  if (finalCount === 0) return undefined;
  if (oldNode !== undefined && oldNode.height === height
    && prefixCount === oldCount && finalCount === oldCount) return oldNode;

  if (height === 0) {
    if (prefixCount === 1) {
      if (oldNode?.kind !== "leaf") throw new Error("Missing preserved table row page");
      return oldNode;
    }
    const oldLeaf = oldNode?.kind === "leaf"
      ? oldNode
      : basePage === firstChangedPage
        ? oldTail
        : undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      return createTailLeaf(oldLeaf, basePage, from, finalLength, rows, firstChangedPage, counters, stage);
    }
    return createTailLeaf(oldLeaf, basePage, from, finalLength, rows, firstChangedPage);
  }

  const canReuseDirectory = oldNode?.kind === "directory" && oldNode.height === height;
  const children = canReuseDirectory
    ? oldNode.children.slice()
    : new Array<TableRowTreeNode | undefined>(DIRECTORY_CAPACITY).fill(undefined);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(DIRECTORY_CAPACITY, stage);
  }

  const childPageCapacity = DIRECTORY_CAPACITY ** (height - 1);
  for (let slot = 0; slot < DIRECTORY_CAPACITY; slot += 1) {
    const childBasePage = basePage + slot * childPageCapacity;
    const childFinalCount = pagesWithinSubtree(totalFinalPages, childBasePage, childPageCapacity);
    if (childFinalCount === 0) {
      children[slot] = undefined;
      continue;
    }

    let oldChild: TableRowTreeNode | undefined;
    if (canReuseDirectory) oldChild = oldNode.children[slot];
    else if (oldNode !== undefined && oldNode.height < height && slot === 0) oldChild = oldNode;

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
        rows,
        firstChangedPage,
        counters,
        stage,
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
        rows,
        firstChangedPage,
      );
    }
  }
  return Object.freeze({ kind: "directory", height, children: Object.freeze(children) });
}

function getLeaf(root: TableRowTreeNode | undefined, rootHeight: number, pageIndex: number): TableRowLeaf | undefined {
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

function getRow(root: TableRowTreeNode | undefined, height: number, index: number): TableRowRecord | undefined {
  const leaf = getLeaf(root, height, Math.floor(index / LEAF_CAPACITY));
  return leaf?.rows[index % LEAF_CAPACITY];
}

function setPage(
  node: TableRowTreeNode | undefined,
  height: number,
  basePage: number,
  pageIndex: number,
  page: TableRowLeaf,
  counters?: TableRowIndexCounters,
  stage?: TableRowCounterStage,
): TableRowTreeNode {
  if (height === 0) return page;
  const canReuseDirectory = node?.kind === "directory" && node.height === height;
  const children = canReuseDirectory
    ? node.children.slice()
    : new Array<TableRowTreeNode | undefined>(DIRECTORY_CAPACITY).fill(undefined);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
    counters.recordRecordSlotsAllocated(DIRECTORY_CAPACITY, stage);
  }
  const childPageCapacity = DIRECTORY_CAPACITY ** (height - 1);
  const slot = Math.floor((pageIndex - basePage) / childPageCapacity);
  if (slot < 0 || slot >= DIRECTORY_CAPACITY) throw new RangeError("Table row page is outside its directory");
  const childBasePage = basePage + slot * childPageCapacity;
  const previousChild = canReuseDirectory ? node.children[slot] : undefined;
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    children[slot] = setPage(previousChild, height - 1, childBasePage, pageIndex, page, counters, stage);
  } else {
    children[slot] = setPage(previousChild, height - 1, childBasePage, pageIndex, page);
  }
  return Object.freeze({ kind: "directory", height, children: Object.freeze(children) });
}

function copyRangeFromNode(
  node: TableRowTreeNode,
  height: number,
  basePage: number,
  from: number,
  to: number,
  output: TableRowRecord[],
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

function assertReadRange(from: number, to: number): void {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    throw new RangeError("Table row read range must be ordered non-negative safe integers");
  }
}

class PersistentTableRowIndex implements TableRowIndex {
  private readonly root: TableRowTreeNode | undefined;
  private readonly rootHeight: number;
  private readonly prefixLength: number;
  private readonly tail: TableRowLeaf | undefined;
  private declare counters?: TableRowIndexCounters;
  private declare counterStage?: TableRowCounterStage;

  readonly length: number;
  readonly completeRowCount: number;
  readonly revision: number;

  constructor(
    root: TableRowTreeNode | undefined,
    rootHeight: number,
    prefixLength: number,
    tail: TableRowLeaf | undefined,
    length: number,
    completeRowCount: number,
    revision: number,
    counters?: TableRowIndexCounters,
    counterStage?: TableRowCounterStage,
  ) {
    this.root = root;
    this.rootHeight = rootHeight;
    this.prefixLength = prefixLength;
    this.tail = tail;
    this.length = length;
    this.completeRowCount = completeRowCount;
    this.revision = revision;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
      this.counters = counters;
      if (counterStage !== undefined) this.counterStage = counterStage;
    }
  }

  get(index: number): TableRowRecord | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) return undefined;
    if (index >= this.prefixLength) return this.tail?.rows[index - this.prefixLength];
    return getRow(this.root, this.rootHeight, index);
  }

  readRange(from: number, to: number): readonly TableRowRecord[] {
    assertReadRange(from, to);
    const start = Math.min(from, this.length);
    const end = Math.min(to, this.length);
    if (start >= end) return EMPTY_ROWS;
    const output = new Array<TableRowRecord>(end - start);
    let outputOffset = 0;
    const prefixEnd = Math.min(end, this.prefixLength);
    if (start < prefixEnd && this.root !== undefined) {
      outputOffset = copyRangeFromNode(this.root, this.rootHeight, 0, start, prefixEnd, output, outputOffset);
    }
    if (this.tail !== undefined) {
      const tailStart = Math.max(start, this.prefixLength);
      for (let index = tailStart; index < end; index += 1) {
        const row = this.tail.rows[index - this.prefixLength];
        if (row !== undefined) output[outputOffset++] = row;
      }
    }
    return Object.freeze(output);
  }

  replaceTail(from: number, inputRows: readonly TableRowRecord[]): TableRowIndex {
    let counters: TableRowIndexCounters | undefined;
    let stage: TableRowCounterStage | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters = this.counters;
      stage = this.counterStage;
    }
    if (!Number.isSafeInteger(from) || from < this.completeRowCount || from > this.length) {
      throw new RangeError("Table row tail replacement must start at or after completeRowCount and within the index");
    }
    if (!Array.isArray(inputRows)) throw new TypeError("Table row tail replacement must be an array");

    let normalizedRows: TableRowRecord[] | undefined;
    for (let offset = 0; offset < inputRows.length; offset += 1) {
      const index = from + offset;
      if (!Number.isSafeInteger(index)) throw new RangeError("Table row replacement index exceeds the safe integer range");
      const inputRow = inputRows[offset]!;
      const row = normalizeAndAssertRow(inputRow, index);
      if (row !== inputRow) {
        if (normalizedRows === undefined) {
          normalizedRows = inputRows.slice();
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
            counters.recordRecordSlotsAllocated(inputRows.length, stage);
          }
        }
        normalizedRows[offset] = row;
      }
      if (row.isProvisional && offset !== inputRows.length - 1) {
        throw new RangeError("Only the final table row may be provisional");
      }
    }
    const rows = normalizedRows ?? inputRows;

    const finalLength = from + rows.length;
    if (!Number.isSafeInteger(finalLength)) throw new RangeError("Table row index length exceeds the safe integer range");
    const preservedLast = from > 0 ? this.get(from - 1) : undefined;
    if (preservedLast?.isProvisional && rows.length > 0) {
      throw new RangeError("A provisional table row cannot be followed by another row");
    }
    if (from === this.length && rows.length === 0) return this;

    const finalLast = rows.length > 0 ? rows[rows.length - 1] : preservedLast;
    const completeRowCount = finalLength - (finalLast?.isProvisional ? 1 : 0);
    const oldPageCount = this.prefixLength / LEAF_CAPACITY;
    const prefixPageCount = Math.floor(from / LEAF_CAPACITY);
    const finalPageCount = Math.floor(completeRowCount / LEAF_CAPACITY);
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
            rows,
            firstChangedPage,
            counters,
            stage,
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
            rows,
            firstChangedPage,
          );
    const prefixLength = finalPageCount * LEAF_CAPACITY;
    const tail = finalLength > prefixLength
      ? typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? createTailLeaf(
            this.tail,
            finalPageCount,
            from,
            finalLength,
            rows,
            firstChangedPage,
            counters,
            stage,
          )
        : createTailLeaf(this.tail, finalPageCount, from, finalLength, rows, firstChangedPage)
      : undefined;

    const revision = nextRevision(this.revision);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      return new PersistentTableRowIndex(
        root,
        rootHeight,
        prefixLength,
        tail,
        finalLength,
        completeRowCount,
        revision,
        counters,
        stage,
      );
    }
    return new PersistentTableRowIndex(
      root,
      rootHeight,
      prefixLength,
      tail,
      finalLength,
      completeRowCount,
      revision,
    );
  }

  updateRows(updates: readonly TableRowIndexUpdate[]): TableRowIndex {
    let counters: TableRowIndexCounters | undefined;
    let stage: TableRowCounterStage | undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters = this.counters;
      stage = this.counterStage;
    }
    if (!Array.isArray(updates)) throw new TypeError("Table row updates must be an array");
    if (updates.length === 0) return this;

    const updatedPages = new Map<number, TableRowRecord[]>();
    const changedPages: number[] = [];
    let previousIndex = -1;
    for (const update of updates) {
      if (!Number.isSafeInteger(update.index) || update.index <= previousIndex
        || update.index < 0 || update.index >= this.length) {
        throw new RangeError("Table row updates must have unique ascending in-range indexes");
      }
      previousIndex = update.index;
      const previous = this.get(update.index);
      if (!previous || previous.sourceRevision !== update.expectedSourceRevision) {
        throw new Error(`Stale table row update at index ${update.index}`);
      }
      const row = normalizeAndAssertRow(update.row, update.index);
      if (!sameSourceProjection(previous, row)) {
        throw new RangeError("Table row semantic updates cannot change row source identity or revision");
      }
      const pageIndex = Math.floor(update.index / LEAF_CAPACITY);
      let pageRows = updatedPages.get(pageIndex);
      if (!pageRows) {
        const prefixPageCount = this.prefixLength / LEAF_CAPACITY;
        const page = pageIndex < prefixPageCount
          ? getLeaf(this.root, this.rootHeight, pageIndex)
          : pageIndex === prefixPageCount
            ? this.tail
            : undefined;
        if (!page) throw new Error("Missing table row page for semantic update");
        pageRows = page.rows.slice() as TableRowRecord[];
        updatedPages.set(pageIndex, pageRows);
        changedPages.push(pageIndex);
      }
      pageRows[update.index % LEAF_CAPACITY] = row;
    }

    let root = this.root;
    let tail = this.tail;
    let rootHeight = this.rootHeight;
    const prefixPageCount = this.prefixLength / LEAF_CAPACITY;
    for (const pageIndex of changedPages) {
      const oldPage = pageIndex < prefixPageCount
        ? getLeaf(root, rootHeight, pageIndex)
        : pageIndex === prefixPageCount
          ? tail
          : undefined;
      const rows = updatedPages.get(pageIndex);
      if (!oldPage || !rows) throw new Error("Missing table row page during semantic update");
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
        counters.recordRecordSlotsAllocated(LEAF_CAPACITY, stage);
      }
      const page = makeLeaf(rows, oldPage.used);
      if (pageIndex < prefixPageCount) {
        root = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? setPage(root, rootHeight, 0, pageIndex, page, counters, stage)
          : setPage(root, rootHeight, 0, pageIndex, page);
      } else if (pageIndex === prefixPageCount) {
        tail = page;
      } else {
        throw new Error("Table row semantic update exceeds the active tail");
      }
    }

    const revision = nextRevision(this.revision);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      return new PersistentTableRowIndex(
        root,
        rootHeight,
        this.prefixLength,
        tail,
        this.length,
        this.completeRowCount,
        revision,
        counters,
        stage,
      );
    }
    return new PersistentTableRowIndex(
      root,
      rootHeight,
      this.prefixLength,
      tail,
      this.length,
      this.completeRowCount,
      revision,
    );
  }

  materialize(): readonly TableRowRecord[] {
    return this.readRange(0, this.length);
  }
}

export function createTableRowIndex(
  inputRows: readonly TableRowRecord[] = EMPTY_ROWS,
  options?: object,
): TableRowIndex {
  if (!Array.isArray(inputRows)) throw new TypeError("Initial table rows must be an array");
  let counters: TableRowIndexCounters | undefined;
  let stage: TableRowCounterStage | undefined;
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    const diagnosticOptions = options as TableRowIndexDiagnosticOptions | undefined;
    counters = diagnosticOptions?.campaignCounters;
    stage = diagnosticOptions?.counterStage;
  }
  let normalizedRows: TableRowRecord[] | undefined;
  for (let index = 0; index < inputRows.length; index += 1) {
    const inputRow = inputRows[index]!;
    const row = normalizeAndAssertRow(inputRow, index);
    if (row !== inputRow) {
      if (normalizedRows === undefined) {
        normalizedRows = inputRows.slice();
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
          counters.recordRecordSlotsAllocated(inputRows.length, stage);
        }
      }
      normalizedRows[index] = row;
    }
    if (row.isProvisional && index !== inputRows.length - 1) {
      throw new RangeError("Only the final table row may be provisional");
    }
  }
  const rows = normalizedRows ?? inputRows;
  const completeRowCount = inputRows.length - (rows[rows.length - 1]?.isProvisional ? 1 : 0);
  const prefixLength = Math.floor(completeRowCount / LEAF_CAPACITY) * LEAF_CAPACITY;
  const pageCount = prefixLength / LEAF_CAPACITY;
  const rootHeight = pageCount === 0 ? 0 : treeHeightForPageCount(pageCount);
  const root = pageCount === 0
    ? undefined
    : typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? buildInitialTree(rows, pageCount, rootHeight, 0, counters, stage)
      : buildInitialTree(rows, pageCount, rootHeight, 0);
  const tailLength = rows.length - prefixLength;
  let tail: TableRowLeaf | undefined;
  if (tailLength > 0) {
    const tailRows = new Array<TableRowRecord | undefined>(LEAF_CAPACITY).fill(undefined);
    for (let offset = 0; offset < tailLength; offset += 1) tailRows[offset] = rows[prefixLength + offset];
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && counters !== undefined) {
      counters.recordRecordSlotsAllocated(LEAF_CAPACITY, stage);
    }
    tail = makeLeaf(tailRows, tailLength);
  }
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    return new PersistentTableRowIndex(
      root,
      rootHeight,
      prefixLength,
      tail,
      rows.length,
      completeRowCount,
      0,
      counters,
      stage,
    );
  }
  return new PersistentTableRowIndex(root, rootHeight, prefixLength, tail, rows.length, completeRowCount, 0);
}
