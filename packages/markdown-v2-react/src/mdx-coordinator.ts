"use client";

import type { Block } from "@stream-mdx/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMDXClient, registerInlineMdxModule } from "./mdx-client";
import type { RendererStore } from "./renderer/store";

/**
 * Lightweight client coordinator for MDX blocks.
 * - Watches finalized MDX blocks
 * - Compiles them via server endpoint
 * - Returns a derived blocks array with `compiledMdxRef` populated
 */
interface MdxWorkerClientLike {
  setMdxCompiled(blockId: string, compiledId: string): void;
  setMdxError(blockId: string, message: string): void;
}

interface MdxCoordinatorOptions {
  workerClient?: MdxWorkerClientLike;
  store?: RendererStore;
  mode?: "server" | "worker";
}

export function useMdxCoordinator(blocks: ReadonlyArray<Block>, compileEndpoint?: string, options?: MdxCoordinatorOptions): ReadonlyArray<Block> {
  const mdxClientRef = useRef(getMDXClient(compileEndpoint));
  const mode: "server" | "worker" = options?.mode ?? "server";

  // Map block.id -> compiled id
  const [compiledMap, setCompiledMap] = useState<Map<string, string>>(new Map());
  const blockSignatureRef = useRef<Map<string, string>>(new Map());

  const applyCompiledRef = useCallback(
    (block: Block, compiledId: string) => {
      if (mode === "worker") {
        return;
      }
      if (options?.workerClient) {
        options.workerClient.setMdxCompiled(block.id, compiledId);
        return;
      }
      const store = options?.store;
      if (!store) {
        // Fallback: rely on local state
        return;
      }
      const currentBlocks = store.getBlocks();
      const index = currentBlocks.findIndex((candidate) => candidate.id === block.id);
      if (index === -1) return;
      const current = currentBlocks[index];
      if (current.payload.compiledMdxRef?.id === compiledId) {
        return;
      }
      store.applyPatches([
        {
          op: "setProps",
          at: { blockId: block.id, nodeId: block.id },
          props: {
            block: {
              ...current,
              payload: {
                ...current.payload,
                compiledMdxRef: { id: compiledId },
                meta: {
                  ...(current.payload.meta ?? {}),
                  mdxStatus: "compiled",
                },
              },
            },
          },
        },
      ]);
    },
    [options?.workerClient, options?.store, mode],
  );

  useEffect(() => {
    if (mode === "worker") {
      return;
    }
    // Find compile targets: finalized MDX blocks without compiled ref yet
    const targets = blocks.filter((b) => b.type === "mdx" && b.isFinalized && !b.payload.compiledMdxRef && !compiledMap.has(b.id));
    if (targets.length === 0) return;

    let cancelled = false;
    (async () => {
      for (const block of targets) {
        try {
          const compiled = await mdxClientRef.current.compile(block);
          if (cancelled) return;
          registerInlineMdxModule({
            id: compiled.id,
            code: compiled.code,
            dependencies: compiled.dependencies,
          });
          setCompiledMap((prev) => {
            if (prev.has(block.id)) return prev;
            const next = new Map(prev);
            next.set(block.id, compiled.id);
            return next;
          });
          applyCompiledRef(block, compiled.id);
        } catch (e) {
          // Compilation failure: leave as-is; could log or set a sentinel id
          // eslint-disable-next-line no-console
          console.warn("MDX compile failed for block", block.id, e);
          if (options?.workerClient) {
            options.workerClient.setMdxError(block.id, e instanceof Error ? e.message : String(e));
          } else if (options?.store) {
            options.store.applyPatches([
              {
                op: "setProps",
                at: { blockId: block.id, nodeId: block.id },
                props: {
                  block: {
                    ...block,
                    payload: {
                      ...block.payload,
                      meta: { ...(block.payload.meta ?? {}), mdxStatus: "error", mdxError: e instanceof Error ? e.message : String(e) },
                    },
                  },
                },
              },
            ]);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [blocks, compiledMap, applyCompiledRef, options?.workerClient, options?.store, mode]);

  useEffect(() => {
    if (mode === "worker") {
      return;
    }
    const blockMap = new Map(blocks.map((block) => [block.id, block]));

    setCompiledMap((prev) => {
      let mutated = false;
      const next = new Map(prev);

      for (const [blockId] of prev) {
        const candidate = blockMap.get(blockId);
        if (!candidate || candidate.type !== "mdx") {
          next.delete(blockId);
          mutated = true;
          continue;
        }
        const previousSignature = blockSignatureRef.current.get(blockId);
        const currentSignature = candidate.payload.raw ?? "";
        if (previousSignature !== undefined && previousSignature !== currentSignature) {
          next.delete(blockId);
          mutated = true;
        }
      }

      return mutated ? next : prev;
    });

    const signatureMap = new Map<string, string>();
    for (const block of blocks) {
      if (block.type === "mdx") {
        signatureMap.set(block.id, block.payload.raw ?? "");
      }
    }
    blockSignatureRef.current = signatureMap;
  }, [blocks, mode]);

  // Produce derived blocks with compiled refs filled in
  const derivedBlocks = useMemo(() => {
    if (mode === "worker") {
      return blocks;
    }
    if (options?.workerClient) {
      return blocks;
    }
    if (compiledMap.size === 0) return blocks;
    let changed = false;
    const out: Block[] = blocks.map((b) => {
      if (b.type === "mdx" && !b.payload.compiledMdxRef) {
        const id = compiledMap.get(b.id);
        if (id) {
          changed = true;
          return {
            ...b,
            payload: {
              ...b.payload,
              compiledMdxRef: { id },
            },
          };
        }
      }
      return b;
    });
    return changed ? out : blocks;
  }, [blocks, compiledMap, mode, options?.workerClient]);

  if (options?.workerClient) {
    return blocks;
  }

  return derivedBlocks;
}
