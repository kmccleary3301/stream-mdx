import assert from "node:assert/strict";
import type { SyntaxNode, Tree } from "@lezer/common";
import { GFM, parser as baseMarkdownParser } from "@lezer/markdown";
import { AppendSourceDocument, createBlockCompatibilityExtension, type SourceSnapshot } from "@stream-mdx/core";
import { NATIVE_CONTAINER_TAIL_VANISHED, NativeContainerTailParser, type NativeContainerTailChange } from "../src/engine/native-container-tail";
import { NativeMarkdownInput } from "../src/engine/native-markdown-input";
import { HtmlContinuationExtension } from "../src/parser/html-extension";

const markdownParser = baseMarkdownParser.configure([
  GFM,
  createBlockCompatibilityExtension(),
  HtmlContinuationExtension,
]);
const LIST_BLANK_GAP = /\r?\n[ >\t]*\r?\n/;
const LIST_ITEM_TYPES: Record<string, true> = { ListItem: true, EmptyListItem: true };
const OMITTED_LIST_CHILDREN: Record<string, true> = { ListMark: true, QuoteMark: true, LinkReference: true };

type NativeContainerFixture = {
  readonly document: AppendSourceDocument;
  readonly owner: NativeContainerTailParser;
};

type ReadRange = readonly [from: number, to: number];

function findList(tree: Tree): SyntaxNode {
  const pending = [tree.topNode];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type.name === "BulletList" || node.type.name === "OrderedList") return node;
    for (let child = node.firstChild; child; child = child.nextSibling) pending.push(child);
  }
  throw new Error("Expected the fixture to parse as a native list");
}

function nativeListIsLoose(list: SyntaxNode, source: SourceSnapshot): boolean {
  let priorItemEnd: number | undefined;
  for (let item = list.firstChild; item; item = item.nextSibling) {
    if (!LIST_ITEM_TYPES[item.type.name]) continue;
    if (priorItemEnd !== undefined && LIST_BLANK_GAP.test(source.read(priorItemEnd, item.from))) return true;
    priorItemEnd = item.to;

    let priorBlockEnd: number | undefined;
    for (let block = item.firstChild; block; block = block.nextSibling) {
      if (OMITTED_LIST_CHILDREN[block.type.name]) continue;
      if (priorBlockEnd !== undefined && LIST_BLANK_GAP.test(source.read(priorBlockEnd, block.from))) return true;
      priorBlockEnd = block.to;
    }
  }
  return false;
}

function coldListIsLoose(source: SourceSnapshot): boolean {
  const tree = new NativeMarkdownInput(source).parse(markdownParser);
  return nativeListIsLoose(findList(tree), source);
}

function createFixture(initialText: string, reads?: ReadRange[]): NativeContainerFixture {
  const document = new AppendSourceDocument();
  document.append(initialText);
  const source = watchedSnapshot(document.snapshot(), reads);
  const tree = new NativeMarkdownInput(source).parse(markdownParser);
  const root = findList(tree);
  return {
    document,
    owner: NativeContainerTailParser.admit(markdownParser, document, 1, source, root),
  };
}

function watchedSnapshot(source: SourceSnapshot, reads?: ReadRange[]): SourceSnapshot {
  if (!reads) return source;
  return {
    lineChunks: true,
    length: source.length,
    chunk: (from) => source.chunk(from),
    read: (from, to) => {
      reads.push([from, to]);
      return source.read(from, to);
    },
    materialize: () => source.materialize(),
  };
}

function append(fixture: NativeContainerFixture, text: string, reads?: ReadRange[]): {
  readonly change: NativeContainerTailChange;
  readonly source: SourceSnapshot;
} {
  fixture.document.append(text);
  const source = watchedSnapshot(fixture.document.snapshot(), reads);
  const change = fixture.owner.append(source, text, source.length);
  if (change === NATIVE_CONTAINER_TAIL_VANISHED) throw new Error("native container test input lost its bounded root");
  assert.ok(change, "an open native container must publish an append change");
  return { change, source };
}

function assertListParity(change: NativeContainerTailChange, source: SourceSnapshot): void {
  const list = change.listProperties.find((property) => property.pathIndex === 0);
  assert.ok(list, "the active native path must retain its root-list properties");
  assert.equal(list.loose, coldListIsLoose(source), "bounded native list properties must match a cold configured-parser tree");
}

function codeInfoText(change: NativeContainerTailChange, source: SourceSnapshot): string {
  const info = change.leafNode.getChild("CodeInfo");
  assert.ok(info, "the active fenced-code node must retain its parser-decoded info child");
  const range = change.window.mapping.mapRange(info.from, info.to);
  return source.read(range.from, range.to);
}

function testLooseListTransitionSurvivesAnOmittedGap(): void {
  const initial = "- ```ts\r\n  const first = 1;";
  const fixture = createFixture(initial);
  assert.equal(fixture.owner.state.listProperties[0]?.loose, false, "the initial list is tight");

  const contextLines = Array.from({ length: 40 }, (_, index) => `  context-${index}`).join("\r\n");
  const appended = "\r\n  ```\r\n\r\n- intro\r\n" + contextLines + "\r\n  ```js\r\n  const second = 2;";
  const first = append(fixture, appended);
  assert.equal(first.change.leafNode.type.name, "FencedCode", "the new item's active leaf must be the native fenced block");
  assertListParity(first.change, first.source);
  assert.equal(first.change.listProperties[0]?.loose, true, "the blank sibling gap loosens the list during the transition");

  const continued = append(fixture, "\r\n  const third = 3;");
  const previousGapTo = initial.length + "\r\n  ```\r\n\r\n".length;
  assert.ok(continued.change.window.sourceOffset >= previousGapTo, "the physical append window must start after the prior sibling gap");
  assertListParity(continued.change, continued.source);
  assert.equal(continued.change.listProperties[0]?.loose, true, "looseness must survive after its only blank gap leaves the active window");
}

function testTightListTransitionRemainsTight(): void {
  const fixture = createFixture("- ```ts\r\n  const first = 1;");
  const contextLines = Array.from({ length: 40 }, (_, index) => `  context-${index}`).join("\r\n");
  const appended = "\r\n  ```\r\n- intro\r\n" + contextLines + "\r\n  ```js\r\n  const second = 2;";
  const { change, source } = append(fixture, appended);
  assert.equal(change.leafNode.type.name, "FencedCode");
  assertListParity(change, source);
  assert.equal(change.listProperties[0]?.loose, false, "adjacent native list items must remain tight");
}

function testGrowingFenceHeaderUsesOnlyNewContext(): void {
  const reads: ReadRange[] = [];
  const fixture = createFixture("- ```t", reads);
  assert.equal(fixture.owner.state.activeLeafType, "FencedCode");

  const afterInfo = append(fixture, "s", reads);
  assert.equal(codeInfoText(afterInfo.change, afterInfo.source), "ts");
  assertNoCompleteHeaderRead(reads, "- ```ts");

  for (let index = 0; index < 24; index += 1) {
    const before = reads.length;
    const step = append(fixture, "  ", reads);
    assert.equal(codeInfoText(step.change, step.source).trimEnd(), "ts");
    assertNoCompleteHeaderRead(reads.slice(before), "- ```ts" + "  ".repeat(index + 1));
  }

  const trailingWhitespace = "  ".repeat(24);
  const finalHeader = append(fixture, `\r\n  body \u{1F4A1}`, reads);
  assert.equal(codeInfoText(finalHeader.change, finalHeader.source).trimEnd(), "ts");
  const mappedMarker = finalHeader.change.window.mapping.mapRange(
    finalHeader.change.leafNode.getChild("CodeMark")!.from,
    finalHeader.change.leafNode.getChild("CodeMark")!.to,
  );
  assert.deepEqual(mappedMarker, { from: 2, to: 5 }, "native mapping must retain physical UTF-16 offsets across CRLF and supplementary text");
  const bodyText = finalHeader.change.leafNode.getChild("CodeText");
  assert.ok(bodyText, "the active native code leaf must retain its decoded body node");
  const bodyRange = finalHeader.change.window.mapping.mapRange(bodyText.from, bodyText.to);
  const emojiFrom = "- ```t".length + "s".length + trailingWhitespace.length + "\r\n  body ".length;
  assert.ok(bodyRange.from <= emojiFrom && bodyRange.to >= emojiFrom + 2, "UTF-16 source mapping must cover the supplementary body character");
  assert.equal(finalHeader.source.read(emojiFrom, emojiFrom + 2), "\u{1F4A1}");
  const completeHeader = `- \`\`\`ts${trailingWhitespace}`;
  const beforeBodyAppend = reads.length;
  const laterBody = append(fixture, "\r\n  later body", reads);
  assert.equal(codeInfoText(laterBody.change, laterBody.source).trimEnd(), "ts");
  assertNoCompleteHeaderRead(reads.slice(beforeBodyAppend), completeHeader);
}

function assertNoCompleteHeaderRead(reads: readonly ReadRange[], completeHeader: string): void {
  const fullHeader = reads.some(([from, to]) => from === 0 && to >= completeHeader.length);
  assert.equal(fullHeader, false, "append context must not reread/materialize the growing fenced header");
}

testLooseListTransitionSurvivesAnOmittedGap();
testTightListTransitionRemainsTight();
testGrowingFenceHeaderUsesOnlyNewContext();
