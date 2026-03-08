import path from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  typeof bootstrap.bundleUrl === "string" && bootstrap.bundleUrl.length > 0 ? bootstrap.bundleUrl : resolveDefaultBundleUrl().href;

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
  const fromImportMeta = getImportMetaUrl();
  if (fromImportMeta) {
    return fromImportMeta;
  }
  if (typeof __filename === "string" && __filename.length > 0) {
    return pathToFileURL(__filename).href;
  }
  const fromStack = getModuleUrlFromStack();
  if (fromStack) {
    return fromStack;
  }
  throw new Error("[stream-mdx] Unable to resolve worker-thread module URL.");
}

function getImportMetaUrl(): string | undefined {
  try {
    const candidate = (0, eval)("import.meta.url");
    return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function resolveDefaultBundleUrl(): URL {
  const packageRoot = resolvePackageRootFromRequire();
  if (packageRoot) {
    const resolved = firstExistingPath([
      path.join(packageRoot, "dist/hosted/markdown-worker.js"),
      path.join(packageRoot, "dist/worker.mjs"),
      path.join(packageRoot, "dist/worker.js"),
      path.join(packageRoot, "src/worker.ts"),
    ]);
    if (resolved) {
      return pathToFileURL(resolved);
    }
  }

  const moduleUrl = getModuleUrl();
  const candidates = [
    new URL("../hosted/markdown-worker.js", moduleUrl),
    new URL("../../dist/hosted/markdown-worker.js", moduleUrl),
    new URL("../../../public/workers/markdown-worker.js", moduleUrl),
    new URL("../../../../public/workers/markdown-worker.js", moduleUrl),
    new URL("../../dist/worker.mjs", moduleUrl),
    new URL("../../dist/worker.js", moduleUrl),
    new URL("../worker.mjs", moduleUrl),
    new URL("../worker.js", moduleUrl),
    new URL("../worker.ts", moduleUrl),
  ];
  for (const candidate of candidates) {
    if (urlExists(candidate)) return candidate;
  }
  return candidates[0];
}

function urlExists(url: URL): boolean {
  if (url.protocol !== "file:") return false;
  try {
    return existsSync(path.normalize(fileURLToPath(url)));
  } catch {
    return false;
  }
}

function firstExistingPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore and continue
    }
  }
  return undefined;
}

function resolvePackageRootFromRequire(): string | undefined {
  const bases = [
    path.join(process.cwd(), "package.json"),
    typeof __filename === "string" && __filename.length > 0
      ? __filename
      : path.join(process.cwd(), "__stream-mdx-worker-thread-resolver__.cjs"),
  ];
  for (const base of bases) {
    try {
      const req = createRequire(base);
      const nodeEntry = req.resolve("@stream-mdx/worker/node");
      return path.resolve(path.dirname(nodeEntry), "..", "..");
    } catch {
      // keep trying fallbacks
    }
  }
  return undefined;
}

function getModuleUrlFromStack(): string | undefined {
  const previous = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_error, stackTrace) => stackTrace;
    const stackTrace = new Error().stack as unknown as NodeJS.CallSite[] | undefined;
    if (!Array.isArray(stackTrace)) return undefined;
    const files = stackTrace
      .map((frame) => frame.getFileName())
      .filter((fileName): fileName is string => Boolean(fileName));

    const preferred = files.find(
      (fileName) =>
        fileName.includes("/markdown-v2-worker/src/node/worker-thread-entry.") ||
        fileName.includes("/markdown-v2-worker/dist/node/worker-thread-entry.") ||
        fileName.includes("\\markdown-v2-worker\\src\\node\\worker-thread-entry.") ||
        fileName.includes("\\markdown-v2-worker\\dist\\node\\worker-thread-entry."),
    );
    if (preferred) {
      return preferred.startsWith("file://") ? preferred : pathToFileURL(preferred).href;
    }

    const firstAbsolute = files.find((fileName) => fileName.startsWith("file://") || path.isAbsolute(fileName));
    if (!firstAbsolute) return undefined;
    return firstAbsolute.startsWith("file://") ? firstAbsolute : pathToFileURL(firstAbsolute).href;
  } catch {
    return undefined;
  } finally {
    Error.prepareStackTrace = previous;
  }
}
