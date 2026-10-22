import type { Input, SyntaxNode } from "@lezer/common";
import type { InlineParser } from "./inline-parser";
import type { InlineNode } from "./types";
import { freezeTableCellRecord, freezeTableHeaderRecord } from "./table-records";
import type { TableCellRecord, TableHeaderRecord } from "./table-records";
export interface NativeSourceReader {
  readonly length: number;
  read(from: number, to: number): string;
}

export interface NativeSourceRange {
  readonly from: number;
  readonly to: number;
}

/** Coordinates shared by a native tree, its parse input, and the canonical authored document. */
export interface NativeSourceMapping {
  readonly input: Input;
  readonly source: NativeSourceReader;
  /** Maps a Lezer-input UTF-16 offset to its authored UTF-16 offset. */
  readonly mapOffset: (offset: number) => number;
  /** Maps an input interval when a synthetic window has side-specific boundaries. */
  readonly mapRange?: (from: number, to: number) => NativeSourceRange;
}

export type NativeTableCellAttemptRecorder = (
  cellId: string,
  labels: ReadonlySet<string>,
  sourceUnits: number,
) => void;

function mappedRange(mapping: NativeSourceMapping, from: number, to: number): NativeSourceRange {
  return mapping.mapRange?.(from, to) ?? { from: mapping.mapOffset(from), to: mapping.mapOffset(to) };
}

export interface NativeTableCellPosition {
  readonly nativeColumnIndex: number;
  readonly from: number;
  readonly to: number;
}

export interface NativeTableParts {
  readonly header: SyntaxNode;
  readonly delimiter: SyntaxNode;
  readonly rows: readonly SyntaxNode[];
}

export interface NativeTableContent {
  readonly header: readonly (readonly InlineNode[])[];
  readonly align: readonly ("left" | "center" | "right" | null)[];
  readonly rows: readonly (readonly (readonly InlineNode[])[])[];
}

/** Returns native TableCell positions; pipe delimiters are never re-parsed as table syntax. */
export function nativeTableCellPositions(rowNode: SyntaxNode): NativeTableCellPosition[] {
  const cells: NativeTableCellPosition[] = [];
  const cursor = rowNode.cursor();
  let nativeColumnIndex = 0;
  let firstDelimiter = true;
  if (!cursor.firstChild()) return cells;
  do {
    if (cursor.type.name === "TableDelimiter") {
      const isLeadingOuterPipe = firstDelimiter && cursor.from === rowNode.from;
      firstDelimiter = false;
      if (!isLeadingOuterPipe) nativeColumnIndex += 1;
    } else if (cursor.type.name === "TableCell") {
      cells.push({ nativeColumnIndex, from: cursor.from, to: cursor.to });
    }
  } while (cursor.nextSibling());
  return cells;
}

/** Native header children determine logical columns, including omitted empty cells. */
export function nativeTableColumnCount(rowNode: SyntaxNode): number {
  const cursor = rowNode.cursor();
  let nativeColumnIndex = 0;
  let firstDelimiter = true;
  let trailingDelimiter = false;
  if (!cursor.firstChild()) return 0;
  do {
    if (cursor.type.name === "TableDelimiter") {
      const isLeadingOuterPipe = firstDelimiter && cursor.from === rowNode.from;
      firstDelimiter = false;
      if (!isLeadingOuterPipe) nativeColumnIndex += 1;
      trailingDelimiter = cursor.to === rowNode.to;
    } else if (cursor.type.name === "TableCell") {
      trailingDelimiter = false;
    }
  } while (cursor.nextSibling());
  return nativeColumnIndex + (trailingDelimiter ? 0 : 1);
}

export function nativeTableParts(tableNode: SyntaxNode): NativeTableParts | undefined {
  let header: SyntaxNode | undefined;
  let delimiter: SyntaxNode | undefined;
  const rows: SyntaxNode[] = [];
  for (let child = tableNode.firstChild; child; child = child.nextSibling) {
    if (child.type.name === "TableHeader") header = child;
    else if (child.type.name === "TableDelimiter") delimiter = child;
    else if (child.type.name === "TableRow") rows.push(child);
  }
  return header && delimiter ? { header, delimiter, rows } : undefined;
}

function rangesForColumns(
  rowNode: SyntaxNode,
  columnCount: number,
  emptyAt: number,
): Array<{ readonly from: number; readonly to: number }> {
  const ranges = new Array<{ readonly from: number; readonly to: number } | undefined>(columnCount);
  for (const position of nativeTableCellPositions(rowNode)) {
    const column = position.nativeColumnIndex;
    if (column >= 0 && column < columnCount && ranges[column] === undefined) {
      ranges[column] = { from: position.from, to: position.to };
    }
  }
  for (let column = 0; column < columnCount; column += 1) {
    ranges[column] ??= { from: emptyAt, to: emptyAt };
  }
  return ranges as Array<{ readonly from: number; readonly to: number }>;
}

function parseAlignment(source: string, columnCount: number): Array<"left" | "center" | "right" | null> {
  const fields: string[] = [];
  let fieldStart = 0;
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source.charCodeAt(offset) !== 124) continue;
    fields.push(source.slice(fieldStart, offset));
    fieldStart = offset + 1;
  }
  fields.push(source.slice(fieldStart));
  if (fields[0]?.trim() === "") fields.shift();
  if (fields.at(-1)?.trim() === "") fields.pop();
  const align = new Array<"left" | "center" | "right" | null>(columnCount);
  for (let column = 0; column < columnCount; column += 1) {
    const field = (fields[column] ?? "").trim();
    const left = field.startsWith(":");
    const right = field.endsWith(":");
    align[column] = left && right ? "center" : left ? "left" : right ? "right" : null;
  }
  return align;
}

/** Builds the worker's immutable native header record through a piecewise source mapping. */
export function createNativeTableHeaderRecordFromMapping(
  headerNode: SyntaxNode,
  delimiterNode: SyntaxNode,
  ownerId: string,
  mapping: NativeSourceMapping,
  inlineParser: InlineParser,
  recordAttempts?: NativeTableCellAttemptRecorder,
): TableHeaderRecord {
  const columnCount = Math.max(1, nativeTableColumnCount(headerNode));
  const headerRowRange = mappedRange(mapping, headerNode.from, headerNode.to);
  const delimiterRange = mappedRange(mapping, delimiterNode.from, delimiterNode.to);
  const ranges = rangesForColumns(headerNode, columnCount, headerNode.to);
  const cells = new Array<TableCellRecord>(columnCount);
  for (let column = 0; column < columnCount; column += 1) {
    const localRange = ranges[column]!;
    const sourceRange = mappedRange(mapping, localRange.from, localRange.to);
    const raw = mapping.source.read(sourceRange.from, sourceRange.to);
    const attempted = new Set<string>();
    const inline = parseCellInline(inlineParser, raw, { onAttemptedReference: (label) => attempted.add(label) });
    recordAttempts?.(`${ownerId}::header:cell:${column}`, attempted, raw.length);
    cells[column] = freezeTableCellRecord({
      id: `${ownerId}::header:cell:${column}`,
      index: column,
      sourceRange,
      raw,
      inline,
    });
  }
  return freezeTableHeaderRecord({
    cells,
    align: parseAlignment(mapping.source.read(delimiterRange.from, delimiterRange.to), columnCount),
    sourceRange: { from: headerRowRange.from, to: delimiterRange.to },
  });
}

function inlineCells(
  rowNode: SyntaxNode,
  columnCount: number,
  emptyAt: number,
  mapping: NativeSourceMapping,
  inlineParser: InlineParser,
): InlineNode[][] {
  return rangesForColumns(rowNode, columnCount, emptyAt).map(({ from, to }) => {
    const range = mappedRange(mapping, from, to);
    return parseCellInline(inlineParser, mapping.source.read(range.from, range.to));
  });
}

/** GFM removes the backslash of every `\|` in a table cell before inline parsing, so code spans hold a bare pipe. */
function parseCellInline(inlineParser: InlineParser, raw: string, options?: Parameters<InlineParser["parse"]>[1]): InlineNode[] {
  return inlineParser.parse(raw.includes("\\|") ? raw.replace(/\\\|/g, "|") : raw, options);
}

/** Lowers an already-admitted native GFM Table node without constructing or parsing its raw prefix. */
export function lowerNativeTableContent(
  tableNode: SyntaxNode,
  mapping: NativeSourceMapping,
  inlineParser: InlineParser,
): NativeTableContent | undefined {
  const parts = nativeTableParts(tableNode);
  if (!parts) return undefined;
  const columnCount = Math.max(1, nativeTableColumnCount(parts.header));
  const header = inlineCells(parts.header, columnCount, parts.header.to, mapping, inlineParser);
  const delimiterRange = mappedRange(mapping, parts.delimiter.from, parts.delimiter.to);
  const align = parseAlignment(mapping.source.read(delimiterRange.from, delimiterRange.to), columnCount);
  const rows = parts.rows.map((row) =>
    inlineCells(row, columnCount, row.to, mapping, inlineParser));
  return { header, align, rows };
}
