import assert from "node:assert";
import type {
  ManagedTableViewState,
  TableCellRecord,
  TableHeaderRecord,
  TableRowRecord,
} from "@stream-mdx/core";
import type {
  CounterStage,
  SessionCountersSnapshot,
  StageCounters,
} from "./counter-sink";
import type { DivergenceReport } from "./scaling-diagnostics";

export interface TableBoundaryEvidence {
  ownerId: string;
  generation: number;
  initialCompleteRows: number;
  finalCompleteRows: number;
  appendedRows: number;
  appendPatchCount: number;
  patchRowSlots: number;
  sourcePatchUnits: number;
  sourceSuffixUnits: number;
  exactAuthoredSuffix: boolean;
  coldSemanticParity: boolean;
  retainedFirstCompletedRow: boolean;
  retainedLastCompletedRow: boolean;
  nativeDomRows: number;
  nativeDomCells: number;
  noFinalizeOrInvalidation: boolean;
}

export interface TableScalingObservation {
  stage: CounterStage | "protocol";
  counter: string;
  n: number | null;
  fourN: number | null;
  unitWorkN: number | null;
  unitWork4N: number | null;
  ratio: number | null;
  available: boolean;
  expected?: "zero";
  note?: string;
}

const REQUIRED_TABLE_SOURCE_COUNTERS: readonly {
  readonly stage: CounterStage;
  readonly counter: keyof StageCounters;
}[] = [
  { stage: "engine", counter: "source_units_read" },
  { stage: "engine", counter: "source_units_materialized" },
  { stage: "engine", counter: "inline_source_units_prepared" },
  { stage: "engine", counter: "record_slots_allocated" },
  { stage: "patch", counter: "patches_emitted" },
  { stage: "store", counter: "record_slots_allocated" },
  { stage: "store", counter: "store_records_touched" },
  { stage: "view", counter: "store_records_touched" },
] as const;

function tableCellSemantics(cell: TableCellRecord) {
  return {
    index: cell.index,
    sourceRange: cell.sourceRange,
    raw: cell.raw,
    inline: cell.inline,
  };
}

function tableRowSemantics(row: TableRowRecord) {
  return {
    index: row.index,
    sourceRange: row.sourceRange,
    isProvisional: row.isProvisional,
    cells: row.cells.map(tableCellSemantics),
  };
}

function tableHeaderSemantics(header: TableHeaderRecord) {
  return {
    sourceRange: header.sourceRange,
    align: header.align,
    cells: header.cells.map(tableCellSemantics),
  };
}

export function assertTableSuffixSemanticParity(
  actual: ManagedTableViewState,
  cold: ManagedTableViewState,
  initialCompleteRows: number,
): void {
  assert.equal(cold.rows.length, actual.rows.length, "cold and streaming projections have the same row count");
  assert.deepEqual(tableHeaderSemantics(actual.header), tableHeaderSemantics(cold.header), "table headers match the cold canonical parse");
  for (let index = initialCompleteRows; index < actual.source.completeRowCount; index += 1) {
    const actualRow = actual.rows.get(index);
    const coldRow = cold.rows.get(index);
    assert.ok(actualRow, `streaming suffix row ${index} exists`);
    assert.ok(coldRow, `cold suffix row ${index} exists`);
    assert.deepEqual(tableRowSemantics(actualRow), tableRowSemantics(coldRow), `streaming suffix row ${index} matches cold semantics`);
  }
}

export interface TableScalingEvidenceInput {
  workloadName: string;
  windowUnits: number;
  appendChunkCount: number;
  sourcePrefix: string;
  snapshotN: SessionCountersSnapshot;
  snapshot4N: SessionCountersSnapshot;
  tableBoundaryN?: TableBoundaryEvidence;
  tableBoundary4N?: TableBoundaryEvidence;
  gatePassed: boolean;
}

export interface TableScalingEvidenceResult {
  gatePassed: boolean;
  observations: TableScalingObservation[];
  boundary?: { n: TableBoundaryEvidence; fourN: TableBoundaryEvidence };
}

export function reportTableScalingEvidence(
  input: TableScalingEvidenceInput,
  reportDivergence: (divergence: DivergenceReport) => void,
): TableScalingEvidenceResult {
  const {
    workloadName,
    windowUnits,
    appendChunkCount,
    sourcePrefix,
    snapshotN,
    snapshot4N,
    tableBoundaryN,
    tableBoundary4N,
  } = input;
  let gatePassed = input.gatePassed;
  const observations: TableScalingObservation[] = [];
  let boundary: TableScalingEvidenceResult["boundary"];

  const observe = (
    stage: CounterStage | "protocol",
    counter: string,
    n: number | null,
    fourN: number | null,
    expectedZero = false,
    note?: string,
  ): TableScalingObservation => {
    if (expectedZero) {
      return {
        stage,
        counter,
        n,
        fourN,
        unitWorkN: null,
        unitWork4N: null,
        ratio: null,
        available: n !== null && fourN !== null,
        expected: "zero",
        note,
      };
    }
    const unitWorkN = n !== null && fourN !== null && n > 0 && fourN > 0
      ? n / windowUnits
      : null;
    const unitWork4N = n !== null && fourN !== null && n > 0 && fourN > 0
      ? fourN / windowUnits
      : null;
    const available = unitWorkN !== null && unitWork4N !== null;
    return {
      stage,
      counter,
      n,
      fourN,
      unitWorkN,
      unitWork4N,
      ratio: unitWorkN !== null && unitWork4N !== null && unitWorkN !== 0
        ? unitWork4N / unitWorkN
        : null,
      available,
      note,
    };
  };

  const reportMissing = (observation: TableScalingObservation): void => {
    gatePassed = false;
    reportDivergence({
      fixtureId: `scaling-${workloadName}`,
      planMode: "window-append",
      seed: 0,
      stage: `diagnostic:scaling:missing:${observation.stage}:${observation.counter}`,
      commitIndex: appendChunkCount,
      frontier: windowUnits,
      sourcePrefix,
      message: `Table work observation '${observation.stage}.${observation.counter}' is unavailable in both bounded append windows; observed N=${observation.n ?? "missing"}, 4N=${observation.fourN ?? "missing"}`,
    });
  };

  for (const { stage, counter } of REQUIRED_TABLE_SOURCE_COUNTERS) {
    const observation = observe(
      stage,
      counter,
      snapshotN.stages[stage][counter],
      snapshot4N.stages[stage][counter],
    );
    observations.push(observation);
    if (!observation.available) reportMissing(observation);
  }

  const patchRowsObservation = observe(
    "protocol",
    "appendTableRows.rowSlots",
    tableBoundaryN?.patchRowSlots ?? null,
    tableBoundary4N?.patchRowSlots ?? null,
    false,
    "Counted from actual semantic PATCH payloads, not inferred from store state.",
  );
  observations.push(patchRowsObservation);
  if (!patchRowsObservation.available) {
    reportMissing(patchRowsObservation);
  } else if (patchRowsObservation.ratio !== null && patchRowsObservation.ratio > 1.25) {
    gatePassed = false;
    reportDivergence({
      fixtureId: `scaling-${workloadName}`,
      planMode: "window-append",
      seed: 0,
      stage: "diagnostic:scaling:patch:appendTableRows.rowSlots",
      commitIndex: appendChunkCount,
      frontier: windowUnits,
      sourcePrefix,
      message: `Table patch row-slot ratio ${patchRowsObservation.ratio.toFixed(2)}x exceeds the unchanged 1.25x gate`,
    });
  }

  const noMaterializationObservation = observe(
    "snapshot",
    "source_units_materialized",
    snapshotN.stages.snapshot.source_units_materialized,
    snapshot4N.stages.snapshot.source_units_materialized,
    true,
    "Expected zero measured whole-table/source materialization; baseline setup materializes before sink reset.",
  );
  observations.push(noMaterializationObservation);
  if (noMaterializationObservation.n !== 0 || noMaterializationObservation.fourN !== 0) {
    gatePassed = false;
    reportDivergence({
      fixtureId: `scaling-${workloadName}`,
      planMode: "window-append",
      seed: 0,
      stage: "diagnostic:scaling:unexpected-source-materialization",
      commitIndex: appendChunkCount,
      frontier: windowUnits,
      sourcePrefix,
      message: `Measured table append window must not materialize whole source/store projections: snapshot units N=${noMaterializationObservation.n}, 4N=${noMaterializationObservation.fourN}`,
    });
  }

  const tableViewRows = observe(
    "view",
    "table_rows_rendered",
    snapshotN.stages.view.table_rows_rendered,
    snapshot4N.stages.view.table_rows_rendered,
    false,
    "Counted from actual native body-row render callbacks inside the diagnostic guard.",
  );
  const tableViewCells = observe(
    "view",
    "table_cells_rendered",
    snapshotN.stages.view.table_cells_rendered,
    snapshot4N.stages.view.table_cells_rendered,
    false,
    "Counted from actual native header/body cell render callbacks inside the diagnostic guard.",
  );
  observations.push(tableViewRows, tableViewCells);
  for (const observation of [tableViewRows, tableViewCells]) {
    if (!observation.available) {
      reportMissing(observation);
    } else if (observation.ratio !== null && observation.ratio > 1.25) {
      gatePassed = false;
      reportDivergence({
        fixtureId: `scaling-${workloadName}`,
        planMode: "window-append",
        seed: 0,
        stage: `diagnostic:scaling:${observation.stage}:${observation.counter}`,
        commitIndex: appendChunkCount,
        frontier: windowUnits,
        sourcePrefix,
        message: `Native table view counter '${observation.counter}' ratio ${observation.ratio.toFixed(2)}x exceeds the unchanged 1.25x gate`,
      });
    }
  }

  if (!tableBoundaryN || !tableBoundary4N) {
    gatePassed = false;
    reportDivergence({
      fixtureId: `scaling-${workloadName}`,
      planMode: "window-append",
      seed: 0,
      stage: "diagnostic:scaling:missing-table-boundary",
      commitIndex: 0,
      frontier: 0,
      sourcePrefix: "",
      message: "Actual native table boundary evidence is unavailable; no source, cold-parity, identity, or DOM pass is inferred.",
    });
  } else {
    boundary = { n: tableBoundaryN, fourN: tableBoundary4N };
    if (
      !tableBoundaryN.exactAuthoredSuffix ||
      !tableBoundary4N.exactAuthoredSuffix ||
      !tableBoundaryN.coldSemanticParity ||
      !tableBoundary4N.coldSemanticParity ||
      !tableBoundaryN.retainedFirstCompletedRow ||
      !tableBoundary4N.retainedFirstCompletedRow ||
      !tableBoundaryN.retainedLastCompletedRow ||
      !tableBoundary4N.retainedLastCompletedRow ||
      !tableBoundaryN.noFinalizeOrInvalidation ||
      !tableBoundary4N.noFinalizeOrInvalidation
    ) {
      gatePassed = false;
      reportDivergence({
        fixtureId: `scaling-${workloadName}`,
        planMode: "window-append",
        seed: 0,
        stage: "diagnostic:scaling:table-boundary",
        commitIndex: appendChunkCount,
        frontier: windowUnits,
        sourcePrefix,
        message: "Native table source, cold semantic parity, retained-row identity, or append-only boundary evidence failed.",
      });
    }
  }

  return {
    gatePassed,
    observations,
    ...(boundary ? { boundary } : {}),
  };
}
