const DEFAULT_WORKER_PATH = "/workers/markdown-worker.js";

const BLOB_REGISTRY = new WeakMap<Worker, string>();

export type DefaultWorkerMode = "auto" | "hosted" | "blob";

export interface CreateDefaultWorkerOptions {
  /**
   * Selects how the helper instantiates the worker.
   * - `auto` (default) tries to use inline source when available, then falls back to hosted URL.
   * - `hosted` always instantiates from the provided URL.
   * - `blob` requires `inlineSource` (or an inline `<script data-markdown-v2-worker-source>` element) and never touches the hosted URL.
   */
  mode?: DefaultWorkerMode;
  /**
   * Hosted worker URL. Defaults to `/workers/markdown-worker.js` or whatever is declared via
   * `<script data-markdown-v2-worker-url="...">`.
   */
  url?: string | URL;
  /**
   * Inline worker source (module string) used when `mode` is `blob` or `auto`.
   */
  inlineSource?: string;
  /**
   * Override the worker name (shows up in devtools).
   */
  name?: string;
  /**
   * Credentials to use when instantiating a hosted worker.
   */
  credentials?: WorkerOptions["credentials"];
}

export function createDefaultWorker(options: CreateDefaultWorkerOptions = {}): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return null;
  }

  const mode = options.mode ?? "auto";
  const workerName = options.name ?? "markdown-v2";
  const workerOptions: WorkerOptions = {
    type: "module",
    name: workerName,
    credentials: options.credentials ?? "same-origin",
  };

  const inlineSource = resolveInlineSource(options.inlineSource);

  if ((mode === "auto" || mode === "blob") && inlineSource) {
    const blobWorker = instantiateBlobWorker(inlineSource, workerOptions);
    if (blobWorker) {
      return blobWorker;
    }
    if (mode === "blob") {
      return null;
    }
  } else if (mode === "blob") {
    console.warn("[markdown-v2] Blob worker requested but no inline source was provided.");
    return null;
  }

  const hostedUrl = resolveHostedUrl(options.url);
  try {
    return new Worker(hostedUrl, workerOptions);
  } catch (error) {
    console.error("[markdown-v2] Unable to instantiate hosted worker:", error);
    return null;
  }
}

export function releaseDefaultWorker(worker: Worker | null | undefined): void {
  if (!worker) return;
  const blobUrl = BLOB_REGISTRY.get(worker);
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    BLOB_REGISTRY.delete(worker);
  }
}

function instantiateBlobWorker(source: string, workerOptions: WorkerOptions): Worker | null {
  try {
    const blob = new Blob([source], { type: "text/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl, workerOptions);
    BLOB_REGISTRY.set(worker, blobUrl);
    return worker;
  } catch (error) {
    console.warn("[markdown-v2] Failed to instantiate blob worker:", error);
    return null;
  }
}

function resolveHostedUrl(explicit?: string | URL): string | URL {
  if (explicit) {
    return explicit;
  }
  if (typeof document !== "undefined") {
    const script = document.querySelector<HTMLScriptElement>('script[data-markdown-v2-worker-url]');
    if (script?.dataset?.markdownV2WorkerUrl) {
      return script.dataset.markdownV2WorkerUrl;
    }
    const meta = document.querySelector<HTMLMetaElement>('meta[name="markdown-v2:worker"]');
    if (meta?.content) {
      return meta.content;
    }
  }
  return DEFAULT_WORKER_PATH;
}

function resolveInlineSource(explicit?: string): string | undefined {
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit;
  }
  if (typeof document === "undefined") {
    return undefined;
  }
  const script = document.querySelector<HTMLScriptElement>('script[data-markdown-v2-worker-source]');
  const text = script?.textContent;
  return text && text.trim().length > 0 ? text : undefined;
}
