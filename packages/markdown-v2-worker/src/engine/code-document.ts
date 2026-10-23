import {
  createCodeLineIndex,
  createCodeNodeHandle,
  type CodeBlockMetadata,
  type CodeDiffStatus,
  type CodeHighlightThemes,
  type CodeLineDecoration,
  type CodeDiffTokenLine,
  type CodeLineIndex,
  type CodeLineRange,
  type CodeLineRecord,
  type CodeNodeHandle,
  type CodeTokenLine,
  type HighlightUnavailableReason,
} from "@stream-mdx/core";
import {
  DEFAULT_CODE_HIGHLIGHT_THEMES,
  getSharedHighlighter,
  advanceDiffCursor,
  codeDiffStatus,
  resolveHighlightThemes,
} from "./highlight";
import type { DiffCursorState } from "./types";
import {
  RootCodeHighlighter,
  registerPreparedCodeLineSource,
  type PreparedCodeLineOwner,
  type RootCodeHighlightConfiguration,
} from "./root-code-pipeline";

declare const codeContextBrand: unique symbol;

export interface CodeContext {
  readonly [codeContextBrand]: true;
}

interface CodeContextLease {
  readonly generationToken: symbol;
  readonly completedLineCount: number;
  readonly sourceRevision: number;
  readonly configurationRevision: number;
}
const codeContextLeases = new WeakMap<CodeContext, CodeContextLease>();

const INITIAL_SOURCE_REVISION = 0;

export interface CreateCodeDocumentOptions {
  readonly language: string;
  /** Treat the source as unified diff; language is the code grammar for both sides. */
  readonly diff?: boolean;
  readonly initialContent: string;
  /** Creation-time theme names, copied independently of caller-owned configuration. */
  readonly themes?: CodeHighlightThemes;
}

export type HighlightRequest =
  | {
      readonly mode: "isolated";
      /** Zero-based half-open line range. */
      readonly range: { readonly from: number; readonly to: number };
    }
  | {
      readonly mode: "range";
      /** Zero-based half-open line range in this document's complete source. */
      readonly range: { readonly from: number; readonly to: number };
    }
  | {
      readonly mode: "continuation";
      readonly context?: CodeContext;
      /** Zero-based half-open line range in the continued source. */
      readonly range: { readonly from: number; readonly to: number };
    };

export type { HighlightUnavailableReason };
export type HighlightResult =
  | {
      readonly exactness: "exact";
      readonly tokens: readonly CodeTokenLine[];
      readonly diffTokens?: readonly CodeDiffTokenLine[];
      readonly sourceRevision: number;
    }
  | {
      readonly exactness: "isolated";
      readonly tokens: readonly CodeTokenLine[];
      readonly diffTokens?: readonly CodeDiffTokenLine[];
      readonly sourceRevision: number;
    }
  | {
      readonly exactness: "unavailable";
      readonly tokens: null;
      readonly reason: HighlightUnavailableReason;
      readonly sourceRevision: number;
    };

export interface CodeDocumentController {
  readonly handle: CodeNodeHandle;
  captureContext(): CodeContext;
  append(text: string): void;
  finalize(): void;
  highlight(request: HighlightRequest): Promise<HighlightResult>;
  dispose(): void;
}

function createLineRecords(
  source: string,
  ownerId: string,
  firstIndex = 0,
  sourceOffset = 0,
  sourceRevision = INITIAL_SOURCE_REVISION,
): CodeLineRecord[] {
  const records: CodeLineRecord[] = [];
  let from = 0;
  for (let index = firstIndex; ; index += 1) {
    let to = from;
    while (to < source.length && source[to] !== "\r" && source[to] !== "\n") to += 1;

    let ending: CodeLineRecord["ending"] = "";
    if (to < source.length) {
      ending = source[to] === "\r" && source[to + 1] === "\n"
        ? "\r\n"
        : source[to] === "\r" ? "\r" : "\n";
    }
    const pendingCarriageReturn = ending === "\r" && to === source.length - 1;

    records.push(Object.freeze({
      id: `${ownerId}:line:${index}`,
      index,
      text: source.slice(from, to),
      ending,
      sourceRange: Object.freeze({ from: sourceOffset + from, to: sourceOffset + to }),
      sourceRevision,
      isProvisional: ending === "" || pendingCarriageReturn,
    }));

    if (ending === "" || pendingCarriageReturn) break;
    from = to + ending.length;
  }
  return records;
}

type CodeHandleListener = () => void;

interface CodeHandleObserver {
  readonly listener: CodeHandleListener;
}

interface CodeLineRangeSubscription {
  readonly from: number;
  readonly to: number;
  readonly listeners: Set<CodeHandleObserver>;
  snapshot: CodeLineRangeSnapshot | undefined;
}

interface CodeLineRangeSnapshot {
  readonly from: number;
  readonly to: number;
  readonly lines: readonly CodeLineRecord[];
}

const CODE_LINE_RANGE_CACHE_LIMIT = 128;

function assertCodeLineRange(range: CodeLineRange): void {
  if (
    range === null ||
    typeof range !== "object" ||
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 0 ||
    range.to < range.from
  ) {
    throw new RangeError("Code line read range must be ordered non-negative safe integers");
  }
}

function rangeIntersectsIndices(from: number, to: number, indices: ReadonlySet<number>): boolean {
  for (const index of indices) {
    if (index >= from && index < to) return true;
  }
  return false;
}


class CodeDocumentLineOwner implements PreparedCodeLineOwner {
  readonly id = "code-document";
  private lines: CodeLineIndex;
  private sourceRevision = INITIAL_SOURCE_REVISION;
  private sourceLength: number;
  private metadataRevision = INITIAL_SOURCE_REVISION;
  private finalized = false;
  private disposed = false;
  private readonly language: string;
  private readonly configurationRevision: number;
  private diffCursor: DiffCursorState | undefined;
  private diffStatus: CodeDiffStatus | undefined;
  /** A committed hunk header or file boundary arrived while the previous hunk still owed rows. */
  private diffRowsAbandoned = false;
  private metadata: CodeBlockMetadata;
  private readonly metadataListeners = new Set<CodeHandleObserver>();
  private readonly lineRangeSubscriptions = new Map<string, CodeLineRangeSubscription>();
  private readonly inactiveLineRangeSnapshots = new Map<string, CodeLineRangeSnapshot>();

  constructor(source: string, language: string, diff: boolean, configurationRevision: number) {
    this.language = language;
    this.configurationRevision = configurationRevision;
    this.sourceLength = source.length;
    this.diffCursor = diff ? { oldLine: null, newLine: null } : undefined;
    const initialLines = createLineRecords(source, this.id);
    this.lines = createCodeLineIndex({ lines: initialLines });
    for (const line of initialLines) this.commitDiffLine(line);
    this.diffStatus = this.getDiffStatus();
    this.metadata = this.createMetadata();
    registerPreparedCodeLineSource(this, { info: language, language, diff });
  }

  getLines(): CodeLineIndex {
    return this.lines;
  }

  getSourceRevision(): number {
    return this.sourceRevision;
  }

  readMetadata(): CodeBlockMetadata {
    this.assertActive();
    return this.metadata;
  }

  readLines(range: CodeLineRange): readonly CodeLineRecord[] {
    this.assertActive();
    assertCodeLineRange(range);
    const key = `${range.from}:${range.to}`;
    const subscription = this.lineRangeSubscriptions.get(key);
    if (subscription !== undefined) {
      let snapshot = subscription.snapshot;
      if (snapshot === undefined) {
        snapshot = this.createRangeSnapshot(range.from, range.to);
        subscription.snapshot = snapshot;
      }
      return snapshot.lines;
    }

    const cached = this.inactiveLineRangeSnapshots.get(key);
    if (cached !== undefined) {
      this.inactiveLineRangeSnapshots.delete(key);
      this.inactiveLineRangeSnapshots.set(key, cached);
      return cached.lines;
    }

    const snapshot = this.createRangeSnapshot(range.from, range.to);
    this.cacheInactiveSnapshot(key, snapshot);
    return snapshot.lines;
  }

  private createRangeSnapshot(from: number, to: number): CodeLineRangeSnapshot {
    return { from, to, lines: this.lines.readRange(from, to) };
  }

  private cacheInactiveSnapshot(key: string, snapshot: CodeLineRangeSnapshot): void {
    this.inactiveLineRangeSnapshots.delete(key);
    this.inactiveLineRangeSnapshots.set(key, snapshot);
    if (this.inactiveLineRangeSnapshots.size > CODE_LINE_RANGE_CACHE_LIMIT) {
      const oldest = this.inactiveLineRangeSnapshots.keys().next().value as string | undefined;
      if (oldest !== undefined) this.inactiveLineRangeSnapshots.delete(oldest);
    }
  }

  subscribeMetadata(listener: CodeHandleListener): () => void {
    this.assertActive();
    const observer = { listener };
    this.metadataListeners.add(observer);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.metadataListeners.delete(observer);
    };
  }

  subscribeLines(range: CodeLineRange, listener: CodeHandleListener): () => void {
    this.assertActive();
    assertCodeLineRange(range);
    const key = `${range.from}:${range.to}`;
    let subscription = this.lineRangeSubscriptions.get(key);
    if (subscription === undefined) {
      const snapshot = this.inactiveLineRangeSnapshots.get(key)
        ?? this.createRangeSnapshot(range.from, range.to);
      this.inactiveLineRangeSnapshots.delete(key);
      subscription = {
        from: range.from,
        to: range.to,
        listeners: new Set(),
        snapshot,
      };
      this.lineRangeSubscriptions.set(key, subscription);
    }
    const observer = { listener };
    subscription.listeners.add(observer);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.lineRangeSubscriptions.get(key);
      if (current === undefined) return;
      current.listeners.delete(observer);
      if (current.listeners.size === 0) {
        this.lineRangeSubscriptions.delete(key);
        if (current.snapshot !== undefined) {
          this.cacheInactiveSnapshot(key, current.snapshot);
        }
      }
    };
  }

  append(text: string): void {
    if (this.disposed) throw new Error("Code document is disposed");
    if (this.finalized) throw new Error("Code document is finalized");
    if (text.length === 0) return;

    const from = this.lines.length - 1;
    const previous = this.lines.get(from);
    if (!previous?.isProvisional) {
      throw new Error("Code document must retain a provisional tail line");
    }

    const sourceRevision = this.sourceRevision + 1;
    const tailSource = previous.text + previous.ending + text;
    const replacement = createLineRecords(
      tailSource,
      this.id,
      from,
      previous.sourceRange.from,
      sourceRevision,
    );
    const lines = this.lines.replaceTail(from, replacement);
    for (const line of replacement) this.commitDiffLine(line);
    this.lines = lines;
    this.sourceRevision = sourceRevision;
    this.sourceLength += text.length;
    this.metadataRevision += 1;
    this.diffStatus = this.getDiffStatus();
    this.metadata = this.createMetadata();

    this.invalidateRangeSnapshots(from, lines.length);
    this.notifyMetadataListeners();
    this.notifyLineRangeListeners(from, lines.length);
  }

  finalize(): void {
    if (this.disposed) throw new Error("Code document is disposed");
    if (this.finalized) return;

    const finalLineIndex = this.lines.length - 1;
    const finalLine = this.lines.get(finalLineIndex);
    const lineChanged = finalLine?.isProvisional === true;
    if (lineChanged && finalLine !== undefined) {
      const completedLine = Object.freeze({ ...finalLine, isProvisional: false });
      this.commitDiffLine(completedLine);
      this.lines = this.lines.replaceTail(finalLineIndex, [completedLine]);
    }
    this.finalized = true;
    this.metadataRevision += 1;
    this.diffStatus = this.getDiffStatus();
    this.metadata = this.createMetadata();

    if (lineChanged) this.invalidateRangeSnapshots(finalLineIndex, finalLineIndex + 1);
    this.notifyMetadataListeners();
    if (lineChanged) this.notifyLineRangeListeners(finalLineIndex, finalLineIndex + 1);
  }

  decorateLines(decorations: readonly CodeLineDecoration[]): CodeLineIndex {
    if (this.disposed) return this.lines;
    const previous = this.lines;
    const lines = previous.decorate(decorations);
    if (lines === previous) return lines;

    const changedIndices = new Set<number>();
    for (const decoration of decorations) {
      const index = decoration.index;
      if (
        Number.isSafeInteger(index) &&
        index >= 0 &&
        index < lines.length &&
        previous.get(index) !== lines.get(index)
      ) {
        changedIndices.add(index);
      }
    }
    this.lines = lines;
    if (changedIndices.size > 0) {
      this.invalidateRangeSnapshotsForIndices(changedIndices);
      this.notifyLineRangeListenersForIndices(changedIndices);
    }
    return lines;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.metadataListeners.clear();
    this.lineRangeSubscriptions.clear();
    this.inactiveLineRangeSnapshots.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Code document is disposed");
  }

  private commitDiffLine(line: CodeLineRecord): void {
    if (this.diffCursor !== undefined && !line.isProvisional && advanceDiffCursor(line.text, this.diffCursor)) {
      this.diffRowsAbandoned = true;
    }
  }

  private getDiffStatus(): CodeDiffStatus | undefined {
    const cursor = this.diffCursor;
    if (cursor === undefined) return undefined;
    const tail = this.lines.get(this.lines.length - 1);
    return codeDiffStatus(
      cursor,
      this.diffRowsAbandoned,
      tail?.isProvisional ? tail.text : undefined,
      this.finalized,
    );
  }

  private createMetadata(): CodeBlockMetadata {
    return Object.freeze({
      codeOwnerId: this.id,
      generation: 0,
      revision: this.metadataRevision,
      state: this.finalized ? "finalized" : "open",
      processedTo: this.sourceLength,
      completeLineCount: this.lines.completeLineCount,
      lineCount: this.lines.length,
      sourceRange: Object.freeze({ from: 0, to: this.sourceLength }),
      configurationRevision: this.configurationRevision,
      info: this.language,
      language: this.language,
      ...(this.diffStatus !== undefined ? { diffStatus: this.diffStatus } : {}),
    });
  }

  private invalidateRangeSnapshots(from: number, to: number): void {
    for (const subscription of this.lineRangeSubscriptions.values()) {
      const snapshot = subscription.snapshot;
      if (snapshot !== undefined && snapshot.from < to && snapshot.to > from) {
        subscription.snapshot = undefined;
      }
    }
    for (const [key, snapshot] of this.inactiveLineRangeSnapshots) {
      if (snapshot.from < to && snapshot.to > from) {
        this.inactiveLineRangeSnapshots.delete(key);
      }
    }
  }

  private notifyMetadataListeners(): void {
    for (const observer of this.metadataListeners) observer.listener();
  }

  private notifyLineRangeListeners(from: number, to: number): void {
    for (const subscription of this.lineRangeSubscriptions.values()) {
      if (subscription.from >= to || subscription.to <= from) continue;
      for (const observer of subscription.listeners) observer.listener();
    }
  }

  private invalidateRangeSnapshotsForIndices(indices: ReadonlySet<number>): void {
    for (const subscription of this.lineRangeSubscriptions.values()) {
      const snapshot = subscription.snapshot;
      if (snapshot !== undefined && rangeIntersectsIndices(snapshot.from, snapshot.to, indices)) {
        subscription.snapshot = undefined;
      }
    }
    for (const [key, snapshot] of this.inactiveLineRangeSnapshots) {
      if (rangeIntersectsIndices(snapshot.from, snapshot.to, indices)) {
        this.inactiveLineRangeSnapshots.delete(key);
      }
    }
  }

  private notifyLineRangeListenersForIndices(indices: ReadonlySet<number>): void {
    for (const subscription of this.lineRangeSubscriptions.values()) {
      if (!rangeIntersectsIndices(subscription.from, subscription.to, indices)) continue;
      for (const observer of subscription.listeners) observer.listener();
    }
  }
}

class CodeDocumentControllerImpl implements CodeDocumentController {
  readonly handle: CodeNodeHandle;
  private readonly codeHighlighter = new RootCodeHighlighter();
  private readonly language: string;
  private readonly themes: Readonly<CodeHighlightThemes>;
  private readonly diff: boolean;

  private readonly generationToken = Symbol("code-document-generation");
  private readonly configurationRevision = 0;
  private owner: CodeDocumentLineOwner | undefined;
  private disposed = false;

  constructor(options: CreateCodeDocumentOptions) {
    this.language = options.language;
    const themes = options.themes;
    this.themes = themes ? { ...themes } : DEFAULT_CODE_HIGHLIGHT_THEMES;
    this.diff = options.diff === true;
    this.owner = new CodeDocumentLineOwner(
      options.initialContent,
      options.language,
      this.diff,
      this.configurationRevision,
    );
    const getOwner = (): CodeDocumentLineOwner => {
      const owner = this.owner;
      if (this.disposed || !owner) throw new Error("Code document is disposed");
      return owner;
    };
    this.handle = createCodeNodeHandle({
      readSource: () => getOwner().getLines().materialize(),
      readMetadata: () => getOwner().readMetadata(),
      readLines: (range: CodeLineRange) => getOwner().readLines(range),
      subscribeMetadata: (listener: CodeHandleListener) => getOwner().subscribeMetadata(listener),
      subscribeLines: (range: CodeLineRange, listener: CodeHandleListener) =>
        getOwner().subscribeLines(range, listener),
    });
  }

  captureContext(): CodeContext {
    const owner = this.owner;
    if (this.disposed || !owner) throw new Error("Code document is disposed");

    const context = Object.freeze({}) as unknown as CodeContext;
    codeContextLeases.set(context, Object.freeze({
      generationToken: this.generationToken,
      completedLineCount: owner.getLines().completeLineCount,
      sourceRevision: owner.getSourceRevision(),
      configurationRevision: this.configurationRevision,
    }));
    return context;
  }

  async highlight(request: HighlightRequest): Promise<HighlightResult> {
    const owner = this.owner;
    if (this.disposed || !owner) throw new Error("Code document is disposed");


    if (request.mode === "continuation") {
      const sourceRevision = owner.getSourceRevision();
      const contextLease = request.context ? codeContextLeases.get(request.context) : undefined;
      if (!contextLease) {
        return { exactness: "unavailable", tokens: null, reason: "missing_context", sourceRevision };
      }
      if (contextLease.generationToken !== this.generationToken) {
        return { exactness: "unavailable", tokens: null, reason: "stale_generation", sourceRevision };
      }
      if (
        contextLease.configurationRevision !== this.configurationRevision
        || contextLease.sourceRevision > sourceRevision
        || contextLease.completedLineCount > owner.getLines().completeLineCount
      ) {
        return { exactness: "unavailable", tokens: null, reason: "source_mismatch", sourceRevision };
      }
    }

    const highlighter = await getSharedHighlighter([this.language]);
    if (this.disposed || this.owner !== owner) throw new Error("Code document is disposed");
    const { themes } = await resolveHighlightThemes(highlighter, this.themes);
    if (this.disposed || this.owner !== owner) throw new Error("Code document is disposed");

    const config: RootCodeHighlightConfiguration = {
      highlighter,
      themes,
      configurationRevision: this.configurationRevision,
      enabled: true,
    };
    const requestMode = request.mode === "isolated" ? "isolated" : "range";
    const decorations = await this.codeHighlighter.tokenizeRange(
      owner,
      request.range.from,
      request.range.to,
      config,
      () => !this.disposed && this.owner === owner,
      requestMode,
    );
    if (this.disposed || this.owner !== owner) throw new Error("Code document is disposed");

    const index = owner.getLines();
    const from = Math.max(0, Math.min(index.length, Math.floor(request.range.from)));
    const to = Math.max(from, Math.min(index.length, Math.floor(request.range.to)));
    if (decorations.length !== to - from) {
      throw new Error("Code document highlighting did not produce the requested line range");
    }
    const firstDecoration = decorations[0];
    if (firstDecoration?.exactness === "unavailable") {
      return {
        exactness: "unavailable",
        tokens: null,
        reason: firstDecoration.reason,
        sourceRevision: owner.getSourceRevision(),
      };
    }

    const exactness = requestMode === "isolated" ? "isolated" : "exact";
    const hasDiffTokenTracks = firstDecoration !== undefined
      && firstDecoration.diffTokens !== undefined;
    const diffTokens = hasDiffTokenTracks
      ? decorations.map((decoration) => {
          if (decoration.exactness === "unavailable") {
            throw new Error("Code document highlighting returned mixed availability");
          }
          const line = decoration.diffTokens;
          if (line === undefined) {
            throw new Error("Code document diff highlighting returned mixed token tracks");
          }
          return line;
        })
      : undefined;
    return {
      exactness,
      tokens: decorations.map((decoration) => {
        if (decoration.exactness === "unavailable") {
          throw new Error("Code document highlighting returned mixed availability");
        }
        return decoration.tokens;
      }),
      ...(diffTokens !== undefined ? { diffTokens } : {}),
      sourceRevision: owner.getSourceRevision(),
    };
  }

  append(text: string): void {
    const owner = this.owner;
    if (this.disposed || !owner) throw new Error("Code document is disposed");
    owner.append(text);
  }

  finalize(): void {
    const owner = this.owner;
    if (this.disposed || !owner) throw new Error("Code document is disposed");
    owner.finalize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.codeHighlighter.clear();
    this.owner?.dispose();
    this.owner = undefined;
  }
}

export function createCodeDocument(options: CreateCodeDocumentOptions): CodeDocumentController {
  return new CodeDocumentControllerImpl(options);
}
