import { buildLookaheadContainerContext, createContainerSignature, prepareSurfaceLookahead } from "./streaming/inline-streaming";
import type { LookaheadContainerContext, LookaheadDecisionTrace } from "./streaming/lookahead-contract";
import type { InlineNode, MixedContentSegment, ProtectedRange } from "./types";
import { sanitizeHtmlInWorker } from "./worker-html-sanitizer";

export interface MixedContentAutoCloseHtmlOptions {
  autoClose?: boolean;
  maxNewlines?: number;
  allowTags?: Iterable<string>;
  allowedTags?: Record<string, string[]>;
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
  allowedTags?: Record<string, string[]>;
  literalTagContent?: string[];
}

export interface MixedContentExtractionResult {
  segments: MixedContentSegment[];
  lookahead: LookaheadDecisionTrace[];
}

function mixedSurfaceContext(input: Partial<LookaheadContainerContext> | undefined, kind: "html" | "mdx", localTextField?: string): LookaheadContainerContext {
  const context = buildLookaheadContainerContext({
    ...input,
    segmentOrigin: "mixed-content",
    mixedSegmentKind: kind,
    insideHtml: kind === "html" || input?.insideHtml === true,
    insideMdx: kind === "mdx" || input?.insideMdx === true,
    localTextField: localTextField ?? input?.localTextField,
  });
  return { ...context, containerSignature: createContainerSignature(context) };
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
  const needsLocalRanges = !(typeof baseOffset === "number" && Number.isFinite(baseOffset)) && (options?.protectedRanges?.length ?? 0) > 0;
  const initial = splitByTagSegments(raw, needsLocalRanges ? 0 : baseOffset, parseInline, options);
  const expanded: MixedContentSegment[] = [];
  const lookahead: LookaheadDecisionTrace[] = [];
  for (const segment of initial) {
    if (segment.kind === "text") {
      const splitSegments = splitTextSegmentByExpressions(segment, parseInline, options);
      expanded.push(...splitSegments);
      for (const splitSegment of splitSegments) {
        if (Array.isArray(splitSegment.lookahead) && splitSegment.lookahead.length > 0) {
          lookahead.push(...(splitSegment.lookahead as LookaheadDecisionTrace[]));
        }
      }
    } else {
      expanded.push(segment);
    }
    if (segment.kind !== "text" && Array.isArray(segment.lookahead) && segment.lookahead.length > 0) {
      lookahead.push(...(segment.lookahead as LookaheadDecisionTrace[]));
    }
  }
  const segments = mergeAdjacentTextSegments(expanded, parseInline);
  if (needsLocalRanges) {
    for (const segment of segments) delete segment.range;
  }
  return { segments, lookahead };
}
/** `sourcePositions[i]` is the absolute authored UTF-16 offset of `rawSource[i]`. */
export function prepareTrustedMdxInlineNodes(
  nodes: readonly InlineNode[],
  rawSource: string,
  baseOffset: number,
  ownerIdPrefix: string,
  options?: Pick<MixedContentOptions, "protectedRanges" | "protectedRangeKinds">,
  sourcePositions?: readonly number[],
): InlineNode[] {
  const hasSourcePositions = sourcePositions !== undefined;
  if (
    (hasSourcePositions && sourcePositions.length !== rawSource.length) ||
    (!hasSourcePositions && (!Number.isSafeInteger(baseOffset) || baseOffset < 0)) ||
    !ownerIdPrefix
  ) return nodes as InlineNode[];

  if (sourcePositions) {
    let previous = -1;
    for (const position of sourcePositions) {
      if (!Number.isSafeInteger(position) || position < 0 || position <= previous) return nodes as InlineNode[];
      previous = position;
    }
  }

  const lowerBound = (target: number): number => {
    let low = 0;
    let high = sourcePositions?.length ?? 0;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((sourcePositions as readonly number[])[middle] < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const localRangeForSourceRange = (from: number, to: number): { from: number; to: number } | undefined => {
    if (sourcePositions) {
      const localFrom = lowerBound(from);
      const localTo = lowerBound(to);
      return localFrom < localTo &&
        sourcePositions[localFrom] === from &&
        sourcePositions[localTo - 1] + 1 === to
        ? { from: localFrom, to: localTo }
        : undefined;
    }
    const localFrom = from - baseOffset;
    const localTo = to - baseOffset;
    return localFrom >= 0 && localTo <= rawSource.length && localTo > localFrom
      ? { from: localFrom, to: localTo }
      : undefined;
  };
  const sourceRangeForLocalRange = (from: number, to: number): { from: number; to: number } | undefined => {
    if (from < 0 || to <= from || to > rawSource.length) return undefined;
    return sourcePositions
      ? { from: sourcePositions[from], to: sourcePositions[to - 1] + 1 }
      : { from: baseOffset + from, to: baseOffset + to };
  };

  const extractionOptions = sourcePositions && options?.protectedRanges
    ? {
        ...options,
        protectedRanges: options.protectedRanges.flatMap((range) => {
          const from = lowerBound(range.from);
          const to = lowerBound(range.to);
          return from < to ? [{ ...range, from, to }] : [];
        }),
      }
    : options;
  type Candidate = {
    from: number;
    to: number;
    localFrom: number;
    localTo: number;
    raw: string;
    ownerId: string;
  };
  let candidateOrdinal = 0;
  const candidates: Candidate[] = extractMixedContentSegments(
    rawSource,
    sourcePositions ? 0 : baseOffset,
    () => [],
    extractionOptions,
  ).flatMap((segment) => {
    const range = segment.range;
    if (segment.kind !== "mdx" || !range || range.to <= range.from) return [];
    const localFrom = range.from - (sourcePositions ? 0 : baseOffset);
    const localTo = range.to - (sourcePositions ? 0 : baseOffset);
    const sourceRange = sourceRangeForLocalRange(localFrom, localTo);
    if (!sourceRange) return [];
    const index = candidateOrdinal++;
    return [{
      ...sourceRange,
      localFrom,
      localTo,
      raw: rawSource.slice(localFrom, localTo),
      ownerId: `${ownerIdPrefix}::native-mdx:${index}`,
    }];
  });
  if (candidates.length === 0) return nodes as InlineNode[];

  const resolved = new Set<Candidate>();
  const trustedNode = (candidate: Candidate): InlineNode => ({
    kind: "trusted-mdx-inline",
    raw: candidate.raw,
    ownerId: candidate.ownerId,
    sourceRange: { from: candidate.from, to: candidate.to },
  });
  const splitTextNode = (
    node: InlineNode,
    range: { from: number; to: number },
    candidatesInside: readonly Candidate[],
  ): InlineNode[] | undefined => {
    if (node.kind !== "text") return undefined;
    const localNode = localRangeForSourceRange(range.from, range.to);
    if (!localNode) return undefined;
    const result: InlineNode[] = [];
    const splitCandidates: Candidate[] = [];
    let cursor = localNode.from;
    for (const candidate of candidatesInside) {
      if (candidate.localFrom < cursor || candidate.localTo > localNode.to) continue;
      if (candidate.localFrom > cursor) {
        const sourceRange = sourceRangeForLocalRange(cursor, candidate.localFrom);
        if (!sourceRange) return undefined;
        result.push({
          kind: "text",
          text: rawSource.slice(cursor, candidate.localFrom),
          sourceRange,
        });
      }
      result.push(trustedNode(candidate));
      splitCandidates.push(candidate);
      cursor = candidate.localTo;
    }
    if (cursor < localNode.to) {
      const sourceRange = sourceRangeForLocalRange(cursor, localNode.to);
      if (!sourceRange) return undefined;
      result.push({ kind: "text", text: rawSource.slice(cursor, localNode.to), sourceRange });
    }
    for (const candidate of splitCandidates) resolved.add(candidate);
    return result;
  };

  const transformList = (values: readonly InlineNode[]): InlineNode[] => {
    let result: InlineNode[] | undefined;
    for (let index = 0; index < values.length; index++) {
      const node = values[index];
      const range = node.sourceRange;
      const exact = range && candidates.find(
        (candidate) => !resolved.has(candidate) && candidate.from === range.from && candidate.to === range.to,
      );
      let transformed: InlineNode[];
      if (exact) {
        resolved.add(exact);
        transformed = [trustedNode(exact)];
      } else {
        if ("children" in node && Array.isArray(node.children)) {
          const children = transformList(node.children);
          transformed = children === node.children ? [node] : [{
            ...node,
            ...(range ? { sourceRange: { ...range } } : {}),
            children,
          }];
        } else if (node.kind === "text" && range) {
          const inside = candidates.filter(
            (candidate) => !resolved.has(candidate) && candidate.from >= range.from && candidate.to <= range.to,
          );
          transformed = inside.length > 0 ? splitTextNode(node, range, inside) ?? [node] : [node];
        } else {
          transformed = [node];
        }
      }
      if (!result && (transformed.length !== 1 || transformed[0] !== node)) {
        result = values.slice(0, index);
      }
      if (result) result.push(...transformed);
    }

    let current = result ?? values as InlineNode[];
    for (const candidate of candidates) {
      if (resolved.has(candidate)) continue;
      let first = -1;
      let last = -1;
      for (let index = 0; index < current.length; index++) {
        const range = current[index].sourceRange;
        if (!range || range.to <= candidate.from || range.from >= candidate.to) continue;
        if (first < 0) first = index;
        last = index;
      }
      if (first < 0 || first === last) continue;
      const firstNode = current[first];
      const lastNode = current[last];
      const firstRange = firstNode.sourceRange;
      const lastRange = lastNode.sourceRange;
      if (!firstRange || !lastRange || candidate.from < firstRange.from || candidate.to > lastRange.to) continue;
      const firstLocal = firstRange.from < candidate.from
        ? localRangeForSourceRange(firstRange.from, firstRange.to)
        : undefined;
      const lastLocal = candidate.to < lastRange.to
        ? localRangeForSourceRange(lastRange.from, lastRange.to)
        : undefined;
      if (firstRange.from < candidate.from &&
          (firstNode.kind !== "text" || !firstLocal || rawSource.slice(firstLocal.from, firstLocal.to) !== firstNode.text ||
            candidate.localFrom <= firstLocal.from || candidate.localFrom >= firstLocal.to)) continue;
      if (candidate.to < lastRange.to &&
          (lastNode.kind !== "text" || !lastLocal || rawSource.slice(lastLocal.from, lastLocal.to) !== lastNode.text ||
            candidate.localTo <= lastLocal.from || candidate.localTo >= lastLocal.to)) continue;
      let fullyCovered = true;
      for (let index = first + 1; index < last; index++) {
        const range = current[index].sourceRange;
        if (!range || range.from < candidate.from || range.to > candidate.to) {
          fullyCovered = false;
          break;
        }
      }
      if (!fullyCovered) continue;

      const replacement: InlineNode[] = [];
      if (firstLocal) {
        const beforeRange = sourceRangeForLocalRange(firstLocal.from, candidate.localFrom);
        if (!beforeRange) continue;
        replacement.push({ kind: "text", text: rawSource.slice(firstLocal.from, candidate.localFrom), sourceRange: beforeRange });
      }
      replacement.push(trustedNode(candidate));
      if (lastLocal) {
        const afterRange = sourceRangeForLocalRange(candidate.localTo, lastLocal.to);
        if (!afterRange) continue;
        replacement.push({ kind: "text", text: rawSource.slice(candidate.localTo, lastLocal.to), sourceRange: afterRange });
      }
      current = [...current.slice(0, first), ...replacement, ...current.slice(last + 1)];
      resolved.add(candidate);
    }
    return current;
  };

  return transformList(nodes);
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
  const customAllowed = options?.allowedTags ? Object.keys(options.allowedTags) : undefined;
  const htmlAllowTags = normalizeHtmlAllowlist(options?.html?.allowTags, customAllowed);
  const sanitizeOptions =
    options?.allowedTags || options?.html?.allowedTags
      ? { allowedTags: options.allowedTags ?? options.html?.allowedTags }
      : undefined;
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
    let backslashes = 0;
    for (let i = start - 1; i >= 0 && source[i] === "\\"; i--) {
      backslashes++;
    }
    if (backslashes % 2 !== 0) {
      tagPattern.lastIndex = start + 1;
      match = tagPattern.exec(source);
      continue;
    }
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
          context: mixedSurfaceContext(baseLookaheadContext, "mdx"),
        });
        if (anticipated.prepared.kind !== "parse") {
          tagPattern.lastIndex = start + 1;
          match = tagPattern.exec(source);
          continue;
        }
        if (start > cursor) {
          const absoluteFrom = baseIsFinite ? (baseOffset as number) + cursor : undefined;
          const absoluteTo = baseIsFinite ? (baseOffset as number) + start : undefined;
          pushTextSegment(segments, source.slice(cursor, start), absoluteFrom, absoluteTo, parseInline, baseLookaheadContext);
        }
        const repaired = anticipated.prepared.content;
        segments.push({
          kind: "mdx",
          value: repaired,
          range: createSegmentRange(baseOffset, start, end),
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
            context: mixedSurfaceContext(baseLookaheadContext, "html"),
          });
          if (anticipated.prepared.kind === "parse") {
            if (start > cursor) {
              const absoluteFrom = baseIsFinite ? (baseOffset as number) + cursor : undefined;
              const absoluteTo = baseIsFinite ? (baseOffset as number) + start : undefined;
              pushTextSegment(segments, source.slice(cursor, start), absoluteFrom, absoluteTo, parseInline, baseLookaheadContext);
            }
            const closedValue = anticipated.prepared.content;
            const segment: MixedContentSegment = {
              kind: "html",
              value: closedValue,
              range: createSegmentRange(baseOffset, start, source.length),
              sanitized: sanitizeHtmlInWorker(closedValue, sanitizeOptions),
              lookahead: anticipated.trace,
            };
            setSegmentRange(segment, createSegmentRange(baseOffset, start, source.length));
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
      pushTextSegment(segments, source.slice(cursor, start), absoluteFrom, absoluteTo, parseInline, baseLookaheadContext);
    }

    let rawSegment = source.slice(start, end);
    const kind: MixedContentSegment["kind"] = mdxAllowed ? "mdx" : "html";
    const segment: MixedContentSegment = {
      kind,
      value: rawSegment,
    };
    setSegmentRange(segment, createSegmentRange(baseOffset, start, end));
    if (kind === "html") {
      segment.sanitized = sanitizeHtmlInWorker(rawSegment, sanitizeOptions);
    } else {
      const closingTagPattern = new RegExp(`</\\s*${escapeRegExp(tagName)}\\s*>\\s*$`, "i");
      const hasExplicitClose = closingTagPattern.test(rawSegment);
      if (mdxAutoClose && !hasExplicitClose && !rawSegment.endsWith("/>")) {
        const anticipated = prepareSurfaceLookahead("mdx-tag", rawSegment, {
          allowComponents: mdxAllowlist ?? undefined,
          maxNewlines: mdxMaxNewlines,
          context: mixedSurfaceContext(baseLookaheadContext, "mdx"),
        });
        if (anticipated.prepared.kind === "parse") {
          rawSegment = anticipated.prepared.content;
          segment.value = rawSegment;
          segment.lookahead = anticipated.trace;
        }
      }
    }
    segments.push(segment);
    cursor = end;
    tagPattern.lastIndex = end;
    match = tagPattern.exec(source);
  }

  if (cursor < source.length) {
    const absoluteFrom = baseIsFinite ? (baseOffset as number) + cursor : undefined;
    const absoluteTo = baseIsFinite ? (baseOffset as number) + source.length : undefined;
    pushTextSegment(segments, source.slice(cursor), absoluteFrom, absoluteTo, parseInline, baseLookaheadContext);
  }

  return segments;
}

function splitTextSegmentByExpressions(segment: MixedContentSegment, parseInline: (content: string) => InlineNode[], options?: MixedContentOptions): MixedContentSegment[] {
  if (segment.kind !== "text" || !segment.value) {
    return [segment];
  }
  const { value } = segment;
  if (isLikelyMathSegment(value)) {
    return [segment];
  }
  const hasRange = segment.range && typeof segment.range.from === "number" && typeof segment.range.to === "number";
  const rangeStart = hasRange ? segment.range?.from : undefined;
  const context = options?.lookaheadContext;
  const protectedRanges = options?.protectedRanges ?? [];
  const protectedKinds = protectedRanges.length
    ? new Set<ProtectedRange["kind"]>(options?.protectedRangeKinds ?? ["math-inline", "math-display", "code-inline", "code-block", "autolink"])
    : null;
  const exprPattern = /\{[^{}]+\}/g;
  const results: MixedContentSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = exprPattern.exec(value);
  if (match === null) return [segment];

  while (match !== null) {
    const start = match.index;
    const end = exprPattern.lastIndex;
    let precedingBackslashes = 0;
    for (let slashIndex = start - 1; slashIndex >= 0 && value[slashIndex] === "\\"; slashIndex--) {
      precedingBackslashes++;
    }
    if (precedingBackslashes % 2 !== 0) {
      match = exprPattern.exec(value);
      continue;
    }
    const absoluteStart = (rangeStart ?? 0) + start;
    const absoluteEnd = (rangeStart ?? 0) + end;
    if (protectedKinds && protectedRanges.some((range) => protectedKinds.has(range.kind) && range.from <= absoluteStart && range.to >= absoluteEnd)) {
      match = exprPattern.exec(value);
      continue;
    }
    if (start > cursor) {
      const textValue = value.slice(cursor, start);
      results.push(
        buildTextSegmentWithExpressionLookahead(textValue, createSegmentRange(rangeStart, cursor, start), parseInline, context),
      );
    }
    const expressionValue = match[0];
    const expressionSegment: MixedContentSegment = {
      kind: "mdx",
      value: expressionValue,
    };
    setSegmentRange(expressionSegment, createSegmentRange(rangeStart, start, end));
    results.push(expressionSegment);
    cursor = end;
    match = exprPattern.exec(value);
  }
  if (results.length === 0) return [segment];

  if (cursor < value.length) {
    const textValue = value.slice(cursor);
    results.push(
      buildTextSegmentWithExpressionLookahead(textValue, createSegmentRange(rangeStart, cursor, value.length), parseInline, context),
    );
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
  context?: Partial<LookaheadContainerContext>,
): void {
  if (value.length === 0) return;
  target.push(buildTextSegmentWithExpressionLookahead(value, createSegmentRange(from, 0, value.length, to), parseInline, context));
}

function setSegmentRange(segment: MixedContentSegment, range: { from: number; to: number } | undefined): void {
  if (range) {
    segment.range = range;
  }
}

function buildTextSegmentWithExpressionLookahead(
  value: string,
  range: { from: number; to: number } | undefined,
  parseInline: (content: string) => InlineNode[],
  context?: Partial<LookaheadContainerContext>,
): MixedContentSegment {
  const segment: MixedContentSegment = {
    kind: "text",
    value,
    inline: parseInline(value),
  };
  setSegmentRange(segment, range);
  const expressionStart = findTrailingMdxExpressionStart(value);
  if (expressionStart === -1) {
    return segment;
  }
  const rawCandidate = value.slice(expressionStart);
  const anticipated = prepareSurfaceLookahead("mdx-expression", rawCandidate, {
    context: mixedSurfaceContext(context, "mdx", "mixed-text-mdx-expression-tail"),
  });
  if (anticipated.trace.length > 0) {
    segment.lookahead = anticipated.trace;
  }
  return segment;
}

function findTrailingMdxExpressionStart(value: string): number {
  let openIndex = -1;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        openIndex = i;
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) {
          openIndex = -1;
        }
      }
    }
  }
  return depth > 0 ? openIndex : -1;
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

function normalizeHtmlAllowlist(value: Iterable<string> | undefined, additional?: Iterable<string>): Set<string> {
  const tags = new Set<string>(DEFAULT_INLINE_HTML_AUTOCLOSE_TAGS);
  if (value) {
    for (const tag of value) {
      if (tag) tags.add(tag.toLowerCase());
    }
  }
  if (additional) {
    for (const tag of additional) {
      if (tag) tags.add(tag.toLowerCase());
    }
  }
  return tags;
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
