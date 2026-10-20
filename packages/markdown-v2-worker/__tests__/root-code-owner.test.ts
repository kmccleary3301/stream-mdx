import assert from "node:assert/strict";
import { AppendSourceDocument, type CodeLineDecoration } from "@stream-mdx/core";
import { RootCodeSourceOwner } from "../src/engine/root-code-owner";

const OPENING = "  ```ts\r\n";

function createOwner(source: AppendSourceDocument, id = "root-code"): RootCodeSourceOwner {
  return new RootCodeSourceOwner({
    id,
    generation: 7,
    source,
    opening: {
      from: 2,
      bodyFrom: OPENING.length,
      marker: "`",
      width: 3,
      indent: 2,
      info: "ts",
      language: "ts",
    },
  });
}

function appendAndAccept(source: AppendSourceDocument, owner: RootCodeSourceOwner, text: string) {
  const from = source.length;
  source.append(text);
  return owner.accept(from, source.length);
}

function main(): void {
  const source = new AppendSourceDocument();
  source.append(OPENING);
  const owner = createOwner(source);
  const bodyFrom = OPENING.length;

  const highSurrogate = '  const value = "\uD83D';
  const firstChange = appendAndAccept(source, owner, highSurrogate);
  const firstPartial = owner.getLines().get(0);
  assert.ok(firstPartial);
  assert.strictEqual(firstPartial.text, 'const value = "\uD83D', "opening indentation is removed from display text");
  assert.deepStrictEqual(firstPartial.sourceRange, { from: bodyFrom, to: bodyFrom + highSurrogate.length }, "source ranges retain authored indentation and UTF-16 offsets");
  assert.strictEqual(firstPartial.isProvisional, true);

  const lowSurrogateAndCR = "\uDE03;\r";
  const secondChange = appendAndAccept(source, owner, lowSurrogateAndCR);
  const secondPartial = owner.getLines().get(0);
  assert.ok(secondPartial);
  assert.strictEqual(secondPartial.text, 'const value = "😃;', "a surrogate pair split across accepts remains exact");
  assert.strictEqual(secondPartial.ending, "", "a trailing CR remains provisional until its line ending is known");
  assert.ok(secondPartial.sourceRevision > firstPartial.sourceRevision, "changed tail rows advance their source revision");
  assert.strictEqual(firstPartial.text, 'const value = "\uD83D', "older line-index snapshots remain immutable");
  assert.strictEqual(firstChange.lines[0], firstPartial);
  assert.strictEqual(secondChange.lines[0], secondPartial);

  const completedBody = "\n  second\n";
  const thirdChange = appendAndAccept(source, owner, completedBody);
  assert.strictEqual(thirdChange.fromLine, 0, "only the changed tail is returned");
  assert.strictEqual(thirdChange.lines.length, 2, "the CRLF completion and the new line are returned once");
  const firstComplete = owner.getLines().get(0);
  const secondComplete = owner.getLines().get(1);
  assert.ok(firstComplete && secondComplete);
  assert.strictEqual(firstComplete.id, secondPartial.id);
  assert.strictEqual(firstComplete.ending, "\r\n", "a CRLF split across accepts remains one authored ending");
  assert.strictEqual(firstComplete.text, 'const value = "😃;');
  assert.deepStrictEqual(firstComplete.sourceRange, {
    from: bodyFrom,
    to: bodyFrom + highSurrogate.length + lowSurrogateAndCR.length - 1,
  }, "record ranges cover authored line content but exclude the preserved ending");
  assert.strictEqual(secondComplete.text, "second", "opening indentation, not closing indentation, determines dedenting");
  assert.strictEqual(secondComplete.ending, "\n");
  assert.strictEqual(owner.getLines().length, 2, "a body-ending newline does not create an extra visual row");

  const closeCandidate = "   ```";
  const candidateChange = appendAndAccept(source, owner, closeCandidate);
  assert.strictEqual(candidateChange.state, "open", "a closing-looking EOF line is only provisional");
  assert.deepStrictEqual(candidateChange.lines, [], "a provisional close candidate is absent from code rows");
  assert.strictEqual(owner.getLines().length, 2);

  const followingMarkdown = "\r\n# following native markdown\n";
  const closingChange = appendAndAccept(source, owner, followingMarkdown);
  const processedTo = source.length - "# following native markdown\n".length;
  const nativeBlockEnd = processedTo - 1;
  assert.strictEqual(closingChange.state, "closed");
  assert.strictEqual(closingChange.processedTo, processedTo, "the code owner consumes the closing-line CRLF before yielding the remainder");
  assert.strictEqual(closingChange.remainingTailFrom, processedTo, "the rest of the accepted chunk is left to native Markdown");
  assert.strictEqual(owner.getMetadata().sourceRange.to, nativeBlockEnd);
  const block = owner.materializeBlock();
  assert.strictEqual(block.type, "code");
  assert.strictEqual(block.isFinalized, true);
  assert.deepStrictEqual(block.payload.range, { from: 2, to: nativeBlockEnd }, "native FencedCode ranges start at the marker and exclude the final LF");
  assert.strictEqual(block.payload.raw, source.snapshot().read(2, nativeBlockEnd), "cold raw block materialization matches the native authored range");
  assert.strictEqual(block.payload.meta?.info, "ts");
  assert.strictEqual(block.payload.meta?.lang, "ts");

  const emptySource = new AppendSourceDocument();
  const emptyOpening = "```js\n";
  emptySource.append(emptyOpening);
  const emptyOwner = new RootCodeSourceOwner({
    id: "empty-root-code",
    generation: 8,
    source: emptySource,
    opening: { from: 0, bodyFrom: emptyOpening.length, marker: "`", width: 3, indent: 0, info: "js", language: "js" },
  });
  const emptyPlaceholder = emptyOwner.getLines().get(0);
  assert.ok(emptyPlaceholder);
  assert.strictEqual(emptyPlaceholder.text, "", "empty code retains its one visual empty row");
  appendAndAccept(emptySource, emptyOwner, "   ");
  const provisionalBodyRow = emptyOwner.getLines().get(0);
  assert.ok(provisionalBodyRow);
  assert.strictEqual(provisionalBodyRow.text, "   ");
  const markerChange = appendAndAccept(emptySource, emptyOwner, "```");
  assert.strictEqual(markerChange.state, "open");
  const candidatePlaceholder = emptyOwner.getLines().get(0);
  assert.ok(candidatePlaceholder);
  assert.strictEqual(candidatePlaceholder.text, "", "a provisional close candidate leaves the empty visual placeholder");
  assert.ok(candidatePlaceholder.sourceRevision > provisionalBodyRow.sourceRevision, "suppressing a close candidate advances the placeholder revision");
  const reopenedChange = appendAndAccept(emptySource, emptyOwner, "x");
  const reopenedRow = emptyOwner.getLines().get(0);
  assert.ok(reopenedRow);
  assert.strictEqual(reopenedRow.text, "   ```x", "an invalidated close candidate is restored as body text");
  assert.ok(reopenedRow.sourceRevision > candidatePlaceholder.sourceRevision, "reintroduced rows carry a newer source revision");
  assert.strictEqual(reopenedChange.lines[0], reopenedRow);
  const decoratedSource = new AppendSourceDocument();
  const decoratedOpening = "```\n";
  decoratedSource.append(decoratedOpening);
  const decoratedOwner = new RootCodeSourceOwner({
    id: "decorated-root-code",
    generation: 10,
    source: decoratedSource,
    opening: { from: 0, bodyFrom: decoratedOpening.length, marker: "`", width: 3, indent: 0, info: "" },
  });
  appendAndAccept(decoratedSource, decoratedOwner, "first\n");
  const firstDecoratedLine = decoratedOwner.getLines().get(0);
  assert.ok(firstDecoratedLine);
  const ownerRevisionBeforeDecoration = decoratedOwner.getMetadata().revision;
  const decoration: CodeLineDecoration = {
    index: 0,
    lineId: firstDecoratedLine.id,
    sourceRevision: firstDecoratedLine.sourceRevision,
    configurationRevision: 1,
    exactness: "exact",
    tokens: { spans: [{ t: "first" }] },
  };
  decoratedOwner.decorateLines([decoration]);
  const decoratedRecord = decoratedOwner.getLines().get(0);
  assert.ok(decoratedRecord);
  assert.strictEqual(decoratedRecord.decoration, decoration);
  assert.strictEqual(decoratedOwner.getMetadata().revision, ownerRevisionBeforeDecoration, "decorations do not advance source-owner revision");
  appendAndAccept(decoratedSource, decoratedOwner, "second");
  assert.strictEqual(decoratedOwner.getLines().get(0), decoratedRecord, "source appends preserve decorated completed rows in the same index");

  const eofSource = new AppendSourceDocument();
  const tildeOpening = "~~~js\n";
  eofSource.append(tildeOpening);
  const eofOwner = new RootCodeSourceOwner({
    id: "eof-root-code",
    generation: 9,
    source: eofSource,
    opening: {
      from: 0,
      bodyFrom: tildeOpening.length,
      marker: "~",
      width: 3,
      indent: 0,
      info: "js",
      language: "js",
    },
  });
  const eofCandidate = appendAndAccept(eofSource, eofOwner, "~~~");
  assert.strictEqual(eofCandidate.state, "open", "an EOF closing fence remains provisional before finalization");
  const eofFinalization = eofOwner.finalize();
  assert.strictEqual(eofFinalization.state, "finalized", "FINALIZE confirms a matching closing line at EOF");
  assert.strictEqual(eofFinalization.processedTo, undefined, "an EOF close with no remainder is not reported as an input split");
  assert.strictEqual(eofOwner.getLines().length, 1, "finalized empty code keeps one visual empty row");
  assert.strictEqual(eofOwner.materializeBlock().payload.meta?.code, "");
  assert.strictEqual(eofOwner.materializeBlock().payload.raw, `${tildeOpening}~~~`);
}

main();
