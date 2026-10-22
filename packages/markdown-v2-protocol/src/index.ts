import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
export { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import type {
  NodeSnapshot,
  DiffBlock,
  DiffKind,
  DiffLine,
  DiffLineKind,
  Patch,
  PatchMetrics,
  ThemedLine,
  ThemedToken,
  TokenLineV1,
  TokenSpan,
  TokenStyle,
} from "@stream-mdx/core";

export const STREAM_MDX_PROTOCOL_ID = "streammdx";
// Wire identity is shared with physical/direct worker startup.

export type StreamMdxEventType = "init" | "snapshot" | "patch" | "metrics" | "error" | "done";

export type StreamMdxCapabilityLevel = "none" | "v1";

export type StreamMdxCapabilities = {
  tokens?: StreamMdxCapabilityLevel;
  diff?: StreamMdxCapabilityLevel;
  mdx?: "none" | "detect" | "compile-ref" | "compile-inline";
  htmlBlocks?: "none" | "sanitized" | "raw";
  math?: "none" | "tex";
  tables?: StreamMdxCapabilityLevel;
  footnotes?: StreamMdxCapabilityLevel;
};

export type StreamMdxTheme = {
  mode: "single" | "dual";
  theme?: string;
  dark?: string;
  light?: string;
};

export type StreamMdxEventBase = {
  protocol: typeof STREAM_MDX_PROTOCOL_ID;
  schemaVersion: typeof STREAM_MDX_SCHEMA_VERSION;
  streamId: string;
  event: StreamMdxEventType;
  tx?: number;
};

export type StreamMdxInitEvent = StreamMdxEventBase & {
  event: "init";
  createdAt?: number;
  capabilities?: StreamMdxCapabilities;
  theme?: StreamMdxTheme;
  shikiVersion?: string;
};

export type StreamMdxSnapshotEvent = StreamMdxEventBase & {
  event: "snapshot";
  snapshot: NodeSnapshot;
};

export type StreamMdxPatchEvent = StreamMdxEventBase & {
  event: "patch";
  tx: number;
  patches: Patch[];
  metrics?: PatchMetrics | null;
};

export type StreamMdxMetricsEvent = StreamMdxEventBase & {
  event: "metrics";
  tx?: number;
  metrics: PatchMetrics;
};

export type StreamMdxErrorEvent = StreamMdxEventBase & {
  event: "error";
  message: string;
  stack?: string;
};

export type StreamMdxDoneEvent = StreamMdxEventBase & {
  event: "done";
  finalTx?: number;
  status: "ok" | "error";
};

export type StreamMdxEvent =
  | StreamMdxInitEvent
  | StreamMdxSnapshotEvent
  | StreamMdxPatchEvent
  | StreamMdxMetricsEvent
  | StreamMdxErrorEvent
  | StreamMdxDoneEvent;

export type { DiffBlock, DiffKind, DiffLine, DiffLineKind, ThemedLine, ThemedToken, TokenLineV1, TokenSpan, TokenStyle };
