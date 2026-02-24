import type { Block, PatchMetrics, WorkerIn, WorkerOut } from "@stream-mdx/core";
// Main V2 Markdown Renderer
// Client-side renderer with component registry and worker integration
import type { PatchFlushResult } from "./renderer/patch-commit-scheduler";
import type { BlockComponents, InlineComponents, Renderer, RendererConfig } from "./types";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getBlockKey, PATCH_ROOT_ID } from "@stream-mdx/core";
import { createDefaultWorker, releaseDefaultWorker } from "@stream-mdx/worker";
import { ComponentRegistry } from "./components";
import { getMDXComponentFactory, registerMDXComponents } from "./mdx-client";
import { useRendererChildren } from "./renderer/hooks";
import { BlockNodeRenderer } from "./renderer/node-views";
import { isHeavyPatch, splitPatchBatch } from "./renderer/patch-batching";
import { PatchCommitScheduler } from "./renderer/patch-commit-scheduler";
import { createRendererStore } from "./renderer/store";

const WORKER_DEBUG_ENABLED =
  (() => {
    try {
      if (typeof process !== "undefined" && process.env) {
        const value = process.env.NEXT_PUBLIC_STREAMING_DEBUG_WORKER;
        if (value === "1" || value === "true") {
          return true;
        }
      }
      if (typeof globalThis !== "undefined") {
        const debug = (globalThis as { __STREAMING_DEBUG__?: { worker?: boolean } })?.__STREAMING_DEBUG__;
        if (debug?.worker) {
          return true;
        }
      }
    } catch {
      // ignore detection errors
    }
    return false;
  })() || false;

function isLikelyMdxComponentName(name: string): boolean {
  if (!name) return false;
  const first = name.charAt(0);
  return first.toUpperCase() === first && first.toLowerCase() !== first;
}

function getMdxComponentNames(config: RendererConfig): string[] | undefined {
  const components = config.mdx?.components;
  if (!components) return undefined;
  const names = Object.keys(components).filter(isLikelyMdxComponentName);
  return names.length > 0 ? names : undefined;
}

/**
 * Main renderer class
 */
export class MarkdownRenderer implements Renderer {
  private worker: Worker | null = null;
  private blocks: Block[] = [];
  private updateCallbacks: Array<(blocks: ReadonlyArray<Block>) => void> = [];
  private componentRegistry: ComponentRegistry;
  private config: RendererConfig;
  private store = createRendererStore();
  private patchScheduler: PatchCommitScheduler;
  private lastPatchMetrics: PatchMetrics | null = null;
  private lastWorkerError: Extract<WorkerOut, { type: "ERROR" }> | null = null;
  private flushListeners = new Set<(result: PatchFlushResult) => void>();
  private workerMessageListener: ((event: MessageEvent<WorkerOut>) => void) | null = null;

  constructor(config: RendererConfig = {}) {
    this.config = config;
    this.componentRegistry = new ComponentRegistry();
    if (this.config.mdx?.compileEndpoint) {
      getMDXComponentFactory(this.config.mdx.compileEndpoint);
    }
    if (this.config.mdx?.components) {
      registerMDXComponents(this.config.mdx.components);
    }
    this.patchScheduler = new PatchCommitScheduler({
      store: this.store,
      onFlush: (result) => this.handlePatchFlush(result),
      options: {
        frameBudgetMs: this.config.performance?.frameBudgetMs,
        timeoutMs: this.config.performance?.flushTimeoutMs,
        maxBatchesPerFlush: this.config.performance?.maxBatchesPerFlush,
        maxLowPriorityBatchesPerFlush: this.config.performance?.maxLowPriorityBatchesPerFlush,
        lowPriorityFrameBudgetMs: this.config.performance?.lowPriorityFrameBudgetMs,
        urgentQueueThreshold: this.config.performance?.urgentQueueThreshold,
        batch: this.config.performance?.batch,
        historyLimit: this.config.performance?.historyLimit,
        startupMicrotaskFlushes: this.config.performance?.startupMicrotaskFlushes,
      },
    });
  }

  /**
   * Attach Web Worker
   */
  attachWorker(worker: Worker, options?: { skipInit?: boolean }): void {
    this.patchScheduler.restart();
    this.store.reset([]);
    this.blocks = [];
    if (this.updateCallbacks.length > 0) {
      this.notifyUpdateCallbacks();
    }
    this.worker = worker;
    this.workerMessageListener = this.handleWorkerMessage.bind(this);
    this.worker.addEventListener("message", this.workerMessageListener);

    if (!options?.skipInit) {
      // Initialize worker
      const mdxComponentNames = getMdxComponentNames(this.config);
      const docPlugins = {
        footnotes: this.config.plugins?.footnotes ?? true,
        html: this.config.plugins?.html ?? true,
        mdx: this.config.plugins?.mdx ?? true,
        tables: this.config.plugins?.tables ?? true,
        callouts: this.config.plugins?.callouts ?? false,
        math: this.config.plugins?.math ?? true,
        formatAnticipation: this.config.plugins?.formatAnticipation ?? false,
        liveCodeHighlighting: this.config.plugins?.liveCodeHighlighting ?? false,
        ...(mdxComponentNames ? { mdxComponentNames } : {}),
      };

      this.worker.postMessage({
        type: "INIT",
        initialContent: "",
        prewarmLangs: this.config.highlight?.langs || [],
        docPlugins,
        mdx: {
          compileMode: this.config.mdx?.compileStrategy ?? "server",
        },
      } as WorkerIn);
    }
  }

  detachWorker(options: { terminate?: boolean } = {}): void {
    if (!this.worker) return;
    const shouldTerminate = options.terminate ?? false;
    try {
      if (this.workerMessageListener) {
        this.worker.removeEventListener("message", this.workerMessageListener);
      }
      if (shouldTerminate && typeof this.worker.terminate === "function") {
        this.worker.terminate();
      }
    } catch (error) {
      console.warn("Failed to detach markdown worker", error);
    } finally {
      this.worker = null;
      this.workerMessageListener = null;
    }
  }

  /**
   * Append text chunk for streaming
   */
  append(text: string): void {
    if (!this.worker) {
      throw new Error("Worker not attached");
    }

    this.worker.postMessage({
      type: "APPEND",
      text,
    } as WorkerIn);
  }

  /**
   * Render static content
   */
  async renderStatic(text: string): Promise<Block[]> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("Worker not attached"));
        return;
      }

      // One-time callback for static rendering
      const handleMessage = (event: MessageEvent<WorkerOut>) => {
        const message = event.data;
        if (message.type === "INITIALIZED") {
          this.worker?.removeEventListener("message", handleMessage);
          resolve(message.blocks);
        }
      };

      this.worker.addEventListener("message", handleMessage);

      const mdxComponentNames = getMdxComponentNames(this.config);
      const docPlugins = {
        footnotes: this.config.plugins?.footnotes ?? true,
        html: this.config.plugins?.html ?? true,
        mdx: this.config.plugins?.mdx ?? true,
        tables: this.config.plugins?.tables ?? true,
        callouts: this.config.plugins?.callouts ?? false,
        math: this.config.plugins?.math ?? true,
        formatAnticipation: this.config.plugins?.formatAnticipation ?? false,
        liveCodeHighlighting: this.config.plugins?.liveCodeHighlighting ?? false,
        ...(mdxComponentNames ? { mdxComponentNames } : {}),
      };

      this.worker.postMessage({
        type: "INIT",
        initialContent: text,
        prewarmLangs: this.config.highlight?.langs || [],
        docPlugins,
        mdx: {
          compileMode: this.config.mdx?.compileStrategy ?? "server",
        },
      } as WorkerIn);
    });
  }

  /**
   * Subscribe to block updates
   */
  onUpdate(callback: (blocks: ReadonlyArray<Block>) => void): () => void {
    this.updateCallbacks.push(callback);

    // Return unsubscribe function
    return () => {
      const index = this.updateCallbacks.indexOf(callback);
      if (index > -1) {
        this.updateCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Set block components
   */
  setBlockComponents(map: Partial<BlockComponents>): void {
    this.componentRegistry.setBlockComponents(map);
  }

  /**
   * Set inline components
   */
  setInlineComponents(map: Partial<InlineComponents>): void {
    this.componentRegistry.setInlineComponents(map);
  }

  setMdxComponents(map: Record<string, React.ComponentType<unknown>>): void {
    if (this.config.mdx?.compileEndpoint) {
      getMDXComponentFactory(this.config.mdx.compileEndpoint);
    }
    registerMDXComponents(map);
  }

  /**
   * Get component registry for external access
   */
  getComponentRegistry(): ComponentRegistry {
    return this.componentRegistry;
  }

  getStore() {
    return this.store;
  }

  flushPendingPatches(): PatchFlushResult | null {
    return this.patchScheduler.flushAll();
  }

  waitForPatchQueueIdle(): Promise<void> {
    return this.patchScheduler.awaitIdle();
  }

  /**
   * Handle worker messages
   */
  private handleWorkerMessage(event: MessageEvent<WorkerOut>): void {
    const message = event.data;

    switch (message.type) {
      case "INITIALIZED":
        this.patchScheduler.clear();
        this.store.reset(message.blocks);
        if (this.updateCallbacks.length > 0) {
          this.blocks = this.store.getBlocks() as Block[];
          this.notifyUpdateCallbacks();
        }
        break;

      case "METRICS":
        // Handle performance metrics
        if (WORKER_DEBUG_ENABLED) {
          // eslint-disable-next-line no-console
          console.debug("Worker metrics:", message.metrics);
        }
        break;

      case "PATCH": {
        if (message.metrics) {
          this.lastPatchMetrics = message.metrics;
        }
        if (message.patches.length > 0) {
          const receivedAt = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
          const batches = splitPatchBatch(message.patches);
          batches.forEach((batch, index) => {
            const priority: "high" | "low" = batch.some(isHeavyPatch) ? "low" : "high";
            this.patchScheduler.enqueue({
              patches: batch,
              meta: {
                tx: message.tx,
                metrics: index === 0 ? message.metrics : undefined,
                receivedAt,
                priority,
              },
            });
          });
        }
        break;
      }

      case "RESET":
        this.patchScheduler.clear();
        break;

      case "ERROR":
        this.lastWorkerError = message;
        console.error("V2 Markdown worker reported an error", {
          phase: message.phase,
          blockId: message.blockId,
          error: message.error,
          meta: message.meta,
        });
        break;

      default:
        console.warn("Unknown worker message type:", message);
    }
  }

  getLastPatchMetrics(): PatchMetrics | null {
    return this.lastPatchMetrics;
  }

  getLastWorkerError(): Extract<WorkerOut, { type: "ERROR" }> | null {
    return this.lastWorkerError;
  }

  addFlushListener(listener: (result: PatchFlushResult) => void): () => void {
    this.flushListeners.add(listener);
    return () => this.flushListeners.delete(listener);
  }

  pause(): void {
    this.patchScheduler.pause();
  }

  resume(): void {
    this.patchScheduler.resume();
  }

  isPaused(): boolean {
    return this.patchScheduler.isPaused();
  }

  restart(): void {
    this.patchScheduler.restart();
    this.store.reset([]);
    this.blocks = [];
    if (this.updateCallbacks.length > 0) {
      this.notifyUpdateCallbacks();
    }
  }

  finalize(): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: "FINALIZE" } as WorkerIn);
  }

  setCredits(value: number): void {
    if (!this.worker) return;
    const credits = Math.max(0, Math.min(1, value));
    this.worker.postMessage({ type: "SET_CREDITS", credits } as WorkerIn);
  }

  getPatchHistory(limit?: number): ReadonlyArray<PatchFlushResult> {
    return this.patchScheduler.getHistory(limit);
  }

  setPatchHistoryLimit(limit: number): void {
    this.patchScheduler.setHistoryLimit(limit);
  }

  clearPatchHistory(): void {
    this.patchScheduler.clearHistory();
  }

  getPendingQueueSize(): number {
    return this.patchScheduler.getPendingCount();
  }

  /**
   * Handle scheduled patch flush results from the commit scheduler.
   */
  private handlePatchFlush(result: PatchFlushResult): void {
    if (!result || result.batches.length === 0) {
      return;
    }

    const touchedIds = new Set<string>();
    for (const batch of result.batches) {
      if (batch.metrics) {
        this.lastPatchMetrics = batch.metrics;
      }
      for (const id of batch.touched) {
        touchedIds.add(id);
      }
    }

    if (this.updateCallbacks.length > 0) {
      this.blocks = this.store.getBlocks() as Block[];
      if (touchedIds.size > 0 || result.totalPatches > 0) {
        this.notifyUpdateCallbacks();
      }
    }

    if (this.flushListeners.size > 0) {
      for (const listener of this.flushListeners) {
        try {
          listener(result);
        } catch (error) {
          console.error("[markdown-renderer] flush listener failed", error);
        }
      }
    }
  }

  /**
   * Notify all update callbacks
   */
  private notifyUpdateCallbacks(): void {
    for (const callback of this.updateCallbacks) {
      callback(this.blocks);
    }
  }
}

/**
 * React hook for using the markdown renderer
 */
export function useMarkdownRenderer(config: RendererConfig = {}): {
  renderer: MarkdownRenderer;
  blocks: ReadonlyArray<Block>;
  append: (text: string) => void;
  renderStatic: (text: string) => Promise<Block[]>;
  setBlockComponents: (components: Partial<BlockComponents>) => void;
  setInlineComponents: (components: Partial<InlineComponents>) => void;
  setMdxComponents: (components: Record<string, React.ComponentType<unknown>>) => void;
  store: ReturnType<MarkdownRenderer["getStore"]>;
} {
  const [renderer] = useState(() => new MarkdownRenderer(config));
  const [blocks, setBlocks] = useState<ReadonlyArray<Block>>([]);
  const workerRef = useRef<Worker | null>(null);

  // Initialize worker
  useEffect(() => {
    if (!workerRef.current) {
      const fallbackFactory = () => new Worker("/workers/markdown-worker.js", { type: "module", name: "markdown-v2" });
      const worker = createDefaultWorker() ?? fallbackFactory();
      workerRef.current = worker;
      renderer.attachWorker(worker);
    }

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        releaseDefaultWorker(workerRef.current);
        workerRef.current = null;
      }
    };
  }, [renderer]);

  // Subscribe to updates
  useEffect(() => {
    const unsubscribe = renderer.onUpdate(setBlocks);
    return unsubscribe;
  }, [renderer]);

  const mdxComponents = config.mdx?.components;
  useEffect(() => {
    if (mdxComponents && Object.keys(mdxComponents).length > 0) {
      renderer.setMdxComponents(mdxComponents);
    }
  }, [renderer, mdxComponents]);

  const append = useCallback(
    (text: string) => {
      renderer.append(text);
    },
    [renderer],
  );

  const renderStatic = useCallback(
    (text: string) => {
      return renderer.renderStatic(text);
    },
    [renderer],
  );

  const setBlockComponents = useCallback(
    (components: Partial<BlockComponents>) => {
      renderer.setBlockComponents(components);
    },
    [renderer],
  );

  const setInlineComponents = useCallback(
    (components: Partial<InlineComponents>) => {
      renderer.setInlineComponents(components);
    },
    [renderer],
  );

  const setMdxComponents = useCallback(
    (components: Record<string, React.ComponentType<unknown>>) => {
      renderer.setMdxComponents(components);
    },
    [renderer],
  );

  return {
    renderer,
    blocks,
    append,
    renderStatic,
    setBlockComponents,
    setInlineComponents,
    setMdxComponents,
    store: renderer.getStore(),
  };
}

/**
 * React component for rendering markdown blocks
 */
export const MarkdownBlocksRenderer = React.memo<{
  blocks: ReadonlyArray<Block>;
  componentRegistry: ComponentRegistry;
  className?: string;
  style?: React.CSSProperties;
  store?: ReturnType<typeof createRendererStore>;
}>(({ blocks, componentRegistry, className = "markdown-renderer", style, store }) => {
  if (store) {
    return React.createElement(
      "div",
      {
        className,
        style: { contain: "content", ...(style ?? {}) }, // CSS containment for performance
      },
      React.createElement(StoreBackedBlocks, { store, componentRegistry }),
    );
  }

  const renderedBlocks = useMemo(() => {
    return blocks.map((block) => {
      const key = getBlockKey(block);
      return React.createElement(BlockRenderer, {
        key,
        block,
        componentRegistry,
        isFinalized: block.isFinalized,
      });
    });
  }, [blocks, componentRegistry]);

  return React.createElement(
    "div",
    {
      className,
      style: { contain: "content", ...(style ?? {}) }, // CSS containment for performance
    },
    renderedBlocks,
  );
});

const StoreBackedBlocks = React.memo<{ store: ReturnType<typeof createRendererStore>; componentRegistry: ComponentRegistry }>(
  ({ store, componentRegistry }) => {
    const blockIds = useRendererChildren(store, PATCH_ROOT_ID);
    return React.createElement(
      React.Fragment,
      null,
      blockIds.map((blockId) => React.createElement(BlockNodeRenderer, { key: blockId, store, blockId, registry: componentRegistry })),
    );
  },
);

StoreBackedBlocks.displayName = "StoreBackedBlocks";

/**
 * Individual block renderer with memoization
 */
const BlockRenderer = React.memo<{
  block: Block;
  componentRegistry: ComponentRegistry;
  isFinalized: boolean;
}>(({ block, componentRegistry, isFinalized }) => {
  const element = useMemo(() => {
    return componentRegistry.renderBlock(block);
  }, [block, componentRegistry]);

  // Add finalization indicator for debugging
  const className = `markdown-block markdown-block-${block.type} ${isFinalized ? "finalized" : "dirty"}`;

  return React.cloneElement(element, {
    className: `${element.props.className || ""} ${className}`.trim(),
    "data-block-id": block.id,
    "data-finalized": isFinalized,
  });
});

/**
 * Complete markdown renderer component
 */
export const MarkdownRenderer2: React.FC<{
  config?: RendererConfig;
  className?: string;
  onBlocksChange?: (blocks: ReadonlyArray<Block>) => void;
  children?: (api: ReturnType<typeof useMarkdownRenderer>) => React.ReactNode;
}> = ({ config, className, onBlocksChange, children }) => {
  const api = useMarkdownRenderer(config);

  // Notify parent of block changes
  useEffect(() => {
    if (onBlocksChange) {
      onBlocksChange(api.blocks);
    }
  }, [api.blocks, onBlocksChange]);

  if (children) {
    return React.createElement(React.Fragment, {}, children(api));
  }

  return React.createElement(MarkdownBlocksRenderer, {
    blocks: api.blocks,
    componentRegistry: api.renderer.getComponentRegistry(),
    className,
    store: api.renderer.getStore(),
  });
};

/**
 * Factory function for creating renderer instances
 */
export function createMarkdownRenderer(config: RendererConfig = {}): MarkdownRenderer {
  return new MarkdownRenderer(config);
}
