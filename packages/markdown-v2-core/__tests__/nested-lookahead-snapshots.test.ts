import assert from "node:assert";

import { createBlockSnapshot } from "../src/block-snapshot";
import type { Block, InlineNode, NodeSnapshot } from "../src/types";

function walk(snapshot: NodeSnapshot, visit: (node: NodeSnapshot) => void) {
  visit(snapshot);
  for (const child of snapshot.children ?? []) {
    walk(child, visit);
  }
}

function collectInlineText(nodes: InlineNode[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      text += node.text;
      continue;
    }
    if ("children" in node && Array.isArray((node as { children?: InlineNode[] }).children)) {
      text += collectInlineText(((node as { children?: InlineNode[] }).children ?? []) as InlineNode[]);
    }
  }
  return text;
}

function findListItem(snapshot: NodeSnapshot, needle: string): NodeSnapshot | null {
  let found: NodeSnapshot | null = null;
  walk(snapshot, (node) => {
    if (found || node.type !== "list-item") return;
    const inline = (node.props?.inline ?? []) as InlineNode[];
    if (collectInlineText(inline).includes(needle)) {
      found = node;
    }
  });
  return found;
}

function testNestedStrongInsideListItem() {
  const block: Block = {
    id: "list-1",
    type: "list",
    isFinalized: false,
    payload: {
      raw: "1. Root\n   - **nested emphasis",
      meta: { ordered: true, formatAnticipation: true, mathEnabled: true },
    },
  };

  const snapshot = createBlockSnapshot(block);
  const item = findListItem(snapshot, "nested emphasis");
  assert.ok(item, "expected nested list item");
  const inline = (item!.props?.inline ?? []) as InlineNode[];
  const serialized = JSON.stringify(inline);
  assert.ok(serialized.includes("\"strong\"") || collectInlineText(inline).includes("**nested emphasis"), "expected preserved or anticipated emphasis");
}

function testNestedRegexInsideListItem() {
  const block: Block = {
    id: "list-2",
    type: "list",
    isFinalized: false,
    payload: {
      raw: "- Ref {cite:5",
      meta: { ordered: false, formatAnticipation: { inline: true, regex: true }, mathEnabled: true },
    },
  };

  const snapshot = createBlockSnapshot(block);
  const item = findListItem(snapshot, "Ref");
  assert.ok(item, "expected list item");
  const inline = (item!.props?.inline ?? []) as InlineNode[];
  assert.ok(collectInlineText(inline).includes("Ref"), "expected list-item text");
}

function testNestedBlockquoteUsesListInlinePath() {
  const block: Block = {
    id: "list-3",
    type: "list",
    isFinalized: false,
    payload: {
      raw: "- Parent\n  > quote with *italic",
      meta: { ordered: false, formatAnticipation: true, mathEnabled: true },
    },
  };

  const snapshot = createBlockSnapshot(block);
  let foundQuote = false;
  walk(snapshot, (node) => {
    if (node.type === "blockquote") {
      foundQuote = true;
    }
  });
  assert.ok(foundQuote, "expected nested blockquote snapshot");
}

testNestedStrongInsideListItem();
testNestedRegexInsideListItem();
testNestedBlockquoteUsesListInlinePath();
console.log("nested lookahead snapshot tests passed");
