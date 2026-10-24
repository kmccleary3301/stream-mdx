declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

import type { SyntaxNode, Tree } from "@lezer/common";
import {
  createBlockSnapshot,
  generateBlockId,
  parseCodeFenceInfo,
  type AppendSourceDocument,
  type CodeBlockSnapshot,
  type CodeBlockSourceMetadata,
  type CodeLineDecoration,
  type CodeDiffTokenLine,
  type CodeLineIndex,
  type CodeLineRecord,
  type CodeTokenLine,
  type HighlightUnavailableReason,
  type NodeSnapshot,
  type Patch,
  type SourceSnapshot,
} from "@stream-mdx/core";
import {
  buildDiffTokenLines,
  detectDiffLanguage,
  extractDiffFilePath,
  guessLanguageFromPath,
  isDiffFileBoundary,
  parseDiffHunkHeader,
  parseUnifiedDiffLine,
  renderShikiLines,
  renderTokenLines,
  resolveHighlightLanguage,
  type CodeThemePair,
  type SharedHighlighter,
} from "./highlight";
import {
  RootCodeSourceOwner,
  type CodeSourceChange,
  type RootCodeSourceMetadata,
  type RootCodeSourceOpening,
  type RootCodeSourceOwnerOptions,
} from "./root-code-owner";
import type { CodeEngine, DiffCursorState, DiffLineInfo, ShikiThemedToken } from "./types";

const OPENING_BY_OWNER = new WeakMap<RootCodeSourceOwner, RootCodeSourceOpening>();
const PREPARED_CODE_SOURCE_BY_OWNER = new WeakMap<PreparedCodeLineOwner, PreparedCodeLineSource>();
const NO_ROOT_CODE_OWNERS: readonly RootCodeSourceOwner[] = Object.freeze([]);

export interface PreparedCodeLineOwner {
  readonly id: string;
  getLines(): CodeLineIndex;
  decorateLines(decorations: readonly CodeLineDecoration[]): CodeLineIndex;
}

export interface PreparedCodeLineSource {
  readonly info: string;
  readonly language?: string;
  readonly diff?: boolean;
}

export function registerPreparedCodeLineSource(
  owner: PreparedCodeLineOwner,
  source: PreparedCodeLineSource,
): void {
  PREPARED_CODE_SOURCE_BY_OWNER.set(owner, Object.freeze({ ...source }));
}

function preparedCodeSourceOf(owner: PreparedCodeLineOwner): PreparedCodeLineSource {
  const source = PREPARED_CODE_SOURCE_BY_OWNER.get(owner);
  if (!source) throw new Error(`Prepared code source is unavailable for owner ${owner.id}`);
  return source;
}
function preparedCodeDiffInfo(source: PreparedCodeLineSource): ReturnType<typeof detectDiffLanguage> {
  const { lang, meta } = parseCodeFenceInfo(source.info);
  return detectDiffLanguage(lang, source.diff ? { ...meta, diff: true } : meta);
}

export interface RootCodeHighlightConfiguration {
  readonly highlighter: SharedHighlighter | null;
  readonly codeEngine?: CodeEngine;
  readonly themes: CodeThemePair;
  readonly configurationRevision: number;
  readonly enabled: boolean;
  readonly counters?: {
    recordTokenization(lines: number, units: number, stage?: "engine" | "snapshot" | "patch" | "store" | "view"): void;
  };
}

export interface RootCodePatchChange {
  readonly code: CodeBlockSourceMetadata;
  readonly expectedRevision: number;
  readonly fromLine: number;
  readonly lines: readonly CodeLineRecord[];
  readonly sourceAppend: string;
}

function lineStartAt(source: SourceSnapshot, from: number): number {
  let cursor = from;
  const scanStart = Math.max(0, from - 4);
  while (cursor > scanStart) {
    const previous = source.read(cursor - 1, cursor);
    if (previous === "\n" || previous === "\r") break;
    cursor -= 1;
  }
  return cursor;
}

function openingFor(node: SyntaxNode, source: SourceSnapshot, sourceOffset: number): RootCodeSourceOpening | undefined {
  const nodeFrom = node.from + sourceOffset;
  const lineStart = lineStartAt(source, nodeFrom);
  const line = source.chunk(lineStart);
  let indent = 0;
  while (indent < 4 && line[indent] === " ") indent += 1;
  if (indent > 3) return undefined;
  const from = lineStart + indent;
  if (nodeFrom !== from) return undefined;
  const marker = line[indent];
  if (marker !== "`" && marker !== "~") return undefined;
  let width = 0;
  while (line[indent + width] === marker) width += 1;
  if (width < 3) return undefined;

  const lf = line.indexOf("\n");
  const cr = line.indexOf("\r");
  let endingAt = -1;
  if (lf >= 0 && cr >= 0) endingAt = Math.min(lf, cr);
  else endingAt = Math.max(lf, cr);
  // Lezer line chunks exclude their LF; read that boundary from the authored source.
  if (endingAt < 0) {
    const boundary = lineStart + line.length;
    if (source.read(boundary, Math.min(source.length, boundary + 1)) !== "\n") return undefined;
    endingAt = line.length;
  }
  const endingFrom = lineStart + endingAt;
  const ending = source.read(endingFrom, Math.min(source.length, endingFrom + 2));
  // A CR at the frontier may still become CRLF; like an unterminated opening line, it waits for the next append.
  if (ending === "\r") return undefined;
  const bodyFrom = endingFrom + (ending.startsWith("\r\n") ? 2 : 1);
  const infoNode = node.getChild("CodeInfo");
  const info = infoNode ? source.read(infoNode.from + sourceOffset, infoNode.to + sourceOffset) : "";
  const { lang } = parseCodeFenceInfo(info);
  return {
    from,
    bodyFrom,
    marker,
    width,
    indent,
    info,
    ...(lang ? { language: lang } : {}),
  };
}

/** A Lezer Input window over an immutable document snapshot; offsets are window-relative. */
export class SourceRangeInput implements SourceSnapshot {
  readonly lineChunks: true = true;
  readonly length: number;
  private readonly source: SourceSnapshot;
  private readonly from: number;

  constructor(source: SourceSnapshot, from: number, to = source.length) {
    this.from = Math.max(0, Math.min(source.length, from));
    const end = Math.max(this.from, Math.min(source.length, to));
    this.length = end - this.from;
    this.source = source;
  }

  chunk(from: number): string {
    const start = Math.max(0, Math.min(this.length, from));
    if (start === this.length) return "";
    const chunk = this.source.chunk(this.from + start);
    return chunk.length <= this.length - start ? chunk : chunk.slice(0, this.length - start);
  }

  read(from: number, to: number): string {
    const start = Math.max(0, Math.min(this.length, from));
    const end = Math.max(start, Math.min(this.length, to));
    return this.source.read(this.from + start, this.from + end);
  }
  materialize(): string {
    return this.read(0, this.length);
  }
}

function rootCodeCursorAtSourceStart(
  tree: Tree,
  sourceOffset: number,
  minimumSourceStart: number,
) {
  const position = minimumSourceStart - sourceOffset;
  if (minimumSourceStart > sourceOffset && position >= tree.length) return undefined;
  const cursor = tree.cursor();
  if (minimumSourceStart <= sourceOffset) return cursor.firstChild() ? cursor : undefined;
  cursor.moveTo(position, 1);
  while (cursor.node.parent?.parent) {
    if (!cursor.parent()) return undefined;
  }
  if (!cursor.node.parent && !cursor.childAfter(position)) return undefined;
  while (sourceOffset + cursor.to <= minimumSourceStart) {
    if (!cursor.nextSibling()) return undefined;
  }
  return cursor;
}

/** Admit only top-level native FencedCode nodes and bind each to the authored source. */
export function createRootCodeOwners(
  tree: Tree,
  source: AppendSourceDocument,
  generation: number,
  sourceOffset = 0,
  counters?: RootCodeSourceOwnerOptions["counters"] & {
    readonly recordDocumentRecordsVisited?: (count: number, stage?: "engine") => void;
  },
  excludedSourceStarts?: ReadonlySet<number>,
  existingSourceStarts?: Pick<ReadonlySet<number>, "has">,
  minimumSourceStart = sourceOffset,
): readonly RootCodeSourceOwner[] {
  let reader: SourceSnapshot | undefined;
  let owners: RootCodeSourceOwner[] | undefined;
  const cursor = rootCodeCursorAtSourceStart(tree, sourceOffset, minimumSourceStart);
  if (!cursor) return NO_ROOT_CODE_OWNERS;
  do {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      counters?.recordDocumentRecordsVisited?.(1, "engine");
    }
    const sourceStart = cursor.from + sourceOffset;
    if (cursor.type.name !== "FencedCode"
      || excludedSourceStarts?.has(sourceStart)
      || existingSourceStarts?.has(sourceStart)) continue;
    const opening = openingFor(cursor.node, reader ??= source.snapshot(), sourceOffset);
    if (!opening) continue;
    const id = generateBlockId(`${opening.from}:code`, "code");
    const owner = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? new RootCodeSourceOwner({ id, generation, source, opening, counters })
      : new RootCodeSourceOwner({ id, generation, source, opening });
    OPENING_BY_OWNER.set(owner, opening);
    registerPreparedCodeLineSource(owner, opening);
    if (opening.bodyFrom < source.length) owner.accept(opening.bodyFrom, source.length);
    (owners ??= []).push(owner);
  } while (cursor.nextSibling());
  return owners ?? NO_ROOT_CODE_OWNERS;
}
 
function openingOf(owner: RootCodeSourceOwner): RootCodeSourceOpening {
  const opening = OPENING_BY_OWNER.get(owner);
  if (!opening) throw new Error("Root code opening is unavailable for this owner");
  return opening;
}

export function rootCodeNodeSnapshot(
  owner: RootCodeSourceOwner,
  source: SourceSnapshot,
  configurationRevision: number,
): NodeSnapshot {
  const metadata = owner.getMetadata();
  const opening = openingOf(owner);
  const linesIndex = owner.getLines();
  const code: CodeBlockSnapshot = Object.freeze({
    ...metadata,
    configurationRevision,
    info: opening.info,
    ...(opening.language ? { language: opening.language } : {}),
    lines: linesIndex.readRange(0, linesIndex.length),
    raw: source.read(metadata.sourceRange.from, metadata.sourceRange.to),
  });
  const block = owner.materializeBlock();
  const snapshot = createBlockSnapshot(block);
  return {
    ...snapshot,
    props: {
      ...(snapshot.props ?? {}),
      info: opening.info,
      ...(opening.language ? { language: opening.language } : {}),
    },
    range: { ...metadata.sourceRange },
    code,
  };
}

export function rootCodeAppendChange(
  owner: RootCodeSourceOwner,
  source: SourceSnapshot,
  previous: RootCodeSourceMetadata,
  change: CodeSourceChange,
): RootCodePatchChange {
  const metadata = owner.getMetadata();
  const sourceAppend = source.read(previous.sourceRange.to, metadata.sourceRange.to);
  if (previous.sourceRange.to + sourceAppend.length !== metadata.sourceRange.to) {
    throw new Error("Root code sourceAppend does not match its authored source range");
  }
  return {
    code: metadata,
    expectedRevision: change.expectedRevision,
    fromLine: change.fromLine,
    lines: change.lines,
    sourceAppend,
  };
}

interface DiffGrammarCheckpoint {
  readonly line: number;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly oldRemaining?: number;
  readonly newRemaining?: number;
  readonly fileStartLine: number;
  readonly oldGrammarState: unknown;
  readonly newGrammarState: unknown;
  readonly configurationRevision: number;
  readonly language: string;
  readonly fileLanguage: string;
  readonly highlighter: SharedHighlighter | null;
  readonly codeEngineId?: string;
  readonly darkTheme: CodeThemePair["dark"];
  readonly lightTheme: CodeThemePair["light"];
  readonly prefixLineId: string;
  readonly prefixSourceRevision: number;
}

interface HighlightOwnerState {
  processedCompleteLines: number;
  grammarState?: unknown;
  grammarStateLine: number;
  codeEngineId?: string;
  diffCheckpoints?: DiffGrammarCheckpoint[];
  missingDiffContext?: {
    readonly line: number;
    readonly lineId: string;
    readonly sourceRevision: number;
    readonly fileStartLine: number;
    cursor: DiffCursorState;
    scannedThrough: number;
    prefixLineId: string;
    prefixSourceRevision: number;
  };
  resolvedLanguage?: string;
  resolution?: Promise<string>;
  work: Promise<unknown>;
}


type HtmlCodeLineDecoration = CodeLineDecoration & { readonly html: string | null };
const GRAMMAR_STATE_ADVANCE_CHUNK_LINES = 64;
const MAX_DIFF_GRAMMAR_CHECKPOINTS = 32;
interface CodeEngineDiffState {
  old?: unknown;
  new?: unknown;
  language?: string;
}

export function tokenizeCodeLines(
  engine: CodeEngine,
  language: string,
  lines: readonly string[],
  state: unknown,
): { readonly lines: readonly CodeTokenLine[]; readonly state: unknown } {
  const result = engine.tokenizeLines({ language, lines, state: state ?? null });
  if (result.lines.length !== lines.length) {
    throw new Error(`CodeEngine ${engine.id} returned ${result.lines.length} token lines for ${lines.length} source lines`);
  }
  return result;
}

export function buildDiffTokenLinesWithCodeEngine(
  lines: readonly DiffLineInfo[],
  language: string,
  grammarState: unknown,
  codeEngine: CodeEngine,
): {
  readonly tokenLines: readonly (CodeTokenLine | null)[];
  readonly diffTokenLines: readonly CodeDiffTokenLine[];
  readonly grammarState: CodeEngineDiffState;
} {
  const state: CodeEngineDiffState = typeof grammarState === "object" && grammarState !== null
    ? grammarState as CodeEngineDiffState
    : {};
  const tokenLines: Array<CodeTokenLine | null> = new Array(lines.length).fill(null);
  const diffTokenLines = new Array<CodeDiffTokenLine>(lines.length);
  let oldState = state.old;
  let newState = state.new;
  let currentLanguage = state.language ?? language;
  let currentKind: DiffLineInfo["kind"] | null = null;
  let currentRun: DiffLineInfo[] = [];
  let startIndex = 0;

  const flush = (): void => {
    if (!currentKind || currentRun.length === 0) return;
    const contents = currentRun.map((line) => line.content ?? "");
    let oldLines: readonly CodeTokenLine[] | undefined;
    let newLines: readonly CodeTokenLine[] | undefined;
    if (currentKind === "context") {
      const oldResult = tokenizeCodeLines(codeEngine, currentLanguage, contents, oldState);
      oldState = oldResult.state;
      oldLines = oldResult.lines;
      const newResult = tokenizeCodeLines(codeEngine, currentLanguage, contents, newState);
      newState = newResult.state;
      newLines = newResult.lines;
    } else if (currentKind === "add") {
      const result = tokenizeCodeLines(codeEngine, currentLanguage, contents, newState);
      newState = result.state;
      newLines = result.lines;
    } else {
      const result = tokenizeCodeLines(codeEngine, currentLanguage, contents, oldState);
      oldState = result.state;
      oldLines = result.lines;
    }
    for (let offset = 0; offset < currentRun.length; offset += 1) {
      const oldTokens = oldLines?.[offset] ?? null;
      const newTokens = newLines?.[offset] ?? null;
      const lineIndex = startIndex + offset;
      tokenLines[lineIndex] = currentKind === "remove" ? oldTokens : newTokens;
      diffTokenLines[lineIndex] = { old: oldTokens, new: newTokens };
    }
    currentRun = [];
    currentKind = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.kind === "meta" || line.kind === "hunk" || line.hunkHeader) {
      flush();
      const fileBoundary = line.kind === "meta"
        && (line.raw.startsWith("diff --git") || line.raw.startsWith("--- ") || line.raw.startsWith("+++ "));
      if (fileBoundary) {
        oldState = undefined;
        newState = undefined;
        const filePath = extractDiffFilePath(line.raw);
        if (filePath) currentLanguage = guessLanguageFromPath(filePath) ?? language;
      }
      tokenLines[index] = null;
      diffTokenLines[index] = { old: null, new: null };
      continue;
    }
    if (currentKind !== line.kind) {
      flush();
      currentKind = line.kind;
      startIndex = index;
    }
    currentRun.push(line);
  }
  flush();
  state.old = oldState;
  state.new = newState;
  state.language = currentLanguage;
  return { tokenLines, diffTokenLines, grammarState: state };
}

/** One continuation state per prepared code lease; range requests reuse it in source order. */
export class RootCodeHighlighter {
  private owners = new WeakMap<PreparedCodeLineOwner, HighlightOwnerState>();

  async decorateAvailable(
    owner: PreparedCodeLineOwner,
    config: RootCodeHighlightConfiguration,
    isCurrent: () => boolean,
  ): Promise<readonly HtmlCodeLineDecoration[]> {
    const state = this.state(owner);
    return this.enqueue(state, async () => {
      this.prepareCodeEngineState(state, config);
      if (!config.enabled || (!config.codeEngine && !config.highlighter) || !isCurrent()) return [];
      const index = owner.getLines();
      const to = index.completeLineCount;
      const from = state.processedCompleteLines;
      if (to <= from) return [];
      const rows = index.readRange(from, to);
      if (rows.length === 0) return [];
      const language = await this.resolveLanguage(owner, config, state);
      if (!isCurrent()) return [];
      const input = rows.map((row) => row.text).join("\n");
      try {
        if (!this.alignGrammarState(index, from, language, config, state)) return [];
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          config.counters?.recordTokenization(rows.length, input.length, "engine");
        }
        let rendered: readonly (CodeTokenLine | null)[];
        let html: readonly (string | null)[];
        if (config.codeEngine) {
          const result = tokenizeCodeLines(config.codeEngine, language, rows.map((row) => row.text), state.grammarState);
          state.grammarState = result.state;
          state.grammarStateLine = to;
          rendered = result.lines;
          html = rows.map(() => null);
        } else {
          const highlighter = config.highlighter!;
          const tokenRows = highlighter.codeToTokensWithThemes(input, {
            lang: language as never,
            themes: config.themes,
            grammarState: state.grammarState as never,
          } as never) as ShikiThemedToken[][];
          state.grammarState = highlighter.getLastGrammarState(tokenRows as never);
          state.grammarStateLine = to;
          rendered = renderTokenLines(tokenRows);
          html = renderShikiLines(tokenRows);
        }
        const decorations = this.makeDecorations(rows, rendered, html, config.configurationRevision, "exact");
        const current = owner.getLines();
        const valid = decorations.filter((decoration) => {
          const row = current.get(decoration.index);
          return row?.id === decoration.lineId && row.sourceRevision === decoration.sourceRevision;
        });
        if (!isCurrent()) return [];
        if (valid.length > 0) owner.decorateLines(valid);
        if (valid.length === rows.length) state.processedCompleteLines = to;
        return valid;
      } catch (error) {
        console.warn("Code highlighting failed", owner.id, error);
        return [];
      }
    });
  }

  async tokenizeRange(
    owner: PreparedCodeLineOwner,
    fromLine: number,
    toLine: number,
    config: RootCodeHighlightConfiguration,
    isCurrent: () => boolean,
    requestMode: "isolated" | "range" = "range",
  ): Promise<readonly HtmlCodeLineDecoration[]> {
    const state = this.state(owner);
    return this.enqueue(state, async () => {
      this.prepareCodeEngineState(state, config);
      if (!config.enabled || (!config.codeEngine && !config.highlighter) || !isCurrent()) return [];
      const index = owner.getLines();
      const from = Math.max(0, Math.min(index.length, Math.floor(fromLine)));
      const to = Math.max(from, Math.min(index.length, Math.floor(toLine)));
      const rows = index.readRange(from, to);
      const useSourceContext = requestMode === "range";
      const exactness = requestMode === "isolated" ? "isolated" : "exact";
      if (rows.length === 0) return [];
      const language = await this.resolveLanguage(owner, config, state);
      if (!isCurrent()) return [];
      try {
        const source = preparedCodeSourceOf(owner);
        const diffInfo = preparedCodeDiffInfo(source);
        if (
          diffInfo.isDiff
          && useSourceContext
          && this.hasCachedMissingDiffPrefixContext(index, from, to, state)
        ) {
          const unavailable = this.makeUnavailableDecorations(rows, config.configurationRevision, "missing_context");
          if (!isCurrent()) return [];
          owner.decorateLines(unavailable);
          return unavailable;
        }

        let rendered: readonly (CodeTokenLine | null)[];
        let html: Array<string | null>;
        let diffTokens: CodeDiffTokenLine[] | undefined;
        if (diffInfo.isDiff) {
          const checkpoint = useSourceContext ? this.nearestDiffCheckpoint(index, from, language, config, state) : undefined;
          const scanFrom = useSourceContext ? (checkpoint?.line ?? 0) : from;
          const scanRows = index.readRange(scanFrom, to);
          const cursor: DiffCursorState = {
            oldLine: useSourceContext ? checkpoint?.oldLine ?? null : null,
            newLine: useSourceContext ? checkpoint?.newLine ?? null : null,
            ...(useSourceContext && checkpoint?.oldRemaining !== undefined
              ? { oldRemaining: checkpoint.oldRemaining }
              : {}),
            ...(useSourceContext && checkpoint?.newRemaining !== undefined
              ? { newRemaining: checkpoint.newRemaining }
              : {}),
            ...(useSourceContext ? { fileStartLine: checkpoint?.fileStartLine ?? 0 } : {}),
          };
          const includesProvisionalTail = scanRows[scanRows.length - 1]?.isProvisional === true;
          const stableLength = includesProvisionalTail ? scanRows.length - 1 : scanRows.length;
          const stableCursor: DiffCursorState = { ...cursor };
          const diffLines: DiffLineInfo[] = [];
          let unavailablePrefix: { readonly row: CodeLineRecord; readonly fileStartLine: number } | undefined;
          for (let offset = 0; offset < scanRows.length; offset += 1) {
            const row = scanRows[offset]!;
            if (isDiffFileBoundary(row.text, cursor)) {
              cursor.fileStartLine = row.index;
              if (useSourceContext && row.index <= from) {
                unavailablePrefix = undefined;
                state.missingDiffContext = undefined;
              }
            }
            if (useSourceContext) {
              const header = parseDiffHunkHeader(row.text);
              if (header) {
                const missingPrefixContext = cursor.oldLine === null || cursor.newLine === null
                  ? header.oldStart > 1 || header.newStart > 1
                  : header.oldStart > cursor.oldLine || header.newStart > cursor.newLine;
                if (missingPrefixContext) {
                  unavailablePrefix = { row, fileStartLine: cursor.fileStartLine ?? 0 };
                }
              }
            }
            diffLines.push(parseUnifiedDiffLine(row.text, cursor));
            if (offset < stableLength) {
              stableCursor.oldLine = cursor.oldLine;
              stableCursor.newLine = cursor.newLine;
              if (cursor.oldRemaining !== undefined) stableCursor.oldRemaining = cursor.oldRemaining;
              else delete stableCursor.oldRemaining;
              if (cursor.newRemaining !== undefined) stableCursor.newRemaining = cursor.newRemaining;
              else delete stableCursor.newRemaining;
              if (cursor.fileStartLine !== undefined) stableCursor.fileStartLine = cursor.fileStartLine;
              else delete stableCursor.fileStartLine;
            }
          }
          if (useSourceContext && unavailablePrefix) {
            this.rememberMissingDiffContext(
              owner,
              unavailablePrefix.row,
              unavailablePrefix.fileStartLine,
              stableCursor,
              scanFrom + stableLength,
              state,
            );
            const unavailable = this.makeUnavailableDecorations(rows, config.configurationRevision, "missing_context");
            if (!isCurrent()) return [];
            owner.decorateLines(unavailable);
            return unavailable;
          }

          const stableLines = includesProvisionalTail ? diffLines.slice(0, stableLength) : diffLines;
          const initialGrammarState: CodeEngineDiffState = {
            old: checkpoint?.oldGrammarState,
            new: checkpoint?.newGrammarState,
            language: checkpoint?.fileLanguage ?? language,
          };
          const scanTokens: Array<CodeTokenLine | null> = new Array(scanRows.length).fill(null);
          const scanDiffTokens = new Array<CodeDiffTokenLine>(scanRows.length);
          let completedGrammarState = initialGrammarState;

          if (stableLines.length > 0) {
            if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
              let inputLength = Math.max(0, scanRows.length - 1);
              for (const row of scanRows) inputLength += row.text.length;
              config.counters?.recordTokenization(scanRows.length, inputLength, "engine");
            }
            const completed = config.codeEngine
              ? buildDiffTokenLinesWithCodeEngine(stableLines, language, initialGrammarState, config.codeEngine)
              : await buildDiffTokenLines(stableLines, language, initialGrammarState, config.highlighter!, config.themes);
            completedGrammarState = {
              old: completed.grammarState.old,
              new: completed.grammarState.new,
              language: completed.grammarState.language ?? language,
            };
            for (let offset = 0; offset < completed.diffTokenLines.length; offset += 1) {
              scanTokens[offset] = completed.tokenLines[offset] ?? null;
              scanDiffTokens[offset] = completed.diffTokenLines[offset]!;
            }
            if (useSourceContext && isCurrent()) {
              this.rememberDiffCheckpoint(
                owner,
                index,
                scanFrom + stableLines.length,
                completedGrammarState,
                stableCursor,
                language,
                config,
                state,
              );
            }
          }

          if (includesProvisionalTail) {
            const provisionalLines = [diffLines[diffLines.length - 1]!];
            const provisional = config.codeEngine
              ? buildDiffTokenLinesWithCodeEngine(
                  provisionalLines,
                  language,
                  { old: completedGrammarState.old, new: completedGrammarState.new },
                  config.codeEngine,
                )
              : await buildDiffTokenLines(
                  provisionalLines,
                  language,
                  { old: completedGrammarState.old, new: completedGrammarState.new },
                  config.highlighter!,
                  config.themes,
                );
            scanTokens[scanTokens.length - 1] = provisional.tokenLines[0] ?? null;
            scanDiffTokens[scanDiffTokens.length - 1] = provisional.diffTokenLines[0]!;
          }

          const requestedOffset = from - scanFrom;
          rendered = scanTokens.slice(requestedOffset, requestedOffset + rows.length);
          diffTokens = scanDiffTokens.slice(requestedOffset, requestedOffset + rows.length);
          html = rows.map(() => null);
        } else {
          const input = rows.map((row) => row.text).join("\n");
          if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
            config.counters?.recordTokenization(rows.length, input.length, "engine");
          }
          if (useSourceContext && !this.alignGrammarState(index, from, language, config, state)) return [];
          if (config.codeEngine) {
            const result = tokenizeCodeLines(
              config.codeEngine,
              language,
              rows.map((row) => row.text),
              useSourceContext ? state.grammarState : null,
            );
            if (useSourceContext && !rows[rows.length - 1]?.isProvisional) {
              state.grammarState = result.state;
              state.grammarStateLine = to;
            }
            rendered = result.lines;
            html = rows.map(() => null);
          } else {
            const highlighter = config.highlighter!;
            const tokenRows = highlighter.codeToTokensWithThemes(input, {
              lang: language as never,
              themes: config.themes,
              ...(useSourceContext ? { grammarState: state.grammarState as never } : {}),
            } as never) as ShikiThemedToken[][];
            if (useSourceContext && !rows[rows.length - 1]?.isProvisional) {
              state.grammarState = highlighter.getLastGrammarState(tokenRows as never);
              state.grammarStateLine = to;
            }
            rendered = renderTokenLines(tokenRows);
            html = renderShikiLines(tokenRows);
          }
        }
        const decorations = this.makeDecorations(rows, rendered, html, config.configurationRevision, exactness, diffTokens);
        const current = owner.getLines();
        const valid = decorations.filter((decoration) => {
          const row = current.get(decoration.index);
          return row?.id === decoration.lineId && row.sourceRevision === decoration.sourceRevision;
        });
        if (!isCurrent()) return [];
        if (valid.length > 0) owner.decorateLines(valid);
        return valid;
      } catch (error) {
        console.warn("Code range highlighting failed", owner.id, error);
        return [];
      }
    });
  }

  clear(): void {
    this.owners = new WeakMap<PreparedCodeLineOwner, HighlightOwnerState>();
  }
  private prepareCodeEngineState(state: HighlightOwnerState, config: RootCodeHighlightConfiguration): void {
    const codeEngineId = config.codeEngine?.id;
    if (state.codeEngineId === codeEngineId) return;
    state.codeEngineId = codeEngineId;
    state.processedCompleteLines = 0;
    state.grammarState = undefined;
    state.grammarStateLine = 0;
    state.diffCheckpoints = undefined;
    state.missingDiffContext = undefined;
    state.resolvedLanguage = undefined;
    state.resolution = undefined;
  }

  private alignGrammarState(
    index: CodeLineIndex,
    fromLine: number,
    language: string,
    config: RootCodeHighlightConfiguration,
    state: HighlightOwnerState,
  ): boolean {
    if (!config.highlighter && !config.codeEngine) return false;
    if (fromLine < state.grammarStateLine) {
      state.grammarState = undefined;
      state.grammarStateLine = 0;
    }
    while (state.grammarStateLine < fromLine) {
      const from = state.grammarStateLine;
      const to = Math.min(fromLine, from + GRAMMAR_STATE_ADVANCE_CHUNK_LINES);
      const rows = index.readRange(from, to);
      if (rows.length === 0) return false;
      const input = rows.map((row) => row.text).join("\n");
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        config.counters?.recordTokenization(rows.length, input.length, "engine");
      }
      if (config.codeEngine) {
        const result = tokenizeCodeLines(config.codeEngine, language, rows.map((row) => row.text), state.grammarState);
        state.grammarState = result.state;
      } else {
        const highlighter = config.highlighter!;
        const tokenRows = highlighter.codeToTokensWithThemes(input, {
          lang: language as never,
          themes: config.themes,
          grammarState: state.grammarState as never,
        } as never) as ShikiThemedToken[][];
        state.grammarState = highlighter.getLastGrammarState(tokenRows as never);
      }
      state.grammarStateLine = to;
    }
    return true;
  }

  private hasCachedMissingDiffPrefixContext(
    index: CodeLineIndex,
    fromLine: number,
    toLine: number,
    state: HighlightOwnerState,
  ): boolean {
    const missing = state.missingDiffContext;
    if (!missing) return false;
    const row = index.get(missing.line);
    const prefix = missing.scannedThrough > 0 ? index.get(missing.scannedThrough - 1) : undefined;
    if (
      row?.id === missing.lineId
      && row.sourceRevision === missing.sourceRevision
      && prefix?.id === missing.prefixLineId
      && prefix.sourceRevision === missing.prefixSourceRevision
      && !prefix.isProvisional
      && missing.scannedThrough <= index.completeLineCount
      && missing.cursor.fileStartLine === missing.fileStartLine
    ) {
      if (toLine <= missing.line) return false;
      if (fromLine <= missing.line || fromLine < missing.scannedThrough) return true;

      const cursor = missing.cursor;
      let scannedThrough = missing.scannedThrough;
      while (scannedThrough <= fromLine) {
        const next = index.get(scannedThrough);
        if (!next || next.isProvisional) break;
        if (isDiffFileBoundary(next.text, cursor)) {
          state.missingDiffContext = undefined;
          return false;
        }
        parseUnifiedDiffLine(next.text, cursor, true);
        scannedThrough += 1;
      }

      const scannedPrefix = index.get(scannedThrough - 1);
      if (scannedPrefix && !scannedPrefix.isProvisional) {
        missing.scannedThrough = scannedThrough;
        missing.prefixLineId = scannedPrefix.id;
        missing.prefixSourceRevision = scannedPrefix.sourceRevision;
      }
      return true;
    }
    state.missingDiffContext = undefined;
    return false;
  }

  private rememberMissingDiffContext(
    owner: PreparedCodeLineOwner,
    row: CodeLineRecord,
    fileStartLine: number,
    cursor: DiffCursorState,
    scannedThrough: number,
    state: HighlightOwnerState,
  ): void {
    const currentIndex = owner.getLines();
    const current = currentIndex.get(row.index);
    const prefix = scannedThrough > 0 ? currentIndex.get(scannedThrough - 1) : undefined;
    if (
      row.isProvisional
      || current?.id !== row.id
      || current.sourceRevision !== row.sourceRevision
      || scannedThrough <= 0
      || scannedThrough > currentIndex.completeLineCount
      || !prefix
      || prefix.isProvisional
      || cursor.fileStartLine !== fileStartLine
    ) {
      return;
    }
    state.missingDiffContext = {
      line: row.index,
      lineId: row.id,
      sourceRevision: row.sourceRevision,
      fileStartLine,
      cursor,
      scannedThrough,
      prefixLineId: prefix.id,
      prefixSourceRevision: prefix.sourceRevision,
    };
  }

  private nearestDiffCheckpoint(
    index: CodeLineIndex,
    beforeLine: number,
    language: string,
    config: RootCodeHighlightConfiguration,
    state: HighlightOwnerState,
  ): DiffGrammarCheckpoint | undefined {
    const checkpoints = state.diffCheckpoints;
    if (!checkpoints) return undefined;

    let nearest: DiffGrammarCheckpoint | undefined;
    let retained = 0;
    for (let offset = 0; offset < checkpoints.length; offset += 1) {
      const checkpoint = checkpoints[offset];
      if (!checkpoint || !this.isDiffCheckpointCompatible(index, checkpoint, language, config)) continue;
      checkpoints[retained] = checkpoint;
      retained += 1;
      if (checkpoint.line <= beforeLine && (!nearest || checkpoint.line > nearest.line)) nearest = checkpoint;
    }
    checkpoints.length = retained;
    return nearest;
  }

  private isDiffCheckpointCompatible(
    index: CodeLineIndex,
    checkpoint: DiffGrammarCheckpoint,
    language: string,
    config: RootCodeHighlightConfiguration,
  ): boolean {
    if (
      checkpoint.configurationRevision !== config.configurationRevision
      || checkpoint.language !== language
      || checkpoint.highlighter !== config.highlighter
      || checkpoint.codeEngineId !== config.codeEngine?.id
      || checkpoint.darkTheme !== config.themes.dark
      || checkpoint.lightTheme !== config.themes.light
      || checkpoint.line > index.completeLineCount
    ) {
      return false;
    }
    const prefix = index.get(checkpoint.line - 1);
    return prefix !== undefined
      && prefix.id === checkpoint.prefixLineId
      && prefix.sourceRevision === checkpoint.prefixSourceRevision
      && !prefix.isProvisional;
  }

  private rememberDiffCheckpoint(
    owner: PreparedCodeLineOwner,
    sourceIndex: CodeLineIndex,
    line: number,
    grammarState: { readonly old?: unknown; readonly new?: unknown; readonly language?: string },
    diffCursor: DiffCursorState,
    language: string,
    config: RootCodeHighlightConfiguration,
    state: HighlightOwnerState,
  ): void {
    const highlighter = config.highlighter;
    if ((!highlighter && !config.codeEngine) || line <= 0 || line > sourceIndex.completeLineCount) return;

    const scannedPrefix = sourceIndex.get(line - 1);
    const currentIndex = owner.getLines();
    const currentPrefix = currentIndex.get(line - 1);
    if (
      !scannedPrefix
      || scannedPrefix.isProvisional
      || currentIndex.completeLineCount < line
      || currentPrefix === undefined
      || currentPrefix.id !== scannedPrefix.id
      || currentPrefix.sourceRevision !== scannedPrefix.sourceRevision
    ) {
      return;
    }

    const checkpoint: DiffGrammarCheckpoint = {
      line,
      oldLine: diffCursor.oldLine,
      newLine: diffCursor.newLine,
      ...(diffCursor.oldRemaining !== undefined ? { oldRemaining: diffCursor.oldRemaining } : {}),
      ...(diffCursor.newRemaining !== undefined ? { newRemaining: diffCursor.newRemaining } : {}),
      fileStartLine: diffCursor.fileStartLine ?? 0,
      oldGrammarState: grammarState.old,
      newGrammarState: grammarState.new,
      configurationRevision: config.configurationRevision,
      language,
      fileLanguage: grammarState.language ?? language,
      highlighter,
      codeEngineId: config.codeEngine?.id,
      darkTheme: config.themes.dark,
      lightTheme: config.themes.light,
      prefixLineId: currentPrefix.id,
      prefixSourceRevision: currentPrefix.sourceRevision,
    };
    const checkpoints = state.diffCheckpoints ?? (state.diffCheckpoints = []);
    for (let offset = 0; offset < checkpoints.length; offset += 1) {
      if (checkpoints[offset]?.line === line) {
        checkpoints[offset] = checkpoint;
        return;
      }
    }
    if (checkpoints.length >= MAX_DIFF_GRAMMAR_CHECKPOINTS) checkpoints.shift();
    checkpoints.push(checkpoint);
  }

  private makeDecorations(
    rows: readonly CodeLineRecord[],
    rendered: readonly (CodeTokenLine | null)[],
    htmlLines: readonly (string | null)[],
    configurationRevision: number,
    exactness: "exact" | "isolated",
    diffTokens?: readonly CodeDiffTokenLine[],
  ): HtmlCodeLineDecoration[] {
    const decorations: HtmlCodeLineDecoration[] = [];
    for (let offset = 0; offset < rows.length; offset += 1) {
      const row = rows[offset];
      if (!row) continue;
      const tokens = rendered[offset] ?? { spans: row.text.length > 0 ? [{ t: row.text }] : [] };
      const diffTokenLine = diffTokens?.[offset];
      if (diffTokens !== undefined && diffTokenLine === undefined) {
        throw new Error("Diff highlighting did not produce paired tokens for every requested line");
      }
      decorations.push(Object.freeze({
        index: row.index,
        lineId: row.id,
        sourceRevision: row.sourceRevision,
        configurationRevision,
        exactness,
        tokens,
        ...(diffTokenLine !== undefined ? { diffTokens: diffTokenLine } : {}),
        html: htmlLines[offset] ?? row.text,
      }));
    }
    return decorations;
  }

  private makeUnavailableDecorations(
    rows: readonly CodeLineRecord[],
    configurationRevision: number,
    reason: HighlightUnavailableReason,
  ): HtmlCodeLineDecoration[] {
    return rows.map((row) => Object.freeze({
      index: row.index,
      lineId: row.id,
      sourceRevision: row.sourceRevision,
      configurationRevision,
      exactness: "unavailable" as const,
      tokens: null,
      reason,
      html: null,
    }));
  }

  private state(owner: PreparedCodeLineOwner): HighlightOwnerState {
    let state = this.owners.get(owner);
    if (!state) {
      state = { processedCompleteLines: 0, grammarStateLine: 0, work: Promise.resolve() };
      this.owners.set(owner, state);
    }
    return state;
  }

  private enqueue<T>(state: HighlightOwnerState, work: () => Promise<T>): Promise<T> {
    const result = state.work.then(work, work);
    state.work = result.then(() => undefined, () => undefined);
    return result;
  }

  private async resolveLanguage(
    owner: PreparedCodeLineOwner,
    config: RootCodeHighlightConfiguration,
    state: HighlightOwnerState,
  ): Promise<string> {
    if (state.resolvedLanguage) return state.resolvedLanguage;
    if (!state.resolution) {
      const source = preparedCodeSourceOf(owner);
      const diffInfo = preparedCodeDiffInfo(source);
      const requested = diffInfo.isDiff ? diffInfo.baseLang ?? "text" : source.language ?? "text";
      state.resolution = config.codeEngine
        ? Promise.resolve(requested)
        : resolveHighlightLanguage(config.highlighter, requested);
    }
    return state.resolution;
  }
}

export function rootCodeDecoratePatch(
  owner: RootCodeSourceOwner,
  configurationRevision: number,
  decorations: readonly CodeLineDecoration[],
): Extract<Patch, { op: "decorateCode" }> | null {
  if (decorations.length === 0) return null;
  const metadata = owner.getMetadata();
  return {
    op: "decorateCode",
    at: { blockId: owner.id },
    codeOwnerId: owner.id,
    generation: metadata.generation,
    configurationRevision,
    decorations,
    meta: { kind: "enrichment" },
  };
}

export function rootCodeAppendPatch(
  owner: RootCodeSourceOwner,
  change: RootCodePatchChange,
): Extract<Patch, { op: "appendCode" }> {
  return {
    op: "appendCode",
    at: { blockId: owner.id },
    code: change.code,
    expectedRevision: change.expectedRevision,
    fromLine: change.fromLine,
    lines: change.lines,
    sourceAppend: change.sourceAppend,
    meta: { kind: "semantic" },
  };
}
