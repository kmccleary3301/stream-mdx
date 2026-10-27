import type { StreamingFeatureFlags, StreamingMarkdownProps } from "../src/streaming-markdown";

export const htmlOutput: StreamingFeatureFlags = { outputMode: "html" };
export const tokenOutput: StreamingFeatureFlags = { outputMode: "tokens" };
export const combinedOutput: StreamingFeatureFlags = { outputMode: "both" };
export const optionalOutputMode: StreamingFeatureFlags = {};
export const consumerFeatures: NonNullable<StreamingMarkdownProps["features"]> = { outputMode: "tokens" };

// @ts-expect-error Unsupported output modes must be rejected by the public feature type.
export const invalidOutput: StreamingFeatureFlags = { outputMode: "plain" };
