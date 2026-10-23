import assert from "node:assert/strict";
import {
  appendManagedTableRows,
  createManagedTableState,
  materializeManagedTableSnapshot,
} from "../src/table-block-state";
import type {
  TableBlockSnapshot,
  TableBlockSourceMetadata,
  TableCellRecord,
  TableRowRecord,
} from "../src/table-records";
import type { Patch } from "../src/types";
import { AppendSourceDocument } from "../src/source-document";

const TABLE_ID = "table-1";
const INITIAL_SOURCE = "|h|\r\n|---|\r\n|x";
const RETRACTED_SOURCE = "|h|\r\n|---|\r\n|x\r\n|stable|";
const REEXTENDED_SOURCE = "|h|\r\n|---|\r\n|x\r\n|stable|\r\n|z";

function cell(id: string, raw: string, from: number, to: number): TableCellRecord {
  return {
    id,
    index: 0,
    sourceRange: { from, to },
    raw,
    inline: raw ? [{ kind: "text", text: raw }] : [],
  };
}

function row(
  index: number,
  from: number,
  to: number,
  raw: string,
  cellFrom: number,
  cellTo: number,
  sourceRevision: number,
  isProvisional: boolean,
): TableRowRecord {
  const id = `${TABLE_ID}::row:${index}`;
  return {
    id,
    index,
    sourceRange: { from, to },
    sourceRevision,
    isProvisional,
    cells: [cell(`${id}::cell:0`, raw, cellFrom, cellTo)],
  };
}

function metadata(
  revision: number,
  processedTo: number,
  rangeTo: number,
  completeRowCount: number,
  rowCount: number,
): TableBlockSourceMetadata {
  return {
    tableOwnerId: TABLE_ID,
    generation: 1,
    revision,
    state: "open",
    processedTo,
    completeRowCount,
    rowCount,
    sourceRange: { from: 0, to: rangeTo },
  };
}

function appendPatch(
  expectedRevision: number,
  table: TableBlockSourceMetadata,
  fromRow: number,
  rows: readonly TableRowRecord[],
  sourceAppend: string,
): Extract<Patch, { op: "appendTableRows" }> {
  return {
    op: "appendTableRows",
    at: { blockId: TABLE_ID },
    expectedRevision,
    fromRow,
    rows,
    sourceAppend,
    table,
  };
}

// A retracted provisional tail may return only when its retained source bytes are identical.
const initialState = createManagedTableState({
  ...metadata(0, 14, 14, 0, 1),
  header: {
    cells: [cell(`${TABLE_ID}::header::cell:0`, "h", 1, 2)],
    align: [null],
    sourceRange: { from: 0, to: 10 },
  },
  rows: [row(0, 12, 14, "x", 13, 14, 0, true)],
  raw: INITIAL_SOURCE,
} satisfies TableBlockSnapshot, TABLE_ID);
const initialSnapshot = materializeManagedTableSnapshot(initialState);
assert.strictEqual(initialSnapshot.raw, INITIAL_SOURCE);

const firstAppend = appendManagedTableRows(
  initialState,
  TABLE_ID,
  appendPatch(
    0,
    metadata(1, 28, 28, 2, 3),
    0,
    [
      row(0, 12, 14, "x", 13, 14, 1, false),
      row(1, 16, 24, "stable", 17, 23, 1, false),
      row(2, 26, 28, "z", 27, 28, 1, true),
    ],
    "\r\n|stable|\r\n|z",
  ),
);
assert.ok("state" in firstAppend, "table source can admit a completed row and provisional tail");

const retraction = appendManagedTableRows(
  firstAppend.state,
  TABLE_ID,
  appendPatch(1, metadata(2, 29, 24, 2, 2), 2, [], ""),
);
assert.ok("state" in retraction, "a provisional tail can be returned to the document parser");
const retractedSnapshot = materializeManagedTableSnapshot(retraction.state);
assert.strictEqual(retractedSnapshot.raw, RETRACTED_SOURCE);

const identicalReextension = appendManagedTableRows(
  retraction.state,
  TABLE_ID,
  appendPatch(
    2,
    metadata(3, 29, 28, 2, 3),
    2,
    [row(2, 26, 28, "z", 27, 28, 3, true)],
    "\r\n|z",
  ),
);
assert.ok("state" in identicalReextension, "identical retained provisional bytes can be re-extended");
assert.strictEqual(materializeManagedTableSnapshot(identicalReextension.state).raw, REEXTENDED_SOURCE);
assert.strictEqual(retractedSnapshot.raw, RETRACTED_SOURCE, "re-extension does not grow an earlier snapshot");

assert.throws(
  () => appendManagedTableRows(
    retraction.state,
    TABLE_ID,
    appendPatch(
      2,
      metadata(3, 29, 28, 2, 3),
      2,
      [row(2, 26, 28, "q", 27, 28, 3, true)],
      "\r\n|q",
    ),
  ),
  RangeError,
  "re-extension cannot rewrite bytes admitted before the provisional-tail retraction",
);
assert.strictEqual(materializeManagedTableSnapshot(retraction.state).raw, RETRACTED_SOURCE);
assert.strictEqual(retractedSnapshot.raw, RETRACTED_SOURCE, "rejected re-extension preserves the earlier snapshot");
assert.strictEqual(initialSnapshot.raw, INITIAL_SOURCE, "later table updates preserve the original snapshot");


// The canonical-source path must validate the claimed append, even when the changed bytes are outside cell ranges.
const canonicalDocument = new AppendSourceDocument();
canonicalDocument.append(INITIAL_SOURCE);
const canonicalState = createManagedTableState(
  initialSnapshot,
  TABLE_ID,
  undefined,
  canonicalDocument.snapshot(),
);
const canonicalHistorical = materializeManagedTableSnapshot(canonicalState);
const canonicalSourceAppend = "\r\n|stable|\r\n|z";
canonicalDocument.append(canonicalSourceAppend);
const canonicalSnapshot = canonicalDocument.snapshot();
assert.strictEqual(canonicalSnapshot.materialize(), REEXTENDED_SOURCE);

const canonicalRows = [
  row(0, 12, 14, "x", 13, 14, 1, false),
  row(1, 16, 24, "stable", 17, 23, 1, false),
  row(2, 26, 28, "z", 27, 28, 1, true),
];
const canonicalAppend = appendManagedTableRows(
  canonicalState,
  TABLE_ID,
  appendPatch(0, metadata(1, 28, 28, 2, 3), 0, canonicalRows, canonicalSourceAppend),
  canonicalSnapshot,
);
assert.ok("state" in canonicalAppend, "a canonical CRLF append matching the source document is accepted");
assert.strictEqual(materializeManagedTableSnapshot(canonicalAppend.state).raw, REEXTENDED_SOURCE);
assert.strictEqual(canonicalHistorical.raw, INITIAL_SOURCE, "canonical append preserves the earlier snapshot");

assert.throws(
  () => appendManagedTableRows(
    canonicalState,
    TABLE_ID,
    appendPatch(0, metadata(1, 28, 28, 2, 3), 0, canonicalRows, "xx|stable|\r\n|z"),
    canonicalSnapshot,
  ),
  RangeError,
  "canonical input rejects a same-length append that rewrites only the CRLF separator",
);
assert.strictEqual(canonicalHistorical.raw, INITIAL_SOURCE, "rejected canonical append preserves the earlier snapshot");

console.log("table block state test passed");
