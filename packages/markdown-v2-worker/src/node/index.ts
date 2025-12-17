import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";

export interface CreateWorkerThreadOptions extends Omit<WorkerOptions, "type" | "workerData"> {
  /**
   * Override the worker bundle module that should be executed inside the thread.
   *
   * Defaults to the hosted worker shipped with `@stream-mdx/worker` at
   * `dist/hosted/markdown-worker.js`.
   */
  workerBundle?: string | URL;
  /**
   * Extra data passed to the thread. This will be merged with the internal
   * `bundleUrl` field used by the bootstrap.
   */
  workerData?: Record<string, unknown>;
}

/**
 * Returns the file URL for the hosted worker bundle shipped with `@stream-mdx/worker`.
 */
export function getHostedWorkerBundleUrl(): URL {
  return new URL("../hosted/markdown-worker.js", getModuleUrl());
}

/**
 * Creates a Node `worker_threads` Worker running the StreamMDX hosted worker bundle.
 *
 * The thread bootstrap installs WebWorker-like shims (`self`, `postMessage`, `onmessage`)
 * so the same hosted bundle used in browsers can run under Node.
 */
export function createWorkerThread(options: CreateWorkerThreadOptions = {}): Worker {
  const { workerBundle, workerData, ...workerOptions } = options;
  const runnerUrl = new URL("./worker-thread-entry.mjs", getModuleUrl());
  const bundleUrl = normalizeWorkerBundleUrl(workerBundle) ?? getHostedWorkerBundleUrl();

  return new Worker(runnerUrl, {
    ...workerOptions,
    workerData: {
      ...(workerData ?? {}),
      bundleUrl: bundleUrl.href,
    },
  });
}

function normalizeWorkerBundleUrl(value: string | URL | undefined): URL | undefined {
  if (!value) return undefined;
  if (value instanceof URL) return value;
  try {
    return new URL(value);
  } catch {
    return pathToFileURL(path.resolve(value));
  }
}

function getModuleUrl(): string {
  if (typeof __filename === "string" && __filename.length > 0) {
    return pathToFileURL(__filename).href;
  }
  return import.meta.url;
}
