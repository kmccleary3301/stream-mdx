import type { MarkdownParser } from "@lezer/markdown";
import {
  createTableRowIndex,
  freezeTableBlockSnapshot,
  freezeTableCellRecord,
  freezeTableHeaderRecord,
  freezeTableRowRecord,
  type AppendSourceDocument,
  type Block,
  type InlineNode,
  type InlineParser,
  type TableBlockSnapshot,
  type TableBlockSourceMetadata,
  type TableCellRecord,
  type TableHeaderRecord,
  type TableRowIndex,
  type TableRowIndexUpdate,
  type TableRowRecord,
} from "@stream-mdx/core";
import {
  NativeTableRowClassifier,
  type NativeTableExtensionContext,
  type NativeTableRowClassifierChange,
  type NativeTableRowClassifierCounters,
  type NativeTableRowSpan,
} from "./native-table-row-classifier";
import { createNativeTableRowRecord } from "./native-table-projection";

declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

export type RootTableSourceOwnerState = "open" | "closed" | "finalized";

type RootTableCounterStage = "engine" | "snapshot" | "patch" | "store" | "view";

export interface RootTableSourceOwnerCounters extends NativeTableRowClassifierCounters {
  recordInlineSourceUnits(count: number, stage?: RootTableCounterStage): void;
  recordRecordSlotsAllocated(count: number, stage?: RootTableCounterStage): void;
  recordSourceUnitsMaterialized(count: number, stage?: RootTableCounterStage): void;
  recordInvalidation(cause: string, blockId: string, fields?: string[]): void;
}

export interface RootTableSourceOpening {
  readonly from: number;
  readonly bodyFrom: number;
  readonly sourceRangeEnd: number;
  readonly header: TableHeaderRecord;
  readonly columnCount: number;
  readonly extensionContext: NativeTableExtensionContext;
}

export interface RootTableSourceOwnerOptions {
  readonly id: string;
  readonly containerId?: string;
  readonly generation: number;
  readonly source: AppendSourceDocument;
  readonly parser: MarkdownParser;
  readonly inlineParser: InlineParser;
  readonly opening: RootTableSourceOpening;
  readonly initialCellAttempts?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly counters?: RootTableSourceOwnerCounters;
}

export interface RootTableSourceMetadata extends TableBlockSourceMetadata {}

export interface RootTableSourceChange {
  readonly table: RootTableSourceMetadata;
  readonly expectedRevision: number;
  readonly fromRow: number;
  readonly rows: readonly TableRowRecord[];
  readonly sourceAppend: string;
  /** Native root-parser continuation only; never part of a semantic table patch. */
  readonly rootResumeFrom?: number;
}

export interface RootTableSemanticChange {
  readonly tableOwnerId: string;
  readonly generation: number;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly updates: readonly TableRowIndexUpdate[];
  readonly header?: TableHeaderRecord;
}

export interface RootTableFootnoteProjection {
  readonly block: Block;
  readonly headerCellIds: readonly string[];
  readonly rows: readonly {
    readonly rowIndex: number;
    readonly cellIds: readonly string[];
  }[];
}

interface CellLocation {
  readonly rowIndex: number | null;
  readonly columnIndex: number;
}

interface InlineMeaningUpdate {
  readonly cellId: string;
  readonly inline: readonly InlineNode[];
}

function nextRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) throw new RangeError("Root table owner revision exceeds the safe integer range");
  return next;
}
const EMPTY_REFERENCE_LABELS: ReadonlySet<string> = new Set();

function inlineValueEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!inlineValueEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)
      || !inlineValueEqual(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

function hasFootnoteReference(nodes: readonly InlineNode[]): boolean {
  for (const node of nodes) {
    if (node.kind === "footnote-ref") return true;
    if ("children" in node && Array.isArray(node.children) && hasFootnoteReference(node.children)) return true;
  }
  return false;
}

function cellInline(cell: TableCellRecord): InlineNode[] {
  return cell.inline as InlineNode[];
}

export class RootTableSourceOwner {
  readonly id: string;
  readonly containerId?: string;
  readonly generation: number;
  readonly columnCount: number;

  private readonly source: AppendSourceDocument;
  private readonly tableFrom: number;
  private readonly inlineParser: InlineParser;
  private readonly classifier: NativeTableRowClassifier;
  private header: TableHeaderRecord;
  private rowIndex: TableRowIndex;
  private state: RootTableSourceOwnerState = "open";
  private revision = 0;
  private processedTo: number;
  private sourceRangeEnd: number;
  private readonly initialSourceRangeEnd: number;
  private cachedBlock: { readonly revision: number; readonly block: Block } | undefined;
  private readonly cellLocations = new Map<string, CellLocation>();
  private readonly cellAttempts = new Map<string, ReadonlySet<string>>();
  private readonly cellsByReference = new Map<string, Set<string>>();
  private readonly footnoteRows = new Map<number, readonly { readonly cellId: string; readonly columnIndex: number }[]>();
  private headerFootnoteCells: Array<{ readonly cellId: string; readonly columnIndex: number }> = [];
  private declare counters?: RootTableSourceOwnerCounters;

  constructor(options: RootTableSourceOwnerOptions) {
    const { id, generation, source, parser, inlineParser, opening } = options;
    if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError("Root table owner generation must be a non-negative safe integer");
    if (!Number.isSafeInteger(opening.from) || opening.from < 0
      || !Number.isSafeInteger(opening.bodyFrom) || opening.bodyFrom < opening.from
      || opening.bodyFrom > source.length
      || !Number.isSafeInteger(opening.sourceRangeEnd) || opening.sourceRangeEnd < opening.from) {
      throw new RangeError("Root table opening offsets must be ordered source ranges");
    }
    if (!Number.isSafeInteger(opening.columnCount) || opening.columnCount < 1
      || opening.header.cells.length !== opening.columnCount
      || opening.header.align.length !== opening.columnCount) {
      throw new RangeError("Root table opening must have one native header and alignment per column");
    }

    this.id = id;
    this.containerId = options.containerId;
    this.generation = generation;
    this.source = source;
    this.tableFrom = opening.from;
    this.inlineParser = inlineParser;
    this.header = opening.header;
    this.columnCount = opening.columnCount;
    this.processedTo = opening.bodyFrom;
    this.sourceRangeEnd = opening.sourceRangeEnd;
    this.initialSourceRangeEnd = opening.sourceRangeEnd;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters = options.counters;
      const diagnosticOptions = {
        campaignCounters: this.counters,
        counterStage: "engine" as const,
      };
      this.rowIndex = createTableRowIndex([], diagnosticOptions);
    } else {
      this.rowIndex = createTableRowIndex();
    }
    for (let columnIndex = 0; columnIndex < this.header.cells.length; columnIndex += 1) {
      const cell = this.header.cells[columnIndex];
      if (!cell) continue;
      this.cellLocations.set(cell.id, { rowIndex: null, columnIndex });
      this.installCellAttempts(cell.id, options.initialCellAttempts?.get(cell.id) ?? EMPTY_REFERENCE_LABELS);
      if (hasFootnoteReference(cell.inline)) this.headerFootnoteCells.push({ cellId: cell.id, columnIndex });
    }
    this.classifier = new NativeTableRowClassifier({
      parser,
      columnCount: opening.columnCount,
      bodyFrom: opening.bodyFrom,
      extensionContext: opening.extensionContext,
      tableFrom: opening.from,
      ...(typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? { counters: options.counters }
        : {}),
    });
  }

  getMetadata(): RootTableSourceMetadata {
    return Object.freeze({
      tableOwnerId: this.id,
      generation: this.generation,
      revision: this.revision,
      state: this.state,
      processedTo: this.processedTo,
      completeRowCount: this.rowIndex.completeRowCount,
      rowCount: this.rowIndex.length,
      sourceRange: Object.freeze({ from: this.tableFrom, to: this.sourceRangeEnd }),
    });
  }

  getHeader(): TableHeaderRecord {
    return this.header;
  }

  getRows(): TableRowIndex {
    return this.rowIndex;
  }

  accept(from: number, to: number): RootTableSourceChange {
    if (this.state !== "open") throw new Error(`Cannot accept source for a ${this.state} root table owner`);
    this.validateAcceptanceRange(from, to);
    return this.acceptClassifiedRows(this.classifier.accept(this.source.snapshot(), from, to));
  }

  admitNativeRows(
    from: number,
    to: number,
    rows: readonly NativeTableRowSpan[],
    state: RootTableSourceOwnerState,
    actualInterruptFrom?: number,
  ): RootTableSourceChange {
    if (this.state !== "open") throw new Error(`Cannot accept source for a ${this.state} root table owner`);
    this.validateAcceptanceRange(from, to);
    const change = this.classifier.admitNativeRows(
      this.source.snapshot(),
      from,
      to,
      rows,
      state,
      actualInterruptFrom,
    );
    return this.acceptClassifiedRows(change);
  }

  private validateAcceptanceRange(from: number, to: number): void {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)
      || from !== this.processedTo || to < from || to > this.source.length) {
      throw new RangeError("Root table source acceptance must continue at processedTo within the source document");
    }
  }

  private acceptClassifiedRows(change: NativeTableRowClassifierChange): RootTableSourceChange {
    return this.consume(change);
  }

  finalize(): RootTableSourceChange {
    if (this.state === "finalized") return this.noChange();
    if (this.state === "closed") {
      const expectedRevision = this.revision;
      this.state = "finalized";
      this.revision = nextRevision(this.revision);
      this.cachedBlock = undefined;
      return this.change(expectedRevision, this.rowIndex.length, [], "");
    }
    return this.consume(this.classifier.finalize(this.source.snapshot(), this.processedTo, this.source.length));
  }

  invalidateLinkReferences(labels: ReadonlySet<string>): RootTableSemanticChange | null {
    if (labels.size === 0) return null;
    const targetIds = new Set<string>();
    for (const label of labels) {
      const ids = this.cellsByReference.get(label);
      if (!ids) continue;
      for (const id of ids) targetIds.add(id);
    }
    if (targetIds.size === 0) return null;

    const ordered = Array.from(targetIds);
    ordered.sort((left, right) => {
      const leftLocation = this.cellLocations.get(left);
      const rightLocation = this.cellLocations.get(right);
      const leftRow = leftLocation?.rowIndex ?? -1;
      const rightRow = rightLocation?.rowIndex ?? -1;
      return leftRow - rightRow || (leftLocation?.columnIndex ?? 0) - (rightLocation?.columnIndex ?? 0);
    });
    const updates: InlineMeaningUpdate[] = [];
    for (const cellId of ordered) {
      const cell = this.cellForId(cellId);
      if (!cell) continue;
      const attempted = new Set<string>();
      const inline = this.inlineParser.parse(cell.raw, {
        onAttemptedReference: (label) => attempted.add(label),
      });
      this.installCellAttempts(cellId, attempted);
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        this.counters?.recordInlineSourceUnits(cell.raw.length, "engine");
      }
      if (!inlineValueEqual(cell.inline, inline)) updates.push({ cellId, inline });
    }
    return this.applyInlineMeaning(updates, "link_reference_definition");
  }

  getFootnoteProjection(): RootTableFootnoteProjection | null {
    if (this.headerFootnoteCells.length === 0 && this.footnoteRows.size === 0) return null;
    const headerCellIds = this.headerFootnoteCells.map((entry) => entry.cellId);
    const header = this.headerFootnoteCells.map((entry) => {
      const cell = this.header.cells[entry.columnIndex];
      return cell ? cellInline(cell) : [];
    });
    const rows: Array<{ readonly rowIndex: number; readonly cellIds: readonly string[] }> = [];
    const projectedRows: InlineNode[][][] = [];
    const footnoteRows = Array.from(this.footnoteRows.entries()).sort((left, right) => left[0] - right[0]);
    for (const [rowIndex, entries] of footnoteRows) {
      const row = this.rowIndex.get(rowIndex);
      if (!row) continue;
      rows.push({ rowIndex, cellIds: entries.map((entry) => entry.cellId) });
      projectedRows.push(entries.map((entry) => {
        const cell = row.cells[entry.columnIndex];
        return cell ? cellInline(cell) : [];
      }));
    }
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters?.recordRecordSlotsAllocated(header.length + projectedRows.length, "engine");
    }
    return {
      block: {
        id: this.id,
        type: "table",
        isFinalized: this.state !== "open",
        payload: {
          raw: "",
          meta: { header, align: this.header.align, rows: projectedRows },
          range: { from: this.tableFrom, to: this.sourceRangeEnd },
        },
      },
      headerCellIds,
      rows,
    };
  }

  applyFootnoteProjection(projection: RootTableFootnoteProjection): RootTableSemanticChange | null {
    const meta = projection.block.payload.meta;
    if (!meta || !Array.isArray(meta.header) || !Array.isArray(meta.rows)) return null;
    const updates: InlineMeaningUpdate[] = [];
    const header = meta.header as InlineNode[][];
    for (let index = 0; index < projection.headerCellIds.length; index += 1) {
      const cellId = projection.headerCellIds[index];
      const inline = header[index];
      if (cellId && Array.isArray(inline)) updates.push({ cellId, inline });
    }
    const rows = meta.rows as InlineNode[][][];
    for (let row = 0; row < projection.rows.length; row += 1) {
      const mapping = projection.rows[row];
      const inlineRow = rows[row];
      if (!mapping || !inlineRow) continue;
      for (let column = 0; column < mapping.cellIds.length; column += 1) {
        const cellId = mapping.cellIds[column];
        const inline = inlineRow[column];
        if (cellId && Array.isArray(inline)) updates.push({ cellId, inline });
      }
    }
    return this.applyInlineMeaning(updates, "footnote_reference_numbering");
  }

  materializeBlock(includeTableMetadata = true, tableSnapshot?: TableBlockSnapshot): Block {
    if (includeTableMetadata && this.cachedBlock?.revision === this.revision) return this.cachedBlock.block;
    const metadata = this.getMetadata();
    const raw = tableSnapshot?.raw ?? this.source.snapshot().read(this.tableFrom, metadata.sourceRange.to);
    const rows = includeTableMetadata ? this.rowIndex.materialize() : [];
    const block: Block = {
      id: this.id,
      type: "table",
      isFinalized: this.state !== "open",
      payload: {
        raw,
        meta: {
          lezerNodeType: "Table",
          ...(includeTableMetadata ? {
            header: this.header.cells.map((cell) => cellInline(cell)),
            align: this.header.align.slice(),
            rows: rows.map((row) => row.cells.map((cell) => cellInline(cell))),
          } : {}),
        },
        range: { ...metadata.sourceRange },
      },
    };
    if (includeTableMetadata) this.cachedBlock = { revision: this.revision, block };
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && !tableSnapshot) {
      this.counters?.recordSourceUnitsMaterialized(raw.length, "snapshot");
    }
    return block;
  }

  createSnapshot(): TableBlockSnapshot {
    const metadata = this.getMetadata();
    const source = this.source.snapshot();
    const raw = source.read(this.tableFrom, metadata.sourceRange.to);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters?.recordSourceUnitsMaterialized(raw.length, "snapshot");
    }
    return freezeTableBlockSnapshot({
      ...metadata,
      header: this.header,
      rows: this.rowIndex.materialize(),
      raw,
    });
  }

  private consume(change: NativeTableRowClassifierChange): RootTableSourceChange {
    const previous = this.getMetadata();
    const source = this.source.snapshot();
    const fromRow = previous.completeRowCount;
    if (change.fromRow !== fromRow) {
      throw new Error("Native table row classifier frontier does not match the row index");
    }
    const previousTail = this.rowIndex.readRange(fromRow, this.rowIndex.length);
    const spans = change.provisionalRow
      ? [...change.completeRows, change.provisionalRow]
      : change.completeRows;
    const rows = new Array<TableRowRecord>(spans.length);
    if (spans.length > 0
      && typeof __STREAM_MDX_COUNTERS__ !== "undefined"
      && __STREAM_MDX_COUNTERS__
      && this.counters !== undefined) {
      this.counters.recordRecordSlotsAllocated(spans.length, "engine");
    }
    for (let offset = 0; offset < spans.length; offset += 1) {
      const span = spans[offset];
      if (!span) continue;
      const prior = this.rowIndex.get(span.index);
      rows[offset] = createNativeTableRowRecord(
        span,
        this.id,
        this.columnCount,
        source,
        this.inlineParser,
        prior,
        (cellId, labels, sourceUnits) => this.recordPreparedCell(cellId, labels, sourceUnits),
      );
    }
    const sourceRowsChanged = rows.length !== previousTail.length
      || rows.some((row, offset) => row !== previousTail[offset]);
    if (sourceRowsChanged) {
      const nextRowIndexes = new Set(rows.map((row) => row.index));
      for (const previousRow of previousTail) {
        if (!nextRowIndexes.has(previousRow.index)) this.removeRowDependencies(previousRow);
      }
      this.rowIndex = this.rowIndex.replaceTail(fromRow, rows);
    }
    for (const row of rows) this.installRowDependencies(row);

    const lastIndexedRow = this.rowIndex.get(this.rowIndex.length - 1);
    const tableEnd = lastIndexedRow?.sourceRange.to ?? this.initialSourceRangeEnd;
    const nextProcessedTo = change.acceptedTo;
    const nextState = change.state;
    const metadataChanged = nextProcessedTo !== this.processedTo
      || nextState !== this.state
      || tableEnd !== this.sourceRangeEnd
      || sourceRowsChanged;
    const expectedRevision = this.revision;
    if (metadataChanged) this.revision = nextRevision(this.revision);
    this.processedTo = nextProcessedTo;
    this.state = nextState;
    this.sourceRangeEnd = tableEnd;
    if (metadataChanged) this.cachedBlock = undefined;

    const patchRows = sourceRowsChanged ? rows : [];
    const patchFromRow = patchRows.length > 0 ? fromRow : this.rowIndex.length;
    const sourceAppend = tableEnd > previous.sourceRange.to
      ? source.read(previous.sourceRange.to, tableEnd)
      : "";
    const rootResumeFrom = previous.state === "open" ? change.remainderFrom : undefined;
    return this.change(expectedRevision, patchFromRow, patchRows, sourceAppend, rootResumeFrom);
  }

  private applyInlineMeaning(
    updates: readonly InlineMeaningUpdate[],
    cause: "link_reference_definition" | "footnote_reference_numbering",
  ): RootTableSemanticChange | null {
    if (updates.length === 0) return null;
    const expectedRevision = this.revision;
    let headerCells: TableCellRecord[] | undefined;
    const rowCells = new Map<number, { readonly row: TableRowRecord; readonly cells: TableCellRecord[] }>();
    for (const update of updates) {
      const location = this.cellLocations.get(update.cellId);
      if (!location) continue;
      const current = this.cellForId(update.cellId);
      if (!current || inlineValueEqual(current.inline, update.inline)) continue;
      const nextCell = freezeTableCellRecord({ ...current, inline: update.inline });
      if (location.rowIndex === null) {
        headerCells ??= this.header.cells.slice();
        headerCells[location.columnIndex] = nextCell;
        continue;
      }
      let rowUpdate = rowCells.get(location.rowIndex);
      if (!rowUpdate) {
        const row = this.rowIndex.get(location.rowIndex);
        if (!row) continue;
        rowUpdate = { row, cells: row.cells.slice() as TableCellRecord[] };
        rowCells.set(location.rowIndex, rowUpdate);
      }
      rowUpdate.cells[location.columnIndex] = nextCell;
    }
    if (!headerCells && rowCells.size === 0) return null;

    const header = headerCells
      ? freezeTableHeaderRecord({ ...this.header, cells: headerCells })
      : undefined;
    const rowUpdates: TableRowIndexUpdate[] = [];
    const patchUpdates: TableRowIndexUpdate[] = [];
    const sortedRows = Array.from(rowCells.keys()).sort((left, right) => left - right);
    for (const index of sortedRows) {
      const rowUpdate = rowCells.get(index);
      if (!rowUpdate) continue;
      const row = freezeTableRowRecord({ ...rowUpdate.row, cells: rowUpdate.cells });
      const update = { index, expectedSourceRevision: rowUpdate.row.sourceRevision, row };
      rowUpdates.push(update);
      patchUpdates.push(update);
    }
    if (rowUpdates.length > 0) {
      this.rowIndex = this.rowIndex.updateRows(rowUpdates);
      for (const update of rowUpdates) this.installRowDependencies(update.row);
    }
    if (header) {
      this.header = header;
      this.headerFootnoteCells.length = 0;
      for (let columnIndex = 0; columnIndex < header.cells.length; columnIndex += 1) {
        const cell = header.cells[columnIndex];
        if (cell && hasFootnoteReference(cell.inline)) this.headerFootnoteCells.push({ cellId: cell.id, columnIndex });
      }
    }
    this.revision = nextRevision(this.revision);
    this.cachedBlock = undefined;

    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      if (header) this.counters?.recordInvalidation(cause, this.id, ["table.header"]);
      for (const _index of sortedRows) this.counters?.recordInvalidation(cause, this.id, ["table.rows"]);
    }
    return {
      tableOwnerId: this.id,
      generation: this.generation,
      expectedRevision,
      revision: this.revision,
      updates: patchUpdates,
      ...(header ? { header } : {}),
    };
  }

  private cellForId(cellId: string): TableCellRecord | undefined {
    const location = this.cellLocations.get(cellId);
    if (!location) return undefined;
    return location.rowIndex === null
      ? this.header.cells[location.columnIndex]
      : this.rowIndex.get(location.rowIndex)?.cells[location.columnIndex];
  }

  private recordPreparedCell(cellId: string, labels: ReadonlySet<string>, sourceUnits: number): void {
    this.installCellAttempts(cellId, labels);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters?.recordInlineSourceUnits(sourceUnits, "engine");
    }
  }

  private installCellAttempts(cellId: string, labels: ReadonlySet<string>): void {
    const previous = this.cellAttempts.get(cellId);
    if (previous) {
      for (const label of previous) {
        const ids = this.cellsByReference.get(label);
        ids?.delete(cellId);
        if (ids?.size === 0) this.cellsByReference.delete(label);
      }
    }
    if (labels.size === 0) {
      this.cellAttempts.delete(cellId);
      return;
    }
    const next = new Set(labels);
    this.cellAttempts.set(cellId, next);
    for (const label of next) {
      let ids = this.cellsByReference.get(label);
      if (!ids) {
        ids = new Set();
        this.cellsByReference.set(label, ids);
      }
      ids.add(cellId);
    }
  }

  private installRowDependencies(row: TableRowRecord): void {
    let footnotes: Array<{ readonly cellId: string; readonly columnIndex: number }> | undefined;
    for (let columnIndex = 0; columnIndex < row.cells.length; columnIndex += 1) {
      const cell = row.cells[columnIndex];
      if (!cell) continue;
      this.cellLocations.set(cell.id, { rowIndex: row.index, columnIndex });
      if (hasFootnoteReference(cell.inline)) {
        footnotes ??= [];
        footnotes.push({ cellId: cell.id, columnIndex });
      }
    }
    if (footnotes) this.footnoteRows.set(row.index, footnotes);
    else this.footnoteRows.delete(row.index);
  }

  private removeRowDependencies(row: TableRowRecord): void {
    for (const cell of row.cells) {
      this.cellLocations.delete(cell.id);
      this.installCellAttempts(cell.id, EMPTY_REFERENCE_LABELS);
    }
    this.footnoteRows.delete(row.index);
  }

  private change(
    expectedRevision: number,
    fromRow: number,
    rows: readonly TableRowRecord[],
    sourceAppend: string,
    rootResumeFrom?: number,
  ): RootTableSourceChange {
    const change = {
      table: this.getMetadata(),
      expectedRevision,
      fromRow,
      rows: Object.freeze(rows),
      sourceAppend,
    };
    return rootResumeFrom === undefined
      ? Object.freeze(change)
      : Object.freeze({ ...change, rootResumeFrom });
  }

  private noChange(): RootTableSourceChange {
    return this.change(this.revision, this.rowIndex.length, [], "");
  }
}
