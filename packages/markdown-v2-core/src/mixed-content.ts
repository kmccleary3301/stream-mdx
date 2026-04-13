import { buildLookaheadContainerContext, prepareSurfaceLookahead } from "./streaming/inline-streaming";
import type { LookaheadContainerContext, LookaheadDecisionTrace } from "./streaming/lookahead-contract";
import type { InlineNode, MixedContentSegment, ProtectedRange } from "./types";
import { sanitizeHtmlInWorker } from "./worker-html-sanitizer";

export interface MixedContentAutoCloseHtmlOptions {
  autoClose?: boolean;
  maxNewlines?: number;
  allowTags?: Iterable<string>;
}

export interface MixedContentAutoCloseMdxOptions {
  autoClose?: boolean;
  maxNewlines?: number;
  componentAllowlist?: Iterable<string>;
}

export interface MixedContentOptions {
  html?: MixedContentAutoCloseHtmlOptions;
  mdx?: MixedContentAutoCloseMdxOptions;
  protectedRanges?: ReadonlyArray<ProtectedRange>;
  protectedRangeKinds?: ReadonlyArray<ProtectedRange["kind"]>;
  lookaheadContext?: Partial<LookaheadContainerContext>;
}

export interface MixedContentExtractionResult {
  segments: MixedContentSegment[];
  lookahead: LookaheadDecisionTrace[];
}

const DEFAULT_INLINE_HTML_AUTOCLOSE_TAGS = new Set([
  "span",
  "em",
  "strong",
  "code",
  "kbd",
  "del",
  "s",
  "mark",
  "sub",
  "sup",
  "i",
  "b",
  "u",
  "small",
  "abbr",
  "a",
]);

export function extractMixedContentSegments(
  raw: string,
  baseOffset: number | undefined,
  parseInline: (content: string) => InlineNode[],
  options?: MixedContentOptions,
): MixedContentSegment[] {
  return extractMixedContentSegmentsWithLookahead(raw, baseOffset, parseInline, options).segments;
}

export function extractMixedContentSegmentsWithLookahead(
  raw: string,
  baseOffset: number | undefined,
  parseInline: (content: string) => InlineNode[],
  options?: MixedContentOptions,
): MixedContentExtractionResult {
  if (!raw) return { segments: [], lookahead: [] };
  const initial = splitByTagSegments(raw, baseOffset, parseInline, options);
  const expanded: MixedContentSegment[] = [];
  const lookahead: LookaheadDecisionTrace[] = [];
  for (const segment of initial) {
    if (segment.kind === "text") {
      expanded.push(...splitTextSegmentByExpressions(segment, parseInline));
    } else {
      expanded.push(segment);
    }
    if (Array.isArray(segment.lookahead) && segment.lookahead.length > 0) {
      lookahead.push(...(segment.lookahead as LookaheadDecisionTrace[]));
    }
  }
  return { segments: mergeAdjacentTextSegments(expanded, parseInline), lookahead };
}

function splitByTagSegments(
  source: string,
  baseOffset: number | undefined,
  parseInline: (content: string) => InlineNode[],
  options?: MixedContentOptions,
): MixedContentSegment[] {
  const segments: MixedContentSegment[] = [];
  const lowerSource = source.toLowerCase();
  const tagPattern = /<([A-Za-z][\w:-]*)([^<>]*?)\/?>/g;
  let cursor = 0;
  let match: RegExpExecArray | null = tagPattern.exec(source);
  const baseIsFinite = typeof baseOffset === "number" && Number.isFinite(baseOffset);
  const htmlAllowTags = normalizeHtmlAllowlist(options?.html?.allowTags);
  const htmlAutoClose = options?.html?.autoClose === true;
  const htmlMaxNewlines = normalizeNewlineLimit(options?.html?.maxNewlines);
  const mdxAutoClose = options?.mdx?.autoClose === true;
  const mdxMaxNewlines = normalizeNewlineLimit(options?.mdx?.maxNewlines);
  const mdxAllowlist = normalizeComponentAllowlist(options?.mdx?.componentAllowlist);
  const protectedRanges = options?.protectedRanges ?? [];
  const protectedKinds = protectedRanges.length
    ? new Set<ProtectedRange["kind"]>(options?.protectedRangeKinds ?? ["math-inline", "math-display", "code-inline", "code-block", "autolink"])
    : null;

  const baseLookaheadContext = buildLookaheadContainerContext({
    segmentOrigin: "mixed-content",
    provisional: true,
    ...options?.lookaheadContext,
  });

  while (match !== null) {
    const start = match.index;
    const tagName = match[1];
    const matchText = match[0];
    const tagNameLower = tagName.toLowerCase();
    const isSelfClosing = matchText.endsWith("/>") || isVoidHtmlTag(tagNameLower);
    const mdxCandidate = isLikelyMdxComponent(tagName);
    const mdxAllowed = mdxCandidate && (!mdxAllowlist || mdxAllowlist.has(tagName));
    if (mdxCandidate && mdxAllowlist && !mdxAllowed) {
      // If a component isn't allowlisted, keep it as text until fully closed.
      tagPattern.lastIndex = start + 1;
      match = tagPattern.exec(source);
      continue;
    }
    let end = tagPattern.lastIndex;
    if (protectedKinds && protectedRanges.length > 0) {
      const absoluteStart = baseIsFinite ? (baseOffset as number) + start : start;
      const absoluteEnd = baseIsFinite ? (baseOffset as number) + end : end;
      const covered = protectedRanges.some(
        (range) =>
          protectedKinds.has(range.kind) &&
          typeof range.from === "number" &&
          typeof range.to === "number" &&
          range.from <= absoluteStart &&
          range.to >= absoluteEnd,
      );
      if (covered) {
        tagPattern.lastIndex = start + 1;
        match = tagPattern.exec(source);
        continue;
      }
    }

    if (!isSelfClosing) {
      const closingIndex = findClosingHtmlTag(lowerSource, tagNameLower, end);
      if (closingIndex !== -1) {
        end = closingIndex;
      } else if (mdxAllowed) {
        if (!mdxAutoClose) {
          // Without MDX auto-close, avoid emitting a synthetic segment for an unclosed tag.
          // This prevents opening-tag-only segments that can later drift from finalized structure.
          tagPattern.lastIndex = start + 1;
          match = tagPattern.exec(source);
          continue;
        }
        const rawSegment = source.slice(start, end);
        const anticipated = prepareSurfaceLookahead("mdx-tag", rawSegment, {
          allowComponents: mdxAllowlist ?? undefined,
          maxNewlines: mdxMaxNewlines,
          context: {
            ...baseLookaheadContext,
            insideMdx: true,
            mixedSegmentKind: "mdx",
          },
        });
        if (anticipated.prepared.kind !== "parse") {
          tagPattern.lastIndex = start + 1;
          match = tagPattern.exec(source);
          continue;
        }
        if (start > cursor) {
          const absoluteFrom = baseIsFinite ? (baseOffset as number) + cursor : undefined;
          const absoluteTo = baseIsFinite ? (baseOffset as number) + start : undefined;
          pushTextSegment(segments, source.slice(cursor, start), absoluteFrom, absoluteTo, parseInline);
        }
        const repaired = anticipated.prepared.content;
        segments.push({
          kind: "mdx",
          value: repaired,
          range: createSegmentRange(baseOffset, start, end),
          status: "pending",
          lookahead: anticipated.trace,
        });
        cursor = end;
        tagPattern.lastIndex = end;
        match = tagPattern.exec(source);
        continue;
      } else {
        if (htmlAutoClose && htmlAllowTags.has(tagNameLower)) {
          const rawSegment = source.slice(start);
          const anticipated = prepareSurfaceLookahead("html-inline", rawSegment, {
            allowTags: htmlAllowTags,
            maxNewlines: htmlMaxNewlines,
            context: {
              ...baseLookaheadContext,
              insideHtml: true,
              mixedSegmentKind: "html",
            },
          });
          if (anticipated.prepared.kind === "parse") {
            if (start > cursor) {
              const absoluteFrom = baseIsFinite ? (baseOffset as number) + cursor : undefined;
              const absoluteTo = baseIsFinite ? (baseOffset as number) + start : undefined;
              pushTextSegment(segments, source.slice(cursor, start), absoluteFrom, absoluteTo, parseInline);
            }
            const closedValue = anticipated.prepared.content;
            const segment: MixedContentSegment = {
              kind: "html",
              value: closedValue,
              range: createSegmentRange(baseOffset, start, source.length),
              sanitized: sanitizeHtmlInWorker(closedValue),
              lookahead: anticipated.trace,
            };
            segments.push(segment);
            cursor = source.length;
            break;
          }
        }
        // Tag not closed (common during streaming). Treat it as plain text and
        // continue scanning after the "<" so we don't get stuck on the same match.
        tagPattern.lastIndex = start + 1;
        match = tagPattern.exec(source);
        continue;
      }
    }

    if (start > cursor) {
      const absoluteFrom = baseIsFinite ? (baseOffset as number) + cursor : undefined;
      const absoluteTo = baseIsFinite ? (baseOffset as number) + start : undefined;
      pushTextSegment(segments, source.slice(cursor, start), absoluteFrom, absoluteTo, parseInline);
    }

    let rawSegment = source.slice(start, end);
    const kind: MixedContentSegment["kind"] = mdxAllowed ? "mdx" : "html";
    const segment: MixedContentSegment = {
      kind,
      value: rawSegment,
      range: createSegmentRange(baseOffset, start, end),
    };
    if (kind === "html") {
      segment.sanitized = sanitizeHtmlInWorker(rawSegment);
    } else {
      const closingTagPattern = new RegExp(`</\\s*${escapeRegExp(tagName)}\\s*>\\s*$`, "i");
      const hasExplicitClose = closingTagPattern.test(rawSegment);
      if (mdxAutoClose && !hasExplicitClose && !rawSegment.endsWith("/>")) {
        const anticipated = prepareSurfaceLookahead("mdx-tag", rawSegment, {
          allowComponents: mdxAllowlist ?? undefined,
          maxNewlines: mdxMaxNewlines,
          context: {
            ...baseLookaheadContext,
            insideMdx: true,
            mixedSegmentKind: "mdx",
          },
        });
        if (anticipated.prepared.kind === "parse") {
          rawSegment = anticipated.prepared.content;
          segment.value = rawSegment;
          segment.lookahead = anticipated.trace;
        }
      }
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

function normalizeNewlineLimit(value: number | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return 2;
  }
  return Math.max(0, value ?? 0);
}

function normalizeHtmlAllowlist(value: Iterable<string> | undefined): Set<string> {
  if (!value) return DEFAULT_INLINE_HTML_AUTOCLOSE_TAGS;
  const tags = new Set<string>();
  for (const tag of value) {
    if (tag) {
      tags.add(tag.toLowerCase());
    }
  }
  return tags.size > 0 ? tags : DEFAULT_INLINE_HTML_AUTOCLOSE_TAGS;
}

function normalizeComponentAllowlist(value: Iterable<string> | undefined): Set<string> | null {
  if (!value) return null;
  const tags = new Set<string>();
  for (const tag of value) {
    if (tag) tags.add(tag);
  }
  return tags.size > 0 ? tags : null;
}

function countNewlines(value: string, limit?: number): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) {
      count += 1;
      if (limit !== undefined && count >= limit) {
        return count;
      }
    }
  }
  return count;
}

function selfCloseTag(rawTag: string): string {
  if (rawTag.endsWith("/>")) return rawTag;
  const closeIndex = rawTag.lastIndexOf(">");
  if (closeIndex === -1) return rawTag;
  return `${rawTag.slice(0, closeIndex)}/>`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
