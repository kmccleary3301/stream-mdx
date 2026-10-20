import assert from "node:assert";
import { parser as nativeParser } from "@lezer/markdown";
import { AppendSourceDocument } from "@stream-mdx/core";

const SOURCE_CHUNK_UNITS = 4096;
const DIRECTORY_CHUNK_COUNT = 64 * 32;
const boundaryUnits = ["\r", "\n", "\uD83D", "\uDE03", "\uD800", "\r", "\uDC00"];
const bulkAPrefix = "\r\n\r\uD83D\uDE03";
const bulkBPrefix = "\uDC00\n\r";
const bulkA = `${bulkAPrefix}${"a".repeat(SOURCE_CHUNK_UNITS - bulkAPrefix.length - 1)}\uD800`;
const bulkB = `${bulkBPrefix}${"b".repeat(SOURCE_CHUNK_UNITS - bulkBPrefix.length - 1)}\r`;

function main(): void {
  const nativeInputDocument = new AppendSourceDocument();
  nativeInputDocument.append("```ts\r\nbody \uD83D");
  nativeInputDocument.append("\uDE03\r");
  nativeInputDocument.append("\n");
  nativeInputDocument.append("`");
  nativeInputDocument.append("``\r");
  const nativeInput = nativeInputDocument.snapshot();
  const nativeInputSource = "```ts\r\nbody \uD83D\uDE03\r\n```\r";
  const nativeInputTree = nativeParser.parse(nativeInput).toString();
  assert.strictEqual(
    nativeInputTree,
    nativeParser.parse(nativeInputSource).toString(),
    "cold Lezer parsing matches StringInput across split surrogate, CRLF, and closing-fence chunks",
  );
  nativeInputDocument.append("future text\r\n");
  assert.strictEqual(nativeInput.read(0, nativeInput.length + 16), nativeInputSource, "old read() stops at its captured length");
  assert.strictEqual(nativeInput.chunk(0), "```ts\r", "old chunk() retains CRLF line semantics after append");
  assert.strictEqual(nativeInput.chunk(nativeInput.length), "", "old chunk() cannot see appended source");
  assert.strictEqual(nativeParser.parse(nativeInput).toString(), nativeInputTree, "Lezer Input remains stable after append");
  assert.strictEqual(nativeInput.materialize(), nativeInputSource, "first materialization after append retains the captured source");
  assert.strictEqual(
    nativeParser.parse(nativeInput.materialize()).toString(),
    nativeInputTree,
    "materialized old input has the same native consumer output",
  );

  const document = new AppendSourceDocument();
  const expectedParts: string[] = [];
  const append = (text: string): void => {
    document.append(text);
    expectedParts.push(text);
  };

  append("seed");
  const seedReader = document.snapshot();
  assert.strictEqual(document.snapshot(), seedReader, "snapshot() reuses the current immutable reader");
  document.append("");
  assert.strictEqual(document.snapshot(), seedReader, "an empty append does not create a source version");

  for (const unit of boundaryUnits) append(unit);
  const boundaryExpected = expectedParts.join("");
  const boundaryReader = document.snapshot();
  assert.strictEqual(document.length, boundaryExpected.length, "document length counts UTF-16 code units");
  assert.strictEqual(boundaryReader.lineChunks, true, "Input chunks end at LF across source pieces");
  assert.strictEqual(boundaryReader.materialize(), boundaryExpected, "explicit materialization returns exact source");

  // Eight existing source chunks plus 56 full chunks fill one 64-entry leaf.
  for (let chunkIndex = 0; chunkIndex < 56; chunkIndex += 1) {
    append(chunkIndex % 2 === 0 ? bulkA : bulkB);
  }
  const leafCapacityExpected = expectedParts.join("");
  const leafCapacityReader = document.snapshot();

  // The next authored chunk creates a second leaf page.
  append(bulkB);
  const pageGrowthExpected = expectedParts.join("");
  const pageGrowthReader = document.snapshot();

  // Fill all 32 directory entries, then append once more to grow the directory root.
  for (let chunkIndex = 0; chunkIndex < DIRECTORY_CHUNK_COUNT - 65; chunkIndex += 1) {
    append(chunkIndex % 2 === 0 ? bulkA : bulkB);
  }
  const directoryCapacityExpected = expectedParts.join("");
  const directoryCapacityReader = document.snapshot();
  append(bulkB);
  const directoryGrowthExpected = expectedParts.join("");
  const directoryGrowthReader = document.snapshot();

  assert.notStrictEqual(directoryGrowthReader, seedReader, "an actual append creates a new immutable reader");
  assert.strictEqual(seedReader.materialize(), "seed", "the first reader is unchanged after all storage growth");
  assert.strictEqual(boundaryReader.materialize(), boundaryExpected, "split CR/LF and surrogate appends stay exact");
  assert.strictEqual(leafCapacityReader.materialize(), leafCapacityExpected, "leaf-capacity reader keeps its exact source");
  assert.strictEqual(pageGrowthReader.materialize(), pageGrowthExpected, "page growth preserves the preceding reader");
  assert.strictEqual(directoryCapacityReader.materialize(), directoryCapacityExpected, "directory-capacity reader keeps its exact source");
  assert.strictEqual(directoryGrowthReader.materialize(), directoryGrowthExpected, "directory growth preserves the preceding reader");
  assert.strictEqual(document.snapshot().materialize(), directoryGrowthExpected, "the latest reader contains the full authored source");
  assert.strictEqual(document.length, directoryGrowthExpected.length, "directory growth preserves UTF-16 length");
  assert.strictEqual(seedReader.length, "seed".length, "an old snapshot retains its captured length");
  assert.strictEqual(seedReader.read(0, document.length), "seed", "old read() clips future source");
  assert.strictEqual(seedReader.chunk(0), "seed", "old chunk() retains its captured line");
  assert.strictEqual(seedReader.chunk(seedReader.length), "", "old chunk() stops at its captured end");
  assert.strictEqual(
    nativeParser.parse(seedReader).toString(),
    nativeParser.parse("seed").toString(),
    "Lezer consumes an old snapshot after directory and height growth",
  );

  const firstBulkOffset = "seed".length + boundaryUnits.length;
  const firstChunkEnd = firstBulkOffset + SOURCE_CHUNK_UNITS;
  const crossPieceLineStart = firstChunkEnd - 2;
  const crossPieceLineEnd = leafCapacityExpected.indexOf("\n", crossPieceLineStart);
  assert.strictEqual(
    leafCapacityReader.chunk(crossPieceLineStart),
    leafCapacityExpected.slice(crossPieceLineStart, crossPieceLineEnd),
    "chunk() continues through a split surrogate to the next authored LF",
  );
  assert.strictEqual(
    leafCapacityReader.read(leafCapacityExpected.length - 2, leafCapacityExpected.length + 2),
    leafCapacityExpected.slice(leafCapacityExpected.length - 2),
    "old read() clips beyond a captured leaf-capacity boundary after later appends",
  );
  assert.strictEqual(
    leafCapacityReader.chunk(leafCapacityExpected.length - 2),
    leafCapacityExpected.slice(leafCapacityExpected.length - 2),
    "old chunk() stops at a captured leaf-capacity boundary after later appends",
  );
  assert.strictEqual(
    leafCapacityReader.read(firstChunkEnd - 1, firstChunkEnd + 1),
    leafCapacityExpected.slice(firstChunkEnd - 1, firstChunkEnd + 1),
    "read() preserves a surrogate pair split across source chunks",
  );
  const secondChunkEnd = firstChunkEnd + SOURCE_CHUNK_UNITS;
  assert.strictEqual(
    pageGrowthReader.read(secondChunkEnd - 1, secondChunkEnd + 2),
    "\r\r\n",
    "read() preserves a CRLF pair across source-chunk boundaries",
  );
  assert.strictEqual(
    pageGrowthReader.read(leafCapacityExpected.length - 2, leafCapacityExpected.length + 2),
    pageGrowthExpected.slice(leafCapacityExpected.length - 2, leafCapacityExpected.length + 2),
    "read() crosses a leaf-page boundary without changing authored units",
  );
  assert.strictEqual(
    directoryGrowthReader.read(directoryCapacityExpected.length - 2, directoryCapacityExpected.length + 2),
    directoryGrowthExpected.slice(directoryCapacityExpected.length - 2, directoryCapacityExpected.length + 2),
    "read() crosses a directory-root growth boundary exactly",
  );
  const appendedLineEnd = bulkB.indexOf("\n");
  assert.strictEqual(
    directoryGrowthReader.chunk(directoryCapacityExpected.length),
    bulkB.slice(0, appendedLineEnd),
    "chunk() returns the next line prefix from the grown directory",
  );

  console.log("source document append regression passed");
}

main();
