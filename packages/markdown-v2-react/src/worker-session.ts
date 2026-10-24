import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { createDefaultWorker, releaseDefaultWorker } from "@stream-mdx/worker";
import type { MarkdownRenderer } from "./renderer";
import type { MarkdownEngineMode, StreamingMarkdownProps } from "./streaming-markdown";
import type { CodeEngine } from "@stream-mdx/worker/engine";

type WorkerSource = StreamingMarkdownProps["worker"];

export class EngineCompatibilityError extends Error {
  constructor(message?: string) {
    super(message ?? 'Unable to create a worker for automatic bootstrap takeover; pass engine="main" when workers are unavailable.');
    this.name = "EngineCompatibilityError";
  }
}

export interface WorkerLease {
  worker: Worker;
  dispose(): void;
}

export function createWorkerLease(worker: Worker, owned: boolean, release?: () => void): WorkerLease {
  let disposed = false;
  return {
    worker,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!owned) return;
      try {
        worker.terminate();
      } catch (error) {
        console.warn("Unable to terminate markdown worker", error);
      } finally {
        release?.();
      }
    },
  };
}

export interface WorkerFactories {
  available(): boolean;
  fromUrl(url: string | URL): Worker;
  defaultWorker(): Worker | null;
  releaseDefault(worker: Worker): void;
  inline(codeEngine?: CodeEngine): Promise<Worker>;
}

const workerFactories: WorkerFactories = {
  available: () => typeof window !== "undefined" && typeof Worker !== "undefined",
  fromUrl: (url) => new Worker(url, { type: "module", name: "markdown-v2" }),
  defaultWorker: createDefaultWorker,
  releaseDefault: releaseDefaultWorker,
  async inline(codeEngine) {
    // Static import would pull the inline engine into worker-only browser bundles.
    const { createInlineEngineWorker } = await import("@stream-mdx/worker/engine");
    return createInlineEngineWorker(codeEngine ? { extensions: { code: codeEngine } } : undefined);
  },
};

function instantiateWorker(source: WorkerSource, factories: WorkerFactories): WorkerLease | null {
  if (!factories.available()) return null;
  if (source && typeof source === "object" && !(source instanceof URL)) {
    return createWorkerLease(source, false);
  }
  if (typeof source === "function") {
    try {
      return createWorkerLease(source(), true);
    } catch (error) {
      console.warn("StreamingMarkdown: worker factory failed", error);
      return null;
    }
  }
  const fromUrl = (url: string | URL) => {
    try {
      return createWorkerLease(factories.fromUrl(url), true);
    } catch (error) {
      console.warn("StreamingMarkdown: unable to instantiate worker", error);
      return null;
    }
  };
  if (source instanceof URL || typeof source === "string") return fromUrl(source);
  const worker = factories.defaultWorker();
  return worker
    ? createWorkerLease(worker, true, () => factories.releaseDefault(worker))
    : fromUrl("/workers/markdown-worker.js");
}

export function resolveWorkerSetup(
  engine: MarkdownEngineMode,
  source: WorkerSource,
  cancelled: () => boolean,
  factories: WorkerFactories = workerFactories,
  managedWorker = false,
  codeEngine?: CodeEngine,
): WorkerLease | null | Promise<WorkerLease | null> {
  if (managedWorker && (engine === "main" || !source || source instanceof URL || typeof source === "string")) {
    throw new Error("managedWorker requires a caller-initialized Worker instance or worker factory and cannot use engine='main', a worker URL, or the default worker");
  }
  if (codeEngine && engine !== "main") {
    throw new EngineCompatibilityError('The main-realm CodeEngine requires engine="main".');
  }
  let lease: WorkerLease | null = null;
  const inlineBootstrap = engine === "auto" && !managedWorker;
  if (engine !== "main" && !inlineBootstrap) {
    if (engine === "worker" && !factories.available()) {
      throw new Error("Worker is not supported in this environment");
    }
    // Only managed auto reaches this path; unmanaged auto uses the inline bootstrap below and managed auto cannot fall back.
    lease = instantiateWorker(source, factories);
    if (!lease && (engine === "worker" || managedWorker)) {
      throw new Error(managedWorker
        ? "managedWorker requires an available caller-initialized worker; inline fallback is not supported"
        : "Failed to create markdown worker instance");
    }
  }
  if (lease) {
    if (cancelled()) {
      lease.dispose();
      return null;
    }
    return lease;
  }
  if (cancelled()) return null;
  // Only loading the inline engine is asynchronous. Available workers stay synchronous.
  return factories.inline(codeEngine).then((worker) => {
    const inlineLease = createWorkerLease(worker, true);
    if (cancelled()) {
      inlineLease.dispose();
      return null;
    }
    return inlineLease;
  });
}

export function useWorkerSession({
  renderer, workerSource, engine, session, managedWorker, codeEngine, onErrorRef, debug, factories = workerFactories,
}: {
  renderer: MarkdownRenderer;
  workerSource: WorkerSource;
  engine: MarkdownEngineMode;
  session: number;
  managedWorker: boolean;
  codeEngine?: CodeEngine;
  onErrorRef: MutableRefObject<StreamingMarkdownProps["onError"]>;
  debug: boolean;
  factories?: WorkerFactories;
}) {
  const [workerReady, setWorkerReady] = useState(false);
  const [inputReady, setInputReady] = useState(false);
  /**
   * Counts attach-time initializations. A restart can clear and restore `inputReady` within one render batch,
   * so input consumers depend on this counter to observe every completed initialization.
   */
  const [initializationEpoch, setInitializationEpoch] = useState(0);
  const inputReadyRef = useRef(false);
  const [initializationError, setInitializationError] = useState<Error | null>(null);
  const workerReadyRef = useRef(false);
  const readyRendererRef = useRef<MarkdownRenderer | null>(null);
  const activeInstanceRef = useRef<{
    lease: WorkerLease;
    source: WorkerSource;
    engine: MarkdownEngineMode;
    session: number;
    managedWorker: boolean;
    codeEngine?: CodeEngine;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (process.env.NODE_ENV !== "production" && debug) console.info("[debug] instantiate worker effect");
    setWorkerReady(false);
    workerReadyRef.current = false;
    setInputReady(false);
    inputReadyRef.current = false;
    setInitializationError(null);

    const reportError = (error: unknown) => {
      if (cancelled) return;
      const reported = error instanceof Error ? error : new Error(String(error));
      inputReadyRef.current = false;
      setInputReady(false);
      setInitializationError(reported);
      onErrorRef.current?.(reported);
    };
    let takeoverLease: WorkerLease | null = null;
    let takeoverRequest: object | null = null;
    let removeBootstrapTakeover: (() => void) | null = null;
    const failTakeover = (lease: WorkerLease | null, request: object, cause: unknown) => {
      if (lease && takeoverLease !== lease) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (lease) {
        if (takeoverRequest !== request) return;
        takeoverLease = null;
        takeoverRequest = null;
        lease.dispose();
      }
      if (!renderer.failBootstrapTakeover(error, request)) return;
      reportError(error);
    };
    const startBootstrapTakeover = (request: object) => {
      if (cancelled || readyRendererRef.current !== renderer) return;
      if (takeoverLease) {
        if (takeoverRequest === request) return;
        takeoverLease.dispose();
        takeoverLease = null;
        takeoverRequest = null;
      }
      const lease = instantiateWorker(workerSource, factories);
      if (!lease) {
        failTakeover(null, request, new EngineCompatibilityError());
        return;
      }
      takeoverLease = lease;
      takeoverRequest = request;
      const bootstrapLease = activeInstanceRef.current?.lease;
      void renderer.waitForBootstrapProjection().then(() => {
        if (
          cancelled ||
          readyRendererRef.current !== renderer ||
          takeoverLease !== lease ||
          takeoverRequest !== request
        ) {
          if (takeoverLease === lease && takeoverRequest === request) {
            takeoverLease = null;
            takeoverRequest = null;
          }
          lease.dispose();
          return;
        }
        renderer.attachWorker(lease.worker, {
          takeoverSource: renderer.getBootstrapSourceForTakeover(),
          onTakeoverCommitted: () => {
            if (
              cancelled ||
              readyRendererRef.current !== renderer ||
              takeoverLease !== lease ||
              takeoverRequest !== request
            ) {
              if (takeoverLease === lease && takeoverRequest === request) {
                takeoverLease = null;
                takeoverRequest = null;
              }
              lease.dispose();
              return;
            }
            activeInstanceRef.current = { lease, source: workerSource, engine, session, managedWorker, codeEngine };
            takeoverLease = null;
            takeoverRequest = null;
            if (bootstrapLease !== lease) bootstrapLease?.dispose();
          },
          onInitializationError: (error) => failTakeover(lease, request, error),
        });
      }).catch((error: unknown) => failTakeover(lease, request, error));
    };
    const attach = (lease: WorkerLease) => {
      renderer.detachWorker();
      readyRendererRef.current = renderer;
      renderer.attachWorker(lease.worker, {
        skipInit: managedWorker,
        bootstrap: engine === "auto" && !managedWorker,
        onInitialized: () => {
          if (cancelled || readyRendererRef.current !== renderer) return;
          inputReadyRef.current = true;
          setInitializationError(null);
          setInputReady(true);
          setInitializationEpoch((epoch) => epoch + 1);
        },
        onInitializationError: (error) => {
          if (!cancelled) reportError(error);
        },
      });
      workerReadyRef.current = true;
      setWorkerReady(true);
      if (engine === "auto" && !managedWorker) {
        removeBootstrapTakeover = renderer.setBootstrapTakeoverHandler(startBootstrapTakeover);
      }
    };
    const existing = activeInstanceRef.current;
    if (existing && existing.source === workerSource && existing.engine === engine && existing.managedWorker === managedWorker && existing.codeEngine === codeEngine && (managedWorker || existing.session === session)) {
      attach(existing.lease);
    } else {
      existing?.lease.dispose();
      activeInstanceRef.current = null;
      const setup = (lease: WorkerLease | null) => {
        if (!lease) return;
        if (cancelled) {
          lease.dispose();
          return;
        }
        activeInstanceRef.current = { lease, source: workerSource, engine, session, managedWorker, codeEngine };
        attach(lease);
      };
      try {
        const resolved = resolveWorkerSetup(engine, workerSource, () => cancelled, factories, managedWorker, codeEngine);
        if (resolved instanceof Promise) {
          void resolved.then(setup).catch(reportError);
        } else {
          setup(resolved);
        }
      } catch (error) {
        reportError(error);
      }
    }
    return () => {
      cancelled = true;
      setWorkerReady(false);
      workerReadyRef.current = false;
      setInputReady(false);
      inputReadyRef.current = false;
      removeBootstrapTakeover?.();
      if (takeoverLease) {
        takeoverLease.dispose();
        takeoverLease = null;
        takeoverRequest = null;
      }
      if (readyRendererRef.current === renderer) readyRendererRef.current = null;
      renderer.detachWorker();
    };
  }, [renderer, workerSource, engine, session, managedWorker, codeEngine, debug, onErrorRef, factories]);

  useEffect(() => () => {
    activeInstanceRef.current?.lease.dispose();
    activeInstanceRef.current = null;
  }, []);

  return { workerReady, workerReadyRef, inputReady, inputReadyRef, initializationEpoch, initializationError, readyRendererRef };
}
