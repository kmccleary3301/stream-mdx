import type { InlineNode, MixedContentSegment } from "./types";
import { sanitizeHtmlInWorker } from "./worker-html-sanitizer";

export function extractMixedContentSegments(
  raw: string,
  baseOffset: number | undefined,
  parseInline: (content: string) => InlineNode[],
): MixedContentSegment[] {
  if (!raw) return [];
  const initial = splitByTagSegments(raw, baseOffset, parseInline);
  const expanded: MixedContentSegment[] = [];
  for (const segment of initial) {
    if (segment.kind === "text") {
      expanded.push(...splitTextSegmentByExpressions(segment, parseInline));
    } else {
      expanded.push(segment);
    }
  }
  return mergeAdjacentTextSegments(expanded, parseInline);
}

function splitByTagSegments(source: string, baseOffset: number | undefined, parseInline: (content: string) => InlineNode[]): MixedContentSegment[] {
  const segments: MixedContentSegment[] = [];
  const lowerSource = source.toLowerCase();
  const tagPattern = /<([A-Za-z][\w:-]*)([^<>]*?)\/?>/g;
  let cursor = 0;
  let match: RegExpExecArray | null = tagPattern.exec(source);
  const baseIsFinite = typeof baseOffset === "number" && Number.isFinite(baseOffset);

  while (match !== null) {
    const start = match.index;
    const tagName = match[1];
    const matchText = match[0];
    const isSelfClosing = matchText.endsWith("/>") || isVoidHtmlTag(tagName);
    let end = tagPattern.lastIndex;

    if (!isSelfClosing && !isLikelyMdxComponent(tagName)) {
      const closingIndex = findClosingHtmlTag(lowerSource, tagName.toLowerCase(), end);
      if (closingIndex === -1) {
        // Tag not closed (common during streaming). Treat it as plain text and
        // continue scanning after the "<" so we don't get stuck on the same match.
        tagPattern.lastIndex = start + 1;
        match = tagPattern.exec(source);
        continue;
      }
      end = closingIndex;
    }

    if (start > cursor) {
      const absoluteFrom = baseIsFinite ? (baseOffset as number) + cursor : undefined;
      const absoluteTo = baseIsFinite ? (baseOffset as number) + start : undefined;
      pushTextSegment(segments, source.slice(cursor, start), absoluteFrom, absoluteTo, parseInline);
    }

    const rawSegment = source.slice(start, end);
    const kind: MixedContentSegment["kind"] = isLikelyMdxComponent(tagName) ? "mdx" : "html";
    const segment: MixedContentSegment = {
      kind,
      value: rawSegment,
      range: createSegmentRange(baseOffset, start, end),
    };
    if (kind === "html") {
      segment.sanitized = sanitizeHtmlInWorker(rawSegment);
    } else {
      segment.status = "pending";
    }
    segments.push(segment);
    cursor = end;
    tagPattern.lastIndex = end;
    match = tagPattern.exec(source);
  }

  if (cursor < source.length) {
    const absoluteFrom = baseIsFinite ? (baseOffset as number) + cursor : undefined;
    const absoluteTo = baseIsFinite ? (baseOffset as number) + source.length : undefined;
    pushTextSegment(segments, source.slice(cursor), absoluteFrom, absoluteTo, parseInline);
  }

  return segments;
}

function splitTextSegmentByExpressions(segment: MixedContentSegment, parseInline: (content: string) => InlineNode[]): MixedContentSegment[] {
  if (segment.kind !== "text" || !segment.value) {
    return [segment];
  }
  const { value } = segment;
  if (isLikelyMathSegment(value)) {
    return [segment];
  }
  const hasRange = segment.range && typeof segment.range.from === "number" && typeof segment.range.to === "number";
  const rangeStart = hasRange ? segment.range?.from : undefined;
  const exprPattern = /\{[^{}]+\}/g;
  const results: MixedContentSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = exprPattern.exec(value);

  while (match !== null) {
    const start = match.index;
    const end = exprPattern.lastIndex;
    if (start > cursor) {
      const textValue = value.slice(cursor, start);
      results.push({
        kind: "text",
        value: textValue,
        range: createSegmentRange(rangeStart, cursor, start),
        inline: parseInline(textValue),
      });
    }
    const expressionValue = match[0];
    results.push({
      kind: "mdx",
      value: expressionValue,
      range: createSegmentRange(rangeStart, start, end),
      status: "pending",
    });
    cursor = end;
    match = exprPattern.exec(value);
  }

  if (cursor < value.length) {
    const textValue = value.slice(cursor);
    results.push({
      kind: "text",
      value: textValue,
      range: createSegmentRange(rangeStart, cursor, value.length),
      inline: parseInline(textValue),
    });
  }

  return results.length > 0 ? results : [segment];
}

function isLikelyMathSegment(value: string): boolean {
  if (!value) return false;
  if (value.includes("$$")) {
    return true;
  }
  if (/\\begin\{[^}]+\}/.test(value) || /\\end\{[^}]+\}/.test(value)) {
    return true;
  }
  if (/\\\(|\\\)|\\\[|\\\]/.test(value)) {
    return true;
  }
  if (/\$[^$]*\$/.test(value)) {
    return true;
  }
  if (/\\[a-zA-Z]+\{/.test(value)) {
    return true;
  }
  return false;
}

function mergeAdjacentTextSegments(segments: MixedContentSegment[], parseInline: (content: string) => InlineNode[]): MixedContentSegment[] {
  if (segments.length === 0) return segments;
  const merged: MixedContentSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "text" && segment.value.length === 0) {
      continue;
    }
    const last = merged[merged.length - 1];
    if (segment.kind === "text" && last && last.kind === "text" && last.range && segment.range && last.range.to === segment.range.from) {
      last.value += segment.value;
      if (last.range && segment.range) {
        last.range.to = segment.range.to;
      }
      last.inline = parseInline(last.value);
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

function pushTextSegment(
  target: MixedContentSegment[],
  value: string,
  from: number | undefined,
  to: number | undefined,
  parseInline: (content: string) => InlineNode[],
): void {
  if (value.length === 0) return;
  target.push({
    kind: "text",
    value,
    range: createSegmentRange(from, 0, value.length, to),
    inline: parseInline(value),
  });
}

function createSegmentRange(base: number | undefined, relativeFrom: number, relativeTo: number, absoluteTo?: number): { from: number; to: number } | undefined {
  if (typeof base !== "number" || !Number.isFinite(base)) {
    return undefined;
  }
  const from = base + relativeFrom;
  const to = absoluteTo !== undefined ? absoluteTo : base + relativeTo;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    return undefined;
  }
  return { from, to };
}

const VOID_HTML_TAGS = new Set(["br", "hr", "img", "meta", "input", "link", "source", "track", "area", "base", "col", "embed"]);

function isVoidHtmlTag(tagName: string): boolean {
  return VOID_HTML_TAGS.has(tagName.toLowerCase());
}

export function isLikelyMdxComponent(tagName: string): boolean {
  const first = tagName.charAt(0);
  return first.toUpperCase() === first && first.toLowerCase() !== first;
}

export function findClosingHtmlTag(lowerSource: string, lowerTagName: string, startIndex: number): number {
  let depth = 1;
  let searchIndex = startIndex;
  while (searchIndex < lowerSource.length) {
    const nextOpen = lowerSource.indexOf(`<${lowerTagName}`, searchIndex);
    const nextClose = lowerSource.indexOf(`</${lowerTagName}`, searchIndex);
    if (nextClose === -1) {
      return -1;
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      searchIndex = nextOpen + 1;
      continue;
    }
    const closeEnd = lowerSource.indexOf(">", nextClose);
    if (closeEnd === -1) {
      return -1;
    }
    depth--;
    const absoluteEnd = closeEnd + 1;
    if (depth === 0) {
      return absoluteEnd;
    }
    searchIndex = absoluteEnd;
  }
  return -1;
}
