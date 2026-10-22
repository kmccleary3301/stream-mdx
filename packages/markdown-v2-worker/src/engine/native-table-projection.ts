import type { SyntaxNode } from "@lezer/common";
import {
  freezeTableCellRecord,
  freezeTableHeaderRecord,
  freezeTableRowRecord,
  type InlineParser,
  type TableAlignment,
  type TableCellRecord,
  type TableHeaderRecord,
  type TableRowRecord,
  type TableSourceRange,
  type SourceSnapshot,
} from "@stream-mdx/core";
import {
  nativeTableCellPositions,
  nativeTableColumnCount,
  type NativeTableCellSpan,
  type NativeTableRowSpan,
} from "./native-table-row-classifier";
import { parseTableCellInline } from "./table-cell-inline";

export type TableCellAttemptRecorder = (cellId: string, labels: ReadonlySet<string>, sourceUnits: number) => void;

function parseAlignmentFields(raw: string, columnCount: number): readonly TableAlignment[] {
  const fields: string[] = [];
  let fieldStart = 0;
  for (let offset = 0; offset < raw.length; offset += 1) {
    if (raw.charCodeAt(offset) !== 124) continue;
    fields.push(raw.slice(fieldStart, offset));
    fieldStart = offset + 1;
  }
  fields.push(raw.slice(fieldStart));
  if (fields.length > 0 && fields[0]!.trim() === "") fields.shift();
  if (fields.length > 0 && fields[fields.length - 1]!.trim() === "") fields.pop();

  const align = new Array<TableAlignment>(columnCount);
  for (let column = 0; column < columnCount; column += 1) {
    const field = (fields[column] ?? "").trim();
    const left = field.startsWith(":");
    const right = field.endsWith(":");
    align[column] = left && right ? "center" : left ? "left" : right ? "right" : null;
  }
  return Object.freeze(align);
}

function absoluteRange(from: number, to: number): TableSourceRange {
  return { from, to };
}

function sourceCells(
  positions: readonly NativeTableCellSpan[],
  columnCount: number,
  emptyAt: number,
): TableSourceRange[] {
  const ranges = new Array<TableSourceRange | undefined>(columnCount);
  for (const position of positions) {
    const column = position.nativeColumnIndex;
    if (column < 0 || column >= columnCount || ranges[column] !== undefined) continue;
    ranges[column] = position.sourceRange;
  }
  for (let column = 0; column < columnCount; column += 1) {
    ranges[column] ??= absoluteRange(emptyAt, emptyAt);
  }
  return ranges as TableSourceRange[];
}

function prepareCell(
  id: string,
  index: number,
  sourceRange: TableSourceRange,
  source: SourceSnapshot,
  inlineParser: InlineParser,
  previous: TableCellRecord | undefined,
  recordAttempts: TableCellAttemptRecorder | undefined,
): TableCellRecord {
  const raw = source.read(sourceRange.from, sourceRange.to);
  if (previous && previous.id === id && previous.index === index
    && previous.raw === raw && previous.sourceRange.from === sourceRange.from
    && previous.sourceRange.to === sourceRange.to) return previous;

  const attempted = new Set<string>();
  const inline = parseTableCellInline(inlineParser, raw, {
    onAttemptedReference: (label) => attempted.add(label),
  });
  recordAttempts?.(id, attempted, raw.length);
  return freezeTableCellRecord({ id, index, sourceRange, raw, inline });
}

function cellsForRow(
  ownerId: string,
  rowIndex: number,
  sourceRange: TableSourceRange,
  positions: readonly NativeTableCellSpan[],
  columnCount: number,
  source: SourceSnapshot,
  inlineParser: InlineParser,
  previous: readonly TableCellRecord[] | undefined,
  recordAttempts: TableCellAttemptRecorder | undefined,
): readonly TableCellRecord[] {
  const ranges = sourceCells(positions, columnCount, sourceRange.to);
  const cells = new Array<TableCellRecord>(columnCount);
  const rowId = `${ownerId}::row:${rowIndex}`;
  for (let column = 0; column < columnCount; column += 1) {
    const range = ranges[column]!;
    cells[column] = prepareCell(
      `${rowId}::cell:${column}`,
      column,
      range,
      source,
      inlineParser,
      previous?.[column],
      recordAttempts,
    );
  }
  return Object.freeze(cells);
}

export function createNativeTableHeaderRecord(
  headerNode: SyntaxNode,
  delimiterNode: SyntaxNode,
  ownerId: string,
  source: SourceSnapshot,
  sourceOffset: number,
  inlineParser: InlineParser,
  recordAttempts?: TableCellAttemptRecorder,
): TableHeaderRecord {
  const columnCount = Math.max(1, nativeTableColumnCount(headerNode));
  const headerRowRange = absoluteRange(headerNode.from + sourceOffset, headerNode.to + sourceOffset);
  const delimiterRange = absoluteRange(delimiterNode.from + sourceOffset, delimiterNode.to + sourceOffset);
  const headerRange = absoluteRange(headerRowRange.from, delimiterRange.to);
  const positions = nativeTableCellPositions(headerNode).map((position, ordinal) => ({
    ordinal,
    nativeColumnIndex: position.nativeColumnIndex,
    sourceRange: absoluteRange(position.from + sourceOffset, position.to + sourceOffset),
  }));
  const ranges = sourceCells(positions, columnCount, headerRowRange.to);
  const cells = new Array<TableCellRecord>(columnCount);
  for (let column = 0; column < columnCount; column += 1) {
    cells[column] = prepareCell(
      `${ownerId}::header:cell:${column}`,
      column,
      ranges[column]!,
      source,
      inlineParser,
      undefined,
      recordAttempts,
    );
  }
  const delimiter = source.read(delimiterRange.from, delimiterRange.to);
  return freezeTableHeaderRecord({
    cells,
    align: parseAlignmentFields(delimiter, columnCount),
    sourceRange: headerRange,
  });
}

export function createNativeTableRowRecord(
  span: NativeTableRowSpan,
  ownerId: string,
  columnCount: number,
  source: SourceSnapshot,
  inlineParser: InlineParser,
  previous?: TableRowRecord,
  recordAttempts?: TableCellAttemptRecorder,
): TableRowRecord {
  const cells = cellsForRow(
    ownerId,
    span.index,
    span.sourceRange,
    span.cells,
    columnCount,
    source,
    inlineParser,
    previous?.cells,
    recordAttempts,
  );
  const changed = !previous
    || previous.sourceRange.from !== span.sourceRange.from
    || previous.sourceRange.to !== span.sourceRange.to
    || previous.isProvisional !== span.isProvisional
    || previous.cells.some((cell, index) => {
      const next = cells[index];
      return !next || cell.raw !== next.raw
        || cell.sourceRange.from !== next.sourceRange.from
        || cell.sourceRange.to !== next.sourceRange.to;
    });
  const sourceRevision = previous
    ? changed
      ? incrementSourceRevision(previous.sourceRevision)
      : previous.sourceRevision
    : 0;
  if (previous && !changed) return previous;
  return freezeTableRowRecord({
    id: `${ownerId}::row:${span.index}`,
    index: span.index,
    sourceRange: span.sourceRange,
    sourceRevision,
    isProvisional: span.isProvisional,
    cells,
  });
}

function incrementSourceRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) throw new RangeError("Table row source revision exceeds the safe integer range");
  return next;
}

export function createNativeTableRowRecordFromNode(
  rowNode: SyntaxNode,
  sourceOffset: number,
  rowIndex: number,
  ownerId: string,
  columnCount: number,
  source: SourceSnapshot,
  inlineParser: InlineParser,
  isProvisional: boolean,
  previous?: TableRowRecord,
  recordAttempts?: TableCellAttemptRecorder,
): TableRowRecord {
  const sourceRange = absoluteRange(rowNode.from + sourceOffset, rowNode.to + sourceOffset);
  const positions = nativeTableCellPositions(rowNode).map((position, ordinal) => ({
    ordinal,
    nativeColumnIndex: position.nativeColumnIndex,
    sourceRange: absoluteRange(position.from + sourceOffset, position.to + sourceOffset),
  }));
  return createNativeTableRowRecord({
    index: rowIndex,
    sourceRange,
    cells: positions,
    isProvisional,
  }, ownerId, columnCount, source, inlineParser, previous, recordAttempts);
}

export function isNativeTableRowTerminated(source: SourceSnapshot, end: number, finalizing = false): boolean {
  let cursor = end;
  while (cursor < source.length) {
    const unit = source.read(cursor, cursor + 1);
    if (unit !== " " && unit !== "\t") break;
    cursor += 1;
  }
  if (cursor >= source.length) return false;
  const first = source.read(cursor, cursor + 1);
  if (first === "\n") return true;
  if (first !== "\r") return false;
  return cursor + 1 < source.length || finalizing;
}
