import assert from "node:assert/strict";
import { GFM, parser } from "@lezer/markdown";
import { AppendSourceDocument, InlineParser, createBlockCompatibilityExtension } from "@stream-mdx/core";
import { HtmlContinuationExtension } from "../src/parser/html-extension";
import { NativeMarkdownInput } from "../src/engine/native-markdown-input";
import { SourceRangeInput } from "../src/engine/root-code-pipeline";
import { createRootTableOwners, rootTableAppendChange, rootTableAppendPatch } from "../src/engine/root-table-pipeline";

const markdownParser = parser.configure([GFM, createBlockCompatibilityExtension(), HtmlContinuationExtension]);
const reclassifyingParser = parser.configure([
  GFM,
  createBlockCompatibilityExtension(),
  HtmlContinuationExtension,
  {
    parseBlock: [{
      name: "ProvisionalRowReclassifier",
      endLeaf: (_context, line) => line.text.slice(line.pos) === "---",
    }],
  },
]);
const source = new AppendSourceDocument();
source.append("|h|\r\n|---|\r\n");
const inlineParser = new InlineParser({ maxCacheEntries: 0 });
const initialTree = new NativeMarkdownInput(source.snapshot()).parse(markdownParser);
const owners = createRootTableOwners(
  initialTree,
  source,
  7,
  markdownParser,
  inlineParser,
  "header-independent",
);
assert.equal(owners.length, 1, "native CRLF table opening must admit one owner");
const owner = owners[0]!;
assert.equal(
  source.snapshot().read(owner.getMetadata().sourceRange.from, owner.getMetadata().sourceRange.to),
  "|h|\r\n|---|",
  "empty-body ownership must retain the native delimiter while excluding its trailing line ending",
);
assert.equal(
  source.snapshot().read(owner.getHeader().sourceRange.from, owner.getHeader().sourceRange.to),
  "|h|\r\n|---|",
  "header source range must retain the native alignment delimiter but exclude its line ending",
);
assert.equal(owner.getMetadata().processedTo, source.length, "processedTo begins after the delimiter line ending");

function appendAndCheckOwnedSuffix(text: string): string {
  const previous = owner.getMetadata();
  const previousRaw = owner.createSnapshot().raw;
  const from = source.length;
  source.append(text);
  const change = owner.accept(from, source.length);
  const patch = rootTableAppendChange(source.snapshot(), previous, change);
  const nextRaw = owner.createSnapshot().raw;
  assert.equal(
    patch.sourceAppend,
    source.snapshot().read(previous.sourceRange.to, change.table.sourceRange.to),
    "append payload must cover newly owned source, not merely the processed frontier",
  );
  assert.equal(previousRaw + patch.sourceAppend, nextRaw, "raw table source must reconstruct exactly from append patches");
  return nextRaw;
}

appendAndCheckOwnedSuffix("#");
assert.equal(owner.getMetadata().state, "open", "an unconfirmed tail must not close the owner");
const raw = appendAndCheckOwnedSuffix("notheading\r\n");
assert.equal(raw, "|h|\r\n|---|\r\n#notheading", "owned raw source must preserve authored CRLF bytes and omit only the final row ending");
assert.equal(owner.getRows().get(0)?.sourceRange.from, 12);
assert.equal(owner.getRows().get(0)?.sourceRange.to, 23);
assert.equal(owner.getRows().get(0)?.cells[0]?.raw, "#notheading", "native cell spans must map to authored UTF-16 source");

const coldTree = new NativeMarkdownInput(source.snapshot(), true).parse(markdownParser);
assert.equal(coldTree.cursor().type.name, "Document");
assert.ok(coldTree.toString().includes("TableRow(TableCell)"), "cold native parsing must retain the appended row");
const finalized = owner.finalize();
assert.equal(finalized.table.state, "finalized", "FINALIZE must seal the still-open table owner");
const reclassifiedSource = new AppendSourceDocument();
reclassifiedSource.append("|h|\n|---|\n--");
const reclassifiedTree = new NativeMarkdownInput(reclassifiedSource.snapshot()).parse(reclassifyingParser);
const reclassifiedOwner = createRootTableOwners(
  reclassifiedTree,
  reclassifiedSource,
  8,
  reclassifyingParser,
  inlineParser,
  "source-dependent",
)[0]!;
assert.equal(reclassifiedOwner.getMetadata().completeRowCount, 0);
assert.equal(reclassifiedOwner.getMetadata().rowCount, 1, "cold construction may seed one provisional row");
assert.equal(reclassifiedOwner.getHeader().sourceRange.to, 9, "header record carries the delimiter-end rollback floor");
const beforeExtension = reclassifiedOwner.getMetadata();
const rawBeforeExtension = reclassifiedOwner.createSnapshot().raw;
reclassifiedSource.append("\n|stable|\n--");
const extension = reclassifiedOwner.accept(beforeExtension.processedTo, reclassifiedSource.length);
const extensionPatch = rootTableAppendChange(reclassifiedSource.snapshot(), beforeExtension, extension);
assert.equal(extension.table.completeRowCount, 2);
assert.equal(extension.table.rowCount, 3);
assert.equal(extension.rows[2]?.isProvisional, true);
assert.equal(
  rawBeforeExtension + extensionPatch.sourceAppend,
  reclassifiedOwner.createSnapshot().raw,
  "re-extension must include previously accepted but now newly owned table bytes",
);
const completedPrefix = [reclassifiedOwner.getRows().get(0)!, reclassifiedOwner.getRows().get(1)!] as const;
const beforeRetraction = reclassifiedOwner.getMetadata();
const oldSourceLength = reclassifiedSource.length;
reclassifiedSource.append("-");
const retraction = reclassifiedOwner.accept(beforeRetraction.processedTo, reclassifiedSource.length);
const retractionPatch = rootTableAppendChange(reclassifiedSource.snapshot(), beforeRetraction, retraction);
assert.equal(retraction.table.state, "open", "an incomplete native root line must remain revisable");
assert.equal(retraction.table.processedTo, reclassifiedSource.length, "accepted input frontier must remain monotonic");
assert.equal(retraction.table.completeRowCount, 2);
assert.equal(retraction.table.rowCount, 2, "retraction must remove only the provisional row");
assert.equal(retraction.table.sourceRange.to, completedPrefix[1].sourceRange.to);
assert.equal(retraction.fromRow, 2);
assert.equal(retraction.rows.length, 0);
assert.equal(retraction.sourceAppend, "");
assert.equal(retraction.rootResumeFrom, undefined, "an unconfirmed root cannot retire the table owner");
assert.equal(reclassifiedOwner.getRows().get(0), completedPrefix[0], "completed prefix record identity must survive retraction");
assert.equal(reclassifiedOwner.getRows().get(1), completedPrefix[1], "completed suffix record identity must survive retraction");
assert.equal(reclassifiedOwner.createSnapshot().raw, "|h|\n|---|\n--\n|stable|");
assert.equal(oldSourceLength, beforeRetraction.processedTo);
const beforeConfirmation = reclassifiedOwner.getMetadata();
reclassifiedSource.append("\n");
const confirmed = reclassifiedOwner.accept(beforeConfirmation.processedTo, reclassifiedSource.length);
assert.equal(confirmed.table.state, "closed", "a completed native root opening closes the table owner");
assert.equal(confirmed.rootResumeFrom, completedPrefix[1].sourceRange.to + 1);
const confirmedPatch = rootTableAppendChange(reclassifiedSource.snapshot(), beforeConfirmation, confirmed);
const protocolPatch = rootTableAppendPatch(reclassifiedOwner, confirmedPatch);
assert.equal(Object.hasOwn(protocolPatch, "rootResumeFrom"), false, "native resume coordinate must never enter semantic patches");
const emptyPrefixSource = new AppendSourceDocument();
emptyPrefixSource.append("|h|\r\n|---|\r\n--");
const emptyPrefixTree = new NativeMarkdownInput(emptyPrefixSource.snapshot()).parse(reclassifyingParser);
const emptyPrefixOwner = createRootTableOwners(
  emptyPrefixTree,
  emptyPrefixSource,
  9,
  reclassifyingParser,
  inlineParser,
  "source-dependent",
)[0]!;
assert.equal(emptyPrefixOwner.getMetadata().completeRowCount, 0);
assert.equal(emptyPrefixOwner.getMetadata().rowCount, 1);
const beforeEmptyPrefixRetraction = emptyPrefixOwner.getMetadata();
emptyPrefixSource.append("-");
const emptyPrefixRetraction = emptyPrefixOwner.accept(beforeEmptyPrefixRetraction.processedTo, emptyPrefixSource.length);
const emptyPrefixPatch = rootTableAppendChange(
  emptyPrefixSource.snapshot(),
  beforeEmptyPrefixRetraction,
  emptyPrefixRetraction,
);
assert.equal(emptyPrefixRetraction.table.processedTo, emptyPrefixSource.length);
assert.equal(emptyPrefixRetraction.table.completeRowCount, 0);
assert.equal(emptyPrefixRetraction.table.rowCount, 0);
assert.equal(emptyPrefixRetraction.table.sourceRange.to, emptyPrefixOwner.getHeader().sourceRange.to);
assert.equal(emptyPrefixOwner.getHeader().sourceRange.to, 10);
assert.equal(emptyPrefixRetraction.rootResumeFrom, undefined, "CRLF interruption remains provisional before its ending arrives");
assert.equal(emptyPrefixPatch.sourceAppend, "");
assert.equal(emptyPrefixOwner.createSnapshot().raw, "|h|\r\n|---|");
emptyPrefixSource.append("\r\n|later|\r\n|---|\r\nrow");
const emptyPrefixConfirmed = emptyPrefixOwner.accept(emptyPrefixRetraction.table.processedTo, emptyPrefixSource.length);
assert.equal(emptyPrefixConfirmed.table.state, "closed");
assert.equal(emptyPrefixConfirmed.rootResumeFrom, 12, "CRLF resume begins after the delimiter's complete line ending");
const remainingRootFrom = emptyPrefixConfirmed.rootResumeFrom;
assert.ok(remainingRootFrom !== undefined);
const remainingRootTree = new NativeMarkdownInput(
  new SourceRangeInput(emptyPrefixSource.snapshot(), remainingRootFrom),
).parse(reclassifyingParser);
assert.ok(remainingRootTree.toString().includes("HorizontalRule"), "remainder must replay the reclassified native root line");
const resumedTableOwner = createRootTableOwners(
  remainingRootTree,
  emptyPrefixSource,
  9,
  reclassifyingParser,
  inlineParser,
  "source-dependent",
  remainingRootFrom,
)[0]!;
assert.equal(resumedTableOwner.getMetadata().sourceRange.from, 17, "native re-admission retains absolute source offsets");
assert.equal(resumedTableOwner.getRows().get(0)?.sourceRange.from, 33);
assert.equal(resumedTableOwner.createSnapshot().raw, "|later|\r\n|---|\r\nrow");
assert.equal(emptyPrefixOwner.createSnapshot().raw, "|h|\r\n|---|", "new root admission must not re-extend the closed table owner");
