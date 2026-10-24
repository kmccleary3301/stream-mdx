import type { CodeLineRecord } from "./code-records";
import type { CodeBlockSourceMetadata } from "./types";
import type { TableBlockSourceMetadata, TableHeaderRecord, TableRowRecord } from "./table-records";

const tableNodeHandleBrand: unique symbol = Symbol("TableNodeHandle");
const codeNodeHandleBrand: unique symbol = Symbol("CodeNodeHandle");

/** Zero-based, half-open line range. Reads clamp both bounds to the current line count. */
export interface CodeLineRange {
  readonly from: number;
  readonly to: number;
}

/** Whether a diff document's declared hunk row counts are satisfied. */
export type CodeDiffStatus = "complete" | "incomplete" | "malformed";

/** Bounded code-owner metadata; line records remain available through explicit range reads. */
export interface CodeBlockMetadata extends CodeBlockSourceMetadata {
  readonly configurationRevision: number;
  readonly info: string;
  readonly language?: string;
  readonly diffStatus?: CodeDiffStatus;
}

/** Zero-based, half-open body-row range. Reads clamp both bounds to the current row count. */
export interface TableRowRange {
  readonly from: number;
  readonly to: number;
}

/** Bounded table-owner metadata; body records remain available through explicit range reads. */
export interface TableBlockMetadata extends TableBlockSourceMetadata {
  readonly header: TableHeaderRecord;
}

/** Opaque, owner-local read and observation access to prepared table state. */
export interface TableNodeHandle {
  readonly [tableNodeHandleBrand]: true;
  /** Stable metadata, replaced when the owner source frontier or lifecycle changes. */
  readonly readMetadata: () => TableBlockMetadata;
  /** Reads a bounded half-open body-row range; unchanged retained snapshots preserve identity. */
  readonly readRows: (range: TableRowRange) => readonly TableRowRecord[];
  readonly subscribeMetadata: (listener: () => void) => () => void;
  /** Notifies when changed records intersect the range; unsubscribe releases only this listener. */
  readonly subscribeRows: (range: TableRowRange, listener: () => void) => () => void;
}

/** Create the branded read-only handle implemented by a table owner adapter. */
export function createTableNodeHandle(
  operations: Omit<TableNodeHandle, typeof tableNodeHandleBrand>,
): TableNodeHandle {
  const handle: TableNodeHandle = { ...operations, [tableNodeHandleBrand]: true };
  return Object.freeze(handle);
}

/** Opaque, owner-local read and observation access to prepared code state. */
export interface CodeNodeHandle {
  readonly [codeNodeHandleBrand]: true;
  readonly readSource: () => string;
  /** Stable bounded metadata, replaced when the owner source frontier or lifecycle changes. */
  readonly readMetadata: () => CodeBlockMetadata;
  /** Reads a bounded half-open range; retained snapshots preserve identity until invalidated or evicted. */
  readonly readLines: (range: CodeLineRange) => readonly CodeLineRecord[];
  /** Unsubscribe releases only this metadata listener, not the owner. */
  readonly subscribeMetadata: (listener: () => void) => () => void;
  /** Notifies when changed records intersect the range; unsubscribe releases only this listener. */
  readonly subscribeLines: (range: CodeLineRange, listener: () => void) => () => void;
}

/** Create the branded read-only handle implemented by a code owner adapter. */
export function createCodeNodeHandle(
  operations: Omit<CodeNodeHandle, typeof codeNodeHandleBrand>,
): CodeNodeHandle {
  const handle: CodeNodeHandle = { ...operations, [codeNodeHandleBrand]: true };
  return Object.freeze(handle);
}
