import {
  AppendSourceDocument,
  createCodeLineIndex,
  parseCodeFenceInfo,
  type Block,
  type CodeDiffStatus,
  type CodeLineIndex,
  type CodeLineDecoration,
  type CodeLineRecord,
  type DiffBlock,
  type DiffLine,
  type ThemedLine,
  type SourceSnapshot,
} from "@stream-mdx/core";
import {
  abandonsOwedRows,
  codeDiffStatus,
  detectDiffLanguage,
  parseUnifiedDiffLine,
  toDiffLineKind,
  toThemedLine,
} from "./highlight";
import type { DiffCursorState } from "./types";

declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

function themedDiffLine(decoration: CodeLineDecoration): ThemedLine | null {
  if (decoration.exactness === "unavailable") return null;
  return toThemedLine(decoration.tokens, "dark") ?? [];
}

function sameThemedDiffLine(
  left: ThemedLine | null | undefined,
  right: ThemedLine | null,
): boolean {
  if (right === null) return left === null || left === undefined;
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < right.length; index += 1) {
    const leftToken = left[index];
    const rightToken = right[index];
    if (
      !leftToken ||
      !rightToken ||
      leftToken.content !== rightToken.content ||
      leftToken.color !== rightToken.color ||
      leftToken.fontStyle !== rightToken.fontStyle
    ) return false;
  }
  return true;
}

function updateDiffBlockPresentation(
  value: unknown,
  decorations: readonly CodeLineDecoration[],
  lines: CodeLineIndex,
): DiffBlock[] | undefined {
  if (!Array.isArray(value) || decorations.length === 0) return undefined;
  const diffBlocks = value as DiffBlock[];
  let orderedDecorations = decorations;
  for (let index = 1; index < decorations.length; index += 1) {
    if ((decorations[index - 1]?.index ?? -1) > (decorations[index]?.index ?? -1)) {
      orderedDecorations = [...decorations].sort((left, right) => left.index - right.index);
      break;
    }
  }
  let nextDiffBlocks: DiffBlock[] | undefined;
  let decorationCursor = 0;
  let sourceLineOffset = 0;
  let previousIndex: number | undefined;
  for (let blockIndex = 0; blockIndex < diffBlocks.length; blockIndex += 1) {
    const diffBlock = diffBlocks[blockIndex];
    if (!diffBlock || !Array.isArray(diffBlock.lines)) continue;
    const blockEnd = sourceLineOffset + diffBlock.lines.length;
    while (
      decorationCursor < orderedDecorations.length &&
      (orderedDecorations[decorationCursor]?.index ?? Number.POSITIVE_INFINITY) < sourceLineOffset
    ) decorationCursor += 1;
    let nextLines: DiffLine[] | undefined;
    while (decorationCursor < orderedDecorations.length) {
      const decoration = orderedDecorations[decorationCursor];
      if (!decoration || decoration.index >= blockEnd) break;
      decorationCursor += 1;
      if (decoration.index === previousIndex) continue;
      previousIndex = decoration.index;
      const diffLineIndex = decoration.index - sourceLineOffset;
      const diffLine = diffBlock.lines[diffLineIndex];
      const sourceLine = lines.get(decoration.index);
      const lineDecoration = sourceLine?.decoration;
      if (!diffLine || !sourceLine || sourceLine.text !== diffLine.raw || !lineDecoration) continue;
      const tokens = themedDiffLine(lineDecoration);
      if (sameThemedDiffLine(diffLine.tokens, tokens)) continue;
      if (!nextLines) nextLines = diffBlock.lines.slice();
      nextLines[diffLineIndex] = { ...diffLine, tokens };
    }
    if (nextLines) {
      nextDiffBlocks ??= diffBlocks.slice();
      nextDiffBlocks[blockIndex] = { ...diffBlock, lines: nextLines };
    }
    sourceLineOffset = blockEnd;
  }
  return nextDiffBlocks;
}

const SOURCE_SCAN_WINDOW_UNITS = 4096;
const EMPTY_CHANGED_LINES: readonly CodeLineRecord[] = Object.freeze([]);

/** A complete closing fence is terminal, so a closed fence is already finalized. */
export type RootCodeSourceOwnerState = "open" | "finalized";

export interface RootCodeSourceOpening {
  /** Native FencedCode node start at the marker; its opening indentation precedes this offset. */
  readonly from: number;
  /** Absolute UTF-16 offset immediately after the complete native opening line. */
  readonly bodyFrom: number;
  readonly marker: "`" | "~";
  readonly width: number;
  /** Number of leading ASCII spaces on the validated opening fence (0 through 3). */
  readonly indent: number;
  /** Native CodeInfo contents, retained without reparsing or normalization. */
  readonly info: string;
  /** Native requested language, when already available from opening admission. */
  readonly language?: string;
}

type RootCodeSourceCounterStage = "engine" | "snapshot" | "patch" | "store" | "view";

interface RootCodeSourceOwnerCounters {
  recordCodeSourceUnitsPrepared(count: number): void;
  recordSourceUnitsMaterialized(count: number): void;
  recordRecordSlotsAllocated(count: number, stage?: RootCodeSourceCounterStage): void;
  recordPrefixComparisons?(count: number, stage?: RootCodeSourceCounterStage): void;
}

export interface RootCodeSourceOwnerOptions {
  readonly id: string;
  readonly generation: number;
  readonly source: AppendSourceDocument;
  readonly opening: RootCodeSourceOpening;
  /** @internal Stage-local diagnostic sink; only read when campaign counters are enabled. */
  readonly counters?: RootCodeSourceOwnerCounters;
}

export interface CodeSourceChange {
  readonly codeOwnerId: string;
  readonly generation: number;
  readonly expectedRevision: number;
  readonly revision: number;
  /** First line index in the returned changed tail. */
  readonly fromLine: number;
  /** Only changed/new tail records; preceding completed records are never returned again. */
  readonly lines: readonly CodeLineRecord[];
  readonly state: RootCodeSourceOwnerState;
  /** Exclusive consumed-source offset after the close line ending; not necessarily the native Block range end. */
  readonly processedTo?: number;
  /** Start of following native Markdown when a confirmed close splits the accepted range. */
  readonly remainingTailFrom?: number;
}

export interface RootCodeSourceMetadata {
  readonly codeOwnerId: string;
  readonly generation: number;
  readonly revision: number;
  readonly state: RootCodeSourceOwnerState;
  readonly processedTo: number;
  readonly completeLineCount: number;
  readonly lineCount: number;
  readonly sourceRange: {
    readonly from: number;
    readonly to: number;
  };
  readonly diffStatus?: CodeDiffStatus;
}

type FenceTailKind = "close" | "prefix" | undefined;

interface DraftCodeLine {
  readonly raw: string;
  readonly from: number;
  readonly to: number;
  readonly ending: CodeLineRecord["ending"];
  readonly isProvisional: boolean;
}

/** Unified-diff row meaning for a line of a diff-labeled fence; derived from that line and its predecessors. */
interface DiffLineFields {
  readonly diffKind: NonNullable<CodeLineRecord["diffKind"]>;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

function classifyFenceTail(raw: string, opening: RootCodeSourceOpening): FenceTailKind {
  let cursor = 0;
  while (cursor < 3 && raw[cursor] === " ") cursor += 1;
  if (raw[cursor] !== opening.marker) return undefined;

  const markerStart = cursor;
  while (cursor < raw.length && raw[cursor] === opening.marker) cursor += 1;
  const markerCount = cursor - markerStart;
  while (cursor < raw.length && (raw[cursor] === " " || raw[cursor] === "\t")) cursor += 1;
  if (cursor !== raw.length) return undefined;

  return markerCount >= opening.width ? "close" : "prefix";
}

function stripOpeningIndent(raw: string, indent: number): string {
  if (indent === 0) return raw;
  let spaces = 0;
  while (spaces < indent && raw[spaces] === " ") spaces += 1;
  return spaces === 0 ? raw : raw.slice(spaces);
}


function freezeRecord(
  ownerId: string,
  index: number,
  draft: DraftCodeLine,
  openingIndent: number,
  sourceRevision: number,
  diff: DiffLineFields | undefined,
): CodeLineRecord {
  const base = {
    id: `${ownerId}:line:${index}`,
    index,
    text: stripOpeningIndent(draft.raw, openingIndent),
    ending: draft.ending,
    sourceRange: Object.freeze({ from: draft.from, to: draft.to }),
    sourceRevision,
    isProvisional: draft.isProvisional,
  };
  return Object.freeze(diff ? { ...base, diffKind: diff.diffKind, oldNo: diff.oldNo, newNo: diff.newNo } : base);
}

function sameRecordProjection(
  record: CodeLineRecord,
  draft: DraftCodeLine,
  index: number,
  ownerId: string,
  openingIndent: number,
  diff: DiffLineFields | undefined,
): boolean {
  return record.id === `${ownerId}:line:${index}`
    && record.index === index
    && record.text === stripOpeningIndent(draft.raw, openingIndent)
    && record.ending === draft.ending
    && record.sourceRange.from === draft.from
    && record.sourceRange.to === draft.to
    && record.isProvisional === draft.isProvisional
    && record.diffKind === diff?.diffKind
    && (record.oldNo ?? null) === (diff?.oldNo ?? null)
    && (record.newNo ?? null) === (diff?.newNo ?? null);
}

function readSourceRange(reader: SourceSnapshot, from: number, to: number): string {
  return from < to ? reader.read(from, to) : "";
}

function nextOwnerRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) throw new RangeError("Root code owner revision exceeds the safe integer range");
  return next;
}

/**
 * Owns one root ordinary fenced-code source interval. Completed rows are never
 * reparsed; only newly accepted source plus the one unfinished physical line
 * can affect the mutable tail. Source ranges cover authored line contents and
 * exclude their line terminators; `ending` preserves those UTF-16 source units.
 */
export class RootCodeSourceOwner {
  readonly id: string;
  readonly generation: number;

  private readonly source: AppendSourceDocument;
  private readonly opening: RootCodeSourceOpening;
  private codeLines: CodeLineIndex;
  private state: RootCodeSourceOwnerState = "open";
  private revision = 0;
  private processedTo: number;
  private lineStart: number;
  private pendingCR = false;
  private rawEnd: number;
  /** Diff numbering and hunk counts after the complete-line prefix. */
  private diffCursor: DiffCursorState | undefined;
  private diffRowsAbandoned = false;
  private cachedBlock: { readonly revision: number; readonly block: Block } | undefined;
  private presentation: {
    readonly revision: number;
    readonly highlightedHtml: string | undefined;
    readonly meta: Block["payload"]["meta"];
  } | undefined;
  private declare counters?: RootCodeSourceOwnerCounters;

  constructor(options: RootCodeSourceOwnerOptions) {
    const { id, generation, source, opening } = options;
    if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError("Root code owner generation must be a non-negative safe integer");
    if (!Number.isSafeInteger(opening.from) || opening.from < 0
      || !Number.isSafeInteger(opening.bodyFrom) || opening.bodyFrom < opening.from
      || opening.bodyFrom > source.length) {
      throw new RangeError("Root code opening offsets must be an ordered source range");
    }
    if (!Number.isSafeInteger(opening.width) || opening.width < 3) throw new RangeError("Root code opening fence width must be at least three");
    if (!Number.isSafeInteger(opening.indent) || opening.indent < 0 || opening.indent > 3) {
      throw new RangeError("Root code opening indentation must be zero through three spaces");
    }

    this.id = id;
    this.generation = generation;
    this.source = source;
    this.opening = Object.freeze({ ...opening });
    this.processedTo = opening.bodyFrom;
    this.lineStart = opening.bodyFrom;
    this.rawEnd = opening.bodyFrom;
    const { lang, meta } = parseCodeFenceInfo(opening.info);
    const initialCursor: DiffCursorState | undefined = detectDiffLanguage(lang, meta).isDiff
      ? { oldLine: null, newLine: null }
      : undefined;
    this.diffCursor = initialCursor;
    const initialDraft: DraftCodeLine = {
      raw: "",
      from: opening.bodyFrom,
      to: opening.bodyFrom,
      ending: "",
      isProvisional: true,
    };
    const initialRecord = freezeRecord(id, 0, initialDraft, opening.indent, 0, initialCursor
      ? diffLineFields("", { ...initialCursor })
      : undefined);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters = options.counters;
      const diagnosticOptions = {
        lines: [initialRecord],
        campaignCounters: this.counters,
        counterStage: "engine" as const,
      };
      this.codeLines = createCodeLineIndex(diagnosticOptions);
    } else {
      this.codeLines = createCodeLineIndex({ lines: [initialRecord] });
    }
  }

  /** Apply one contiguous newly accepted UTF-16 source range. */
  accept(from: number, to: number): CodeSourceChange {
    if (this.state !== "open") throw new Error(`Cannot accept source for a ${this.state} root code owner`);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)
      || from !== this.processedTo || to < from || to > this.source.length) {
      throw new RangeError("Root code source acceptance must continue at processedTo within the source document");
    }
    return this.consume(from, to, false);
  }

  /** Immutable persistent line-index snapshot; prior snapshots remain unchanged. */
  getLines(): CodeLineIndex {
    return this.codeLines;
  }

  /** Apply decorations to this owner's persistent index without changing its source revision. */
  decorateLines(decorations: readonly CodeLineDecoration[]): CodeLineIndex {
    this.codeLines = this.codeLines.decorate(decorations);
    this.cachedBlock = undefined;
    return this.codeLines;
  }
  setPresentation(block: Block): void {
    if (block.id !== this.id || block.type !== "code") {
      throw new TypeError("Root code presentation must belong to its source owner");
    }
    this.presentation = {
      revision: this.revision,
      highlightedHtml: block.payload.highlightedHtml,
      meta: block.payload.meta ? { ...block.payload.meta } : undefined,
    };
    this.cachedBlock = undefined;
  }
  getPresentation(): {
    readonly highlightedHtml: string | undefined;
    readonly meta: Block["payload"]["meta"];
  } | undefined {
    const presentation = this.presentation;
    return presentation?.revision === this.revision ? presentation : undefined;
  }
  /** Apply lazy progress and touched diff tokens without materializing the source-backed Block. */
  updateLazyTokenizationPresentation(
    lineCount: number,
    decorations: readonly CodeLineDecoration[],
  ): void {
    const presentation = this.presentation;
    if (presentation?.revision !== this.revision) return;
    const meta = { ...(presentation.meta ?? {}) };
    let changed = meta.lazyTokenizedUntil !== lineCount;
    if (changed) meta.lazyTokenizedUntil = lineCount;
    const diffBlocks = updateDiffBlockPresentation(meta.diffBlocks, decorations, this.codeLines);
    if (diffBlocks) {
      meta.diffBlocks = diffBlocks;
      changed = true;
    }
    if (!changed) return;
    this.presentation = {
      revision: this.revision,
      highlightedHtml: presentation.highlightedHtml,
      meta,
    };
    this.cachedBlock = undefined;
  }


  /** Small immutable owner snapshot, without retaining a SourceSnapshot. */
  getMetadata(): RootCodeSourceMetadata {
    const diffStatus = this.getDiffStatus();
    return Object.freeze({
      codeOwnerId: this.id,
      generation: this.generation,
      revision: this.revision,
      state: this.state,
      processedTo: this.processedTo,
      completeLineCount: this.codeLines.completeLineCount,
      lineCount: this.codeLines.length,
      sourceRange: Object.freeze({ from: this.opening.from, to: this.rawEnd }),
      ...(diffStatus !== undefined ? { diffStatus } : {}),
    });
  }

  private getDiffStatus(): CodeDiffStatus | undefined {
    const cursor = this.diffCursor;
    if (cursor === undefined) return undefined;
    const tail = this.codeLines.get(this.codeLines.length - 1);
    return codeDiffStatus(
      cursor,
      this.diffRowsAbandoned,
      tail?.isProvisional ? tail.text : undefined,
      this.state === "finalized",
    );
  }

  /** Seal an open owner, finishing only its pending line (and unaccepted suffix, if any). */
  finalize(): CodeSourceChange {
    if (this.state === "finalized") return this.noChange(this.codeLines.completeLineCount);

    const from = this.processedTo;
    const to = this.source.length;
    return this.consume(from, to, true);
  }

  /** Cold native Block materialization, cached until the semantic owner revision changes. */
  materializeBlock(): Block {
    if (this.cachedBlock?.revision === this.revision) return this.cachedBlock.block;

    const reader = this.source.snapshot();
    const raw = reader.read(this.opening.from, this.rawEnd);
    const code = this.codeLines.materialize().replace(/\r\n?/g, "\n").replace(/\n$/, "");
    const presentation = this.presentation?.revision === this.revision ? this.presentation : undefined;
    const meta: NonNullable<Block["payload"]["meta"]> = {
      ...(presentation?.meta ?? {}),
      lezerNodeType: "FencedCode",
      code,
      info: this.opening.info,
    };
    if (this.opening.language !== undefined) meta.lang = this.opening.language;
    const previousTokenLines = meta.tokenLines;
    const tokenLines = this.codeLines.readRange(0, this.codeLines.length).map((line, index) => {
      if (line.decoration?.exactness === "unavailable") return null;
      return line.decoration?.tokens ?? (Array.isArray(previousTokenLines) ? previousTokenLines[index] : null);
    });
    meta.tokenLines = tokenLines;

    const block: Block = {
      id: this.id,
      type: "code",
      isFinalized: this.state !== "open",
      payload: {
        raw,
        meta,
        range: { from: this.opening.from, to: this.rawEnd },
        inline: undefined,
        highlightedHtml: presentation?.highlightedHtml,
        sanitizedHtml: undefined,
      },
    };
    this.cachedBlock = { revision: this.revision, block };

    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters?.recordSourceUnitsMaterialized(raw.length + code.length);
    }
    return block;
  }

  private consume(from: number, to: number, finalizeAtEnd: boolean): CodeSourceChange {
    const expectedRevision = this.revision;
    const oldState = this.state;
    const oldRawEnd = this.rawEnd;
    const oldCompleteLineCount = this.codeLines.completeLineCount;
    const reader = this.source.snapshot();
    const completed: DraftCodeLine[] = [];
    let cursor = from;
    let lineStart = this.lineStart;
    let pendingCR = this.pendingCR;
    let closeBoundary: number | undefined;
    let closeRawEnd: number | undefined;

    const completePhysicalLine = (
      contentEnd: number,
      ending: CodeLineRecord["ending"],
      boundary: number,
    ): boolean => {
      const raw = readSourceRange(reader, lineStart, contentEnd);
      if (classifyFenceTail(raw, this.opening) === "close") {
        closeRawEnd = ending === "\n" ? contentEnd : ending === "\r\n" ? contentEnd + 1 : boundary;
        closeBoundary = boundary;
        lineStart = boundary;
        pendingCR = false;
        return true;
      }
      completed.push({ raw, from: lineStart, to: contentEnd, ending, isProvisional: false });
      lineStart = boundary;
      pendingCR = false;
      return false;
    };

    if (pendingCR) {
      if (cursor < to) {
        const next = readSourceRange(reader, cursor, cursor + 1);
        const boundary = next === "\n" ? cursor + 1 : cursor;
        const ending = next === "\n" ? "\r\n" : "\r";
        if (completePhysicalLine(cursor - 1, ending, boundary)) {
          cursor = boundary;
        } else {
          cursor = boundary;
        }
      } else if (finalizeAtEnd) {
        completePhysicalLine(cursor - 1, "\r", cursor);
      }
    }

    while (cursor < to && closeBoundary === undefined) {
      const windowEnd = Math.min(to, cursor + SOURCE_SCAN_WINDOW_UNITS);
      const window = reader.read(cursor, windowEnd);
      const lfAt = window.indexOf("\n");
      const crAt = window.indexOf("\r");
      let separatorAt = -1;
      if (lfAt >= 0 && crAt >= 0) separatorAt = Math.min(lfAt, crAt);
      else separatorAt = Math.max(lfAt, crAt);

      if (separatorAt < 0) {
        cursor = windowEnd;
        continue;
      }

      const sourceSeparatorAt = cursor + separatorAt;
      if (window[separatorAt] === "\n") {
        const boundary = sourceSeparatorAt + 1;
        if (completePhysicalLine(sourceSeparatorAt, "\n", boundary)) cursor = boundary;
        else cursor = boundary;
        continue;
      }

      if (sourceSeparatorAt + 1 < to) {
        const next = readSourceRange(reader, sourceSeparatorAt + 1, sourceSeparatorAt + 2);
        if (next === "\n") {
          const boundary = sourceSeparatorAt + 2;
          if (completePhysicalLine(sourceSeparatorAt, "\r\n", boundary)) cursor = boundary;
          else cursor = boundary;
        } else {
          const boundary = sourceSeparatorAt + 1;
          if (completePhysicalLine(sourceSeparatorAt, "\r", boundary)) cursor = boundary;
          else cursor = boundary;
        }
      } else if (finalizeAtEnd) {
        const boundary = sourceSeparatorAt + 1;
        completePhysicalLine(sourceSeparatorAt, "\r", boundary);
        cursor = boundary;
      } else {
        pendingCR = true;
        cursor = to;
      }
    }

    let nextState: RootCodeSourceOwnerState;
    let nextRawEnd: number;
    let provisionalTail: DraftCodeLine | undefined;
    let finalTail: DraftCodeLine | undefined;

    if (closeBoundary !== undefined) {
      nextState = "finalized";
      nextRawEnd = closeRawEnd ?? closeBoundary;
      pendingCR = false;
    } else if (finalizeAtEnd) {
      const tailEnd = pendingCR ? to - 1 : to;
      const tailRaw = readSourceRange(reader, lineStart, tailEnd);
      const tailKind = classifyFenceTail(tailRaw, this.opening);
      if (tailKind === "close") {
        closeRawEnd = to;
        closeBoundary = to;
        lineStart = to;
        pendingCR = false;
      } else if (to > lineStart || tailRaw.length > 0) {
        finalTail = { raw: tailRaw, from: lineStart, to: tailEnd, ending: pendingCR ? "\r" : "", isProvisional: false };
        lineStart = to;
        pendingCR = false;
      } else {
        pendingCR = false;
      }
      nextState = "finalized";
      nextRawEnd = to;
    } else {
      const tailEnd = pendingCR ? to - 1 : to;
      const tailRaw = readSourceRange(reader, lineStart, tailEnd);
      const tailKind = classifyFenceTail(tailRaw, this.opening);
      if (tailKind === undefined && (to > lineStart || tailRaw.length > 0)) {
        provisionalTail = { raw: tailRaw, from: lineStart, to: tailEnd, ending: "", isProvisional: true };
      }
      nextState = "open";
      nextRawEnd = to;
    }

    const desiredTail: DraftCodeLine[] = completed.slice();
    if (provisionalTail !== undefined) desiredTail.push(provisionalTail);
    if (finalTail !== undefined) desiredTail.push(finalTail);
    const hasBodyLine = oldCompleteLineCount > 0 || completed.length > 0 || provisionalTail !== undefined || finalTail !== undefined;
    if (!hasBodyLine) {
      desiredTail.push({
        raw: "",
        from: this.opening.bodyFrom,
        to: this.opening.bodyFrom,
        ending: "",
        isProvisional: nextState === "open",
      });
    }

    const oldTail = this.codeLines.readRange(oldCompleteLineCount, this.codeLines.length);
    const diffRows = this.diffCursor ? new Array<DiffLineFields>(desiredTail.length) : undefined;
    let committedDiffCursor = this.diffCursor;
    let committedDiffRowsAbandoned = this.diffRowsAbandoned;
    if (diffRows && this.diffCursor) {
      const working: DiffCursorState = { ...this.diffCursor };
      let workingDiffRowsAbandoned = this.diffRowsAbandoned;
      for (let offset = 0; offset < desiredTail.length; offset += 1) {
        const draft = desiredTail[offset];
        const text = stripOpeningIndent(draft.raw, this.opening.indent);
        if (draft.isProvisional) {
          committedDiffCursor = { ...working };
          committedDiffRowsAbandoned = workingDiffRowsAbandoned;
        }
        if (!workingDiffRowsAbandoned && abandonsOwedRows(text, working)) {
          workingDiffRowsAbandoned = true;
        }
        diffRows[offset] = diffLineFields(text, working);
        if (!draft.isProvisional) committedDiffRowsAbandoned = workingDiffRowsAbandoned;
      }
      if (desiredTail.length === 0 || !desiredTail[desiredTail.length - 1].isProvisional) {
        committedDiffCursor = working;
        committedDiffRowsAbandoned = workingDiffRowsAbandoned;
      }
    }
    const reusableRecords = new Array<CodeLineRecord | undefined>(desiredTail.length);
    let rowsChanged = oldTail.length !== desiredTail.length;
    for (let offset = 0; offset < desiredTail.length; offset += 1) {
      const index = oldCompleteLineCount + offset;
      const draft = desiredTail[offset];
      const previous = oldTail[offset];
      if (draft !== undefined && previous !== undefined
        && sameRecordProjection(previous, draft, index, this.id, this.opening.indent, diffRows?.[offset])) {
        reusableRecords[offset] = previous;
      } else {
        rowsChanged = true;
      }
    }
    const semanticChanged = rowsChanged || nextState !== oldState || nextRawEnd !== oldRawEnd;
    const nextRevision = semanticChanged ? nextOwnerRevision(this.revision) : this.revision;
    const nextRows = new Array<CodeLineRecord>(desiredTail.length);
    for (let offset = 0; offset < desiredTail.length; offset += 1) {
      const draft = desiredTail[offset];
      if (draft === undefined) continue;
      nextRows[offset] = reusableRecords[offset]
        ?? freezeRecord(this.id, oldCompleteLineCount + offset, draft, this.opening.indent, nextRevision, diffRows?.[offset]);
    }

    const preparedTo = closeBoundary ?? to;
    const preparedUnits = Math.max(0, preparedTo - from) + Math.max(0, from - this.lineStart);
    if (rowsChanged) this.codeLines = this.codeLines.replaceTail(oldCompleteLineCount, nextRows);
    this.state = nextState;
    this.revision = semanticChanged ? nextRevision : this.revision;
    this.processedTo = closeBoundary ?? to;
    this.lineStart = lineStart;
    this.pendingCR = pendingCR;
    this.diffCursor = committedDiffCursor;
    this.diffRowsAbandoned = committedDiffRowsAbandoned;
    this.rawEnd = nextRawEnd;
    if (semanticChanged) this.cachedBlock = undefined;

    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters?.recordCodeSourceUnitsPrepared(preparedUnits);
    }

    // Every new revision restates the open tail: consumers replace lines from the completed prefix.
    const changedLines = semanticChanged
      ? Object.freeze(this.codeLines.readRange(oldCompleteLineCount, this.codeLines.length))
      : EMPTY_CHANGED_LINES;
    const splitsInput = closeBoundary !== undefined && closeBoundary < to;
    return this.change(
      expectedRevision,
      oldCompleteLineCount,
      changedLines,
      splitsInput ? closeBoundary : undefined,
    );
  }

  private noChange(fromLine: number): CodeSourceChange {
    return this.change(this.revision, fromLine, EMPTY_CHANGED_LINES);
  }

  private change(
    expectedRevision: number,
    fromLine: number,
    lines: readonly CodeLineRecord[],
    splitAt?: number,
  ): CodeSourceChange {
    if (splitAt !== undefined) {
      return Object.freeze({
        codeOwnerId: this.id,
        generation: this.generation,
        expectedRevision,
        revision: this.revision,
        fromLine,
        lines,
        state: this.state,
        processedTo: splitAt,
        remainingTailFrom: splitAt,
      });
    }
    return Object.freeze({
      codeOwnerId: this.id,
      generation: this.generation,
      expectedRevision,
      revision: this.revision,
      fromLine,
      lines,
      state: this.state,
    });
  }
}

function diffLineFields(text: string, cursor: DiffCursorState): DiffLineFields {
  const info = parseUnifiedDiffLine(text, cursor);
  return { diffKind: toDiffLineKind(info.kind), oldNo: info.oldNo ?? null, newNo: info.newNo ?? null };
}
