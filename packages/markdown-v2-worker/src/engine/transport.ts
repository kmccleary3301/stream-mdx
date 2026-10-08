import type { WorkerIn, WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "./engine";
import type {
  InlineEngineWorkerOptions,
  ServeMarkdownWorkerOptions,
} from "./types";

interface WorkerGlobalScopeLike {
  postMessage: (message: WorkerOut) => void;
  onmessage?: ((event: MessageEvent<WorkerIn>) => void | Promise<void>) | null;
  addEventListener?: (type: string, listener: (event: MessageEvent<WorkerIn>) => void) => void;
  removeEventListener?: (type: string, listener: (event: MessageEvent<WorkerIn>) => void) => void;
}

export function serveMarkdownWorker(options?: ServeMarkdownWorkerOptions): MarkdownEngine {
  let scopeCandidate: unknown = options?.scope;
  if (!scopeCandidate) {
    if (typeof self !== "undefined") {
      scopeCandidate = self;
    } else if (typeof globalThis !== "undefined") {
      scopeCandidate = globalThis;
    }
  }

  if (!scopeCandidate || typeof scopeCandidate !== "object") {
    throw new Error("[stream-mdx] No global worker scope available for serveMarkdownWorker");
  }

  const scope = scopeCandidate as WorkerGlobalScopeLike;

  const post = (message: WorkerOut) => {
    if (typeof scope.postMessage === "function") {
      scope.postMessage(message);
    } else if (typeof postMessage === "function") {
      postMessage(message);
    } else {
      throw new Error("[stream-mdx] No postMessage function found in worker scope");
    }
  };

  const engine = new MarkdownEngine({
    post,
    extensions: options?.extensions,
  });

  scope.onmessage = (event: MessageEvent<WorkerIn>) => {
    const data = event ? event.data : undefined;
    if (data) {
      return engine.handle(data);
    }
  };

  return engine;
}

function clonePayload<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function createInlineEngineWorker(options?: InlineEngineWorkerOptions): Worker {
  let terminated = false;
  const messageListeners = new Set<(event: MessageEvent<WorkerOut>) => void>();
  const errorListeners = new Set<(event: ErrorEvent) => void>();
  let onmessageHandler: ((event: MessageEvent<WorkerOut>) => void) | null = null;
  let onerrorHandler: ((event: ErrorEvent) => void) | null = null;

  const engine = new MarkdownEngine({
    post: (message: WorkerOut) => {
      if (terminated) return;
      const cloned = clonePayload(message);
      queueMicrotask(() => {
        if (terminated) return;
        let event: MessageEvent<WorkerOut>;
        try {
          event = new MessageEvent("message", { data: cloned });
        } catch {
          event = { type: "message", data: cloned } as unknown as MessageEvent<WorkerOut>;
        }

        if (onmessageHandler) {
          try {
            onmessageHandler(event);
          } catch (error) {
            console.error("[stream-mdx:inline-worker] onmessage handler threw:", error);
          }
        }

        for (const listener of messageListeners) {
          try {
            listener(event);
          } catch (error) {
            console.error("[stream-mdx:inline-worker] message listener threw:", error);
          }
        }
      });
    },
    extensions: options?.extensions,
  });

  const worker: unknown = {
    postMessage(msg: unknown): void {
      if (terminated) return;
      const cloned = clonePayload(msg as WorkerIn);
      queueMicrotask(async () => {
        if (terminated) return;
        try {
          await engine.handle(cloned);
        } catch (error) {
          if (terminated) return;
          let errorEvent: ErrorEvent;
          try {
            errorEvent = new ErrorEvent("error", {
              error,
              message: error instanceof Error ? error.message : String(error),
            });
          } catch {
            errorEvent = {
              type: "error",
              error,
              message: error instanceof Error ? error.message : String(error),
            } as unknown as ErrorEvent;
          }

          if (onerrorHandler) {
            onerrorHandler(errorEvent);
          }
          for (const listener of errorListeners) {
            listener(errorEvent);
          }
        }
      });
    },

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (typeof listener !== "function") return;
      if (type === "message") {
        messageListeners.add(listener as (event: MessageEvent<WorkerOut>) => void);
      } else if (type === "error") {
        errorListeners.add(listener as (event: ErrorEvent) => void);
      }
    },

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (typeof listener !== "function") return;
      if (type === "message") {
        messageListeners.delete(listener as (event: MessageEvent<WorkerOut>) => void);
      } else if (type === "error") {
        errorListeners.delete(listener as (event: ErrorEvent) => void);
      }
    },

    get onmessage() {
      return onmessageHandler;
    },
    set onmessage(fn: ((event: MessageEvent<WorkerOut>) => void) | null) {
      onmessageHandler = fn;
    },

    get onerror() {
      return onerrorHandler;
    },
    set onerror(fn: ((event: ErrorEvent) => void) | null) {
      onerrorHandler = fn;
    },

    terminate(): void {
      if (terminated) return;
      terminated = true;
      messageListeners.clear();
      errorListeners.clear();
      onmessageHandler = null;
      onerrorHandler = null;
      engine.dispose();
    },

    dispatchEvent(_event: Event): boolean {
      return true;
    },
  };

  return worker as Worker;
}
