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
export type { CodeBlockMetadata, CodeDiffTokenLine, CodeLineDecoration, CodeLineDecorationUpdate, CodeLineIndex, CodeLineRange, CodeLineRecord, CodeNodeHandle, CodeTokenLine, CodeTokenSpan, HighlightUnavailableReason } from "./code-records";
export { createCodeNodeHandle } from "./code-records";
export { freezeParagraphSpanRecord } from "./paragraph-records";
export { createParagraphSpanIndex } from "./paragraph-span-index";
export {
  createManagedParagraphState,
  appendManagedParagraphSpans,
  updateManagedParagraphSpans,
  materializeManagedParagraphSnapshot,
} from "./paragraph-block-state";
export type { ManagedParagraphViewState, ManagedParagraphPatchResult } from "./paragraph-block-state";
export type {
  ParagraphBlockSnapshot,
  ParagraphBlockSourceMetadata,
  ParagraphBlockState,
  ParagraphSpanIndex,
  ParagraphSpanChildSnapshot,
  ParagraphSpanRecord,
  ParagraphSpanUpdate,
} from "./paragraph-records";
export type { ParagraphRecordCounterStage, ParagraphRecordWorkCounters, ParagraphSpanIndexOptions } from "./paragraph-span-index";
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
export * from "./native-table-lowering";
export * from "./admission";
export type {
  TrustedMdxArtifact,
  TrustedMdxSourceRegion,
} from "./trusted-mdx-artifact";
export * from "./trusted-mdx-artifact";
