declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

import {
  AppendSourceDocument,
  createCodeLineIndex,
  createSourceWindow,
  extractCodeLines,
  extractHighlightedLines,
  type Block,
  type CodeBlockSnapshot,
  type CodeBlockSourceMetadata,
  type CodeLineDecoration,
  type CodeLineDecorationUpdate,
  type CodeLineIndex,
  type CodeLineRecord,
  type CodeTokenLine,
  type CodeTokenSpan,
  type NodeSnapshot,
  type Patch,
  type SourceSnapshot,
  type TokenLineV1,
  type TokenStyle,
} from "@stream-mdx/core";

export interface CodeBlockViewState {
  readonly source: CodeBlockSourceMetadata;
  readonly configurationRevision: number;
  readonly info: string;
  readonly language?: string;
  readonly lines: CodeLineIndex;
}

export interface StoreCodeCounters {
  recordRecordSlotsAllocated(count: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  recordPrefixComparisons(count: number): void;
  recordSourceUnitsRead(count: number): void;
  recordSourceUnitsMaterialized(count: number): void;
  recordSourceDirectoryEntriesCopied(count: number): void;
}

export interface StoredCodeBlockState {
  readonly view: CodeBlockViewState;
  readonly sourceSnapshot: SourceSnapshot;
  readonly document?: AppendSourceDocument;
  readonly managed: boolean;
  readonly ranges: Map<string, { readonly from: number; readonly to: number; readonly lines: readonly CodeLineRecord[] }>;
}

export type AppendCodePatch = Extract<Patch, { op: "appendCode" }>;
export type DecorateCodePatch = Extract<Patch, { op: "decorateCode" }>;

export const CODE_LINE_RANGE_SIZE = 64;

const CODE_RANGE_CACHE_LIMIT = 128;
const TOKEN_FONT_STYLE_ITALIC = 1;
const TOKEN_FONT_STYLE_BOLD = 2;
const TOKEN_FONT_STYLE_UNDERLINE = 4;
const TOKEN_FONT_STYLE_STRIKETHROUGH = 8;

type RawLine = { readonly text: string; readonly from: number; readonly to: number; readonly ending: CodeLineRecord["ending"] };
type ParsedTokenStyle = {
  readonly dark?: TokenStyle;
  readonly light?: TokenStyle;
  readonly single?: TokenStyle;
};


function createIndex(lines: readonly CodeLineRecord[], counters?: StoreCodeCounters): CodeLineIndex {
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    return createCodeLineIndex({
      lines,
      counterStage: "store",
      campaignCounters: counters,
    } as Parameters<typeof createCodeLineIndex>[0]);
  }
  return createCodeLineIndex({ lines });
}

function metadataSnapshot(source: CodeBlockSourceMetadata): CodeBlockSourceMetadata {
  return Object.freeze({
    codeOwnerId: source.codeOwnerId,
    generation: source.generation,
    revision: source.revision,
    state: source.state,
    processedTo: source.processedTo,
    completeLineCount: source.completeLineCount,
    lineCount: source.lineCount,
    sourceRange: Object.freeze({ from: source.sourceRange.from, to: source.sourceRange.to }),
  });
}

function createView(
  source: CodeBlockSourceMetadata,
  configurationRevision: number,
  info: string,
  language: string | undefined,
  lines: CodeLineIndex,
): CodeBlockViewState {
  return Object.freeze({
    source: metadataSnapshot(source),
    configurationRevision,
    info,
    language,
    lines,
  });
}

function assertSourceRange(source: CodeBlockSourceMetadata, rawLength: number): void {
  const { from, to } = source.sourceRange;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to - from !== rawLength
  ) {
    throw new RangeError("Code source range must match its authored UTF-16 source length");
  }
  if (
    !Number.isSafeInteger(source.generation) ||
    source.generation < 0 ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 0 ||
    !Number.isSafeInteger(source.processedTo) ||
    source.processedTo < 0 ||
    !Number.isSafeInteger(source.completeLineCount) ||
    source.completeLineCount < 0 ||
    !Number.isSafeInteger(source.lineCount) ||
    source.lineCount < 0 ||
    source.completeLineCount > source.lineCount ||
    (source.state !== "open" && source.state !== "closed" && source.state !== "finalized")
  ) {
    throw new RangeError("Code source metadata is invalid");
  }
}

function createSourceDocument(raw: string, counters?: StoreCodeCounters): AppendSourceDocument {
  const document = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? new AppendSourceDocument({ counters } as never)
    : new AppendSourceDocument();
  document.append(raw);
  return document;
}
interface SourceStateForRaw {
  readonly sourceSnapshot: SourceSnapshot;
  readonly document?: AppendSourceDocument;
}
function sourceStateForRaw(
  raw: string,
  sourceFrom: number,
  sourceTo: number,
  canonicalSource?: SourceSnapshot,
  counters?: StoreCodeCounters,
): SourceStateForRaw {
  if (canonicalSource) {
    if (
      !Number.isSafeInteger(sourceFrom) ||
      !Number.isSafeInteger(sourceTo) ||
      sourceFrom < 0 ||
      sourceTo < sourceFrom ||
      sourceTo > canonicalSource.length ||
      canonicalSource.read(sourceFrom, sourceTo) !== raw
    ) throw new RangeError("Code source range does not match the canonical input");
    return { sourceSnapshot: createSourceWindow(canonicalSource, sourceFrom, sourceTo) };
  }
  const document = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? createSourceDocument(raw, counters)
    : createSourceDocument(raw);
  return { sourceSnapshot: createSourceWindow(document.snapshot(), 0, raw.length), document };
}

function splitRawLines(raw: string): RawLine[] {
  if (raw.length === 0) return [];
  const lines: RawLine[] = [];
  let start = 0;
  while (start < raw.length) {
    let end = start;
    while (end < raw.length && raw[end] !== "\n" && raw[end] !== "\r") end += 1;
    let ending: CodeLineRecord["ending"] = "";
    if (end < raw.length) {
      if (raw[end] === "\r" && raw[end + 1] === "\n") {
        ending = "\r\n";
      } else {
        ending = raw[end] as "\n" | "\r";
      }
    }
    lines.push({ text: raw.slice(start, end), from: start, to: end, ending });
    start = end + ending.length;
  }
  if (raw.endsWith("\n") || raw.endsWith("\r")) {
    lines.push({ text: "", from: raw.length, to: raw.length, ending: "" });
  }
  return lines;
}

function trimProvisionalFenceTail(raw: string): string {
  if (raw.endsWith("\n")) return raw;
  const opening = raw.match(/^ {0,3}(`{3,}|~{3,})[^\n]*\n/);
  if (!opening) return raw;
  const lastNewline = raw.lastIndexOf("\n");
  const tail = raw.slice(lastNewline + 1).match(/^ {0,3}(`+|~+)[\t ]*$/);
  return tail && tail[1][0] === opening[1][0] && tail[1].length < opening[1].length
    ? raw.slice(0, lastNewline)
    : raw;
}
function sourceBodyLines(raw: string): { lines: RawLine[]; hasClosingFence: boolean } {
  const physical = splitRawLines(raw);
  const first = physical[0]?.text.match(/^( {0,3})(`{3,}|~{3,})/);
  if (!first) {
    const isIndented = /^ {4}/m.test(raw);
    if (!isIndented) return { lines: physical, hasClosingFence: false };
    return {
      lines: physical.map((line) => {
        let removed = 0;
        while (removed < 4 && line.text[removed] === " ") removed += 1;
        if (removed === 4) {
          return { ...line, from: line.from + removed, text: line.text.slice(removed) };
        }
        return line;
      }),
      hasClosingFence: false,
    };
  }

  const marker = first[2][0] === "`" ? "`" : "~";
  const width = first[2].length;
  const close = new RegExp(`^ {0,3}${marker === "`" ? "\\`" : "~"}{${width},}[\\t ]*$`);
  let closeIndex = -1;
  for (let index = physical.length - 1; index > 0; index -= 1) {
    if (close.test(physical[index]?.text ?? "")) {
      closeIndex = index;
      break;
    }
  }
  const end = closeIndex === -1 ? physical.length : closeIndex;
  const lines = physical.slice(1, end).map((line) => {
    let removed = 0;
    while (removed < first[1].length && line.text[removed] === " ") removed += 1;
    return removed === 0 ? line : { ...line, from: line.from + removed, text: line.text.slice(removed) };
  });
  return { lines, hasClosingFence: closeIndex !== -1 };
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function mergeTokenStyles(parent: ParsedTokenStyle | undefined, next: ParsedTokenStyle): ParsedTokenStyle {
  if (!parent) return next;
  return {
    dark: parent.dark || next.dark ? { ...parent.dark, ...next.dark } : undefined,
    light: parent.light || next.light ? { ...parent.light, ...next.light } : undefined,
    single: parent.single || next.single ? { ...parent.single, ...next.single } : undefined,
  };
}

function parseColor(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized || /[<>"'`]/.test(normalized)) return undefined;
  if (/^#[\da-f]{3,8}$/i.test(normalized)) return normalized;
  if (/^(?:rgb|rgba|hsl|hsla)\([\d\s.,%/+-]+\)$/i.test(normalized)) return normalized;
  if (/^[a-z]{1,24}$/i.test(normalized)) return normalized;
  return undefined;
}

function styleFromTag(tag: string): ParsedTokenStyle {
  const styleMatch = tag.match(/\bstyle\s*=\s*(["'])(.*?)\1/i);
  if (!styleMatch) return {};
  const values = new Map<string, string>();
  for (const declaration of styleMatch[2].split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    values.set(declaration.slice(0, colon).trim().toLowerCase(), decodeHtmlText(declaration.slice(colon + 1).trim()));
  }
  const dark: TokenStyle = {};
  const light: TokenStyle = {};
  const single: TokenStyle = {};
  const darkFg = parseColor(values.get("--shiki-dark") ?? "");
  const lightFg = parseColor(values.get("--shiki-light") ?? "");
  const darkBg = parseColor(values.get("--shiki-dark-bg") ?? "");
  const lightBg = parseColor(values.get("--shiki-light-bg") ?? "");
  const fg = parseColor(values.get("color") ?? "");
  const bg = parseColor(values.get("background-color") ?? "");
  if (darkFg) dark.fg = darkFg;
  if (lightFg) light.fg = lightFg;
  if (darkBg) dark.bg = darkBg;
  if (lightBg) light.bg = lightBg;
  if (fg) single.fg = fg;
  if (bg) single.bg = bg;
  let fontStyle = 0;
  if (values.get("font-style")?.toLowerCase().includes("italic")) fontStyle |= TOKEN_FONT_STYLE_ITALIC;
  const weight = values.get("font-weight")?.toLowerCase();
  if (weight === "bold" || (Number(weight) >= 600 && Number(weight) <= 900)) fontStyle |= TOKEN_FONT_STYLE_BOLD;
  const decorations = values.get("text-decoration")?.toLowerCase() ?? "";
  if (decorations.includes("underline")) fontStyle |= TOKEN_FONT_STYLE_UNDERLINE;
  if (decorations.includes("line-through")) fontStyle |= TOKEN_FONT_STYLE_STRIKETHROUGH;
  if (fontStyle > 0) {
    dark.fs = fontStyle;
    light.fs = fontStyle;
    single.fs = fontStyle;
  }
  return {
    dark: Object.keys(dark).length > 0 ? dark : undefined,
    light: Object.keys(light).length > 0 ? light : undefined,
    single: Object.keys(single).length > 0 ? single : undefined,
  };
}

function tokenLineFromHtml(html: string, expectedText: string): CodeTokenLine | undefined {
  const spans: CodeTokenSpan[] = [];
  const styles: Array<ParsedTokenStyle | undefined> = [];
  let text = "";
  const parts = html.match(/<[^>]*>|[^<]+/g) ?? [];
  for (const part of parts) {
    if (part[0] === "<") {
      if (/^<\s*\//.test(part)) {
        if (styles.length > 0) styles.pop();
      } else if (!/^<\s*!/.test(part) && !/^<\s*\?/.test(part) && !/\/\s*>$/.test(part)) {
        const own = styleFromTag(part);
        styles.push(mergeTokenStyles(styles[styles.length - 1], own));
      }
      continue;
    }
    const value = decodeHtmlText(part);
    if (!value) continue;
    text += value;
    const active = styles[styles.length - 1];
    const span: CodeTokenSpan = {
      t: value,
      ...(active?.dark || active?.light ? { v: { dark: active.dark, light: active.light } } : {}),
      ...(active?.single ? { s: active.single } : {}),
    };
    const prior = spans[spans.length - 1];
    if (prior && JSON.stringify({ v: prior.v, s: prior.s }) === JSON.stringify({ v: span.v, s: span.s })) {
      spans[spans.length - 1] = { ...prior, t: prior.t + span.t };
    } else {
      spans.push(span);
    }
  }
  return text === expectedText && spans.length > 0 ? { spans } : undefined;
}

function legacyDecoration(
  tokens: TokenLineV1 | CodeTokenLine | null | undefined,
  html: unknown,
  expectedText: string,
  index: number,
  lineId: string,
  configurationRevision: number,
  sourceRevision = 0,
): CodeLineDecoration | undefined {
  const normalized = tokens && Array.isArray(tokens.spans)
    ? (tokens as CodeTokenLine)
    : typeof html === "string" && html.includes("<")
      ? tokenLineFromHtml(html, expectedText)
      : undefined;
  if (!normalized) return undefined;
  return {
    index,
    lineId,
    sourceRevision,
    configurationRevision,
    exactness: "exact",
    tokens: normalized,
  };
}
function withLegacyDecoration(
  line: CodeLineRecord,
  decoration: CodeLineDecoration | undefined,
): CodeLineRecord {
  if (decoration !== undefined) return { ...line, decoration };
  const { decoration: previousDecoration, ...undecorated } = line;
  return previousDecoration === undefined &&
    !Object.prototype.hasOwnProperty.call(line, "decoration")
    ? line
    : undecorated;
}

function legacyCodeState(
  snapshot: NodeSnapshot,
  block: Block | undefined,
  canonicalSource?: SourceSnapshot,
  counters?: StoreCodeCounters,
): StoredCodeBlockState {
  const raw = block?.payload.raw ?? (typeof snapshot.props?.raw === "string" ? snapshot.props.raw : typeof snapshot.props?.text === "string" ? snapshot.props.text : "");
  const sourceFrom = snapshot.range?.from ?? block?.payload.range?.from ?? 0;
  const sourceTo = sourceFrom + raw.length;
  const sourceText = block?.isFinalized ? raw : trimProvisionalFenceTail(raw);
  const body = sourceBodyLines(sourceText);
  const childLines = Array.isArray(snapshot.children) ? snapshot.children.filter((child) => child.type === "code-line") : [];
  const extracted = childLines.length > 0
    ? childLines.map((child) => typeof child.props?.text === "string" ? child.props.text : "")
    : extractCodeLines(sourceText);
  const meta = block?.payload.meta;
  const tokenLines = Array.isArray(meta?.tokenLines) ? meta.tokenLines as Array<TokenLineV1 | null> : [];
  const highlightedLines = typeof block?.payload.highlightedHtml === "string"
    ? extractHighlightedLines(block.payload.highlightedHtml, extracted.length)
    : [];
  const configurationRevision = Number.isSafeInteger(meta?.configurationRevision) && Number(meta?.configurationRevision) >= 0
    ? Number(meta?.configurationRevision)
    : 0;
  const lines: CodeLineRecord[] = extracted.map((text, index) => {
    const rawLine = body.lines[index];
    const lineId = childLines[index]?.id ?? `${snapshot.id}::line:${index}`;
    const decoration = legacyDecoration(
      tokenLines[index] ?? (childLines[index]?.props?.tokens as TokenLineV1 | null | undefined),
      childLines[index]?.props?.html ?? highlightedLines[index],
      text,
      index,
      lineId,
      configurationRevision,
    );
    return {
      id: lineId,
      index,
      text,
      ending: rawLine?.ending ?? (index + 1 < extracted.length ? "\n" : ""),
      sourceRange: rawLine
        ? { from: sourceFrom + rawLine.from, to: sourceFrom + rawLine.to }
        : { from: sourceTo, to: sourceTo },
      sourceRevision: 0,
      isProvisional: !block?.isFinalized && !body.hasClosingFence && index === extracted.length - 1 && rawLine?.ending === "",
      decoration,
      diffKind: childLines[index]?.props?.diffKind as CodeLineRecord["diffKind"],
      oldNo: childLines[index]?.props?.oldNo as CodeLineRecord["oldNo"],
      newNo: childLines[index]?.props?.newNo as CodeLineRecord["newNo"],
    };
  });
  const index = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? createIndex(lines, counters)
    : createIndex(lines);
  const state: "open" | "closed" | "finalized" = block?.isFinalized
    ? "finalized"
    : body.hasClosingFence
      ? "closed"
      : "open";
  const source: CodeBlockSourceMetadata = {
    codeOwnerId: snapshot.id,
    generation: 0,
    revision: 0,
    state,
    processedTo: sourceTo,
    completeLineCount: index.completeLineCount,
    lineCount: index.length,
    sourceRange: { from: sourceFrom, to: sourceTo },
  };
  const sourceState = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? sourceStateForRaw(raw, sourceFrom, sourceTo, canonicalSource, counters)
    : sourceStateForRaw(raw, sourceFrom, sourceTo, canonicalSource);
  const view = createView(
    source,
    configurationRevision,
    typeof snapshot.props?.info === "string" ? snapshot.props.info : typeof meta?.info === "string" ? meta.info : "",
    typeof snapshot.props?.language === "string"
      ? snapshot.props.language
      : typeof snapshot.props?.lang === "string"
        ? snapshot.props.lang
        : typeof meta?.lang === "string"
          ? meta.lang
          : undefined,
    index,
  );
  return { view, ...sourceState, managed: false, ranges: new Map() };
}

export function createStoredCodeBlockState(
  snapshot: NodeSnapshot,
  block: Block | undefined,
  canonicalSource?: SourceSnapshot,
  counters?: StoreCodeCounters,
): StoredCodeBlockState {
  if (snapshot.code === undefined) {
    return typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? legacyCodeState(snapshot, block, canonicalSource, counters)
      : legacyCodeState(snapshot, block, canonicalSource);
  }
  const cold = snapshot.code as CodeBlockSnapshot;
  if (typeof cold.raw !== "string" || cold.codeOwnerId !== snapshot.id) {
    throw new TypeError("Code snapshot owner and raw source must match its node");
  }
  assertSourceRange(cold, cold.raw.length);
  if (!Number.isSafeInteger(cold.configurationRevision) || cold.configurationRevision < 0) {
    throw new RangeError("Code snapshot configuration revision is invalid");
  }
  const index = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? createIndex(cold.lines, counters)
    : createIndex(cold.lines);
  if (index.length !== cold.lineCount || index.completeLineCount !== cold.completeLineCount) {
    throw new RangeError("Code snapshot line counts do not match its line records");
  }
  for (let lineIndex = 0; lineIndex < cold.lines.length; lineIndex += 1) {
    const line = cold.lines[lineIndex];
    if (!line || line.index !== lineIndex || line.sourceRange.from < cold.sourceRange.from || line.sourceRange.to > cold.sourceRange.to) {
      throw new RangeError("Code snapshot line ranges must be inside its source range");
    }
  }
  const sourceState = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? sourceStateForRaw(
        cold.raw,
        cold.sourceRange.from,
        cold.sourceRange.to,
        canonicalSource,
        counters,
      )
    : sourceStateForRaw(cold.raw, cold.sourceRange.from, cold.sourceRange.to, canonicalSource);
  return {
    view: createView(cold, cold.configurationRevision, cold.info, cold.language, index),
    ...sourceState,
    managed: true,
    ranges: new Map(),
  };
}

function nextRangesForAppend(
  ranges: Map<string, { readonly from: number; readonly to: number; readonly lines: readonly CodeLineRecord[] }>,
  fromLine: number,
) {
  const next = new Map<string, { readonly from: number; readonly to: number; readonly lines: readonly CodeLineRecord[] }>();
  for (const [key, range] of ranges) {
    if (range.to <= fromLine) next.set(key, range);
  }
  return next;
}

export function appendStoredCodeState(
  current: StoredCodeBlockState,
  patch: AppendCodePatch,
  canonicalSource?: SourceSnapshot,
): { readonly state?: StoredCodeBlockState; readonly reason?: string } {
  if (!current.managed) return { reason: "owner is not source-managed" };
  const old = current.view.source;
  if (
    patch.code.codeOwnerId !== old.codeOwnerId ||
    patch.code.generation !== old.generation ||
    patch.expectedRevision !== old.revision
  ) {
    return { reason: "owner, generation, or expected revision mismatch" };
  }
  if (!Array.isArray(patch.lines) || typeof patch.sourceAppend !== "string") return { reason: "append payload is invalid" };
  if (old.state !== "open" && (
    old.state !== "closed" ||
    patch.code.state !== "finalized" ||
    patch.sourceAppend !== "" ||
    patch.lines.length !== 0 ||
    patch.code.processedTo !== old.processedTo ||
    patch.code.lineCount !== old.lineCount ||
    patch.code.completeLineCount !== old.completeLineCount
  )) return { reason: "source owner is no longer open" };
  if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 0 || old.revision >= Number.MAX_SAFE_INTEGER) {
    return { reason: "source revision is invalid" };
  }
  if (patch.code.revision !== patch.expectedRevision + 1) return { reason: "next source revision is not consecutive" };
  if (patch.fromLine !== old.completeLineCount) return { reason: "changed tail does not start at the completed prefix" };
  if (patch.code.sourceRange.from !== old.sourceRange.from) return { reason: "source range start changed" };
  if (patch.code.sourceRange.to !== old.sourceRange.to + patch.sourceAppend.length) return { reason: "source append length does not match the new range" };
  if (patch.code.processedTo < old.processedTo) return { reason: "processed source frontier moved backwards" };
  if (patch.code.completeLineCount < old.completeLineCount) return { reason: "completed prefix moved backwards" };
  if (patch.code.lineCount !== patch.fromLine + patch.lines.length) return { reason: "changed tail line count does not match metadata" };
  try {
    if (canonicalSource) {
      if (canonicalSource.read(old.sourceRange.to, patch.code.sourceRange.to) !== patch.sourceAppend) {
        return { reason: "authored source suffix does not match the canonical input" };
      }
      assertSourceRange(patch.code, patch.code.sourceRange.to - patch.code.sourceRange.from);
    } else {
      if (!current.document) return { reason: "cold code source document is unavailable" };
      assertSourceRange(patch.code, current.document.length + patch.sourceAppend.length);
    }
    const nextLines = current.view.lines.replaceTail(patch.fromLine, patch.lines);
    if (nextLines.length !== patch.code.lineCount || nextLines.completeLineCount !== patch.code.completeLineCount) {
      return { reason: "changed tail records do not match metadata counts" };
    }
    for (const line of patch.lines) {
      if (line.sourceRange.from < patch.code.sourceRange.from || line.sourceRange.to > patch.code.sourceRange.to) {
        return { reason: "changed tail line range is outside the updated source range" };
      }
    }
    if (!canonicalSource && patch.sourceAppend.length > 0) current.document!.append(patch.sourceAppend);
    const sourceSnapshot = canonicalSource
      ? patch.code.sourceRange.to === old.sourceRange.to
        ? current.sourceSnapshot
        : createSourceWindow(canonicalSource, patch.code.sourceRange.from, patch.code.sourceRange.to)
      : current.document
        ? createSourceWindow(current.document.snapshot(), 0, current.document.length)
        : current.sourceSnapshot;
    const nextState: StoredCodeBlockState = {
      view: createView(patch.code, current.view.configurationRevision, current.view.info, current.view.language, nextLines),
      sourceSnapshot,
      document: canonicalSource ? undefined : current.document,
      managed: true,
      ranges: nextRangesForAppend(current.ranges, patch.fromLine),
    };
    return { state: nextState };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : "append validation failed" };
  }
}
export type AppendLinesPatch = Extract<Patch, { op: "appendLines" }>;

export function appendLegacyCodeState(
  current: StoredCodeBlockState,
  patch: AppendLinesPatch,
): { readonly state?: StoredCodeBlockState; readonly reason?: string } {
  if (current.managed) return { reason: "legacy appendLines cannot mutate a source-managed owner" };
  if (current.view.source.state === "finalized") return { reason: "legacy code owner is finalized" };
  if (!Array.isArray(patch.lines) || patch.lines.length === 0 || patch.startIndex !== current.view.lines.length) {
    return { reason: "legacy appendLines must extend the indexed tail" };
  }
  const old = current.view.source;
  if (old.revision >= Number.MAX_SAFE_INTEGER) return { reason: "legacy source revision exceeds the safe integer range" };
  const revision = old.revision + 1;
  const lines: CodeLineRecord[] = patch.lines.map((text, offset) => {
    const index = patch.startIndex + offset;
    const lineId = `${old.codeOwnerId}::line:${index}`;
    const tokens = patch.tokens?.[offset] ?? null;
    return {
      id: lineId,
      index,
      text,
      ending: offset + 1 < patch.lines.length ? "\n" : "",
      sourceRange: { from: old.sourceRange.to, to: old.sourceRange.to },
      sourceRevision: revision,
      isProvisional: false,
      decoration: legacyDecoration(
        tokens,
        patch.highlight?.[offset],
        text,
        index,
        lineId,
        current.view.configurationRevision,
        revision,
      ),
      diffKind: patch.diffKind?.[offset] ?? undefined,
      oldNo: patch.oldNo?.[offset] ?? undefined,
      newNo: patch.newNo?.[offset] ?? undefined,
    };
  });
  try {
    const currentLines = current.view.lines;
    const previousTail = currentLines.get(currentLines.length - 1);
    const appendBase = previousTail?.isProvisional
      ? currentLines.replaceTail(previousTail.index, [{ ...previousTail, isProvisional: false }])
      : currentLines;
    const index = appendBase.replaceTail(patch.startIndex, lines);
    const source: CodeBlockSourceMetadata = {
      ...old,
      revision,
      completeLineCount: index.completeLineCount,
      lineCount: index.length,
    };
    return {
      state: {
        view: createView(source, current.view.configurationRevision, current.view.info, current.view.language, index),
        sourceSnapshot: current.sourceSnapshot,
        document: current.document,
        managed: false,
        ranges: nextRangesForAppend(current.ranges, previousTail?.isProvisional ? previousTail.index : patch.startIndex),
      },
    };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : "legacy appendLines validation failed" };
  }
}
export function updateLegacyCodeLineState(
  current: StoredCodeBlockState,
  line: { readonly id: string; readonly index: number; readonly props: Record<string, unknown> },
  allowSemanticEdit = false,
  canonicalSource?: SourceSnapshot,
  counters?: StoreCodeCounters,
): StoredCodeBlockState | undefined {
  if (current.managed || !Number.isSafeInteger(line.index) || line.index < 0) return undefined;
  const previous = current.view.lines.get(line.index);
  if (!previous || previous.id !== line.id) return undefined;

  const text = typeof line.props.text === "string" ? line.props.text : "";
  const textChanged = text !== previous.text;
  const isProvisional = typeof line.props.isProvisional === "boolean"
    ? line.props.isProvisional
    : previous.isProvisional;
  const provisionalChanged = isProvisional !== previous.isProvisional;
  const source = current.view.source;
  const ownerRevision = source.revision + (textChanged ? 1 : 0);
  const sourceRevision = previous.sourceRevision + (textChanged ? 1 : 0);
  if (
    (textChanged && (!Number.isSafeInteger(ownerRevision) || ownerRevision > Number.MAX_SAFE_INTEGER)) ||
    !Number.isSafeInteger(sourceRevision) ||
    sourceRevision > Number.MAX_SAFE_INTEGER
  ) {
    return undefined;
  }

  const decoration = legacyDecoration(
    line.props.tokens as TokenLineV1 | null | undefined,
    line.props.html,
    text,
    line.index,
    line.id,
    current.view.configurationRevision,
    sourceRevision,
  );
  const hasDiffKind = Object.prototype.hasOwnProperty.call(line.props, "diffKind");
  const hasOldNo = Object.prototype.hasOwnProperty.call(line.props, "oldNo");
  const hasNewNo = Object.prototype.hasOwnProperty.call(line.props, "newNo");
  const diffKind = !hasDiffKind
    ? previous.diffKind
    : line.props.diffKind === null
      ? undefined
      : line.props.diffKind as CodeLineRecord["diffKind"];
  const oldNo = hasOldNo ? line.props.oldNo as CodeLineRecord["oldNo"] : previous.oldNo;
  const newNo = hasNewNo ? line.props.newNo as CodeLineRecord["newNo"] : previous.newNo;
  const diffMetadataChanged =
    diffKind !== previous.diffKind || oldNo !== previous.oldNo || newNo !== previous.newNo;

  if (!textChanged) {
    // The store's code-line setProps normalization omits diff metadata, so absent fields are preserved.
    // There is no index operation for metadata-only changes on completed rows; reject such an adapter input.
    if (diffMetadataChanged || (provisionalChanged && line.index !== current.view.lines.length - 1)) return undefined;
    const update: CodeLineDecorationUpdate | undefined = decoration ?? (previous.decoration
      ? {
          index: line.index,
          lineId: line.id,
          sourceRevision,
          configurationRevision: previous.decoration.configurationRevision,
          tokens: null,
        }
      : undefined);
    if (update === undefined && !provisionalChanged) return current;
    const decoratedLines = update === undefined ? current.view.lines : current.view.lines.decorate([update]);
    const updatedLine = decoratedLines.get(line.index) ?? previous;
    let lines = decoratedLines;
    if (provisionalChanged) {
      if (source.state === "open") {
        lines = current.view.lines.replaceTail(line.index, [{ ...updatedLine, isProvisional }]);
      } else {
        const updatedLines = [
          ...current.view.lines.readRange(0, line.index),
          { ...updatedLine, isProvisional },
        ];
        lines = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
          ? createIndex(updatedLines, counters)
          : createIndex(updatedLines);
      }
    }
    if (lines === current.view.lines) return current;
    const ranges = new Map<string, { readonly from: number; readonly to: number; readonly lines: readonly CodeLineRecord[] }>();
    for (const [key, range] of current.ranges) {
      if (line.index < range.from || line.index >= range.to) ranges.set(key, range);
    }
    const nextSource = provisionalChanged
      ? { ...source, completeLineCount: lines.completeLineCount, lineCount: lines.length }
      : source;
    return {
      view: createView(nextSource, current.view.configurationRevision, current.view.info, current.view.language, lines),
      sourceSnapshot: current.sourceSnapshot,
      document: current.document,
      managed: false,
      ranges,
    };
  }

  if (
    source.state !== "finalized" &&
    !allowSemanticEdit &&
    (
      line.index !== current.view.lines.length - 1 ||
      (source.state === "open" && (
        !previous.isProvisional ||
        line.index !== current.view.lines.completeLineCount
      ))
    )
  ) {
    return undefined;
  }

  if (!current.document && !canonicalSource) return undefined;
  const raw = current.document
    ? current.document.snapshot().materialize()
    : current.sourceSnapshot.materialize();
  const relativeFrom = previous.sourceRange.from - source.sourceRange.from;
  const relativeTo = previous.sourceRange.to - source.sourceRange.from;
  if (
    source.sourceRange.to !== source.sourceRange.from + raw.length ||
    relativeFrom < 0 ||
    relativeTo > raw.length ||
    relativeTo < relativeFrom ||
    raw.slice(relativeFrom, relativeTo) !== previous.text ||
    (canonicalSource && (
      source.sourceRange.to > canonicalSource.length ||
      canonicalSource.read(source.sourceRange.from, source.sourceRange.to) !== raw
    ))
  ) {
    return undefined;
  }

  const nextRaw = `${raw.slice(0, relativeFrom)}${text}${raw.slice(relativeTo)}`;
  const nextSourceTo = source.sourceRange.to + text.length - previous.text.length;
  const updated = withLegacyDecoration(
    {
      ...previous,
      text,
      sourceRevision,
      sourceRange: { from: previous.sourceRange.from, to: previous.sourceRange.from + text.length },
      isProvisional,
      diffKind,
      oldNo,
      newNo,
    },
    decoration,
  );
  const delta = text.length - previous.text.length;
  const allLines = current.view.lines.readRange(0, current.view.lines.length);
  const replacesOpenTail = source.state === "open" &&
    line.index === current.view.lines.length - 1 &&
    previous.isProvisional &&
    line.index === current.view.lines.completeLineCount;
  let lines: CodeLineIndex;
  if (replacesOpenTail) {
    lines = current.view.lines.replaceTail(line.index, [updated]);
  } else {
    const updatedLines = allLines.map((record) => {
      if (record.index < line.index || delta === 0) return record.index === line.index ? updated : record;
      if (record.index === line.index) return updated;
      return {
        ...record,
        sourceRange: { from: record.sourceRange.from + delta, to: record.sourceRange.to + delta },
      };
    });
    lines = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? createIndex(updatedLines, counters)
      : createIndex(updatedLines);
  }
  const nextSource: CodeBlockSourceMetadata = {
    ...source,
    revision: ownerRevision,
    processedTo: nextSourceTo,
    completeLineCount: lines.completeLineCount,
    lineCount: lines.length,
    sourceRange: { from: source.sourceRange.from, to: nextSourceTo },
  };
  let nextSourceState: SourceStateForRaw;
  try {
    nextSourceState = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? sourceStateForRaw(nextRaw, nextSource.sourceRange.from, nextSourceTo, canonicalSource, counters)
      : sourceStateForRaw(nextRaw, nextSource.sourceRange.from, nextSourceTo, canonicalSource);
  } catch {
    return undefined;
  }
  return {
    view: createView(
      nextSource,
      current.view.configurationRevision,
      current.view.info,
      current.view.language,
      lines,
    ),
    ...nextSourceState,
    managed: false,
    ranges: nextRangesForAppend(current.ranges, line.index),
  };
}

export function refreshLegacyCodeSource(
  current: StoredCodeBlockState,
  block: Block,
  canonicalSource?: SourceSnapshot,
  counters?: StoreCodeCounters,
): StoredCodeBlockState {
  if (current.managed) return current;
  const raw = block.payload.raw;
  const sourceFrom = block.payload.range?.from ?? current.view.source.sourceRange.from;
  const sourceTo = sourceFrom + raw.length;
  const body = sourceBodyLines(raw);
  const metadata = block.payload.meta;
  const source: CodeBlockSourceMetadata = {
    ...current.view.source,
    state: block.isFinalized ? "finalized" : body.hasClosingFence ? "closed" : "open",
    processedTo: sourceTo,
    completeLineCount: current.view.lines.completeLineCount,
    lineCount: current.view.lines.length,
    sourceRange: { from: sourceFrom, to: sourceTo },
  };
  const validatedSourceState = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
    ? sourceStateForRaw(raw, sourceFrom, sourceTo, canonicalSource, counters)
    : sourceStateForRaw(raw, sourceFrom, sourceTo, canonicalSource);
  const sourceState = canonicalSource &&
    current.view.source.sourceRange.from === sourceFrom &&
    current.view.source.sourceRange.to === sourceTo
    ? { sourceSnapshot: current.sourceSnapshot }
    : validatedSourceState;
  return {
    view: createView(
      source,
      current.view.configurationRevision,
      typeof metadata?.info === "string" ? metadata.info : current.view.info,
      typeof metadata?.lang === "string" ? metadata.lang : current.view.language,
      current.view.lines,
    ),
    ...sourceState,
    managed: false,
    ranges: current.ranges,
  };
}
export function finalizeStoredCodeState(current: StoredCodeBlockState): StoredCodeBlockState {
  if (current.view.source.state === "finalized") return current;
  const source: CodeBlockSourceMetadata = { ...current.view.source, state: "finalized" };
  return {
    ...current,
    view: createView(source, current.view.configurationRevision, current.view.info, current.view.language, current.view.lines),
  };
}


export function decorateStoredCodeState(
  current: StoredCodeBlockState,
  patch: DecorateCodePatch,
): {
  readonly state?: StoredCodeBlockState;
  readonly changed: boolean;
  readonly changedIndices?: ReadonlySet<number>;
  readonly reason?: string;
} {
  const old = current.view.source;
  if (
    !current.managed ||
    patch.codeOwnerId !== old.codeOwnerId ||
    patch.generation !== old.generation ||
    patch.configurationRevision !== current.view.configurationRevision
  ) {
    return { changed: false, reason: "owner, generation, or configuration revision mismatch" };
  }
  if (!Array.isArray(patch.decorations)) return { changed: false, reason: "decoration payload is invalid" };
  const valid: CodeLineDecorationUpdate[] = [];
  const changedIndices = new Set<number>();
  for (const decoration of patch.decorations) {
    if (
      !Number.isSafeInteger(decoration.index) ||
      decoration.index < 0 ||
      decoration.configurationRevision !== current.view.configurationRevision
    ) {
      continue;
    }
    const line = current.view.lines.get(decoration.index);
    if (!line || line.id !== decoration.lineId || line.sourceRevision !== decoration.sourceRevision) continue;
    valid.push(decoration);
    if (
      decoration.tokens === null
        ? line.decoration !== undefined && line.decoration.configurationRevision === decoration.configurationRevision
        : line.decoration !== decoration
    ) changedIndices.add(decoration.index);
  }
  if (valid.length === 0) return { state: current, changed: false };
  try {
    const lines = current.view.lines.decorate(valid);
    if (lines === current.view.lines) return { state: current, changed: false };
    const ranges = new Map<string, { readonly from: number; readonly to: number; readonly lines: readonly CodeLineRecord[] }>();
    for (const [key, range] of current.ranges) {
      let intersects = false;
      for (const index of changedIndices) {
        if (index >= range.from && index < range.to) {
          intersects = true;
          break;
        }
      }
      if (!intersects) ranges.set(key, range);
    }
    return {
      state: {
        view: createView(old, current.view.configurationRevision, current.view.info, current.view.language, lines),
        sourceSnapshot: current.sourceSnapshot,
        document: current.document,
        managed: current.managed,
        ranges,
      },
      changed: true,
      changedIndices,
    };
  } catch (error) {
    return { changed: false, reason: error instanceof Error ? error.message : "decoration validation failed" };
  }
}

export function readStoredCodeLines(state: StoredCodeBlockState, from: number, to: number): readonly CodeLineRecord[] {
  const key = `${from}:${to}`;
  const cached = state.ranges.get(key);
  if (cached) {
    state.ranges.delete(key);
    state.ranges.set(key, cached);
    return cached.lines;
  }
  const lines = state.view.lines.readRange(from, to);
  state.ranges.set(key, { from, to, lines });
  if (state.ranges.size > CODE_RANGE_CACHE_LIMIT) {
    const oldest = state.ranges.keys().next().value as string | undefined;
    if (oldest !== undefined) state.ranges.delete(oldest);
  }
  return lines;
}

export function materializeStoredCodeBlock(
  state: StoredCodeBlockState,
  block: Block | undefined,
  id: string,
  props: Record<string, unknown>,
  range?: { readonly from: number; readonly to: number },
): Block {
  const raw = state.sourceSnapshot.materialize();
  const result: Block = block
    ? {
        ...block,
        payload: {
          ...block.payload,
          inline: block.payload.inline,
          meta: block.payload.meta ? { ...block.payload.meta } : undefined,
          range: block.payload.range ? { ...block.payload.range } : undefined,
          raw,
        },
      }
    : {
        id,
        type: "code",
        isFinalized: state.view.source.state !== "open",
        payload: { raw, meta: {} },
      };
  result.id = id;
  result.type = "code";
  result.isFinalized = state.view.source.state !== "open";
  result.payload.raw = raw;
  if (!result.payload.range && (range || state.view.source.sourceRange)) {
    const sourceRange = range ?? state.view.source.sourceRange;
    result.payload.range = { from: sourceRange.from, to: sourceRange.to };
  }
  if (
    result.payload.range &&
    (result.payload.range.from !== state.view.source.sourceRange.from ||
      result.payload.range.to !== state.view.source.sourceRange.to)
  ) {
    result.payload.range = { ...state.view.source.sourceRange };
  }
  const metadata = { ...(result.payload.meta ?? {}) };
  if (state.managed || typeof metadata.code === "string" || block === undefined) {
    metadata.code = state.view.lines.materialize().replace(/\r\n?/g, "\n").replace(/\n$/, "");
  }
  if (state.view.info.length > 0) metadata.info = state.view.info;
  if (state.view.language !== undefined) metadata.lang = state.view.language;
  const rows = state.view.lines.readRange(0, state.view.lines.length);
  const tokenLines = rows.map((line) => line.decoration
    ? { spans: line.decoration.tokens.spans as TokenLineV1["spans"] }
    : null);
  metadata.tokenLines = tokenLines;
  const diffKind = rows.map((line) => line.diffKind ?? null);
  const oldNo = rows.map((line) => line.oldNo ?? null);
  const newNo = rows.map((line) => line.newNo ?? null);
  if (diffKind.some((line) => line !== null)) metadata.diffKind = diffKind;
  if (oldNo.some((line) => line !== null)) metadata.oldNo = oldNo;
  if (newNo.some((line) => line !== null)) metadata.newNo = newNo;
  result.payload.meta = metadata;
  return result;
}
