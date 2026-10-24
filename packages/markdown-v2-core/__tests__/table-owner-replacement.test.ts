import assert from "node:assert/strict";
import { applyPatchBatch, createInitialSnapshot } from "../src/block-snapshot";
import { freezeTableBlockSnapshot, type TableBlockSnapshotInput } from "../src/table-records";
import { PATCH_ROOT_ID } from "../src/types";
import type { Block, InlineNode, NodeSnapshot } from "../src/types";

const tableId = "active-table";
const rawFor = (headerText: string) => `| ${headerText} |\n| --- |\n| x |`;

function tableNode(revision: number, meaning: string, headerText = "H"): NodeSnapshot {
  const raw = rawFor(headerText);
  const block: Block = {
    id: tableId,
    type: "table",
    isFinalized: false,
    payload: { raw, range: { from: 0, to: raw.length }, meta: {} },
  };
  const rowId = `${tableId}::row:0`;
  const table: TableBlockSnapshotInput = {
    tableOwnerId: tableId,
    generation: 4,
    revision,
    state: "open",
    processedTo: raw.length,
    completeRowCount: 1,
    rowCount: 1,
    sourceRange: { from: 0, to: raw.length },
    header: {
      sourceRange: { from: 0, to: 13 },
      align: [null],
      cells: [{
        id: `${tableId}::header-cell:0`,
        index: 0,
        raw: headerText,
        sourceRange: { from: 2, to: 2 + headerText.length },
        inline: [{ kind: "text", text: headerText }],
      }],
    },
    rows: [{
      id: rowId,
      index: 0,
      sourceRange: { from: 14, to: 19 },
      sourceRevision: 1,
      isProvisional: false,
      cells: [{
        id: `${rowId}::cell:0`,
        index: 0,
        raw: "x",
        sourceRange: { from: 16, to: 17 },
        inline: [{ kind: "text", text: meaning }],
      }],
    }],
    raw,
  };
  return { id: tableId, type: "table", props: { block }, table: freezeTableBlockSnapshot(table) };
}

function materializedCellText(snapshot: ReturnType<typeof createInitialSnapshot>): string {
  const block = snapshot.getBlocks()[0];
  assert.ok(block);
  const rows = block.payload.meta?.rows as InlineNode[][][] | undefined;
  return rows?.[0]?.[0]?.map((node) => node.kind === "text" ? node.text : "").join("") ?? "";
}

const snapshot = createInitialSnapshot({
  id: PATCH_ROOT_ID,
  type: "__root__",
  children: [tableNode(1, "Old meaning")],
});
applyPatchBatch(snapshot, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: tableNode(2, "Current meaning"),
}]);
assert.equal(materializedCellText(snapshot), "Current meaning",
  "same-generation active table replacement publishes current semantic rows");

applyPatchBatch(snapshot, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: tableNode(1, "Old meaning"),
}]);
assert.equal(materializedCellText(snapshot), "Current meaning",
  "delayed table replacement cannot restore an older semantic row snapshot");

applyPatchBatch(snapshot, [{ op: "deleteChild", at: { blockId: PATCH_ROOT_ID }, index: 0 }]);
applyPatchBatch(snapshot, [{
  op: "insertChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: tableNode(3, "Retired generation"),
}]);
assert.deepEqual(snapshot.getBlocks(), [], "a truly retired table generation cannot be reinserted");

const mismatchedIdentity = createInitialSnapshot({
  id: PATCH_ROOT_ID,
  type: "__root__",
  children: [tableNode(1, "Old meaning")],
});
applyPatchBatch(mismatchedIdentity, [{
  op: "replaceChild",
  at: { blockId: PATCH_ROOT_ID },
  index: 0,
  node: tableNode(2, "Changed header", "J"),
}]);
assert.equal(materializedCellText(mismatchedIdentity), "Old meaning",
  "same-generation replacement cannot change the table header source identity");

console.log("table owner replacement test passed");
