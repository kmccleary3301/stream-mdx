// V2 Worker Client for Markdown Renderer
// Similar interface to the V1 streaming worker client

import type { WorkerIn, WorkerOut } from "@stream-mdx/core";
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

  constructor(options: MarkdownWorkerClientOptions = {}) {
    let owned = false;
    if (typeof window !== "undefined" && typeof Worker !== "undefined") {
      try {
        const worker = this.createWorkerInstance(options);
        if (worker) {
          owned = !options.worker;
          this.worker = worker;
          this.messageListener = (ev: MessageEvent<WorkerOut>) => {
            for (const listener of this.listeners) {
              listener(ev.data);
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
    docPlugins?: { footnotes?: boolean; html?: boolean; mdx?: boolean; tables?: boolean; callouts?: boolean; math?: boolean },
    mdxOptions?: { compileMode?: "server" | "worker" },
  ) {
    this.post({
      type: "INIT",
      initialContent,
      prewarmLangs,
      docPlugins,
      mdx: mdxOptions,
    } as WorkerIn);
  }

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

  setMdxCompiled(blockId: string, compiledId: string) {
    this.post({ type: "MDX_COMPILED", blockId, compiledId } as WorkerIn);
  }

  setMdxError(blockId: string, error?: string) {
    this.post({ type: "MDX_ERROR", blockId, error } as WorkerIn);
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
    if (this.worker) {
      this.worker.postMessage(msg);
    } else {
      console.warn("V2 Markdown Worker not available");
    }
  }
}
