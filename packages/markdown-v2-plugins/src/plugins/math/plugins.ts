// Math plugin implementations

import type { MarkdownPlugin } from "../base";
import { MathDisplayRenderer, MathInlineRenderer } from "./renderer";
// Use Lezer-native streaming handlers (Phase 2)
import { LezerDisplayMathStreamingHandler, LezerInlineMathStreamingHandler } from "./streaming-v2";
import { MathTokenizer } from "./tokenizer";

/**
 * Inline math plugin ($...$)
 */
export const MathInlinePlugin: MarkdownPlugin = {
  name: "math-inline",
  priority: 100,

  patterns: {
    start: /\$/,
    end: /\$/,
    full: /\$([^$\n\r]+?)\$/,
    multiline: false,
    minLength: 3,
  },

  tokenizer: MathTokenizer,

  renderer: MathInlineRenderer as unknown as MarkdownPlugin["renderer"],

  streamingHandler: new LezerInlineMathStreamingHandler(),

  config: {
    enabled: true,
    renderOptions: {
      displayMode: false,
      throwOnError: false,
    },
    streamingOptions: {
      maxWaitTime: 5000, // 5 seconds
      bufferSize: 1000,
      abandonIncomplete: true,
    },
  },
};

/**
 * Display math plugin ($$...$$)
 */
export const MathDisplayPlugin: MarkdownPlugin = {
  name: "math-display",
  priority: 200, // Higher priority than inline math

  patterns: {
    start: /\$\$/,
    end: /\$\$/,
    full: /\$\$([\s\S]*?(?:\$(?!\$)[^$]*?)*?)\$\$/,
    multiline: true,
    minLength: 5,
  },

  tokenizer: MathTokenizer,

  renderer: MathDisplayRenderer as unknown as MarkdownPlugin["renderer"],

  streamingHandler: new LezerDisplayMathStreamingHandler(),

  config: {
    enabled: true,
    renderOptions: {
      displayMode: true,
      throwOnError: false,
    },
    streamingOptions: {
      maxWaitTime: 10000, // 10 seconds for complex expressions
      bufferSize: 5000,
      abandonIncomplete: false, // Don't abandon display math easily
    },
  },
};

/**
 * Helper function to register both math plugins
 */
export function registerMathPlugins(registry: import("../registry").PluginRegistry) {
  const inlineResult = registry.register(MathInlinePlugin);
  const displayResult = registry.register(MathDisplayPlugin);

  return {
    inline: inlineResult,
    display: displayResult,
    success: inlineResult.success && displayResult.success,
  };
}
