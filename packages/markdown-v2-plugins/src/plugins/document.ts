// Document-phase plugin system for post-parse aggregation (e.g., footnotes)
import type { Block, InlineNode, ProtectedRange } from "@stream-mdx/core";

type InlineParserAdapter = {
  parse: (input: string) => InlineNode[];
};

export interface DocumentState {
  inlineParser?: InlineParserAdapter;
  [key: string]: unknown;
}

export interface DocumentContext {
  /** Full markdown content */
  content: string;
  /** Current blocks (mutable copy provided to plugin runner) */
  blocks: Block[];
  /** Persistent state across streaming updates */
  state: DocumentState;
  /** Aggregated protected ranges (math, code, html) for the current document */
  protectedRanges?: ReadonlyArray<ProtectedRange>;
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

export const globalDocumentPluginRegistry = new DocumentPluginRegistry();
