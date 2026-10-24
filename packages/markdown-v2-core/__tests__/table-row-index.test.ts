import assert from "node:assert/strict";
import { createTableRowIndex } from "../src/index";
import type { TableRowRecord } from "../src/index";

const TABLE_ID = "table-index";

function row(index: number, isProvisional: boolean, sourceRevision = 0): TableRowRecord {
  const id = `${TABLE_ID}::row:${index}`;
  const from = index * 4;
  const raw = `r${index}`;
  return {
    id,
    index,
    sourceRange: { from, to: from + 4 },
    sourceRevision,
    isProvisional,
    cells: [{
      id: `${id}::cell:0`,
      index: 0,
      sourceRange: { from: from + 1, to: from + 1 + raw.length },
      raw,
      inline: [{ kind: "text", text: raw }],
    }],
  };
}

const completeRows = Array.from({ length: 64 }, (_value, index) => row(index, false));
const provisionalRow = row(64, true);
const original = createTableRowIndex([...completeRows, provisionalRow]);
const retainedProvisional = original.get(64);
assert.equal(original.completeRowCount, 64);

const reextended = original.replaceTail(64, [row(64, false, 1), row(65, true, 1)]);
assert.equal(reextended.length, 66);
assert.equal(reextended.completeRowCount, 65);
assert.deepEqual(reextended.readRange(63, 66).map((record) => record.index), [63, 64, 65]);
assert.equal(reextended.get(65)?.isProvisional, true);
assert.strictEqual(reextended.get(0), original.get(0), "tail replacement preserves completed prefix records");
assert.ok(retainedProvisional?.isProvisional);
assert.strictEqual(original.get(64), retainedProvisional, "tail replacement leaves the previous index unchanged");
assert.equal(original.completeRowCount, 64);

assert.throws(
  () => createTableRowIndex([row(0, true), row(1, false)]),
  /Only the final table row may be provisional/,
  "only the final table row may be provisional",
);

console.log("table row index test passed");
