import {
  PATCH_ROOT_ID,
  applyPatchBatch,
  createInitialSnapshot,
  type Block,
  type DocumentSnapshot,
  type TocHeading,
  type WorkerIn,
  type WorkerOut,
} from "@stream-mdx/core";

type WorkerInitMessage = Extract<WorkerIn, { type: "INIT" }>;

export interface SnapshotArtifactV1 {
  version: 1;
  schemaId: "streammdx.snapshot.v1";
  createdAt: string;
  hash: string;
  contentHash: string;
  configHash: string;
  hashSalt?: string;
  blocks: Block[];
  tocHeadings?: TocHeading[];
  init?: {
    docPlugins?: WorkerInitMessage["docPlugins"];
    mdx?: WorkerInitMessage["mdx"];
    prewarmLangs?: string[];
  };
}

export interface CompileMarkdownSnapshotDirectOptions {
  text: string;
  init?: Omit<WorkerInitMessage, "type" | "initialContent">;
  hashSalt?: string;
  cache?: {
    dir: string;
    key?: string;
    readOnly?: boolean;
  };
  timeoutMs?: number;
  settleMs?: number;
  finalize?: boolean;
}

export interface CompileMarkdownSnapshotDirectResult {
  blocks: Block[];
  snapshot: DocumentSnapshot;
  artifact: SnapshotArtifactV1;
  fromCache: boolean;
}

type InlineWorkerScope = {
  onmessage?: ((event: MessageEvent<WorkerIn>) => void | Promise<void>) | null;
};

type NodeFsLike = {
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<void>;
  writeFile(filePath: string, data: string, encoding: "utf8"): Promise<void>;
};

type NodePathLike = {
  join(...segments: string[]): string;
  dirname(filePath: string): string;
};

type NodeCacheRuntime = {
  fs: NodeFsLike;
  path: NodePathLike;
};

const globalBridge = globalThis as {
  self?: InlineWorkerScope;
  postMessage?: (message: WorkerOut) => void;
};

let runtimePromise: Promise<InlineWorkerScope> | null = null;
let nodeCacheRuntimePromise: Promise<NodeCacheRuntime | null> | null = null;
let activeQueue: WorkerOut[] | null = null;
let compileChain: Promise<void> = Promise.resolve();
let originalPostMessage: ((message: WorkerOut) => void) | undefined;

function withCompileLock<T>(fn: () => Promise<T>): Promise<T> {
  let resolveChain!: () => void;
  const next = new Promise<void>((resolve) => {
    resolveChain = resolve;
  });
  const previous = compileChain;
  compileChain = next;

  return previous
    .catch(() => undefined)
    .then(async () => {
      try {
        return await fn();
      } finally {
        resolveChain();
      }
    });
}

async function ensureWorkerRuntimeLoaded(): Promise<InlineWorkerScope> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const scope = (globalBridge.self ?? {}) as InlineWorkerScope;
    globalBridge.self = scope;

    if (!originalPostMessage && typeof globalBridge.postMessage === "function") {
      originalPostMessage = globalBridge.postMessage.bind(globalBridge);
    }
    globalBridge.postMessage = (message: WorkerOut) => {
      if (activeQueue) {
        activeQueue.push(message);
        return;
      }
      if (originalPostMessage) {
        try {
          originalPostMessage(message);
        } catch {
          // ignore passthrough errors
        }
      }
    };

    await import("./worker");
    if (typeof scope.onmessage !== "function") {
      throw new Error("[stream-mdx] direct compile runtime failed to initialize worker onmessage.");
    }
    return scope;
  })();
  return runtimePromise;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}

async function dispatchWorkerMessage(
  scope: InlineWorkerScope,
  message: WorkerIn,
  timeoutMs: number,
): Promise<WorkerOut[]> {
  const queue: WorkerOut[] = [];
  activeQueue = queue;
  try {
    const task = scope.onmessage ? scope.onmessage({ data: message } as MessageEvent<WorkerIn>) : undefined;
    const awaited = isPromiseLike(task) ? task.then(() => undefined) : Promise.resolve();
    await withTimeout(awaited, timeoutMs, `[stream-mdx] direct compile timed out during ${message.type}`);
    await waitForQueueSettle(queue);
    return queue;
  } finally {
    activeQueue = null;
  }
}

async function waitForQueueSettle(queue: WorkerOut[], maxWaitMs = 64): Promise<void> {
  const start = Date.now();
  let lastLength = queue.length;
  let idleTicks = 0;
  while (Date.now() - start < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (queue.length === lastLength) {
      idleTicks += 1;
    } else {
      lastLength = queue.length;
      idleTicks = 0;
    }
    if (idleTicks >= 2) return;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await promise;
  }
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function firstWorkerError(messages: WorkerOut[]): string | null {
  const errorMessage = messages.find((message): message is Extract<WorkerOut, { type: "ERROR" }> => message.type === "ERROR");
  if (!errorMessage) return null;
  return `Worker error (${errorMessage.phase}): ${errorMessage.error.message}`;
}

function extractPatches(messages: WorkerOut[]): Extract<WorkerOut, { type: "PATCH" }>[] {
  return messages.filter((message): message is Extract<WorkerOut, { type: "PATCH" }> => message.type === "PATCH");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const primitive = JSON.stringify(value);
    return primitive === undefined ? "null" : primitive;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const body = entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",");
  return `{${body}}`;
}

function fallbackHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function sha256Hex(input: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return fallbackHash(input);
    const bytes = new TextEncoder().encode(input);
    const digest = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return fallbackHash(input);
  }
}

async function buildHashes(text: string, init: Omit<WorkerInitMessage, "type" | "initialContent"> | undefined, hashSalt: string | undefined) {
  const hashPayload = stableStringify({
    text,
    init: init ?? null,
    salt: hashSalt ?? null,
  });
  const configPayload = stableStringify({
    init: init ?? null,
    salt: hashSalt ?? null,
  });
  const [hash, contentHash, configHash] = await Promise.all([
    sha256Hex(hashPayload),
    sha256Hex(text),
    sha256Hex(configPayload),
  ]);
  return { hash, contentHash, configHash };
}

async function getNodeCacheRuntime(): Promise<NodeCacheRuntime | null> {
  if (nodeCacheRuntimePromise) return nodeCacheRuntimePromise;
  nodeCacheRuntimePromise = (async () => {
    try {
      const dynamicImport = new Function("specifier", "return import(specifier);") as (
        specifier: string,
      ) => Promise<unknown>;
      const fsModule = (await dynamicImport("node:fs/promises")) as NodeFsLike;
      const pathModule = await dynamicImport("node:path");
      const pathApi = ((pathModule as { default?: unknown }).default ?? pathModule) as NodePathLike;
      return {
        fs: fsModule,
        path: pathApi,
      };
    } catch {
      return null;
    }
  })();
  return nodeCacheRuntimePromise;
}

async function resolveCachePath(cache: CompileMarkdownSnapshotDirectOptions["cache"], cacheKey: string): Promise<string | null> {
  if (!cache) return null;
  const runtime = await getNodeCacheRuntime();
  if (!runtime) return null;
  return runtime.path.join(cache.dir, `${sanitizeCacheKey(cacheKey)}.json`);
}

async function readSnapshotCache(cachePath: string, hash: string): Promise<SnapshotArtifactV1 | null> {
  const runtime = await getNodeCacheRuntime();
  if (!runtime) return null;
  try {
    const raw = await runtime.fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as SnapshotArtifactV1;
    if (!parsed || parsed.version !== 1 || parsed.hash !== hash || !Array.isArray(parsed.blocks)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeSnapshotCache(cachePath: string, artifact: SnapshotArtifactV1): Promise<void> {
  const runtime = await getNodeCacheRuntime();
  if (!runtime) return;
  try {
    await runtime.fs.mkdir(runtime.path.dirname(cachePath), { recursive: true });
    await runtime.fs.writeFile(cachePath, JSON.stringify(artifact, null, 2), "utf8");
  } catch {
    // ignore cache write failures
  }
}

function sanitizeCacheKey(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

/**
 * Compiles markdown in-process without spawning `worker_threads`.
 *
 * This runtime is useful when a platform cannot host workers (for example edge
 * functions that disallow `worker_threads`) but still needs deterministic
 * `Block[]` snapshots from the canonical worker pipeline.
 */
export async function compileMarkdownSnapshotDirect(
  options: CompileMarkdownSnapshotDirectOptions,
): Promise<CompileMarkdownSnapshotDirectResult> {
  return await withCompileLock(async () => {
    const { text, init, hashSalt, cache, timeoutMs = 30_000, settleMs = 50, finalize = true } = options;
    const { hash, contentHash, configHash } = await buildHashes(text, init, hashSalt);
    const cacheKey = cache?.key ?? hash;
    const cachePath = await resolveCachePath(cache, cacheKey);
    if (cachePath) {
      const cached = await readSnapshotCache(cachePath, hash);
      if (cached) {
        const snapshot = createInitialSnapshot(cached.blocks);
        return {
          blocks: snapshot.blocks,
          snapshot,
          artifact: cached,
          fromCache: true,
        };
      }
    }
    const scope = await ensureWorkerRuntimeLoaded();

    const initMessages = await dispatchWorkerMessage(
      scope,
      {
        type: "INIT",
        initialContent: text,
        prewarmLangs: init?.prewarmLangs,
        docPlugins: init?.docPlugins,
        mdx: init?.mdx,
      },
      timeoutMs,
    );
    const initError = firstWorkerError(initMessages);
    if (initError) {
      throw new Error(initError);
    }

    const initialized = initMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
    if (!initialized) {
      throw new Error("[stream-mdx] direct compile failed: worker did not emit INITIALIZED.");
    }

    const snapshot = createInitialSnapshot(initialized.blocks);
    for (const patch of extractPatches(initMessages)) {
      snapshot.blocks = applyPatchBatch(snapshot, patch.patches);
    }

    if (finalize) {
      const finalizeMessages = await dispatchWorkerMessage(scope, { type: "FINALIZE" }, timeoutMs);
      const finalizeError = firstWorkerError(finalizeMessages);
      if (finalizeError) {
        throw new Error(finalizeError);
      }
      for (const patch of extractPatches(finalizeMessages)) {
        snapshot.blocks = applyPatchBatch(snapshot, patch.patches);
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }

    const artifact: SnapshotArtifactV1 = {
      version: 1,
      schemaId: "streammdx.snapshot.v1",
      createdAt: new Date().toISOString(),
      hash,
      contentHash,
      configHash,
      hashSalt: hashSalt ?? undefined,
      blocks: snapshot.blocks,
      tocHeadings: (() => {
        const root = snapshot.nodes.get(PATCH_ROOT_ID);
        const maybe = root?.props?.tocHeadings;
        return Array.isArray(maybe) ? (maybe as TocHeading[]) : undefined;
      })(),
      init: init
        ? {
            docPlugins: init.docPlugins,
            mdx: init.mdx,
            prewarmLangs: init.prewarmLangs,
          }
        : undefined,
    };

    if (cachePath && !cache?.readOnly) {
      await writeSnapshotCache(cachePath, artifact);
    }

    return {
      blocks: snapshot.blocks,
      snapshot,
      artifact,
      fromCache: false,
    };
  });
}
