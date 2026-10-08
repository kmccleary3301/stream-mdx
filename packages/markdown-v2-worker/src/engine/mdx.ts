import type { Block, CompiledMdxModule } from "@stream-mdx/core";
import { cloneBlock } from "@stream-mdx/core";
import { compileMdxContent } from "../mdx-compile";
import type { MdxStatusUpdate, WorkerMdxMode } from "./types";

export const MAX_WORKER_MDX_CACHE_ENTRIES = 128;

export interface EngineMdxState {
  cache: Map<string, CompiledMdxModule>;
  inflight: Map<string, Promise<CompiledMdxModule>>;
  compileMode: WorkerMdxMode;
  debugMdx: boolean;
}

export function cacheWorkerMdxModule(state: EngineMdxState, key: string, module: CompiledMdxModule): void {
  const stored: CompiledMdxModule = {
    ...module,
    dependencies: module.dependencies ? [...module.dependencies] : undefined,
  };
  if (!state.cache.has(key) && state.cache.size >= MAX_WORKER_MDX_CACHE_ENTRIES) {
    const oldest = state.cache.keys().next().value;
    if (typeof oldest === "string") {
      state.cache.delete(oldest);
    }
  }
  state.cache.set(key, stored);
}

export async function getOrCompileMdxModuleForBlock(state: EngineMdxState, block: Block): Promise<CompiledMdxModule> {
  const cacheKey = block.id;
  const cached = state.cache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      dependencies: cached.dependencies ? [...cached.dependencies] : undefined,
    };
  }

  const inflight = state.inflight.get(cacheKey);
  if (inflight) {
    const result = await inflight;
    return {
      ...result,
      dependencies: result.dependencies ? [...result.dependencies] : undefined,
    };
  }

  const source = block.payload.raw ?? "";
  const compilePromise = (async () => {
    const { code, dependencies } = await compileMdxContent(source);
    const module: CompiledMdxModule = {
      id: `worker:${cacheKey}`,
      code,
      dependencies,
      source: "worker",
    };
    cacheWorkerMdxModule(state, cacheKey, module);
    return module;
  })();

  state.inflight.set(cacheKey, compilePromise);
  try {
    const compiled = await compilePromise;
    return {
      ...compiled,
      dependencies: compiled.dependencies ? [...compiled.dependencies] : undefined,
    };
  } finally {
    state.inflight.delete(cacheKey);
  }
}

export async function updateMdxCompilationState(state: EngineMdxState, block: Block): Promise<void> {
  if (block.type !== "mdx") {
    if ("compiledMdxModule" in block.payload) {
      block.payload.compiledMdxModule = undefined;
    }
    return;
  }

  if (state.compileMode !== "worker") {
    if ("compiledMdxModule" in block.payload) {
      block.payload.compiledMdxModule = undefined;
    }
    return;
  }

  const baseMeta = (block.payload.meta ?? {}) as Record<string, unknown>;
  const pendingMeta: Record<string, unknown> = { ...baseMeta, mdxStatus: "pending" };
  if ("mdxError" in pendingMeta) {
    pendingMeta.mdxError = undefined;
  }
  block.payload.meta = pendingMeta;

  if (!block.isFinalized) {
    block.payload.compiledMdxModule = null;
    block.payload.compiledMdxRef = { id: "pending" };
    return;
  }

  try {
    const module = await getOrCompileMdxModuleForBlock(state, block);
    block.payload.compiledMdxModule = {
      ...module,
      dependencies: module.dependencies ? [...module.dependencies] : undefined,
    };
    block.payload.compiledMdxRef = { id: module.id };
    const nextMeta = {
      ...(block.payload.meta ?? {}),
      mdxStatus: "compiled",
    } as Record<string, unknown>;
    if ("mdxError" in nextMeta) {
      nextMeta.mdxError = undefined;
    }
    block.payload.meta = nextMeta;
  } catch (error) {
    const message = error instanceof Error ? error.message : "MDX compilation failed";
    block.payload.compiledMdxModule = null;
    block.payload.compiledMdxRef = undefined;
    const errorMeta = {
      ...(block.payload.meta ?? {}),
      mdxStatus: "error",
      mdxError: message,
    } as Record<string, unknown>;
    block.payload.meta = errorMeta;
  }
}

export function preserveMdxMetadata(previous: Block, next: Block): void {
  const prevRaw = previous.payload.raw ?? "";
  const nextRaw = next.payload.raw ?? "";
  if (prevRaw !== nextRaw) {
    return;
  }

  if (previous.payload.compiledMdxRef && !next.payload.compiledMdxRef) {
    next.payload.compiledMdxRef = { ...previous.payload.compiledMdxRef };
  }
  if (previous.payload.compiledMdxModule && !next.payload.compiledMdxModule) {
    next.payload.compiledMdxModule = {
      ...previous.payload.compiledMdxModule,
      dependencies: previous.payload.compiledMdxModule.dependencies ? [...previous.payload.compiledMdxModule.dependencies] : undefined,
    };
  } else if (previous.payload.compiledMdxModule === null && typeof next.payload.compiledMdxModule === "undefined") {
    next.payload.compiledMdxModule = null;
  }

  const prevMeta = (previous.payload.meta ?? null) as {
    mdxStatus?: unknown;
    mdxError?: unknown;
  } | null;
  if (!prevMeta) {
    return;
  }

  const currentMeta = (next.payload.meta ?? undefined) as { mdxStatus?: unknown; mdxError?: unknown } | undefined;
  const mergedMeta: Record<string, unknown> = currentMeta ? { ...currentMeta } : {};
  let metaChanged = false;

  if (typeof prevMeta.mdxStatus === "string" && mergedMeta.mdxStatus === undefined) {
    mergedMeta.mdxStatus = prevMeta.mdxStatus;
    metaChanged = true;
  }

  if (typeof prevMeta.mdxError === "string" && mergedMeta.mdxError === undefined) {
    mergedMeta.mdxError = prevMeta.mdxError;
    metaChanged = true;
  }

  if (metaChanged || !currentMeta) {
    next.payload.meta = mergedMeta;
  }
}

export function applyMdxStatusUpdate(
  blocks: Block[],
  blockId: string,
  update: MdxStatusUpdate,
): { updatedBlock: Block | null; blockIndex: number } {
  const index = blocks.findIndex((b) => b.id === blockId);
  if (index === -1) return { updatedBlock: null, blockIndex: -1 };

  const previous = blocks[index];
  if (typeof update.rawSignature === "string" && (previous.payload.raw ?? "") !== update.rawSignature) {
    return { updatedBlock: null, blockIndex: index };
  }
  const updated = cloneBlock(previous);
  updated.payload = {
    ...updated.payload,
    compiledMdxRef: update.status === "error" ? undefined : (update.compiledRef ?? updated.payload.compiledMdxRef),
    compiledMdxModule: update.status === "error" ? undefined : updated.payload.compiledMdxModule,
    meta: {
      ...(updated.payload.meta ?? {}),
      mdxStatus: update.status,
      ...(update.error ? { mdxError: update.error } : {}),
    },
  };

  blocks[index] = updated;
  return { updatedBlock: updated, blockIndex: index };
}
