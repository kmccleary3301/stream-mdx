import type { Block, PatchMetrics, WorkerIn, WorkerOut } from "@stream-mdx/core";
// Main V2 Markdown Renderer
// Client-side renderer with component registry and worker integration
import type { PatchCommitSchedulerOptions, PatchFlushResult } from "./renderer/patch-commit-scheduler";
import type { BlockComponents, CodeHighlightRangeRequest, CodeRenderersConfig, InlineComponents, MathRenderer, Renderer, RendererConfig, TableVirtualizationOptions } from "./types";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { createDefaultWorker, releaseDefaultWorker } from "@stream-mdx/worker";
import { ComponentRegistry } from "./components";
import { getMDXComponentFactory, registerMDXComponents } from "./mdx-client";
import { CodeHighlightRequestContext } from "./renderer/code-highlight-context";
import { getPatchKind, isHeavyPatch, splitPatchBatch } from "./renderer/patch-batching";
import { PatchCommitScheduler } from "./renderer/patch-commit-scheduler";
import { createRendererStore, type RendererStore } from "./renderer/store";
import { MarkdownBlocksRenderer } from "./renderer/blocks-renderer";

export { MarkdownBlocksRenderer } from "./renderer/blocks-renderer";

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

interface OwnedInitialization {
  owner?: MarkdownRenderer;
  resolve?: (blocks: Block[]) => void;
  reject?: (error: Error) => void;
}

interface WorkerInitializationQueue {
  pending: OwnedInitialization[];
  acknowledgements: WeakMap<MessageEvent<WorkerOut>, OwnedInitialization>;
}

function extractWorkerError(event: Event): Error {
  if (event && "error" in event) {
    const candidate = event.error;
    if (candidate instanceof Error) {
      return candidate;
    }
  }
  if (event && "message" in event && typeof event.message === "string") {
    return new Error(event.message);
  }
  return new Error("Worker error");
}

// A borrowed worker can outlive its renderer. Keep cancelled FIFO slots until
// their native responses arrive, including while no renderer is attached.
const workerInitializations = new WeakMap<Worker, WorkerInitializationQueue>();
function getWorkerInitializations(worker: Worker): WorkerInitializationQueue {
  const existing = workerInitializations.get(worker);
  if (existing) return existing;
  const queue: WorkerInitializationQueue = { pending: [], acknowledgements: new WeakMap() };
  workerInitializations.set(worker, queue);
  worker.addEventListener("message", (event: MessageEvent<WorkerOut>) => {
    const message = event.data;
    if (message.type === "INITIALIZED") {
      const initialization = queue.pending.shift();
      if (initialization) {
        queue.acknowledgements.set(event, initialization);
        initialization.resolve?.(message.blocks);
      }
    } else if (message.type === "ERROR" && message.phase === "INIT" && typeof message.meta?.rule !== "string") {
      queue.pending.shift()?.reject?.(new Error(message.error.message));
    }
  });
  worker.addEventListener("error", (event: Event) => {
    const error = extractWorkerError(event);
    while (queue.pending.length > 0) {
      queue.pending.shift()?.reject?.(error);
    }
  });
  return queue;
}

/**
 * Main renderer class
 */
export class MarkdownRenderer implements Renderer {
  private worker: Worker | null = null;
  private skipWorkerInit = false;
  private workerHasContent = false;
  private initializationQueue: WorkerInitializationQueue | null = null;
  private blocks: Block[] = [];
  private updateCallbacks: Array<(blocks: ReadonlyArray<Block>) => void> = [];
  private componentRegistry: ComponentRegistry;
  private config: RendererConfig;
  private store: RendererStore;
  private patchScheduler: PatchCommitScheduler;
  private lastPatchMetrics: PatchMetrics | null = null;
  private lastWorkerError: Extract<WorkerOut, { type: "ERROR" }> | null = null;
  private flushListeners = new Set<(result: PatchFlushResult) => void>();
  private workerMessageListener: ((event: MessageEvent<WorkerOut>) => void) | null = null;
  private workerErrorListener: ((event: Event) => void) | null = null;

  constructor(config: RendererConfig = {}) {
    this.config = config;
    this.store = createRendererStore([], { themes: config.themes });
    this.componentRegistry = new ComponentRegistry(
      {},
      {},
      this.config.codeRenderers ?? {},
      {
        artifactHtml: this.config.artifactHtml,
        mathRenderer: this.config.mathRenderer,
        tableVirtualization: this.config.tableVirtualization,
        urlTransform: this.config.urlTransform,
        blockRenderer: this.config.blockRenderer,
        allowedElements: this.config.allowedElements,
        disallowedElements: this.config.disallowedElements,
        allowElement: this.config.allowElement,
        unwrapDisallowed: this.config.unwrapDisallowed,
        disableAutolinkProtocols: this.config.disableAutolinkProtocols,
      },
    );
    if (this.config.html?.literalTagContent) {
      this.componentRegistry.setLiteralTagContent(this.config.html.literalTagContent);
    }
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
        adaptiveBudgeting: this.config.performance?.adaptiveBudgeting,
      },
    });
  }

  /**
   * Attach Web Worker
   */
  attachWorker(worker: Worker, options?: { skipInit?: boolean }): void {
    if (this.worker) this.detachWorker();
    this.patchScheduler.restart();
    this.store.reset([]);
    this.blocks = [];
    if (this.updateCallbacks.length > 0) {
      this.notifyUpdateCallbacks();
    }
    this.worker = worker;
    this.skipWorkerInit = options?.skipInit ?? false;
    this.workerHasContent = false;
    this.initializationQueue = getWorkerInitializations(worker);
    this.workerMessageListener = this.handleWorkerMessage.bind(this);
    this.worker.addEventListener("message", this.workerMessageListener);
    this.workerErrorListener = this.handleWorkerError.bind(this);
    this.worker.addEventListener("error", this.workerErrorListener);
    if (!this.skipWorkerInit) this.initializeWorker();
  }

  private initializeWorker(initialContent = "", completion: OwnedInitialization = {}): void {
    if (!this.worker) throw new Error("Worker not attached");
    this.store.setThemes(this.config.themes);
    const mdxComponentNames = getMdxComponentNames(this.config);
    const codeHighlighting = this.config.plugins?.codeHighlighting;
    const outputMode = this.config.plugins?.outputMode;
    const liveTokenization = this.config.plugins?.liveTokenization;
    const emitHighlightTokens = this.config.plugins?.emitHighlightTokens;
    const emitDiffBlocks = this.config.plugins?.emitDiffBlocks;
    const docPlugins = {
      footnotes: this.config.plugins?.footnotes ?? true,
      html: this.config.plugins?.html ?? true,
      mdx: this.config.plugins?.mdx ?? true,
      tables: this.config.plugins?.tables ?? true,
      callouts: this.config.plugins?.callouts ?? false,
      math: this.config.plugins?.math ?? true,
      formatAnticipation: this.config.plugins?.formatAnticipation ?? false,
      ...(codeHighlighting !== undefined ? { codeHighlighting } : {}),
      ...(outputMode !== undefined ? { outputMode } : {}),
      liveCodeHighlighting: this.config.plugins?.liveCodeHighlighting ?? false,
      ...(liveTokenization !== undefined ? { liveTokenization } : {}),
      ...(emitHighlightTokens !== undefined ? { emitHighlightTokens } : {}),
      ...(emitDiffBlocks !== undefined ? { emitDiffBlocks } : {}),
      ...(mdxComponentNames ? { mdxComponentNames } : {}),
    };
    this.initializationQueue?.pending.push({ ...completion, owner: this });
    try {
      this.worker.postMessage({
        type: "INIT",
        initialContent,
        prewarmLangs: this.config.highlight?.langs || [],
        docPlugins,
        mdx: { compileMode: this.config.mdx?.compileStrategy ?? "server" },
        ...(this.config.themes ? { themes: this.config.themes } : {}),
        ...(this.config.syntax ? { syntax: this.config.syntax } : {}),
        ...(this.config.html ? { html: this.config.html } : {}),
      } as WorkerIn);
      this.workerHasContent = initialContent.length > 0;
    } catch (error) {
      this.initializationQueue?.pending.pop();
      throw error;
    }
  }

  detachWorker(options: { terminate?: boolean } = {}): void {
    this.patchScheduler.clear();
    if (!this.worker) return;
    const shouldTerminate = options.terminate ?? false;
    for (const initialization of this.initializationQueue?.pending ?? []) {
      if (initialization.owner !== this) continue;
      initialization.reject?.(new Error("Worker detached before initialization completed"));
      initialization.owner = undefined;
      initialization.resolve = undefined;
      initialization.reject = undefined;
    }
    try {
      if (this.workerMessageListener) {
        this.worker.removeEventListener("message", this.workerMessageListener);
      }
      if (this.workerErrorListener) {
        this.worker.removeEventListener("error", this.workerErrorListener);
      }
      if (shouldTerminate && typeof this.worker.terminate === "function") {
        this.worker.terminate();
      }
    } catch (error) {
      console.warn("Failed to detach markdown worker", error);
    } finally {
      this.worker = null;
      this.workerMessageListener = null;
      this.workerErrorListener = null;
      this.workerHasContent = false;
      this.initializationQueue = null;
    }
  }
  private handleWorkerError(event: Event): void {
    const error = extractWorkerError(event);
    this.lastWorkerError = {
      type: "ERROR",
      phase: "UNKNOWN",
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    };
    for (const initialization of this.initializationQueue?.pending ?? []) {
      if (initialization.owner !== this) continue;
      initialization.reject?.(error);
      initialization.owner = undefined;
      initialization.resolve = undefined;
      initialization.reject = undefined;
    }
  }


  /**
   * Append text chunk for streaming
   */
  append(text: string): void {
    if (!this.worker) {
      throw new Error("Worker not attached");
    }
    this.workerHasContent ||= text.length > 0;

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

      this.patchScheduler.restart();
      this.store.reset([]);
      this.blocks = [];
      if (this.updateCallbacks.length > 0) this.notifyUpdateCallbacks();
      this.initializeWorker(text, { resolve, reject });
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
  setCodeRenderers(map: CodeRenderersConfig): void {
    this.componentRegistry.setCodeRenderers(map);
  }

  setMathRenderer(mathRenderer: MathRenderer): void {
    this.componentRegistry.setMathRenderer(mathRenderer);
  }

  setTableVirtualization(options: TableVirtualizationOptions): void {
    this.componentRegistry.setTableVirtualization(options);
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
      case "INITIALIZED": {
        const initialization = this.initializationQueue?.acknowledgements.get(event);
        if (initialization && initialization.owner !== this) break;
        if (this.initializationQueue?.pending.length === 0) {
          this.patchScheduler.clear();
          this.store.reset(message.blocks);
          if (this.updateCallbacks.length > 0) {
            this.blocks = this.store.getBlocks() as Block[];
            this.notifyUpdateCallbacks();
          }
        }
        break;
      }

      case "METRICS":
        // Handle performance metrics
        if (WORKER_DEBUG_ENABLED) {
          // eslint-disable-next-line no-console
          console.debug("Worker metrics:", message.metrics);
        }
        break;

      case "PATCH": {
        if (this.initializationQueue && this.initializationQueue.pending.length > 0) break;
        if (message.metrics) {
          this.lastPatchMetrics = message.metrics;
        }
        if (message.patches.length > 0) {
          const receivedAt = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
          const batches = splitPatchBatch(message.patches);
          batches.forEach((batch, index) => {
            const hasSemantic = batch.some((patch) => getPatchKind(patch) === "semantic");
            const priority: "high" | "low" = hasSemantic ? "high" : batch.some(isHeavyPatch) ? "low" : "high";
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

      case "DEBUG_STATE":
        // Debug-only worker payloads; ignore in the renderer.
        break;

      case "FINALIZED":
        // Server/CLI compile completion signal; ignore in the renderer.
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
    if (this.workerHasContent) {
      if (!this.skipWorkerInit) this.initializeWorker();
      this.workerHasContent = false;
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

  requestCodeHighlightRange(request: CodeHighlightRangeRequest): void {
    if (!this.worker) return;
    this.worker.postMessage({
      type: "TOKENIZE_RANGE",
      blockId: request.blockId,
      startLine: request.startLine,
      endLine: request.endLine,
      priority: request.priority,
    } as WorkerIn);
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

  setSchedulingOptions(options: PatchCommitSchedulerOptions): void {
    this.patchScheduler.updateOptions(options);
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
 * Complete markdown renderer component
 */
export const MarkdownRenderer2: React.FC<{
  config?: RendererConfig;
  className?: string;
  onBlocksChange?: (blocks: ReadonlyArray<Block>) => void;
  children?: (api: ReturnType<typeof useMarkdownRenderer>) => React.ReactNode;
}> = ({ config, className, onBlocksChange, children }) => {
  const api = useMarkdownRenderer(config);
  const highlightRequester = useCallback(
    (request: CodeHighlightRangeRequest) => {
      api.renderer.requestCodeHighlightRange(request);
    },
    [api.renderer],
  );

  // Notify parent of block changes
  useEffect(() => {
    if (onBlocksChange) {
      onBlocksChange(api.blocks);
    }
  }, [api.blocks, onBlocksChange]);

  if (children) {
    return React.createElement(React.Fragment, {}, children(api));
  }

  return React.createElement(
    CodeHighlightRequestContext.Provider,
    { value: highlightRequester },
    React.createElement(MarkdownBlocksRenderer, {
      blocks: api.blocks,
      componentRegistry: api.renderer.getComponentRegistry(),
      className,
      store: api.renderer.getStore(),
    }),
  );
};

/**
 * Factory function for creating renderer instances
 */
export function createMarkdownRenderer(config: RendererConfig = {}): MarkdownRenderer {
  return new MarkdownRenderer(config);
}
