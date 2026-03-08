import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";

import { PATCH_ROOT_ID, applyPatchBatch, createInitialSnapshot, type Block, type DocumentSnapshot, type TocHeading, type WorkerIn, type WorkerOut } from "@stream-mdx/core";

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

/**
 * Creates a Node `worker_threads` Worker running the StreamMDX hosted worker bundle.
 *
 * The thread bootstrap installs WebWorker-like shims (`self`, `postMessage`, `onmessage`)
 * so the same hosted bundle used in browsers can run under Node.
 */
export function createWorkerThread(options: CreateWorkerThreadOptions = {}): Worker {
  const { workerBundle, workerData, ...workerOptions } = options;
  const runnerUrl = resolveWorkerThreadEntryUrl();
  const bundleUrl = normalizeWorkerBundleUrl(workerBundle) ?? getHostedWorkerBundleUrl();

  return new Worker(runnerUrl, {
    ...workerOptions,
    workerData: {
      ...(workerData ?? {}),
      bundleUrl: bundleUrl.href,
    },
  });
}

function resolveWorkerThreadEntryUrl(): URL {
  const packageRoot = resolvePackageRootFromRequire();
  if (packageRoot) {
    const resolved = firstExistingPath([
      path.join(packageRoot, "dist/node/worker-thread-entry.mjs"),
      path.join(packageRoot, "dist/node/worker-thread-entry.cjs"),
      path.join(packageRoot, "src/node/worker-thread-entry.ts"),
    ]);
    if (resolved) {
      return pathToFileURL(resolved);
    }
  }

  const moduleUrl = getModuleUrl();
  const distEntry = new URL("./worker-thread-entry.mjs", moduleUrl);
  const sourceEntry = new URL("./worker-thread-entry.ts", moduleUrl);
  if (urlExists(distEntry)) {
    return distEntry;
  }
  if (urlExists(sourceEntry)) {
    return sourceEntry;
  }
  return distEntry;
}

function urlExists(url: URL): boolean {
  if (url.protocol !== "file:") return false;
  try {
    return existsSync(path.normalize(fileURLToPath(url)));
  } catch {
    return false;
  }
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
    typeof __filename === "string" && __filename.length > 0 ? __filename : path.join(process.cwd(), "__stream-mdx-node-resolver__.cjs"),
  ];
  for (const base of bases) {
    try {
      const req = createRequire(base);
      const nodeEntry = req.resolve("@stream-mdx/worker/node");
      // /.../dist/node/index.{cjs,mjs} -> package root is ../..
      return path.resolve(path.dirname(nodeEntry), "..", "..");
    } catch {
      // keep trying fallbacks
    }
  }
  return undefined;
}

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
  throw new Error("[stream-mdx] Unable to resolve module URL.");
}

function getImportMetaUrl(): string | undefined {
  try {
    const candidate = (0, eval)("import.meta.url");
    return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
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
        fileName.includes("/markdown-v2-worker/src/node/index.") ||
        fileName.includes("/markdown-v2-worker/dist/node/index.") ||
        fileName.includes("\\markdown-v2-worker\\src\\node\\index.") ||
        fileName.includes("\\markdown-v2-worker\\dist\\node\\index."),
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

export interface CompileMarkdownSnapshotOptions {
  text: string;
  init?: Omit<WorkerInitMessage, "type" | "initialContent">;
  /**
   * Optional salt mixed into the snapshot hash and cache key.
   *
   * This exists so callers can invalidate on renderer/compiler changes (not just
   * input text + init), while keeping deterministic outputs for a given salt.
   */
  hashSalt?: string;
  worker?: Worker;
  workerOptions?: CreateWorkerThreadOptions;
  timeoutMs?: number;
  settleMs?: number;
  cache?: {
    dir: string;
    key?: string;
    readOnly?: boolean;
  };
  finalize?: boolean;
}

export interface CompileMarkdownSnapshotResult {
  blocks: Block[];
  snapshot: DocumentSnapshot;
  artifact: SnapshotArtifactV1;
  fromCache: boolean;
}

export function computeSnapshotHash(text: string, init?: Omit<WorkerInitMessage, "type" | "initialContent">, hashSalt?: string): string {
  return hashCompileInput(text, init, hashSalt);
}

export async function compileMarkdownSnapshot(options: CompileMarkdownSnapshotOptions): Promise<CompileMarkdownSnapshotResult> {
  const {
    text,
    init,
    hashSalt,
    worker: providedWorker,
    workerOptions,
    timeoutMs = 30_000,
    settleMs = 50,
    cache,
    finalize = true,
  } = options;

  const hash = hashCompileInput(text, init, hashSalt);
  const cacheKey = cache?.key ?? hash;
  const cachePath = cache ? path.join(cache.dir, `${sanitizeCacheKey(cacheKey)}.json`) : null;

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

  const worker = providedWorker ?? createWorkerThread(workerOptions);
  const ownedWorker = !providedWorker;

  return await new Promise<CompileMarkdownSnapshotResult>((resolve, reject) => {
    let snapshot: DocumentSnapshot | null = null;
    let initialized = false;
    let settled = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const finalizeNow = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const finalSnapshot = snapshot ?? createInitialSnapshot();
      const blocks = finalSnapshot.blocks;
      const contentHash = createHash("sha256").update(text).digest("hex");
      const configHash = createHash("sha256")
        .update(
          stableStringify({
            init: init ?? null,
            salt: hashSalt ?? null,
          }),
        )
        .digest("hex");
      const artifact: SnapshotArtifactV1 = {
        version: 1,
        schemaId: "streammdx.snapshot.v1",
        createdAt: new Date().toISOString(),
        hash,
        contentHash,
        configHash,
        hashSalt: hashSalt ?? undefined,
        blocks,
        tocHeadings: (() => {
          const root = finalSnapshot.nodes.get(PATCH_ROOT_ID);
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
        void writeSnapshotCache(cachePath, artifact);
      }

      resolve({
        blocks,
        snapshot: finalSnapshot,
        artifact,
        fromCache: false,
      });
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const scheduleIdleFinalize = () => {
      if (finalize || !initialized) return;
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => finalizeNow(), settleMs);
    };

    const handleMessage = (message: WorkerOut) => {
      switch (message.type) {
        case "INITIALIZED":
          snapshot = createInitialSnapshot(message.blocks);
          initialized = true;
          scheduleIdleFinalize();
          break;
        case "PATCH":
          if (snapshot) {
            snapshot.blocks = applyPatchBatch(snapshot, message.patches);
          }
          scheduleIdleFinalize();
          break;
        case "FINALIZED":
          if (finalize) {
            finalizeNow();
          }
          break;
        case "RESET":
          fail(new Error(`Worker reset during compile: ${message.reason}`));
          break;
        case "ERROR":
          fail(new Error(`Worker error (${message.phase}): ${message.error.message}`));
          break;
        default:
          break;
      }
    };

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      worker.off("message", handleMessage);
      worker.off("error", fail);
      if (ownedWorker) {
        try {
          worker.terminate();
        } catch {
          // ignore terminate errors
        }
      }
    };

    worker.on("message", handleMessage);
    worker.on("error", fail);

    timeoutTimer = setTimeout(() => {
      fail(new Error("Worker compile timed out."));
    }, timeoutMs);

    const initMessage: WorkerInitMessage = {
      type: "INIT",
      initialContent: text,
      prewarmLangs: init?.prewarmLangs,
      docPlugins: init?.docPlugins,
      mdx: init?.mdx,
    };
    worker.postMessage(initMessage);

    if (finalize) {
      worker.postMessage({ type: "FINALIZE" } as WorkerIn);
    }
  });
}

export interface CompileMarkdownSnapshotPoolOptions {
  /**
   * Number of worker_threads to keep warm.
   * Each worker is single-flight (requests are queued per worker).
   */
  size?: number;
  workerOptions?: CreateWorkerThreadOptions;
  /**
   * In-memory cache entries keyed by the snapshot hash.
   * Set to 0 to disable.
   */
  maxMemoryEntries?: number;
}

export interface CompileMarkdownSnapshotPool {
  compile(options: Omit<CompileMarkdownSnapshotOptions, "worker">): Promise<CompileMarkdownSnapshotResult>;
  close(): Promise<void>;
}

export function createCompileMarkdownSnapshotPool(options: CompileMarkdownSnapshotPoolOptions = {}): CompileMarkdownSnapshotPool {
  const size = Math.max(1, Math.min(8, Math.floor(options.size ?? 2)));
  const workers = new Array(size).fill(null).map(() => createWorkerThread(options.workerOptions));
  const queues: Array<Promise<void>> = new Array(size).fill(Promise.resolve());
  let rr = 0;

  const maxMemoryEntries = Math.max(0, Math.floor(options.maxMemoryEntries ?? 64));
  const memory = maxMemoryEntries > 0 ? new Map<string, CompileMarkdownSnapshotResult>() : null;

  const enqueue = <T>(index: number, fn: () => Promise<T>): Promise<T> => {
    let resolveOuter!: (value: T) => void;
    let rejectOuter!: (reason?: unknown) => void;
    const outer = new Promise<T>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });
    queues[index] = queues[index]
      .catch(() => undefined)
      .then(async () => {
        try {
          const value = await fn();
          resolveOuter(value);
        } catch (err) {
          rejectOuter(err);
        }
      })
      .then(() => undefined);
    return outer;
  };

  const compile = async (compileOptions: Omit<CompileMarkdownSnapshotOptions, "worker">) => {
    const hash = computeSnapshotHash(compileOptions.text, compileOptions.init, compileOptions.hashSalt);
    if (memory && memory.has(hash)) {
      return memory.get(hash)!;
    }
    const index = rr++ % workers.length;
    const result = await enqueue(index, async () => {
      return await compileMarkdownSnapshot({
        ...compileOptions,
        worker: workers[index],
      });
    });
    if (memory) {
      memory.set(hash, result);
      if (memory.size > maxMemoryEntries) {
        const firstKey = memory.keys().next().value as string | undefined;
        if (firstKey) memory.delete(firstKey);
      }
    }
    return result;
  };

  const close = async () => {
    for (const worker of workers) {
      try {
        await worker.terminate();
      } catch {
        // ignore
      }
    }
  };

  return { compile, close };
}

async function readSnapshotCache(cachePath: string, hash: string): Promise<SnapshotArtifactV1 | null> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
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
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(artifact, null, 2), "utf8");
  } catch {
    // ignore cache write failures
  }
}

function sanitizeCacheKey(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

function hashCompileInput(text: string, init?: Omit<WorkerInitMessage, "type" | "initialContent">, hashSalt?: string): string {
  const payload = stableStringify({
    text,
    init: init ?? null,
    salt: hashSalt ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
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
