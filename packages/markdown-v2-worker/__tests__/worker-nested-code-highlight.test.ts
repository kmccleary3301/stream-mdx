import assert from "node:assert/strict";
import { GFM, parser as baseMarkdownParser, Table } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import {
  AppendSourceDocument,
  createBlockCompatibilityExtension,
  createBlockSnapshot,
  InlineParser,
  PATCH_ROOT_ID,
  prepareNestedBlockSnapshotFromNative,
  type Block,
  type NodeSnapshot,
  type Patch,
} from "@stream-mdx/core";
import { createRendererStore, type RendererStore } from "@stream-mdx/react/renderer/store";
import { CODE_HIGHLIGHT_THEMES, getSharedHighlighter } from "../src/engine/highlight";
import { NativeContainerTailParser, type NativeContainerTailChange } from "../src/engine/native-container-tail";
import { NativeMarkdownInput } from "../src/engine/native-markdown-input";
import {
  NativeNestedCodeSourceOwner,
  type NativeNestedCodeSourceChange,
  type NativeNestedCodeSourceMapping,
  type NativeNestedCodeState,
  type NativeNestedCodeTailUpdate,
} from "../src/engine/native-nested-code-owner";
import { RootCodeHighlighter, SourceRangeInput } from "../src/engine/root-code-pipeline";
import { HtmlContinuationExtension } from "../src/parser/html-extension";

const INPUT_GENERATION = 17;

const markdownParser = baseMarkdownParser.configure([
  GFM.filter((extension) => extension !== Table),
  createBlockCompatibilityExtension(),
  HtmlContinuationExtension,
]);

interface NativeNestedCodeFixture {
  readonly document: AppendSourceDocument;
  readonly inputGeneration: number;
  readonly containerNode: SyntaxNode;
  readonly mapping: NativeNestedCodeSourceMapping;
  readonly block: Block;
  readonly owner: NativeNestedCodeSourceOwner;
  readonly store: RendererStore;
}

interface PublishedTailChange {
  readonly nativeChange: NativeContainerTailChange;
  readonly update: NativeNestedCodeTailUpdate;
  readonly change: NativeNestedCodeSourceChange;
}

function findSyntaxNode(root: SyntaxNode, typeName: string): SyntaxNode | undefined {
  const pending: SyntaxNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.type.name === typeName) return node;
    for (let child = node.firstChild; child; child = child.nextSibling) pending.push(child);
  }
  return undefined;
}

function createFixture(
  initialText: string,
  containerId: string,
  containerNodeName: "BulletList" | "Blockquote" = "BulletList",
): NativeNestedCodeFixture {
  const document = new AppendSourceDocument();
  document.append(initialText);
  const source = document.snapshot();
  const input = new NativeMarkdownInput(new SourceRangeInput(source, 0));
  const tree = input.parse(markdownParser);
  const containerNode = findSyntaxNode(tree.topNode, containerNodeName);
  assert.ok(containerNode, "the configured native parser must produce the nested container");

  const mapping: NativeNestedCodeSourceMapping = {
    input,
    source,
    mapOffset: (offset) => offset,
    mapRange: (from, to) => ({ from, to }),
  };
  const containerRange = mapping.mapRange(containerNode.from, containerNode.to);
  const block: Block = {
    id: containerId,
    type: containerNodeName === "Blockquote" ? "blockquote" : "list",
    isFinalized: false,
    payload: {
      raw: source.read(containerRange.from, containerRange.to),
      range: containerRange,
    },
  };

  let owner: NativeNestedCodeSourceOwner | undefined;
  const preparedNested = prepareNestedBlockSnapshotFromNative(
    block,
    containerNode,
    mapping,
    new InlineParser(),
    markdownParser,
    undefined,
    (node, id, kind, range) => {
      if (kind !== "code") return undefined;
      owner = NativeNestedCodeSourceOwner.admit({
        id,
        containerId,
        generation: 3,
        inputGeneration: INPUT_GENERATION,
        source: document,
        node,
        mapping,
        closure: "open",
        range,
      });
      return owner.snapshot();
    },
  );
  if (!owner) throw new Error("Configured native lowering did not admit a nested code owner");

  block.payload.meta = { ...(block.payload.meta ?? {}), preparedNested };
  const containerSnapshot = createBlockSnapshot(block);
  const rootSnapshot: NodeSnapshot = {
    id: PATCH_ROOT_ID,
    type: "__root__",
    props: {},
    range: { from: 0, to: source.length },
    inputSource: { generation: INPUT_GENERATION, raw: source.materialize() },
    children: [containerSnapshot],
  };
  const store = createRendererStore();
  store.resetSnapshot(rootSnapshot);

  return {
    document,
    inputGeneration: INPUT_GENERATION,
    containerNode,
    mapping,
    block,
    owner,
    store,
  };
}

function appendNativeTail(
  fixture: NativeNestedCodeFixture,
  tailParser: NativeContainerTailParser,
  text: string,
  closure: NativeNestedCodeState,
): PublishedTailChange {
  const previousSourceLength = fixture.document.length;
  fixture.document.append(text);
  const source = fixture.document.snapshot();
  const nativeChange = tailParser.append(source, text, source.length);
  assert.ok(nativeChange, "the native container parser must publish the appended code tail");
  assert.equal(nativeChange.leafNode.type.name, "FencedCode", "the active native leaf must remain the fenced code node");

  const physicalCodeRange = nativeChange.window.mapping.mapRange(
    nativeChange.leafNode.from,
    nativeChange.leafNode.to,
  );
  const previousRange = fixture.owner.getMetadata().sourceRange;
  assert.equal(physicalCodeRange.from, previousRange.from, "the logical tail must map back to the admitted physical code start");
  const update: NativeNestedCodeTailUpdate = {
    nodes: nativeChange.changedCodeNodes,
    mapping: nativeChange.window.mapping,
    inputGeneration: fixture.inputGeneration,
    sourceDocument: fixture.document,
    closure,
    sourceRange: { from: previousRange.from, to: physicalCodeRange.to },
  };
  const change = fixture.owner.acceptNativeTail(update);

  const sourcePatch: Patch = {
    op: "appendInputSource",
    at: { blockId: PATCH_ROOT_ID },
    generation: fixture.inputGeneration,
    from: previousSourceLength,
    text,
    meta: { kind: "semantic" },
  };
  fixture.store.applyPatches([sourcePatch], { captureMetrics: false });
  fixture.store.applyPatches([fixture.owner.appendPatch(change)], { captureMetrics: false });

  return { nativeChange, update, change };
}

function assertConsumerSourceMatchesOwner(fixture: NativeNestedCodeFixture): void {
  const view = fixture.store.getCodeBlock(fixture.owner.id);
  assert.ok(view, "the renderer consumer must retain the managed nested-code view");
  const snapshot = fixture.owner.snapshot();
  assert.ok(snapshot.code);
  const source = fixture.document.snapshot();
  const range = view.source.sourceRange;
  assert.equal(
    source.read(range.from, range.to),
    snapshot.code.raw,
    "consumer-visible code ranges must select the authored physical source",
  );
}

async function runNestedFencedTailTest(): Promise<void> {
  const codeText = 'print("nested-code-block-highlight")';
  const initialText = `*   \`\`\`python\r\n    \t${codeText}`;
  const fixture = createFixture(initialText, "native-fenced-container");
  const tailParser = NativeContainerTailParser.admit(
    markdownParser,
    fixture.document,
    fixture.inputGeneration,
    fixture.document.snapshot(),
    fixture.containerNode,
  );

  const initialWindow = fixture.store.getCodeLines(fixture.owner.id, 0, 4);
  assert.equal(initialWindow.length, 1, "the open native fence must publish one provisional source line");
  const initialLine = initialWindow[0];
  assert.ok(initialLine);
  assert.equal(initialLine.text, `\t${codeText}`, "nested fenced code must display the tab after list and fence indentation");
  assert.equal(initialLine.isProvisional, true, "a terminal code line stays provisional until its ending arrives");

  const initialContainer = fixture.store.getBlocks().find((block) => block.id === fixture.block.id);
  assert.ok(initialContainer);
  assert.equal(initialContainer.payload.raw, initialText, "the container retains authored list indentation and tab bytes");
  assertConsumerSourceMatchesOwner(fixture);

  const completedBody = appendNativeTail(fixture, tailParser, "\n", "open");

  const completedWindow = fixture.store.getCodeLines(fixture.owner.id, 0, 4);
  assert.equal(completedWindow.length, 1, "the body terminator must not create a duplicate code row");
  const completedLine = completedWindow[0];
  assert.ok(completedLine);
  assert.equal(completedLine.text, `\t${codeText}`);
  assert.equal(completedLine.isProvisional, false);
  assert.equal(initialLine.text, `\t${codeText}`, "a previously published provisional record must remain unchanged");
  assert.equal(initialLine.isProvisional, true);
  assertConsumerSourceMatchesOwner(fixture);

  appendNativeTail(fixture, tailParser, "    ``", "open");
  assert.strictEqual(fixture.store.getCodeLines(fixture.owner.id, 0, 1)[0], completedLine);
  assert.equal(fixture.store.getCodeLines(fixture.owner.id, 0, 4).length, 1);
  assert.equal(completedLine.text, `\t${codeText}`);
  assertConsumerSourceMatchesOwner(fixture);

  const completedFence = appendNativeTail(fixture, tailParser, "`\n", "closed");
  assert.equal(fixture.owner.state, "closed");
  assert.equal(fixture.store.getCodeLines(fixture.owner.id, 0, 4).length, 1, "the closing fence is not published as code");
  assert.strictEqual(fixture.store.getCodeLines(fixture.owner.id, 0, 1)[0], completedLine);
  assert.equal(completedLine.text, `\t${codeText}`);
  assert.ok(completedLine.isProvisional === false);
  assertConsumerSourceMatchesOwner(fixture);

  const staleInputUpdate: NativeNestedCodeTailUpdate = {
    ...completedFence.update,
    inputGeneration: fixture.inputGeneration + 1,
  };
  assert.throws(
    () => fixture.owner.acceptNativeTail(staleInputUpdate),
    Error,
    "the native leaf must reject a stale canonical-input generation",
  );

  const replacementOwner = NativeNestedCodeSourceOwner.admit({
    id: fixture.owner.id,
    containerId: fixture.block.id,
    generation: fixture.owner.generation + 1,
    inputGeneration: fixture.inputGeneration,
    source: fixture.document,
    node: completedFence.nativeChange.leafNode,
    mapping: completedFence.update.mapping,
    closure: "closed",
    range: completedFence.update.sourceRange,
  });
  assert.throws(
    () => replacementOwner.appendPatch(completedBody.change),
    TypeError,
    "a replacement lease must reject an append from the retired owner generation",
  );

  const currentView = fixture.store.getCodeBlock(fixture.owner.id);
  assert.ok(currentView);
  fixture.store.applyPatches([fixture.owner.appendPatch(completedBody.change)], { captureMetrics: false });
  assert.equal(
    fixture.store.getCodeBlock(fixture.owner.id)?.source.revision,
    currentView.source.revision,
    "the consumer must ignore an append patch from an obsolete owner revision",
  );

  const finalized = fixture.owner.finalize(completedFence.update.mapping);
  fixture.store.applyPatches([fixture.owner.appendPatch(finalized)], { captureMetrics: false });
  assert.equal(fixture.owner.state, "finalized");
  assert.equal(fixture.store.getCodeLines(fixture.owner.id, 0, 4).length, 1);

  const sharedHighlighter = await getSharedHighlighter(["python"]);
  const highlighter = new RootCodeHighlighter();
  const decorations = await highlighter.decorateAvailable(fixture.owner, {
    highlighter: sharedHighlighter,
    themes: CODE_HIGHLIGHT_THEMES,
    configurationRevision: 0,
    enabled: true,
  }, () => true);
  assert.equal(decorations.length, 1, "the real Shiki highlighter must decorate the completed nested code line");
  const decorationPatch = fixture.owner.decoratePatch(0, decorations);
  assert.ok(decorationPatch);
  fixture.store.applyPatches([decorationPatch], { captureMetrics: false });
  const tokens = fixture.store.getCodeLines(fixture.owner.id, 0, 1)[0]?.decoration?.tokens.spans ?? [];
  assert.equal(tokens.map((token) => token.t).join(""), `\t${codeText}`);
  const call = tokens.find((token) => token.t.includes("print") && !token.t.includes("nested-code-block-highlight"));
  const literal = tokens.find((token) => token.t.includes("nested-code-block-highlight"));
  assert.ok(call && literal, "the code consumer retains token styles for both the Python call and string literal");
  assert.notDeepEqual(call.v?.light ?? call.s, literal.v?.light ?? literal.s, "light syntax styles distinguish the call and literal");
  assert.notDeepEqual(call.v?.dark ?? call.s, literal.v?.dark ?? literal.s, "dark syntax styles distinguish the call and literal");
  assertConsumerSourceMatchesOwner(fixture);
}

async function runNestedIndentedTerminalTest(): Promise<void> {
  const initialText = "- foo\r\n\r\n\t\tbar";
  const fixture = createFixture(initialText, "native-indented-container");
  const initialWindow = fixture.store.getCodeLines(fixture.owner.id, 0, 4);
  assert.equal(initialWindow.length, 1, "the native indented block must produce one code row");
  const initialLine = initialWindow[0];
  assert.ok(initialLine);
  assert.equal(initialLine.text, "  bar", "nested indented code must expose its logical display indentation");
  assert.equal(initialLine.isProvisional, true, "the terminal indented line remains provisional before finalization");

  const initialContainer = fixture.store.getBlocks().find((block) => block.id === fixture.block.id);
  assert.ok(initialContainer);
  assert.equal(initialContainer.payload.raw, initialText, "the container snapshot retains the authored tab indentation");
  assertConsumerSourceMatchesOwner(fixture);

  const finalized = fixture.owner.finalize(fixture.mapping);
  fixture.store.applyPatches([fixture.owner.appendPatch(finalized)], { captureMetrics: false });
  const finalizedWindow = fixture.store.getCodeLines(fixture.owner.id, 0, 4);
  assert.equal(finalizedWindow.length, 1, "finalizing an unterminated indented block must not add a code row");
  const finalizedLine = finalizedWindow[0];
  assert.ok(finalizedLine);
  assert.equal(finalizedLine.text, "  bar");
  assert.equal(finalizedLine.isProvisional, false, "EOF finalization completes the terminal indented line");
  assert.equal(initialLine.text, "  bar", "a previously published indented line remains immutable");
  assert.equal(initialLine.isProvisional, true);
  assertConsumerSourceMatchesOwner(fixture);
}

function runNestedBlockquoteTabProjectionTest(): void {
  for (const [input, expectedDisplay] of [[">\t\tcode", "   code"], [">     code", "code"]]) {
    const fixture = createFixture(input, "native-blockquote-indent-container", "Blockquote");
    const rows = fixture.store.getCodeLines(fixture.owner.id, 0, 2);
    assert.equal(rows.length, 1, "the native blockquote must expose one indented-code row");
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.text, expectedDisplay, "blockquote marker whitespace follows native space and tab indentation");
    assert.equal(row.ending, "");
    assert.equal(
      fixture.document.snapshot().read(row.sourceRange.from, row.sourceRange.to),
      "code",
      "the code row range selects authored text rather than consumed quote indentation",
    );
    assertConsumerSourceMatchesOwner(fixture);
  }
}

function runCrossChunkCrLfProjectionTest(): void {
  const prefix = "*   ```text\r\n    ";
  const probeDocument = new AppendSourceDocument();
  probeDocument.append(`${prefix}x\r\n    tail`);
  const probeInput = new NativeMarkdownInput(new SourceRangeInput(probeDocument.snapshot(), 0));
  const probeTree = probeInput.parse(markdownParser);
  const probeContainer = findSyntaxNode(probeTree.topNode, "BulletList");
  assert.ok(probeContainer);
  const probeCode = findSyntaxNode(probeContainer, "FencedCode");
  assert.ok(probeCode);
  const probeCodeText = probeCode.getChild("CodeText");
  assert.ok(probeCodeText);

  const firstLineLength = 4095 + probeCodeText.from - prefix.length;
  assert.ok(firstLineLength > 2);
  const firstLine = `${"x".repeat(firstLineLength - 2)}😀`;
  const initialText = `${prefix}${firstLine}\r\n    tail`;
  const fixture = createFixture(initialText, "native-crlf-chunk-container");
  const codeNode = findSyntaxNode(fixture.containerNode, "FencedCode");
  assert.ok(codeNode);
  const codeText = codeNode.getChild("CodeText");
  assert.ok(codeText);
  const eventFrom = fixture.mapping.mapOffset(codeText.from);
  const crOffset = initialText.indexOf("\r\n", prefix.length);
  assert.equal(crOffset - eventFrom, 4095, "CR must be the final UTF-16 unit in the first 4096-unit code chunk");

  const rows = fixture.store.getCodeLines(fixture.owner.id, 0, 3);
  assert.equal(rows.length, 2, "a cross-chunk CRLF must not create an empty consumer row");
  const first = rows[0];
  const second = rows[1];
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.text, firstLine);
  assert.equal(first.ending, "\r\n");
  assert.equal(first.sourceRange.from, initialText.indexOf(firstLine));
  assert.equal(first.sourceRange.to, crOffset);
  assert.equal(first.sourceRange.to - first.sourceRange.from, firstLine.length, "code row ranges use UTF-16 source units");
  assert.equal(
    fixture.document.snapshot().read(first.sourceRange.from, first.sourceRange.to),
    firstLine,
    "the first code row range must exclude both physical CRLF units",
  );
  assert.equal(second.text, "tail");
  assert.equal(second.ending, "");
  assert.equal(second.sourceRange.from, initialText.indexOf("tail"));
  assert.equal(
    fixture.document.snapshot().read(second.sourceRange.from, second.sourceRange.to),
    "tail",
    "the next row range must begin after the complete physical CRLF",
  );
  assertConsumerSourceMatchesOwner(fixture);
}

runNestedBlockquoteTabProjectionTest();
runCrossChunkCrLfProjectionTest();


await runNestedFencedTailTest();
await runNestedIndentedTerminalTest();
console.log("worker-nested-code-highlight test passed");
