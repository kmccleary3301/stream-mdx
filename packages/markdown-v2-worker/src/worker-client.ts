// V2 Worker Client for Markdown Renderer
// Similar interface to the V1 streaming worker client

import type { CodeHighlightOutputMode, CodeHighlightingMode, ContentPolicy, FormatAnticipationConfig, RestrictedComponentDescriptor, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import { createDefaultWorker, releaseDefaultWorker, type CreateDefaultWorkerOptions } from "./create-default-worker";

export interface MarkdownWorkerClientOptions {
  worker?: Worker | (() => Worker);
  workerUrl?: string | URL;
  name?: string;
  defaultWorker?: CreateDefaultWorkerOptions;
}

export class MarkdownWorkerClient {
  private worker?: Worker;
  private readonly ownsWorker: boolean;
  private listeners = new Set<(msg: WorkerOut) => void>();
  private messageListener?: (event: MessageEvent<WorkerOut>) => void;
  private errorListener?: (event: ErrorEvent) => void;
  private messageErrorListener?: (event: MessageEvent<unknown>) => void;
  private cleanupCallbacks: Array<() => void> = [];
  private initialized = false;
  private initializationError?: Error;

  constructor(options: MarkdownWorkerClientOptions = {}) {
    let owned = false;
    if (typeof window !== "undefined" && typeof Worker !== "undefined") {
      try {
        const worker = this.createWorkerInstance(options);
        if (worker) {
          owned = !options.worker;
          this.worker = worker;
          this.messageListener = (ev: MessageEvent<WorkerOut>) => {
            let message = ev.data;
            if (message.type === "INITIALIZED") {
              if (
                message.schemaVersion !== STREAM_MDX_SCHEMA_VERSION ||
                !Number.isSafeInteger(message.generation) ||
                message.generation < 0 ||
                message.snapshot.inputSource?.generation !== message.generation ||
                typeof message.snapshot.inputSource?.raw !== "string"
              ) {
              const error = new Error(
                message.schemaVersion !== STREAM_MDX_SCHEMA_VERSION
                  ? `Incompatible worker schema: expected ${STREAM_MDX_SCHEMA_VERSION}, received ${message.schemaVersion}`
                  : "Incompatible worker initialization: canonical input baseline is missing or invalid",
              );
              error.name = "WorkerSchemaMismatch";
              this.initializationError = error;
              this.initialized = false;
              message = { type: "ERROR", phase: "INIT", error: { name: error.name, message: error.message } };
            } else {
              this.initialized = true;
              this.initializationError = undefined;
            }
            } else if ((message.type === "PATCH" || message.type === "FINALIZED") && !this.initialized) {
              return;
            }
            for (const listener of this.listeners) {
              listener(message);
            }
          };
          this.errorListener = (error: Event) => {
            if (error instanceof ErrorEvent) {
              const stack = error.error && typeof error.error === "object" ? (error.error as Error).stack : undefined;
              console.error("V2 Markdown Worker error:", error.message, "at", error.filename, `${error.lineno}:${error.colno}`, stack ?? "<no-stack>");
            } else {
              console.error("V2 Markdown Worker error:", error);
            }
          };
          this.messageErrorListener = (event: MessageEvent<unknown>) => {
            console.error("V2 Markdown Worker message error:", event.data);
          };
          this.worker.addEventListener("message", this.messageListener);
          this.worker.addEventListener("error", this.errorListener);
          this.worker.addEventListener("messageerror", this.messageErrorListener);
        }
      } catch (error) {
        console.warn("Failed to create V2 Markdown Worker:", error);
      }
    }
    this.ownsWorker = owned;
  }

  private createWorkerInstance(options: MarkdownWorkerClientOptions): Worker | undefined {
    const { worker, workerUrl, name, defaultWorker } = options;
    try {
      if (worker) {
        return typeof worker === "function" ? worker() : worker;
      }
      const auto = createDefaultWorker({
        ...defaultWorker,
        url: workerUrl ?? defaultWorker?.url,
        name: name ?? defaultWorker?.name,
      });
      if (auto) {
        this.cleanupCallbacks.push(() => releaseDefaultWorker(auto));
        return auto;
      }
      const script = workerUrl ?? "/workers/markdown-worker.js";
      return new Worker(script instanceof URL ? script : script, { type: "module", name: name ?? "markdown-v2" });
    } catch (error) {
      console.warn("Unable to instantiate markdown worker:", error);
      return undefined;
    }
  }

  onMessage(cb: (msg: WorkerOut) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  init(
    initialContent?: string,
    prewarmLangs?: string[],
    docPlugins?: {
      footnotes?: boolean;
      html?: boolean;
      mdx?: boolean;
      tables?: boolean;
      callouts?: boolean;
      math?: boolean;
      formatAnticipation?: FormatAnticipationConfig;
      codeHighlighting?: CodeHighlightingMode;
      outputMode?: CodeHighlightOutputMode;
      liveCodeHighlighting?: boolean;
      liveTokenization?: boolean;
      emitHighlightTokens?: boolean;
      emitDiffBlocks?: boolean;
      lazyTokenization?: {
        enabled?: boolean;
        thresholdLines?: number;
      };
    },
    contentPolicy?: ContentPolicy,
    contentComponents?: readonly RestrictedComponentDescriptor[],
  ) {
    this.post({
      type: "INIT",
      schemaVersion: STREAM_MDX_SCHEMA_VERSION,
      initialContent,
      prewarmLangs,
      docPlugins,
      ...(contentPolicy ? { contentPolicy } : {}),
      ...(contentComponents ? { contentComponents } : {}),
    } as WorkerIn);
  }

  /** Post source only after the matching INITIALIZED acknowledgement; rejection accepts no units. */
  append(text: string) {
    this.post({ type: "APPEND", text });
  }

  finalize() {
    this.post({ type: "FINALIZE" } as WorkerIn);
  }

  setCredits(credits: number) {
    const value = Math.max(0, Math.min(1, credits));
    this.post({ type: "SET_CREDITS", credits: value } as WorkerIn);
  }


  terminate(options: { force?: boolean } = {}) {
    if (this.worker) {
      if (this.messageListener) {
        this.worker.removeEventListener("message", this.messageListener);
      }
      if (this.errorListener) {
        this.worker.removeEventListener("error", this.errorListener);
      }
      if (this.messageErrorListener) {
        this.worker.removeEventListener("messageerror", this.messageErrorListener);
      }
      const shouldTerminate = options.force ?? this.ownsWorker;
      if (shouldTerminate && typeof this.worker.terminate === "function") {
        this.worker.terminate();
      }
    }
    this.worker = undefined;
    this.initialized = false;
    this.initializationError = undefined;
    this.messageListener = undefined;
    this.errorListener = undefined;
    this.messageErrorListener = undefined;
    this.listeners.clear();
    if (this.cleanupCallbacks.length > 0) {
      for (const cleanup of this.cleanupCallbacks.splice(0, this.cleanupCallbacks.length)) {
        try {
          cleanup();
        } catch (error) {
          console.warn("Failed to clean up worker resources", error);
        }
      }
    }
  }

  getWorker(): Worker | undefined {
    return this.worker;
  }

  private post(msg: WorkerIn) {
    if (msg.type === "INIT") {
      this.initialized = false;
      this.initializationError = undefined;
    } else if ((msg.type === "APPEND" || msg.type === "FINALIZE") && !this.initialized) {
      throw this.initializationError ?? new Error("Wait for a matching INITIALIZED acknowledgement before posting source or FINALIZE");
    }
    if (this.worker) {
      this.worker.postMessage(msg);
    } else {
      console.warn("V2 Markdown Worker not available");
    }
  }
}
