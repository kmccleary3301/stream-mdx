import assert from "node:assert";

import { applyPatchBatch, createBlockSnapshot, createInitialSnapshot, inlineNodesToPlainText, STREAM_MDX_SCHEMA_VERSION, type Block, type CodeBlockSnapshot, type CodeLineRecord, type DocumentSnapshot, type NodeSnapshot, type ParagraphBlockSnapshot, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "../src/engine/engine";

type InitializedMessage = Extract<WorkerOut, { type: "INITIALIZED" }>;
type DumpMessage = Extract<WorkerOut, { type: "DUMP_BLOCKS" }>;
type DebugMessage = Extract<WorkerOut, { type: "DEBUG_STATE" }>;
type InitMessage = Extract<WorkerIn, { type: "INIT" }>;
type EngineInitOptions = Pick<InitMessage, "prewarmLangs" | "docPlugins">;

const PYTHON_INCREMENTAL_OPTIONS: EngineInitOptions = {
  prewarmLangs: ["python"],
  docPlugins: {
    tables: true,
    codeHighlighting: "incremental",
    outputMode: "tokens",
    liveTokenization: true,
    emitHighlightTokens: true,
    lazyTokenization: { enabled: false },
  },
};

interface EngineFixture {
  readonly engine: MarkdownEngine;
  readonly messages: WorkerOut[];
  readonly initialized: InitializedMessage;
  readonly document: DocumentSnapshot;
  appliedThrough: number;
}

function findInitialized(messages: readonly WorkerOut[]): InitializedMessage {
  const initialized = messages.find((message): message is InitializedMessage => message.type === "INITIALIZED");
  assert.ok(initialized, "INIT must publish its consumer snapshot");
  return initialized;
}

function findDump(messages: readonly WorkerOut[]): DumpMessage {
  const dump = messages.find((message): message is DumpMessage => message.type === "DUMP_BLOCKS");
  assert.ok(dump, "DUMP_BLOCKS must publish current blocks");
  return dump;
}

function findDebug(messages: readonly WorkerOut[]): DebugMessage {
  const debug = messages.find((message): message is DebugMessage => message.type === "DEBUG_STATE");
  assert.ok(debug, "DEBUG_STATE must publish current source and root-block state");
  return debug;
}

async function createEngineFixture(initialSource: string, initOptions: EngineInitOptions = {}): Promise<EngineFixture> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
  await engine.handle({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: initialSource,
    prewarmLangs: initOptions.prewarmLangs ?? [],
    docPlugins: { tables: true, ...initOptions.docPlugins },
  });
  const initialized = findInitialized(messages);
  assert.deepStrictEqual(
    initialized.snapshot.inputSource,
    { generation: initialized.generation, raw: initialSource },
    "the worker snapshot must carry the actual canonical authored input",
  );
  const fixture: EngineFixture = {
    engine,
    messages,
    initialized,
    document: createInitialSnapshot(initialized.snapshot),
    appliedThrough: 0,
  };
  applyPendingPatches(fixture);
  return fixture;
}

function applyPendingPatches(fixture: EngineFixture): void {
  for (const message of fixture.messages.slice(fixture.appliedThrough)) {
    if (message.type === "PATCH") applyPatchBatch(fixture.document, message.patches);
  }
  fixture.appliedThrough = fixture.messages.length;
}

async function append(fixture: EngineFixture, text: string): Promise<void> {
  await fixture.engine.handle({ type: "APPEND", text });
  applyPendingPatches(fixture);
}

async function finalize(fixture: EngineFixture): Promise<void> {
  await fixture.engine.handle({ type: "FINALIZE" });
  applyPendingPatches(fixture);
}

async function requestDump(fixture: EngineFixture): Promise<DumpMessage> {
  const start = fixture.messages.length;
  await fixture.engine.handle({ type: "DUMP_BLOCKS" });
  applyPendingPatches(fixture);
  return findDump(fixture.messages.slice(start));
}

async function requestDebug(fixture: EngineFixture): Promise<DebugMessage> {
  const start = fixture.messages.length;
  await fixture.engine.handle({ type: "DEBUG_STATE" });
  applyPendingPatches(fixture);
  return findDebug(fixture.messages.slice(start));
}

function findNodes(root: NodeSnapshot, type: string): NodeSnapshot[] {
  const found: NodeSnapshot[] = [];
  const pending = [root];
  for (let index = 0; index < pending.length; index += 1) {
    const node = pending[index]!;
    if (node.type === type) found.push(node);
    pending.push(...(node.children ?? []));
  }
  return found;
}

function findNode(root: NodeSnapshot, type: string): NodeSnapshot | undefined {
  return findNodes(root, type)[0];
}

function findRootBlock(blocks: readonly Block[], type: string): Block {
  const block = blocks.find((candidate) => candidate.type === type);
  assert.ok(block, `expected a root ${type} block`);
  return block;
}

function coldExport(block: Block): NodeSnapshot {
  return createBlockSnapshot(block);
}

function codeSnapshotForBlock(block: Block): NodeSnapshot {
  const code = findNode(coldExport(block), "code");
  assert.ok(code, "the cold native tree must retain its code node");
  assert.ok(code.code, "the cold native tree must retain its managed code snapshot");
  return code;
}


function paragraphText(node: NodeSnapshot): string | undefined {
  const candidate = node.props?.block;
  const block = candidate && typeof candidate === "object" && "payload" in candidate
    ? candidate as Block
    : undefined;
  const value = node.paragraph ?? block?.payload.meta?.paragraph;
  if (value && typeof value === "object" && "spans" in value) {
    const paragraph = value as ParagraphBlockSnapshot;
    const parts: string[] = [];
    for (const span of paragraph.spans) {
      if (span.children?.length) {
        for (const child of span.children) {
          const text = child.props?.text;
          if (typeof text === "string") parts.push(text);
        }
      } else {
        parts.push(inlineNodesToPlainText([...span.nodes]));
      }
    }
    return parts.join("");
  }
  const text = node.props?.text;
  return typeof text === "string" ? text : undefined;
}

function visibleText(root: NodeSnapshot): string[] {
  const values: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const paragraph = node.type === "paragraph" ? paragraphText(node) : undefined;
    if (paragraph !== undefined) values.push(paragraph);
    else {
      const text = node.props?.text;
      if (typeof text === "string") values.push(text);
    }
    pending.push(...(node.children ?? []));
  }
  return values;
}

function listItemTexts(root: NodeSnapshot): string[] {
  return findNodes(root, "list-item").map((item) => {
    const primary = item.children?.find((child) => child.type === "paragraph" && child.props?.listItemPrimary === true);
    const paragraph = primary ? paragraphText(primary) : undefined;
    if (paragraph !== undefined) return paragraph;
    const text = item.props?.text;
    return typeof text === "string" ? text : "";
  });
}

function assertPhysicalCodeRange(code: CodeBlockSnapshot, source: string, from: number, to: number): void {
  assert.deepStrictEqual(code.sourceRange, { from, to }, "native code ranges must use physical authored UTF-16 offsets");
  assert.strictEqual(code.raw, source.slice(from, to), "cold code source must select its exact authored range");
  for (const line of code.lines) {
    assert.ok(line.sourceRange.from >= from && line.sourceRange.to <= to, "code line ranges must stay within their physical owner range");
    assert.strictEqual(
      source.slice(line.sourceRange.from, line.sourceRange.to),
      line.text,
      "code line ranges must select their authored text rather than container indentation",
    );
  }
}

function codeLineRecordsWithoutDecoration(lines: readonly CodeLineRecord[]): Omit<CodeLineRecord, "decoration">[] {
  return lines.map((line) => {
    const { decoration, ...record } = line;
    void decoration;
    return record;
  });
}

function assertCodeLineRecordsEqualExceptDecoration(
  actual: readonly CodeLineRecord[],
  expected: readonly CodeLineRecord[],
  message: string,
): void {
  assert.deepStrictEqual(
    codeLineRecordsWithoutDecoration(actual),
    codeLineRecordsWithoutDecoration(expected),
    message,
  );
}

function assertPythonTokenStyles(
  code: CodeBlockSnapshot,
  expectedLines: readonly string[],
  literalTexts: readonly string[],
): void {
  assert.deepStrictEqual(code.lines.map((line) => line.text), expectedLines, "the native code DTO must retain each authored Python row");
  assert.strictEqual(expectedLines.length, literalTexts.length);
  for (let index = 0; index < expectedLines.length; index += 1) {
    const expectedLine = expectedLines[index]!;
    const literalText = literalTexts[index]!;
    const spans = code.lines[index]?.decoration?.tokens.spans;
    assert.ok(spans, `the actual engine must publish Shiki decorations for Python row ${index}`);
    assert.strictEqual(
      spans.map((span) => span.t).join(""),
      expectedLine,
      `the Shiki token text must cover Python row ${index} exactly`,
    );
    const call = spans.find((span) => span.t.includes("print") && !span.t.includes(literalText));
    const literal = spans.find((span) => span.t.includes(literalText));
    assert.ok(call && literal, `Python row ${index} must include distinct call and string-literal tokens`);
    const callLight = call.v?.light ?? call.s;
    const literalLight = literal.v?.light ?? literal.s;
    const callDark = call.v?.dark ?? call.s;
    const literalDark = literal.v?.dark ?? literal.s;
    assert.ok(callLight && literalLight, `Python row ${index} must carry light-theme call and literal styles`);
    assert.ok(callDark && literalDark, `Python row ${index} must carry dark-theme call and literal styles`);
    assert.notDeepStrictEqual(callLight, literalLight, `Python row ${index} call and literal styles must differ in light mode`);
    assert.notDeepStrictEqual(callDark, literalDark, `Python row ${index} call and literal styles must differ in dark mode`);
  }
}

async function testInitiallyClosedNativePythonCodeRetainsRealHighlightStyles(): Promise<void> {
  const initialSource = [
    "- ready",
    "",
    "  ```python",
    "  print('first')",
    "  ```",
  ].join("\n");
  const fixture = await createEngineFixture(initialSource, PYTHON_INCREMENTAL_OPTIONS);
  try {
    const initializedCode = findNode(fixture.initialized.snapshot, "code");
    assert.ok(initializedCode, "INITIALIZED must include its closed nested Python code node");
    assert.ok(initializedCode.code, "INITIALIZED must admit the closed nested Python fence as a managed native owner");
    assert.strictEqual(initializedCode.code.state, "closed", "the initial source must already close its nested code owner");
    assert.strictEqual(initializedCode.code.language, "python");

    const dump = await requestDump(fixture);
    const dumpedCode = codeSnapshotForBlock(findRootBlock(dump.blocks, "list"));
    assert.ok(dumpedCode.code);
    assertPythonTokenStyles(dumpedCode.code, ["print('first')"], ["first"]);

    const consumerCode = codeSnapshotForBlock(findRootBlock(fixture.document.getBlocks(), "list"));
    assert.ok(consumerCode.code);
    assertPythonTokenStyles(consumerCode.code, ["print('first')"], ["first"]);
    assert.deepStrictEqual(consumerCode.code.lines, dumpedCode.code.lines, "DUMP_BLOCKS and the patched Core consumer snapshot must expose the same real styles");
  } finally {
    fixture.engine.dispose();
  }
}

async function testClosingAppendHighlightsNewNativePythonBodyRows(): Promise<void> {
  const initialSource = [
    "- running",
    "",
    "  ```python",
    "  print('first')",
  ].join("\n");
  const fixture = await createEngineFixture(initialSource, PYTHON_INCREMENTAL_OPTIONS);
  try {
    const initializedCode = findNode(fixture.initialized.snapshot, "code");
    assert.ok(initializedCode, "INITIALIZED must include its open nested Python code node");
    assert.ok(initializedCode.code, "INITIALIZED must admit an open nested Python fence as a managed native owner");
    assert.strictEqual(initializedCode.code.state, "open");
    assert.strictEqual(initializedCode.code.language, "python");

    const appended = "\n  print('last')\n  ```";
    await append(fixture, appended);
    const source = initialSource + appended;
    const consumerCode = codeSnapshotForBlock(findRootBlock(fixture.document.getBlocks(), "list"));
    assert.ok(consumerCode.code);
    assert.strictEqual(consumerCode.code.state, "closed", "the append carrying a body row and closing fence must close the owner");
    assert.strictEqual(consumerCode.code.language, "python");
    assertPythonTokenStyles(consumerCode.code, ["print('first')", "print('last')"], ["first", "last"]);
    assertPhysicalCodeRange(consumerCode.code, source, source.indexOf("```python"), source.length);

    const dump = await requestDump(fixture);
    const dumpedCode = codeSnapshotForBlock(findRootBlock(dump.blocks, "list"));
    assert.ok(dumpedCode.code);
    assertPythonTokenStyles(dumpedCode.code, ["print('first')", "print('last')"], ["first", "last"]);
    assert.deepStrictEqual(dumpedCode.code.lines, consumerCode.code.lines, "the direct worker dump and patched Core snapshot must preserve both highlighted rows");
  } finally {
    fixture.engine.dispose();
  }
}

async function testInitialNativeCodeAdmissionAndHistoricalExports(): Promise<void> {
  const initialSource = [
    "- opening paragraph",
    "",
    "  ```ts",
    "  const first = 1;",
  ].join("\r\n");
  const fixture = await createEngineFixture(initialSource);
  try {
    const initialCode = findNode(fixture.initialized.snapshot, "code");
    assert.ok(initialCode, "INITIALIZED must include the nested native code node");
    assert.ok(initialCode.code, "INITIALIZED must admit nested code as a managed native source owner");
    assert.strictEqual(initialCode.code.info, "ts");
    assert.strictEqual(initialCode.code.language, "ts");
    assert.strictEqual(initialCode.code.state, "open", "an unclosed code leaf must remain open at EOF");
    assert.deepStrictEqual(initialCode.code.lines.map((line) => line.text), ["const first = 1;"]);
    assertPhysicalCodeRange(
      initialCode.code,
      initialSource,
      initialSource.indexOf("```ts"),
      initialSource.length,
    );

    const initialDump = await requestDump(fixture);
    const initialCold = coldExport(findRootBlock(fixture.document.getBlocks(), "list"));
    const initialColdCode = findNode(initialCold, "code");
    assert.ok(initialColdCode, "Core cold export must include the admitted nested code node");
    assert.ok(initialColdCode.code, "Core cold export must preserve the admitted nested code source");
    const initializedHistory = JSON.stringify(fixture.initialized);
    const dumpHistory = JSON.stringify(initialDump);
    const coldHistory = JSON.stringify(initialCold);

    const appended = [
      "",
      "  const second = \"value\";",
      "  ```",
    ].join("\r\n");
    await append(fixture, appended);
    const currentSource = initialSource + appended;
    const currentList = findRootBlock(fixture.document.getBlocks(), "list");
    const currentCold = coldExport(currentList);
    const closedCode = findNode(currentCold, "code");
    assert.ok(closedCode, "the applied worker patches must retain the nested code node");
    assert.ok(closedCode.code, "the applied worker patches must retain the nested code owner");
    assert.strictEqual(closedCode.code.state, "closed", "a closing fence at EOF must close the native code leaf");
    assert.strictEqual(closedCode.code.info, "ts");
    assert.strictEqual(closedCode.code.language, "ts");
    assert.deepStrictEqual(closedCode.code.lines.map((line) => line.text), ["const first = 1;", 'const second = "value";']);
    assertPhysicalCodeRange(
      closedCode.code,
      currentSource,
      currentSource.indexOf("```ts"),
      currentSource.length,
    );
    assert.strictEqual(closedCode.code.raw, currentSource.slice(closedCode.code.sourceRange.from, closedCode.code.sourceRange.to));
    assert.strictEqual(closedCode.code.language, "ts", "the Core code projection keeps the authored language after the closing append");

    const dump = await requestDump(fixture);
    const dumpList = findRootBlock(dump.blocks, "list");
    const dumpCode = codeSnapshotForBlock(dumpList);
    assert.deepStrictEqual(dumpCode.code?.lines, closedCode.code.lines, "the worker dump and patched Core snapshot expose the same rendered code rows");
    assert.deepStrictEqual(dumpCode.code?.sourceRange, closedCode.code.sourceRange);
    const debug = await requestDebug(fixture);
    assert.strictEqual(debug.state.contentLength, currentSource.length);
    assert.strictEqual(debug.state.lastBlockType, "list");

    await finalize(fixture);
    const finalizedList = findRootBlock(fixture.document.getBlocks(), "list");
    const finalizedCode = codeSnapshotForBlock(finalizedList);
    assert.ok(finalizedCode.code, "the Core cold export must retain the finalized native owner");
    assertCodeLineRecordsEqualExceptDecoration(
      finalizedCode.code.lines,
      closedCode.code.lines,
      "EOF finalization preserves every authored/source/identity field while allowing its decoration to update",
    );
    assert.deepStrictEqual(finalizedCode.code.sourceRange, closedCode.code.sourceRange);

    assert.strictEqual(JSON.stringify(fixture.initialized), initializedHistory, "the direct post callback's INITIALIZED value remains historical");
    assert.strictEqual(JSON.stringify(initialDump), dumpHistory, "an earlier direct DUMP_BLOCKS value remains historical");
    assert.strictEqual(JSON.stringify(initialCold), coldHistory, "a Core cold export remains historical after later patches");
  } finally {
    fixture.engine.dispose();
  }
}

async function testSplitFenceHeaderAndClosingAppend(): Promise<void> {
  const initialSource = [
    "- intro \u{1F4A1}",
    "",
    "  ```t",
  ].join("\r\n");
  const fixture = await createEngineFixture(initialSource);
  try {
    const appended = [
      "s",
      '  const value = "\u{1F4A1}";',
      "  const final = 2;",
      "  ```",
    ].join("\r\n");
    await append(fixture, appended);
    const source = initialSource + appended;
    const list = findRootBlock(fixture.document.getBlocks(), "list");
    const cold = coldExport(list);
    const code = findNode(cold, "code");
    assert.ok(code, "the completed split header must export a native code node");
    assert.ok(code.code, "the completed split header must admit a native nested code owner");
    assert.strictEqual(code.code.info, "ts", "header text split across appends must form the authored language");
    assert.strictEqual(code.code.language, "ts");
    assert.strictEqual(code.code.state, "closed", "the append carrying the body and closing fence must close the leaf");
    assertPhysicalCodeRange(code.code, source, source.indexOf("```t"), source.length);
    assert.deepStrictEqual(code.code.lines.map((line) => line.text), ['const value = "\u{1F4A1}";', "const final = 2;"], "the consumer code rows render the body admitted with the split language header");

    const dump = await requestDump(fixture);
    const dumpedCode = codeSnapshotForBlock(findRootBlock(dump.blocks, "list"));
    assert.strictEqual(dumpedCode.code?.language, "ts");
    assert.deepStrictEqual(dumpedCode.code?.lines, code.code.lines, "the worker dump preserves the same consumer-visible code rows");
    assert.deepStrictEqual(dumpedCode.code?.sourceRange, code.code.sourceRange);
    const debug = await requestDebug(fixture);
    assert.strictEqual(debug.state.contentLength, source.length);
    assert.strictEqual(debug.state.blockTypeCounts.list, 1);

    await finalize(fixture);
    const finalizedCode = codeSnapshotForBlock(findRootBlock(fixture.document.getBlocks(), "list"));
    assert.ok(finalizedCode.code, "the Core cold export must retain the finalized native owner");
    assert.strictEqual(finalizedCode.code.state, "finalized", "the closed EOF leaf must finalize without changing its authored range");
    assertPhysicalCodeRange(finalizedCode.code, source, source.indexOf("```t"), source.length);
  } finally {
    fixture.engine.dispose();
  }
}

async function testReferenceParagraphDisappearsAndLooseListChildrenRemain(): Promise<void> {
  const contextItems = Array.from({ length: 40 }, (_, index) => `- context-${index}`);
  const initialSource = ["- first", "", "- second"].join("\n");
  const fixture = await createEngineFixture(initialSource);
  try {
    const contextAppend = [...contextItems, "", "  [destination]"].join("\n");
    await append(fixture, `\n${contextAppend}`);
    const sourceBeforeDefinition = `${initialSource}\n${contextAppend}`;
    const before = coldExport(findRootBlock(fixture.document.getBlocks(), "list"));
    assert.ok(visibleText(before).some((value) => value.includes("[destination]")), "the unfinished reference text is initially a renderable paragraph");
    assert.strictEqual(listItemTexts(before).length, contextItems.length + 2);

    const appended = ": /guide";
    await append(fixture, appended);
    const source = sourceBeforeDefinition + appended;
    const currentList = findRootBlock(fixture.document.getBlocks(), "list");
    assert.strictEqual(currentList.isFinalized, false, "the native list remains open at EOF");
    const currentCold = coldExport(currentList);
    const visibleAfter = visibleText(currentCold);
    assert.ok(!visibleAfter.some((value) => value.includes("[destination]")), "a reference definition must disappear from rendered nested children");
    const expectedItems = ["first", "second", ...contextItems.map((item) => item.slice(2))];
    assert.deepStrictEqual(listItemTexts(currentCold), expectedItems, "all authored list items remain visible in their original order");
    assert.strictEqual(currentCold.props?.loose, true, "the earlier blank sibling gap keeps the list loose after the active tail advances");

    const dump = await requestDump(fixture);
    const dumpedList = findRootBlock(dump.blocks, "list");
    assert.strictEqual(dumpedList.isFinalized, false);
    const dumpCold = coldExport(dumpedList);
    assert.deepStrictEqual(listItemTexts(dumpCold), expectedItems, "an open DUMP_BLOCKS list retains its current children");
    assert.strictEqual(dumpCold.props?.loose, true);
    assert.ok(!visibleText(dumpCold).some((value) => value.includes("[destination]")));

    const debug = await requestDebug(fixture);
    assert.strictEqual(debug.state.contentLength, source.length);
    assert.strictEqual(debug.state.lastBlockType, "list");
    await finalize(fixture);
    const finalized = coldExport(findRootBlock(fixture.document.getBlocks(), "list"));
    assert.strictEqual(findRootBlock(fixture.document.getBlocks(), "list").isFinalized, true);
    assert.deepStrictEqual(listItemTexts(finalized), expectedItems);
    assert.strictEqual(finalized.props?.loose, true);
  } finally {
    fixture.engine.dispose();
  }
}

async function testOpenQuoteDumpRetainsCurrentChildren(): Promise<void> {
  const initialSource = "> alpha\n> beta";
  const fixture = await createEngineFixture(initialSource);
  try {
    await append(fixture, " plus");
    const source = `${initialSource} plus`;
    const dump = await requestDump(fixture);
    const quote = findRootBlock(dump.blocks, "blockquote");
    assert.strictEqual(quote.isFinalized, false, "the blockquote stays open at EOF");
    const dumpedQuote = coldExport(quote);
    assert.match(visibleText(dumpedQuote).join("\n"), /beta plus/, "an open quote dump retains its current paragraph text");

    const consumerQuote = coldExport(findRootBlock(fixture.document.getBlocks(), "blockquote"));
    assert.match(visibleText(consumerQuote).join("\n"), /beta plus/, "applied Core patches retain the same open quote children");
    const debug = await requestDebug(fixture);
    assert.strictEqual(debug.state.contentLength, source.length);
    assert.strictEqual(debug.state.lastBlockType, "blockquote");

    await finalize(fixture);
    const finalizedQuote = findRootBlock(fixture.document.getBlocks(), "blockquote");
    assert.strictEqual(finalizedQuote.isFinalized, true, "FINALIZE closes the quote at EOF");
    assert.match(visibleText(coldExport(finalizedQuote)).join("\n"), /beta plus/);
  } finally {
    fixture.engine.dispose();
  }
}

async function run(): Promise<void> {
  await testInitiallyClosedNativePythonCodeRetainsRealHighlightStyles();
  await testClosingAppendHighlightsNewNativePythonBodyRows();
  await testInitialNativeCodeAdmissionAndHistoricalExports();
  await testSplitFenceHeaderAndClosingAppend();
  await testReferenceParagraphDisappearsAndLooseListChildrenRemain();
  await testOpenQuoteDumpRetainsCurrentChildren();

}
await run();
console.log("native container tail engine test passed");
