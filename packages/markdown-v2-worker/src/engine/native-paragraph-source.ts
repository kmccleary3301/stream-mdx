declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

import type { Input, SyntaxNode } from "@lezer/common";
import type { SourceSnapshot } from "@stream-mdx/core";

export interface ParagraphSourceRange {
  readonly from: number;
  readonly to: number;
}

/** Logical paragraph text mapped onto its exact authored UTF-16 source extent. */
export interface ParagraphSourceText {
  readonly sourceRange: ParagraphSourceRange;
  readonly text: string;
  /** Exact physical ranges omitted from logical text; syntax belongs to the left logical range. */
  readonly omittedRanges?: readonly ParagraphSourceRange[];
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
  /** Marks a parser anchor that may outlive its speculative syntax node. */
  readonly fromTailAnchor?: boolean;
}

/**
 * Physical coordinates supplied by native paragraph admission. `textRange` is the native
 * paragraph/Task input; `sourceRange` is the authored extent owned by the prepared paragraph.
 */
export interface NativeParagraphSourceContext {
  readonly sourceRange: ParagraphSourceRange;
  readonly textRange: ParagraphSourceRange;
  readonly markers: readonly NativeParagraphSourceMarker[];
  readonly taskMarker?: ParagraphSourceRange;
  /** Exact ASCII space/tab container-indent ranges supplied by native parsing. */
  readonly indentationRanges?: readonly ParagraphSourceRange[];
}
export type NativeParagraphSourceTextReader = ParagraphSourceTextReader & {
  appendContext(context: NativeParagraphSourceContext, replaceFrom?: number): void;
  fork(context: NativeParagraphSourceContext, replaceFrom?: number): NativeParagraphSourceTextReader;
};

interface NativeParagraphSourceDiagnosticCounters {
  recordPrefixComparisons?(count?: number, stage?: "engine"): void;
  recordSourceUnitsRead?(count: number, stage?: "engine"): void;
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
  omittedRanges?: readonly ParagraphSourceRange[],
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
  let ownedOmittedRanges: readonly ParagraphSourceRange[] | undefined;
  if (omittedRanges?.length) {
    let previousOmittedTo = sourceRange.from;
    ownedOmittedRanges = Object.freeze(omittedRanges.map((range) => {
      if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
        || range.from < previousOmittedTo || range.to <= range.from || range.to > sourceRange.to) {
        throw new RangeError("Paragraph source omission ranges must be ordered within the authored extent");
      }
      previousOmittedTo = range.to;
      return Object.freeze({ from: range.from, to: range.to });
    }));
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
    let slicedOmittedRanges: ParagraphSourceRange[] | undefined;
    if (ownedOmittedRanges) {
      for (const range of ownedOmittedRanges) {
        if (range.from >= nextRange.from && range.to <= nextRange.to) {
          (slicedOmittedRanges ??= []).push(range);
        } else if (range.from < nextRange.to && range.to > nextRange.from) {
          throw new RangeError("Paragraph source slice cuts through an omitted source range");
        }
      }
    }
    return sourceTextFromRuns(text.slice(from, to), nextRange, sliceRuns(runs, from, to), slicedOmittedRanges);
  };

  return Object.freeze({
    sourceRange: Object.freeze({ from: sourceRange.from, to: sourceRange.to }),
    text,
    ...(ownedOmittedRanges === undefined ? {} : { omittedRanges: ownedOmittedRanges }),
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

function firstRangeEndingAfter<T>(
  values: readonly T[],
  from: number,
  rangeOf: (value: T) => ParagraphSourceRange,
  startAt?: number,
  counters?: NativeParagraphSourceDiagnosticCounters,
): number {
  let low = Math.min(startAt ?? 0, values.length);
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "engine");
    }
    if (rangeOf(values[middle]!).to <= from) low = middle + 1;
    else high = middle;
  }
  return low;
}
type NativeParagraphOmission = {
  readonly range: ParagraphSourceRange;
  readonly markerType?: NativeParagraphSourceMarker["typeName"] | "TaskMarker";
};

function nativeParagraphOmissions(
  context: NativeParagraphSourceContext,
  input: string,
  sourceRange: ParagraphSourceRange,
  contentFrom: number,
  contentTo: number,
  firstIndentation: number,
  counters?: NativeParagraphSourceDiagnosticCounters,
): NativeParagraphOmission[] {
  const omissions: NativeParagraphOmission[] = [];
  const firstMarker = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? firstRangeEndingAfter(context.markers, contentFrom, (marker) => marker.range, undefined, counters)
    : firstRangeEndingAfter(context.markers, contentFrom, (marker) => marker.range);
  for (let index = firstMarker; index < context.markers.length; index += 1) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "engine");
    }
    const marker = context.markers[index]!;
    if (marker.range.from >= contentTo) break;
    assertRange(marker.range, context.sourceRange.to, "Native paragraph marker");
    if (marker.range.from < contentFrom || marker.range.to > contentTo) {
      throw new RangeError("Native paragraph marker mapping escapes the requested authored text range");
    }
    // A complete tail anchor with no list-item separator was speculative, not syntax.
    if (marker.fromTailAnchor === true
      && marker.typeName === "ListMark"
      && marker.range.to < contentTo) {
      const markerEnd = marker.range.to - sourceRange.from;
      const markerLast = input.charCodeAt(markerEnd - 1);
      const next = input.charCodeAt(markerEnd);
      const separated = markerLast === 9 || markerLast === 32
        || next === 9 || next === 10 || next === 13 || next === 32;
      if (!separated) continue;
    }
    omissions.push({ range: marker.range, markerType: marker.typeName });
  }
  const taskMarker = context.taskMarker;
  if (taskMarker && taskMarker.from < contentTo && taskMarker.to > contentFrom) {
    assertRange(taskMarker, context.sourceRange.to, "Native paragraph task marker");
    if (taskMarker.from < contentFrom || taskMarker.to > contentTo) {
      throw new RangeError("Native task marker mapping escapes the requested authored text range");
    }
    omissions.push({ range: taskMarker, markerType: "TaskMarker" });
  }
  const indentationRanges = context.indentationRanges ?? [];
  for (let index = firstIndentation; index < indentationRanges.length; index += 1) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "engine");
    }
    const range = indentationRanges[index]!;
    if (range.from >= contentTo) break;
    assertRange(range, context.sourceRange.to, "Native paragraph indentation");
    if (range.from < contentFrom || range.to > contentTo) {
      throw new RangeError("Native paragraph indentation mapping escapes the requested authored text range");
    }
    omissions.push({ range });
  }
  omissions.sort((left, right) => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "engine");
    }
    return left.range.from - right.range.from || left.range.to - right.range.to;
  });
  let previousTo = contentFrom;
  for (const omission of omissions) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "engine");
    }
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
  counters?: NativeParagraphSourceDiagnosticCounters,
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
  const indentationRanges = context.indentationRanges ?? [];
  const firstIndentation = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? firstRangeEndingAfter(indentationRanges, contentFrom, (range) => range, undefined, counters)
    : firstRangeEndingAfter(indentationRanges, contentFrom, (range) => range);
  for (let index = firstIndentation; index < indentationRanges.length; index += 1) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "engine");
    }
    const indentation = indentationRanges[index]!;
    if (indentation.from >= contentTo) break;
    if (indentation.to <= contentFrom) continue;
    const exactIndent = input.slice(indentation.from - sourceRange.from, indentation.to - sourceRange.from);
    if (!/^[\t ]+$/.test(exactIndent)) {
      throw new RangeError("Native paragraph indentation ranges may contain only authored ASCII spaces and tabs");
    }
  }
  const omissions = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? nativeParagraphOmissions(context, input, sourceRange, contentFrom, contentTo, firstIndentation, counters)
    : nativeParagraphOmissions(context, input, sourceRange, contentFrom, contentTo, firstIndentation);
  const parts: string[] = [];
  const runs: SourceRun[] = [];
  let logicalLength = 0;
  let omittedRanges: ParagraphSourceRange[] | undefined;
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
      } else if (omission.markerType === "TaskMarker") {
        while (cursor < lineTo) {
          const next = input[cursor - sourceRange.from];
          if (next !== " " && next !== "\t") break;
          cursor += 1;
        }
      }
      (omittedRanges ??= []).push({ from: omission.range.from, to: cursor });
      omissionIndex += 1;
    }
    logicalLength = appendMappedInputRange(input, sourceRange, cursor, lineTo, parts, runs, logicalLength);
    if (lineTo === contentTo) break;
    logicalLength = appendMappedInputRange(input, sourceRange, lineTo, lineTo + 1, parts, runs, logicalLength);
    lineFrom = lineTo + 1;
  }

  let text = parts.length === 0 ? "" : parts.length === 1 ? parts[0]! : parts.join("");
  if (text.length !== logicalLength) throw new RangeError("Native paragraph logical text lost UTF-16 units");
  return sourceTextFromRuns(text, sourceRange, runs, omittedRanges);
}

/** Exact ASCII space/tab container-indent ranges from only the current native input window. */
export function nativeParagraphSpaceTabIndentationRangesFromInput(
  input: Input,
  inputRange: ParagraphSourceRange,
  mapRange: (from: number, to: number) => ParagraphSourceRange,
  markers: readonly NativeParagraphSourceMarker[],
  counters?: NativeParagraphSourceDiagnosticCounters,
): readonly ParagraphSourceRange[] {
  const text = input.read(inputRange.from, inputRange.to);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && text.length > 0) {
    counters?.recordSourceUnitsRead?.(text.length, "engine");
  }
  if (text.length !== inputRange.to - inputRange.from) {
    throw new RangeError("Native paragraph indentation input must cover its bounded native range");
  }
  const ranges: ParagraphSourceRange[] = [];
  let lineFrom = 0;
  while (lineFrom < text.length) {
    let lineTo = text.indexOf("\n", lineFrom);
    const carriageReturn = text.indexOf("\r", lineFrom);
    if (carriageReturn >= 0 && (lineTo < 0 || carriageReturn < lineTo)) lineTo = carriageReturn;
    if (lineTo < 0) lineTo = text.length;
    const line = text.slice(lineFrom, lineTo);
    const sourceRange = mapRange(inputRange.from + lineFrom, inputRange.from + lineTo);
    if (line.length !== sourceRange.to - sourceRange.from) {
      throw new RangeError("Native paragraph indentation line does not map to a contiguous physical range");
    }
    const orderedMarkers = markers
      .filter((marker) => {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          counters?.recordPrefixComparisons?.(1, "engine");
        }
        return marker.range.from >= sourceRange.from && marker.range.to <= sourceRange.to;
      })
      .sort((left, right) => {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          counters?.recordPrefixComparisons?.(1, "engine");
        }
        return left.range.from - right.range.from;
      });
    let cursor = sourceRange.from;
    for (const marker of orderedMarkers) {
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        counters?.recordPrefixComparisons?.(1, "engine");
      }
      if (marker.range.from < cursor || marker.range.to > sourceRange.to) {
        throw new RangeError("Native marker does not align with its physical line");
      }
      const before = line.slice(cursor - sourceRange.from, marker.range.from - sourceRange.from);
      const leading = /^[\t ]*/.exec(before)![0].length;
      if (leading > 0) ranges.push(Object.freeze({ from: cursor, to: cursor + leading }));
      if (leading !== before.length) break;
      cursor = marker.range.to;
      if (marker.typeName === "QuoteMark" && cursor < sourceRange.to) {
        const next = line[cursor - sourceRange.from];
        if (next === " " || next === "\t") cursor += 1;
      }
    }
    const remainder = line.slice(cursor - sourceRange.from);
    const leading = /^[\t ]*/.exec(remainder)![0].length;
    if (leading > 0) ranges.push(Object.freeze({ from: cursor, to: cursor + leading }));
    if (lineTo === text.length) break;
    lineFrom = lineTo + (text[lineTo] === "\r" && text[lineTo + 1] === "\n" ? 2 : 1);
  }
  return Object.freeze(ranges);
}

/** Read only the requested canonical physical range, then use the pure native source projection. */
export function readNativeParagraphSourceText(
  source: SourceSnapshot,
  context: NativeParagraphSourceContext,
  from = context.sourceRange.from,
  to = context.sourceRange.to,
  counters?: NativeParagraphSourceDiagnosticCounters,
): ParagraphSourceText {
  assertRange(context.sourceRange, source.length, "Native paragraph owner");
  assertRange({ from, to }, source.length, "Native paragraph read");
  if (from < context.sourceRange.from || to > context.sourceRange.to) {
    throw new RangeError("Native paragraph source read must stay inside its admitted physical extent");
  }
  const input = source.read(from, to);
  if (input.length !== to - from) throw new RangeError("Canonical paragraph source read returned a short range");
  return typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? nativeParagraphSourceTextFromInput(input, { from, to }, context, counters)
    : nativeParagraphSourceTextFromInput(input, { from, to }, context);
}

type NativeParagraphSourceMarkerAnchor = {
  readonly typeName: NativeParagraphSourceMarker["typeName"];
  readonly from: number;
  readonly to: number;
};

/** Build context from actual native Paragraph/Task nodes; marker coordinates stay caller-mapped. */
export function nativeParagraphSourceContext(
  paragraph: SyntaxNode,
  sourceRange: ParagraphSourceRange,
  textRange: ParagraphSourceRange,
  mapMarker: NativeParagraphMarkerMapper,
  extraMarkers: readonly NativeParagraphSourceMarkerAnchor[] = [],
  extraIndentationRanges: readonly ParagraphSourceRange[] = [],
  minimumSourceOffset = sourceRange.from,
  skipAncestorSiblingScan = false,
  counters?: NativeParagraphSourceDiagnosticCounters,
): NativeParagraphSourceContext {
  const markers: NativeParagraphSourceMarker[] = [];
  for (const marker of extraMarkers) {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "engine");
    }
    if (marker.from < sourceRange.to && marker.to > sourceRange.from && marker.to > minimumSourceOffset) {
      markers.push({ typeName: marker.typeName, range: marker, fromTailAnchor: true });
    }
  }
  let seen: Set<SyntaxNode> | undefined;
  const collect = (node: SyntaxNode): void => {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordPrefixComparisons?.(1, "engine");
    }
    if (minimumSourceOffset > sourceRange.from) {
      const nodeRange = mapMarker(node);
      if (nodeRange && nodeRange.to <= minimumSourceOffset) return;
    }
    if (node.type.name === "QuoteMark" || node.type.name === "ListMark") {
      if (seen?.has(node)) return;
      seen?.add(node);
      const range = mapMarker(node);
      if (range && range.to > minimumSourceOffset) markers.push({ typeName: node.type.name, range });
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) collect(child);
  };
  // Typed anchors replace ancestor sibling scans, not marks inside the changing paragraph.
  if (!skipAncestorSiblingScan) seen = new Set<SyntaxNode>();
  collect(paragraph);
  if (!skipAncestorSiblingScan) {
    for (let parent = paragraph.parent; parent; parent = parent.parent) {
      for (let child = parent.firstChild; child; child = child.nextSibling) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          counters?.recordPrefixComparisons?.(1, "engine");
        }
        if (child.type.name === "QuoteMark" || child.type.name === "ListMark") collect(child);
      }
    }
  }
  const taskMarkerNode = paragraph.type.name === "Task" ? paragraph.getChild("TaskMarker") : null;
  const taskMarker = taskMarkerNode ? mapMarker(taskMarkerNode) : undefined;
  markers.sort((left, right) =>
    left.range.from - right.range.from
      || left.range.to - right.range.to
      || left.typeName.localeCompare(right.typeName));
  let uniqueMarkerCount = 0;
  for (const marker of markers) {
    const previous = markers[uniqueMarkerCount - 1];
    if (previous
      && previous.range.from === marker.range.from
      && previous.range.to === marker.range.to
      && previous.typeName === marker.typeName) {
      if (previous.fromTailAnchor === true && marker.fromTailAnchor !== true) {
        markers[uniqueMarkerCount - 1] = marker;
      }
      continue;
    }
    markers[uniqueMarkerCount] = marker;
    uniqueMarkerCount += 1;
  }
  markers.length = uniqueMarkerCount;
  return Object.freeze({
    sourceRange: Object.freeze({ from: sourceRange.from, to: sourceRange.to }),
    textRange: Object.freeze({ from: textRange.from, to: textRange.to }),
    markers: Object.freeze(markers),
    ...(taskMarker ? { taskMarker: Object.freeze({ from: taskMarker.from, to: taskMarker.to }) } : {}),
    indentationRanges: Object.freeze(Array.from(extraIndentationRanges)),
  });
}

export function readNativeParagraphSourceTextReader(
  context: NativeParagraphSourceContext,
  counters?: NativeParagraphSourceDiagnosticCounters,
): NativeParagraphSourceTextReader {
  let sourceRange = { from: context.sourceRange.from, to: context.sourceRange.from };
  let textRange = { from: context.textRange.from, to: context.textRange.from };
  const markers: NativeParagraphSourceMarker[] = [];
  const indentationRanges: ParagraphSourceRange[] = [];
  let taskMarker: ParagraphSourceRange | undefined;
  let markerReplaceStart = 0;
  let indentationReplaceStart = 0;
  let previousReplaceFrom: number | undefined;
  const appendContext = (next: NativeParagraphSourceContext, replaceFrom?: number): void => {
    if (replaceFrom !== undefined
      && (!Number.isSafeInteger(replaceFrom)
        || replaceFrom < next.sourceRange.from
        || replaceFrom > next.sourceRange.to)) {
      throw new RangeError("Native paragraph context replacement must stay inside its physical owner");
    }
    sourceRange = {
      from: Math.min(sourceRange.from, next.sourceRange.from),
      to: Math.max(sourceRange.to, next.sourceRange.to),
    };
    textRange = {
      from: Math.min(textRange.from, next.textRange.from),
      to: Math.max(textRange.to, next.textRange.to),
    };
    if (replaceFrom !== undefined) {
      const monotonicReplace = previousReplaceFrom !== undefined && replaceFrom >= previousReplaceFrom;
      const markerSearchFrom = monotonicReplace ? markerReplaceStart : 0;
      const indentationSearchFrom = monotonicReplace ? indentationReplaceStart : 0;
      const markerStart = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? firstRangeEndingAfter(markers, replaceFrom, (marker) => marker.range, markerSearchFrom, counters)
        : firstRangeEndingAfter(markers, replaceFrom, (marker) => marker.range, markerSearchFrom);
      const indentationStart = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? firstRangeEndingAfter(indentationRanges, replaceFrom, (range) => range, indentationSearchFrom, counters)
        : firstRangeEndingAfter(indentationRanges, replaceFrom, (range) => range, indentationSearchFrom);
      markers.splice(markerStart);
      indentationRanges.splice(indentationStart);
      markerReplaceStart = markerStart;
      indentationReplaceStart = indentationStart;
      previousReplaceFrom = replaceFrom;
      if (taskMarker && taskMarker.to > replaceFrom) taskMarker = undefined;
    }
    for (const marker of next.markers) {
      const last = markers[markers.length - 1];
      if (last && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        counters?.recordPrefixComparisons?.(1, "engine");
      }
      if (!last
        || last.range.from < marker.range.from
        || (last.range.from === marker.range.from && last.range.to < marker.range.to)) {
        markers.push(marker);
        continue;
      }
      let low = 0;
      let high = markers.length;
      while (low < high) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          counters?.recordPrefixComparisons?.(1, "engine");
        }
        const middle = (low + high) >>> 1;
        const current = markers[middle]!;
        if (current.range.from < marker.range.from
          || (current.range.from === marker.range.from && current.range.to < marker.range.to)) low = middle + 1;
        else high = middle;
      }
      const current = markers[low];
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && current) {
        counters?.recordPrefixComparisons?.(1, "engine");
      }
      if (current?.typeName !== marker.typeName
        || current.range.from !== marker.range.from
        || current.range.to !== marker.range.to) {
        markers.splice(low, 0, marker);
        if (low < markerReplaceStart) markerReplaceStart += 1;
      }
    }
    if (next.taskMarker) taskMarker = next.taskMarker;
    for (const range of next.indentationRanges ?? []) {
      const last = indentationRanges[indentationRanges.length - 1];
      if (last && typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        counters?.recordPrefixComparisons?.(1, "engine");
      }
      if (!last || last.from < range.from || (last.from === range.from && last.to < range.to)) {
        indentationRanges.push(range);
        continue;
      }
      let low = 0;
      let high = indentationRanges.length;
      while (low < high) {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          counters?.recordPrefixComparisons?.(1, "engine");
        }
        const middle = (low + high) >>> 1;
        const current = indentationRanges[middle]!;
        if (current.from < range.from || (current.from === range.from && current.to < range.to)) low = middle + 1;
        else high = middle;
      }
      const current = indentationRanges[low];
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && current) {
        counters?.recordPrefixComparisons?.(1, "engine");
      }
      if (current?.from !== range.from || current.to !== range.to) {
        indentationRanges.splice(low, 0, range);
        if (low < indentationReplaceStart) indentationReplaceStart += 1;
      }
    }
  };
  appendContext(context);
  const reader = ((source: SourceSnapshot, from: number, to: number) => {
    const currentContext = {
      sourceRange,
      textRange,
      markers,
      ...(taskMarker ? { taskMarker } : {}),
      indentationRanges,
    };
    return typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? readNativeParagraphSourceText(source, currentContext, from, to, counters)
      : readNativeParagraphSourceText(source, currentContext, from, to);
  }) as NativeParagraphSourceTextReader;
  reader.appendContext = appendContext;
  reader.fork = (next, replaceFrom) => {
    const forkContext = {
      sourceRange,
      textRange,
      markers,
      ...(taskMarker ? { taskMarker } : {}),
      indentationRanges,
    };
    const fork = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? readNativeParagraphSourceTextReader(forkContext, counters)
      : readNativeParagraphSourceTextReader(forkContext);
    fork.appendContext(next, replaceFrom);
    return fork;
  };
  return reader;
}
