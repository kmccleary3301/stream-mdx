import { AppendSourceDocument, createSourceWindow, type SourceSnapshot } from "./source-document";
import { createTableRowIndex, type TableRowIndex } from "./table-row-index";
import type { Patch } from "./types";
import { freezeTableHeaderRecord } from "./table-records";
import type {
  TableBlockSnapshot,
  TableBlockSourceMetadata,
  TableCellRecord,
  TableHeaderRecord,
  TableRowRecord,
} from "./table-records";
export interface ManagedTableViewState {
  readonly source: TableBlockSourceMetadata;
  readonly header: TableHeaderRecord;
  readonly rows: TableRowIndex;
  readonly sourceSnapshot: SourceSnapshot;
}

declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

interface TableStateWorkCounters {
  recordRecordSlotsAllocated(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordPrefixComparisons(count: number): void;
  recordSourceUnitsRead(count: number): void;
  recordSourceUnitsMaterialized(count: number): void;
  recordSourceDirectoryEntriesCopied(count: number): void;
}

interface ManagedTableStateOptions {
  readonly [option: string]: never;
}

interface ManagedTableSourceOwner {
  readonly document?: AppendSourceDocument;
  readonly completedLength: number;
  readonly counters?: TableStateWorkCounters;
}

const sourceOwnerByState = new WeakMap<ManagedTableViewState, ManagedTableSourceOwner>();

export type ManagedTablePatchResult =
  | { readonly state: ManagedTableViewState }
  | { readonly reason: string };

export function createManagedTableState(
  snapshot: TableBlockSnapshot,
  ownerId: string,
  options?: ManagedTableStateOptions,
  canonicalSource?: SourceSnapshot,
): ManagedTableViewState {
  let counters: TableStateWorkCounters | undefined;
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    counters = (options as { readonly counters?: TableStateWorkCounters } | undefined)?.counters;
  }
  if (
    !snapshot ||
    typeof snapshot.raw !== "string" ||
    snapshot.tableOwnerId !== ownerId ||
    !Array.isArray(snapshot.header?.cells) ||
    !Array.isArray(snapshot.header?.align) ||
    !Array.isArray(snapshot.rows)
  ) {
    throw new RangeError("Table snapshot owner or shape is invalid");
  }
  assertTableSourceMetadata(snapshot, snapshot.raw.length);
  const rows = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? createTableRowIndex(snapshot.rows, { campaignCounters: counters, counterStage: "store" })
    : createTableRowIndex(snapshot.rows);
  if (rows.length !== snapshot.rowCount || rows.completeRowCount !== snapshot.completeRowCount) {
    throw new RangeError("Table snapshot row counts do not match its records");
  }
  const sourceReader = sourceFromString(snapshot.raw);
  assertTableHeader(snapshot.header, snapshot.sourceRange, sourceReader);
  let previousRowEnd = snapshot.header.sourceRange.to;
  for (let index = 0; index < rows.length; index++) {
    const row = rows.get(index);
    if (!row) throw new RangeError("Table snapshot row index is incomplete");
    assertTableRowRecord(row, index, snapshot, snapshot.header.cells.length, sourceReader, snapshot.sourceRange);
    if (row.sourceRange.from < previousRowEnd) throw new RangeError("Table rows overlap or are out of order");
    previousRowEnd = row.sourceRange.to;
  }

  const completedLength = completeTableSourceLength(snapshot, snapshot.header, rows);
  if (completedLength > snapshot.raw.length) throw new RangeError("Completed table source exceeds its raw range");
  let document: AppendSourceDocument | undefined;
  let sourceSnapshot: SourceSnapshot;
  if (canonicalSource) {
    const { from, to } = snapshot.sourceRange;
    if (to > canonicalSource.length || canonicalSource.read(from, to) !== snapshot.raw) {
      throw new RangeError("Table snapshot source does not match canonical input");
    }
    sourceSnapshot = createSourceWindow(canonicalSource, from, to);
  } else {
    document = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? new AppendSourceDocument({ counters } as never)
      : new AppendSourceDocument();
    document.append(snapshot.raw);
    sourceSnapshot = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? createTableSourceSnapshot(document, snapshot.raw.length, counters)
      : createTableSourceSnapshot(document, snapshot.raw.length);
  }
  const owner: ManagedTableSourceOwner = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? { document, completedLength, counters }
    : { document, completedLength };
  return createManagedTableView(snapshot, freezeTableHeaderRecord(snapshot.header), rows, sourceSnapshot, owner);
}

export function appendManagedTableRows(
  current: ManagedTableViewState,
  ownerId: string,
  patch: Extract<Patch, { op: "appendTableRows" }>,
  canonicalSource?: SourceSnapshot,
): ManagedTablePatchResult {
  const old = current.source;
  const next = patch.table;
  const owner = sourceOwnerByState.get(current);
  if (!owner) return { reason: "table source owner is unavailable" };
  if (
    patch.table?.tableOwnerId !== ownerId ||
    patch.table.tableOwnerId !== old.tableOwnerId ||
    patch.table.generation !== old.generation ||
    patch.expectedRevision !== old.revision
  ) return { reason: "stale table owner or revision" };
  if (
    !Number.isSafeInteger(patch.expectedRevision) ||
    !Number.isSafeInteger(patch.fromRow) ||
    patch.fromRow < 0 ||
    typeof patch.sourceAppend !== "string" ||
    !Array.isArray(patch.rows) ||
    !Number.isSafeInteger(next.revision) ||
    next.revision !== old.revision + 1
  ) return { reason: "invalid table append envelope" };

  const nextLength = next.sourceRange.to - next.sourceRange.from;
  const retractingProvisionalTail = isTableProvisionalRetraction(old, next, patch);
  if (old.state !== "open" && !(old.state === "closed" && isTableLifecycleFinalize(old, next, patch))) {
    return { reason: "table owner is not appendable" };
  }
  if (
    next.sourceRange.from !== old.sourceRange.from ||
    (!retractingProvisionalTail && next.sourceRange.to !== old.sourceRange.to + patch.sourceAppend.length) ||
    (retractingProvisionalTail && patch.sourceAppend !== "") ||
    next.processedTo < old.processedTo ||
    next.completeRowCount < old.completeRowCount ||
    next.rowCount < next.completeRowCount
  ) return { reason: "table source frontier regressed" };
  assertTableSourceMetadata(next, nextLength);

  const preservingTail = patch.fromRow === old.rowCount && patch.rows.length === 0;
  if (
    (!preservingTail && patch.fromRow !== old.completeRowCount) ||
    (preservingTail && (
      next.rowCount !== old.rowCount ||
      next.completeRowCount !== old.completeRowCount ||
      next.sourceRange.to !== old.sourceRange.to ||
      patch.sourceAppend !== ""
    )) ||
    (!preservingTail && !retractingProvisionalTail && next.rowCount !== patch.fromRow + patch.rows.length) ||
    (retractingProvisionalTail && next.rowCount !== patch.fromRow)
  ) return { reason: "table append does not begin at the provisional frontier" };
  if (isTableLifecycleFinalize(old, next, patch) && !preservingTail) {
    return { reason: "table lifecycle finalization changed rows or source" };
  }

  const rows = preservingTail ? current.rows : current.rows.replaceTail(patch.fromRow, patch.rows);
  if (rows.length !== next.rowCount || rows.completeRowCount !== next.completeRowCount) {
    return { reason: "table append row counts do not match their records" };
  }
  const sourceReader = sourceForAppend(current, patch.sourceAppend, canonicalSource, next.sourceRange);
  const prefixRowEnd = patch.fromRow === 0
    ? current.header.sourceRange.to
    : current.rows.get(patch.fromRow - 1)?.sourceRange.to;
  if (prefixRowEnd === undefined) return { reason: "table append prefix is unavailable" };
  let previousRowEnd: number = prefixRowEnd;
  for (let offset = 0; offset < patch.rows.length; offset++) {
    const row = patch.rows[offset];
    assertTableRowRecord(row, patch.fromRow + offset, next, current.header.cells.length, sourceReader, next.sourceRange);
    if (row.sourceRange.from < previousRowEnd) return { reason: "table append rows overlap or are out of order" };
    previousRowEnd = row.sourceRange.to;
  }
  if (!preservingTail && !retractingProvisionalTail) {
    const provisionalCount = patch.rows.reduce((count, row) => count + Number(row.isProvisional), 0);
    if (provisionalCount > 1 || (provisionalCount === 1 && !patch.rows[patch.rows.length - 1]?.isProvisional)) {
      return { reason: "table append has an unstable non-tail row" };
    }
  }

  const nextOwner = appendTableSource(
    owner,
    current,
    next,
    rows,
    patch.sourceAppend,
    nextLength,
    retractingProvisionalTail,
    canonicalSource,
  );
  let sourceSnapshot = current.sourceSnapshot;
  if (nextLength !== current.sourceSnapshot.length || patch.sourceAppend !== "") {
    if (canonicalSource) {
      sourceSnapshot = createSourceWindow(canonicalSource, next.sourceRange.from, next.sourceRange.to);
    } else if (nextOwner.document) {
      sourceSnapshot = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? createTableSourceSnapshot(nextOwner.document, nextLength, nextOwner.counters)
        : createTableSourceSnapshot(nextOwner.document, nextLength);
    } else {
      return { reason: "table source document is unavailable" };
    }
  }
  return { state: createManagedTableView(copyTableSource(next), current.header, rows, sourceSnapshot, nextOwner) };
}

export function updateManagedTableRows(
  current: ManagedTableViewState,
  ownerId: string,
  patch: Extract<Patch, { op: "updateTableRows" }>,
): ManagedTablePatchResult {
  const old = current.source;
  const owner = sourceOwnerByState.get(current);
  if (!owner) return { reason: "table source owner is unavailable" };
  if (
    patch.tableOwnerId !== ownerId ||
    patch.tableOwnerId !== old.tableOwnerId ||
    patch.generation !== old.generation ||
    patch.expectedRevision !== old.revision
  ) return { reason: "stale table owner or revision" };
  if (
    !Number.isSafeInteger(patch.expectedRevision) ||
    !Number.isSafeInteger(patch.revision) ||
    patch.revision !== old.revision + 1 ||
    !Array.isArray(patch.updates) ||
    (patch.updates.length === 0 && !patch.header)
  ) return { reason: "invalid table update envelope" };
  if (patch.header && !sameTableHeaderSource(current.header, patch.header)) {
    return { reason: "table header update changed source identity" };
  }
  if (patch.header) assertTableHeader(patch.header, old.sourceRange, current.sourceSnapshot);
  const seen = new Set<number>();
  let previousIndex = -1;
  for (const update of patch.updates) {
    const prior = Number.isSafeInteger(update?.index) && update.index >= 0 ? current.rows.get(update.index) : undefined;
    if (
      !prior ||
      update.index <= previousIndex ||
      seen.has(update.index) ||
      update.expectedSourceRevision !== prior.sourceRevision ||
      !sameTableRowSource(prior, update.row)
    ) return { reason: "stale or source-changing table row update" };
    previousIndex = update.index;
    seen.add(update.index);
  }
  const rows = patch.updates.length === 0 ? current.rows : current.rows.updateRows(patch.updates);
  const source = { ...old, revision: patch.revision };
  const header = patch.header ? freezeTableHeaderRecord(patch.header) : current.header;
  const view = createManagedTableView(source, header, rows, current.sourceSnapshot, owner);
  return { state: view };
}

export function materializeManagedTableSnapshot(state: ManagedTableViewState): TableBlockSnapshot {
  return {
    ...copyTableSource(state.source),
    header: state.header,
    rows: state.rows.materialize(),
    raw: state.sourceSnapshot.materialize(),
  };
}

interface TableSourceReader {
  readonly length: number;
  read(from: number, to: number): string;
}

function sourceFromString(source: string): TableSourceReader {
  return {
    length: source.length,
    read(from, to) {
      const start = Math.max(0, from);
      const end = Math.min(source.length, to);
      return start >= end ? "" : source.slice(start, end);
    },
  };
}

function completeTableSourceLength(
  source: TableBlockSourceMetadata,
  header: TableHeaderRecord,
  rows: TableRowIndex,
): number {
  const lastCompleteRow = source.completeRowCount > 0 ? rows.get(source.completeRowCount - 1) : undefined;
  const end = lastCompleteRow?.sourceRange.to ?? header.sourceRange.to;
  const length = end - source.sourceRange.from;
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Completed table source range is invalid");
  return length;
}

function createManagedTableView(
  source: TableBlockSourceMetadata,
  header: TableHeaderRecord,
  rows: TableRowIndex,
  sourceSnapshot: SourceSnapshot,
  owner: ManagedTableSourceOwner,
): ManagedTableViewState {
  const immutableSource = copyTableSource(source);
  Object.freeze(immutableSource.sourceRange);
  Object.freeze(immutableSource);
  const view = Object.freeze({ source: immutableSource, header, rows, sourceSnapshot });
  sourceOwnerByState.set(view, owner);
  return view;
}

function createTableSourceSnapshot(
  document: AppendSourceDocument,
  ownedLength: number,
  counters?: TableStateWorkCounters,
): SourceSnapshot {
  const backing = document.snapshot();
  if (ownedLength > backing.length) throw new RangeError("Table source snapshot exceeds its retained source log");
  let cachedSource: string | undefined;
  return Object.freeze({
    lineChunks: true as const,
    length: ownedLength,
    chunk(from: number): string {
      const start = Math.max(0, from);
      if (start >= ownedLength) return "";
      return backing.chunk(start).slice(0, ownedLength - start);
    },
    read(from: number, to: number): string {
      const start = Math.max(0, from);
      const end = Math.min(ownedLength, to);
      return start >= end ? "" : backing.read(start, end);
    },
    materialize(): string {
      if (cachedSource !== undefined) return cachedSource;
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        counters?.recordSourceUnitsMaterialized(ownedLength);
      }
      cachedSource = backing.read(0, ownedLength);
      return cachedSource;
    },
  });
}

function isTableProvisionalRetraction(
  old: TableBlockSourceMetadata,
  next: TableBlockSourceMetadata,
  patch: Extract<Patch, { op: "appendTableRows" }>,
): boolean {
  return old.state === "open" &&
    next.state !== "finalized" &&
    patch.sourceAppend === "" &&
    patch.rows.length === 0 &&
    patch.fromRow === old.completeRowCount &&
    old.rowCount === old.completeRowCount + 1 &&
    next.completeRowCount === old.completeRowCount &&
    next.rowCount === old.completeRowCount &&
    next.sourceRange.from === old.sourceRange.from &&
    next.sourceRange.to < old.sourceRange.to;
}

function appendTableSource(
  owner: ManagedTableSourceOwner,
  current: ManagedTableViewState,
  nextSource: TableBlockSourceMetadata,
  nextRows: TableRowIndex,
  sourceAppend: string,
  nextLength: number,
  retractingProvisionalTail: boolean,
  canonicalSource?: SourceSnapshot,
): ManagedTableSourceOwner {
  const completedLength = completeTableSourceLength(nextSource, current.header, nextRows);
  if (
    completedLength < owner.completedLength ||
    completedLength > nextLength ||
    nextLength < completedLength
  ) throw new RangeError("Completed table source frontier is invalid");

  if (canonicalSource) {
    if (nextLength < current.sourceSnapshot.length) {
      if (
        !retractingProvisionalTail ||
        sourceAppend !== "" ||
        nextLength < owner.completedLength ||
        completedLength !== owner.completedLength
      ) throw new RangeError("Table source can only retract its provisional tail");
    } else if (nextLength !== current.sourceSnapshot.length + sourceAppend.length) {
      throw new RangeError("Table source append length is inconsistent");
    }
    if (
      sourceAppend.length > 0 &&
      (
        nextSource.sourceRange.to > canonicalSource.length ||
        canonicalSource.read(current.source.sourceRange.to, nextSource.sourceRange.to) !== sourceAppend
      )
    ) throw new RangeError("Table source append does not match canonical input");
    return typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? { document: undefined, completedLength, counters: owner.counters }
      : { document: undefined, completedLength };
  }

  const document = owner.document;
  if (!document) throw new RangeError("Table source document is unavailable");
  const logSnapshot = document.snapshot();
  if (logSnapshot.length < current.sourceSnapshot.length) {
    throw new RangeError("Table source log is shorter than its owned prefix");
  }
  if (nextLength < current.sourceSnapshot.length) {
    if (
      !retractingProvisionalTail ||
      sourceAppend !== "" ||
      nextLength < owner.completedLength ||
      completedLength !== owner.completedLength
    ) throw new RangeError("Table source can only retract its provisional tail");
    return owner;
  }
  if (nextLength !== current.sourceSnapshot.length + sourceAppend.length) {
    throw new RangeError("Table source append length is inconsistent");
  }

  const overlapLength = Math.min(sourceAppend.length, logSnapshot.length - current.sourceSnapshot.length);
  if (
    overlapLength > 0 &&
    logSnapshot.read(current.sourceSnapshot.length, current.sourceSnapshot.length + overlapLength) !==
      sourceAppend.slice(0, overlapLength)
  ) throw new RangeError("Table source re-extension changed retained provisional bytes");

  const neverLoggedSuffix = sourceAppend.slice(overlapLength);
  if (logSnapshot.length + neverLoggedSuffix.length < nextLength) {
    throw new RangeError("Table source append cannot reach its declared frontier");
  }
  if (neverLoggedSuffix.length > 0) document.append(neverLoggedSuffix);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    return { document, completedLength, counters: owner.counters };
  }
  return { document, completedLength };
}
function copyTableSource(source: TableBlockSourceMetadata): TableBlockSourceMetadata {
  return {
    tableOwnerId: source.tableOwnerId,
    generation: source.generation,
    revision: source.revision,
    state: source.state,
    processedTo: source.processedTo,
    completeRowCount: source.completeRowCount,
    rowCount: source.rowCount,
    sourceRange: { from: source.sourceRange.from, to: source.sourceRange.to },
  };
}

function assertTableSourceMetadata(source: TableBlockSourceMetadata, rawLength: number): void {
  const range = source.sourceRange;
  if (
    typeof source.tableOwnerId !== "string" ||
    source.tableOwnerId.length === 0 ||
    !Number.isSafeInteger(source.generation) ||
    source.generation < 0 ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 0 ||
    !Number.isSafeInteger(source.processedTo) ||
    source.processedTo < 0 ||
    !Number.isSafeInteger(source.completeRowCount) ||
    source.completeRowCount < 0 ||
    !Number.isSafeInteger(source.rowCount) ||
    source.rowCount < source.completeRowCount ||
    (source.state !== "open" && source.state !== "closed" && source.state !== "finalized") ||
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 0 ||
    range.to < range.from ||
    range.to - range.from !== rawLength
  ) throw new RangeError("Table source metadata is invalid");
}

function isValidRange(range: { from: number; to: number }, within: { from: number; to: number }): boolean {
  return Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to) &&
    range.from >= within.from && range.to >= range.from && range.to <= within.to;
}

function assertTableCellRecord(
  cell: TableCellRecord,
  index: number,
  within: { from: number; to: number },
  sourceRange: { from: number; to: number },
  source: TableSourceReader,
  expectedId?: string,
): void {
  if (
    !cell ||
    typeof cell.id !== "string" ||
    cell.id.length === 0 ||
    (expectedId !== undefined && cell.id !== expectedId) ||
    cell.index !== index ||
    typeof cell.raw !== "string" ||
    !Array.isArray(cell.inline) ||
    !isValidRange(cell.sourceRange, within) ||
    !isValidRange(cell.sourceRange, sourceRange) ||
    cell.sourceRange.to - cell.sourceRange.from !== cell.raw.length ||
    source.read(cell.sourceRange.from - sourceRange.from, cell.sourceRange.to - sourceRange.from) !== cell.raw
  ) throw new RangeError("Table cell identity or source range is invalid");
}

function assertTableHeader(
  header: TableHeaderRecord,
  sourceRange: { from: number; to: number },
  source: TableSourceReader,
): void {
  if (
    !isValidRange(header.sourceRange, sourceRange) ||
    header.cells.length !== header.align.length ||
    header.align.some((align) => align !== null && align !== "left" && align !== "center" && align !== "right")
  ) throw new RangeError("Table header shape is invalid");
  for (let index = 0; index < header.cells.length; index++) {
    assertTableCellRecord(header.cells[index], index, header.sourceRange, sourceRange, source);
  }
}

function assertTableRowRecord(
  row: TableRowRecord,
  index: number,
  source: TableBlockSourceMetadata,
  columnCount: number,
  sourceReader: TableSourceReader,
  tableRange: { from: number; to: number },
): void {
  if (
    !row ||
    row.id !== `${source.tableOwnerId}::row:${index}` ||
    row.index !== index ||
    !Number.isSafeInteger(row.sourceRevision) ||
    row.sourceRevision < 0 ||
    row.sourceRevision > source.revision ||
    typeof row.isProvisional !== "boolean" ||
    !Array.isArray(row.cells) ||
    row.cells.length !== columnCount ||
    !isValidRange(row.sourceRange, tableRange)
  ) throw new RangeError("Table row identity or source range is invalid");
  for (let column = 0; column < row.cells.length; column++) {
    assertTableCellRecord(
      row.cells[column],
      column,
      row.sourceRange,
      tableRange,
      sourceReader,
      `${row.id}::cell:${column}`,
    );
  }
}

function sourceForAppend(
  current: ManagedTableViewState,
  sourceAppend: string,
  canonicalSource: SourceSnapshot | undefined,
  nextRange: { readonly from: number; readonly to: number },
): TableSourceReader {
  if (canonicalSource) return createSourceWindow(canonicalSource, nextRange.from, nextRange.to);
  const prior = current.sourceSnapshot;
  return {
    length: prior.length + sourceAppend.length,
    read(from, to) {
      const start = Math.max(0, from);
      const end = Math.min(prior.length + sourceAppend.length, to);
      if (start >= end) return "";
      if (start >= prior.length) return sourceAppend.slice(start - prior.length, end - prior.length);
      if (end <= prior.length) return prior.read(start, end);
      return prior.read(start, prior.length) + sourceAppend.slice(0, end - prior.length);
    },
  };
}
function isTableLifecycleFinalize(
  old: TableBlockSourceMetadata,
  next: TableBlockSourceMetadata,
  patch: Extract<Patch, { op: "appendTableRows" }>,
): boolean {
  return old.state === "closed" &&
    next.state === "finalized" &&
    patch.sourceAppend === "" &&
    patch.rows.length === 0 &&
    patch.fromRow === old.rowCount &&
    next.processedTo === old.processedTo &&
    next.completeRowCount === old.completeRowCount &&
    next.rowCount === old.rowCount &&
    next.sourceRange.from === old.sourceRange.from &&
    next.sourceRange.to === old.sourceRange.to;
}

function sameTableRowSource(prior: TableRowRecord, next: TableRowRecord): boolean {
  if (
    !next ||
    !next.sourceRange ||
    !Array.isArray(next.cells) ||
    prior.id !== next.id ||
    prior.index !== next.index ||
    prior.sourceRevision !== next.sourceRevision ||
    prior.isProvisional !== next.isProvisional ||
    prior.sourceRange.from !== next.sourceRange.from ||
    prior.sourceRange.to !== next.sourceRange.to ||
    prior.cells.length !== next.cells.length
  ) return false;
  for (let index = 0; index < prior.cells.length; index++) {
    const oldCell = prior.cells[index];
    const newCell = next.cells[index];
    if (
      !newCell ||
      !newCell.sourceRange ||
      oldCell.id !== newCell.id ||
      oldCell.index !== newCell.index ||
      oldCell.raw !== newCell.raw ||
      oldCell.sourceRange.from !== newCell.sourceRange.from ||
      !Array.isArray(newCell.inline) ||
      oldCell.sourceRange.to !== newCell.sourceRange.to
    ) return false;
  }
  return true;
}

function sameTableHeaderSource(prior: TableHeaderRecord, next: TableHeaderRecord): boolean {
  if (
    !next ||
    !next.sourceRange ||
    !Array.isArray(next.cells) ||
    !Array.isArray(next.align) ||
    prior.sourceRange.from !== next.sourceRange.from ||
    prior.sourceRange.to !== next.sourceRange.to ||
    prior.cells.length !== next.cells.length ||
    prior.align.length !== next.align.length ||
    prior.align.some((align, index) => align !== next.align[index])
  ) return false;
  for (let index = 0; index < prior.cells.length; index++) {
    const oldCell = prior.cells[index];
    const newCell = next.cells[index];
    if (
      !newCell ||
      !newCell.sourceRange ||
      oldCell.id !== newCell.id ||
      oldCell.index !== newCell.index ||
      oldCell.raw !== newCell.raw ||
      oldCell.sourceRange.from !== newCell.sourceRange.from ||
      oldCell.sourceRange.to !== newCell.sourceRange.to ||
      !Array.isArray(newCell.inline)
    ) return false;
  }
  return true;
}
