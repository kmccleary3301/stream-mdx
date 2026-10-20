import type { SyntaxNode } from "@lezer/common";
import type { SourceSnapshot } from "@stream-mdx/core";

export interface ParagraphSourceRange {
  readonly from: number;
  readonly to: number;
}

/** Logical paragraph text mapped onto its exact authored UTF-16 source extent. */
export interface ParagraphSourceText {
  readonly sourceRange: ParagraphSourceRange;
  readonly text: string;
  /** Adjacent logical ranges meet at one physical boundary; omitted syntax belongs to the left range. */
  rangeFor(from: number, to: number): ParagraphSourceRange;
  slice(from: number, to: number): ParagraphSourceText;
}

export type ParagraphSourceTextReader = (
  source: SourceSnapshot,
  from: number,
  to: number,
) => ParagraphSourceText;

export interface NativeParagraphSourceMarker {
  readonly typeName: "QuoteMark" | "ListMark";
  /** Exact physical range of a native syntax marker in the canonical source. */
  readonly range: ParagraphSourceRange;
}

/**
 * Physical coordinates supplied by native paragraph admission. `textRange` is the native
 * paragraph/Task input; `sourceRange` is the authored extent owned by the prepared paragraph.
 */
export interface NativeParagraphSourceContext {
  readonly sourceRange: ParagraphSourceRange;
  readonly textRange: ParagraphSourceRange;
  readonly markers: readonly NativeParagraphSourceMarker[];
  /** Exact ASCII space/tab container-indent ranges supplied by native parsing. */
  readonly indentationRanges?: readonly ParagraphSourceRange[];
  readonly task: boolean;
}

export type NativeParagraphMarkerMapper = (
  marker: Pick<SyntaxNode, "from" | "to" | "type">,
) => ParagraphSourceRange | undefined;

type SourceRun = {
  readonly logicalFrom: number;
  readonly logicalTo: number;
  readonly sourceFrom: number;
};

function assertRange(range: ParagraphSourceRange, sourceLength: number, label: string): void {
  if (!Number.isSafeInteger(range.from) || range.from < 0
    || !Number.isSafeInteger(range.to) || range.to < range.from
    || range.to > sourceLength) {
    throw new RangeError(`${label} must be an ordered canonical UTF-16 source range`);
  }
}

function assertLogicalRange(from: number, to: number, length: number): void {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)
    || from < 0 || to < from || to > length) {
    throw new RangeError("Paragraph logical range is outside its mapped text");
  }
}

function sliceRuns(runs: readonly SourceRun[], from: number, to: number): SourceRun[] {
  const nextRuns: SourceRun[] = [];
  let nextLogicalFrom = 0;
  for (const run of runs) {
    const logicalFrom = Math.max(from, run.logicalFrom);
    const logicalTo = Math.min(to, run.logicalTo);
    if (logicalFrom >= logicalTo) continue;
    const sourceFrom = run.sourceFrom + logicalFrom - run.logicalFrom;
    const length = logicalTo - logicalFrom;
    const previous = nextRuns[nextRuns.length - 1];
    if (previous && previous.sourceFrom + (previous.logicalTo - previous.logicalFrom) === sourceFrom) {
      nextRuns[nextRuns.length - 1] = {
        logicalFrom: previous.logicalFrom,
        logicalTo: nextLogicalFrom + length,
        sourceFrom: previous.sourceFrom,
      };
    } else {
      nextRuns.push({ logicalFrom: nextLogicalFrom, logicalTo: nextLogicalFrom + length, sourceFrom });
    }
    nextLogicalFrom += length;
  }
  return nextRuns;
}

function sourceTextFromRuns(
  text: string,
  sourceRange: ParagraphSourceRange,
  runs: readonly SourceRun[],
): ParagraphSourceText {
  let logicalCursor = 0;
  let previousSourceEnd = sourceRange.from;
  for (const run of runs) {
    const length = run.logicalTo - run.logicalFrom;
    if (!Number.isSafeInteger(run.logicalFrom) || run.logicalFrom !== logicalCursor
      || !Number.isSafeInteger(run.logicalTo) || run.logicalTo <= run.logicalFrom
      || run.logicalTo > text.length
      || !Number.isSafeInteger(run.sourceFrom) || run.sourceFrom < previousSourceEnd
      || run.sourceFrom + length > sourceRange.to) {
      throw new RangeError("Paragraph source mapping runs are incomplete or non-monotonic");
    }
    logicalCursor = run.logicalTo;
    previousSourceEnd = run.sourceFrom + length;
  }
  if (logicalCursor !== text.length && (text.length !== 0 || runs.length !== 0)) {
    throw new RangeError("Paragraph source mapping does not cover every logical UTF-16 unit");
  }

  const sourceAtBoundary = (offset: number): number => {
    if (offset === 0) return sourceRange.from;
    if (offset === text.length) return sourceRange.to;
    for (const run of runs) {
      if (offset < run.logicalTo) return run.sourceFrom + (offset - run.logicalFrom);
    }
    throw new RangeError("Paragraph source boundary has no authored coordinate");
  };

  const rangeFor = (from: number, to: number): ParagraphSourceRange => {
    assertLogicalRange(from, to, text.length);
    return Object.freeze({ from: sourceAtBoundary(from), to: sourceAtBoundary(to) });
  };

  const slice = (from: number, to: number): ParagraphSourceText => {
    assertLogicalRange(from, to, text.length);
    const nextRange = rangeFor(from, to);
    return sourceTextFromRuns(text.slice(from, to), nextRange, sliceRuns(runs, from, to));
  };

  return Object.freeze({
    sourceRange: Object.freeze({ from: sourceRange.from, to: sourceRange.to }),
    text,
    rangeFor,
    slice,
  });
}

/** Reuses P9's UTF-16 source-position vector contract without retaining a second copy of it. */
export function paragraphSourceTextFromPositions(
  text: string,
  sourceRange: ParagraphSourceRange,
  sourcePositions: readonly number[],
): ParagraphSourceText {
  if (sourcePositions.length !== text.length) {
    throw new RangeError("Paragraph source positions must have one entry per logical UTF-16 unit");
  }
  let previous = sourceRange.from - 1;
  const runs: SourceRun[] = [];
  for (let index = 0; index < sourcePositions.length; index += 1) {
    const position = sourcePositions[index]!;
    if (!Number.isSafeInteger(position) || position < sourceRange.from || position >= sourceRange.to || position <= previous) {
      throw new RangeError("Paragraph source positions must be strictly ordered within the authored extent");
    }
    const last = runs[runs.length - 1];
    if (last && last.sourceFrom + (last.logicalTo - last.logicalFrom) === position) {
      runs[runs.length - 1] = { ...last, logicalTo: index + 1 };
    } else {
      runs.push({ logicalFrom: index, logicalTo: index + 1, sourceFrom: position });
    }
    previous = position;
  }
  return sourceTextFromRuns(text, sourceRange, runs);
}

/** Root paragraphs use the canonical source directly without allocating a position table. */
export function readContiguousParagraphSourceText(
  source: SourceSnapshot,
  from: number,
  to: number,
): ParagraphSourceText {
  assertRange({ from, to }, source.length, "Paragraph source");
  const text = from === to ? "" : source.read(from, to);
  const sourceRange = Object.freeze({ from, to });
  const rangeFor = (logicalFrom: number, logicalTo: number): ParagraphSourceRange => {
    assertLogicalRange(logicalFrom, logicalTo, text.length);
    return Object.freeze({ from: from + logicalFrom, to: from + logicalTo });
  };
  const slice = (logicalFrom: number, logicalTo: number): ParagraphSourceText => {
    assertLogicalRange(logicalFrom, logicalTo, text.length);
    return readContiguousParagraphSourceText(source, from + logicalFrom, from + logicalTo);
  };
  return Object.freeze({ sourceRange, text, rangeFor, slice });
}

function appendMappedInputRange(
  input: string,
  sourceRange: ParagraphSourceRange,
  from: number,
  to: number,
  parts: string[],
  runs: SourceRun[],
  logicalLength: number,
): number {
  if (from >= to) return logicalLength;
  const piece = input.slice(from - sourceRange.from, to - sourceRange.from);
  if (piece.length !== to - from) throw new RangeError("Native paragraph input did not cover its physical source range");
  parts.push(piece);
  const previous = runs[runs.length - 1];
  if (previous && previous.logicalTo === logicalLength
    && previous.sourceFrom + (previous.logicalTo - previous.logicalFrom) === from) {
    runs[runs.length - 1] = {
      logicalFrom: previous.logicalFrom,
      logicalTo: logicalLength + piece.length,
      sourceFrom: previous.sourceFrom,
    };
  } else {
    runs.push({ logicalFrom: logicalLength, logicalTo: logicalLength + piece.length, sourceFrom: from });
  }
  return logicalLength + piece.length;
}

function appendMappedSlice(
  inputText: string,
  inputRuns: readonly SourceRun[],
  from: number,
  to: number,
  outputParts: string[],
  outputRuns: SourceRun[],
  outputLength: number,
): number {
  if (from >= to) return outputLength;
  outputParts.push(inputText.slice(from, to));
  for (const run of inputRuns) {
    const logicalFrom = Math.max(from, run.logicalFrom);
    const logicalTo = Math.min(to, run.logicalTo);
    if (logicalFrom >= logicalTo) continue;
    const sourceFrom = run.sourceFrom + logicalFrom - run.logicalFrom;
    const outputFrom = outputLength + logicalFrom - from;
    const outputTo = outputFrom + logicalTo - logicalFrom;
    const previous = outputRuns[outputRuns.length - 1];
    if (previous && previous.logicalTo === outputFrom
      && previous.sourceFrom + (previous.logicalTo - previous.logicalFrom) === sourceFrom) {
      outputRuns[outputRuns.length - 1] = {
        logicalFrom: previous.logicalFrom,
        logicalTo: outputTo,
        sourceFrom: previous.sourceFrom,
      };
    } else {
      outputRuns.push({ logicalFrom: outputFrom, logicalTo: outputTo, sourceFrom });
    }
  }
  return outputLength + to - from;
}

type NativeParagraphOmission = {
  readonly range: ParagraphSourceRange;
  readonly markerType?: NativeParagraphSourceMarker["typeName"];
};

function nativeParagraphOmissions(
  context: NativeParagraphSourceContext,
  sourceRange: ParagraphSourceRange,
  contentFrom: number,
  contentTo: number,
): NativeParagraphOmission[] {
  const omissions: NativeParagraphOmission[] = [];
  for (const marker of context.markers) {
    if (marker.range.from >= contentTo || marker.range.to <= contentFrom) continue;
    assertRange(marker.range, context.sourceRange.to, "Native paragraph marker");
    if (marker.range.from < contentFrom || marker.range.to > contentTo) {
      throw new RangeError("Native paragraph marker mapping escapes the requested authored text range");
    }
    omissions.push({ range: marker.range, markerType: marker.typeName });
  }
  for (const range of context.indentationRanges ?? []) {
    if (range.from >= contentTo || range.to <= contentFrom) continue;
    assertRange(range, context.sourceRange.to, "Native paragraph indentation");
    if (range.from < contentFrom || range.to > contentTo) {
      throw new RangeError("Native paragraph indentation mapping escapes the requested authored text range");
    }
    omissions.push({ range });
  }
  omissions.sort((left, right) => left.range.from - right.range.from || left.range.to - right.range.to);
  let previousTo = contentFrom;
  for (const omission of omissions) {
    if (omission.range.from < previousTo || omission.range.to > sourceRange.to) {
      throw new RangeError("Native paragraph marker and indentation ranges overlap or escape the requested extent");
    }
    previousTo = omission.range.to;
  }
  return omissions;
}

/**
 * Pure native phrasing-source projection. The caller supplies exact physical marker and
 * indentation ranges; omitted syntax is never inferred from marker lengths or Unicode trim.
 */
export function nativeParagraphSourceTextFromInput(
  input: string,
  sourceRange: ParagraphSourceRange,
  context: NativeParagraphSourceContext,
): ParagraphSourceText {
  assertRange(context.sourceRange, context.sourceRange.to, "Native paragraph owner");
  assertRange(sourceRange, context.sourceRange.to, "Native paragraph input");
  if (input.length !== sourceRange.to - sourceRange.from
    || sourceRange.from < context.sourceRange.from || sourceRange.to > context.sourceRange.to) {
    throw new RangeError("Native paragraph input must exactly cover a range within its admitted owner");
  }
  assertRange(context.textRange, context.sourceRange.to, "Native paragraph text");
  if (context.textRange.from < context.sourceRange.from || context.textRange.to > context.sourceRange.to) {
    throw new RangeError("Native paragraph text range escapes its physical owner");
  }

  const contentFrom = Math.max(sourceRange.from, context.textRange.from);
  const contentTo = Math.min(sourceRange.to, context.textRange.to);
  for (const indentation of context.indentationRanges ?? []) {
    if (indentation.from >= contentTo || indentation.to <= contentFrom) continue;
    const exactIndent = input.slice(indentation.from - sourceRange.from, indentation.to - sourceRange.from);
    if (!/^[\t ]+$/.test(exactIndent)) {
      throw new RangeError("Native paragraph indentation ranges may contain only authored ASCII spaces and tabs");
    }
  }
  const omissions = nativeParagraphOmissions(context, sourceRange, contentFrom, contentTo);
  const parts: string[] = [];
  const runs: SourceRun[] = [];
  let logicalLength = 0;
  let omissionIndex = 0;
  let lineFrom = contentFrom;

  while (lineFrom < contentTo) {
    const localLineFrom = lineFrom - sourceRange.from;
    const newline = input.indexOf("\n", localLineFrom);
    const lineTo = newline < 0 || sourceRange.from + newline >= contentTo
      ? contentTo
      : sourceRange.from + newline;
    let cursor = lineFrom;
    while (omissionIndex < omissions.length && omissions[omissionIndex]!.range.to <= lineFrom) omissionIndex += 1;
    while (omissionIndex < omissions.length && omissions[omissionIndex]!.range.from < lineTo) {
      const omission = omissions[omissionIndex]!;
      if (omission.range.from < cursor || omission.range.to > lineTo) {
        throw new RangeError("Native paragraph omission is inconsistent with physical line boundaries");
      }
      logicalLength = appendMappedInputRange(input, sourceRange, cursor, omission.range.from, parts, runs, logicalLength);
      cursor = omission.range.to;
      if (omission.markerType === "QuoteMark" && cursor < lineTo) {
        const next = input[cursor - sourceRange.from];
        if (next === " " || next === "\t") cursor += 1;
      }
      omissionIndex += 1;
    }
    logicalLength = appendMappedInputRange(input, sourceRange, cursor, lineTo, parts, runs, logicalLength);
    if (lineTo === contentTo) break;
    logicalLength = appendMappedInputRange(input, sourceRange, lineTo, lineTo + 1, parts, runs, logicalLength);
    lineFrom = lineTo + 1;
  }

  let text = parts.length === 0 ? "" : parts.length === 1 ? parts[0]! : parts.join("");
  if (text.length !== logicalLength) throw new RangeError("Native paragraph logical text lost UTF-16 units");
  if (context.task) {
    const taskPrefix = /^\[([ xX])\][\t ]+/.exec(text);
    if (taskPrefix) {
      const removed = taskPrefix[0].length;
      text = text.slice(removed);
      return sourceTextFromRuns(text, sourceRange, sliceRuns(runs, removed, logicalLength));
    }
  }
  return sourceTextFromRuns(text, sourceRange, runs);
}

/** Exact ASCII space/tab line-prefix ranges for the legacy P2 list-leaf projection. */
export function nativeParagraphSpaceTabIndentationRangesFromInput(
  input: string,
  sourceRange: ParagraphSourceRange,
  markers: readonly NativeParagraphSourceMarker[],
): readonly ParagraphSourceRange[] {
  if (input.length !== sourceRange.to - sourceRange.from) {
    throw new RangeError("Native paragraph indentation input must cover its physical range");
  }
  const orderedMarkers = markers.slice().sort((left, right) => left.range.from - right.range.from);
  const ranges: ParagraphSourceRange[] = [];
  let markerIndex = 0;
  let lineFrom = sourceRange.from;
  while (lineFrom < sourceRange.to) {
    const localLineFrom = lineFrom - sourceRange.from;
    const newline = input.indexOf("\n", localLineFrom);
    const lineTo = newline < 0 ? sourceRange.to : Math.min(sourceRange.to, sourceRange.from + newline);
    let cursor = lineFrom;
    while (markerIndex < orderedMarkers.length && orderedMarkers[markerIndex]!.range.to <= lineFrom) markerIndex += 1;
    while (markerIndex < orderedMarkers.length && orderedMarkers[markerIndex]!.range.from < lineTo) {
      const marker = orderedMarkers[markerIndex]!;
      if (marker.range.from < cursor || marker.range.to > lineTo) {
        throw new RangeError("Native marker does not align with its physical line");
      }
      const before = input.slice(cursor - sourceRange.from, marker.range.from - sourceRange.from);
      const leading = /^[\t ]*/.exec(before)![0].length;
      if (leading > 0) ranges.push(Object.freeze({ from: cursor, to: cursor + leading }));
      if (leading !== before.length) break;
      cursor = marker.range.to;
      if (marker.typeName === "QuoteMark" && cursor < lineTo) {
        const next = input[cursor - sourceRange.from];
        if (next === " " || next === "\t") cursor += 1;
      }
      markerIndex += 1;
    }
    const remainder = input.slice(cursor - sourceRange.from, lineTo - sourceRange.from);
    const leading = /^[\t ]*/.exec(remainder)![0].length;
    if (leading > 0) ranges.push(Object.freeze({ from: cursor, to: cursor + leading }));
    if (lineTo === sourceRange.to) break;
    lineFrom = lineTo + 1;
  }
  return Object.freeze(ranges);
}

/** Read only the requested canonical physical range, then use the pure native source projection. */
export function readNativeParagraphSourceText(
  source: SourceSnapshot,
  context: NativeParagraphSourceContext,
  from = context.sourceRange.from,
  to = context.sourceRange.to,
): ParagraphSourceText {
  assertRange(context.sourceRange, source.length, "Native paragraph owner");
  assertRange({ from, to }, source.length, "Native paragraph read");
  if (from < context.sourceRange.from || to > context.sourceRange.to) {
    throw new RangeError("Native paragraph source read must stay inside its admitted physical extent");
  }
  const input = source.read(from, to);
  if (input.length !== to - from) throw new RangeError("Canonical paragraph source read returned a short range");
  return nativeParagraphSourceTextFromInput(input, { from, to }, context);
}

/** Build context from actual native Paragraph/Task nodes; marker coordinates stay caller-mapped. */
export function nativeParagraphSourceContext(
  paragraph: SyntaxNode,
  sourceRange: ParagraphSourceRange,
  textRange: ParagraphSourceRange,
  mapMarker: NativeParagraphMarkerMapper,
  extraMarkers: readonly NativeParagraphSourceMarker[] = [],
  extraIndentationRanges: readonly ParagraphSourceRange[] = [],
): NativeParagraphSourceContext {
  const markers: NativeParagraphSourceMarker[] = Array.from(extraMarkers);
  const seen = new Set<SyntaxNode>();
  const collect = (node: SyntaxNode): void => {
    if (node.type.name === "QuoteMark" || node.type.name === "ListMark") {
      if (seen.has(node)) return;
      seen.add(node);
      const range = mapMarker(node);
      if (range) markers.push({ typeName: node.type.name, range });
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) collect(child);
  };
  collect(paragraph);
  for (let parent = paragraph.parent; parent; parent = parent.parent) {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.type.name === "QuoteMark" || child.type.name === "ListMark") collect(child);
    }
  }
  let task = false;
  for (let node: SyntaxNode | null = paragraph; node; node = node.parent) {
    if (node.type.name === "Task") task = true;
  }
  return Object.freeze({
    sourceRange: Object.freeze({ from: sourceRange.from, to: sourceRange.to }),
    textRange: Object.freeze({ from: textRange.from, to: textRange.to }),
    markers: Object.freeze(markers.filter((marker) =>
      marker.range.from < sourceRange.to && marker.range.to > sourceRange.from,
    )),
    indentationRanges: Object.freeze(Array.from(extraIndentationRanges)),
    task,
  });
}

export function readNativeParagraphSourceTextReader(
  context: NativeParagraphSourceContext,
): ParagraphSourceTextReader {
  return (source, from, to) => readNativeParagraphSourceText(source, context, from, to);
}
