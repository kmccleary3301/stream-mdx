import type { CompiledMdxModule } from "@stream-mdx/core";

import { loadMdxRuntime } from "./mdx-runtime";
import {
  markMdxPrefetchCancelled,
  markMdxPrefetchComplete,
  markMdxPrefetchError,
  markMdxPrefetchStart,
} from "./mdx-hydration-metrics";

export type MdxPrefetchRequest = {
  id: string;
  compiledModule?: CompiledMdxModule | null;
};

export type MdxPrefetchQueueOptions = {
  concurrency?: number;
  idleTimeoutMs?: number;
};

const DEFAULT_PREFETCH_CONCURRENCY = 2;
const DEFAULT_PREFETCH_IDLE_TIMEOUT = 120;

export class MdxPrefetchQueue {
  private queue: MdxPrefetchRequest[] = [];
  private queued = new Set<string>();
  private inflight = new Map<string, AbortController>();
  private active = 0;
  private scheduled = false;
  private idleId: number | ReturnType<typeof setTimeout> | null = null;
  private options: MdxPrefetchQueueOptions;

  constructor(options?: MdxPrefetchQueueOptions) {
    this.options = options ?? {};
  }

  enqueue(request: MdxPrefetchRequest): void {
    if (!request.id) return;
    if (this.inflight.has(request.id) || this.queued.has(request.id)) {
      return;
    }
    this.queue.push(request);
    this.queued.add(request.id);
    this.schedule();
  }

  cancel(id: string): void {
    if (!id) return;
    if (this.queued.delete(id)) {
      this.queue = this.queue.filter((entry) => entry.id !== id);
    }
    const controller = this.inflight.get(id);
    if (controller) {
      controller.abort();
      this.inflight.delete(id);
    }
    markMdxPrefetchCancelled(id);
  }

  cancelAll(): void {
    for (const id of this.queued) {
      markMdxPrefetchCancelled(id);
    }
    this.queue = [];
    this.queued.clear();
    for (const [id, controller] of this.inflight.entries()) {
      controller.abort();
      this.inflight.delete(id);
      markMdxPrefetchCancelled(id);
    }
    this.active = 0;
    this.clearIdle();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      void this.drain();
    };
    const idleTimeoutMs = this.options.idleTimeoutMs ?? DEFAULT_PREFETCH_IDLE_TIMEOUT;
    const globalRef = globalThis as typeof globalThis & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
    };
    if (typeof globalRef.requestIdleCallback === "function") {
      this.idleId = globalRef.requestIdleCallback(run, { timeout: idleTimeoutMs });
    } else {
      this.idleId = globalRef.setTimeout(run, idleTimeoutMs);
    }
  }

  private clearIdle(): void {
    if (this.idleId === null) return;
    const idleId = this.idleId;
    const globalRef = globalThis as typeof globalThis & {
      cancelIdleCallback?: (id: number) => void;
      clearTimeout: typeof clearTimeout;
    };
    if (typeof globalRef.cancelIdleCallback === "function") {
      if (typeof idleId === "number") {
        globalRef.cancelIdleCallback(idleId);
      }
    } else {
      globalRef.clearTimeout(idleId as ReturnType<typeof setTimeout>);
    }
    this.idleId = null;
  }

  private async drain(): Promise<void> {
    const concurrency = this.options.concurrency ?? DEFAULT_PREFETCH_CONCURRENCY;
    while (this.active < concurrency && this.queue.length > 0) {
      const request = this.queue.shift();
      if (!request) break;
      this.queued.delete(request.id);
      const controller = new AbortController();
      this.inflight.set(request.id, controller);
      this.active += 1;
      void this.runRequest(request, controller).finally(() => {
        this.inflight.delete(request.id);
        this.active = Math.max(0, this.active - 1);
        if (this.queue.length > 0) {
          this.schedule();
        }
      });
    }
  }

  private async runRequest(request: MdxPrefetchRequest, controller: AbortController): Promise<void> {
    try {
      await prefetchMdxBundle({ id: request.id, compiledModule: request.compiledModule, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      console.warn("[mdx-prefetch] bundle prefetch failed", { id: request.id, error });
    }
  }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: string }).name === "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const abortError = typeof DOMException === "function" ? new DOMException("Aborted", "AbortError") : new Error("Aborted");
    throw abortError;
  }
}

export async function prefetchMdxBundle(request: MdxPrefetchRequest & { signal?: AbortSignal }): Promise<void> {
  if (!request.id) return;
  throwIfAborted(request.signal);
  markMdxPrefetchStart(request.id);
  try {
    const runtime = await loadMdxRuntime();
    throwIfAborted(request.signal);
    if (request.compiledModule?.code) {
      runtime.registerInlineMdxModule({
        id: request.compiledModule.id,
        code: request.compiledModule.code,
        dependencies: request.compiledModule.dependencies ?? [],
      });
      markMdxPrefetchComplete(request.id);
      return;
    }
    const client = runtime.getMDXClient();
    const compiled = await client.getCompiled({ id: request.id }, { signal: request.signal });
    runtime.registerInlineMdxModule({
      id: compiled.id,
      code: compiled.code,
      dependencies: compiled.dependencies ?? [],
    });
    markMdxPrefetchComplete(request.id);
  } catch (error) {
    if (isAbortError(error, request.signal)) {
      markMdxPrefetchCancelled(request.id);
      return;
    }
    markMdxPrefetchError(request.id);
    throw error;
  }
}
