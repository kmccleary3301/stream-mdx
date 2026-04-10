import assert from "node:assert";

import type { Block, InlineNode, Patch } from "@stream-mdx/core";
import DOMPurifyFactory from "dompurify";

import { createRendererStore } from "../src/renderer/store";

const dompurifyShim = DOMPurifyFactory as unknown as { sanitize?: (html: string, config?: unknown) => string };
if (typeof dompurifyShim.sanitize !== "function") {
  dompurifyShim.sanitize = (html: string) => html;
}

function textNode(text: string): InlineNode {
  return { kind: "text", text };
}

function createFinalizedCodeBlock(): Block {
  return {
    id: "code-block",
    type: "code",
    isFinalized: true,
    payload: {
      raw: ["```ts", "const alpha = 1;", "const beta = 2;", "```"].join("\n"),
      meta: {
        lang: "ts",
        code: ["const alpha = 1;", "const beta = 2;"].join("\n"),
      },
    },
  };
}

function createFinalizedListBlock(): Block {
  return {
    id: "list-block",
    type: "list",
    isFinalized: true,
    payload: {
      raw: "- First\n- Second",
      meta: {
        ordered: false,
        items: [[textNode("First")], [textNode("Second")]],
      },
    },
  };
}

function createFinalizedTableBlock(): Block {
  return {
    id: "table-block",
    type: "table",
    isFinalized: true,
    payload: {
      raw: ["| Name | Value |", "| --- | --- |", "| Alpha | 1 |"].join("\n"),
      meta: {
        header: [[textNode("Name")], [textNode("Value")]],
        rows: [[[textNode("Alpha")], [textNode("1")]]],
        align: [null, null],
      },
    },
  };
}

async function runFinalizedCodeSemanticStabilityTest(): Promise<void> {
  const store = createRendererStore([createFinalizedCodeBlock()]);
  const initial = store.getNode("code-block");
  assert.ok(initial, "expected finalized code block");
  const initialEpoch = initial.blockEpoch;
  const codeLineId = initial.children[0];
  assert.ok(codeLineId, "expected finalized code line child");

  store.applyPatches([
    {
      op: "setProps",
      at: { blockId: "code-block", nodeId: codeLineId },
      props: {
        index: 0,
        text: "const alpha = 100;",
      },
      meta: {
        kind: "semantic",
        blockEpoch: initialEpoch - 1,
      },
    } satisfies Patch,
  ]);

  const afterStale = store.getNode("code-block");
  assert.ok(afterStale, "expected finalized code block after stale semantic follow-up");
  const staleLine = store.getNode(codeLineId);
  assert.ok(staleLine, "expected finalized code line after stale semantic follow-up");
  assert.strictEqual(staleLine.props?.text, "const alpha = 1;", "stale semantic code-line update must be rejected");
  assert.strictEqual(afterStale.block?.isFinalized, true, "stale semantic code-line update must not reopen finalized block");

  store.applyPatches([
    {
      op: "setProps",
      at: { blockId: "code-block", nodeId: codeLineId },
      props: {
        index: 0,
        text: "const alpha = 100;",
      },
      meta: {
        kind: "semantic",
        blockEpoch: initialEpoch,
        parseEpoch: initialEpoch + 1,
        tx: 9001,
      },
    } satisfies Patch,
  ]);

  const afterValid = store.getNode("code-block");
  const updatedLine = store.getNode(codeLineId);
  assert.ok(afterValid && updatedLine, "expected finalized code block after valid semantic follow-up");
  assert.strictEqual(updatedLine.props?.text, "const alpha = 100;", "valid semantic code-line update should land");
  assert.strictEqual(afterValid.block?.isFinalized, true, "valid semantic code-line update must keep block finalized");
  assert.ok(afterValid.blockEpoch > initialEpoch, "valid semantic code-line update must advance block epoch");
}

async function runFinalizedListSemanticStabilityTest(): Promise<void> {
  const store = createRendererStore([createFinalizedListBlock()]);
  const initial = store.getNode("list-block");
  assert.ok(initial, "expected finalized list block");
  const initialEpoch = initial.blockEpoch;
  const originalChildren = [...store.getChildren("list-block")];
  assert.strictEqual(originalChildren.length, 2, "expected finalized list items");

  store.applyPatches([
    {
      op: "reorder",
      at: { blockId: "list-block", nodeId: "list-block" },
      from: 1,
      to: 0,
      count: 1,
      meta: {
        kind: "semantic",
        blockEpoch: initialEpoch - 1,
      },
    } satisfies Patch,
  ]);

  const afterStale = store.getChildren("list-block");
  assert.deepStrictEqual(afterStale, originalChildren, "stale semantic list reorder must be rejected");

  store.applyPatches([
    {
      op: "reorder",
      at: { blockId: "list-block", nodeId: "list-block" },
      from: 1,
      to: 0,
      count: 1,
      meta: {
        kind: "semantic",
        blockEpoch: initialEpoch,
        parseEpoch: initialEpoch + 1,
        tx: 9002,
      },
    } satisfies Patch,
  ]);

  const afterValid = store.getNode("list-block");
  const reordered = store.getChildren("list-block");
  assert.ok(afterValid, "expected finalized list block after valid semantic reorder");
  assert.strictEqual(reordered[0], originalChildren[1], "valid semantic list reorder should land");
  assert.strictEqual(reordered[1], originalChildren[0], "valid semantic list reorder should land");
  assert.strictEqual(afterValid.block?.isFinalized, true, "valid semantic list reorder must keep block finalized");
  assert.ok(afterValid.blockEpoch > initialEpoch, "valid semantic list reorder must advance block epoch");
}

async function runFinalizedTableSemanticStabilityTest(): Promise<void> {
  const store = createRendererStore([createFinalizedTableBlock()]);
  const initial = store.getNode("table-block");
  assert.ok(initial, "expected finalized table block");
  const initialEpoch = initial.blockEpoch;
  const tbodyId = store.getChildren("table-block")[1];
  assert.ok(tbodyId, "expected finalized table body");
  const originalRowId = tbodyId ? store.getChildren(tbodyId)[0] : undefined;
  assert.ok(originalRowId, "expected finalized table row");
  const originalFirstCellId = originalRowId ? store.getChildren(originalRowId)[0] : undefined;
  assert.ok(originalFirstCellId, "expected finalized table cell");
  const originalCell = store.getNode(originalFirstCellId);
  assert.ok(originalCell, "expected finalized table cell");
  assert.strictEqual(originalCell.props?.text, "Alpha", "expected initial finalized table cell text");

  const staleUpdatedTable: Block = {
    ...initial.block!,
    payload: {
      ...initial.block!.payload,
      meta: {
        ...(initial.block!.payload.meta ?? {}),
        rows: [[[textNode("Omega")], [textNode("9")]]],
      },
    },
  };

  store.applyPatches([
    {
      op: "setProps",
      at: { blockId: "table-block", nodeId: "table-block" },
      props: {
        block: staleUpdatedTable,
      },
      meta: {
        kind: "semantic",
        blockEpoch: initialEpoch - 1,
      },
    } satisfies Patch,
  ]);

  const staleCell = store.getNode(originalFirstCellId);
  assert.ok(staleCell, "expected original finalized table cell after stale replacement");
  assert.strictEqual(staleCell.props?.text, "Alpha", "stale semantic table replacement must not mutate finalized table");

  const validUpdatedTable: Block = {
    ...initial.block!,
    payload: {
      ...initial.block!.payload,
      meta: {
        ...(initial.block!.payload.meta ?? {}),
        rows: [[[textNode("Omega")], [textNode("9")]]],
      },
    },
  };

  store.applyPatches([
    {
      op: "setProps",
      at: { blockId: "table-block", nodeId: "table-block" },
      props: {
        block: validUpdatedTable,
      },
      meta: {
        kind: "semantic",
        blockEpoch: initialEpoch,
        parseEpoch: initialEpoch + 1,
        tx: 9003,
      },
    } satisfies Patch,
  ]);

  const afterValid = store.getNode("table-block");
  const replacedTbodyId = store.getChildren("table-block")[1];
  assert.ok(replacedTbodyId, "expected finalized table body after valid semantic replacement");
  const replacedRowId = replacedTbodyId ? store.getChildren(replacedTbodyId)[0] : undefined;
  assert.ok(replacedRowId, "expected finalized table row after valid semantic replacement");
  const replacedCellId = store.getChildren(replacedRowId)[0];
  const replacedCell = store.getNode(replacedCellId);
  assert.ok(afterValid && replacedCell, "expected finalized table after valid semantic replacement");
  assert.strictEqual(replacedCell.props?.text, "Omega", "valid semantic table replacement should land");
  assert.strictEqual(afterValid.block?.isFinalized, true, "valid semantic table replacement must keep block finalized");
  assert.ok(afterValid.blockEpoch > initialEpoch, "valid semantic table replacement must advance block epoch");
}

async function main() {
  await runFinalizedCodeSemanticStabilityTest();
  await runFinalizedListSemanticStabilityTest();
  await runFinalizedTableSemanticStabilityTest();
}

await main();
console.log("finalized-semantic-stability test passed");
