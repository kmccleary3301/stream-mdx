import assert from "node:assert";
import {
  freezeTableBlockSnapshot,
  freezeTableCellRecord,
  freezeTableHeaderRecord,
  freezeTableRowRecord,
  type TableBlockSnapshotInput,
  type TableCellRecordInput,
} from "../src/table-records";

function assertDeeplyFrozen(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value), `${path} must be frozen`);
  for (const [key, child] of Object.entries(value)) assertDeeplyFrozen(child, `${path}.${key}`);
}

/** Plain mutable input, as a table patch arrives from structured clone. */
function mutableCell(index: number, text: string): TableCellRecordInput {
  return {
    id: `cell-${index}`,
    index,
    sourceRange: { from: index * 4, to: index * 4 + text.length },
    raw: text,
    inline: [{ kind: "strong", children: [{ kind: "text", text }] }],
  } as TableCellRecordInput;
}

function mutableSnapshot(): TableBlockSnapshotInput {
  return {
    tableOwnerId: "table-1",
    generation: 1,
    revision: 2,
    state: "open",
    processedTo: 40,
    completeRowCount: 1,
    rowCount: 2,
    sourceRange: { from: 0, to: 40 },
    header: { cells: [mutableCell(0, "A"), mutableCell(1, "B")], align: ["left", null], sourceRange: { from: 0, to: 8 } },
    rows: [
      { id: "row-0", index: 0, sourceRange: { from: 16, to: 24 }, sourceRevision: 1, isProvisional: false, cells: [mutableCell(0, "a1"), mutableCell(1, "b1")] },
      { id: "row-1", index: 1, sourceRange: { from: 25, to: 40 }, sourceRevision: 2, isProvisional: true, cells: [mutableCell(0, "a2")] },
    ],
    raw: "| A | B |\n| - | - |\n| a1 | b1 |\n| a2",
  } as TableBlockSnapshotInput;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Mutable input becomes a deeply frozen record that later input mutation cannot reach.
{
  const input = mutableSnapshot();
  const snapshot = freezeTableBlockSnapshot(input);
  assertDeeplyFrozen(snapshot, "snapshot");
  const before = JSON.stringify(snapshot);
  (input.rows[0].cells[0].inline[0] as { children: Array<{ text: string }> }).children[0].text = "mutated";
  (input.header.align as Array<string | null>)[1] = "right";
  input.header.cells[1].sourceRange.to = 999;
  input.rows[1].sourceRange.to = 999;
  input.sourceRange.to = 999;
  (input.rows as unknown[]).push(input.rows[0]);
  assert.strictEqual(JSON.stringify(snapshot), before, "a frozen snapshot must not alias caller-owned input");

  const cellInput = mutableCell(0, "x");
  const cell = freezeTableCellRecord(cellInput);
  assertDeeplyFrozen(cell, "cell");
  (cellInput.inline[0] as { kind: string }).kind = "em";
  assert.strictEqual((cell.inline[0] as { kind: string }).kind, "strong", "cell inline must not alias caller-owned input");

  const rowInput = mutableSnapshot().rows[0];
  const row = freezeTableRowRecord(rowInput);
  assertDeeplyFrozen(row, "row");
  rowInput.cells[0].raw = "mutated";
  assert.strictEqual(row.cells[0].raw, "a1", "row cells must not alias caller-owned input");

  const headerInput = mutableSnapshot().header;
  const header = freezeTableHeaderRecord(headerInput);
  assertDeeplyFrozen(header, "header");
  (headerInput.align as Array<string | null>)[0] = "center";
  assert.strictEqual(header.align[0], "left", "header align must not alias caller-owned input");
}

// Already deeply frozen records are reused, so unchanged records keep their identity.
{
  const frozen = deepFreeze(mutableSnapshot());
  assert.strictEqual(freezeTableBlockSnapshot(frozen), frozen, "frozen snapshot is reused");
  assert.strictEqual(freezeTableHeaderRecord(frozen.header), frozen.header, "frozen header is reused");
  assert.strictEqual(freezeTableRowRecord(frozen.rows[0]), frozen.rows[0], "frozen row is reused");
  assert.strictEqual(freezeTableCellRecord(frozen.rows[0].cells[0]), frozen.rows[0].cells[0], "frozen cell is reused");

  // A partially frozen snapshot copies only what is still mutable and reuses its frozen parts.
  const partial = { ...frozen, rows: [...frozen.rows] };
  const fromPartial = freezeTableBlockSnapshot(partial);
  assert.notStrictEqual(fromPartial.rows, partial.rows, "a mutable rows array is copied");
  assert.strictEqual(fromPartial.rows[0], frozen.rows[0], "frozen rows inside a copied array keep their identity");
  assert.strictEqual(fromPartial.header, frozen.header, "a frozen header inside a copied snapshot keeps its identity");
}

// A frozen outer record with a mutable part is still copied, never returned as-is.
{
  const base = deepFreeze(mutableSnapshot());
  const cellWithMutableRange = Object.freeze({ ...base.rows[0].cells[0], sourceRange: { from: 0, to: 2 } });
  const cell = freezeTableCellRecord(cellWithMutableRange);
  assert.notStrictEqual(cell, cellWithMutableRange, "a cell with a mutable range is copied");
  assertDeeplyFrozen(cell, "cell with mutable range");

  const mutableGrandchildren = [{ kind: "text", text: "deep" }];
  const cellWithDeepMutableInline = Object.freeze({
    ...base.rows[0].cells[0],
    inline: Object.freeze([Object.freeze({ kind: "strong", children: mutableGrandchildren })]),
  });
  const deepCopy = freezeTableCellRecord(cellWithDeepMutableInline as TableCellRecordInput);
  assertDeeplyFrozen(deepCopy, "cell with deep mutable inline");
  mutableGrandchildren.push({ kind: "text", text: "late" });
  assert.strictEqual(JSON.stringify(deepCopy.inline).includes("late"), false, "deep inline content must not alias caller-owned input");

  const cellWithMutableInline = Object.freeze({ ...base.rows[0].cells[0], inline: [{ kind: "text", text: "t" }] });
  const inlineCopy = freezeTableCellRecord(cellWithMutableInline as TableCellRecordInput);
  assert.notStrictEqual(inlineCopy, cellWithMutableInline, "a cell with mutable inline content is copied");
  assertDeeplyFrozen(inlineCopy, "cell with mutable inline");

  const cellWithMutableNestedInline = Object.freeze({
    ...base.rows[0].cells[0],
    inline: Object.freeze([{ kind: "text", text: "t" }]),
  });
  assertDeeplyFrozen(freezeTableCellRecord(cellWithMutableNestedInline as TableCellRecordInput), "cell with mutable nested inline");

  const rowWithMutableRange = Object.freeze({ ...base.rows[0], sourceRange: { from: 16, to: 24 } });
  assert.notStrictEqual(freezeTableRowRecord(rowWithMutableRange), rowWithMutableRange, "a row with a mutable range is copied");
  const rowWithMutableCells = Object.freeze({ ...base.rows[0], cells: [...base.rows[0].cells] });
  assertDeeplyFrozen(freezeTableRowRecord(rowWithMutableCells), "row with mutable cells");

  const headerWithMutableAlign = Object.freeze({ ...base.header, align: ["left", null] });
  assertDeeplyFrozen(freezeTableHeaderRecord(headerWithMutableAlign as never), "header with mutable align");
  const headerWithMutableRange = Object.freeze({ ...base.header, sourceRange: { from: 0, to: 8 } });
  assertDeeplyFrozen(freezeTableHeaderRecord(headerWithMutableRange), "header with mutable range");

  const snapshotWithMutableRange = Object.freeze({ ...base, sourceRange: { from: 0, to: 40 } });
  assertDeeplyFrozen(freezeTableBlockSnapshot(snapshotWithMutableRange), "snapshot with mutable range");
  const snapshotWithMutableHeader = Object.freeze({ ...base, header: { ...base.header } });
  assertDeeplyFrozen(freezeTableBlockSnapshot(snapshotWithMutableHeader), "snapshot with mutable header");
}

console.log("table records test passed");
