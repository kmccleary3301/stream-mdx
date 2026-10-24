import type { InlineNode } from "./types";

export interface TableSourceRange {
  readonly from: number;
  readonly to: number;
}

export type TableAlignment = "left" | "center" | "right" | null;

export interface TableCellRecord {
  readonly id: string;
  readonly index: number;
  readonly sourceRange: TableSourceRange;
  readonly raw: string;
  readonly inline: readonly InlineNode[];
}

export interface TableRowRecord {
  readonly id: string;
  readonly index: number;
  readonly sourceRange: TableSourceRange;
  readonly sourceRevision: number;
  readonly isProvisional: boolean;
  readonly cells: readonly TableCellRecord[];
}

export interface TableHeaderRecord {
  readonly cells: readonly TableCellRecord[];
  readonly align: readonly TableAlignment[];
  /** Native header row through its alignment delimiter, excluding the line ending. */
  readonly sourceRange: TableSourceRange;
}

export interface TableBlockSourceMetadata {
  readonly tableOwnerId: string;
  readonly generation: number;
  readonly revision: number;
  readonly state: "open" | "closed" | "finalized";
  readonly processedTo: number;
  readonly completeRowCount: number;
  readonly rowCount: number;
  readonly sourceRange: TableSourceRange;
}

export interface TableBlockSnapshot extends TableBlockSourceMetadata {
  readonly header: TableHeaderRecord;
  readonly rows: readonly TableRowRecord[];
  readonly raw: string;
}

export type TableCellRecordInput = {
  readonly id: string;
  readonly index: number;
  readonly sourceRange: TableSourceRange;
  readonly raw: string;
  readonly inline: readonly InlineNode[];
};

export type TableRowRecordInput = {
  readonly id: string;
  readonly index: number;
  readonly sourceRange: TableSourceRange;
  readonly sourceRevision: number;
  readonly isProvisional: boolean;
  readonly cells: readonly TableCellRecord[];
};

export type TableHeaderRecordInput = {
  readonly cells: readonly TableCellRecord[];
  readonly align: readonly TableAlignment[];
  readonly sourceRange: TableSourceRange;
};

export type TableBlockSnapshotInput = TableBlockSourceMetadata & {
  readonly header: TableHeaderRecord;
  readonly rows: readonly TableRowRecord[];
  readonly raw: string;
};

function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  if (Array.isArray(value)) {
    for (const child of value) if (!isDeeplyFrozen(child)) return false;
    return true;
  }
  for (const child of Object.values(value)) if (!isDeeplyFrozen(child)) return false;
  return true;
}

function cloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((child) => cloneAndFreeze(child))) as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = cloneAndFreeze(child);
  return Object.freeze(copy) as T;
}

function freezeRange(range: TableSourceRange): TableSourceRange {
  return Object.isFrozen(range) ? range : Object.freeze({ from: range.from, to: range.to });
}

export function freezeTableCellRecord(input: TableCellRecordInput): TableCellRecord {
  if (Object.isFrozen(input) && Object.isFrozen(input.sourceRange)
    && Object.isFrozen(input.inline) && isDeeplyFrozen(input.inline)) return input as TableCellRecord;
  return Object.freeze({
    id: input.id,
    index: input.index,
    sourceRange: freezeRange(input.sourceRange),
    raw: input.raw,
    inline: isDeeplyFrozen(input.inline)
      ? input.inline
      : cloneAndFreeze(input.inline),
  });
}

export function freezeTableRowRecord(input: TableRowRecordInput): TableRowRecord {
  if (Object.isFrozen(input) && Object.isFrozen(input.sourceRange)
    && isDeeplyFrozen(input.cells)) return input as TableRowRecord;
  return Object.freeze({
    id: input.id,
    index: input.index,
    sourceRange: freezeRange(input.sourceRange),
    sourceRevision: input.sourceRevision,
    isProvisional: input.isProvisional,
    cells: isDeeplyFrozen(input.cells)
      ? input.cells
      : Object.freeze(input.cells.map(freezeTableCellRecord)),
  });
}

export function freezeTableHeaderRecord(input: TableHeaderRecordInput): TableHeaderRecord {
  if (Object.isFrozen(input) && Object.isFrozen(input.sourceRange)
    && isDeeplyFrozen(input.cells) && Object.isFrozen(input.align)) return input as TableHeaderRecord;
  return Object.freeze({
    cells: isDeeplyFrozen(input.cells)
      ? input.cells
      : Object.freeze(input.cells.map(freezeTableCellRecord)),
    align: Object.isFrozen(input.align) ? input.align : Object.freeze(input.align.slice()),
    sourceRange: freezeRange(input.sourceRange),
  });
}

export function freezeTableBlockSnapshot(input: TableBlockSnapshotInput): TableBlockSnapshot {
  if (Object.isFrozen(input) && Object.isFrozen(input.sourceRange)
    && isDeeplyFrozen(input.header) && isDeeplyFrozen(input.rows)) return input as TableBlockSnapshot;
  return Object.freeze({
    tableOwnerId: input.tableOwnerId,
    generation: input.generation,
    revision: input.revision,
    state: input.state,
    processedTo: input.processedTo,
    completeRowCount: input.completeRowCount,
    rowCount: input.rowCount,
    sourceRange: freezeRange(input.sourceRange),
    header: freezeTableHeaderRecord(input.header),
    rows: isDeeplyFrozen(input.rows)
      ? input.rows
      : Object.freeze(input.rows.map(freezeTableRowRecord)),
    raw: input.raw,
  });
}
