/**
 * Diagnostic bundle entry for replay oracle and performance observation.
 * Exports actual source implementations bundled with __STREAM_MDX_COUNTERS__ = true.
 */

export { MarkdownEngine } from "../../packages/markdown-v2-worker/src/engine/engine";
export { createRendererStore } from "../../packages/markdown-v2-react/src/renderer/store";
export { StreamingMarkdown } from "../../packages/markdown-v2-react/src/streaming-markdown";
export { CodeBlockView } from "../../packages/markdown-v2-react/src/renderer/code-block-view";
export { ComponentRegistry } from "../../packages/markdown-v2-react/src/components";
export { MarkdownBlocksRenderer } from "../../packages/markdown-v2-react/src/renderer/blocks-renderer";
export { SessionCounterSink, COUNTER_STAGES } from "./counter-sink";
export type {
  SessionCountersSnapshot,
  StageCounters,
  PublicationRecord,
  InvalidationRecord,
  InvalidationCause,
  CounterStage,
} from "./counter-sink";
