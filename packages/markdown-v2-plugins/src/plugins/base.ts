// Base plugin interfaces and types for Lezer-native plugin system

import type { ContextTracker, ExternalTokenizer } from "@lezer/lr";
import { CustomStreamingMatcher } from "@stream-mdx/core/streaming/custom-matcher";

/**
 * Core plugin interface that all markdown plugins must implement
 */
export interface MarkdownPlugin {
  /** Unique plugin identifier */
  name: string;

  /** Plugin priority for conflict resolution (higher = higher priority) */
  priority: number;

  /** Pattern definitions for this plugin */
  patterns: PluginPatterns;

  /** Lezer external tokenizer implementation */
  tokenizer: ExternalTokenizer;

  /** Optional context tracker for stateful parsing */
  contextTracker?: ContextTracker<unknown>;

  /**
   * Optional renderer for environments that render plugin output (e.g. React).
   * Worker-only consumers should not need this.
   */
  renderer?: unknown;

  /** Streaming handler for incremental matching */
  streamingHandler: IncrementalMatchHandler;

  /** Optional configuration */
  config?: PluginConfig;
}

/**
 * Pattern definitions for plugin matching
 */
export interface PluginPatterns {
  /** Start pattern (e.g., $ for math) */
  start: RegExp;

  /** End pattern (e.g., $ for math) */
  end: RegExp;

  /** Full pattern for complete matching */
  full: RegExp;

  /** Whether this plugin supports multiline content */
  multiline?: boolean;

  /** Minimum viable string length for this pattern */
  minLength?: number;
}

/**
 * Plugin configuration options
 */
export interface PluginConfig {
  /** Enable/disable this plugin */
  enabled?: boolean;

  /** Custom rendering options */
  renderOptions?: Record<string, unknown>;

  /** Streaming behavior options */
  streamingOptions?: StreamingOptions;
}

/**
 * Streaming behavior configuration
 */
export interface StreamingOptions {
  /** Maximum time to wait for pattern completion (ms) */
  maxWaitTime?: number;

  /** Buffer size for partial matches */
  bufferSize?: number;

  /** Whether to abandon incomplete matches */
  abandonIncomplete?: boolean;
}

/**
 * Handler for incremental pattern matching during streaming
 */
export interface IncrementalMatchHandler {
  /** Check if current content might be a partial match */
  checkPartialMatch(content: string): PartialMatchResult;

  /** Complete a match when pattern is finished */
  completeMatch(content: string): CompleteMatchResult;

  /** Abandon a partial match */
  abandonMatch(content: string): void;

  /** Reset the handler state */
  reset(): void;
}

/**
 * Result of partial match detection
 */
export interface PartialMatchResult {
  /** Whether there's a potential partial match */
  hasPartialMatch: boolean;

  /** Type of match being attempted */
  type: string | null;

  /** Confidence level (0-1) */
  confidence: number;

  /** Expected completion patterns */
  expectedNext?: string[];

  /** Whether the match is likely to complete */
  likelyToComplete?: boolean;
}

/**
 * Result of completed match
 */
export interface CompleteMatchResult {
  /** Whether the match was successful */
  success: boolean;

  /** Matched content */
  content: string;

  /** Match metadata */
  metadata: MatchMetadata;

  /** Processing time in ms */
  processingTime?: number;
}

/**
 * Metadata about a completed match
 */
export interface MatchMetadata {
  /** Start position in original content */
  start: number;

  /** End position in original content */
  end: number;

  /** Plugin that made this match */
  plugin: string;

  /** Match type (e.g., 'inline-math', 'display-math') */
  type: string;

  /** Extracted data (e.g., math expression, component props) */
  data: Record<string, unknown>;

  /** Whether this was a multiline match */
  multiline?: boolean;
}

/**
 * Context for plugin operations
 */
export interface PluginContext {
  /** Current parsing position */
  position: number;

  /** Available content buffer */
  content: string;

  /** Current parse state */
  parseState: unknown;

  /** Other active plugins */
  activePlugins: Set<string>;

  /** Streaming status */
  isStreaming: boolean;

  /** Performance metrics */
  metrics?: PerformanceMetrics;
}

/**
 * Performance tracking for plugins
 */
export interface PerformanceMetrics {
  /** Time spent in tokenization */
  tokenizeTime: number;

  /** Time spent in rendering */
  renderTime: number;

  /** Number of matches processed */
  matchCount: number;

  /** Number of false positives */
  falsePositives: number;
}

/**
 * Base class for implementing streaming handlers
 */
export abstract class BaseIncrementalMatchHandler implements IncrementalMatchHandler {
  protected incrementalMatcher: CustomStreamingMatcher;
  protected pattern: RegExp;
  protected currentContent = "";
  protected startTime = 0;

  constructor(pattern: RegExp) {
    this.pattern = pattern;
    this.incrementalMatcher = new CustomStreamingMatcher(pattern);
  }

  abstract checkPartialMatch(content: string): PartialMatchResult;
  abstract completeMatch(content: string): CompleteMatchResult;

  abandonMatch(content: string): void {
    this.reset();
  }

  reset(): void {
    this.incrementalMatcher.reset();
    this.currentContent = "";
    this.startTime = 0;
  }

  protected calculateConfidence(content: string): number {
    // Simple confidence based on content length and pattern characteristics
    const minLength = this.getMinimumLength();
    if (content.length < minLength) return 0;

    // Higher confidence for longer, more structured content
    return Math.min(1, content.length / (minLength * 2));
  }

  protected abstract getMinimumLength(): number;
}

/**
 * Plugin registration result
 */
export interface PluginRegistrationResult {
  success: boolean;
  message: string;
  conflicts?: string[];
}

/**
 * Plugin conflict resolution strategies
 */
export enum ConflictResolution {
  /** Use plugin with higher priority */
  PRIORITY = "priority",

  /** Use longest match */
  LONGEST_MATCH = "longest",

  /** Use first registered plugin */
  FIRST_REGISTERED = "first",

  /** Try both and use most confident */
  CONFIDENCE = "confidence",
}

/**
 * Error types for plugin operations
 */
export enum PluginError {
  TOKENIZATION_FAILED = "tokenization_failed",
  RENDERING_FAILED = "rendering_failed",
  PATTERN_INVALID = "pattern_invalid",
  STREAMING_TIMEOUT = "streaming_timeout",
  PARTIAL_MATCH_ABANDONED = "partial_match_abandoned",
  CONTEXT_CORRUPTION = "context_corruption",
}

/**
 * Plugin error with context information
 */
export class PluginException extends Error {
  constructor(
    public errorType: PluginError,
    message: string,
    public pluginName: string,
    public context?: PluginContext,
  ) {
    super(`[${pluginName}] ${errorType}: ${message}`);
    this.name = "PluginException";
  }
}
