export * from "./types";
export * from "./block-snapshot";
export * from "./nested-block-snapshot";
export * from "./block-compatibility";
export * from "./code-highlighting";
export { createCodeLineIndex } from "./code-records";
export * from "./table-records";
export { createTableRowIndex } from "./table-row-index";
export type { TableRowIndex, TableRowIndexUpdate } from "./table-row-index";
export {
  createManagedTableState,
  appendManagedTableRows,
  updateManagedTableRows,
  materializeManagedTableSnapshot,
} from "./table-block-state";
export type { ManagedTableViewState, ManagedTablePatchResult } from "./table-block-state";
export type { CodeLineDecoration, CodeLineDecorationUpdate, CodeLineIndex, CodeLineRecord, CodeTokenLine, CodeTokenSpan } from "./code-records";
export { AppendSourceDocument, createSourceWindow } from "./source-document";
export type { SourceSnapshot, StagedSourceAppend } from "./source-document";
export * from "./utils";
export * from "./mixed-content";
export * from "./security";
export * from "./inline-parser";
export * from "./inline/types";
export { collectLinkReferences, diffLinkReferences } from "./inline/reference-collector";
export { compileSyntaxRuleToExtension } from "./inline/plugin-adapter";
export * from "./worker-html-sanitizer";
export * from "./perf/backpressure";
export * from "./perf/patch-coalescing";
export * from "./streaming/custom-matcher";
export * from "./streaming/inline-streaming";
