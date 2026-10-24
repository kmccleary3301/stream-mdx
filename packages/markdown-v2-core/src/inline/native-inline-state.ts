import { InlineContext, type DelimiterType, type MarkdownParser } from "@lezer/markdown";
import type { MarkdownElement } from "./types";

interface NativeInlineContextConstructor {
  new(parser: MarkdownParser, text: string, offset: number): InlineContext;
}

const nativeInlineContextConstructor = InlineContext as typeof InlineContext & NativeInlineContextConstructor;

type NativeInlineToken = (context: InlineContext, next: number, position: number) => number;

type NativeDelimiter = {
  readonly type: DelimiterType;
  readonly from: number;
  readonly to: number;
  side: number;
};

type NativePart = MarkdownElement | NativeDelimiter | null;

type NativeContextView = InlineContext & {
  parts: NativePart[];
  resolveMarkers(from: number): MarkdownElement[];
};

type NativeParserView = MarkdownParser & {
  inlineParsers: readonly (NativeInlineToken | undefined)[];
  inlineNames: readonly string[];
};

export interface ActiveLinkDelimiter {
  readonly from: number;
  readonly to: number;
  side: number;
}

export interface InlineParserSettlement {
  readonly nodeNames: ReadonlySet<string>;
  readonly extendsAtEOF: boolean;
}

export interface NativeReferenceAttempt {
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

export interface NativeInlineSettlement {
  elements: MarkdownElement[];
  settledTo: number;
  referenceAttempts: readonly NativeReferenceAttempt[];
}

interface SourceSpan {
  from: number;
  to: number;
}

interface ContinuationState {
  unfinishedFrom: number;
  unresolvedReferenceSpans?: SourceSpan[];
  referenceAttempts?: NativeReferenceAttempt[];
}

const continuationStates = new WeakMap<InlineContext, ContinuationState>();
const OPEN = 1;
const CLOSE = 2;
const WHITESPACE = /\s/;
const HTML_COMPLETIONS = [">", "x>", "\">", "x\">", "'>", "x'>", "?>", "]]>", "-->"] as const;

const nativeLocalParsers: Record<string, true> = {
  Escape: true,
  Entity: true,
  InlineCode: true,
  HTMLTag: true,
  Emphasis: true,
  HardBreak: true,
  Link: true,
  LinkEnd: true,
  Image: true,
  ReferenceGuard: true,
  Strikethrough: true,
  Autolink: true,
  FtpAutolink: true,
  HtmlCommentCompatibility: true,
  Math: true,
};

function contextView(context: InlineContext): NativeContextView {
  return context as NativeContextView;
}

function parserView(parser: MarkdownParser): NativeParserView {
  return parser as NativeParserView;
}

function isDelimiter(part: NativePart): part is NativeDelimiter {
  return part !== null && typeof part.type !== "number";
}

function lowerBoundary(current: number, candidate: number): number {
  return candidate < current ? candidate : current;
}

function adjustBoundary(text: string, boundary: number): number {
  if (boundary > 0 && boundary < text.length) {
    const before = text.charCodeAt(boundary - 1);
    const after = text.charCodeAt(boundary);
    if ((before === 13 && after === 10) ||
        (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)) {
      return boundary - 1;
    }
  }
  return boundary;
}

function findTrailingRunStart(text: string): number {
  let cursor = text.length;
  while (cursor > 0 && WHITESPACE.test(text[cursor - 1])) cursor--;
  while (cursor > 0 && !WHITESPACE.test(text[cursor - 1])) cursor--;
  return cursor;
}

function parserNeedsWholeTail(
  parser: MarkdownParser,
  customParserNames: ReadonlySet<string>,
  settlements: ReadonlyMap<string, InlineParserSettlement>,
): boolean {
  const view = parserView(parser);
  for (let index = 0; index < view.inlineParsers.length; index++) {
    if (!view.inlineParsers[index]) continue;
    const name = view.inlineNames[index];
    if (customParserNames.has(name)) {
      if (!settlements.has(name)) return true;
    } else if (!nativeLocalParsers[name]) {
      return true;
    }
  }
  return false;
}

function reportUnfinished(context: InlineContext, from: number): void {
  const state = continuationStates.get(context);
  if (!state) return;
  const localFrom = from - context.offset;
  if (localFrom >= 0 && localFrom < state.unfinishedFrom) state.unfinishedFrom = localFrom;
}

/** Reports an actually failed candidate at the current configured-parser position. */
export function reportIncompleteNativeCandidate(
  context: InlineContext,
  from: number,
  open: string,
  close: string,
  lineBounded = false,
): void {
  if (!open || !close) return;
  const localFrom = from - context.offset;
  if (localFrom < 0 || localFrom >= context.text.length) return;

  const remaining = context.text.length - localFrom;
  if (remaining < open.length) {
    if (open.startsWith(context.text.slice(localFrom))) reportUnfinished(context, from);
    return;
  }
  if (!context.text.startsWith(open, localFrom)) return;

  let limit = context.text.length;
  if (lineBounded) {
    const newline = context.text.indexOf("\n", localFrom);
    const carriageReturn = context.text.indexOf("\r", localFrom);
    if (newline !== -1 && newline < limit) limit = newline;
    if (carriageReturn !== -1 && carriageReturn < limit) limit = carriageReturn;
  }
  const closeAt = context.text.indexOf(close, localFrom + open.length);
  if (closeAt === -1 || closeAt >= limit) reportUnfinished(context, from);
}

/** Records a failed, genuinely open token only while this adapter owns the context. */
export function reportUnfinishedNativeToken(context: InlineContext, from: number): void {
  reportUnfinished(context, from);
}

/** ReferenceGuard's exact native link/image opener, kept behind the private parts view. */
export function findActiveLinkDelimiter(context: InlineContext): ActiveLinkDelimiter | null {
  const parts = contextView(context).parts;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (!isDelimiter(part) || !part.side) continue;
    if (part.type === InlineContext.linkStart || part.type === InlineContext.imageStart) return part;
  }
  return null;
}

export function reportUnfinishedReference(context: InlineContext, from: number): void {
  reportUnfinished(context, from);
}

/** Protects a completed unresolved reference only if the eventual cut would split its source. */
export function reportUnresolvedReferenceSpan(context: InlineContext, from: number, to: number): void {
  const state = continuationStates.get(context);
  if (!state || to <= from) return;
  const localFrom = from - context.offset;
  const localTo = to - context.offset;
  if (localFrom < 0 || localTo > context.text.length) return;
  (state.unresolvedReferenceSpans ??= []).push({ from: localFrom, to: localTo });
}

/** Retains a native ReferenceGuard candidate span and the label it actually queried. */
export function reportReferenceAttempt(
  context: InlineContext,
  from: number,
  to: number,
  label: string,
): void {
  const state = continuationStates.get(context);
  if (!state || to <= from) return;
  const localFrom = from - context.offset;
  const localTo = to - context.offset;
  if (localFrom < 0 || localTo > context.text.length) return;
  (state.referenceAttempts ??= []).push({ from: localFrom, to: localTo, label });
}

function nativeEntityCanComplete(
  parser: MarkdownParser,
  token: NativeInlineToken,
  text: string,
  position: number,
): boolean {
  const inspected = text.slice(position, position + 31);
  if (inspected.length === 0 || inspected.charCodeAt(0) !== 38) return false;

  const completion = inspected.length === 1 ? "a;" : inspected.charCodeAt(1) === 35 ? "0;" : ";";
  const probe = new nativeInlineContextConstructor(parser, inspected + completion, position);
  return token(probe, probe.char(position), position) >= 0;
}

function nativeHtmlCanComplete(
  parser: MarkdownParser,
  token: NativeInlineToken,
  text: string,
  position: number,
): boolean {
  const suffix = text.slice(position);
  for (const completion of HTML_COMPLETIONS) {
    const probe = new nativeInlineContextConstructor(parser, suffix + completion, position);
    if (token(probe, probe.char(position), position) >= 0) return true;
  }
  return false;
}

function clampToNativeElement(elements: readonly MarkdownElement[], boundary: number): number {
  let safe = boundary;
  for (const element of elements) {
    if (element.from < boundary && boundary < element.to) safe = lowerBoundary(safe, element.from);
    safe = lowerBoundary(safe, clampToNativeElement(element.children, boundary));
  }
  return safe;
}

export function finalizeNativeInlineBoundary(
  text: string,
  elements: readonly MarkdownElement[],
  boundary: number,
): number {
  let safe = boundary;
  while (true) {
    const clamped = clampToNativeElement(elements, safe);
    if (clamped === safe) return adjustBoundary(text, safe);
    safe = clamped;
  }
}

function collectBoundary(
  parser: MarkdownParser,
  context: InlineContext,
  elements: readonly MarkdownElement[],
  text: string,
  state: ContinuationState,
  settlements: ReadonlyMap<string, InlineParserSettlement>,
): number {
  let boundary = state.unfinishedFrom;
  const nativeContext = contextView(context);

  for (const part of nativeContext.parts) {
    if (!isDelimiter(part)) continue;
    if (part.side & OPEN) boundary = lowerBoundary(boundary, part.from);
    else if ((part.side & CLOSE) && part.to === text.length) boundary = lowerBoundary(boundary, part.from);
  }

  boundary = lowerBoundary(boundary, findTrailingRunStart(text));

  let trailingBackslashes = 0;
  for (let index = text.length - 1; index >= 0 && text.charCodeAt(index) === 92; index--) trailingBackslashes++;
  if (trailingBackslashes % 2 === 1) {
    let escapeStart = text.length - trailingBackslashes;
    while (escapeStart > 0 && WHITESPACE.test(text[escapeStart - 1])) escapeStart--;
    boundary = lowerBoundary(boundary, escapeStart);
  }

  const nodeTypes = parser.nodeSet.types;
  const inspect = (nodes: readonly MarkdownElement[], topLevel: boolean): void => {
    for (const element of nodes) {
      const name = nodeTypes[element.type]?.name ?? "";
      if (element.to === text.length) {
        if (name === "InlineCode" || name === "Emphasis" || name === "StrongEmphasis" || name === "Strikethrough") {
          boundary = lowerBoundary(boundary, element.from);
        }
        if (topLevel && name === "URL") boundary = lowerBoundary(boundary, element.from);
        for (const settlement of settlements.values()) {
          if (settlement.extendsAtEOF && settlement.nodeNames.has(name)) {
            boundary = lowerBoundary(boundary, element.from);
          }
        }
      }
      if ((name === "Link" || name === "Image") && text.charCodeAt(element.to) === 40) {
        boundary = lowerBoundary(boundary, element.from);
      }
      inspect(element.children, false);
    }
  };
  inspect(elements, true);

  for (const span of state.unresolvedReferenceSpans ?? []) {
    if (span.from < boundary && boundary < span.to) boundary = span.from;
  }

  return finalizeNativeInlineBoundary(text, elements, boundary);
}

export function parseNativeInlineSettlement(
  parser: MarkdownParser,
  text: string,
  customParserNames: ReadonlySet<string>,
  settlements: ReadonlyMap<string, InlineParserSettlement>,
): NativeInlineSettlement {
  if (parserNeedsWholeTail(parser, customParserNames, settlements)) {
    return { elements: [], settledTo: 0, referenceAttempts: [] };
  }

  const view = parserView(parser);
  const context = new nativeInlineContextConstructor(parser, text, 0);
  const state: ContinuationState = { unfinishedFrom: text.length };
  continuationStates.set(context, state);

  outer: for (let position = 0; position < context.end;) {
    const next = context.char(position);
    for (let index = 0; index < view.inlineParsers.length; index++) {
      const token = view.inlineParsers[index];
      if (!token) continue;
      const name = view.inlineNames[index];
      const result = token(context, next, position);
      if (result >= 0) {
        position = result;
        continue outer;
      }

      if (name === "InlineCode" && next === 96) {
        reportUnfinished(context, position);
      } else if (name === "Entity" && next === 38 && nativeEntityCanComplete(parser, token, text, position)) {
        reportUnfinished(context, position);
      } else if (name === "HTMLTag" && next === 60 && nativeHtmlCanComplete(parser, token, text, position)) {
        reportUnfinished(context, position);
      }
    }
    position++;
  }

  const elements = contextView(context).resolveMarkers(0);
  const settledTo = collectBoundary(parser, context, elements, text, state, settlements);
  continuationStates.delete(context);
  return { elements, settledTo, referenceAttempts: state.referenceAttempts ?? [] };
}
