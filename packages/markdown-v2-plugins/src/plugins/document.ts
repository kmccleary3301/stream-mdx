// Document-phase plugin system for post-parse aggregation (e.g., footnotes)
import type { Block, InlineNode, ParagraphSpanChildSnapshot, ProtectedRange, SourceSnapshot } from "@stream-mdx/core";

/** Changed native paragraph spans; ranges are authored absolute UTF-16 offsets. */
export interface FootnoteParagraphSpanTarget {
  readonly index: number;
  readonly sourceRevision: number;
  readonly sourceRange: { readonly from: number; readonly to: number };
  readonly nodes: readonly InlineNode[];
  readonly children?: readonly ParagraphSpanChildSnapshot[];
  readonly attemptedReferences: readonly string[];
}

export interface FootnoteParagraphTargetDelta {
  readonly ownerId: string;
  readonly generation: number;
  readonly spans: readonly FootnoteParagraphSpanTarget[];
}

export interface FootnoteParagraphTargetUpdate {
  readonly ownerId: string;
  readonly generation: number;
  readonly updates: readonly {
    readonly index: number;
    readonly expectedSourceRevision: number;
    readonly nodes: readonly InlineNode[];
    readonly children?: readonly ParagraphSpanChildSnapshot[];
    readonly attemptedReferences: readonly string[];
  }[];
}

/** Engine-owned semantic updates; never synthetic or partially materialized Blocks. */
export interface FootnoteParagraphTargetBridge {
  readonly deltas: readonly FootnoteParagraphTargetDelta[];
  readonly removedOwnerIds?: readonly string[];
  /** Unchanged generic blocks whose public inline artifacts were rebuilt during tail parsing. */
  readonly inlineRefreshes?: readonly {
    readonly previous: Block;
    readonly current: Block;
  }[];
  readonly rebuild?: boolean;
  applyUpdates(updates: readonly FootnoteParagraphTargetUpdate[]): void;
}

type InlineParserAdapter = {
  parse: (input: string) => InlineNode[];
};

export interface DocumentState {
  inlineParser?: InlineParserAdapter;
  [key: string]: unknown;
}

export interface DocumentContext {
  /** Full authored source, readable by source-global UTF-16 range. */
  source: SourceSnapshot;
  /** Current prepared native blocks only; independently owned root code is excluded. */
  blocks: Block[];
  /** Explicit cold read of every authored block, including materialized owned code. */
  readBlocks(): readonly Block[];
  /** True while the whole document has an open code owner or unfinished native tail. */
  hasProvisionalTail: boolean;
  /** Persistent state across streaming updates */
  state: DocumentState;
  /** Aggregated protected ranges (math, html, and other native protected regions). */
  protectedRanges?: ReadonlyArray<ProtectedRange>;
  /** Private native-paragraph dependency bridge. */
  footnoteParagraphTargets?: FootnoteParagraphTargetBridge;
}

export interface DocumentContribution {
  /** New blocks to append to the end of the document */
  syntheticBlocks?: Block[];
}

export interface DocumentPlugin {
  name: string;
  /** Called at the beginning of each aggregation pass */
  onBegin?(ctx: DocumentContext): void;
  /** Called to process the document; may mutate ctx.blocks (e.g., retag definitions) */
  process(ctx: DocumentContext): undefined | DocumentContribution;
  /** Called at the end; return contributions if not returned in process */
  onEnd?(ctx: DocumentContext): undefined | DocumentContribution;
}

export class DocumentPluginRegistry {
  private plugins: DocumentPlugin[] = [];

  register(plugin: DocumentPlugin): void {
    const existingIndex = this.plugins.findIndex((current) => current.name === plugin.name);
    if (existingIndex >= 0) {
      this.plugins.splice(existingIndex, 1, plugin);
      return;
    }
    this.plugins.push(plugin);
  }

  unregister(name: string): boolean {
    const i = this.plugins.findIndex((p) => p.name === name);
    if (i >= 0) {
      this.plugins.splice(i, 1);
      return true;
    }
    return false;
  }

  getAll(): DocumentPlugin[] {
    return [...this.plugins];
  }

  some(predicate: (plugin: DocumentPlugin) => boolean): boolean {
    return this.plugins.some(predicate);
  }

  clear(): void {
    this.plugins = [];
  }

  /**
   * Run all document plugins in order. Returns contributions (synthetic blocks) from all plugins.
   */
  run(ctx: DocumentContext): DocumentContribution {
    const syntheticBlocks: Block[] = [];
    for (const plugin of this.plugins) {
      try {
        plugin.onBegin?.(ctx);
        const contrib = plugin.process(ctx);
        const endContrib = plugin.onEnd?.(ctx);
        if (contrib?.syntheticBlocks) syntheticBlocks.push(...contrib.syntheticBlocks);
        if (endContrib?.syntheticBlocks) syntheticBlocks.push(...endContrib.syntheticBlocks);
      } catch (e) {
        // Best-effort: a failing plugin shouldn't crash rendering
        console.warn(`[DocumentPlugin] ${plugin.name} failed:`, e);
      }
    }
    return { syntheticBlocks };
  }
}
