import {
  createParagraphSpanIndex,
  freezeParagraphSpanRecord,
  createSourceWindow,
  type AppendSourceDocument,
  type Block,
  type InlineNode,
  type InlineParser,
  type ParagraphBlockSnapshot,
  type BlockResolvedLinkReference,
  type ParagraphBlockSourceMetadata,
  type ParagraphSpanIndex,
  type ParagraphSpanRecord,
  type ParagraphSpanUpdate,
  type ParagraphSpanChildSnapshot,
  type SourceSnapshot,
  findUnmatchedBareAnchorOffsets,
} from "@stream-mdx/core";
import type { NativeParagraphTailChange } from "./native-paragraph-tail";
import {
  readContiguousParagraphSourceText,
  type ParagraphSourceRange,
  type ParagraphSourceText,
  type ParagraphSourceTextReader,
} from "./native-paragraph-source";
import {
  inlineNodesEqual,
  literalizeFallbackHtml,
  literalizeFallbackHtmlInChildren,
  stringListsEqual,
} from "./root-paragraph-content";

declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

export type RootParagraphSourceOwnerState = "open" | "closed" | "finalized";
export type ParagraphInlineSettlementMode = "native-tail" | "original-context";
type ParagraphCounterStage = "engine" | "snapshot" | "patch" | "store" | "view";
type ParagraphDependencyKind = "link" | "footnote";

export interface RootParagraphSourceOwnerCounters {
  recordInlineSourceUnits(units: number, stage?: ParagraphCounterStage): void;
  recordRecordSlotsAllocated(count: number, stage?: ParagraphCounterStage): void;
  recordSourceUnitsMaterialized(units: number, stage?: ParagraphCounterStage): void;
  recordInvalidation(cause: string, blockId: string, fields?: string[]): void;
}


/** Minimal parser-confirmed physical transition shared by root and native paragraph admission. */
export interface ParagraphSourceTransition {
  readonly ownerStart: number;
  readonly ownerEnd: number;
  readonly processedTo: number;
  readonly mode: NativeParagraphTailChange["mode"];
  readonly closure: NativeParagraphTailChange["closure"];
  readonly requiresOwnerReplacement: boolean;
  readonly replacementNode?: NativeParagraphTailChange["replacementNode"];
  readonly replacementSourceOffset?: number;
  readonly rootResumeFrom?: number;
}
export interface RootParagraphSourceOpening {
  readonly from: number;
  readonly to: number;
  readonly state: RootParagraphSourceOwnerState;
}

export interface PreparedParagraphSpanContent {
  readonly nodes?: readonly InlineNode[];
  readonly children?: readonly ParagraphSpanChildSnapshot[];
  readonly attemptedReferences: readonly string[];
}

export interface RootParagraphSourceOwnerOptions {
  readonly id: string;
  readonly generation: number;
  readonly source: AppendSourceDocument;
  readonly inlineParser: InlineParser;
  readonly opening: RootParagraphSourceOpening;
  readonly inlineSettlement: ParagraphInlineSettlementMode;
  /** @internal Stage-local diagnostics are read only when campaign counters are enabled. */
  readonly counters?: RootParagraphSourceOwnerCounters;
  /** Re-reads only the requested physical tail/span from the canonical source snapshot. */
  readonly sourceTextReader?: ParagraphSourceTextReader;
  readonly prepareProvisionalInline?: (
    content: string,
    onAttemptedReference: (label: string) => void,
  ) => readonly InlineNode[];
  readonly prepareSpanChildren?: (
    content: string,
    baseOffset: number,
    provisional: boolean,
    ownerId: string,
    ownerGeneration: number,
    spanIndex: number,
  ) => PreparedParagraphSpanContent | null;
}


export interface ParagraphSourceChange {
  readonly paragraph: ParagraphBlockSourceMetadata;
  readonly expectedRevision: number;
  readonly fromSpan: number;
  readonly spans: readonly ParagraphSpanRecord[];
  readonly mode: NativeParagraphTailChange["mode"];
  readonly requiresOwnerReplacement: false;
  readonly rootResumeFrom?: number;
}

export interface ParagraphOwnerReplacement {
  readonly ownerStart: number;
  readonly expectedRevision: number;
  readonly mode: NativeParagraphTailChange["mode"];
  readonly requiresOwnerReplacement: true;
  readonly replacementNode?: NativeParagraphTailChange["replacementNode"];
  readonly replacementSourceOffset?: number;
  readonly rootResumeFrom?: number;
}

export type RootParagraphSourceChange = ParagraphSourceChange | ParagraphOwnerReplacement;

export interface ParagraphSemanticChange {
  readonly paragraphOwnerId: string;
  readonly generation: number;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly updates: readonly ParagraphSpanUpdate[];
}

export interface PreparedParagraphSpanUpdate {
  readonly index: number;
  readonly expectedSourceRevision: number;
  readonly nodes: readonly InlineNode[];
  readonly children?: readonly ParagraphSpanChildSnapshot[];
  readonly attemptedReferences: readonly string[];
}

interface ParagraphDraft {
  readonly index: number;
  readonly from: number;
  readonly to: number;
  readonly sourceRevision: number;
  readonly isProvisional: boolean;
  readonly nodes: readonly InlineNode[];
  readonly attemptedReferences: readonly string[];
  readonly sourceText?: ParagraphSourceText;
  readonly children?: readonly ParagraphSpanChildSnapshot[];
}
const EMPTY_INLINE_NODES: readonly InlineNode[] = Object.freeze([]);
const EMPTY_ATTEMPTED_REFERENCES: readonly string[] = Object.freeze([]);

function emptyProjectedSourceDraft(
  index: number,
  sourceText: ParagraphSourceText,
  sourceRevision: number,
  isProvisional: boolean,
): ParagraphDraft | undefined {
  if (sourceText.text.length !== 0 || sourceText.sourceRange.from === sourceText.sourceRange.to) return undefined;
  return {
    index,
    from: sourceText.sourceRange.from,
    to: sourceText.sourceRange.to,
    sourceRevision,
    isProvisional,
    nodes: EMPTY_INLINE_NODES,
    attemptedReferences: EMPTY_ATTEMPTED_REFERENCES,
    sourceText,
  };
}

const EMPTY_OMITTED_RANGES: readonly ParagraphSourceRange[] = Object.freeze([]);
const EMPTY_SPAN_RECORDS: readonly ParagraphSpanRecord[] = Object.freeze([]);

function nextRevision(revision: number, label: string): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) throw new RangeError(`${label} revision exceeds the safe integer range`);
  return next;
}


function visitFootnoteDependencies(nodes: readonly InlineNode[], visit: (label: string) => void): void {
  for (const node of nodes) {
    if (node.kind === "footnote-ref") visit(node.label);
    if ("children" in node && Array.isArray(node.children)) visitFootnoteDependencies(node.children, visit);
  }
}


function recordFromDraft(ownerId: string, draft: ParagraphDraft): ParagraphSpanRecord {
  return freezeParagraphSpanRecord({
    id: `${ownerId}:span:${draft.index}`,
    index: draft.index,
    sourceRange: { from: draft.from, to: draft.to },
    sourceRevision: draft.sourceRevision,
    isProvisional: draft.isProvisional,
    nodes: draft.nodes,
    attemptedReferences: draft.attemptedReferences,

    ...(draft.children === undefined ? {} : { children: draft.children }),
  });
}

function dependencyKey(kind: ParagraphDependencyKind, label: string): string {
  return `${kind}:${label}`;
}

/** Owns one root Paragraph's immutable prepared inline history and exact canonical source range. */
export class RootParagraphSourceOwner {
  readonly id: string;
  readonly generation: number;

  private readonly source: AppendSourceDocument;
  private readonly inlineParser: InlineParser;
  private sourceTextReader: ParagraphSourceTextReader;
  private readonly inlineSettlement: ParagraphInlineSettlementMode;
  private readonly prepareProvisionalInline?: RootParagraphSourceOwnerOptions["prepareProvisionalInline"];
  private spanIndex: ParagraphSpanIndex;
  private readonly prepareSpanChildren?: RootParagraphSourceOwnerOptions["prepareSpanChildren"];
  private readonly ownerStart: number;
  private state: RootParagraphSourceOwnerState;
  private revision = 0;
  private processedTo: number;
  private rawEnd: number;
  private readonly spansByDependency = new Map<string, Set<number>>();
  private counters?: RootParagraphSourceOwnerCounters;
  private linkReferences: readonly BlockResolvedLinkReference[] | undefined;
  private omittedRanges: readonly ParagraphSourceRange[] = EMPTY_OMITTED_RANGES;
  private cachedSnapshot: { readonly revision: number; readonly snapshot: ParagraphBlockSnapshot } | undefined;

  constructor(options: RootParagraphSourceOwnerOptions) {
    const { id, generation, source, inlineParser, opening, inlineSettlement, prepareProvisionalInline, prepareSpanChildren, sourceTextReader } = options;
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new RangeError("Root paragraph owner generation must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(opening.from) || opening.from < 0
      || !Number.isSafeInteger(opening.to) || opening.to < opening.from
      || opening.to > source.length) {
      throw new RangeError("Root paragraph opening offsets must be an ordered source range");
    }

    this.id = id;
    this.generation = generation;
    this.source = source;
    this.inlineParser = inlineParser;
    this.prepareProvisionalInline = prepareProvisionalInline;
    this.sourceTextReader = sourceTextReader ?? readContiguousParagraphSourceText;
    this.prepareSpanChildren = prepareSpanChildren;
    this.inlineSettlement = inlineSettlement;
    this.ownerStart = opening.from;
    this.rawEnd = opening.to;
    this.processedTo = source.length;
    this.state = opening.state;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters = options.counters;
    }
    const reader = source.snapshot();
    const initialSourceText = this.readParagraphSourceText(reader, opening.from, opening.to);
    this.omittedRanges = this.replaceOmittedRanges(opening.from, opening.to, initialSourceText.omittedRanges);
    const initialRaw = initialSourceText.text;
    let initialDrafts: ParagraphDraft[];
    if (opening.state === "open" && inlineSettlement === "native-tail") {
      initialDrafts = this.prepareOpenTail(reader, opening.from, opening.to, 0, undefined, initialSourceText);
    } else if (initialRaw.length > 0 || initialSourceText.sourceRange.from < initialSourceText.sourceRange.to) {
      const parsed = this.parseWithAttempts(initialRaw);
      initialDrafts = [{
        index: 0,
        from: initialSourceText.sourceRange.from,
        to: initialSourceText.sourceRange.to,
        sourceRevision: 0,
        isProvisional: opening.state === "open",
        nodes: parsed.nodes,
        attemptedReferences: parsed.attemptedReferences,
        sourceText: initialSourceText,
      }];
    } else {
      initialDrafts = [];
    }
    const initialSpans = initialDrafts.map((draft) => this.createSpanRecord(draft, reader));
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && this.counters !== undefined) {
      this.spanIndex = createParagraphSpanIndex({
        spans: initialSpans,
        campaignCounters: this.counters,
        counterStage: "engine",
      });
    } else {
      this.spanIndex = createParagraphSpanIndex({ spans: initialSpans });
    }
    for (const span of this.spanIndex.materialize()) this.installDependencies(span);
  }


  getMetadata(): ParagraphBlockSourceMetadata {
    return Object.freeze({
      paragraphOwnerId: this.id,
      generation: this.generation,
      revision: this.revision,
      state: this.state,
      processedTo: this.processedTo,
      completeSpanCount: this.spanIndex.completeSpanCount,
      spanCount: this.spanIndex.length,
      sourceRange: Object.freeze({ from: this.ownerStart, to: this.rawEnd }),
      ...(this.omittedRanges.length === 0 ? {} : { omittedRanges: this.omittedRanges }),
      ...(this.linkReferences ? { linkReferences: this.linkReferences } : {}),
    });
  }
  private replaceOmittedRanges(
    from: number,
    to: number,
    replacements: readonly ParagraphSourceRange[] = EMPTY_OMITTED_RANGES,
  ): readonly ParagraphSourceRange[] {
    let prefixCount = 0;
    while (prefixCount < this.omittedRanges.length && this.omittedRanges[prefixCount]!.to <= from) prefixCount += 1;
    if (prefixCount < this.omittedRanges.length && this.omittedRanges[prefixCount]!.from < from) {
      throw new RangeError("Paragraph source update cuts through an omitted range");
    }
    if (prefixCount === this.omittedRanges.length && replacements.length === 0) return this.omittedRanges;
    const combined: ParagraphSourceRange[] = [];
    for (let index = 0; index < prefixCount; index += 1) combined.push(this.omittedRanges[index]!);
    let previousTo = from;
    for (const range of replacements) {
      if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
        || range.from < previousTo || range.to <= range.from || range.to > to) {
        throw new RangeError("Paragraph source update omitted ranges are invalid");
      }
      combined.push(Object.freeze({ from: range.from, to: range.to }));
      previousTo = range.to;
    }
    return combined.length === 0 ? EMPTY_OMITTED_RANGES : Object.freeze(combined);
  }


  getSpans(): ParagraphSpanIndex {
    return this.spanIndex;
  }
  hasFootnoteReferences(): boolean {
    for (const dependency of this.spansByDependency.keys()) {
      if (dependency.startsWith("footnote:")) return true;
    }
    return false;
  }
  getSourceTextReader(): ParagraphSourceTextReader {
    return this.sourceTextReader;
  }
  setLinkReferences(references: readonly BlockResolvedLinkReference[]): void {
    const current = this.linkReferences ?? [];
    if (current.length === references.length && current.every((reference, index) => {
      const next = references[index];
      return next !== undefined
        && reference.label === next.label
        && reference.href === next.href
        && reference.title === next.title;
    })) return;
    this.linkReferences = references.length > 0
      ? references.map((reference) => ({ ...reference }))
      : undefined;
    this.cachedSnapshot = undefined;
  }

  getSourceSnapshot(): SourceSnapshot {
    return createSourceWindow(this.source.snapshot(), this.ownerStart, this.rawEnd);
  }

  createSnapshot(): ParagraphBlockSnapshot {
    if (this.cachedSnapshot?.revision === this.revision) return this.cachedSnapshot.snapshot;
    const metadata = this.getMetadata();
    const raw = this.source.snapshot().read(this.ownerStart, this.rawEnd);
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters?.recordSourceUnitsMaterialized(raw.length, "snapshot");
    }
    const snapshot: ParagraphBlockSnapshot = Object.freeze({
      ...metadata,
      spans: this.spanIndex.materialize(),
      raw,
    });
    this.cachedSnapshot = { revision: this.revision, snapshot };
    return snapshot;
  }

  /** Cold legacy/debug materialization; native snapshots and routine appends use span records instead. */
  materializeBlock(): Block {
    const snapshot = this.createSnapshot();
    const inline: InlineNode[] = [];
    for (const span of snapshot.spans) {
      for (const node of span.nodes) inline.push(node);
    }
    return {
      id: this.id,
      type: "paragraph",
      isFinalized: snapshot.state !== "open",
      payload: {
        raw: snapshot.raw,
        inline,
        range: { ...snapshot.sourceRange },
        meta: {
          paragraph: snapshot,
          ...(snapshot.linkReferences?.length ? { linkReferences: snapshot.linkReferences.map((reference) => ({ ...reference })) } : {}),
        },
      },
    };
  }

  accept(
    from: number,
    to: number,
    nativeChange: ParagraphSourceTransition,
    sourceSnapshot = this.source.snapshot(),
    sourceTextReader = this.sourceTextReader,
  ): RootParagraphSourceChange {
    if (this.state !== "open") throw new Error(`Cannot accept source for a ${this.state} paragraph owner`);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)
      || from !== this.processedTo || to < from || to > this.source.length
      || to > sourceSnapshot.length || sourceSnapshot !== this.source.snapshot()
      || to !== nativeChange.processedTo || nativeChange.ownerStart !== this.ownerStart) {
      throw new RangeError("Paragraph acceptance must continue at its processed frontier against the canonical source snapshot");
    }
    this.sourceTextReader = sourceTextReader;
    const expectedRevision = this.revision;
    if (nativeChange.requiresOwnerReplacement) {
      return {
        ownerStart: this.ownerStart,
        expectedRevision,
        mode: nativeChange.mode,
        requiresOwnerReplacement: true,
        ...(nativeChange.replacementNode ? { replacementNode: nativeChange.replacementNode } : {}),
        ...(nativeChange.replacementSourceOffset === undefined ? {} : { replacementSourceOffset: nativeChange.replacementSourceOffset }),
        ...(nativeChange.rootResumeFrom === undefined ? {} : { rootResumeFrom: nativeChange.rootResumeFrom }),
      };
    }

    const nextState = nativeChange.closure === "finalized"
      ? "finalized"
      : nativeChange.closure === "following-root"
        ? "closed"
        : "open";
    const completeSpanCount = this.spanIndex.completeSpanCount;
    const previousTail = this.spanIndex.get(completeSpanCount);
    const completePrefixEnd = completeSpanCount > 0
      ? this.spanIndex.get(completeSpanCount - 1)?.sourceRange.to
      : this.ownerStart;
    if (completePrefixEnd === undefined || nativeChange.ownerEnd < completePrefixEnd) {
      return {
        ownerStart: this.ownerStart,
        expectedRevision,
        mode: nativeChange.mode,
        requiresOwnerReplacement: true,
        ...(nativeChange.rootResumeFrom === undefined ? {} : { rootResumeFrom: nativeChange.rootResumeFrom }),
      };
    }

    let tailDrafts: ParagraphDraft[];
    let omittedRangeStart: number | undefined;
    let updatedOmittedRanges = this.omittedRanges;
    const sourceChanged = nativeChange.ownerEnd !== this.rawEnd;
    const lifecycleChanged = nextState !== this.state;
    const preserveTailRecords = !sourceChanged && !lifecycleChanged;
    if (preserveTailRecords) {
      tailDrafts = [];
    } else if (nextState === "open" && this.inlineSettlement === "native-tail") {
      const tailStart = previousTail?.sourceRange.from ?? completePrefixEnd;
      if (nativeChange.ownerEnd < tailStart) {
        return {
          ownerStart: this.ownerStart,
          expectedRevision,
          mode: nativeChange.mode,
          requiresOwnerReplacement: true,
          ...(nativeChange.rootResumeFrom === undefined ? {} : { rootResumeFrom: nativeChange.rootResumeFrom }),
        };
      }
      const tailSourceText = this.readParagraphSourceText(sourceSnapshot, tailStart, nativeChange.ownerEnd, sourceTextReader);
      omittedRangeStart = tailSourceText.sourceRange.from;
      updatedOmittedRanges = this.replaceOmittedRanges(omittedRangeStart, nativeChange.ownerEnd, tailSourceText.omittedRanges);
      tailDrafts = this.prepareOpenTail(
        sourceSnapshot,
        tailStart,
        nativeChange.ownerEnd,
        completeSpanCount,
        previousTail,
        tailSourceText,
      );
    } else if (this.inlineSettlement === "original-context") {
      if (completeSpanCount !== 0) {
        return {
          ownerStart: this.ownerStart,
          expectedRevision,
          mode: nativeChange.mode,
          requiresOwnerReplacement: true,
          ...(nativeChange.rootResumeFrom === undefined ? {} : { rootResumeFrom: nativeChange.rootResumeFrom }),
        };
      }
      const sourceText = this.readParagraphSourceText(sourceSnapshot, this.ownerStart, nativeChange.ownerEnd, sourceTextReader);
      omittedRangeStart = sourceText.sourceRange.from;
      updatedOmittedRanges = this.replaceOmittedRanges(omittedRangeStart, nativeChange.ownerEnd, sourceText.omittedRanges);
      const parsed = this.parseWithAttempts(sourceText.text);
      const sourceRevision = previousTail
        ? nextRevision(previousTail.sourceRevision, "Paragraph span source")
        : nextRevision(this.revision, "Paragraph owner");
      const emptyDraft = emptyProjectedSourceDraft(0, sourceText, sourceRevision, nextState === "open");
      if (sourceText.text.length === 0) {
        tailDrafts = emptyDraft ? [emptyDraft] : [];
      } else {
        tailDrafts = [{
          index: 0,
          from: sourceText.sourceRange.from,
          to: sourceText.sourceRange.to,
          sourceRevision,
          isProvisional: nextState === "open",
          nodes: parsed.nodes,
          attemptedReferences: parsed.attemptedReferences,
          sourceText,
        }];
      }
    } else {
      const tailStart = previousTail?.sourceRange.from ?? completePrefixEnd;
      const sourceText = this.readParagraphSourceText(sourceSnapshot, tailStart, nativeChange.ownerEnd, sourceTextReader);
      omittedRangeStart = sourceText.sourceRange.from;
      updatedOmittedRanges = this.replaceOmittedRanges(omittedRangeStart, nativeChange.ownerEnd, sourceText.omittedRanges);
      const rawTail = sourceText.text;
      this.countInlineUnits(rawTail.length);
      const settlement = this.inlineParser.parseSettledPrefix(rawTail);
      let parsed: { readonly nodes: InlineNode[]; readonly attemptedReferences: readonly string[] };
      const drafts: ParagraphDraft[] = [];
      let index = completeSpanCount;
      const settledTo = Math.min(rawTail.length, settlement.settledTo);
      if (settledTo > 0) {
        const settledSourceText = sourceText.slice(0, settledTo);
        drafts.push({
          index,
          from: settledSourceText.sourceRange.from,
          to: settledSourceText.sourceRange.to,
          sourceRevision: previousTail
            ? nextRevision(previousTail.sourceRevision, "Paragraph span source")
            : nextRevision(this.revision, "Paragraph owner"),
          isProvisional: false,
          nodes: settlement.nodes,
          attemptedReferences: Array.from(settlement.attemptedReferences),
          sourceText: settledSourceText,
        });
        index += 1;
      }
      if (settledTo < rawTail.length) {
        const provisionalSourceText = sourceText.slice(settledTo, rawTail.length);
        parsed = this.parseWithAttempts(provisionalSourceText.text);
        drafts.push({
          index,
          from: provisionalSourceText.sourceRange.from,
          to: provisionalSourceText.sourceRange.to,
          sourceRevision: previousTail && drafts.length === 0
            ? nextRevision(previousTail.sourceRevision, "Paragraph span source")
            : nextRevision(this.revision, "Paragraph owner"),
          isProvisional: false,
          nodes: parsed.nodes,
          attemptedReferences: parsed.attemptedReferences,
          sourceText: provisionalSourceText,
        });
      }
      if (drafts.length === 0) {
        const emptyDraft = emptyProjectedSourceDraft(
          index,
          sourceText,
          previousTail
            ? nextRevision(previousTail.sourceRevision, "Paragraph span source")
            : nextRevision(this.revision, "Paragraph owner"),
          false,
        );
        if (emptyDraft) drafts.push(emptyDraft);
      }
      tailDrafts = drafts;
    }

    const acceptedSource = sourceSnapshot;
    const oldTail = this.spanIndex.readRange(completeSpanCount, this.spanIndex.length);
    const tailRecords = preserveTailRecords
      ? oldTail
      : tailDrafts.map((draft) => this.createSpanRecord(draft, acceptedSource, sourceTextReader));
    const nextIndex = preserveTailRecords
      ? this.spanIndex
      : this.spanIndex.replaceTail(completeSpanCount, tailRecords);
    if (omittedRangeStart !== undefined) this.omittedRanges = updatedOmittedRanges;
    const changed = sourceChanged || lifecycleChanged || to !== this.processedTo || nextIndex !== this.spanIndex;
    if (changed) {
      if (nextIndex !== this.spanIndex) {
        for (const span of oldTail) this.removeDependencies(span);
        this.spanIndex = nextIndex;
        for (const span of tailRecords) this.installDependencies(span);
      }
      this.revision = nextRevision(this.revision, "Root paragraph owner");
      this.cachedSnapshot = undefined;
    }
    this.rawEnd = nativeChange.ownerEnd;
    this.processedTo = to;
    this.state = nextState;
    const fromSpan = preserveTailRecords ? this.spanIndex.length : completeSpanCount;
    const spans = preserveTailRecords
      ? EMPTY_SPAN_RECORDS
      : this.spanIndex.readRange(completeSpanCount, this.spanIndex.length);
    return {
      paragraph: this.getMetadata(),
      expectedRevision,
      fromSpan,
      spans,
      mode: nativeChange.mode,
      requiresOwnerReplacement: false,
      ...(nativeChange.rootResumeFrom === undefined ? {} : { rootResumeFrom: nativeChange.rootResumeFrom }),
    };
  }

  finalize(
    nativeChange: ParagraphSourceTransition,
    sourceSnapshot = this.source.snapshot(),
    sourceTextReader = this.sourceTextReader,
  ): RootParagraphSourceChange {
    if (this.state === "finalized") {
      return {
        paragraph: this.getMetadata(),
        expectedRevision: this.revision,
        fromSpan: this.spanIndex.completeSpanCount,
        spans: EMPTY_SPAN_RECORDS,
        mode: nativeChange.mode,
        requiresOwnerReplacement: false,
      };
    }
    if (sourceSnapshot !== this.source.snapshot()
      || nativeChange.ownerStart !== this.ownerStart || nativeChange.processedTo !== this.processedTo) {
      throw new RangeError("Paragraph finalization is stale for this canonical source owner");
    }
    this.sourceTextReader = sourceTextReader;
    const expectedRevision = this.revision;
    if (nativeChange.requiresOwnerReplacement) {
      return {
        ownerStart: this.ownerStart,
        expectedRevision,
        mode: nativeChange.mode,
        requiresOwnerReplacement: true,
        ...(nativeChange.replacementNode ? { replacementNode: nativeChange.replacementNode } : {}),
        ...(nativeChange.replacementSourceOffset === undefined ? {} : { replacementSourceOffset: nativeChange.replacementSourceOffset }),
      };
    }

    if (this.state === "closed") {
      if (nativeChange.ownerEnd !== this.rawEnd) {
        return {
          ownerStart: this.ownerStart,
          expectedRevision,
          mode: nativeChange.mode,
          requiresOwnerReplacement: true,
        };
      }
      this.state = "finalized";
      this.revision = nextRevision(this.revision, "Root paragraph owner");
      this.cachedSnapshot = undefined;
      return {
        paragraph: this.getMetadata(),
        expectedRevision,
        fromSpan: this.spanIndex.length,
        spans: EMPTY_SPAN_RECORDS,
        mode: nativeChange.mode,
        requiresOwnerReplacement: false,
      };
    }

    const completeSpanCount = this.spanIndex.completeSpanCount;
    const previousTail = this.spanIndex.get(completeSpanCount);
    const completePrefixEnd = completeSpanCount > 0
      ? this.spanIndex.get(completeSpanCount - 1)?.sourceRange.to
      : this.ownerStart;
    if (completePrefixEnd === undefined || nativeChange.ownerEnd < completePrefixEnd) {
      return {
        ownerStart: this.ownerStart,
        expectedRevision,
        mode: nativeChange.mode,
        requiresOwnerReplacement: true,
      };
    }
    const tailStart = previousTail?.sourceRange.from ?? completePrefixEnd;
    const finalSource = sourceSnapshot;
    const sourceText = this.readParagraphSourceText(finalSource, tailStart, nativeChange.ownerEnd, sourceTextReader);
    const nextOmittedRanges = this.replaceOmittedRanges(sourceText.sourceRange.from, nativeChange.ownerEnd, sourceText.omittedRanges);
    const rawTail = sourceText.text;
    let finalNodes: InlineNode[];
    let attemptedReferences: readonly string[];
    if (this.inlineSettlement === "original-context") {
      const parsed = this.parseWithAttempts(rawTail);
      finalNodes = parsed.nodes;
      attemptedReferences = parsed.attemptedReferences;
    } else {
      this.countInlineUnits(rawTail.length);
      const hasMixedSpanContent = this.hasSpanContentCandidate(rawTail);
      const settled = this.inlineParser.parseSettledPrefix(rawTail);
      const settledTo = Math.min(rawTail.length, settled.settledTo);
      finalNodes = Array.from(settled.nodes);
      const references = new Set(settled.attemptedReferences);
      if (settledTo < rawTail.length && !hasMixedSpanContent) {
        const parsed = this.parseWithAttempts(rawTail.slice(settledTo));
        finalNodes.push(...parsed.nodes);
        for (const label of parsed.attemptedReferences) references.add(label);
      }
      attemptedReferences = Object.freeze(Array.from(references).sort());
    }
    const tailRecords: ParagraphSpanRecord[] = rawTail.length === 0
      && sourceText.sourceRange.from === sourceText.sourceRange.to
      ? []
      : [this.createSpanRecord({
          index: completeSpanCount,
          from: sourceText.sourceRange.from,
          to: sourceText.sourceRange.to,
          sourceRevision: previousTail ? nextRevision(previousTail.sourceRevision, "Paragraph span source") : nextRevision(this.revision, "Paragraph owner"),
          isProvisional: false,
          nodes: finalNodes,
          attemptedReferences,
          sourceText,
        }, finalSource, sourceTextReader)];
    const oldTail = this.spanIndex.readRange(completeSpanCount, this.spanIndex.length);
    const nextIndex = this.spanIndex.replaceTail(completeSpanCount, tailRecords);
    for (const span of oldTail) this.removeDependencies(span);
    this.spanIndex = nextIndex;
    this.omittedRanges = nextOmittedRanges;
    for (const span of tailRecords) this.installDependencies(span);
    this.rawEnd = nativeChange.ownerEnd;
    this.processedTo = nativeChange.processedTo;
    this.state = "finalized";
    this.revision = nextRevision(this.revision, "Root paragraph owner");
    this.cachedSnapshot = undefined;
    const spans = this.spanIndex.readRange(completeSpanCount, this.spanIndex.length);
    return {
      paragraph: this.getMetadata(),
      expectedRevision,
      fromSpan: completeSpanCount,
      spans,
      mode: nativeChange.mode,
      requiresOwnerReplacement: false,
      ...(nativeChange.rootResumeFrom === undefined ? {} : { rootResumeFrom: nativeChange.rootResumeFrom }),
    };
  }

  invalidateLinkReferences(labels: ReadonlySet<string>): ParagraphSemanticChange | null {
    if (labels.size === 0) return null;
    const indices = new Set<number>();
    for (const label of labels) {
      const dependent = this.spansByDependency.get(dependencyKey("link", label));
      if (dependent) for (const index of dependent) indices.add(index);
    }
    if (indices.size === 0) return null;
    const ordered = Array.from(indices).sort((left, right) => left - right);
    const updates: PreparedParagraphSpanUpdate[] = [];
    const source = this.source.snapshot();
    for (const index of ordered) {
      const span = this.spanIndex.get(index);
      if (!span) continue;
      const prepared = this.createSpanRecord({
        index: span.index,
        from: span.sourceRange.from,
        to: span.sourceRange.to,
        sourceRevision: span.sourceRevision,
        isProvisional: span.isProvisional,
        nodes: span.nodes,
        attemptedReferences: span.attemptedReferences,
      }, source, this.sourceTextReader, true);
      if (inlineNodesEqual(span.nodes, prepared.nodes)
        && span.children === prepared.children
        && stringListsEqual(span.attemptedReferences, prepared.attemptedReferences)) continue;
      updates.push({
        index,
        expectedSourceRevision: span.sourceRevision,
        nodes: prepared.nodes,
        ...(prepared.children ? { children: prepared.children } : {}),
        attemptedReferences: prepared.attemptedReferences,
      });
    }
    return this.applyPreparedSpanUpdates(updates, "link_reference_definition");
  }

  dependentSpanIndices(kind: ParagraphDependencyKind, labels: ReadonlySet<string>): readonly number[] {
    const indices = new Set<number>();
    for (const label of labels) {
      const dependent = this.spansByDependency.get(dependencyKey(kind, label));
      if (dependent) for (const index of dependent) indices.add(index);
    }
    return Object.freeze(Array.from(indices).sort((left, right) => left - right));
  }

  applyPreparedSpanUpdates(
    updates: readonly PreparedParagraphSpanUpdate[],
    cause = "paragraph_prepared_meaning",
  ): ParagraphSemanticChange | null {
    // Finalized source may still receive source-neutral semantic numbering updates.
    if (updates.length === 0) return null;
    const replacements: ParagraphSpanUpdate[] = [];
    let previousIndex = -1;
    for (const update of updates) {
      const current = this.spanIndex.get(update.index);
      if (!current || update.index <= previousIndex || current.sourceRevision !== update.expectedSourceRevision) {
        throw new RangeError("Paragraph prepared span update is stale or not in ascending unique order");
      }
      const next: ParagraphSpanRecord = {
        ...current,
        nodes: update.nodes,
        ...(update.children ? { children: update.children } : {}),
        attemptedReferences: update.attemptedReferences,
      };
      if (inlineNodesEqual(current.nodes, next.nodes)
        && current.children === next.children
        && stringListsEqual(current.attemptedReferences, next.attemptedReferences)) {
        previousIndex = update.index;
        continue;
      }
      replacements.push({ index: update.index, expectedSourceRevision: update.expectedSourceRevision, span: next });
      previousIndex = update.index;
    }
    if (replacements.length === 0) return null;

    const expectedRevision = this.revision;
    const nextIndex = this.spanIndex.updateSpans(replacements);
    const appliedUpdates = replacements.map((update) => {
      const span = nextIndex.get(update.index);
      if (!span) throw new Error("Updated paragraph span is missing from its persistent index");
      return Object.freeze({
        index: update.index,
        expectedSourceRevision: update.expectedSourceRevision,
        span,
      });
    });
    for (const update of replacements) {
      const current = this.spanIndex.get(update.index);
      if (current) this.removeDependencies(current);
    }
    this.spanIndex = nextIndex;
    for (const update of appliedUpdates) this.installDependencies(update.span);
    this.revision = nextRevision(this.revision, "Root paragraph owner");
    this.cachedSnapshot = undefined;
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters?.recordInvalidation(cause, this.id, ["paragraph.spans"]);
    }
    return Object.freeze({
      paragraphOwnerId: this.id,
      generation: this.generation,
      expectedRevision,
      revision: this.revision,
      updates: Object.freeze(appliedUpdates),
    });
  }
  refreshPreparedMeaning(
    source: SourceSnapshot,
    globallyUnmatchedBareAnchorOffsets: ReadonlySet<number>,
    cause = "paragraph_document_context",
  ): ParagraphSemanticChange | null {
    if (!this.prepareSpanChildren) return null;
    const updates: PreparedParagraphSpanUpdate[] = [];
    for (const span of this.spanIndex.materialize()) {
      const sourceText = this.readParagraphSourceText(source, span.sourceRange.from, span.sourceRange.to);
      const newlyMatched = findUnmatchedBareAnchorOffsets(sourceText.text).some((offset) =>
        !globallyUnmatchedBareAnchorOffsets.has(sourceText.sourceRange.from + offset),
      );
      if (!newlyMatched) continue;
      const draft: ParagraphDraft = {
        index: span.index,
        from: span.sourceRange.from,
        to: span.sourceRange.to,
        sourceRevision: span.sourceRevision,
        isProvisional: span.isProvisional,
        nodes: span.nodes,
        attemptedReferences: span.attemptedReferences,
        sourceText,
      };
      const refreshed = this.createSpanRecord(draft, source, this.sourceTextReader, true);
      updates.push({
        index: span.index,
        expectedSourceRevision: span.sourceRevision,
        nodes: refreshed.nodes,
        ...(refreshed.children ? { children: refreshed.children } : {}),
        attemptedReferences: refreshed.attemptedReferences,
      });
    }
    return this.applyPreparedSpanUpdates(updates, cause);
  }


  private createSpanRecord(
    draft: ParagraphDraft,
    source: SourceSnapshot,
    sourceTextReader = this.sourceTextReader,
    refreshInlineMeaning = false,
  ): ParagraphSpanRecord {
    if (!this.prepareSpanChildren && !refreshInlineMeaning) return recordFromDraft(this.id, draft);
    const sourceText = draft.sourceText ?? this.readParagraphSourceText(source, draft.from, draft.to, sourceTextReader);
    const content = sourceText.text;
    if (!this.prepareSpanChildren) {
      const parsed = this.parseWithAttempts(content, draft.isProvisional);
      return recordFromDraft(this.id, { ...draft, nodes: parsed.nodes, attemptedReferences: parsed.attemptedReferences });
    }
    const prepared = this.prepareSpanChildren(content, draft.from, draft.isProvisional, this.id, this.generation, draft.index);
    if (!prepared) {
      const parsed = refreshInlineMeaning || (draft.nodes.length === 0 && content.length > 0)
        ? this.parseWithAttempts(content, draft.isProvisional)
        : undefined;
      return recordFromDraft(this.id, parsed
        ? { ...draft, nodes: parsed.nodes, attemptedReferences: parsed.attemptedReferences }
        : draft);
    }
    const hasHtmlCandidate = content.includes("<");
    const sourceNodes = prepared.nodes ?? draft.nodes;
    const preparedNodes = hasHtmlCandidate ? literalizeFallbackHtml(sourceNodes) : sourceNodes;
    const preparedChildren = prepared.children === undefined
      ? undefined
      : hasHtmlCandidate
        ? literalizeFallbackHtmlInChildren(prepared.children)
        : prepared.children;
    const children = preparedChildren?.map((child) => {
      const logicalFrom = child.range.from - draft.from;
      const logicalTo = child.range.to - draft.from;
      if (logicalFrom < 0 || logicalTo > content.length) {
        throw new RangeError("Prepared paragraph child range escaped its logical source span");
      }
      return { ...child, range: sourceText.rangeFor(logicalFrom, logicalTo) };
    });
    return recordFromDraft(this.id, {
      ...draft,
      nodes: children ? [] : Array.from(preparedNodes ?? draft.nodes),
      attemptedReferences: prepared.attemptedReferences,
      ...(children ? { children } : {}),
    });
  }

  private prepareOpenTail(
    source: SourceSnapshot,
    from: number,
    to: number,
    firstIndex: number,
    previousTail: ParagraphSpanRecord | undefined,
    mappedSourceText = this.readParagraphSourceText(source, from, to),
  ): ParagraphDraft[] {
    const raw = mappedSourceText.text;
    this.countInlineUnits(raw.length);
    const settlement = this.inlineParser.parseSettledPrefix(raw);
    const settledTo = Math.min(raw.length, settlement.settledTo);
    const settledRevision = previousTail
      ? nextRevision(previousTail.sourceRevision, "Paragraph span source")
      : nextRevision(this.revision, "Paragraph owner");
    const drafts: ParagraphDraft[] = [];
    let cursor = 0;
    let index = firstIndex;
    if (settledTo > 0) {
      const settledSourceText = mappedSourceText.slice(0, settledTo);
      drafts.push({
        index,
        from: settledSourceText.sourceRange.from,
        to: settledSourceText.sourceRange.to,
        sourceRevision: settledRevision,
        isProvisional: false,
        nodes: settlement.nodes,
        attemptedReferences: Array.from(settlement.attemptedReferences),
        sourceText: settledSourceText,
      });
      cursor = settledTo;
      index += 1;
    }
    if (cursor < raw.length) {
      const tailSourceText = mappedSourceText.slice(cursor, raw.length);
      const parsed = this.parseWithAttempts(tailSourceText.text, true);
      drafts.push({
        index,
        from: tailSourceText.sourceRange.from,
        to: tailSourceText.sourceRange.to,
        sourceRevision: settledTo > 0
          ? nextRevision(settledRevision, "Paragraph span source")
          : settledRevision,
        isProvisional: true,
        nodes: parsed.nodes,
        attemptedReferences: parsed.attemptedReferences,
        sourceText: tailSourceText,
      });
    }
    if (drafts.length === 0) {
      const emptyDraft = emptyProjectedSourceDraft(index, mappedSourceText, settledRevision, true);
      if (emptyDraft) drafts.push(emptyDraft);
    }
    return drafts;
  }


  private readParagraphSourceText(
    source: SourceSnapshot,
    from: number,
    to: number,
    reader = this.sourceTextReader,
  ): ParagraphSourceText {
    const mapped = reader(source, from, to);
    if (mapped.sourceRange.from !== from || mapped.sourceRange.to !== to || typeof mapped.text !== "string") {
      throw new RangeError("Paragraph source reader must preserve the requested authored physical extent");
    }
    return mapped;
  }

  private hasSpanContentCandidate(content: string): boolean {
    return this.prepareSpanChildren !== undefined && (content.includes("<") || content.includes("{"));
  }

  private parseWithAttempts(content: string, provisional = false): { readonly nodes: InlineNode[]; readonly attemptedReferences: readonly string[] } {
    this.countInlineUnits(content.length);
    if (this.hasSpanContentCandidate(content)) {
      return { nodes: [], attemptedReferences: Object.freeze([]) };
    }
    const attempted = new Set<string>();
    const nodes = provisional && this.prepareProvisionalInline
      ? this.prepareProvisionalInline(content, (label) => attempted.add(label))
      : this.inlineParser.parse(content, {
          cache: false,
          onAttemptedReference: (label) => attempted.add(label),
        });
    return { nodes: Array.from(nodes), attemptedReferences: Object.freeze(Array.from(attempted).sort()) };
  }


  private countInlineUnits(units: number): void {
    if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
      this.counters?.recordInlineSourceUnits(units, "engine");
    }
  }

  private addDependency(dependency: string, spanIndex: number): void {
    let indices = this.spansByDependency.get(dependency);
    if (!indices) {
      indices = new Set<number>();
      this.spansByDependency.set(dependency, indices);
    }
    indices.add(spanIndex);
  }

  private removeDependency(dependency: string, spanIndex: number): void {
    const indices = this.spansByDependency.get(dependency);
    if (!indices) return;
    indices.delete(spanIndex);
    if (indices.size === 0) this.spansByDependency.delete(dependency);
  }

  private installDependencies(span: ParagraphSpanRecord): void {
    for (const label of span.attemptedReferences) this.addDependency(dependencyKey("link", label), span.index);
    visitFootnoteDependencies(span.nodes, (label) => this.addDependency(dependencyKey("footnote", label), span.index));
  }

  private removeDependencies(span: ParagraphSpanRecord): void {
    for (const label of span.attemptedReferences) this.removeDependency(dependencyKey("link", label), span.index);
    visitFootnoteDependencies(span.nodes, (label) => this.removeDependency(dependencyKey("footnote", label), span.index));
  }

}
