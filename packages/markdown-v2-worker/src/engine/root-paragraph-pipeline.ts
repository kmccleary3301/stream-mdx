import type { SyntaxNode, Tree } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import {
  generateBlockId,
  type AppendSourceDocument,
  type InlineParser,
  type InlineNode,
  type NodeSnapshot,
  type ParagraphBlockSourceMetadata,
  type ParagraphSpanRecord,
  type Patch,
  type SourceSnapshot,
} from "@stream-mdx/core";
import {
  NativeParagraphTailParser,
  type NativeParagraphTailChange,
  type NativeParagraphWindowAttestation,
} from "./native-paragraph-tail";
import { FOOTNOTE_DEFINITION_START } from "../parser/footnote-definition-extension";
import {
  RootParagraphSourceOwner,
  type ParagraphOwnerReplacement,
  type ParagraphSemanticChange,
  type ParagraphSourceChange,
  type ParagraphInlineSettlementMode,
  type PreparedParagraphSpanContent,
  type RootParagraphSourceOwnerCounters,
} from "./root-paragraph-owner";

declare const __STREAM_MDX_COUNTERS__: boolean;

const nativeTailByOwner = new WeakMap<RootParagraphSourceOwner, NativeParagraphTailParser>();

export interface RootParagraphPipelineOptions {
  readonly parser: MarkdownParser;
  readonly inlineParser: InlineParser;
  readonly inlineSettlement: ParagraphInlineSettlementMode;
  readonly attestation?: NativeParagraphWindowAttestation;
  readonly sourceOffset?: number;
  readonly finalized?: boolean;
  readonly counters?: RootParagraphSourceOwnerCounters;
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

export interface RootParagraphPatchChange {
  readonly paragraph: ParagraphBlockSourceMetadata;
  readonly expectedRevision: number;
  readonly fromSpan: number;
  readonly spans: readonly ParagraphSpanRecord[];
  readonly sourceAppend: string;
  /** Private native-parser continuation coordinate; never serialized into the semantic patch. */
  readonly rootResumeFrom?: number;
}

function isRootParagraph(node: SyntaxNode): boolean {
  return node.type.name === "Paragraph" && node.parent?.type.name === "Document" && !node.parent.parent;
}
// Keep plugin-owned footnote definitions on the ordinary block path.
export function isRootFootnoteDefinitionStart(source: SourceSnapshot, sourceOffset: number): boolean {
  if (sourceOffset < 0 || sourceOffset + 2 > source.length || source.read(sourceOffset, sourceOffset + 2) !== "[^") {
    return false;
  }
  return FOOTNOTE_DEFINITION_START.test(source.chunk(sourceOffset));
}


function createRootParagraphOwnerFromSnapshot(
  node: SyntaxNode,
  source: AppendSourceDocument,
  sourceSnapshot: SourceSnapshot,
  generation: number,
  options: RootParagraphPipelineOptions,
): RootParagraphSourceOwner | undefined {
  const sourceOffset = options.sourceOffset ?? 0;
  const from = sourceOffset + node.from;
  if (!isRootParagraph(node) || isRootFootnoteDefinitionStart(sourceSnapshot, from)) return undefined;
  const tailParser = NativeParagraphTailParser.admit(
    options.parser,
    sourceSnapshot,
    node,
    sourceOffset,
    options.attestation,
  );
  const state = options.finalized
    ? "finalized"
    : tailParser.state.phase === "closed"
      ? "closed"
      : "open";
  const to = sourceOffset + node.to;
  const id = generateBlockId(`${from}:paragraph`, "paragraph");
  const owner = typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && options.counters !== undefined
    ? new RootParagraphSourceOwner({
        id,
        generation,
        source,
        inlineParser: options.inlineParser,
        opening: { from, to, state },
        inlineSettlement: options.inlineSettlement,
        ...(options.prepareProvisionalInline ? { prepareProvisionalInline: options.prepareProvisionalInline } : {}),
        ...(options.prepareSpanChildren ? { prepareSpanChildren: options.prepareSpanChildren } : {}),
        counters: options.counters,
      })
    : new RootParagraphSourceOwner({
        id,
        generation,
        source,
        inlineParser: options.inlineParser,
        opening: { from, to, state },
        inlineSettlement: options.inlineSettlement,
        ...(options.prepareProvisionalInline ? { prepareProvisionalInline: options.prepareProvisionalInline } : {}),
        ...(options.prepareSpanChildren ? { prepareSpanChildren: options.prepareSpanChildren } : {}),
      });
  nativeTailByOwner.set(owner, tailParser);
  return owner;
}

/** Admit one parser-owned root paragraph with a caller-selected native lease generation. */
export function createRootParagraphOwnerForNode(
  node: SyntaxNode,
  source: AppendSourceDocument,
  generation: number,
  options: RootParagraphPipelineOptions,
): RootParagraphSourceOwner | undefined {
  if (options.attestation && options.attestation.parser !== options.parser) {
    throw new TypeError("Root paragraph window attestation belongs to a different MarkdownParser");
  }
  return createRootParagraphOwnerFromSnapshot(node, source, source.snapshot(), generation, options);
}


/** Admit only native root Paragraph nodes; syntax-tree ranges remain the source authority. */
export function createRootParagraphOwners(
  tree: Tree,
  source: AppendSourceDocument,
  generation: number,
  options: RootParagraphPipelineOptions,
  excludedSourceStarts?: ReadonlySet<number>,
): readonly RootParagraphSourceOwner[] {
  if (options.attestation && options.attestation.parser !== options.parser) {
    throw new TypeError("Root paragraph window attestation belongs to a different MarkdownParser");
  }
  const sourceSnapshot = source.snapshot();
  const owners: RootParagraphSourceOwner[] = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (excludedSourceStarts?.has((options.sourceOffset ?? 0) + node.from)) continue;
    const owner = createRootParagraphOwnerFromSnapshot(node, source, sourceSnapshot, generation, options);
    if (owner) owners.push(owner);
  }
  return owners;
}

export function rootParagraphNodeSnapshot(owner: RootParagraphSourceOwner): NodeSnapshot {
  const paragraph = owner.createSnapshot();
  return {
    id: owner.id,
    type: "paragraph",
    range: { ...paragraph.sourceRange },
    children: [],
    paragraph,
  };
}

export function advanceRootParagraphOwner(
  owner: RootParagraphSourceOwner,
  source: SourceSnapshot,
  appendedText: string,
): ParagraphSourceChange | ParagraphOwnerReplacement {
  const tail = nativeTailByOwner.get(owner);
  const previous = owner.getMetadata();
  if (appendedText.includes(":") && isRootFootnoteDefinitionStart(source, previous.sourceRange.from)) {
    return {
      ownerStart: previous.sourceRange.from,
      expectedRevision: previous.revision,
      mode: tail?.state.mode ?? "full-configured-context",
      requiresOwnerReplacement: true,
    };
  }
  if (!tail) throw new Error("Native paragraph tail state is unavailable for this owner");
  const nativeChange = tail.append(source, appendedText);
  return owner.accept(previous.processedTo, source.length, nativeChange);
}

export function isFinalizedRootParagraphAppendCandidate(owner: RootParagraphSourceOwner): boolean {
  return nativeTailByOwner.get(owner)?.canAppendAfterFinalize ?? false;
}
export function rootParagraphPendingRootOffset(owner: RootParagraphSourceOwner): number | undefined {
  const tail = nativeTailByOwner.get(owner);
  if (!tail) return undefined;
  const candidate = tail.state.followingRootNodes.find((root) => root.readiness === "provisional");
  return candidate ? candidate.sourceOffset + candidate.node.from : undefined;
}

export function probeFinalizedRootParagraphAppend(
  owner: RootParagraphSourceOwner,
  source: SourceSnapshot,
  appendedText: string,
): NativeParagraphTailChange {
  const tail = nativeTailByOwner.get(owner);
  if (!tail) throw new Error("Native paragraph tail state is unavailable for this owner");
  return tail.appendAfterFinalize(source, appendedText);
}

export function finalizeRootParagraphOwner(
  owner: RootParagraphSourceOwner,
  source: SourceSnapshot,
): ParagraphSourceChange | ParagraphOwnerReplacement {
  const tail = nativeTailByOwner.get(owner);
  if (!tail) throw new Error("Native paragraph tail state is unavailable for this owner");
  const nativeChange = tail.finalize(source);
  const change = owner.finalize(nativeChange);
  if (change.requiresOwnerReplacement || change.rootResumeFrom !== undefined) return change;
  const following = nativeChange.followingRootNodes[0];
  return following ? { ...change, rootResumeFrom: following.lineFrom } : change;
}

export function releaseRootParagraphOwner(owner: RootParagraphSourceOwner): void {
  nativeTailByOwner.delete(owner);
}

export function rootParagraphAppendChange(
  source: SourceSnapshot,
  previous: ParagraphBlockSourceMetadata,
  change: ParagraphSourceChange,
): RootParagraphPatchChange {
  const next = change.paragraph;
  const previousEnd = previous.sourceRange.to;
  const nextEnd = next.sourceRange.to;
  if (next.paragraphOwnerId !== previous.paragraphOwnerId
    || next.generation !== previous.generation
    || next.sourceRange.from !== previous.sourceRange.from
    || nextEnd < next.sourceRange.from) {
    throw new Error("Root paragraph append changed its authored owner identity or range");
  }
  let sourceAppend = "";
  if (nextEnd >= previousEnd) {
    sourceAppend = source.read(previousEnd, nextEnd);
    if (previousEnd + sourceAppend.length !== nextEnd) {
      throw new Error("Root paragraph sourceAppend does not match its authored source range");
    }
  } else if (change.fromSpan !== previous.completeSpanCount || next.completeSpanCount < previous.completeSpanCount) {
    throw new Error("Root paragraph source retraction may replace only the provisional span tail");
  }
  return {
    paragraph: next,
    expectedRevision: change.expectedRevision,
    fromSpan: change.fromSpan,
    spans: change.spans,
    sourceAppend,
    ...(change.rootResumeFrom === undefined ? {} : { rootResumeFrom: change.rootResumeFrom }),
  };
}

export function rootParagraphAppendPatch(
  owner: RootParagraphSourceOwner,
  change: RootParagraphPatchChange,
): Extract<Patch, { op: "appendParagraph" }> {
  return {
    op: "appendParagraph",
    at: { blockId: owner.id },
    paragraphOwnerId: change.paragraph.paragraphOwnerId,
    generation: change.paragraph.generation,
    expectedRevision: change.expectedRevision,
    revision: change.paragraph.revision,
    sourceAppend: change.sourceAppend,
    fromSpan: change.fromSpan,
    spans: change.spans,
    paragraph: owner.getMetadata(),
    meta: { kind: "semantic" },
  };
}

export function rootParagraphSemanticPatch(
  owner: RootParagraphSourceOwner,
  change: ParagraphSemanticChange | null,
): Extract<Patch, { op: "updateParagraphSpans" }> | null {
  if (!change) return null;
  return {
    op: "updateParagraphSpans",
    at: { blockId: owner.id },
    paragraphOwnerId: change.paragraphOwnerId,
    generation: change.generation,
    expectedRevision: change.expectedRevision,
    revision: change.revision,
    updates: change.updates,
    paragraph: owner.getMetadata(),
    meta: { kind: "semantic" },
  };
}

export function rootParagraphChangeNeedsReplacement(
  change: ParagraphSourceChange | ParagraphOwnerReplacement,
): change is ParagraphOwnerReplacement {
  return change.requiresOwnerReplacement;
}

