import type { Input, SyntaxNode } from "@lezer/common";
import type { SourceSnapshot } from "@stream-mdx/core";
import { SourceRangeInput } from "./root-code-pipeline";

export type NativeContainerFrameKind = "list" | "item" | "quote";

export interface NativeContainerMarkerAnchor {
  readonly typeName: "ListMark" | "QuoteMark";
  readonly from: number;
  readonly to: number;
  readonly globalChildIndex?: number;
  readonly inputFrom?: number;
}

export interface NativeContainerContextLine {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

export interface NativeContainerWindowFrame {
  readonly kind: NativeContainerFrameKind;
  readonly typeName: string;
  /** Active semantic child; omitted from public tail-state frames. */
  readonly activeChildTypeName?: string;
  /** Zero-based semantic sibling slot; omitted native syntax markers consume no slot. */
  readonly fromChild: number;
  readonly sourceFrontier: number;
  readonly nextChildIndex: number;
  readonly parentFrom: number;
  readonly parentTo: number;
  readonly firstMarker?: NativeContainerMarkerAnchor;
  readonly activeMarker?: NativeContainerMarkerAnchor;
  /** Sibling item markers retained between the first and active items; see `listMarkerChain`. */
  readonly listChain?: readonly NativeContainerMarkerAnchor[];
  readonly quoteMarker?: NativeContainerMarkerAnchor;
  readonly firstQuoteMarker?: NativeContainerMarkerAnchor;
  /** Quote marks on retained list-item or code-opening context lines. */
  readonly contextQuoteMarkers?: readonly NativeContainerMarkerAnchor[];
  readonly firstContextLine?: NativeContainerContextLine;
  /** False while the retained line still reaches the current source end. */
  readonly firstContextLineComplete?: boolean;
  /** Physical source end of the semantic sibling before this frame's active child. */
  readonly childToBeforeFrontier?: number;
}

export interface NativeContainerCodeOpening {
  readonly kind: "fenced" | "indented";
  readonly openingLineFrom: number;
  readonly openingTextFrom: number;
  readonly openingLineTo: number;
  /** Physical source start of a closing fence needed when rebuilding a bounded code window. */
  readonly closingLineFrom?: number;
  /** Exact source context; a fenced opener still in its active physical line stays empty. */
  readonly openingContextText: string;
}

export interface NativeContainerWindowSourceMapping {
  readonly input: Input;
  readonly source: SourceSnapshot;
  readonly mapOffset: (offset: number) => number;
  readonly mapRange: (from: number, to: number) => { readonly from: number; readonly to: number };
}

interface InputSourceRun {
  readonly inputFrom: number;
  readonly inputTo: number;
  readonly sourceFrom: number;
  readonly sourceTo: number;
}

export interface NativeContainerWindow {
  readonly input: Input;
  /** Input offset at which the changing physical source suffix starts. */
  readonly prefixLength: number;
  /** Physical source offset corresponding to the window input's linear suffix. */
  readonly sourceOffset: number;
  readonly anchors: readonly NativeContainerMarkerAnchor[];
  readonly contextAnchors: readonly (NativeContainerContextLine & { readonly inputFrom: number; readonly inputTo: number })[];
  readonly mapping: NativeContainerWindowSourceMapping;
}

class ConcatenatedInput implements Input {
  readonly lineChunks = true;
  readonly length: number;

  constructor(private readonly prefix: string, private readonly tail: SourceRangeInput) {
    this.length = prefix.length + tail.length;
  }

  chunk(from: number): string {
    const position = Math.max(0, Math.min(this.length, from));
    if (position === this.length) return "";
    if (position >= this.prefix.length) return this.tail.chunk(position - this.prefix.length);

    const newline = this.prefix.indexOf("\n", position);
    if (newline >= 0) {
      return newline === position ? "\n" : this.prefix.slice(position, newline);
    }

    const prefixChunk = this.prefix.slice(position);
    const tailChunk = this.tail.chunk(0);
    const tailNewline = tailChunk.indexOf("\n");
    return prefixChunk + (tailNewline < 0 ? tailChunk : tailChunk.slice(0, tailNewline));
  }

  read(from: number, to: number): string {
    const start = Math.max(0, Math.min(this.length, from));
    const end = Math.max(start, Math.min(this.length, to));
    if (start === end) return "";
    if (end <= this.prefix.length) return this.prefix.slice(start, end);
    if (start >= this.prefix.length) return this.tail.read(start - this.prefix.length, end - this.prefix.length);
    return this.prefix.slice(start) + this.tail.read(0, end - this.prefix.length);
  }
}

export function lineStartAt(source: SourceSnapshot, before: number, floor = 0): number {
  const minimum = Math.max(0, Math.min(source.length, floor));
  let cursor = Math.max(minimum, Math.min(source.length, before));
  while (cursor > minimum) {
    const from = Math.max(minimum, cursor - 256);
    const text = source.read(from, cursor);
    const newline = text.lastIndexOf("\n");
    const carriageReturn = text.lastIndexOf("\r");
    const lineBreak = Math.max(newline, carriageReturn);
    if (lineBreak >= 0) {
      if (text[lineBreak] === "\r" && lineBreak === text.length - 1) {
        if (cursor === source.length || source.read(cursor, cursor + 1) === "\n") {
          cursor = from + lineBreak;
          continue;
        }
      }
      return from + lineBreak + 1;
    }
    cursor = from;
  }
  return minimum;
}

export function lineEndAt(source: SourceSnapshot, from: number, limit = source.length): number {
  let cursor = Math.max(0, Math.min(limit, from));
  while (cursor < limit) {
    const end = Math.min(limit, cursor + 256);
    const text = source.read(cursor, end);
    let newline = text.indexOf("\n");
    const carriageReturn = text.indexOf("\r");
    if (carriageReturn >= 0 && (newline < 0 || carriageReturn < newline)) newline = carriageReturn;
    if (newline >= 0) return cursor + newline;
    cursor = end;
  }
  return limit;
}

export function lastPhysicalLineStart(source: SourceSnapshot, from = 0, to = source.length): number {
  const floor = Math.max(0, Math.min(source.length, from));
  return lineStartAt(source, Math.max(floor, to), floor);
}

function physicalLineEnd(source: SourceSnapshot, lineEnd: number, limit: number): number {
  if (lineEnd >= limit) return lineEnd;
  const next = source.read(lineEnd, Math.min(limit, lineEnd + 2));
  if (next.startsWith("\r\n")) return lineEnd + 2;
  if (next.startsWith("\r") || next.startsWith("\n")) return lineEnd + 1;
  return lineEnd;
}

function markerIndent(source: SourceSnapshot, marker: NativeContainerMarkerAnchor): number {
  return marker.from - lineStartAt(source, marker.from);
}

function markerContentColumn(source: SourceSnapshot, marker: NativeContainerMarkerAnchor): number {
  const lineEnd = lineEndAt(source, marker.to, source.length);
  let spaces = 0;
  while (marker.to + spaces < lineEnd && source.read(marker.to + spaces, marker.to + spaces + 1) === " ") spaces += 1;
  const width = marker.to + spaces >= lineEnd || spaces === 0 || spaces > 4 ? 1 : spaces;
  return marker.to - lineStartAt(source, marker.from) + width;
}

/**
 * Item marker lines a list window keeps between its first and active items. A line is a sibling item only if it
 * starts left of the content column of the item line before it, so omitting wider intermediate markers could nest
 * a later sibling under an earlier item. Each candidate is pushed in source order, dropping the previous kept line
 * when the candidate is already a sibling of the line before that one.
 */
export function listMarkerChain(
  source: SourceSnapshot,
  first: NativeContainerMarkerAnchor | undefined,
  candidates: readonly NativeContainerMarkerAnchor[],
  active: NativeContainerMarkerAnchor | undefined,
): readonly NativeContainerMarkerAnchor[] {
  const kept: NativeContainerMarkerAnchor[] = first ? [first] : [];
  const push = (marker: NativeContainerMarkerAnchor): void => {
    while (kept.length >= 2 && markerIndent(source, marker) < markerContentColumn(source, kept[kept.length - 2]!)) kept.pop();
    kept.push(marker);
  };
  for (const candidate of candidates) {
    if (candidate.from !== first?.from && candidate.from !== active?.from) push(candidate);
  }
  if (active && active.from !== first?.from) push(active);
  const chain = kept.slice(first ? 1 : 0);
  if (active && chain[chain.length - 1]?.from === active.from) chain.pop();
  return Object.freeze(chain);
}

function listChainMarkers(frame: NativeContainerWindowFrame): readonly NativeContainerMarkerAnchor[] {
  return frame.kind === "list" ? frame.listChain ?? [] : [];
}

function markerOpenings(frames: readonly NativeContainerWindowFrame[]): NativeContainerMarkerAnchor[] {
  const result: NativeContainerMarkerAnchor[] = [];
  const append = (marker: NativeContainerMarkerAnchor): void => {
    if (!result.some((candidate) => candidate.typeName === marker.typeName && candidate.from === marker.from)) {
      result.push(marker);
    }
  };
  for (const frame of frames) {
    if (frame.kind === "list") {
      if (frame.firstMarker) append({ ...frame.firstMarker, globalChildIndex: 0 });
      for (const marker of listChainMarkers(frame)) append(marker);
      if (frame.activeMarker && frame.activeMarker.from !== frame.firstMarker?.from) {
        append({ ...frame.activeMarker, globalChildIndex: frame.fromChild });
      }
    } else if (frame.kind === "quote") {
      if (frame.firstQuoteMarker) append(frame.firstQuoteMarker);
      if (frame.quoteMarker && frame.quoteMarker.from !== frame.firstQuoteMarker?.from) append(frame.quoteMarker);
      for (const marker of frame.contextQuoteMarkers ?? []) append(marker);
    }
  }
  return result;
}

function readTrailingWhitespace(source: SourceSnapshot, from: number, limit: number): number {
  let cursor = Math.max(0, Math.min(limit, from));
  while (cursor < limit) {
    const end = Math.min(limit, cursor + 128);
    const text = source.read(cursor, end);
    const match = /[^\t ]/.exec(text);
    if (match) return cursor + match.index;
    cursor = end;
  }
  return limit;
}

function validMarkerGap(source: SourceSnapshot, from: number, to: number): boolean {
  if (to < from) return false;
  return /^[\t ]*$/.test(source.read(from, to));
}

function activeContextGapStart(
  source: SourceSnapshot,
  frames: readonly NativeContainerWindowFrame[],
  before: number,
  limit: number,
): number | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const previousChildEnd = frames[index]!.childToBeforeFrontier;
    if (previousChildEnd !== undefined && previousChildEnd <= before) return previousChildEnd;
  }
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]!;
    const marker = frame.kind === "quote" ? frame.quoteMarker : frame.activeMarker;
    if (!marker) continue;
    const lineFrom = lineStartAt(source, marker.from);
    if (lineFrom >= before) continue;
    const lineEnd = physicalLineEnd(source, lineEndAt(source, lineFrom, limit), limit);
    if (lineEnd <= before) return lineEnd;
  }
  return undefined;
}
function boundedContextGapStart(
  source: SourceSnapshot,
  candidate: number | undefined,
  before: number,
): number | undefined {
  if (candidate === undefined || before <= candidate) return undefined;
  const from = Math.max(candidate, before - 256);
  const gap = source.read(from, before);
  if (!/^[\t >\r\n]*$/.test(gap) || !/\r?\n[\t >]*\r?\n/.test(gap)) return undefined;
  return from;
}

function sameRuns(left: readonly InputSourceRun[], right: readonly InputSourceRun[]): boolean {
  return left.length === right.length && left.every((run, index) => {
    const other = right[index];
    return other !== undefined
      && run.inputFrom === other.inputFrom
      && run.inputTo === other.inputTo
      && run.sourceFrom === other.sourceFrom
      && run.sourceTo === other.sourceTo;
  });
}
function sameRunPrefix(left: readonly InputSourceRun[], right: readonly InputSourceRun[], rightCount: number): boolean {
  if (left.length !== rightCount) return false;
  return left.every((run, index) => {
    const other = right[index];
    return other !== undefined
      && run.inputFrom === other.inputFrom
      && run.inputTo === other.inputTo
      && run.sourceFrom === other.sourceFrom
      && run.sourceTo === other.sourceTo;
  });
}

function makeMapping(
  input: Input,
  source: SourceSnapshot,
  runs: readonly InputSourceRun[],
): NativeContainerWindowSourceMapping {
  const mapBoundary = (offset: number, side: "start" | "end"): number => {
    const point = Math.max(0, Math.min(input.length, offset));
    if (side === "start") {
      for (const run of runs) {
        if (point >= run.inputFrom && point < run.inputTo) {
          return run.sourceFrom + Math.min(point - run.inputFrom, run.sourceTo - run.sourceFrom);
        }
        if (point === run.inputFrom) return run.sourceFrom;
      }
    } else {
      for (let index = runs.length - 1; index >= 0; index -= 1) {
        const run = runs[index]!;
        if (point > run.inputFrom && point <= run.inputTo) {
          const inputLength = run.inputTo - run.inputFrom;
          const sourceLength = run.sourceTo - run.sourceFrom;
          return point === run.inputTo
            ? run.sourceTo
            : run.sourceFrom + Math.min(point - run.inputFrom, sourceLength, inputLength);
        }
        if (point === run.inputTo) return run.sourceTo;
      }
    }
    if (point === 0) return runs[0]?.sourceFrom ?? 0;
    return runs[runs.length - 1]?.sourceTo ?? 0;
  };
  const mapRange = (from: number, to: number): { readonly from: number; readonly to: number } => {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > input.length) {
      throw new RangeError("Native container range is outside its bounded input");
    }
    const mappedFrom = mapBoundary(from, "start");
    const mappedTo = from === to ? mappedFrom : Math.max(mappedFrom, mapBoundary(to, "end"));
    return Object.freeze({ from: mappedFrom, to: mappedTo });
  };
  const mapOffset = (offset: number): number => mapBoundary(offset, "start");
  return Object.freeze({ input, source, mapOffset, mapRange });
}

/**
 * Builds the configured-parser input from only active ancestor markers/context and the changing
 * physical suffix. A cache hit is scoped to the canonical document identity, generation and bounds.
 */
export class NativeContainerWindowCache {
  private document: object | undefined;
  private generation = -1;
  private tailFrom = -1;
  private tailTo = -1;
  private prefix = "";
  private runs: readonly InputSourceRun[] = [];
  private prefixLength = 0;
  private prefixRunCount = 0;
  private window: NativeContainerWindow | undefined;

  create(
    document: object,
    generation: number,
    source: SourceSnapshot,
    tailFrom: number,
    tailTo: number,
    frames: readonly NativeContainerWindowFrame[],
    code: NativeContainerCodeOpening | undefined,
    additionalContextLines: readonly NativeContainerContextLine[] = [],
  ): NativeContainerWindow | undefined {
    const from = Math.max(0, Math.min(source.length, tailFrom));
    const to = Math.max(from, Math.min(source.length, tailTo));
    const openings = markerOpenings(frames);
    // Retained chain lines inside a quote carry their own quote marks before the list marker.
    for (const frame of frames) {
      for (const marker of listChainMarkers(frame)) {
        for (let offset = lineStartAt(source, marker.from); offset < marker.from; offset += 1) {
          if (source.read(offset, offset + 1) !== ">") continue;
          if (openings.some((opening) => opening.from === offset)) continue;
          openings.push({ typeName: "QuoteMark", from: offset, to: offset + 1 });
        }
      }
    }
    const codeOpeningFrom = code && code.openingLineFrom < from ? code.openingLineFrom : undefined;
    const contextEnd = codeOpeningFrom ?? from;
    // The active leaf's own context lines (a table's header and delimiter) may sit between the previous child and the
    // changing suffix; the separating gap then ends at the first of them and is emitted before them.
    let gapEnd = contextEnd;
    for (const line of additionalContextLines) {
      if (line.from < gapEnd) gapEnd = line.from;
    }
    const gapStart = boundedContextGapStart(
      source,
      activeContextGapStart(source, frames, gapEnd, to),
      gapEnd,
    );
    const inGap = (lineFrom: number): boolean => gapStart !== undefined && lineFrom >= gapStart && lineFrom < gapEnd;
    const contextLines = new Map<number, NativeContainerContextLine>();
    for (const frame of frames) {
      for (const marker of listChainMarkers(frame)) {
        const lineFrom = lineStartAt(source, marker.from);
        const lineTo = lineEndAt(source, lineFrom, to);
        if (lineFrom < contextEnd && lineTo > lineFrom) contextLines.set(lineFrom, { from: lineFrom, to: lineTo, text: source.read(lineFrom, lineTo) });
      }
      const line = frame.firstContextLine;
      if (line && frame.firstContextLineComplete !== false && line.from < contextEnd) {
        contextLines.set(line.from, line);
      }
    }
    for (const line of additionalContextLines) {
      if (line.from < contextEnd) contextLines.set(line.from, line);
    }
    // Preserve a Setext leaf's text line when the changing suffix starts at its underline.
    for (const frame of frames) {
      if (frame.activeChildTypeName !== "SetextHeading1" && frame.activeChildTypeName !== "SetextHeading2") continue;
      const lineFrom = lineStartAt(source, frame.sourceFrontier);
      if (lineFrom >= from || lineFrom >= contextEnd) continue;
      const lineTo = lineEndAt(source, lineFrom, to);
      if (lineTo <= lineFrom) continue;
      contextLines.set(lineFrom, { from: lineFrom, to: lineTo, text: source.read(lineFrom, lineTo) });
    }
    const groups = new Map<number, NativeContainerMarkerAnchor[]>();
    for (const opening of openings) {
      const lineFrom = lineStartAt(source, opening.from);
      if (lineFrom >= from || (codeOpeningFrom !== undefined && lineFrom >= codeOpeningFrom)) continue;
      if (inGap(lineFrom)) continue;
      const group = groups.get(lineFrom);
      if (group) group.push(opening);
      else groups.set(lineFrom, [opening]);
    }
    for (const [lineFrom] of contextLines) {
      if (lineFrom >= from || inGap(lineFrom)) continue;
      if (!groups.has(lineFrom)) groups.set(lineFrom, []);
    }

    const pieces: string[] = [];
    const runs: InputSourceRun[] = [];
    const anchors: NativeContainerMarkerAnchor[] = [];
    const contextAnchors: Array<NativeContainerContextLine & { inputFrom: number; inputTo: number }> = [];
    let inputLength = 0;
    const appendSource = (sourceFrom: number, sourceTo: number): string => {
      const text = source.read(sourceFrom, sourceTo);
      if (text.length > 0) {
        pieces.push(text);
        runs.push({ inputFrom: inputLength, inputTo: inputLength + text.length, sourceFrom, sourceTo });
        inputLength += text.length;
      }
      return text;
    };
    const appendKnownSource = (sourceFrom: number, text: string): void => {
      if (text.length === 0) return;
      pieces.push(text);
      runs.push({
        inputFrom: inputLength,
        inputTo: inputLength + text.length,
        sourceFrom,
        sourceTo: sourceFrom + text.length,
      });
      inputLength += text.length;
    };
    const appendLineEnding = (sourceFrom: number, sourceTo: number): void => {
      // The changing suffix owns an EOL that reaches across its boundary, including split CRLF.
      if (sourceFrom >= sourceTo || sourceTo > from) return;
      pieces.push("\n");
      runs.push({ inputFrom: inputLength, inputTo: inputLength + 1, sourceFrom, sourceTo });
      inputLength += 1;
    };

    let gapEmitted = gapStart === undefined;
    const emitGap = (): void => {
      if (gapEmitted) return;
      gapEmitted = true;
      // The gap may start at the previous child's content end, inside a context line already emitted with its ending;
      // repeating that ending would add a blank line outside every container.
      const emittedTo = runs.length > 0 ? runs[runs.length - 1]!.sourceTo : 0;
      const gapFrom = Math.max(gapStart!, emittedTo);
      if (gapFrom < gapEnd) appendSource(gapFrom, gapEnd);
    };
    const orderedGroups = [...groups.entries()].sort((left, right) => left[0] - right[0]);
    for (const [lineFrom, group] of orderedGroups) {
      if (lineFrom >= gapEnd) emitGap();
      group.sort((left, right) => left.from - right.from);
      if (group.length > 0) {
        const last = group[group.length - 1]!;
        for (let index = 1; index < group.length; index += 1) {
          if (!validMarkerGap(source, group[index - 1]!.to, group[index]!.from)) return undefined;
        }
        if (!validMarkerGap(source, lineFrom, group[0]!.from)) return undefined;
        const contextLine = contextLines.get(lineFrom);
        const contentEnd = Math.max(contextLine?.to ?? lineFrom, readTrailingWhitespace(source, last.to, to));
        const lineText = contextLine && contentEnd === contextLine.to
          ? contextLine.text
          : source.read(lineFrom, contentEnd);
        const prefixStart = inputLength;
        if (contextLine && contentEnd === contextLine.to) {
          appendKnownSource(lineFrom, lineText);
        } else {
          appendSource(lineFrom, lineFrom + lineText.length);
        }
        if (contextLine) contextAnchors.push({ ...contextLine, inputFrom: prefixStart, inputTo: prefixStart + lineText.length });
        for (const opening of group) anchors.push({ ...opening, inputFrom: prefixStart + opening.from - lineFrom } as NativeContainerMarkerAnchor & { inputFrom: number });
        const endingFrom = lineFrom + lineText.length;
        const endingTo = physicalLineEnd(source, lineEndAt(source, endingFrom, to), to);
        appendLineEnding(endingFrom, endingTo);
      } else {
        const contextLine = contextLines.get(lineFrom)!;
        const prefixStart = inputLength;
        appendKnownSource(contextLine.from, contextLine.text);
        contextAnchors.push({ ...contextLine, inputFrom: prefixStart, inputTo: prefixStart + contextLine.text.length });
        const endingTo = physicalLineEnd(source, lineEndAt(source, contextLine.to, to), to);
        appendLineEnding(contextLine.to, endingTo);
      }
    }
    emitGap();
    if (code && codeOpeningFrom !== undefined) {
      const prefixStart = inputLength;
      appendKnownSource(code.openingLineFrom, code.openingContextText);
      for (const opening of openings) {
        if (lineStartAt(source, opening.from) !== code.openingLineFrom) continue;
        anchors.push({ ...opening, inputFrom: prefixStart + opening.from - code.openingLineFrom });
      }
      const endingTo = physicalLineEnd(source, lineEndAt(source, code.openingLineTo, to), to);
      appendLineEnding(code.openingLineTo, endingTo);
    }

    const prefixLength = inputLength;
    const reusablePrefix = this.window
      && this.document === document
      && this.generation === generation
      && this.prefixLength === prefixLength
      && sameRunPrefix(runs, this.runs, this.prefixRunCount);
    const prefix = reusablePrefix ? this.prefix : pieces.join("");
    const prefixRunCount = runs.length;
    for (const opening of openings) {
      if (lineStartAt(source, opening.from) < from) continue;
      const inputFrom = prefixLength + opening.from - from;
      anchors.push({ ...opening, inputFrom } as NativeContainerMarkerAnchor & { inputFrom: number });
    }
    const reusable = this.window
      && this.document === document
      && this.generation === generation
      && this.tailFrom === from
      && this.tailTo === to
      && this.prefix === prefix
      && sameRuns(this.runs, runs);
    if (reusable) return this.window;

    const input = new ConcatenatedInput(prefix, new SourceRangeInput(source, from, to));
    const suffixRun: InputSourceRun = {
      inputFrom: prefixLength,
      inputTo: prefixLength + to - from,
      sourceFrom: from,
      sourceTo: to,
    };
    if (suffixRun.inputTo > suffixRun.inputFrom) runs.push(suffixRun);
    const mapping = makeMapping(input, source, runs);
    const window: NativeContainerWindow = Object.freeze({
      input,
      prefixLength,
      sourceOffset: from - prefixLength,
      anchors: Object.freeze(anchors),
      contextAnchors: Object.freeze(contextAnchors),
      mapping,
    });
    this.document = document;
    this.generation = generation;
    this.tailFrom = from;
    this.tailTo = to;
    this.prefix = prefix;
    this.runs = runs;
    this.prefixLength = prefixLength;
    this.prefixRunCount = prefixRunCount;
    this.window = window;
    return window;
  }

  clear(): void {
    this.document = undefined;
    this.generation = -1;
    this.tailFrom = -1;
    this.tailTo = -1;
    this.prefix = "";
    this.runs = [];
    this.prefixLength = 0;
    this.prefixRunCount = 0;
    this.window = undefined;
  }
}

export function mapNativeContainerWindowMarker(
  window: Pick<NativeContainerWindow, "prefixLength" | "sourceOffset" | "anchors">,
  mark: Pick<SyntaxNode, "type" | "from" | "to">,
): NativeContainerMarkerAnchor | undefined {
  if (mark.from >= window.prefixLength) {
    return {
      typeName: mark.type.name as NativeContainerMarkerAnchor["typeName"],
      from: window.sourceOffset + mark.from,
      to: window.sourceOffset + mark.to,
    };
  }
  const anchor = window.anchors.find((candidate) =>
    candidate.typeName === mark.type.name
    && (candidate as NativeContainerMarkerAnchor & { inputFrom?: number }).inputFrom === mark.from,
  );
  if (!anchor) return undefined;
  return {
    typeName: anchor.typeName,
    from: anchor.from,
    to: anchor.to,
    ...(anchor.globalChildIndex === undefined ? {} : { globalChildIndex: anchor.globalChildIndex }),
  };
}
