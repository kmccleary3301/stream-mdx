import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

type BootstrapData = {
  bundleUrl?: string;
};

const port = parentPort;
if (!port) {
  throw new Error("[stream-mdx] worker thread bootstrap missing parentPort.");
}

const globalAny = globalThis as unknown as {
  self?: unknown;
  postMessage?: (value: unknown) => void;
  onmessage?: ((event: { data: unknown }) => void | Promise<void>) | null;
  addEventListener?: (type: string, listener: (event: { data: unknown }) => void) => void;
  removeEventListener?: (type: string, listener: (event: { data: unknown }) => void) => void;
};

if (!globalAny.self) {
  globalAny.self = globalThis;
}

globalAny.postMessage = (value: unknown) => {
  port.postMessage(value);
};

const messageListeners = new Set<(event: { data: unknown }) => void>();
globalAny.addEventListener = (type: string, listener: (event: { data: unknown }) => void) => {
  if (type !== "message") return;
  messageListeners.add(listener);
};
globalAny.removeEventListener = (type: string, listener: (event: { data: unknown }) => void) => {
  if (type !== "message") return;
  messageListeners.delete(listener);
};

let ready = false;
const buffered: unknown[] = [];

function dispatchMessage(data: unknown): void {
  const event = { data };

  const handler = globalAny.onmessage;
  if (typeof handler === "function") {
    try {
      handler(event);
    } catch (error) {
      console.error("[stream-mdx] worker thread onmessage threw:", error);
    }
  }

  if (messageListeners.size > 0) {
    for (const listener of messageListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[stream-mdx] worker thread message listener threw:", error);
      }
    }
  }
}

port.on("message", (data: unknown) => {
  if (!ready) {
    buffered.push(data);
    return;
  }
  dispatchMessage(data);
});

const bootstrap = (workerData ?? {}) as BootstrapData;
const bundleUrl =
  typeof bootstrap.bundleUrl === "string" && bootstrap.bundleUrl.length > 0 ? bootstrap.bundleUrl : new URL("../hosted/markdown-worker.js", getModuleUrl()).href;

void (async () => {
  await import(bundleUrl);
  ready = true;
  if (buffered.length > 0) {
    for (const data of buffered.splice(0, buffered.length)) {
      dispatchMessage(data);
    }
  }
})().catch((error) => {
  console.error("[stream-mdx] Failed to load hosted worker bundle in worker thread:", error);
  throw error;
});

function getModuleUrl(): string {
  if (typeof __filename === "string" && __filename.length > 0) {
    return pathToFileURL(__filename).href;
  }
  return import.meta.url;
}
