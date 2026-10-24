import type { Block, PatchMetrics, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createInitialSnapshot, STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import { SourceCapacityError, StreamSessionError, type AppendResult, type FinalizeResult, type WaitForCapacityOptions } from "@stream-mdx/protocol";
// Main V2 Markdown Renderer
// Client-side renderer with component registry and worker integration
import type { PatchCommitSchedulerOptions, PatchFlushResult } from "./renderer/patch-commit-scheduler";
import type { BlockComponents, CodeFenceRenderer, CodeHighlightRangeRequest, ControlsComponentProps, ControlsConfig, InlineComponents, MathRenderer, Renderer, RendererConfig, TableVirtualizationOptions } from "./types";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { createDefaultWorker, releaseDefaultWorker } from "@stream-mdx/worker";
import { ComponentRegistry } from "./components";
import { toSerializableDescriptors, type ContentComponentsMap } from "./components/content-components";
import { CodeHighlightRequestContext } from "./renderer/code-highlight-context";
import { getPatchKind, isHeavyPatch, splitPatchBatch } from "./renderer/patch-batching";
import { PatchCommitScheduler } from "./renderer/patch-commit-scheduler";
import { createRendererStore, type RendererStore } from "./renderer/store";
import { attachTrustedRevisionFeed, type TrustedRevisionFeed } from "./trusted-revision-feed";
import { SOURCE_ADMISSION_HARD_LIMIT, SOURCE_ADMISSION_SOFT_LIMIT } from "./source-admission-limits";
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


interface OwnedInitialization {
  owner?: MarkdownRenderer;
  generation: number;
  workerGeneration?: number;
  callerManagedBaseline?: true;
  resolve?: (blocks: Block[]) => void;
  reject?: (error: Error) => void;
}

interface OwnedFinalization {
  owner?: MarkdownRenderer;
  session: number;
  initialization: OwnedInitialization | null;
  workerGeneration?: number;
  acceptedSourceUnits: number;
  workerAdmissionBaselineSourceUnits: number;
  revisionToken?: { generation: number; version: number };
  acknowledgement?: Extract<WorkerOut, { type: "FINALIZED" }>;
  dispatched: boolean;
  waitingForPatchIdle?: boolean;
  resolve?: (result: FinalizeResult) => void;
  reject?: (error: Error) => void;
}

interface WorkerInitializationQueue {
  pending: OwnedInitialization[];
  acknowledgements: WeakMap<MessageEvent<WorkerOut>, OwnedInitialization>;
  pendingFinalizations: OwnedFinalization[];
  finalizationAcknowledgements: WeakMap<MessageEvent<WorkerOut>, OwnedFinalization>;
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
function hasCompatibleInputSource(message: Extract<WorkerOut, { type: "INITIALIZED" }>): boolean {
  const inputSource = message.snapshot.inputSource;
  return Number.isSafeInteger(message.generation) &&
    message.generation >= 0 &&
    inputSource?.generation === message.generation &&
    typeof inputSource?.raw === "string";
}

// A borrowed worker can outlive its renderer. Keep cancelled FIFO slots until
// their native responses arrive, including while no renderer is attached.
const workerInitializations = new WeakMap<Worker, WorkerInitializationQueue>();
function getWorkerInitializations(worker: Worker): WorkerInitializationQueue {
  const existing = workerInitializations.get(worker);
  if (existing) return existing;
  const queue: WorkerInitializationQueue = {
    pending: [],
    acknowledgements: new WeakMap(),
    pendingFinalizations: [],
    finalizationAcknowledgements: new WeakMap(),
  };
  workerInitializations.set(worker, queue);
  worker.addEventListener("message", (event: MessageEvent<WorkerOut>) => {
    const message = event.data;
    if (message.type === "INITIALIZED") {
      const initialization = queue.pending.shift();
      if (initialization) {
        queue.acknowledgements.set(event, initialization);
        if (message.schemaVersion !== STREAM_MDX_SCHEMA_VERSION || !hasCompatibleInputSource(message)) {
          initialization.reject?.(new Error("Incompatible worker initialization: canonical input baseline is missing or invalid"));
        } else {
          try {
            initialization.resolve?.(createInitialSnapshot(message.snapshot).getBlocks());
          } catch (error) {
            initialization.reject?.(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
    } else if (message.type === "FINALIZED") {
      const finalization = queue.pendingFinalizations.shift();
      if (finalization) queue.finalizationAcknowledgements.set(event, finalization);
    } else if (message.type === "ERROR" && message.phase === "FINALIZE") {
      const finalization = queue.pendingFinalizations.shift();
      if (finalization) queue.finalizationAcknowledgements.set(event, finalization);
    } else if (
      message.type === "ERROR" &&
      message.phase === "INIT" &&
      message.meta?.theme !== undefined
    ) {
      // Theme errors are reported but must retain INIT until its INITIALIZED response.
      queue.pending[0]?.reject?.(new Error(message.error.message));
    } else if (message.type === "ERROR" && message.phase === "INIT" && typeof message.meta?.rule !== "string") {
      const initialization = queue.pending.shift();
      if (initialization) {
        queue.acknowledgements.set(event, initialization);
        initialization.reject?.(new Error(message.error.message));
      }
    }
  });
  worker.addEventListener("error", (event: Event) => {
    const error = extractWorkerError(event);
    while (queue.pending.length > 0) {
      queue.pending.shift()?.reject?.(error);
    }
    while (queue.pendingFinalizations.length > 0) {
      const finalization = queue.pendingFinalizations.shift();
      if (!finalization) continue;
      finalization.owner = undefined;
      finalization.reject?.(error);
      finalization.resolve = undefined;
      finalization.reject = undefined;
    }
  });
  return queue;
}

type SourceCapacityWaiter = {
  session: number;
  units: number;
  signal?: AbortSignal;
  abort?: () => void;
  resolve(): void;
  reject(error: Error): void;
};

/**
 * Main renderer class
 */
export class MarkdownRenderer implements Renderer {
  private worker: Worker | null = null;
  private blocks: Block[] = [];
  private skipWorkerInit = false;
  private managedInitializationPending = false;
  private managedInitializationCallback?: () => void;
  private managedInitializationErrorCallback?: (error: Error) => void;
  private workerHasContent = false;
  private workerSchemaReady = false;
  private initializationQueue: WorkerInitializationQueue | null = null;
  private currentInitialization: OwnedInitialization | null = null;
  private pendingStreamCommands: Array<Extract<WorkerIn, { type: "APPEND" | "FINALIZE" }>> = [];
  private initializationWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
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
  private readonly trustedRevisionFeed: TrustedRevisionFeed | null;
  private trustedFinalizedGeneration: number | null = null;
  private trustedFinalizedVersion: number | null = null;
  private inputSealed = false;
  private acceptedSourceUnits = 0;
  private workerAdmittedSourceUnits = 0;
  private workerAdmissionBaselineSourceUnits = 0;
  private workerAdmissionGeneration: number | null = null;
  private admissionSession = 0;
  private admissionFailure: StreamSessionError | null = null;
  private capacityWaiters = new Set<SourceCapacityWaiter>();
  private semanticAwaitingFlush = false;
  private finalizationPromise: Promise<FinalizeResult> | null = null;
  private pendingFinalization: OwnedFinalization | null = null;

  constructor(config: RendererConfig = {}) {
    if (config.contentPolicy === "trusted-mdx" && !config.engines?.mdx) {
      throw new Error("contentPolicy='trusted-mdx' requires an explicit engines.mdx trusted MDX engine.");
    }
    this.config = config;
    this.trustedRevisionFeed = config.contentPolicy === "trusted-mdx" ? attachTrustedRevisionFeed(this) : null;
    this.store = createRendererStore([], { themes: config.themes });
    this.componentRegistry = new ComponentRegistry(
      {},
      {},
      this.config.codeRenderers ?? {},
      {
        mathRenderer: this.config.mathRenderer,
        tableVirtualization: this.config.tableVirtualization,
        codeVirtualization: this.config.codeVirtualization,
        urlTransform: this.config.urlTransform,
        blockRenderer: this.config.blockRenderer,
        controls: this.config.controls,
        controlsComponent: this.config.controlsComponent,
        allowedElements: this.config.allowedElements,
        disallowedElements: this.config.disallowedElements,
        allowElement: this.config.allowElement,
        unwrapDisallowed: this.config.unwrapDisallowed,
        disableAutolinkProtocols: this.config.disableAutolinkProtocols,
        contentComponents: this.config.contentComponents,
        components: this.config.components,
      },
    );
    if (this.config.html?.literalTagContent) {
      this.componentRegistry.setLiteralTagContent(this.config.html.literalTagContent);
    }
    this.patchScheduler = new PatchCommitScheduler({
      store: this.store,
      onFlush: (result, hasNonInputSourcePatch) => this.handlePatchFlush(result, hasNonInputSourcePatch),
      isGenerationCurrent: (generation) => generation === this.workerAdmissionGeneration,
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
  attachWorker(worker: Worker, options?: {
    skipInit?: boolean;
    onInitialized?: () => void;
    onInitializationError?: (error: Error) => void;
  }): void {
    if (this.worker) this.detachWorker();
    this.patchScheduler.restart();
    this.semanticAwaitingFlush = false;
    this.componentRegistry.resetAnimationTimeline();
    this.store.reset([]);
    this.blocks = [];
    if (this.updateCallbacks.length > 0) {
      this.notifyUpdateCallbacks();
    }
    this.resetSourceAdmission();
    this.inputSealed = false;
    this.worker = worker;
    this.skipWorkerInit = options?.skipInit ?? false;
    this.managedInitializationPending = this.skipWorkerInit;
    this.managedInitializationCallback = this.skipWorkerInit ? options?.onInitialized : undefined;
    this.managedInitializationErrorCallback = this.skipWorkerInit ? options?.onInitializationError : undefined;
    this.workerHasContent = false;
    // Readiness requires the matching native schema-validated root, including for caller-managed workers.
    this.workerSchemaReady = false;
    this.lastWorkerError = null;
    this.initializationQueue = getWorkerInitializations(worker);
    this.workerMessageListener = this.handleWorkerMessage.bind(this);
    this.worker.addEventListener("message", this.workerMessageListener);
    this.workerErrorListener = this.handleWorkerError.bind(this);
    this.worker.addEventListener("error", this.workerErrorListener);
    if (!this.skipWorkerInit) {
      this.initializeWorker("", {
        resolve: () => options?.onInitialized?.(),
        reject: options?.onInitializationError,
      });
    } else {
      this.currentInitialization = {
        owner: this,
        generation: this.trustedRevisionFeed?.getSnapshot().generation ?? 0,
        callerManagedBaseline: true,
      };
    }
  }

  private initializeWorker(
    initialContent = "",
    completion: Omit<OwnedInitialization, "owner" | "generation"> = {},
  ): void {
    if (!this.worker) throw new Error("Worker not attached");
    this.resetSourceAdmission();
    this.inputSealed = false;
    this.store.setThemes(this.config.themes);
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
    };
    const initialization = {
      ...completion,
      owner: this,
      generation: this.trustedRevisionFeed?.getSnapshot().generation ?? 0,
    };
    this.pendingStreamCommands = [];
    this.currentInitialization = initialization;
    this.initializationQueue?.pending.push(initialization);
    this.workerSchemaReady = false;
    try {
      const contentComponents = this.config.contentComponents
        ? toSerializableDescriptors(this.config.contentComponents)
        : undefined;
      this.worker.postMessage({
        type: "INIT",
        schemaVersion: STREAM_MDX_SCHEMA_VERSION,
        initialContent,
        prewarmLangs: this.config.highlight?.langs || [],
        docPlugins,
        contentPolicy: this.config.contentPolicy ?? "restricted",
        ...(contentComponents ? { contentComponents } : {}),
        ...(this.config.themes ? { themes: this.config.themes } : {}),
        ...(this.config.syntax ? { syntax: this.config.syntax } : {}),
        ...(this.config.html ? { html: this.config.html } : {}),
      } as WorkerIn);
      this.workerHasContent = initialContent.length > 0;
    } catch (error) {
      this.initializationQueue?.pending.pop();
      if (this.currentInitialization === initialization) this.currentInitialization = null;
      this.pendingStreamCommands = [];
      throw error;
    }
  }
  /** Wait for this attachment's matching schema-validated initial root; no source export. */
  whenInitialized(): Promise<void> {
    if (!this.worker) return Promise.reject(new Error("Worker not attached"));
    if (this.workerSchemaReady) return Promise.resolve();
    if (this.lastWorkerError) {
      const error = new Error(this.lastWorkerError.error.message);
      error.name = this.lastWorkerError.error.name ?? "WorkerInitializationError";
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => this.initializationWaiters.add({ resolve, reject }));
  }

  private settleInitialization(error?: Error): void {
    for (const waiter of this.initializationWaiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    this.initializationWaiters.clear();
  }
  private reportManagedInitializationError(error: Error): void {
    const callback = this.managedInitializationErrorCallback;
    this.managedInitializationErrorCallback = undefined;
    callback?.(error);
  }
  private pendingSourceUnits(): number {
    return this.acceptedSourceUnits - (this.workerAdmittedSourceUnits - this.workerAdmissionBaselineSourceUnits);
  }

  private appendResult(): AppendResult {
    const pendingSourceUnits = this.pendingSourceUnits();
    return {
      acceptedSourceUnits: this.acceptedSourceUnits,
      pendingSourceUnits,
      shouldPause: pendingSourceUnits >= SOURCE_ADMISSION_SOFT_LIMIT,
    };
  }

  private rejectCapacityWaiters(error: Error): void {
    for (const waiter of this.capacityWaiters) {
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(error);
    }
    this.capacityWaiters.clear();
  }

  private rejectPendingFinalization(error: Error): void {
    const finalization = this.pendingFinalization;
    if (!finalization) return;
    this.pendingFinalization = null;
    if (!finalization.dispatched) {
      const index = this.initializationQueue?.pendingFinalizations.indexOf(finalization) ?? -1;
      if (index >= 0) this.initializationQueue?.pendingFinalizations.splice(index, 1);
    }
    finalization.owner = undefined;
    finalization.reject?.(error);
    finalization.resolve = undefined;
    finalization.reject = undefined;
  }

  private resetFinalizationSession(error: Error): void {
    this.rejectPendingFinalization(error);
    this.finalizationPromise = null;
  }

  private tryCompleteFinalization(): void {
    const finalization = this.pendingFinalization;
    const acknowledgement = finalization?.acknowledgement;
    if (
      !finalization ||
      !acknowledgement ||
      finalization.owner !== this ||
      finalization.session !== this.admissionSession ||
      this.semanticAwaitingFlush
    ) {
      return;
    }
    if (acknowledgement.generation !== this.workerAdmissionGeneration) {
      this.rejectPendingFinalization(new StreamSessionError(
        "stale-generation",
        "Finalization belongs to a replaced worker generation",
      ));
      return;
    }
    // Do not report native source committed until all corresponding patches reach the store.
    if (!this.patchScheduler.isIdle()) {
      if (!finalization.waitingForPatchIdle) {
        finalization.waitingForPatchIdle = true;
        void this.patchScheduler.awaitIdle().then(() => {
          finalization.waitingForPatchIdle = false;
          this.tryCompleteFinalization();
        });
      }
      return;
    }
    this.pendingFinalization = null;
    finalization.owner = undefined;
    finalization.resolve?.({
      generation: acknowledgement.generation,
      acceptedSourceUnits: finalization.acceptedSourceUnits,
      committedSourceUnits: acknowledgement.admittedSourceUnits - finalization.workerAdmissionBaselineSourceUnits,
    });
    finalization.resolve = undefined;
    finalization.reject = undefined;
  }

  private resetSourceAdmission(options: { preserveWorkerFrontier?: boolean } = {}): void {
    const preserveWorkerFrontier = options.preserveWorkerFrontier ?? false;
    const nextBaselineSourceUnits = preserveWorkerFrontier
      ? this.workerAdmissionBaselineSourceUnits + this.acceptedSourceUnits
      : 0;
    const workerAdmissionGeneration = preserveWorkerFrontier ? this.workerAdmissionGeneration : null;
    this.resetFinalizationSession(new StreamSessionError("stale-generation", "Finalization belongs to an ended generation"));
    this.rejectCapacityWaiters(new StreamSessionError("stale-generation", "Source capacity wait belongs to an ended generation"));
    this.admissionSession += 1;
    this.acceptedSourceUnits = 0;
    this.workerAdmissionBaselineSourceUnits = nextBaselineSourceUnits;
    this.workerAdmittedSourceUnits = nextBaselineSourceUnits;
    this.workerAdmissionGeneration = workerAdmissionGeneration;
    this.admissionFailure = null;
  }

  private failSourceAdmission(message: string, reason: "stale-generation" | "disposed" = "stale-generation"): void {
    const error = new StreamSessionError(reason, message);
    this.admissionFailure = error;
    this.rejectCapacityWaiters(error);
    this.rejectPendingFinalization(error);
  }

  private settleCapacityWaiters(): void {
    const pendingSourceUnits = this.pendingSourceUnits();
    for (const waiter of this.capacityWaiters) {
      const error = waiter.session !== this.admissionSession
        ? new StreamSessionError("stale-generation", "Source capacity wait belongs to an ended generation")
        : this.admissionFailure ?? (this.inputSealed ? new StreamSessionError("sealed", "The source session is sealed") : null);
      if (error) {
        this.capacityWaiters.delete(waiter);
        if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.reject(error);
      } else if (
        pendingSourceUnits < SOURCE_ADMISSION_SOFT_LIMIT &&
        pendingSourceUnits + waiter.units <= SOURCE_ADMISSION_HARD_LIMIT
      ) {
        this.capacityWaiters.delete(waiter);
        if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.resolve();
      }
    }
  }

  waitForCapacity(options: WaitForCapacityOptions): Promise<void> {
    const { units, signal } = options;
    const pendingSourceUnits = this.pendingSourceUnits();
    if (this.inputSealed) return Promise.reject(new StreamSessionError("sealed", "The source session is sealed"));
    if (this.admissionFailure) return Promise.reject(this.admissionFailure);
    if (!Number.isSafeInteger(units) || units < 0) return Promise.reject(new RangeError("Capacity units must be a nonnegative safe integer"));
    if (units > SOURCE_ADMISSION_HARD_LIMIT) {
      return Promise.reject(new SourceCapacityError(units, pendingSourceUnits, SOURCE_ADMISSION_HARD_LIMIT));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Capacity wait aborted"));
    }
    if (
      pendingSourceUnits < SOURCE_ADMISSION_SOFT_LIMIT &&
      pendingSourceUnits + units <= SOURCE_ADMISSION_HARD_LIMIT
    ) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: SourceCapacityWaiter = { session: this.admissionSession, units, signal, resolve, reject };
      if (signal) {
        const abort = () => {
          this.capacityWaiters.delete(waiter);
          signal.removeEventListener("abort", abort);
          const reason = signal.reason;
          const error = reason instanceof Error ? reason : new Error("Capacity wait aborted");
          error.name = error.name === "Error" ? "AbortError" : error.name;
          reject(error);
        };
        waiter.abort = abort;
        signal.addEventListener("abort", abort, { once: true });
      }
      this.capacityWaiters.add(waiter);
    });
  }



  private flushPendingStreamCommands(initialization: OwnedInitialization): void {
    if (this.currentInitialization !== initialization || !this.workerSchemaReady || !this.worker) return;
    const commands = this.pendingStreamCommands;
    this.pendingStreamCommands = [];
    this.currentInitialization = null;
    try {
      for (const command of commands) {
        this.worker.postMessage(command);
        if (command.type === "FINALIZE") {
          const finalization = this.pendingFinalization;
          if (finalization?.initialization === initialization) finalization.dispatched = true;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failSourceAdmission(message);
    }
  }


  detachWorker(options: { terminate?: boolean } = {}): void {
    this.patchScheduler.clear();
    this.semanticAwaitingFlush = false;
    this.workerSchemaReady = false;
    this.managedInitializationPending = false;
    this.managedInitializationCallback = undefined;
    this.managedInitializationErrorCallback = undefined;
    this.failSourceAdmission("Worker detached before admission completed", "disposed");
    this.admissionSession += 1;
    this.acceptedSourceUnits = 0;
    this.workerAdmittedSourceUnits = 0;
    this.workerAdmissionBaselineSourceUnits = 0;
    this.workerAdmissionGeneration = null;
    this.settleInitialization(new Error("Worker detached before initialization completed"));
    this.pendingStreamCommands = [];
    this.currentInitialization = null;
    if (!this.worker) return;
    const shouldTerminate = options.terminate ?? false;
    for (const initialization of this.initializationQueue?.pending ?? []) {
      if (initialization.owner !== this) continue;
      initialization.reject?.(new Error("Worker detached before initialization completed"));
      initialization.owner = undefined;
      initialization.resolve = undefined;
      initialization.reject = undefined;
    }
    for (const finalization of this.initializationQueue?.pendingFinalizations ?? []) {
      if (finalization.owner === this) finalization.owner = undefined;
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
    this.failSourceAdmission(error.message);
    this.pendingStreamCommands = [];
    this.currentInitialization = null;
    if (this.managedInitializationPending) this.reportManagedInitializationError(error);
    this.settleInitialization(error);
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
  append(text: string): AppendResult {
    if (this.inputSealed) {
      throw new StreamSessionError("sealed", "Cannot append after FINALIZE; start a new generation first");
    }
    if (this.admissionFailure) throw this.admissionFailure;
    if (!this.worker) throw new StreamSessionError("disposed", "Worker not attached");
    if (!this.workerSchemaReady && this.currentInitialization?.owner !== this) {
      throw new StreamSessionError("stale-generation", "Wait for matching worker initialization before appending source");
    }

    const pendingSourceUnits = this.pendingSourceUnits();
    if (text.length > SOURCE_ADMISSION_HARD_LIMIT - pendingSourceUnits) {
      throw new SourceCapacityError(text.length, pendingSourceUnits, SOURCE_ADMISSION_HARD_LIMIT);
    }

    // PATCH handling stays closed until the worker's validated root, so queue source commands behind it.
    if (this.workerSchemaReady) this.worker.postMessage({ type: "APPEND", text } as WorkerIn);
    else this.pendingStreamCommands.push({ type: "APPEND", text });
    this.acceptedSourceUnits += text.length;
    this.workerHasContent ||= text.length > 0;
    this.trustedRevisionFeed?.append(text);
    if (this.trustedRevisionFeed && text.length > 0) {
      this.trustedFinalizedGeneration = null;
      this.trustedFinalizedVersion = null;
    }
    this.settleCapacityWaiters();
    return this.appendResult();
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

      this.inputSealed = false;
      this.trustedRevisionFeed?.replace(text);
      this.trustedFinalizedGeneration = null;
      this.trustedFinalizedVersion = null;
      this.semanticAwaitingFlush = false;
      this.patchScheduler.restart();
      this.componentRegistry.resetAnimationTimeline();
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

  setContentComponents(map: ContentComponentsMap): void {
    this.componentRegistry.setContentComponents(map);
  }
  setCodeRenderers(map: Record<string, CodeFenceRenderer>): void {
    this.componentRegistry.setCodeRenderers(map);
  }

  setMathRenderer(mathRenderer: MathRenderer): void {
    this.componentRegistry.setMathRenderer(mathRenderer);
  }

  setTableVirtualization(options: TableVirtualizationOptions): void {
    this.componentRegistry.setTableVirtualization(options);
  }
  setControls(controls: ControlsConfig): void {
    this.componentRegistry.setControls(controls);
  }

  setControlsComponent(component?: React.ComponentType<ControlsComponentProps>): void {
    this.componentRegistry.setControlsComponent(component);
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
        if (message.schemaVersion !== STREAM_MDX_SCHEMA_VERSION || !hasCompatibleInputSource(message)) {
          this.workerSchemaReady = false;
          if (initialization && initialization === this.currentInitialization) {
            this.pendingStreamCommands = [];
            this.currentInitialization = null;
          }
          const messageText = message.schemaVersion !== STREAM_MDX_SCHEMA_VERSION
            ? `Incompatible worker schema: expected ${STREAM_MDX_SCHEMA_VERSION}, received ${message.schemaVersion}`
            : "Incompatible worker initialization: canonical input baseline is missing or invalid";
          this.lastWorkerError = {
            type: "ERROR",
            phase: "INIT",
            error: { name: "WorkerSchemaMismatch", message: messageText },
          };
          const error = new Error(messageText);
          error.name = "WorkerSchemaMismatch";
          this.failSourceAdmission(messageText);
          this.settleInitialization(error);
          if (this.managedInitializationPending) this.reportManagedInitializationError(error);
          break;
        }
        if (
          this.workerAdmissionGeneration !== null &&
          message.generation <= this.workerAdmissionGeneration
        ) {
          break;
        }
        if (
          initialization &&
          this.trustedRevisionFeed &&
          initialization.generation !== this.trustedRevisionFeed.getSnapshot().generation
        ) {
          break;
        }
        const managedBaselineInitialization =
          !initialization && this.currentInitialization?.callerManagedBaseline
            ? this.currentInitialization
            : null;
        const matchesCurrentInitialization = initialization !== undefined
          ? initialization === this.currentInitialization
          : managedBaselineInitialization !== null || this.currentInitialization === null;
        if (this.initializationQueue?.pending.length === 0 && matchesCurrentInitialization) {
          const acceptedInitialization = initialization ?? managedBaselineInitialization;
          if (acceptedInitialization) acceptedInitialization.workerGeneration = message.generation;
          this.patchScheduler.clear();
          this.semanticAwaitingFlush = false;
          try {
            this.store.resetSnapshot(message.snapshot);
          } catch (cause) {
            const messageText = cause instanceof Error ? cause.message : String(cause);
            this.workerSchemaReady = false;
            this.lastWorkerError = {
              type: "ERROR",
              phase: "INIT",
              error: { name: "WorkerSchemaMismatch", message: messageText },
            };
            const error = new Error(messageText);
            error.name = "WorkerSchemaMismatch";
            this.settleInitialization(error);
            this.failSourceAdmission(messageText);
            if (this.managedInitializationPending) this.reportManagedInitializationError(error);
            break;
          }
          if (this.workerAdmissionGeneration !== null) {
            this.resetSourceAdmission();
            this.inputSealed = false;
          }
          this.workerAdmissionGeneration = message.generation;
          this.workerAdmittedSourceUnits = 0;
          this.workerAdmissionBaselineSourceUnits = 0;
          this.admissionFailure = null;
          this.workerSchemaReady = true;
          this.lastWorkerError = null;
          if (this.updateCallbacks.length > 0) {
            this.blocks = this.store.getBlocks() as Block[];
            this.notifyUpdateCallbacks();
          }
          if (acceptedInitialization) this.flushPendingStreamCommands(acceptedInitialization);
          this.settleInitialization();
          if (this.managedInitializationPending) {
            this.managedInitializationPending = false;
            const callback = this.managedInitializationCallback;
            this.managedInitializationCallback = undefined;
            this.managedInitializationErrorCallback = undefined;
            callback?.();
          }
        }
        break;
      }

      case "SOURCE_ADMITTED": {
        const sessionAdmittedSourceUnits = message.admittedSourceUnits - this.workerAdmissionBaselineSourceUnits;
        if (
          message.generation !== this.workerAdmissionGeneration ||
          !Number.isSafeInteger(message.admittedSourceUnits) ||
          message.admittedSourceUnits < this.workerAdmissionBaselineSourceUnits ||
          message.admittedSourceUnits < this.workerAdmittedSourceUnits ||
          sessionAdmittedSourceUnits > this.acceptedSourceUnits
        ) {
          break;
        }
        this.workerAdmittedSourceUnits = message.admittedSourceUnits;
        this.settleCapacityWaiters();
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
        if (
          !this.workerSchemaReady ||
          (this.initializationQueue && this.initializationQueue.pending.length > 0) ||
          this.workerAdmissionGeneration === null ||
          message.generation !== this.workerAdmissionGeneration
        ) break;
        if (message.metrics) {
          this.lastPatchMetrics = message.metrics;
        }
        if (message.patches.length > 0) {
          const receivedAt = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
          const semanticGroups: Array<{ key?: string; patches: typeof message.patches }> = [];
          const semanticGroupsByTuple = new Map<string, (typeof semanticGroups)[number]>();
          const enrichmentPatches: typeof message.patches = [];
          const addPatchToBatch = (patch: (typeof message.patches)[number]) => {
            if (getPatchKind(patch) === "enrichment") {
              enrichmentPatches.push(patch);
              return;
            }

            const meta = patch.op === "setHTML" ? patch.patchMeta : patch.meta;
            const streamSeq = meta?.streamSeq;
            const parseEpoch = meta?.parseEpoch;
            const tx = meta?.tx;
            const key =
              typeof streamSeq === "number" && Number.isFinite(streamSeq) && streamSeq >= 0 &&
              typeof parseEpoch === "number" && Number.isFinite(parseEpoch) && parseEpoch >= 0 &&
              typeof tx === "number" && Number.isFinite(tx) && tx >= 0
                ? `${streamSeq}/${parseEpoch}/${tx}`
                : undefined;
            let group = key === undefined ? undefined : semanticGroupsByTuple.get(key);
            if (!group) {
              const previous = semanticGroups[semanticGroups.length - 1];
              if (key === undefined && previous && previous.key === undefined) {
                group = previous;
              } else {
                group = { ...(key === undefined ? {} : { key }), patches: [] };
                semanticGroups.push(group);
                if (key !== undefined) semanticGroupsByTuple.set(key, group);
              }
            }
            group.patches.push(patch);
          };
          for (const patch of message.patches) {
            if (patch.op === "setPropsBatch") {
              for (const entry of patch.entries ?? []) {
                if (!entry || !entry.at) continue;
                addPatchToBatch({
                  op: "setProps",
                  at: entry.at,
                  props: entry.props,
                  meta: { ...(patch.meta ?? {}), ...(entry.meta ?? {}) },
                });
              }
            } else {
              addPatchToBatch(patch);
            }
          }
          const batches = [
            ...semanticGroups.map((group) => group.patches),
            ...splitPatchBatch(enrichmentPatches),
          ];
          batches.forEach((batch, index) => {
            const hasSemantic = batch.some((patch) => getPatchKind(patch) === "semantic");
            if (hasSemantic) this.semanticAwaitingFlush = true;
            const priority: "high" | "low" = hasSemantic ? "high" : batch.some(isHeavyPatch) ? "low" : "high";
            this.patchScheduler.enqueue({
              patches: batch,
              meta: {
                tx: message.tx,
                generation: message.generation,
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
        this.semanticAwaitingFlush = false;
        this.resetSourceAdmission();
        this.workerSchemaReady = false;
        this.workerAdmissionGeneration = null;
        break;

      case "ERROR": {
        const initialization = this.initializationQueue?.acknowledgements.get(event);
        const finalization = this.initializationQueue?.finalizationAcknowledgements.get(event);
        if (initialization && (initialization.owner !== this || initialization !== this.currentInitialization)) break;
        if (finalization && finalization.owner !== this) break;
        this.lastWorkerError = message;
        if (message.phase === "INIT") {
          this.workerSchemaReady = false;
          const error = new Error(message.error.message);
          error.name = message.error.name ?? "WorkerInitializationError";
          this.settleInitialization(error);
          if (this.managedInitializationPending) this.reportManagedInitializationError(error);
        }
        if (message.phase === "FINALIZE" && finalization === this.pendingFinalization) {
          this.rejectPendingFinalization(new Error(message.error.message));
        }
        if (
          message.phase === "APPEND" ||
          (message.phase === "INIT" && message.meta?.theme === undefined && typeof message.meta?.rule !== "string")
        ) {
          if (message.phase === "INIT") {
            this.pendingStreamCommands = [];
            this.currentInitialization = null;
          }
          this.failSourceAdmission(message.error.message);
        }
        if (message.phase === "FINALIZE" && finalization === this.pendingFinalization) {
          this.rejectPendingFinalization(new Error(message.error.message));
        }
        if (
          message.phase === "APPEND" ||
          (message.phase === "INIT" && message.meta?.theme === undefined && typeof message.meta?.rule !== "string")
        ) {
          if (message.phase === "INIT") {
            this.pendingStreamCommands = [];
            this.currentInitialization = null;
          }
          this.failSourceAdmission(message.error.message);
        }
        console.error("V2 Markdown worker reported an error", {
          phase: message.phase,
          blockId: message.blockId,
          error: message.error,
          meta: message.meta,
        });
        break;
      }

      case "DEBUG_STATE":
        // Debug-only worker payloads; ignore in the renderer.
        break;

      case "FINALIZED": {
        const finalization = this.initializationQueue?.finalizationAcknowledgements.get(event);
        if (!finalization || finalization.owner !== this) break;
        if (finalization !== this.pendingFinalization || finalization.session !== this.admissionSession) break;
        const expectedGeneration = finalization.workerGeneration ?? finalization.initialization?.workerGeneration;
        if (expectedGeneration !== undefined && message.generation !== expectedGeneration) {
          this.rejectPendingFinalization(new StreamSessionError("stale-generation", "FINALIZED acknowledgment belongs to a different worker generation"));
          break;
        }
        const committedSourceUnits = message.admittedSourceUnits - finalization.workerAdmissionBaselineSourceUnits;
        if (
          !Number.isSafeInteger(message.admittedSourceUnits) ||
          message.admittedSourceUnits < finalization.workerAdmissionBaselineSourceUnits ||
          committedSourceUnits !== finalization.acceptedSourceUnits
        ) {
          this.rejectPendingFinalization(new Error("FINALIZED acknowledgment did not cover every accepted source unit"));
          break;
        }
        finalization.acknowledgement = message;
        if (
          this.trustedRevisionFeed &&
          finalization.revisionToken &&
          this.trustedRevisionFeed.isCurrent(finalization.revisionToken)
        ) {
          this.trustedFinalizedGeneration = finalization.revisionToken.generation;
          this.trustedFinalizedVersion = finalization.revisionToken.version;
          this.tryPublishTrustedRevision(finalization.revisionToken);
        }
        this.tryCompleteFinalization();
        break;
      }

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

  restart(options: { reinitializeWorker?: boolean } = {}): void {
    const reinitializesWorker = options.reinitializeWorker !== false && this.workerHasContent && !this.skipWorkerInit;
    this.resetFinalizationSession(new StreamSessionError("stale-generation", "Finalization belongs to an ended generation"));
    if (!reinitializesWorker) this.resetSourceAdmission({ preserveWorkerFrontier: true });
    this.inputSealed = false;
    this.trustedRevisionFeed?.reset();
    this.trustedFinalizedGeneration = null;
    this.trustedFinalizedVersion = null;
    this.semanticAwaitingFlush = false;
    this.patchScheduler.restart();
    this.componentRegistry.resetAnimationTimeline();
    // An initialized worker without content keeps its generation and empty input baseline, which the store
    // already mirrors. Resetting would drop that baseline and every later source-range patch with it.
    if (!this.workerSchemaReady || this.workerHasContent) this.store.reset([]);
    // A source session can restart before its attachment receives the initial ACK.
    // Keep that empty initialization so its matching ACK can release the session.
    const preservePendingEmptyInitialization = !this.workerSchemaReady
      && !this.workerHasContent
      && this.currentInitialization?.owner === this;
    this.pendingStreamCommands = [];
    if (!preservePendingEmptyInitialization) this.currentInitialization = null;
    if (this.updateCallbacks.length > 0) {
      this.notifyUpdateCallbacks();
    }
    if (options.reinitializeWorker !== false && this.workerHasContent) {
      if (!this.skipWorkerInit) this.initializeWorker();
      this.workerHasContent = false;
    }
  }

  finalize(): Promise<FinalizeResult> {
    if (this.finalizationPromise) return this.finalizationPromise;
    this.inputSealed = true;
    this.settleCapacityWaiters();

    const initialization = this.workerSchemaReady ? null : this.currentInitialization;
    const failure = this.admissionFailure ??
      (!this.worker
        ? new StreamSessionError("disposed", "Worker not attached")
        : !this.workerSchemaReady && initialization?.owner !== this
          ? new StreamSessionError("stale-generation", "No matching worker initialization owns this source session")
          : null);
    if (failure) {
      this.finalizationPromise = Promise.reject(failure);
      return this.finalizationPromise;
    }

    let resolveFinalization!: (result: FinalizeResult) => void;
    let rejectFinalization!: (error: Error) => void;
    const promise = new Promise<FinalizeResult>((resolve, reject) => {
      resolveFinalization = resolve;
      rejectFinalization = reject;
    });
    this.finalizationPromise = promise;
    const finalization: OwnedFinalization = {
      owner: this,
      session: this.admissionSession,
      initialization,
      workerGeneration: this.workerAdmissionGeneration ?? initialization?.workerGeneration,
      acceptedSourceUnits: this.acceptedSourceUnits,
      workerAdmissionBaselineSourceUnits: this.workerAdmissionBaselineSourceUnits,
      revisionToken: this.trustedRevisionFeed?.requestFinalization(),
      dispatched: false,
      resolve: resolveFinalization,
      reject: rejectFinalization,
    };
    this.pendingFinalization = finalization;
    const queue = this.initializationQueue;
    if (!queue) {
      this.rejectPendingFinalization(new StreamSessionError("disposed", "Worker finalization ownership is unavailable"));
      return promise;
    }
    queue.pendingFinalizations.push(finalization);
    try {
      if (this.workerSchemaReady) {
        this.worker!.postMessage({ type: "FINALIZE" } as WorkerIn);
        finalization.dispatched = true;
      } else {
        this.pendingStreamCommands.push({ type: "FINALIZE" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failSourceAdmission(message);
    }
    return promise;
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
  private handlePatchFlush(result: PatchFlushResult, hasNonInputSourcePatch: boolean): void {
    if (!result) return;
    this.semanticAwaitingFlush = result.remainingSemanticQueueSize > 0;
    if (this.trustedRevisionFeed) {
      if (
        this.trustedFinalizedGeneration !== null &&
        this.trustedFinalizedVersion !== null &&
        !this.semanticAwaitingFlush
      ) {
        this.tryPublishTrustedRevision({
          generation: this.trustedFinalizedGeneration,
          version: this.trustedFinalizedVersion,
        });
      }
    }
    this.tryCompleteFinalization();
    if (result.batches.length === 0) return;

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
      if (touchedIds.size > 0 || hasNonInputSourcePatch) {
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
  private tryPublishTrustedRevision(token: { readonly generation: number; readonly version: number }): void {
    const feed = this.trustedRevisionFeed;
    if (
      !feed ||
      this.trustedFinalizedGeneration !== token.generation ||
      this.trustedFinalizedVersion !== token.version ||
      this.semanticAwaitingFlush ||
      !feed.isCurrent(token)
    ) {
      return;
    }
    feed.complete(token, this.store.getBlocks());
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


  return {
    renderer,
    blocks,
    append,
    renderStatic,
    setBlockComponents,
    setInlineComponents,
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
