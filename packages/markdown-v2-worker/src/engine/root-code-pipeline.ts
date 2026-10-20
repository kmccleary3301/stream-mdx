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
  type CodeLineRecord,
  type TokenLineV1,
  type NodeSnapshot,
  type Patch,
  type SourceSnapshot,
} from "@stream-mdx/core";
import {
  buildDiffTokenLines,
  detectDiffLanguage,
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
import type { ShikiThemedToken } from "./types";

const OPENING_BY_OWNER = new WeakMap<RootCodeSourceOwner, RootCodeSourceOpening>();

export interface RootCodeHighlightConfiguration {
  readonly highlighter: SharedHighlighter | null;
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

/** Admit only top-level native FencedCode nodes and bind each to the authored source. */
export function createRootCodeOwners(
  tree: Tree,
  source: AppendSourceDocument,
  generation: number,
  sourceOffset = 0,
  counters?: RootCodeSourceOwnerOptions["counters"],
): readonly RootCodeSourceOwner[] {
  const reader = source.snapshot();
  const owners: RootCodeSourceOwner[] = [];
  const cursor = tree.cursor();
  if (!cursor.firstChild()) return owners;
  do {
    if (cursor.type.name !== "FencedCode") continue;
    const opening = openingFor(cursor.node, reader, sourceOffset);
    if (!opening) continue;
    const id = generateBlockId(`${opening.from}:code`, "code");
    const owner = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? new RootCodeSourceOwner({ id, generation, source, opening, counters })
      : new RootCodeSourceOwner({ id, generation, source, opening });
    OPENING_BY_OWNER.set(owner, opening);
    if (opening.bodyFrom < source.length) owner.accept(opening.bodyFrom, source.length);
    owners.push(owner);
  } while (cursor.nextSibling());
  return owners;
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

interface HighlightOwnerState {
  processedCompleteLines: number;
  grammarState?: unknown;
  resolvedLanguage?: string;
  resolution?: Promise<string>;
  work: Promise<unknown>;
}

type HtmlCodeLineDecoration = CodeLineDecoration & { readonly html: string | null };
/** One continuation state per root code owner; isolated range requests never replay its prefix. */
export class RootCodeHighlighter {
  private readonly owners = new Map<string, HighlightOwnerState>();

  async decorateAvailable(
    owner: RootCodeSourceOwner,
    config: RootCodeHighlightConfiguration,
    isCurrent: () => boolean,
  ): Promise<readonly HtmlCodeLineDecoration[]> {
    const state = this.state(owner.id);
    return this.enqueue(state, async () => {
      if (!config.enabled || !config.highlighter || !isCurrent()) return [];
      const index = owner.getLines();
      const to = index.completeLineCount;
      const from = state.processedCompleteLines;
      if (to <= from) return [];
      const rows = index.readRange(from, to);
      if (rows.length === 0) return [];
      const language = await this.resolveLanguage(owner, config, state);
      if (!isCurrent()) return [];

      const input = rows.map((row) => row.text).join("\n");
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        config.counters?.recordTokenization(rows.length, input.length, "engine");
      }
      try {
        const tokenRows = config.highlighter.codeToTokensWithThemes(input, {
          lang: language as never,
          themes: config.themes,
          grammarState: state.grammarState as never,
        } as never) as ShikiThemedToken[][];
        state.grammarState = config.highlighter.getLastGrammarState(tokenRows as never);
        const rendered = renderTokenLines(tokenRows);
        const html = renderShikiLines(tokenRows);
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
        console.warn("Root code highlighting failed", owner.id, error);
        return [];
      }
    });
  }

  async tokenizeRange(
    owner: RootCodeSourceOwner,
    fromLine: number,
    toLine: number,
    config: RootCodeHighlightConfiguration,
    isCurrent: () => boolean,
  ): Promise<readonly HtmlCodeLineDecoration[]> {
    const state = this.state(owner.id);
    return this.enqueue(state, async () => {
      if (!config.enabled || !config.highlighter || !isCurrent()) return [];
      const index = owner.getLines();
      const from = Math.max(0, Math.min(index.length, Math.floor(fromLine)));
      const to = Math.max(from, Math.min(index.length, Math.floor(toLine)));
      const rows = index.readRange(from, to);
      if (rows.length === 0) return [];
      const language = await this.resolveLanguage(owner, config, state);
      if (!isCurrent()) return [];
      const input = rows.map((row) => row.text).join("\n");
      try {
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          config.counters?.recordTokenization(rows.length, input.length, "engine");
        }
        const opening = openingOf(owner);
        const { lang, meta } = parseCodeFenceInfo(opening.info);
        const diffInfo = detectDiffLanguage(lang, meta);
        let rendered: Array<TokenLineV1 | null>;
        let html: Array<string | null>;
        if (diffInfo.isDiff) {
          const cursor = { oldLine: null as number | null, newLine: null as number | null };
          const diffLines = rows.map((row) => parseUnifiedDiffLine(row.text, cursor));
          const result = await buildDiffTokenLines(diffLines, language, {}, config.highlighter, config.themes);
          rendered = result.tokenLines;
          html = rows.map(() => null);
        } else {
          const tokenRows = config.highlighter.codeToTokensWithThemes(input, {
            lang: language as never,
            themes: config.themes,
          } as never) as ShikiThemedToken[][];
          state.grammarState = config.highlighter.getLastGrammarState(tokenRows as never);
          rendered = renderTokenLines(tokenRows);
          html = renderShikiLines(tokenRows);
        }
        const decorations = this.makeDecorations(rows, rendered, html, config.configurationRevision, "isolated");
        const current = owner.getLines();
        const valid = decorations.filter((decoration) => {
          const row = current.get(decoration.index);
          return row?.id === decoration.lineId && row.sourceRevision === decoration.sourceRevision;
        });
        if (!isCurrent()) return [];
        if (valid.length > 0) owner.decorateLines(valid);
        return valid;
      } catch (error) {
        console.warn("Root code range highlighting failed", owner.id, error);
        return [];
      }
    });
  }

  clear(): void {
    this.owners.clear();
  }

  private makeDecorations(
    rows: readonly CodeLineRecord[],
    rendered: readonly (TokenLineV1 | null)[],
    htmlLines: readonly (string | null)[],
    configurationRevision: number,
    exactness: CodeLineDecoration["exactness"],
  ): HtmlCodeLineDecoration[] {
    const decorations: HtmlCodeLineDecoration[] = [];
    for (let offset = 0; offset < rows.length; offset += 1) {
      const row = rows[offset];
      if (!row) continue;
      const tokens = rendered[offset] ?? { spans: row.text.length > 0 ? [{ t: row.text }] : [] };
      decorations.push(Object.freeze({
        index: row.index,
        lineId: row.id,
        sourceRevision: row.sourceRevision,
        configurationRevision,
        exactness,
        tokens,
        html: htmlLines[offset] ?? row.text,
      }));
    }
    return decorations;
  }

  private state(ownerId: string): HighlightOwnerState {
    let state = this.owners.get(ownerId);
    if (!state) {
      state = { processedCompleteLines: 0, work: Promise.resolve() };
      this.owners.set(ownerId, state);
    }
    return state;
  }

  private enqueue<T>(state: HighlightOwnerState, work: () => Promise<T>): Promise<T> {
    const result = state.work.then(work, work);
    state.work = result.then(() => undefined, () => undefined);
    return result;
  }

  private async resolveLanguage(
    owner: RootCodeSourceOwner,
    config: RootCodeHighlightConfiguration,
    state: HighlightOwnerState,
  ): Promise<string> {
    if (state.resolvedLanguage) return state.resolvedLanguage;
    if (!state.resolution) {
      const opening = openingOf(owner);
      const { lang, meta } = parseCodeFenceInfo(opening.info);
      const diffInfo = detectDiffLanguage(lang, meta);
      const requested = diffInfo.isDiff ? diffInfo.baseLang ?? "text" : opening.language ?? "text";
      state.resolution = resolveHighlightLanguage(config.highlighter, requested).then((language) => {
        return language;
      });
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
