// Debug wrapper for V2 markdown renderer

import type { Block, InlineNode, WorkerOut } from "@stream-mdx/core";
import { MarkdownWorkerClient } from "@stream-mdx/worker";
import type { DebugHooks, DebugSnapshot, StreamingSegment } from "../markdown-comparison-tests/types";
import { createRendererStore } from "./renderer/store";

interface ExtractedMathExpression {
  tex: string;
  position: number;
}

export class DebugV2Wrapper {
  private static readonly DEFAULT_POSITION = -1;
  private workerClient: MarkdownWorkerClient;
  private debugHooks?: DebugHooks;
  private currentSegment?: StreamingSegment;
  private snapshots: Map<number, DebugSnapshot> = new Map();
  private parseStartTime = 0;
  private renderStartTime = 0;
  private capturedBlocks: Block[] = [];
  private store = createRendererStore();

  constructor() {
    this.workerClient = new MarkdownWorkerClient();
    this.setupWorkerInterception();
  }

  private setupWorkerInterception() {
    // Attach an additional listener to capture data
    this.workerClient.onMessage((message: WorkerOut) => {
      // Capture blocks and call debug hooks
      if (message.type === "INITIALIZED") {
        this.store.reset(message.blocks);
        this.capturedBlocks = [...this.store.getBlocks()];
      } else if (message.type === "PATCH") {
        if (message.patches.length > 0) {
          this.store.applyPatches(message.patches, { captureMetrics: false });
        }
        this.capturedBlocks = [...this.store.getBlocks()];
      } else if (message.type === "RESET") {
        this.store.reset([]);
        this.capturedBlocks = [];
      } else {
        return;
      }

      if (this.debugHooks?.onBlocksGenerated && this.currentSegment) {
        this.debugHooks.onBlocksGenerated(this.capturedBlocks, this.currentSegment);
      }

      // Update snapshot
      if (this.currentSegment) {
        this.updateSnapshot();
      }
    });
  }

  async processSegment(content: string, segment: StreamingSegment, debugHooks?: DebugHooks): Promise<DebugSnapshot> {
    this.debugHooks = debugHooks;
    this.currentSegment = segment;
    this.parseStartTime = performance.now();
    this.renderStartTime = performance.now();

    try {
      // Initialize snapshot
      const snapshot: DebugSnapshot = {
        segment,
        timestamp: Date.now(),
        rawBlocks: [],
        processedBlocks: [],
        renderedHtml: "",
        parseTime: 0,
        renderTime: 0,
        mathExpressions: { inline: [], display: [] },
        componentCounts: {},
        errors: [],
        warnings: [],
      };

      this.snapshots.set(segment.index, snapshot);

      if (debugHooks?.onRenderStart) {
        debugHooks.onRenderStart(segment);
      }

      // Process content through worker
      if (segment.index === 0) {
        this.workerClient.init(content, [], { footnotes: true, html: true, mdx: true, tables: true, callouts: true });
      } else {
        await this.workerClient.append(segment.content);
      }

      // Wait for processing to complete
      await this.waitForProcessing();

      // Finalize snapshot
      return this.finalizeSnapshot(segment.index);
    } catch (error) {
      console.error("V2 Debug processing error:", error);

      if (debugHooks?.onError) {
        debugHooks.onError(error as Error, segment);
      }

      // Return error snapshot
      const errorSnapshot = this.snapshots.get(segment.index) || {
        segment,
        timestamp: Date.now(),
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
        parseTime: performance.now() - this.parseStartTime,
        renderTime: 0,
        mathExpressions: { inline: [], display: [] },
        componentCounts: {},
      };

      return errorSnapshot;
    }
  }

  private async waitForProcessing(): Promise<void> {
    // Wait for worker to finish processing
    return new Promise((resolve) => {
      setTimeout(resolve, 100); // Give worker time to process
    });
  }

  private updateSnapshot() {
    if (!this.currentSegment) return;

    const snapshot = this.snapshots.get(this.currentSegment.index);
    if (!snapshot) return;

    // Extract math expressions from blocks
    const mathExpressions = this.extractMathFromBlocks(this.capturedBlocks);

    // Update snapshot
    const updatedSnapshot: DebugSnapshot = {
      ...snapshot,
      rawBlocks: this.capturedBlocks,
      processedBlocks: this.capturedBlocks,
      parseTime: performance.now() - this.parseStartTime,
      mathExpressions,
    };

    this.snapshots.set(this.currentSegment.index, updatedSnapshot);

    if (this.debugHooks?.onMathParsed && this.currentSegment) {
      const allMath = [...mathExpressions.inline, ...mathExpressions.display];
      this.debugHooks.onMathParsed(allMath, this.currentSegment);
    }
  }

  private finalizeSnapshot(segmentIndex: number): DebugSnapshot {
    const snapshot = this.snapshots.get(segmentIndex);
    if (!snapshot) {
      throw new Error(`No snapshot found for segment ${segmentIndex}`);
    }

    // Generate HTML representation of blocks
    const renderedHtml = this.blocksToHtml(this.capturedBlocks);
    const componentCounts = this.countComponents(this.capturedBlocks);

    const finalSnapshot: DebugSnapshot = {
      ...snapshot,
      renderTime: performance.now() - this.renderStartTime,
      renderedHtml,
      componentCounts,
    };

    if (this.debugHooks?.onRenderComplete && this.currentSegment) {
      this.debugHooks.onRenderComplete(renderedHtml, this.currentSegment);
    }

    return finalSnapshot;
  }

  private extractMathFromBlocks(blocks: Block[]): { inline: ExtractedMathExpression[]; display: ExtractedMathExpression[] } {
    const inline: ExtractedMathExpression[] = [];
    const display: ExtractedMathExpression[] = [];

    for (const block of blocks) {
      if (block.payload.inline) {
        this.extractMathFromInlineNodes(block.payload.inline, inline, display);
      }

      // Also check raw content for math patterns
      const rawMath = this.extractMathFromString(block.payload.raw || "");
      inline.push(...rawMath.inline);
      display.push(...rawMath.display);
    }

    return { inline, display };
  }

  private extractMathFromInlineNodes(nodes: InlineNode[], inline: ExtractedMathExpression[], display: ExtractedMathExpression[]) {
    for (const node of nodes) {
      if (node.kind === "math-inline" && "tex" in node) {
        inline.push({
          tex: node.tex,
          position: DebugV2Wrapper.DEFAULT_POSITION, // Position would need to be calculated
        });
      } else if (node.kind === "math-display" && "tex" in node) {
        display.push({
          tex: node.tex,
          position: DebugV2Wrapper.DEFAULT_POSITION, // Position would need to be calculated
        });
      } else if ("children" in node && node.children) {
        this.extractMathFromInlineNodes(node.children, inline, display);
      }
    }
  }

  private extractMathFromString(content: string): { inline: ExtractedMathExpression[]; display: ExtractedMathExpression[] } {
    const inline: ExtractedMathExpression[] = [];
    const display: ExtractedMathExpression[] = [];

    // Extract inline math $...$
    const inlineRegex = /\$([^$]+?)\$/g;
    let inlineMatch: RegExpExecArray | null = inlineRegex.exec(content);
    while (inlineMatch) {
      inline.push({
        tex: inlineMatch[1],
        position: inlineMatch.index,
      });
      inlineMatch = inlineRegex.exec(content);
    }

    // Extract display math $$...$$
    const displayRegex = /\$\$([^$]+?)\$\$/g;
    let displayMatch: RegExpExecArray | null = displayRegex.exec(content);
    while (displayMatch) {
      display.push({
        tex: displayMatch[1],
        position: displayMatch.index,
      });
      displayMatch = displayRegex.exec(content);
    }

    return { inline, display };
  }

  private blocksToHtml(blocks: Block[]): string {
    // Simple HTML generation for comparison
    return blocks
      .map((block) => {
        switch (block.type) {
          case "paragraph":
            return `<p>${block.payload.raw}</p>`;
          case "heading":
            return `<h2>${block.payload.raw}</h2>`;
          case "code":
            return `<pre><code>${block.payload.raw}</code></pre>`;
          default:
            return `<div class="${block.type}">${block.payload.raw}</div>`;
        }
      })
      .join("\n");
  }

  private countComponents(blocks: Block[]): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const block of blocks) {
      const type = block.type;
      counts[type] = (counts[type] || 0) + 1;

      // Count inline components
      if (block.payload.inline) {
        this.countInlineComponents(block.payload.inline, counts);
      }
    }

    return counts;
  }

  private countInlineComponents(nodes: InlineNode[], counts: Record<string, number>) {
    for (const node of nodes) {
      const kind = node.kind;
      counts[`inline-${kind}`] = (counts[`inline-${kind}`] || 0) + 1;

      if ("children" in node && node.children) {
        this.countInlineComponents(node.children, counts);
      }
    }
  }

  getBlocks(): Block[] {
    return [...this.capturedBlocks];
  }

  cleanup() {
    this.snapshots.clear();
    this.capturedBlocks = [];
    this.debugHooks = undefined;
    this.currentSegment = undefined;
  }
}
