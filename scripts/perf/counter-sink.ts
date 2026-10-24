/**
 * Private per-session counter sink for deterministic work observation.
 * Follows the CounterSeams contract in local://counter-seams-contract.md.
 */
import type { SourceSnapshot } from "@stream-mdx/core";
import type { ProgressObservationEvent, Publication } from "./progress-observation";

export interface SessionCounterSinkOptions {
  readonly enableProgressTrace?: boolean;
  readonly onProgressTrace?: (event: ProgressObservationEvent) => void;
}

export type InvalidationCause =
  | "link_reference_definition"
  | "footnote_definition"
  | "numbering"
  | "list_looseness"
  | "un-enumerated";

export interface InvalidationRecord {
  cause: InvalidationCause;
  blockId: string;
  affectedFields: string[];
}

export interface PublicationRecord {
  tx: number;
  frontier: number;
}



export type CounterStage = "engine" | "snapshot" | "patch" | "store" | "view";

export const COUNTER_STAGES: readonly CounterStage[] = [
  "engine",
  "snapshot",
  "patch",
  "store",
  "view",
] as const;

export interface StageCounters {
  lines_tokenized: number;
  units_tokenized: number;
  inline_source_units_prepared: number;
  source_units_read: number;
  source_units_materialized: number;
  source_directory_entries_copied: number;
  record_slots_allocated: number;
  code_source_units_prepared: number;
  snapshot_nodes_built: number;
  prefix_comparisons: number;
  patches_emitted: number;
  store_records_touched: number;
  table_rows_rendered: number;
  table_cells_rendered: number;
  blocks_reprepared: number;
  document_records_visited: number;
}

export interface SessionCountersSnapshot {
  lines_tokenized: number;
  units_tokenized: number;
  inline_source_units_prepared: number;
  source_units_read: number;
  source_units_materialized: number;
  source_directory_entries_copied: number;
  record_slots_allocated: number;
  code_source_units_prepared: number;
  snapshot_nodes_built: number;
  prefix_comparisons: number;
  patches_emitted: number;
  store_records_touched: number;
  blocks_reprepared: number;
  document_records_visited: number;
  stages: Record<CounterStage, StageCounters>;
  invalidations: InvalidationRecord[];
  processed_frontier: number;
  last_tx: number;
  publications: PublicationRecord[];
}

function createEmptyStageCounters(): StageCounters {
  return {
    lines_tokenized: 0,
    units_tokenized: 0,
    inline_source_units_prepared: 0,
    source_units_read: 0,
    source_units_materialized: 0,
    source_directory_entries_copied: 0,
    record_slots_allocated: 0,
    code_source_units_prepared: 0,
    snapshot_nodes_built: 0,
    prefix_comparisons: 0,
    patches_emitted: 0,
    store_records_touched: 0,
    table_rows_rendered: 0,
    table_cells_rendered: 0,
    blocks_reprepared: 0,
    document_records_visited: 0,
  };
}

function createEmptyStages(): Record<CounterStage, StageCounters> {
  return {
    engine: createEmptyStageCounters(),
    snapshot: createEmptyStageCounters(),
    patch: createEmptyStageCounters(),
    store: createEmptyStageCounters(),
    view: createEmptyStageCounters(),
  };
}

export class SessionCounterSink {
  lines_tokenized = 0;
  units_tokenized = 0;
  inline_source_units_prepared = 0;
  source_units_read = 0;
  source_units_materialized = 0;
  source_directory_entries_copied = 0;
  record_slots_allocated = 0;
  code_source_units_prepared = 0;
  snapshot_nodes_built = 0;
  prefix_comparisons = 0;
  patches_emitted = 0;
  store_records_touched = 0;
  blocks_reprepared = 0;
  document_records_visited = 0;
  readonly invalidations: InvalidationRecord[] = [];
  readonly publications: PublicationRecord[] = [];
  readonly stages: Record<CounterStage, StageCounters> = createEmptyStages();
  processed_frontier = 0;
  last_tx = 0;

  private progressTraceCallback?: (event: ProgressObservationEvent) => void;
  private sourceSnapshotReader?: () => SourceSnapshot;

  constructor(options: SessionCounterSinkOptions = {}) {
    if (options.enableProgressTrace) {
      this.progressTraceCallback = options.onProgressTrace;
    }
  }
  attachSourceSnapshotReader(reader: () => SourceSnapshot): void {
    this.sourceSnapshotReader = reader;
  }

  readSourceSnapshot(): SourceSnapshot {
    const reader = this.sourceSnapshotReader;
    if (!reader) throw new Error("The diagnostic source snapshot reader is not attached.");
    return reader();
  }

  isProgressTraceEnabled(): boolean {
    return this.progressTraceCallback !== undefined;
  }

  beginProgressDocument(generation: number): void {
    this.progressTraceCallback?.({ type: "document", generation });
  }

  recordEngineEntered(generation: number, sourceUnits: number): void {
    this.progressTraceCallback?.({ type: "engine-entered", generation, sourceUnits });
  }

  recordParsedPublication(publication: Publication): void {
    this.progressTraceCallback?.({ type: "parsed-publication", publication });
  }

  recordTokenization(lines: number, units: number, stage: CounterStage = "engine"): void {
    this.lines_tokenized += lines;
    this.units_tokenized += units;
    const s = this.stages[stage];
    if (s) {
      s.lines_tokenized += lines;
      s.units_tokenized += units;
    }
  }

  recordInlineSourceUnits(units: number, stage: CounterStage = "engine"): void {
    this.inline_source_units_prepared += units;
    this.stages[stage].inline_source_units_prepared += units;
  }
  recordSourceUnitsRead(units: number, stage: CounterStage = "engine"): void {
    this.source_units_read += units;
    const s = this.stages[stage];
    if (s) s.source_units_read += units;
  }

  recordSourceUnitsMaterialized(units: number, stage: CounterStage = "snapshot"): void {
    this.source_units_materialized += units;
    const s = this.stages[stage];
    if (s) s.source_units_materialized += units;
  }

  recordSourceDirectoryEntriesCopied(count: number, stage: CounterStage = "engine"): void {
    this.source_directory_entries_copied += count;
    const s = this.stages[stage];
    if (s) s.source_directory_entries_copied += count;
  }

  recordRecordSlotsAllocated(count: number, stage: CounterStage = "engine"): void {
    this.record_slots_allocated += count;
    const s = this.stages[stage];
    if (s) s.record_slots_allocated += count;
  }

  recordCodeSourceUnitsPrepared(units: number, stage: CounterStage = "engine"): void {
    this.code_source_units_prepared += units;
    const s = this.stages[stage];
    if (s) s.code_source_units_prepared += units;
  }


  recordSnapshotNodes(count = 1, stage: CounterStage = "snapshot"): void {
    this.snapshot_nodes_built += count;
    const s = this.stages[stage];
    if (s) {
      s.snapshot_nodes_built += count;
    }
  }

  recordPrefixComparisons(count = 1, stage: CounterStage = "patch"): void {
    this.prefix_comparisons += count;
    const s = this.stages[stage];
    if (s) {
      s.prefix_comparisons += count;
    }
  }
  recordDocumentRecordsVisited(count: number, stage: CounterStage = "engine"): void {
    this.document_records_visited += count;
    this.stages[stage].document_records_visited += count;
  }

  recordPatchesEmitted(count: number, stage: CounterStage = "patch"): void {
    this.patches_emitted += count;
    const s = this.stages[stage];
    if (s) {
      s.patches_emitted += count;
    }
  }

  recordStoreRecordsTouched(count: number, stage: CounterStage = "store"): void {
    this.store_records_touched += count;
    const s = this.stages[stage];
    if (s) {
      s.store_records_touched += count;
    }
  }
  recordTableViewRows(count: number): void {
    this.stages.view.table_rows_rendered += count;
  }

  recordTableViewCells(count: number): void {
    this.stages.view.table_cells_rendered += count;
  }


  recordInvalidation(cause: InvalidationCause, blockId: string, fields?: string[]): void {
    this.invalidations.push({ cause, blockId, affectedFields: fields ?? [] });
  }

  recordBlockReprepared(
    cause?: InvalidationCause,
    blockId?: string,
    fields?: string[],
    stage: CounterStage = "engine",
  ): void {
    this.blocks_reprepared += 1;
    const s = this.stages[stage];
    if (s) {
      s.blocks_reprepared += 1;
    }
    if (cause && blockId) {
      this.invalidations.push({ cause, blockId, affectedFields: fields ?? [] });
    }
  }

  /** Legacy PARSED frontier used by the Node oracle; this is not an apply acknowledgement. */
  recordPublication(tx: number, frontier: number): void {
    this.last_tx = tx;
    this.processed_frontier = frontier;
    this.publications.push({ tx, frontier });
  }

  recordProcessedFrontier(frontier: number, tx?: number): void {
    this.processed_frontier = frontier;
    if (tx !== undefined) {
      this.last_tx = tx;
      this.publications.push({ tx, frontier });
    }
  }

  snapshot(): SessionCountersSnapshot {
    return {
      lines_tokenized: this.lines_tokenized,
      units_tokenized: this.units_tokenized,
      inline_source_units_prepared: this.inline_source_units_prepared,
      source_units_read: this.source_units_read,
      source_units_materialized: this.source_units_materialized,
      source_directory_entries_copied: this.source_directory_entries_copied,
      record_slots_allocated: this.record_slots_allocated,
      code_source_units_prepared: this.code_source_units_prepared,
      snapshot_nodes_built: this.snapshot_nodes_built,
      prefix_comparisons: this.prefix_comparisons,
      patches_emitted: this.patches_emitted,
      store_records_touched: this.store_records_touched,
      blocks_reprepared: this.blocks_reprepared,
      document_records_visited: this.document_records_visited,
      stages: {
        engine: { ...this.stages.engine },
        snapshot: { ...this.stages.snapshot },
        patch: { ...this.stages.patch },
        store: { ...this.stages.store },
        view: { ...this.stages.view },
      },
      invalidations: [...this.invalidations],
      processed_frontier: this.processed_frontier,
      last_tx: this.last_tx,
      publications: [...this.publications],
    };
  }

  reset(): void {
    this.lines_tokenized = 0;
    this.units_tokenized = 0;
    this.inline_source_units_prepared = 0;
    this.source_units_read = 0;
    this.source_units_materialized = 0;
    this.source_directory_entries_copied = 0;
    this.record_slots_allocated = 0;
    this.code_source_units_prepared = 0;
    this.snapshot_nodes_built = 0;
    this.prefix_comparisons = 0;
    this.patches_emitted = 0;
    this.store_records_touched = 0;
    this.blocks_reprepared = 0;
    this.document_records_visited = 0;
    this.processed_frontier = 0;
    this.last_tx = 0;
    this.invalidations.length = 0;
    this.publications.length = 0;
    for (const key of COUNTER_STAGES) {
      const s = this.stages[key];
      s.lines_tokenized = 0;
      s.units_tokenized = 0;
      s.inline_source_units_prepared = 0;
      s.source_units_read = 0;
      s.source_units_materialized = 0;
      s.source_directory_entries_copied = 0;
      s.record_slots_allocated = 0;
      s.code_source_units_prepared = 0;
      s.snapshot_nodes_built = 0;
      s.prefix_comparisons = 0;
      s.patches_emitted = 0;
      s.store_records_touched = 0;
      s.table_rows_rendered = 0;
      s.table_cells_rendered = 0;
      s.blocks_reprepared = 0;
      s.document_records_visited = 0;
    }
  }
}
