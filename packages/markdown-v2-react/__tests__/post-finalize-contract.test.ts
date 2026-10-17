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
      raw: ["```ts", "const answer = 42;", "```"].join("\n"),
      meta: {
        lang: "ts",
        code: "const answer = 42;",
        lazyTokenization: true,
        lazyTokenizedUntil: 0,
        highlightedLines: [null],
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


async function main() {
  const store = createRendererStore([createFinalizedCodeBlock(), createFinalizedListBlock(), createFinalizedTableBlock()]);

  const initialCode = store.getNode("code-block");
  const initialList = store.getNode("list-block");
  const initialTable = store.getNode("table-block");
  assert.ok(initialCode && initialList && initialTable, "expected mixed finalized blocks");

  const codeEpoch = initialCode.blockEpoch;
  const listEpoch = initialList.blockEpoch;
  const tableEpoch = initialTable.blockEpoch;
  const originalListChildren = [...store.getChildren("list-block")];

  const tbodyId = store.getChildren("table-block")[1];
  assert.ok(tbodyId, "expected table body");
  const rowId = store.getChildren(tbodyId)[0];
  assert.ok(rowId, "expected finalized table row");
  const originalCellId = store.getChildren(rowId)[0];
  assert.ok(originalCellId, "expected finalized table cell");

  const enrichedCodeBlock: Block = {
    ...initialCode.block!,
    payload: {
      ...initialCode.block!.payload,
      meta: {
        ...(initialCode.block!.payload.meta ?? {}),
        lazyTokenizedUntil: 1,
        highlightedLines: [
          '<span style="--shiki-dark:#F97583;--shiki-light:#D73A49">const</span><span style="--shiki-dark:#79B8FF;--shiki-light:#005CC5"> answer</span><span style="--shiki-dark:#F97583;--shiki-light:#D73A49"> =</span><span style="--shiki-dark:#79B8FF;--shiki-light:#005CC5"> 42</span><span style="--shiki-dark:#E1E4E8;--shiki-light:#24292E">;</span>',
        ],
      },
    },
  };

  const staleReplacementRow: Block = {
    id: "replacement-row",
    type: "table-row",
    isFinalized: true,
    payload: {
      raw: "| Beta | 2 |",
      meta: {
        cells: [[textNode("Beta")], [textNode("2")]],
      },
    },
  };


  store.applyPatches([
    {
      op: "setProps",
      at: { blockId: "code-block", nodeId: "code-block" },
      props: { block: enrichedCodeBlock },
      meta: { kind: "enrichment" },
    } satisfies Patch,
    {
      op: "reorder",
      at: { blockId: "list-block", nodeId: "list-block" },
      from: 1,
      to: 0,
      count: 1,
      meta: {
        kind: "semantic",
        blockEpoch: listEpoch - 1,
      },
    } satisfies Patch,
    {
      op: "replaceChild",
      at: { blockId: "table-block", nodeId: tbodyId },
      targetId: rowId,
      index: 0,
      child: staleReplacementRow,
      meta: {
        kind: "semantic",
        blockEpoch: tableEpoch - 1,
      },
    } satisfies Patch,
  ]);

  const afterCode = store.getNode("code-block");
  const afterListChildren = store.getChildren("list-block");
  const afterTableCell = store.getNode(originalCellId);
  assert.ok(afterCode && afterTableCell, "expected finalized blocks after mixed follow-up batch");

  assert.strictEqual(afterCode.block?.isFinalized, true, "enrichment must not reopen finalized code blocks");
  assert.strictEqual(afterCode.blockEpoch, codeEpoch, "enrichment must not advance block epoch");
  assert.strictEqual(afterCode.block?.payload.meta?.lazyTokenizedUntil, 1, "enrichment should land on finalized code blocks");

  assert.deepStrictEqual(afterListChildren, originalListChildren, "stale finalized list reorder must be rejected");

  assert.strictEqual(afterTableCell.props?.text, "Alpha", "stale finalized table replacement must be rejected");


  const counters = store.getDebugCounters();
  assert.strictEqual(counters.staleEpochRejected, 2, "expected stale finalized semantic patches to be rejected");
}

await main();
console.log("post-finalize-contract test passed");
