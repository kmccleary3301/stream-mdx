import assert from "node:assert/strict";
import { GFM, parser } from "@lezer/markdown";
import {
  AppendSourceDocument,
  createBlockCompatibilityExtension,
  createBlockSnapshot,
  InlineParser,
  PATCH_ROOT_ID,
  prepareNestedBlockSnapshotFromNative,
} from "@stream-mdx/core";
import type { Block, NodeSnapshot, PreparedNestedSnapshot, SourceSnapshot } from "@stream-mdx/core";
import { createSnapshotStore } from "../src/index";

const LIST_ID = "tui-native-list";
const INPUT_GENERATION = 42;
const nativeParser = parser.configure([GFM, createBlockCompatibilityExtension()]);

function nativeListSnapshot(source: SourceSnapshot): NodeSnapshot {
  const tree = nativeParser.parse(source);
  let listNode = tree.topNode.firstChild;
  while (listNode && listNode.type.name !== "BulletList") listNode = listNode.nextSibling;
  assert.ok(listNode, "the canonical input must contain a parsed native list");

  const block: Block = {
    id: LIST_ID,
    type: "list",
    isFinalized: false,
    payload: { raw: "", range: { from: listNode.from, to: listNode.to } },
  };
  block.payload.meta = {
    preparedNested: prepareNestedBlockSnapshotFromNative(
      block,
      listNode,
      { input: source, source, mapOffset: (offset) => offset },
      new InlineParser(),
      nativeParser,
    ),
  };
  return createBlockSnapshot(block);
}

function nestedChildren(block: Block): NodeSnapshot[] {
  const prepared = block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
  assert.ok(prepared, "the TUI cold export includes the current nested tree");
  return prepared.children;
}

function nestedBlock(node: NodeSnapshot | undefined): Block {
  assert.ok(node);
  const block = node.props?.block as Block | undefined;
  assert.ok(block);
  return block;
}

const initialRaw = "- done\n- growing";
const suffix = "\n  authored continuation";
const fullRaw = `${initialRaw}${suffix}`;
const source = new AppendSourceDocument();
source.append(initialRaw);
const initialListNode = nativeListSnapshot(source.snapshot());
const initialSnapshot: NodeSnapshot = {
  id: PATCH_ROOT_ID,
  type: "__root__",
  range: { from: 0, to: initialRaw.length },
  inputSource: { generation: INPUT_GENERATION, raw: initialRaw },
  children: [initialListNode],
};
const store = createSnapshotStore(initialSnapshot);
const oldBlocks = store.getBlocks();
assert.equal(oldBlocks[0]?.payload.raw, initialRaw, "the initial TUI export reads exact authored container bytes");
assert.deepEqual(oldBlocks[0]?.payload.range, initialListNode.range, "initial TUI range preserves the authored offsets");

source.append(suffix);
const extendedSnapshot = nativeListSnapshot(source.snapshot());
const extendedItem = extendedSnapshot.children?.find((child) => child.id === `${LIST_ID}::item:1`);
assert.ok(extendedSnapshot.range && extendedItem?.range);
store.applyPatches([
  {
    op: "appendInputSource",
    at: { blockId: PATCH_ROOT_ID },
    generation: INPUT_GENERATION,
    from: initialRaw.length,
    text: suffix,
  },
  {
    op: "setProps",
    at: { blockId: LIST_ID, nodeId: LIST_ID },
    props: { range: extendedSnapshot.range },
  },
  {
    op: "setProps",
    at: { blockId: LIST_ID, nodeId: `${LIST_ID}::item:1` },
    props: { range: extendedItem.range },
  },
]);

const currentBlock = store.getBlocks()[0];
assert.ok(currentBlock);
assert.equal(currentBlock.payload.raw, fullRaw, "the TUI store exposes the admitted canonical container source");
assert.deepEqual(currentBlock.payload.range, extendedSnapshot.range);
const currentChildren = nestedChildren(currentBlock);
const completedItem = currentChildren.find((child) => child.id === `${LIST_ID}::item:0`);
const growingItem = currentChildren.find((child) => child.id === `${LIST_ID}::item:1`);
assert.equal(nestedBlock(completedItem).payload.raw, "- done", "completed siblings retain their authored source");
assert.equal(nestedBlock(growingItem).payload.raw, "- growing\n  authored continuation");
assert.deepEqual(nestedBlock(growingItem).payload.range, extendedItem.range);
assert.equal(store.getSnapshot().nodes.get(`${LIST_ID}::item:1`)?.range?.to, extendedItem.range.to);
assert.equal(oldBlocks[0]?.payload.raw, initialRaw, "previous TUI exports remain historical after growth");

console.log("TUI native container range test passed");
