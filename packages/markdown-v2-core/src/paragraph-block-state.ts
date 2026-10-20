import { AppendSourceDocument, createSourceWindow, type SourceSnapshot } from "./source-document";
import { createParagraphSpanIndex } from "./paragraph-span-index";
import type {
  ParagraphBlockSnapshot,
  ParagraphBlockSourceMetadata,
  ParagraphSpanIndex,
  ParagraphSpanRecord,
} from "./paragraph-records";
import type { ParagraphRecordCounterStage, ParagraphRecordWorkCounters } from "./paragraph-span-index";
import type { Patch } from "./types";

export interface ParagraphStateWorkCounters extends ParagraphRecordWorkCounters {
  recordSourceUnitsRead?(count: number, stage?: ParagraphRecordCounterStage): void;
  recordSourceUnitsMaterialized?(count: number, stage?: ParagraphRecordCounterStage): void;
  recordSourceDirectoryEntriesCopied?(count: number, stage?: ParagraphRecordCounterStage): void;
  recordStoreRecordsTouched?(count: number, stage?: ParagraphRecordCounterStage): void;
}

export interface ManagedParagraphStateOptions {
  readonly counters?: ParagraphStateWorkCounters;
  readonly counterStage?: ParagraphRecordCounterStage;
}

export interface ManagedParagraphViewState {
  readonly source: ParagraphBlockSourceMetadata;
  readonly spans: ParagraphSpanIndex;
  readonly sourceSnapshot: SourceSnapshot;
}

export type ManagedParagraphPatchResult =
  | { readonly state: ManagedParagraphViewState }
  | { readonly reason: string };

interface ManagedParagraphSourceOwner {
  readonly document?: AppendSourceDocument;
  readonly completedLength: number;
  readonly counters?: ParagraphStateWorkCounters;
}


declare const __STREAM_MDX_COUNTERS__: boolean | undefined;

const sourceOwnerByState = new WeakMap<ManagedParagraphViewState, ManagedParagraphSourceOwner>();


function copyParagraphSource(source: ParagraphBlockSourceMetadata): ParagraphBlockSourceMetadata {
  return {
    paragraphOwnerId: source.paragraphOwnerId,
    generation: source.generation,
    revision: source.revision,
    state: source.state,
    processedTo: source.processedTo,
    completeSpanCount: source.completeSpanCount,
    spanCount: source.spanCount,
    sourceRange: { from: source.sourceRange.from, to: source.sourceRange.to },
  };
}

function freezeParagraphSource(source: ParagraphBlockSourceMetadata): ParagraphBlockSourceMetadata {
  const copy = copyParagraphSource(source);
  Object.freeze(copy.sourceRange);
  return Object.freeze(copy);
}

function assertParagraphSource(source: ParagraphBlockSourceMetadata, rawLength: number): void {
  const range = source?.sourceRange;
  if (
    typeof source?.paragraphOwnerId !== "string" ||
    source.paragraphOwnerId.length === 0 ||
    !Number.isSafeInteger(source.generation) ||
    source.generation < 0 ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 0 ||
    !Number.isSafeInteger(source.processedTo) ||
    source.processedTo < 0 ||
    !Number.isSafeInteger(source.completeSpanCount) ||
    source.completeSpanCount < 0 ||
    !Number.isSafeInteger(source.spanCount) ||
    source.spanCount < source.completeSpanCount ||
    (source.state !== "open" && source.state !== "closed" && source.state !== "finalized") ||
    !range ||
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 0 ||
    range.to < range.from ||
    range.to - range.from !== rawLength ||
    (source.state !== "open" && source.spanCount !== source.completeSpanCount)
  ) throw new RangeError("Paragraph source metadata is invalid");
}

function validRange(range: { readonly from: number; readonly to: number }, within: { readonly from: number; readonly to: number }): boolean {
  return Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to) &&
    range.from >= within.from && range.to >= range.from && range.to <= within.to;
}

function assertParagraphSpanSource(
  span: ParagraphSpanRecord,
  index: number,
  source: ParagraphBlockSourceMetadata,
): void {
  if (
    !span ||
    span.id !== `${source.paragraphOwnerId}:span:${index}` ||
    span.index !== index ||
    !Number.isSafeInteger(span.sourceRevision) ||
    span.sourceRevision < 0 ||
    typeof span.isProvisional !== "boolean" ||
    !Array.isArray(span.nodes) ||
    !Array.isArray(span.attemptedReferences) ||
    !validRange(span.sourceRange, source.sourceRange)
  ) throw new RangeError("Paragraph span identity or source range is invalid");
}

function assertSpanSourceMatches(
  span: ParagraphSpanRecord,
  source: ParagraphBlockSourceMetadata,
  sourceLength: number,
): void {
  if (!validRange(span.sourceRange, source.sourceRange)) {
    throw new RangeError("Paragraph span source range is outside its owner");
  }
  const from = span.sourceRange.from - source.sourceRange.from;
  const to = span.sourceRange.to - source.sourceRange.from;
  if (from < 0 || to < from || to > sourceLength) {
    throw new RangeError("Paragraph span source range exceeds its retained source");
  }
}

function isSameParagraphSource(left: ParagraphSpanRecord, right: ParagraphSpanRecord): boolean {
  return Boolean(right && right.sourceRange) &&
    left.id === right.id &&
    left.index === right.index &&
    left.sourceRange.from === right.sourceRange.from &&
    left.sourceRange.to === right.sourceRange.to &&
    left.sourceRevision === right.sourceRevision &&
    left.isProvisional === right.isProvisional;
}

function createManagedParagraphView(
  source: ParagraphBlockSourceMetadata,
  spans: ParagraphSpanIndex,
  sourceSnapshot: SourceSnapshot,
  owner: ManagedParagraphSourceOwner,
): ManagedParagraphViewState {
  const view = Object.freeze({ source: freezeParagraphSource(source), spans, sourceSnapshot });
  sourceOwnerByState.set(view, owner);
  return view;
}

function createParagraphSourceSnapshot(
  document: AppendSourceDocument,
  ownedLength: number,
  counters?: ParagraphStateWorkCounters,
): SourceSnapshot {
  const backing = document.snapshot();
  if (ownedLength > backing.length) throw new RangeError("Paragraph source snapshot exceeds its retained source log");
  let cachedSource: string | undefined;
  return Object.freeze({
    lineChunks: true as const,
    length: ownedLength,
    chunk(from: number): string {
      const start = Math.max(0, from);
      if (start >= ownedLength) return "";
      return backing.chunk(start).slice(0, ownedLength - start);
    },
    read(from: number, to: number): string {
      const start = Math.max(0, from);
      const end = Math.min(ownedLength, to);
      return start >= end ? "" : backing.read(start, end);
    },
    materialize(): string {
      if (cachedSource !== undefined) return cachedSource;
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        counters?.recordSourceUnitsMaterialized?.(ownedLength, "store");
      }
      cachedSource = backing.read(0, ownedLength);
      return cachedSource;
    },
  });
}

function completeParagraphSourceLength(
  source: ParagraphBlockSourceMetadata,
  spans: ParagraphSpanIndex,
): number {
  const provisional = source.spanCount > source.completeSpanCount
    ? spans.get(source.completeSpanCount)
    : undefined;
  const end = provisional?.sourceRange.from ?? source.sourceRange.to;
  const length = end - source.sourceRange.from;
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Completed paragraph source range is invalid");
  return length;
}

function assertSnapshotSpans(
  source: ParagraphBlockSourceMetadata,
  spans: ParagraphSpanIndex,
  sourceLength: number,
): void {
  if (spans.length !== source.spanCount || spans.completeSpanCount !== source.completeSpanCount) {
    throw new RangeError("Paragraph snapshot span counts do not match its records");
  }
  let priorEnd = source.sourceRange.from;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans.get(index);
    if (!span) throw new RangeError("Paragraph snapshot span index is incomplete");
    assertSpanSourceMatches(span, source, sourceLength);
    if (span.sourceRange.from < priorEnd) throw new RangeError("Paragraph span source ranges overlap or regress");
    priorEnd = span.sourceRange.to;
  }
}

export function createManagedParagraphState(
  snapshot: ParagraphBlockSnapshot,
  ownerId: string,
  options?: ManagedParagraphStateOptions,
  canonicalSource?: SourceSnapshot,
): ManagedParagraphViewState {
  let counters: ParagraphStateWorkCounters | undefined;
  let counterStage: ParagraphRecordCounterStage = "snapshot";
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    counters = options?.counters;
    counterStage = options?.counterStage ?? "snapshot";
  }
  if (
    !snapshot ||
    typeof snapshot.raw !== "string" ||
    snapshot.paragraphOwnerId !== ownerId ||
    !Array.isArray(snapshot.spans)
  ) throw new RangeError("Paragraph snapshot owner or shape is invalid");
  assertParagraphSource(snapshot, snapshot.raw.length);
  const spans = counters
    ? createParagraphSpanIndex({ spans: snapshot.spans, campaignCounters: counters, counterStage })
    : createParagraphSpanIndex({ spans: snapshot.spans });
  assertSnapshotSpans(snapshot, spans, snapshot.raw.length);
  const completedLength = completeParagraphSourceLength(snapshot, spans);
  if (completedLength > snapshot.raw.length) throw new RangeError("Completed paragraph source exceeds its owned range");
  let document: AppendSourceDocument | undefined;
  let sourceSnapshot: SourceSnapshot;
  if (canonicalSource) {
    const { from, to } = snapshot.sourceRange;
    if (to > canonicalSource.length || canonicalSource.read(from, to) !== snapshot.raw) {
      throw new RangeError("Paragraph snapshot source does not match canonical input");
    }
    sourceSnapshot = createSourceWindow(canonicalSource, from, to);
  } else {
    document = counters
      ? new AppendSourceDocument({ counters } as never)
      : new AppendSourceDocument();
    document.append(snapshot.raw);
    sourceSnapshot = counters
      ? createParagraphSourceSnapshot(document, snapshot.raw.length, counters)
      : createParagraphSourceSnapshot(document, snapshot.raw.length);
  }
  const owner: ManagedParagraphSourceOwner = counters
    ? { document, completedLength, counters }
    : { document, completedLength };
  return createManagedParagraphView(snapshot, spans, sourceSnapshot, owner);
}

export function appendManagedParagraphSpans(
  current: ManagedParagraphViewState,
  ownerId: string,
  patch: Extract<Patch, { op: "appendParagraph" }>,
  canonicalSource?: SourceSnapshot,
): ManagedParagraphPatchResult {
  const old = current.source;
  const next = patch.paragraph;
  const owner = sourceOwnerByState.get(current);
  if (!owner) return { reason: "paragraph source owner is unavailable" };
  if (
    patch.paragraphOwnerId !== ownerId ||
    patch.paragraphOwnerId !== old.paragraphOwnerId ||
    patch.generation !== old.generation ||
    patch.expectedRevision !== old.revision
  ) return { reason: "stale paragraph owner or revision" };
  if (
    !Number.isSafeInteger(patch.expectedRevision) ||
    !Number.isSafeInteger(patch.revision) ||
    patch.revision !== old.revision + 1 ||
    !Number.isSafeInteger(patch.fromSpan) ||
    patch.fromSpan < 0 ||
    typeof patch.sourceAppend !== "string" ||
    !Array.isArray(patch.spans) ||
    !next ||
    !next.sourceRange ||
    !Number.isSafeInteger(next.sourceRange.from) ||
    !Number.isSafeInteger(next.sourceRange.to) ||
    next.revision !== patch.revision
  ) return { reason: "invalid paragraph append envelope" };

  const oldLength = current.sourceSnapshot.length;
  const nextLength = next.sourceRange.to - next.sourceRange.from;
  if (old.state === "finalized" || (old.state === "closed" && !isParagraphLifecycleFinalize(old, next, patch))) {
    return { reason: "paragraph owner is not appendable" };
  }
  if (
    next.paragraphOwnerId !== old.paragraphOwnerId ||
    next.generation !== old.generation ||
    next.sourceRange.from !== old.sourceRange.from ||
    next.processedTo < old.processedTo ||
    next.completeSpanCount < old.completeSpanCount
  ) return { reason: "paragraph source frontier regressed" };
  try {
    assertParagraphSource(next, nextLength);
  } catch (error) {
    return { reason: error instanceof Error ? error.message : "paragraph source metadata is invalid" };
  }

  const metadataOnly = patch.fromSpan === old.spanCount &&
    patch.spans.length === 0 &&
    patch.sourceAppend === "" &&
    nextLength === oldLength &&
    next.completeSpanCount === old.completeSpanCount &&
    next.spanCount === old.spanCount;
    if (next.state !== "open" && next.completeSpanCount !== next.spanCount) {
      return { reason: "closed paragraph cannot retain a provisional span" };
    }
  if (metadataOnly) {
    if (next.sourceRange.to !== old.sourceRange.to) return { reason: "metadata-only paragraph progress changed source" };
    if (old.state === "closed" && next.state !== "finalized") return { reason: "closed paragraph may only finalize" };
    return { state: createManagedParagraphView(next, current.spans, current.sourceSnapshot, owner) };
  }

  const retractingProvisionalTail = nextLength < oldLength;
  if (patch.fromSpan !== old.completeSpanCount) {
    return { reason: "paragraph append does not begin at the provisional frontier" };
  }
  if (next.spanCount !== patch.fromSpan + patch.spans.length) {
    return { reason: "paragraph append span counts do not match their records" };
  }
  if (retractingProvisionalTail) {
    if (
      old.state !== "open" ||
      old.spanCount !== old.completeSpanCount + 1 ||
      patch.sourceAppend !== ""
    ) return { reason: "paragraph can only retract an open provisional source tail" };
  } else if (nextLength !== oldLength + patch.sourceAppend.length) {
    return { reason: "paragraph source append length is inconsistent" };
  }
  if (old.state === "closed" && !isParagraphLifecycleFinalize(old, next, patch)) {
    return { reason: "closed paragraph lifecycle change cannot replace source" };
  }
  if (isParagraphLifecycleFinalize(old, next, patch) && (patch.spans.length > 0 || nextLength !== oldLength)) {
    return { reason: "paragraph lifecycle finalization changed spans or source" };
  }

  let spans: ParagraphSpanIndex;
  try {
    spans = current.spans.replaceTail(patch.fromSpan, patch.spans);
  } catch (error) {
    return { reason: error instanceof Error ? error.message : "invalid paragraph span tail" };
  }
  if (spans.length !== next.spanCount || spans.completeSpanCount !== next.completeSpanCount) {
    return { reason: "paragraph append span counts do not match its index" };
  }
  const prefixEnd = patch.fromSpan > 0
    ? current.spans.get(patch.fromSpan - 1)?.sourceRange.to
    : old.sourceRange.from;
  if (prefixEnd === undefined) return { reason: "paragraph append prefix is unavailable" };
  let previousEnd = prefixEnd;
  const completedFrontier = old.sourceRange.from + owner.completedLength;
  for (let offset = 0; offset < patch.spans.length; offset += 1) {
    const span = spans.get(patch.fromSpan + offset);
    if (!span) return { reason: "paragraph append span index is incomplete" };
    try {
      assertParagraphSpanSource(span, patch.fromSpan + offset, next);
      assertSpanSourceMatches(span, next, nextLength);
    } catch (error) {
      return { reason: error instanceof Error ? error.message : "paragraph span source is invalid" };
    }
    if (span.sourceRange.from < previousEnd || span.sourceRange.from < completedFrontier) {
      return { reason: "paragraph append span overlaps or changes completed source" };
    }
    previousEnd = span.sourceRange.to;
  }
  if (spans.length !== spans.completeSpanCount && next.state !== "open") {
    return { reason: "closed paragraph cannot retain a provisional span" };
  }

  const completedLength = completeParagraphSourceLength(next, spans);
  if (completedLength < owner.completedLength || completedLength > nextLength) {
    return { reason: "completed paragraph source frontier is invalid" };
  }
  const nextOwner = appendParagraphSource(
    owner,
    current,
    next,
    patch.sourceAppend,
    nextLength,
    completedLength,
    retractingProvisionalTail,
    canonicalSource,
  );
  let sourceSnapshot = current.sourceSnapshot;
  if (nextLength !== current.sourceSnapshot.length || patch.sourceAppend !== "") {
    if (canonicalSource) {
      sourceSnapshot = createSourceWindow(canonicalSource, next.sourceRange.from, next.sourceRange.to);
    } else if (nextOwner.document) {
      sourceSnapshot = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
        ? createParagraphSourceSnapshot(nextOwner.document, nextLength, nextOwner.counters)
        : createParagraphSourceSnapshot(nextOwner.document, nextLength);
    } else {
      return { reason: "paragraph source document is unavailable" };
    }
  }
  return { state: createManagedParagraphView(next, spans, sourceSnapshot, nextOwner) };
}

export function updateManagedParagraphSpans(
  current: ManagedParagraphViewState,
  ownerId: string,
  patch: Extract<Patch, { op: "updateParagraphSpans" }>,
): ManagedParagraphPatchResult {
  const old = current.source;
  const next = patch.paragraph;
  const owner = sourceOwnerByState.get(current);
  if (!owner) return { reason: "paragraph source owner is unavailable" };
  if (
    patch.paragraphOwnerId !== ownerId ||
    patch.paragraphOwnerId !== old.paragraphOwnerId ||
    patch.generation !== old.generation ||
    patch.expectedRevision !== old.revision
  ) return { reason: "stale paragraph owner or revision" };
  if (
    !Number.isSafeInteger(patch.expectedRevision) ||
    !Number.isSafeInteger(patch.revision) ||
    patch.revision !== old.revision + 1 ||
    !Array.isArray(patch.updates) ||
    patch.updates.length === 0 ||
    !next ||
    !next.sourceRange ||
    next.revision !== patch.revision ||
    !sameParagraphMetadataExceptRevision(old, next)
  ) return { reason: "invalid paragraph semantic update envelope" };

  let previousIndex = -1;
  for (const update of patch.updates) {
    const currentSpan = Number.isSafeInteger(update?.index) && update.index >= 0 ? current.spans.get(update.index) : undefined;
    if (
      !currentSpan ||
      update.index <= previousIndex ||
      update.expectedSourceRevision !== currentSpan.sourceRevision ||
      !update.span ||
      !isSameParagraphSource(currentSpan, update.span)
    ) return { reason: "stale or source-changing paragraph span update" };
    previousIndex = update.index;
  }

  let spans: ParagraphSpanIndex;
  try {
    spans = current.spans.updateSpans(patch.updates);
  } catch (error) {
    return { reason: error instanceof Error ? error.message : "invalid paragraph semantic update" };
  }
  return { state: createManagedParagraphView(next, spans, current.sourceSnapshot, owner) };
}

export function materializeManagedParagraphSnapshot(state: ManagedParagraphViewState): ParagraphBlockSnapshot {
  const owner = sourceOwnerByState.get(state);
  if (!owner) throw new Error("Paragraph source owner is unavailable");
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    owner.counters?.recordStoreRecordsTouched?.(state.spans.length, "snapshot");
  }
  return {
    ...copyParagraphSource(state.source),
    spans: state.spans.materialize(),
    raw: state.sourceSnapshot.materialize(),
  };
}


function isParagraphLifecycleFinalize(
  old: ParagraphBlockSourceMetadata,
  next: ParagraphBlockSourceMetadata,
  patch: Extract<Patch, { op: "appendParagraph" }>,
): boolean {
  return old.state === "closed" &&
    next.state === "finalized" &&
    patch.sourceAppend === "" &&
    patch.spans.length === 0 &&
    patch.fromSpan === old.spanCount &&
    next.processedTo === old.processedTo &&
    next.completeSpanCount === old.completeSpanCount &&
    next.spanCount === old.spanCount &&
    next.sourceRange.from === old.sourceRange.from &&
    next.sourceRange.to === old.sourceRange.to;
}

function sameParagraphMetadataExceptRevision(
  old: ParagraphBlockSourceMetadata,
  next: ParagraphBlockSourceMetadata,
): boolean {
  return next.paragraphOwnerId === old.paragraphOwnerId &&
    next.generation === old.generation &&
    next.state === old.state &&
    next.processedTo === old.processedTo &&
    next.completeSpanCount === old.completeSpanCount &&
    next.spanCount === old.spanCount &&
    next.sourceRange.from === old.sourceRange.from &&
    next.sourceRange.to === old.sourceRange.to;
}


function appendParagraphSource(
  owner: ManagedParagraphSourceOwner,
  current: ManagedParagraphViewState,
  next: ParagraphBlockSourceMetadata,
  sourceAppend: string,
  nextLength: number,
  completedLength: number,
  retractingProvisionalTail: boolean,
  canonicalSource?: SourceSnapshot,
): ManagedParagraphSourceOwner {
  if (completedLength < owner.completedLength || completedLength > nextLength) {
    throw new RangeError("Completed paragraph source frontier is invalid");
  }
  if (canonicalSource) {
    if (nextLength < current.sourceSnapshot.length) {
      if (
        !retractingProvisionalTail ||
        sourceAppend !== "" ||
        nextLength < owner.completedLength ||
        completedLength < owner.completedLength
      ) throw new RangeError("Paragraph source can only retract its provisional tail");
    } else if (nextLength !== current.sourceSnapshot.length + sourceAppend.length) {
      throw new RangeError("Paragraph source append length is inconsistent");
    }
    if (
      sourceAppend.length > 0 &&
      (
        next.sourceRange.to > canonicalSource.length ||
        canonicalSource.read(current.source.sourceRange.to, next.sourceRange.to) !== sourceAppend
      )
    ) throw new RangeError("Paragraph source append does not match canonical input");
    return typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? { document: undefined, completedLength, counters: owner.counters }
      : { document: undefined, completedLength };
  }
  const document = owner.document;
  if (!document) throw new RangeError("Paragraph source document is unavailable");
  const logSnapshot = document.snapshot();
  if (logSnapshot.length < current.sourceSnapshot.length) {
    throw new RangeError("Paragraph source log is shorter than its owned prefix");
  }
  if (nextLength < current.sourceSnapshot.length) {
    if (
      !retractingProvisionalTail ||
      sourceAppend !== "" ||
      nextLength < owner.completedLength ||
      completedLength < owner.completedLength
    ) throw new RangeError("Paragraph source can only retract its provisional tail");
    return typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__
      ? { document, completedLength, counters: owner.counters }
      : { document, completedLength };
  }
  if (nextLength !== current.sourceSnapshot.length + sourceAppend.length) {
    throw new RangeError("Paragraph source append length is inconsistent");
  }

  const overlapLength = Math.min(sourceAppend.length, logSnapshot.length - current.sourceSnapshot.length);
  if (
    overlapLength > 0 &&
    logSnapshot.read(current.sourceSnapshot.length, current.sourceSnapshot.length + overlapLength) !==
      sourceAppend.slice(0, overlapLength)
  ) throw new RangeError("Paragraph source re-extension changed retained provisional bytes");

  const neverLoggedSuffix = sourceAppend.slice(overlapLength);
  if (logSnapshot.length + neverLoggedSuffix.length < nextLength) {
    throw new RangeError("Paragraph source append cannot reach its declared frontier");
  }
  if (neverLoggedSuffix.length > 0) document.append(neverLoggedSuffix);
  if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
    return { document, completedLength, counters: owner.counters };
  }
  return { document, completedLength };
}
