import type { Input, SyntaxNode, Tree } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import type { SourceSnapshot } from "@stream-mdx/core";
import { NativeMarkdownInput } from "./native-markdown-input";

export type NativeTableRowClassifierState = "open" | "closed" | "finalized";
export type NativeTableExtensionContext = "header-independent" | "source-dependent";

export interface NativeTableSourceRange {
  readonly from: number;
  readonly to: number;
}

export interface NativeTableCellPosition {
  readonly nativeColumnIndex: number;
  readonly from: number;
  readonly to: number;
}

/** A span for an actual native TableCell node; empty cells have no native node. */
export interface NativeTableCellSpan {
  readonly ordinal: number;
  readonly nativeColumnIndex: number;
  readonly sourceRange: NativeTableSourceRange;
}

/** Source spans for one actual native TableRow and its actual TableCell children. */
export interface NativeTableRowSpan {
  readonly index: number;
  readonly sourceRange: NativeTableSourceRange;
  readonly cells: readonly NativeTableCellSpan[];
  readonly isProvisional: boolean;
}

export interface NativeTableRowClassifierCounters {
  recordSourceUnitsMaterialized(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
}

export interface NativeTableRowClassifierOptions {
  /** The actual parser configured for the owning document, including its GFM Table extension. */
  readonly parser: MarkdownParser;
  readonly columnCount: number;
  /** Authored UTF-16 offset immediately after the admitted delimiter line ending. */
  readonly bodyFrom: number;
  /** Only header-independent configured parsers may replace the authored table prefix. */
  readonly extensionContext: NativeTableExtensionContext;
  /** Required only when preserving a caller extension against its exact source-context header. */
  readonly tableFrom?: number;
  /** @internal Diagnostic sink; used only in the counter build. */
  readonly counters?: NativeTableRowClassifierCounters;
}

export interface NativeTableRowClassifierChange {
  readonly completeRows: readonly NativeTableRowSpan[];
  readonly provisionalRow?: NativeTableRowSpan;
  readonly fromRow: number;
  readonly state: NativeTableRowClassifierState;
  readonly acceptedTo: number;
  readonly boundedTailFrom: number;
  readonly actualInterruptFrom?: number;
  readonly remainderFrom?: number;
}



interface ParsedNativeRow {
  readonly node: SyntaxNode;
  readonly row: NativeTableRowSpan;
}

class SyntheticTableTailInput implements Input {
  readonly lineChunks = true;
  readonly length: number;
  private readonly prefix: string;
  private readonly tail: string;
  private readonly tailLength: number;

  constructor(prefix: string, tail: string, tailLength: number) {
    this.prefix = prefix;
    this.tail = tail;
    this.tailLength = tailLength;
    this.length = prefix.length + tailLength;
  }

  chunk(from: number): string {
    const position = Math.max(0, Math.min(this.length, from));
    if (position === this.length) return "";
    if (position < this.prefix.length) return lineChunk(this.prefix, position, this.prefix.length);
    return lineChunk(this.tail, position - this.prefix.length, this.tailLength);
  }

  read(from: number, to: number): string {
    const start = Math.max(0, Math.min(this.length, from));
    const end = Math.max(start, Math.min(this.length, to));
    if (start === end) return "";
    if (end <= this.prefix.length) return this.prefix.slice(start, end);
    if (start >= this.prefix.length) return this.tail.slice(start - this.prefix.length, end - this.prefix.length);
    return this.prefix.slice(start) + this.tail.slice(0, end - this.prefix.length);
  }
}

class SourceWindowInput implements Input {
  readonly lineChunks = true;
  readonly length: number;
  private readonly source: SourceSnapshot;
  private readonly from: number;

  constructor(source: SourceSnapshot, from: number, to: number) {
    this.from = Math.max(0, Math.min(source.length, from));
    const end = Math.max(this.from, Math.min(source.length, to));
    this.length = end - this.from;
    this.source = source;
  }

  chunk(from: number): string {
    const start = Math.max(0, Math.min(this.length, from));
    if (start === this.length) return "";
    const chunk = this.source.chunk(this.from + start);
    return chunk.length <= this.length - start ? chunk : chunk.slice(0, this.length - start);
  }

  read(from: number, to: number): string {
    const start = Math.max(0, Math.min(this.length, from));
    const end = Math.max(start, Math.min(this.length, to));
    return this.source.read(this.from + start, this.from + end);
  }
}

const EMPTY_ROWS: readonly NativeTableRowSpan[] = Object.freeze([]);
declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

function lineChunk(text: string, from: number, limit: number): string {
  if (from >= limit) return "";
  if (text.charCodeAt(from) === 10) return "\n";
  const lineEnd = text.indexOf("\n", from);
  return text.slice(from, lineEnd < 0 || lineEnd >= limit ? limit : lineEnd);
}

function makeSyntheticPrefix(columnCount: number): string {
  const headerCells = new Array<string>(columnCount);
  const delimiterCells = new Array<string>(columnCount);
  for (let index = 0; index < columnCount; index += 1) {
    headerCells[index] = "h";
    delimiterCells[index] = "---";
  }
  return `|${headerCells.join("|")}|\n|${delimiterCells.join("|")}|\n`;
}


function authoredOffset(prefixLength: number, inputOffset: number, tailFrom: number, tailLength: number): number {
  const tailOffset = Math.max(0, Math.min(tailLength, inputOffset - prefixLength));
  return tailFrom + tailOffset;
}

function isHorizontalWhitespaceLine(
  text: string,
  from: number,
  limit: number,
): boolean | undefined {
  if (from < 0 || from >= limit) return undefined;
  for (let cursor = from; cursor < limit; cursor += 1) {
    const unit = text.charCodeAt(cursor);
    if (unit === 10 || unit === 13) return true;
    if (unit !== 32 && unit !== 9) return undefined;
  }
  return false;
}


/** Native TableCell/TableDelimiter child sequence; no authored pipe splitting is performed. */
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

/** Native header child positions determine the admitted number of logical columns, including empty cells. */
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

function mappedNativeCells(
  rowNode: SyntaxNode,
  mapOffset: (offset: number) => number,
): NativeTableCellSpan[] {
  const positions = nativeTableCellPositions(rowNode);
  const cells = new Array<NativeTableCellSpan>(positions.length);
  for (let ordinal = 0; ordinal < positions.length; ordinal += 1) {
    const position = positions[ordinal]!;
    cells[ordinal] = {
      ordinal,
      nativeColumnIndex: position.nativeColumnIndex,
      sourceRange: { from: mapOffset(position.from), to: mapOffset(position.to) },
    };
  }
  return cells;
}

function lineEndingEndAfter(input: Input, end: number): number {
  let cursor = end;
  while (cursor < input.length) {
    const unit = input.read(cursor, cursor + 1);
    if (unit === "\n") return cursor + 1;
    if (unit !== " " && unit !== "\t") break;
    cursor += 1;
  }
  return end;
}

function hasCompleteOpeningLine(input: NativeMarkdownInput, node: SyntaxNode, atEOF: boolean): boolean {
  if (atEOF) return true;
  const lineEnd = node.from + input.chunk(node.from).length;
  return lineEnd < input.length && input.read(lineEnd, lineEnd + 1) === "\n";
}

function tableNodeFromTree(
  tree: Tree,
  input: NativeMarkdownInput,
  atEOF: boolean,
): { readonly table: SyntaxNode; readonly hasConfirmedFollowingRoot: boolean } {
  const root = tree.cursor();
  if (!root.firstChild() || root.type.name !== "Table") {
    throw new Error("Configured Markdown parser did not produce a native GFM Table context");
  }
  const table = root.node;
  return { table, hasConfirmedFollowingRoot: root.nextSibling() && hasCompleteOpeningLine(input, root.node, atEOF) };
}

function nativeRowsFromTree(
  tableNode: SyntaxNode,
  mapOffset: (offset: number) => number,
  firstRowIndex: number,
  input: Input,
  atEOF: boolean,
): ParsedNativeRow[] {
  const rows: ParsedNativeRow[] = [];
  const cursor = tableNode.cursor();
  if (!cursor.firstChild()) return rows;
  do {
    if (cursor.type.name !== "TableRow") continue;
    const rowNode = cursor.node;
    const lineEnd = lineEndingEndAfter(input, rowNode.to);
    const hasEnding = lineEnd > rowNode.to;
    const finalAtEOF = atEOF && !hasEnding;
    const cells = mappedNativeCells(rowNode, mapOffset);
    rows.push({
      node: rowNode,
      row: {
        index: firstRowIndex + rows.length,
        sourceRange: { from: mapOffset(rowNode.from), to: mapOffset(rowNode.to) },
        cells,
        isProvisional: !hasEnding && !finalAtEOF,
      },
    });
  } while (cursor.nextSibling());
  return rows;
}

export class NativeTableRowClassifier {
  readonly columnCount: number;
  private readonly parser: MarkdownParser;
  private readonly prefix: string;
  private readonly extensionContext: NativeTableExtensionContext;
  private readonly tableFrom: number;
  private declare counters?: NativeTableRowClassifierCounters;
  private state: NativeTableRowClassifierState = "open";
  private acceptedTo: number;
  private tailFrom: number;
  private nextRowIndex = 0;
  private interruptFrom: number | undefined;

  constructor(options: NativeTableRowClassifierOptions) {
    if (!Number.isSafeInteger(options.columnCount) || options.columnCount < 1) {
      throw new RangeError("Native table column count must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.bodyFrom) || options.bodyFrom < 0) {
      throw new RangeError("Native table body offset must be a non-negative safe integer");
    }
    const tableFrom = options.tableFrom ?? options.bodyFrom;
    if (!Number.isSafeInteger(tableFrom) || tableFrom < 0 || tableFrom > options.bodyFrom) {
      throw new RangeError("Native table opening offset must precede its body offset");
    }
    if (options.extensionContext === "source-dependent" && options.tableFrom === undefined) {
      throw new Error("Source-dependent native table continuation requires the authored table start");
    }

    this.columnCount = options.columnCount;
    this.parser = options.parser;
    this.extensionContext = options.extensionContext;
    this.tableFrom = tableFrom;
    this.prefix = options.extensionContext === "header-independent" ? makeSyntheticPrefix(options.columnCount) : "";
    this.acceptedTo = options.bodyFrom;
    this.tailFrom = options.bodyFrom;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters = options.counters;
    }
  }

  /** Accept one contiguous authored append interval. */
  accept(source: SourceSnapshot, from: number, to: number): NativeTableRowClassifierChange {
    this.validateRange(source, from, to);
    if (this.state !== "open") throw new Error(`Cannot accept source for a ${this.state} native table classifier`);
    if (to === from) return this.noChange();
    return this.classify(source, to, false);
  }

  /** Seal the current row at EOF, while still honoring native interruptions in the tail. */
  finalize(source: SourceSnapshot, from: number, to: number): NativeTableRowClassifierChange {
    this.validateRange(source, from, to);
    if (this.state === "finalized") return this.noChange();
    if (this.state === "closed") {
      this.state = "finalized";
      return this.noChange();
    }
    const change = this.classify(source, to, true);
    this.state = "finalized";
    return { ...change, state: this.state };
  }

  private validateRange(source: SourceSnapshot, from: number, to: number): void {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)
      || from !== this.acceptedTo || to < from || to > source.length) {
      throw new RangeError("Native table input must continue at acceptedTo within the source snapshot");
    }
    if (this.tailFrom > to || this.tableFrom > to) {
      throw new RangeError("Native table source context extends beyond the supplied source");
    }
  }

  private classify(source: SourceSnapshot, to: number, atEOF: boolean): NativeTableRowClassifierChange {
    return this.extensionContext === "source-dependent"
      ? this.classifySourceContext(source, to, atEOF)
      : this.classifySyntheticTail(source, to, atEOF);
  }

  private classifySyntheticTail(source: SourceSnapshot, to: number, atEOF: boolean): NativeTableRowClassifierChange {
    const priorRowIndex = this.nextRowIndex;
    const raw = source.read(this.tailFrom, to);
    const rawLimit = !atEOF && raw.length > 0 && raw.charCodeAt(raw.length - 1) === 13
      ? raw.length - 1
      : raw.length;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters?.recordSourceUnitsMaterialized(raw.length, "engine");
    }

    const input = new NativeMarkdownInput(new SyntheticTableTailInput(this.prefix, raw, rawLimit), atEOF);
    const tree = input.parse(this.parser);
    const { table, hasConfirmedFollowingRoot } = tableNodeFromTree(tree, input, atEOF);
    const prefixLength = this.prefix.length;
    const rows = nativeRowsFromTree(
      table,
      (offset) => authoredOffset(prefixLength, offset, this.tailFrom, rawLimit),
      priorRowIndex,
      input,
      atEOF,
    );
    const lastTableLineEnd = rows.length > 0 ? rows[rows.length - 1]!.node.to : prefixLength - 1;
    const nextLineOffset = lineEndingEndAfter(input, lastTableLineEnd);
    const nextLineInTail = nextLineOffset - prefixLength;
    const blankInterrupt = isHorizontalWhitespaceLine(raw, nextLineInTail, rawLimit);
    const confirmedBlankInterrupt = blankInterrupt !== undefined && (blankInterrupt || atEOF);
    const interrupted = hasConfirmedFollowingRoot || confirmedBlankInterrupt;
    const actualInterruptFrom = interrupted
      ? authoredOffset(prefixLength, nextLineOffset, this.tailFrom, rawLimit)
      : undefined;
    return this.finishClassification(rows, priorRowIndex, to, atEOF, actualInterruptFrom, this.tailFrom, input, prefixLength, rawLimit);
  }

  private classifySourceContext(source: SourceSnapshot, to: number, atEOF: boolean): NativeTableRowClassifierChange {
    const priorRowIndex = this.nextRowIndex;
    const window = new SourceWindowInput(source, this.tableFrom, to);
    const input = new NativeMarkdownInput(window, atEOF);
    const tree = input.parse(this.parser);
    const { table, hasConfirmedFollowingRoot } = tableNodeFromTree(tree, input, atEOF);
    const rows = nativeRowsFromTree(
      table,
      (offset) => this.tableFrom + offset,
      0,
      input,
      atEOF,
    );
    let delimiterEnd = 0;
    const tableChildren = table.cursor();
    if (tableChildren.firstChild()) {
      do {
        if (tableChildren.type.name === "TableDelimiter") {
          delimiterEnd = tableChildren.to;
          break;
        }
      } while (tableChildren.nextSibling());
    }
    const lastTableLineEnd = rows.length > 0 ? rows[rows.length - 1]!.node.to : delimiterEnd;
    const nextLineOffset = lineEndingEndAfter(input, lastTableLineEnd);
    const text = input.read(0, input.length);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters?.recordSourceUnitsMaterialized(text.length, "engine");
    }
    const blankInterrupt = isHorizontalWhitespaceLine(text, nextLineOffset, input.length);
    const confirmedBlankInterrupt = blankInterrupt !== undefined && (blankInterrupt || atEOF);
    const interrupted = hasConfirmedFollowingRoot || confirmedBlankInterrupt;
    const actualInterruptFrom = interrupted ? this.tableFrom + nextLineOffset : undefined;
    return this.finishClassification(
      rows,
      priorRowIndex,
      to,
      atEOF,
      actualInterruptFrom,
      this.tableFrom,
      input,
      0,
      input.length,
    );
  }

  private finishClassification(
    rows: readonly ParsedNativeRow[],
    priorRowIndex: number,
    to: number,
    atEOF: boolean,
    actualInterruptFrom: number | undefined,
    mutableTailFrom: number,
    input: Input,
    prefixLength: number,
    tailLength: number,
  ): NativeTableRowClassifierChange {
    let parsedCompleteRowCount = 0;
    while (parsedCompleteRowCount < rows.length && !rows[parsedCompleteRowCount]!.row.isProvisional) {
      parsedCompleteRowCount += 1;
    }
    if (actualInterruptFrom !== undefined || atEOF) parsedCompleteRowCount = rows.length;

    const sourceContext = this.extensionContext === "source-dependent";
    if (sourceContext && parsedCompleteRowCount < priorRowIndex) {
      throw new Error("Native table parsing cannot retract an admitted complete row prefix");
    }
    const completeRowsStart = sourceContext ? priorRowIndex : 0;
    const completeRowCount = sourceContext ? parsedCompleteRowCount : priorRowIndex + parsedCompleteRowCount;
    const completeRows = rows.slice(completeRowsStart, parsedCompleteRowCount).map((entry) => entry.row);
    const provisionalRow = actualInterruptFrom === undefined && !atEOF && parsedCompleteRowCount < rows.length
      ? rows[parsedCompleteRowCount]?.row
      : undefined;

    if (actualInterruptFrom !== undefined) {
      this.state = "closed";
      this.interruptFrom = actualInterruptFrom;
      this.tailFrom = actualInterruptFrom;
    } else if (atEOF) {
      this.state = "finalized";
      this.tailFrom = to;
    } else if (this.extensionContext === "header-independent" && completeRows.length > 0) {
      const lastComplete = rows[parsedCompleteRowCount - 1];
      if (!lastComplete) throw new Error("Native table completed-row index invariant violated");
      const lineEnd = lineEndingEndAfter(input, lastComplete.node.to);
      this.tailFrom = authoredOffset(
        prefixLength,
        lineEnd,
        mutableTailFrom,
        tailLength,
      );
    }

    this.acceptedTo = to;
    this.nextRowIndex = completeRowCount;
    return {
      completeRows,
      ...(provisionalRow ? { provisionalRow } : {}),
      fromRow: priorRowIndex,
      state: this.state,
      acceptedTo: this.acceptedTo,
      boundedTailFrom: this.extensionContext === "source-dependent" ? this.tableFrom : this.tailFrom,
      ...(actualInterruptFrom === undefined ? {} : {
        actualInterruptFrom,
        remainderFrom: actualInterruptFrom,
      }),
    };
  }

  private noChange(): NativeTableRowClassifierChange {
    return {
      completeRows: EMPTY_ROWS,
      fromRow: this.nextRowIndex,
      state: this.state,
      acceptedTo: this.acceptedTo,
      boundedTailFrom: this.extensionContext === "source-dependent" ? this.tableFrom : this.tailFrom,
      ...(this.interruptFrom === undefined ? {} : {
        actualInterruptFrom: this.interruptFrom,
        remainderFrom: this.interruptFrom,
      }),
    };
  }
}
