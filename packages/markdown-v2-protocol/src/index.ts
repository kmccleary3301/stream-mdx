import type {
  Block,
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
export const STREAM_MDX_SCHEMA_VERSION = "1.0";

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

export type StreamMdxInitEventV1 = StreamMdxEventBase & {
  event: "init";
  createdAt?: number;
  capabilities?: StreamMdxCapabilities;
  theme?: StreamMdxTheme;
  shikiVersion?: string;
};

export type StreamMdxSnapshotEventV1 = StreamMdxEventBase & {
  event: "snapshot";
  blocks: Block[];
};

export type StreamMdxPatchEventV1 = StreamMdxEventBase & {
  event: "patch";
  tx: number;
  patches: Patch[];
  metrics?: PatchMetrics | null;
};

export type StreamMdxMetricsEventV1 = StreamMdxEventBase & {
  event: "metrics";
  tx?: number;
  metrics: PatchMetrics;
};

export type StreamMdxErrorEventV1 = StreamMdxEventBase & {
  event: "error";
  message: string;
  stack?: string;
};

export type StreamMdxDoneEventV1 = StreamMdxEventBase & {
  event: "done";
  finalTx?: number;
  status: "ok" | "error";
};

export type StreamMdxEventV1 =
  | StreamMdxInitEventV1
  | StreamMdxSnapshotEventV1
  | StreamMdxPatchEventV1
  | StreamMdxMetricsEventV1
  | StreamMdxErrorEventV1
  | StreamMdxDoneEventV1;

export type { DiffBlock, DiffKind, DiffLine, DiffLineKind, ThemedLine, ThemedToken, TokenLineV1, TokenSpan, TokenStyle };
