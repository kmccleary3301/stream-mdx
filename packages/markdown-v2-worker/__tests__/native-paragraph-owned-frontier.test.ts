import assert from "node:assert/strict";
import { GFM, parser, type MarkdownExtension } from "@lezer/markdown";
import { AppendSourceDocument, InlineParser, createBlockCompatibilityExtension } from "@stream-mdx/core";
import { HtmlContinuationExtension } from "../src/parser/html-extension";
import { NativeMarkdownInput } from "../src/engine/native-markdown-input";
import {
  advanceRootParagraphOwner,
  createRootParagraphOwners,
  finalizeRootParagraphOwner,
  rootParagraphAppendChange,
  rootParagraphAppendPatch,
  rootParagraphChangeNeedsReplacement,
  probeFinalizedRootParagraphAppend,
} from "../src/engine/root-paragraph-pipeline";
import { attestNativeParagraphWindowGrammar } from "../src/engine/native-paragraph-tail";

const markdownParser = parser.configure([GFM, createBlockCompatibilityExtension(), HtmlContinuationExtension]);

function createOwner(
  source: AppendSourceDocument,
  inlineParser = new InlineParser({ maxCacheEntries: 0 }),
  parserInstance = markdownParser,
  trusted = true,
) {
  const tree = new NativeMarkdownInput(source.snapshot()).parse(parserInstance);
  const owners = createRootParagraphOwners(tree, source, 41, {
    parser: parserInstance,
    inlineParser,
    inlineSettlement: trusted ? "native-tail" : "original-context",
    ...(trusted ? { attestation: attestNativeParagraphWindowGrammar(parserInstance, {
      tablesEnabled: true,
      blockCompatibility: true,
      htmlContinuation: true,
      footnoteDefinitionInterrupts: false,
      customMarkdownExtensions: [],
    }) } : {}),
  });
  assert.equal(owners.length, 1, "the fixture must have exactly one native root paragraph");
  return owners[0]!;
}


function assertFinalizedFollowingRoot(initialSource: string, appendedText: string, expectedType: string): void {
  const source = new AppendSourceDocument();
  source.append(initialSource);
  const owner = createOwner(source);
  const finalized = finalizeRootParagraphOwner(owner, source.snapshot());
  assert.equal(rootParagraphChangeNeedsReplacement(finalized), false);
  const previousEnd = owner.getMetadata().sourceRange.to;

  source.append(appendedText);
  const change = probeFinalizedRootParagraphAppend(owner, source.snapshot(), appendedText);
  assert.equal(change.requiresOwnerReplacement, false);
  assert.equal(change.closure, "following-root");
  assert.equal(change.ownerEnd, previousEnd, "a native following root must not widen the finalized paragraph source");
  assert.equal(change.processedTo, source.length);
  const firstFollowing = change.followingRootNodes[0];
  assert.ok(firstFollowing);
  assert.equal(firstFollowing.node.type.name, expectedType);
  assert.equal(firstFollowing.readiness, "provisional", "a provisional native root still closes the preceding paragraph");
  assert.equal(change.rootResumeFrom, firstFollowing.sourceOffset + firstFollowing.node.from);
}

function assertFinalizedBodyGrowth(initialSource: string, appendedText: string): void {
  const source = new AppendSourceDocument();
  source.append(initialSource);
  const owner = createOwner(source);
  const finalized = finalizeRootParagraphOwner(owner, source.snapshot());
  assert.equal(rootParagraphChangeNeedsReplacement(finalized), false);
  const previousEnd = owner.getMetadata().sourceRange.to;

  source.append(appendedText);
  const change = probeFinalizedRootParagraphAppend(owner, source.snapshot(), appendedText);
  assert.equal(change.requiresOwnerReplacement, false);
  assert.equal(change.closure, "open", "a suffix without a native paragraph boundary must reopen body growth");
  assert.ok(change.ownerEnd > previousEnd);
  assert.equal(change.ownerEnd, source.length);
  assert.equal(change.followingRootNodes.length, 0);
}




const appendSource = new AppendSourceDocument();
appendSource.append("alpha");
const appendInlineParser = new InlineParser({ maxCacheEntries: 0 });
const appendOwner = createOwner(appendSource, appendInlineParser);
const initialMetadata = appendOwner.getMetadata();
const stableBefore = appendOwner.getSpans().readRange(0, appendOwner.getSpans().completeSpanCount);
appendSource.append(" beta");
const appendResult = advanceRootParagraphOwner(appendOwner, appendSource.snapshot(), " beta");
assert.equal(rootParagraphChangeNeedsReplacement(appendResult), false);
if (rootParagraphChangeNeedsReplacement(appendResult)) throw new Error("unexpected paragraph replacement");
const stableAfter = appendOwner.getSpans().readRange(0, stableBefore.length);
assert.equal(stableAfter.length, stableBefore.length);
for (let index = 0; index < stableBefore.length; index += 1) {
  assert.strictEqual(stableAfter[index], stableBefore[index], "completed prefix spans must retain identity");
}
const appendPatchChange = rootParagraphAppendChange(appendSource.snapshot(), initialMetadata, appendResult);
assert.equal(appendPatchChange.sourceAppend, " beta", "wire source must contain only the authored suffix");
const appendPatch = rootParagraphAppendPatch(appendOwner, appendPatchChange);
assert.equal("raw" in appendPatch, false, "routine paragraph appends must not send whole-block raw source");
assert.equal(JSON.stringify(appendPatch).includes('"inline"'), false, "wire patches must not send a whole-block inline tree");
assert.equal(appendPatch.paragraph.sourceRange.to, appendSource.length);
const coldTree = new NativeMarkdownInput(appendSource.snapshot()).parse(markdownParser);
assert.equal(coldTree.topNode.firstChild?.type.name, "Paragraph", "append-time native ownership must agree with a cold configured parse");
assert.equal(coldTree.topNode.firstChild?.to, appendPatch.paragraph.sourceRange.to);
const preparedText = appendOwner.getSpans().materialize()
  .flatMap((span) => span.nodes)
  .map((node) => node.kind === "text" ? node.text : "")
  .join("");
const coldInlineText = appendInlineParser.parse(appendOwner.getSourceSnapshot().materialize(), { cache: false })
  .map((node) => node.kind === "text" ? node.text : "")
  .join("");
assert.equal(preparedText, coldInlineText, "settled span records must preserve cold inline text parity");


{
  const referenceSource = new AppendSourceDocument();
  const originalReferenceParagraph = "**pinned**. See [guide][destination]";
  referenceSource.append(originalReferenceParagraph);
  const referenceOwner = createOwner(referenceSource);
  const referenceFirstAppend = " remains";
  referenceSource.append(referenceFirstAppend);
  const referenceFirstChange = advanceRootParagraphOwner(
    referenceOwner,
    referenceSource.snapshot(),
    referenceFirstAppend,
  );
  assert.equal(rootParagraphChangeNeedsReplacement(referenceFirstChange), false);
  const referenceSecondAppend = " and **live**";
  referenceSource.append(referenceSecondAppend);
  const referenceSecondChange = advanceRootParagraphOwner(
    referenceOwner,
    referenceSource.snapshot(),
    referenceSecondAppend,
  );
  assert.equal(rootParagraphChangeNeedsReplacement(referenceSecondChange), false);
  const referenceBeforeDefinition = referenceOwner.getMetadata();
  const referenceDefinition = "\n\n[destination]: /guide\n";
  referenceSource.append(referenceDefinition);
  const referenceChange = advanceRootParagraphOwner(
    referenceOwner,
    referenceSource.snapshot(),
    referenceDefinition,
  );
  assert.equal(rootParagraphChangeNeedsReplacement(referenceChange), false);
  if (rootParagraphChangeNeedsReplacement(referenceChange)) throw new Error("unexpected reference-root replacement");
  assert.equal(referenceChange.paragraph.state, "closed", "the completed definition root closes the preceding paragraph");
  assert.equal(
    referenceChange.paragraph.sourceRange.to,
    referenceBeforeDefinition.sourceRange.to,
    "blank separation and the non-renderable definition stay outside paragraph-owned source",
  );
  assert.equal(referenceChange.paragraph.processedTo, referenceSource.length);
  const definitionStart = referenceBeforeDefinition.processedTo + 2;
  assert.equal(
    referenceChange.rootResumeFrom,
    definitionStart,
    "the reference definition must be the native semantic-resume frontier",
  );
  const referencePatchChange = rootParagraphAppendChange(
    referenceSource.snapshot(),
    referenceBeforeDefinition,
    referenceChange,
  );
  assert.equal(referencePatchChange.sourceAppend, "", "the definition is not paragraph source");
  assert.equal(referencePatchChange.rootResumeFrom, definitionStart);
}

const setextSource = new AppendSourceDocument();
setextSource.append("Title");
const setextOwner = createOwner(setextSource);
setextSource.append("\n---");
const setextResult = advanceRootParagraphOwner(setextOwner, setextSource.snapshot(), "\n---");
assert.equal(rootParagraphChangeNeedsReplacement(setextResult), true, "native Setext conversion must replace the paragraph owner");

const tableSource = new AppendSourceDocument();
tableSource.append("| head |\r\n");
const tableOwner = createOwner(tableSource);
tableSource.append("| --- |");
const tableResult = advanceRootParagraphOwner(tableOwner, tableSource.snapshot(), "| --- |");
assert.equal(rootParagraphChangeNeedsReplacement(tableResult), true, "the shared CRLF-aware native parser must detect paragraph-to-table conversion");

assertFinalizedFollowingRoot("retained body", "\n\n[destination]: /guide", "LinkReference");
assertFinalizedFollowingRoot("retained body\n", "\n[destination]: /guide", "LinkReference");
assertFinalizedFollowingRoot("retained body", "\n \n[destination]: /guide", "LinkReference");
assertFinalizedFollowingRoot("retained body\r\n", "\r\n> nested", "Blockquote");
for (const [initialSource, appendedText] of [
  ["unfinished body", " continued"],
  ["unfinished body", "\ncontinued"],
  ["retained LF\n", "continued"],
  ["retained CRLF\r\n", "continued"],
  ["pending CR\r", "\ncontinued"],
] as const) {
  assertFinalizedBodyGrowth(initialSource, appendedText);
}

const fallbackExtension: MarkdownExtension = {
  parseBlock: [{ name: "ParagraphFallbackProbe", endLeaf: (_context, line) => line.text.startsWith("!") }],
};
const fallbackParser = parser.configure([
  GFM,
  createBlockCompatibilityExtension(),
  HtmlContinuationExtension,
  fallbackExtension,
]);
assert.throws(() => attestNativeParagraphWindowGrammar(fallbackParser, {
  tablesEnabled: true,
  blockCompatibility: true,
  htmlContinuation: true,
  footnoteDefinitionInterrupts: false,
  customMarkdownExtensions: [fallbackExtension],
}), /audited default block grammar/, "caller grammar extensions must not receive native-window trust");
const fallbackSource = new AppendSourceDocument();
fallbackSource.append("plain");
const fallbackOwner = createOwner(fallbackSource, new InlineParser({ maxCacheEntries: 0 }), fallbackParser, false);
fallbackSource.append(" tail");
const fallbackResult = advanceRootParagraphOwner(fallbackOwner, fallbackSource.snapshot(), " tail");
assert.equal(rootParagraphChangeNeedsReplacement(fallbackResult), false);
assert.equal(fallbackResult.mode, "full-configured-context", "unattested extension grammars retain exact full-context native parsing");

const referenceSource = new AppendSourceDocument();
referenceSource.append("[go][key]");
const referenceParser = new InlineParser({ maxCacheEntries: 0 });
const referenceOwner = createOwner(referenceSource, referenceParser);
const sourceSpan = referenceOwner.getSpans().get(0)!;
assert.equal("dependencies" in sourceSpan, false, "public source records do not serialize the owner's reverse-index keys");
assert.deepEqual(referenceOwner.dependentSpanIndices("link", new Set(["key"])), [0],
  "unresolved reference attempts must remain in the owner's private targeted dependency index");
referenceParser.setReferences({ key: { href: "/resolved" } });
const semanticChange = referenceOwner.invalidateLinkReferences(new Set(["key"]));
assert.ok(semanticChange, "the matching reference definition must update its dependent span");
const updated = semanticChange!.updates[0]!.span;
assert.deepEqual(updated.sourceRange, sourceSpan.sourceRange, "meaning invalidation preserves authored source identity");
assert.equal(updated.sourceRevision, sourceSpan.sourceRevision);
const resolvedNode = updated.nodes[0];
assert.equal(
  resolvedNode?.kind === "link" ? resolvedNode.href : undefined,
  "/resolved",
  "targeted invalidation must prepare against the InlineParser's current reference map",
);

const finalSource = new AppendSourceDocument();
finalSource.append("[go][target]");
const finalParser = new InlineParser({ maxCacheEntries: 0 });
const finalOwner = createOwner(finalSource, finalParser);
const finalized = finalizeRootParagraphOwner(finalOwner, finalSource.snapshot());
const finalSourceSpan = finalOwner.getSpans().get(0)!;
assert.equal(rootParagraphChangeNeedsReplacement(finalized), false);
assert.equal(finalOwner.getMetadata().state, "finalized");
assert.ok(finalOwner.getSpans().materialize().every((span) => !span.isProvisional));
finalParser.setReferences({ target: { href: "/resolved" } });
const finalizedSemanticChange = finalOwner.invalidateLinkReferences(new Set(["target"]));
assert.ok(finalizedSemanticChange, "same-source meaning updates remain valid after source finalization");
const finalizedUpdated = finalizedSemanticChange!.updates[0]!.span;
assert.deepEqual(finalizedUpdated.sourceRange, finalSourceSpan.sourceRange, "finalized semantic updates preserve authored source identity");
assert.equal(finalizedUpdated.sourceRevision, finalSourceSpan.sourceRevision);
const finalizedLink = finalizedUpdated.nodes[0];
assert.equal(finalizedLink?.kind === "link" ? finalizedLink.href : undefined, "/resolved");
assert.equal(finalOwner.getMetadata().state, "finalized", "semantic updates do not reopen or replace finalized source ownership");
