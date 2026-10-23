import type { Input, SyntaxNode } from "@lezer/common";
import {
  AppendSourceDocument,
  createCodeLineIndex,
  createSourceWindow,
  parseCodeFenceInfo,
  type Block,
  type CodeBlockSnapshot,
  type CodeBlockSourceMetadata,
  type CodeLineDecoration,
  type CodeLineIndex,
  type CodeLineRecord,
  type NodeSnapshot,
  type Patch,
  type SourceSnapshot,
} from "@stream-mdx/core";
import { detectDiffLanguage, parseUnifiedDiffLine, toDiffLineKind } from "./highlight";
import type { DiffCursorState } from "./types";
import {
  registerPreparedCodeLineSource,
  type PreparedCodeLineOwner,
} from "./root-code-pipeline";

declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

export type NativeNestedCodeState = "open" | "closed" | "finalized";
export type NativeNestedCodeNodeKind = "FencedCode" | "CodeBlock" | "IndentedCode";

export interface NativeNestedCodeSourceMapping {
  /** The exact configured-parser input that owns `node` offsets. */
  readonly input: Input;
  /** Current immutable view of the one canonical authored input document. */
  readonly source: SourceSnapshot;
  /** Translate parser UTF-16 offsets to physical authored UTF-16 offsets. */
  mapOffset(offset: number): number;
  /** Optional exact authored extent for ranges crossing synthetic prefix anchors. */
  mapRange?(from: number, to: number): { readonly from: number; readonly to: number };
}

export interface NativeNestedCodeSourceOwnerOptions {
  readonly id: string;
  readonly containerId: string;
  /** Leaf lease generation; independent of the canonical input generation. */
  readonly generation: number;
  readonly inputGeneration: number;
  readonly source: AppendSourceDocument;
  readonly node: SyntaxNode;
  readonly mapping: NativeNestedCodeSourceMapping;
  readonly closure: NativeNestedCodeState;
  /** Native lowering's physical authored range, when already available. */
  readonly range?: { readonly from: number; readonly to: number };
}

export interface NativeNestedCodeTailUpdate {
  /** Parser-tail CodeText/CodeMark events; the bounded window may retain its last completed physical line. */
  readonly nodes: readonly SyntaxNode[];
  readonly mapping: NativeNestedCodeSourceMapping;
  readonly inputGeneration: number;
  readonly sourceDocument: AppendSourceDocument;
  readonly closure: NativeNestedCodeState;
  readonly sourceRange: { readonly from: number; readonly to: number };
}

export interface NativeNestedCodeSourceChange {
  readonly code: CodeBlockSourceMetadata;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly fromLine: number;
  readonly lines: readonly CodeLineRecord[];
  readonly sourceAppend: string;
}

interface NativeCodeLineDraft {
  readonly text: string;
  readonly from: number;
  readonly to: number;
  readonly ending: CodeLineRecord["ending"];
  readonly isProvisional: boolean;
}

interface DiffLineFields {
  readonly diffKind: NonNullable<CodeLineRecord["diffKind"]>;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

interface NativeCodeTextEvent {
  readonly from: number;
  readonly to: number;
}

interface NativeCodeFence {
  readonly marker: "`" | "~";
  readonly width: number;
}

interface PendingNativeCodeLine {
  raw: string;
  from: number;
  to: number;
}

const EMPTY_CODE_LINES: readonly CodeLineRecord[] = Object.freeze([]);
const NON_WHITESPACE = /\S/;


function nextRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) throw new RangeError("Native code owner revision exceeds the safe integer range");
  return next;
}

function sourceRange(source: NativeNestedCodeSourceMapping, from: number, to: number): { from: number; to: number } {
  const range = source.mapRange?.(from, to) ?? { from: source.mapOffset(from), to: source.mapOffset(to) };
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 0 || range.to < range.from || range.to > source.source.length) {
    throw new RangeError("Native code source mapping is outside the canonical input");
  }
  return range;
}

function lineStartAt(source: SourceSnapshot, before: number): number {
  let cursor = Math.max(0, Math.min(source.length, before));
  while (cursor > 0) {
    const from = Math.max(0, cursor - 256);
    const text = source.read(from, cursor);
    const cr = text.lastIndexOf("\r");
    const lf = text.lastIndexOf("\n");
    const boundary = Math.max(cr, lf);
    if (boundary >= 0) return from + boundary + 1;
    cursor = from;
  }
  return 0;
}

function lineEndingAt(source: SourceSnapshot, from: number): CodeLineRecord["ending"] {
  if (from >= source.length) return "";
  const first = source.read(from, from + 1);
  if (first === "\n") return "\n";
  if (first !== "\r") return "";
  return source.read(from + 1, Math.min(source.length, from + 2)) === "\n" ? "\r\n" : "\r";
}

function columnAt(source: SourceSnapshot, from: number, to: number): number {
  let column = 0;
  for (const character of source.read(from, to)) {
    column = character === "\t" ? column + 4 - (column % 4) : column + 1;
  }
  return column;
}

function sourceCharacterAt(source: SourceSnapshot, offset: number): string {
  return offset < source.length ? source.read(offset, offset + 1) : "";
}

function readInputRange(input: Input, from: number, to: number): string {
  let cursor = Math.max(0, from);
  const end = Math.max(cursor, Math.min(input.length, to));
  let result = "";
  while (cursor < end) {
    const chunk = input.chunk(cursor);
    const count = Math.min(chunk.length, end - cursor);
    if (count === 0) throw new RangeError("Native parser input returned an empty chunk before its end");
    result += chunk.slice(0, count);
    cursor += count;
  }
  return result;
}

function directCodeChildren(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.name === "CodeText" || child.type.name === "CodeMark") result.push(child);
  }
  return result;
}

function ancestorBaseIndent(node: SyntaxNode, mapping: NativeNestedCodeSourceMapping): number {
  const ancestors: SyntaxNode[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) ancestors.push(parent);
  ancestors.reverse();

  let baseIndent = 0;
  for (const ancestor of ancestors) {
    const source = mapping.source;
    if (ancestor.type.name === "ListItem" || ancestor.type.name === "EmptyListItem") {
      const mark = ancestor.getChild("ListMark");
      if (!mark) continue;
      const markTo = mapping.mapOffset(mark.to);
      const lineStart = lineStartAt(source, markTo);
      const afterMark = columnAt(source, lineStart, markTo);
      let whitespaceTo = markTo;
      while (sourceCharacterAt(source, whitespaceTo) === " " || sourceCharacterAt(source, whitespaceTo) === "\t") whitespaceTo += 1;
      const spacing = columnAt(source, lineStart, whitespaceTo) - afterMark;
      baseIndent = afterMark + (spacing >= 1 && spacing <= 4 ? spacing : 1);
    } else if (ancestor.type.name === "Blockquote") {
      const mark = ancestor.getChild("QuoteMark");
      if (!mark) continue;
      const markTo = mapping.mapOffset(mark.to);
      const lineStart = lineStartAt(source, markTo);
      // The optional space after `>` may be one column of a tab; the rest of that tab stays content indentation.
      const afterMark = sourceCharacterAt(source, markTo);
      baseIndent = columnAt(source, lineStart, markTo) + (afterMark === " " || afterMark === "\t" ? 1 : 0);
    }
  }
  return baseIndent;
}

function openingIndent(node: SyntaxNode, mapping: NativeNestedCodeSourceMapping, baseIndent: number): number {
  if (node.type.name !== "FencedCode") return 0;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.name !== "CodeMark") continue;
    const markerFrom = mapping.mapOffset(child.from);
    const lineStart = lineStartAt(mapping.source, markerFrom);
    return Math.max(0, columnAt(mapping.source, lineStart, markerFrom) - baseIndent);
  }
  return 0;
}

function openingFence(node: SyntaxNode, mapping: NativeNestedCodeSourceMapping): NativeCodeFence | undefined {
  if (node.type.name !== "FencedCode") return undefined;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.name !== "CodeMark") continue;
    const from = mapping.mapOffset(child.from);
    const to = mapping.mapOffset(child.to);
    const markerText = mapping.source.read(from, to);
    const marker = markerText[0];
    if ((marker !== "`" && marker !== "~") || markerText.length < 3) return undefined;
    for (let index = 1; index < markerText.length; index += 1) {
      if (markerText[index] !== marker) return undefined;
    }
    return { marker, width: markerText.length };
  }
  return undefined;
}

function closingFenceRun(raw: string, fence: NativeCodeFence): number | undefined {
  let cursor = 0;
  while (cursor < raw.length && cursor < 3 && raw[cursor] === " ") cursor += 1;
  if (raw[cursor] !== fence.marker) return undefined;
  const from = cursor;
  while (raw[cursor] === fence.marker) cursor += 1;
  const width = cursor - from;
  while (raw[cursor] === " " || raw[cursor] === "\t") cursor += 1;
  return cursor === raw.length ? width : undefined;
}

function codeInfo(node: SyntaxNode, mapping: NativeNestedCodeSourceMapping): string {
  const info = node.getChild("CodeInfo");
  return info ? readInputRange(mapping.input, info.from, info.to) : "";
}

function stripColumns(text: string, columnsToStrip: number): string {
  let column = 0;
  let index = 0;
  while (index < text.length && column < columnsToStrip) {
    const character = text[index];
    if (character === " ") {
      column += 1;
      index += 1;
    } else if (character === "\t") {
      const nextColumn = column + 4 - (column % 4);
      if (nextColumn > columnsToStrip) return " ".repeat(nextColumn - columnsToStrip) + text.slice(index + 1);
      column = nextColumn;
      index += 1;
    } else {
      break;
    }
  }
  return text.slice(index);
}

function displayLineText(
  source: SourceSnapshot,
  raw: string,
  from: number,
  baseIndent: number,
  requiredIndent: number,
): string {
  const lineStart = lineStartAt(source, from);
  if (sourceCharacterAt(source, lineStart) === ">") {
    return nativeCodeLine(source, lineStart, from + raw.length, baseIndent, requiredIndent, "").text;
  }
  const prefixIndent = Math.max(0, columnAt(source, lineStart, from) - baseIndent);
  if (prefixIndent >= requiredIndent) return " ".repeat(prefixIndent - requiredIndent) + raw;
  return stripColumns(raw, requiredIndent - prefixIndent);
}

function firstLineEnding(gap: string, source: SourceSnapshot, from: number): { ending: CodeLineRecord["ending"]; from: number } | undefined {
  for (let index = 0; index < gap.length; index += 1) {
    if (gap[index] !== "\r" && gap[index] !== "\n") continue;
    const at = from + index;
    const ending = lineEndingAt(source, at);
    if (ending) return { ending, from: at };
  }
  return undefined;
}
function nativeCodeLine(
  source: SourceSnapshot,
  lineStart: number,
  to: number,
  baseIndent: number,
  requiredIndent: number,
  ending: CodeLineRecord["ending"],
): NativeCodeLineDraft {
  let cursor = lineStart;
  let column = 0;
  const requiredColumn = baseIndent + requiredIndent;
  while (cursor < to) {
    const character = sourceCharacterAt(source, cursor);
    if (character === ">") {
      column += 1;
      cursor += 1;
      const afterMark = sourceCharacterAt(source, cursor);
      if (afterMark === " " || afterMark === "\t") {
        column = afterMark === "\t" ? column + 4 - (column % 4) : column + 1;
        cursor += 1;
      }
    } else if ((character === " " || character === "\t") && column < requiredColumn) {
      column = character === "\t" ? column + 4 - (column % 4) : column + 1;
      cursor += 1;
    } else {
      break;
    }
  }
  const raw = source.read(cursor, to);
  return {
    text: " ".repeat(Math.max(0, column - requiredColumn)) + raw,
    from: cursor,
    to,
    ending,
    isProvisional: false,
  };
}

function blankNativeCodeLine(
  source: SourceSnapshot,
  lineStart: number,
  to: number,
  baseIndent: number,
  requiredIndent: number,
  ending: CodeLineRecord["ending"],
): NativeCodeLineDraft {
  const line = nativeCodeLine(source, lineStart, to, baseIndent, requiredIndent, ending);
  if (line.text.trim().length > 0) throw new TypeError("Native code mapping omitted a nonblank CodeText line");
  return line;
}

function trailingNativeCodeLine(
  source: SourceSnapshot,
  end: number,
  baseIndent: number,
  requiredIndent: number,
  closure: NativeNestedCodeState,
  fence: NativeCodeFence | undefined,
): { readonly lineStart: number; readonly line?: NativeCodeLineDraft; readonly pendingCRAt?: number } {
  let contentEnd = end;
  let ending: CodeLineRecord["ending"] = "";
  let pendingCRAt: number | undefined;
  const last = end > 0 ? sourceCharacterAt(source, end - 1) : "";
  if (last === "\n") {
    const isCRLF = end > 1 && sourceCharacterAt(source, end - 2) === "\r";
    contentEnd -= isCRLF ? 2 : 1;
    ending = isCRLF ? "\r\n" : "\n";
  } else if (last === "\r") {
    contentEnd -= 1;
    if (sourceCharacterAt(source, end) === "\n") {
      ending = "\r\n";
    } else if (closure === "open" && end === source.length) {
      pendingCRAt = contentEnd;
    } else {
      ending = "\r";
    }
  } else {
    ending = lineEndingAt(source, end);
    if (ending === "\r" && closure === "open" && end + 1 === source.length) {
      pendingCRAt = end;
      ending = "";
    }
  }

  const lineStart = lineStartAt(source, contentEnd);
  const line = nativeCodeLine(source, lineStart, contentEnd, baseIndent, requiredIndent, ending);
  const fenceWidth = fence ? closingFenceRun(line.text, fence) : undefined;
  const partialFenceAtTail = fence !== undefined && fenceWidth !== undefined
    && fenceWidth < fence.width
    && closure === "open"
    && ending === ""
    && (contentEnd === source.length || (contentEnd + 1 === source.length && sourceCharacterAt(source, contentEnd) === "\r"));
  if (fence !== undefined && fenceWidth !== undefined && (fenceWidth >= fence.width || partialFenceAtTail)) {
    return { lineStart, ...(pendingCRAt === undefined ? {} : { pendingCRAt }) };
  }
  return {
    lineStart,
    line: { ...line, isProvisional: closure === "open" && ending === "" },
    ...(pendingCRAt === undefined ? {} : { pendingCRAt }),
  };
}


function mapCodeTextEvents(nodes: readonly SyntaxNode[], mapping: NativeNestedCodeSourceMapping): NativeCodeTextEvent[] {
  const events: NativeCodeTextEvent[] = [];
  for (const node of nodes) {
    if (node.type.name !== "CodeText") continue;
    const from = mapping.mapOffset(node.from);
    const to = mapping.mapOffset(node.to);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > mapping.source.length) {
      throw new RangeError("Native CodeText mapping is outside the canonical input");
    }
    events.push({ from, to });
  }
  events.sort((left, right) => left.from - right.from || left.to - right.to);
  return events;
}

function readNativeCodeLines(
  source: SourceSnapshot,
  events: readonly NativeCodeTextEvent[],
  baseIndent: number,
  requiredIndent: number,
  closure: NativeNestedCodeState,
  fence: NativeCodeFence | undefined,
): { readonly lines: readonly NativeCodeLineDraft[]; readonly pendingCRAt?: number } {
  const lines: NativeCodeLineDraft[] = [];
  let pending: PendingNativeCodeLine | undefined;
  let pendingCRAt: number | undefined;
  let previousEventTo: number | undefined;
  const append = (raw: string, from: number, to: number): void => {
    if (!pending) pending = { raw: "", from, to: from };
    pending.raw += raw;
    pending.to = to;
  };

  const finish = (ending: CodeLineRecord["ending"], isProvisional = false): void => {
    if (!pending) return;
    const fenceWidth = fence ? closingFenceRun(pending.raw, fence) : undefined;
    const minimumFenceWidth = fence?.width ?? 0;
    const partialFenceAtTail = fenceWidth !== undefined
      && fenceWidth < minimumFenceWidth
      && closure === "open"
      && ending === ""
      && (pending.to === source.length || (pending.to + 1 === source.length && sourceCharacterAt(source, pending.to) === "\r"));
    if (fenceWidth !== undefined && (fenceWidth >= minimumFenceWidth || partialFenceAtTail)) {
      pending = undefined;
      return;
    }
    lines.push({
      text: displayLineText(source, pending.raw, pending.from, baseIndent, requiredIndent),
      from: pending.from,
      to: pending.to,
      ending,
      isProvisional,
    });
    pending = undefined;
  };

  const finishAcrossGap = (nextFrom: number): void => {
    const cursorStart = pending?.to ?? previousEventTo;
    if (cursorStart === undefined || nextFrom <= cursorStart) return;
    let cursor = cursorStart;
    const firstGap = source.read(cursor, nextFrom);
    const boundary = firstLineEnding(firstGap, source, cursor);
    if (!boundary) {
      if (pending && firstGap.length > 0) throw new TypeError("Native CodeText nodes do not map a continuous authored code line");
      return;
    }
    if (pending) finish(boundary.ending);
    else lines.push(blankNativeCodeLine(source, cursor, boundary.from, baseIndent, requiredIndent, boundary.ending));
    cursor = boundary.from + boundary.ending.length;
    while (cursor < nextFrom) {
      const gap = source.read(cursor, nextFrom);
      const nextBoundary = firstLineEnding(gap, source, cursor);
      if (!nextBoundary) break;
      lines.push(blankNativeCodeLine(source, cursor, nextBoundary.from, baseIndent, requiredIndent, nextBoundary.ending));
      cursor = nextBoundary.from + nextBoundary.ending.length;
    }
  };

  for (const event of events) {
    finishAcrossGap(event.from);
    if (event.from === event.to) {
      if (!pending) pending = { raw: "", from: event.from, to: event.from };
      const ending = lineEndingAt(source, event.to);
      if (ending && !(ending === "\r" && event.to + 1 === source.length && closure === "open")) finish(ending);
      else if (ending === "\r" && event.to + 1 === source.length && closure === "open") pendingCRAt = event.to;
      previousEventTo = Math.max(previousEventTo ?? event.to, event.to);
      continue;
    }

    let cursor = event.from;
    while (cursor < event.to) {
      const end = Math.min(event.to, cursor + 4096);
      const text = source.read(cursor, end);
      let offset = 0;
      while (offset < text.length) {
        const lf = text.indexOf("\n", offset);
        const cr = text.indexOf("\r", offset);
        const separator = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
        if (separator < 0) {
          append(text.slice(offset), cursor + offset, cursor + text.length);
          offset = text.length;
          break;
        }

        const contentEnd = cursor + separator;
        append(text.slice(offset, separator), cursor + offset, contentEnd);
        const ending = lineEndingAt(source, contentEnd);
        if (!ending) throw new TypeError("Native CodeText line terminator is absent from canonical input");
        if (ending === "\r" && contentEnd + 1 === source.length && closure === "open") {
          pendingCRAt = contentEnd;
          offset = text.length;
          break;
        }
        finish(ending);
        offset = separator + ending.length;
      }
      // A CRLF can consume one source unit past this 4096-unit chunk.
      cursor += offset;
    }
    previousEventTo = Math.max(previousEventTo ?? event.to, event.to);
  }

  if (pending) {
    const ending = lineEndingAt(source, pending.to);
    if (ending === "\r" && pending.to + 1 === source.length && closure === "open") {
      pendingCRAt = pending.to;
      finish("", true);
    } else if (ending) {
      finish(ending);
    } else {
      finish("", closure === "open");
    }
  }

  return { lines, ...(pendingCRAt === undefined ? {} : { pendingCRAt }) };
}

function diffLineFields(text: string, cursor: DiffCursorState): DiffLineFields {
  const info = parseUnifiedDiffLine(text, cursor);
  return { diffKind: toDiffLineKind(info.kind), oldNo: info.oldNo ?? null, newNo: info.newNo ?? null };
}

function recordFromDraft(
  ownerId: string,
  index: number,
  draft: NativeCodeLineDraft,
  sourceRevision: number,
  diff: DiffLineFields | undefined,
): CodeLineRecord {
  const base = {
    id: `${ownerId}:line:${index}`,
    index,
    text: draft.text,
    ending: draft.ending,
    sourceRange: Object.freeze({ from: draft.from, to: draft.to }),
    sourceRevision,
    isProvisional: draft.isProvisional,
  };
  return Object.freeze(diff ? { ...base, diffKind: diff.diffKind, oldNo: diff.oldNo, newNo: diff.newNo } : base);
}

function draftFromRecord(record: CodeLineRecord, ending = record.ending, isProvisional = record.isProvisional): NativeCodeLineDraft {
  return { text: record.text, from: record.sourceRange.from, to: record.sourceRange.to, ending, isProvisional };
}

function sameProjection(
  record: CodeLineRecord,
  draft: NativeCodeLineDraft,
  index: number,
  ownerId: string,
  diff: DiffLineFields | undefined,
): boolean {
  return record.id === `${ownerId}:line:${index}`
    && record.index === index
    && record.text === draft.text
    && record.ending === draft.ending
    && record.sourceRange.from === draft.from
    && record.sourceRange.to === draft.to
    && record.isProvisional === draft.isProvisional
    && record.diffKind === diff?.diffKind
    && (record.oldNo ?? null) === (diff?.oldNo ?? null)
    && (record.newNo ?? null) === (diff?.newNo ?? null);
}

function validateRange(range: { readonly from: number; readonly to: number }, sourceLength: number): void {
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 0 || range.to < range.from || range.to > sourceLength) {
    throw new RangeError("Native code source range is outside the canonical input");
  }
}

/** Owns only the native code leaf tail; container structure remains in NodeSnapshot.children. */
export class NativeNestedCodeSourceOwner implements PreparedCodeLineOwner {
  readonly id: string;
  readonly containerId: string;
  readonly generation: number;
  readonly inputGeneration: number;

  private readonly sourceDocument: AppendSourceDocument;
  private readonly info: string;
  private readonly language: string | undefined;
  private readonly baseIndent: number;
  private readonly requiredIndent: number;
  private readonly fence: NativeCodeFence | undefined;
  private sourceState: NativeNestedCodeState;
  private sourceRange: { readonly from: number; readonly to: number };
  private processedTo: number;
  private revision = 0;
  private codeLines: CodeLineIndex;
  private diffCursor: DiffCursorState | undefined;
  /** Unified-diff fences tokenize diff-aware, as root code does. */
  readonly isDiff: boolean;
  private pendingCRAt: number | undefined;
  private highlightableLineCount = 0;
  private emptyPlaceholder: boolean;
  private cachedWindow: { readonly from: number; readonly to: number; readonly source: SourceSnapshot } | undefined;
  private presentation: {
    readonly revision: number;
    readonly highlightedHtml: string | undefined;
    readonly meta: Block["payload"]["meta"];
  } | undefined;

  private constructor(options: NativeNestedCodeSourceOwnerOptions) {
    if (!Number.isSafeInteger(options.generation) || options.generation < 0) throw new RangeError("Native code lease generation must be a non-negative safe integer");
    if (!Number.isSafeInteger(options.inputGeneration) || options.inputGeneration < 0) throw new RangeError("Native input generation must be a non-negative safe integer");
    if (options.source.length !== options.mapping.source.length) throw new RangeError("Native code mapping must use the current canonical source snapshot");
    if (!["FencedCode", "CodeBlock", "IndentedCode"].includes(options.node.type.name)) throw new TypeError("Native code ownership admits only configured-parser code nodes");

    const range = options.range ?? sourceRange(options.mapping, options.node.from, options.node.to);
    validateRange(range, options.mapping.source.length);
    const info = codeInfo(options.node, options.mapping);
    const parsedInfo = parseCodeFenceInfo(info);
    const kind = options.node.type.name as NativeNestedCodeNodeKind;
    const baseIndent = ancestorBaseIndent(options.node, options.mapping);
    const fencedIndent = openingIndent(options.node, options.mapping, baseIndent);

    this.id = options.id;
    this.containerId = options.containerId;
    this.generation = options.generation;
    this.inputGeneration = options.inputGeneration;
    this.sourceDocument = options.source;
    this.info = info;
    this.isDiff = detectDiffLanguage(parsedInfo.lang, parsedInfo.meta).isDiff;
    const initialDiffCursor: DiffCursorState | undefined = this.isDiff ? { oldLine: null, newLine: null } : undefined;
    this.language = parsedInfo.lang;
    this.baseIndent = baseIndent;
    this.requiredIndent = kind === "FencedCode" ? fencedIndent : 4;
    this.fence = openingFence(options.node, options.mapping);
    this.sourceState = options.closure;
    this.sourceRange = Object.freeze({ from: range.from, to: range.to });
    this.processedTo = range.to;
    this.pendingCRAt = undefined;

    const initial = readNativeCodeLines(
      options.mapping.source,
      mapCodeTextEvents(directCodeChildren(options.node), options.mapping),
      baseIndent,
      this.requiredIndent,
      options.closure,
      this.fence,
    );
    this.pendingCRAt = initial.pendingCRAt;
    const initialDrafts = initial.lines.length > 0
      ? initial.lines
      : [{ text: "", from: range.to, to: range.to, ending: "" as const, isProvisional: options.closure === "open" }];
    this.emptyPlaceholder = initial.lines.length === 0;
    this.highlightableLineCount = initialDrafts.reduce(
      (count, draft) => count + (NON_WHITESPACE.test(draft.text) ? 1 : 0),
      0,
    );
    let cursor = initialDiffCursor;
    let committedDiffCursor = initialDiffCursor;
    const initialRecords = initialDrafts.map((draft, index) => {
      const before = cursor ? { ...cursor } : undefined;
      const diff = cursor ? diffLineFields(draft.text, cursor) : undefined;
      committedDiffCursor = draft.isProvisional ? before : cursor ? { ...cursor } : undefined;
      return recordFromDraft(this.id, index, draft, 0, diff);
    });
    this.diffCursor = committedDiffCursor;
    this.codeLines = createCodeLineIndex({ lines: initialRecords });
    registerPreparedCodeLineSource(this, { info, ...(parsedInfo.lang ? { language: parsedInfo.lang } : {}) });
  }

  /** A new call always creates a fresh lease; reopening never revives prior Shiki continuation state. */
  static admit(options: NativeNestedCodeSourceOwnerOptions): NativeNestedCodeSourceOwner {
    return new NativeNestedCodeSourceOwner(options);
  }

  get state(): NativeNestedCodeState {
    return this.sourceState;
  }

  getLines(): CodeLineIndex {
    return this.codeLines;
  }
  get hasHighlightableContent(): boolean {
    return this.highlightableLineCount > 0;
  }
  setPresentation(block: Block): void {
    if (block.id !== this.id || block.type !== "code") {
      throw new TypeError("Native nested code presentation must belong to its source owner");
    }
    this.presentation = {
      revision: this.revision,
      highlightedHtml: block.payload.highlightedHtml,
      meta: block.payload.meta ? { ...block.payload.meta } : undefined,
    };
  }

  getPresentation(): {
    readonly highlightedHtml: string | undefined;
    readonly meta: Block["payload"]["meta"];
  } | undefined {
    const presentation = this.presentation;
    return presentation?.revision === this.revision ? presentation : undefined;
  }

  decorateLines(decorations: readonly CodeLineDecoration[]): CodeLineIndex {
    this.codeLines = this.codeLines.decorate(decorations);
    return this.codeLines;
  }

  getMetadata(): CodeBlockSourceMetadata {
    return Object.freeze({
      codeOwnerId: this.id,
      generation: this.generation,
      revision: this.revision,
      state: this.sourceState,
      processedTo: this.processedTo,
      completeLineCount: this.codeLines.completeLineCount,
      lineCount: this.codeLines.length,
      sourceRange: Object.freeze({ from: this.sourceRange.from, to: this.sourceRange.to }),
    });
  }

  getSourceSnapshot(): SourceSnapshot {
    if (this.cachedWindow?.from === this.sourceRange.from && this.cachedWindow.to === this.sourceRange.to) return this.cachedWindow.source;
    const source = createSourceWindow(this.sourceDocument.snapshot(), this.sourceRange.from, this.sourceRange.to);
    this.cachedWindow = { from: this.sourceRange.from, to: this.sourceRange.to, source };
    return source;
  }

  snapshot(configurationRevision = 0): NodeSnapshot {
    const metadata = this.getMetadata();
    const code: CodeBlockSnapshot = Object.freeze({
      ...metadata,
      configurationRevision,
      info: this.info,
      ...(this.language ? { language: this.language } : {}),
      lines: Object.freeze(this.codeLines.readRange(0, this.codeLines.length)),
      raw: this.getSourceSnapshot().materialize(),
    });
    const presentation = this.getPresentation();
    const block: Block | undefined = presentation
      ? {
          id: this.id,
          type: "code",
          isFinalized: this.sourceState !== "open",
          payload: {
            raw: code.raw,
            meta: presentation.meta ? { ...presentation.meta } : undefined,
            range: { ...this.sourceRange },
            inline: undefined,
            highlightedHtml: presentation.highlightedHtml,
            sanitizedHtml: undefined,
          },
        }
      : undefined;
    const props = Object.freeze({
      info: this.info,
      ...(this.language ? { language: this.language } : {}),
      ...(block ? { block } : {}),
    });
    return Object.freeze({
      id: this.id,
      type: "code",
      props,
      range: Object.freeze({ from: this.sourceRange.from, to: this.sourceRange.to }),
      code,
    });
  }

  /** Consume only the parser's changed native code tail and exact newly owned authored suffix. */
  acceptNativeTail(update: NativeNestedCodeTailUpdate): NativeNestedCodeSourceChange {
    if (update.inputGeneration !== this.inputGeneration) throw new Error("Native code update belongs to a different canonical input generation");
    if (update.sourceDocument !== this.sourceDocument) throw new Error("Native code update belongs to a different canonical source document");
    if (update.mapping.source.length !== this.sourceDocument.length) throw new RangeError("Native code update must use the current canonical source snapshot");
    if (this.sourceState === "finalized" || (this.sourceState === "closed" && update.closure !== "finalized")) {
      throw new Error(`Cannot append to a ${this.sourceState} native code lease; admit a fresh lease to reopen EOF`);
    }
    validateRange(update.sourceRange, update.mapping.source.length);
    if (update.sourceRange.from !== this.sourceRange.from || update.sourceRange.to < this.sourceRange.to) {
      throw new RangeError("Native code source range must extend its prior authored range");
    }

    const expectedRevision = this.revision;
    const previousRange = this.sourceRange;
    const oldState = this.sourceState;
    const oldComplete = this.codeLines.completeLineCount;
    const oldTail = this.codeLines.readRange(oldComplete, this.codeLines.length);
    const oldProvisional = oldTail.length > 0 ? oldTail[oldTail.length - 1] : undefined;
    const priorPendingCRResolved = this.pendingCRAt !== undefined && update.mapping.source.length > this.pendingCRAt + 1;
    const parsed = readNativeCodeLines(
      update.mapping.source,
      mapCodeTextEvents(update.nodes, update.mapping),
      this.baseIndent,
      this.requiredIndent,
      update.closure,
      this.fence,
    );
    const lastCompleted = oldComplete > 0 ? this.codeLines.get(oldComplete - 1) : undefined;
    const completedSourceTo = lastCompleted?.sourceRange.to;
    // The bounded parser tail may include a completed CodeText row again; it is already owned.
    const desiredTail = completedSourceTo === undefined
      ? parsed.lines.slice()
      : parsed.lines.filter((line) => line.to > completedSourceTo);
    const repeatsOldProvisional = oldProvisional !== undefined
      && desiredTail.some((line) => line.from === oldProvisional.sourceRange.from);

    if (oldProvisional && !this.emptyPlaceholder && !repeatsOldProvisional) {
      let ending = oldProvisional.ending;
      let isProvisional = oldProvisional.isProvisional;
      if (this.pendingCRAt !== undefined) {
        if (update.mapping.source.length > this.pendingCRAt + 1) {
          ending = lineEndingAt(update.mapping.source, this.pendingCRAt);
          isProvisional = false;
        } else if (update.closure !== "open") {
          ending = "\r";
          isProvisional = false;
        }
      } else {
        const sourceEnding = lineEndingAt(update.mapping.source, oldProvisional.sourceRange.to);
        if (sourceEnding === "\r" && oldProvisional.sourceRange.to + 1 === update.mapping.source.length && update.closure === "open") {
          this.pendingCRAt = oldProvisional.sourceRange.to;
          ending = "";
          isProvisional = true;
        } else if (sourceEnding) {
          ending = sourceEnding;
          isProvisional = false;
        } else if (update.closure !== "open") {
          ending = "";
          isProvisional = false;
        }
      }
      desiredTail.unshift(draftFromRecord(oldProvisional, ending, isProvisional));
    }

    let sourceTailPendingCRAt: number | undefined;
    let completedEmptyPlaceholder = false;
    if (this.emptyPlaceholder && desiredTail.length === 0) {
      const placeholder = this.codeLines.get(0);
      if (placeholder) {
        if (update.closure === "open" && update.sourceRange.to > previousRange.to) {
          const trailing = trailingNativeCodeLine(
            update.mapping.source,
            update.sourceRange.to,
            this.baseIndent,
            this.requiredIndent,
            update.closure,
            this.fence,
          );
          if (trailing.line && trailing.lineStart > lineStartAt(update.mapping.source, this.sourceRange.from)) {
            desiredTail.push(trailing.line);
            sourceTailPendingCRAt = trailing.pendingCRAt;
            completedEmptyPlaceholder = !trailing.line.isProvisional;
          } else {
            desiredTail.push(draftFromRecord(placeholder, placeholder.ending, true));
            sourceTailPendingCRAt = trailing.pendingCRAt;
          }
        } else {
          desiredTail.push(draftFromRecord(placeholder, placeholder.ending, update.closure === "open"));
        }
      }
    }

    const nextTail = desiredTail;
    const diffRows = this.diffCursor ? new Array<DiffLineFields>(nextTail.length) : undefined;
    let committedDiffCursor = this.diffCursor;
    if (diffRows && this.diffCursor) {
      const working = { ...this.diffCursor };
      for (let offset = 0; offset < nextTail.length; offset += 1) {
        const draft = nextTail[offset];
        if (draft.isProvisional) committedDiffCursor = { ...working };
        diffRows[offset] = diffLineFields(draft.text, working);
      }
      if (nextTail.length === 0 || !nextTail[nextTail.length - 1]?.isProvisional) {
        committedDiffCursor = { ...working };
      }
    }
    const reusable = new Array<CodeLineRecord | undefined>(nextTail.length);
    let rowsChanged = oldTail.length !== nextTail.length;
    for (let offset = 0; offset < nextTail.length; offset += 1) {
      const index = oldComplete + offset;
      const prior = oldTail[offset];
      const draft = nextTail[offset];
      if (prior && draft && sameProjection(prior, draft, index, this.id, diffRows?.[offset])) reusable[offset] = prior;
      else rowsChanged = true;
    }
    let highlightableLineCount = this.highlightableLineCount;
    if (rowsChanged) {
      for (const line of oldTail) {
        if (NON_WHITESPACE.test(line.text)) highlightableLineCount -= 1;
      }
      for (const line of nextTail) {
        if (NON_WHITESPACE.test(line.text)) highlightableLineCount += 1;
      }
    }

    const nextState = update.closure;
    const rangeChanged = previousRange.to !== update.sourceRange.to;
    if (this.sourceState === "closed" && update.sourceRange.to !== this.sourceRange.to) {
      throw new RangeError("Finalizing a closed native code lease cannot extend its authored source range");
    }
    const semanticChanged = rowsChanged || nextState !== oldState || rangeChanged;
    const revision = semanticChanged ? nextRevision(this.revision) : this.revision;
    const records = nextTail.map((draft, offset) => reusable[offset] ?? recordFromDraft(this.id, oldComplete + offset, draft, revision, diffRows?.[offset]));
    if (rowsChanged) this.codeLines = this.codeLines.replaceTail(oldComplete, records);
    if (rowsChanged) this.highlightableLineCount = highlightableLineCount;
    this.sourceState = nextState;
    this.diffCursor = committedDiffCursor;
    this.revision = revision;
    this.sourceRange = Object.freeze({ from: update.sourceRange.from, to: update.sourceRange.to });
    this.processedTo = update.sourceRange.to;
    this.pendingCRAt = nextState === "open"
      ? parsed.pendingCRAt ?? sourceTailPendingCRAt ?? (priorPendingCRResolved ? undefined : this.pendingCRAt)
      : undefined;
    if (this.emptyPlaceholder && (parsed.lines.length > 0 || completedEmptyPlaceholder)) this.emptyPlaceholder = false;
    if (nextState !== "open") this.emptyPlaceholder = false;
    if (rangeChanged) this.cachedWindow = undefined;

    const lines = semanticChanged
      ? Object.freeze(this.codeLines.readRange(oldComplete, this.codeLines.length))
      : EMPTY_CODE_LINES;
    const metadata = this.getMetadata();
    const sourceAppend = update.mapping.source.read(previousRange.to, update.sourceRange.to);
    if (previousRange.to + sourceAppend.length !== update.sourceRange.to) throw new Error("Native code sourceAppend does not match its physical authored range");
    return Object.freeze({
      code: metadata,
      expectedRevision,
      revision: this.revision,
      fromLine: oldComplete,
      lines,
      sourceAppend,
    });
  }

  finalizeClosed(): NativeNestedCodeSourceChange {
    if (this.sourceState === "finalized") {
      return Object.freeze({
        code: this.getMetadata(),
        expectedRevision: this.revision,
        revision: this.revision,
        fromLine: this.codeLines.completeLineCount,
        lines: EMPTY_CODE_LINES,
        sourceAppend: "",
      });
    }
    if (this.sourceState !== "closed" || this.codeLines.completeLineCount !== this.codeLines.length) {
      throw new Error("Only a settled closed native code owner can finalize without its parser mapping");
    }
    const expectedRevision = this.revision;
    this.sourceState = "finalized";
    this.revision = nextRevision(this.revision);
    this.pendingCRAt = undefined;
    if (this.presentation?.revision === expectedRevision) {
      this.presentation = { ...this.presentation, revision: this.revision };
    }
    return Object.freeze({
      code: this.getMetadata(),
      expectedRevision,
      revision: this.revision,
      fromLine: this.codeLines.completeLineCount,
      lines: EMPTY_CODE_LINES,
      sourceAppend: "",
    });
  }

  finalize(mapping: NativeNestedCodeSourceMapping): NativeNestedCodeSourceChange {
    if (this.sourceState === "finalized") {
      return Object.freeze({
        code: this.getMetadata(),
        expectedRevision: this.revision,
        revision: this.revision,
        fromLine: this.codeLines.completeLineCount,
        lines: EMPTY_CODE_LINES,
        sourceAppend: "",
      });
    }
    return this.acceptNativeTail({
      nodes: [],
      mapping,
      inputGeneration: this.inputGeneration,
      sourceDocument: this.sourceDocument,
      closure: "finalized",
      sourceRange: this.sourceRange,
    });
  }

  appendPatch(change: NativeNestedCodeSourceChange): Extract<Patch, { op: "appendCode" }> {
    if (change.code.codeOwnerId !== this.id || change.code.generation !== this.generation) {
      throw new TypeError("Native code append change belongs to a different owner lease");
    }

    return {
      op: "appendCode",
      at: { blockId: this.containerId, nodeId: this.id },
      code: change.code,
      expectedRevision: change.expectedRevision,
      fromLine: change.fromLine,
      lines: change.lines,
      sourceAppend: change.sourceAppend,
      meta: { kind: "semantic" },
    };
  }

  decoratePatch(
    configurationRevision: number,
    decorations: readonly CodeLineDecoration[],
  ): Extract<Patch, { op: "decorateCode" }> | null {
    if (decorations.length === 0) return null;
    return {
      op: "decorateCode",
      at: { blockId: this.containerId, nodeId: this.id },
      codeOwnerId: this.id,
      generation: this.generation,
      configurationRevision,
      decorations,
      meta: { kind: "enrichment" },
    };
  }
}
