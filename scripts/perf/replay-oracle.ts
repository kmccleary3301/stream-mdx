#!/usr/bin/env tsx

/**
 * P2 Streaming Replay Oracle
 * Verifies the current dense semantic replay and P2 source-aware scaling paths.
 * Runs in-process under Node (>=20).
 *
 * Imports directly from ./diagnostic-dist/index.mjs to execute with __STREAM_MDX_COUNTERS__ = true.
 *
 * Verifies:
 * 1. Committed-prefix equality against cold non-finalizing parse at every actual PATCH publication frontier
 * 2. Final semantic store equality against cold canonical finalize
 * 3. Independent pinned Shiki validation from bounded prepared code-line records
 * 4. Independent CommonMark/GFM syntax expectations, including distinct opening/closing fence indents
 * 5. INITIALIZED root reset, source-owner generation and append/decorate wire invariants
 * 6. Live mounted native root-code append, update, finalize, unmount and disposal behavior (mdx:false)
 * 7. Bounded equal-append N-vs-4N scaling with the actual private counter sink
 *
 * Usage:
 *   npx tsx scripts/perf/replay-oracle.ts
 *   npx tsx scripts/perf/replay-oracle.ts --section engine-fixture --fixture fence-indent-multiline --json /tmp/stream-mdx-p2-engine.json
 *   npx tsx scripts/perf/replay-oracle.ts --section mounted-code --json /tmp/stream-mdx-p2-mounted-code.json
 *   npx tsx scripts/perf/replay-oracle.ts --section code-scaling --json /tmp/stream-mdx-p2-code-scaling.json
 *   node --import tsx scripts/perf/replay-oracle.ts --section table-scaling --json /tmp/stream-mdx-p2-table-scaling.json
 *
 * The aggregate command runs the complete dense replay and every current P2 scaling family.
 * Section selection focuses only the named proof; engine-fixture defaults to the root-code fixture.
 */

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { createHighlighter, type Highlighter } from "shiki";

import type { Block, WorkerOut } from "@stream-mdx/core";
import { cloneBlock } from "@stream-mdx/core";
import type { MarkdownEngineOptions } from "../../packages/markdown-v2-worker/src/engine/types";
import type { RendererStore, RendererStoreOptions } from "../../packages/markdown-v2-react/src/renderer/store";
import {
  MarkdownEngine,
  createRendererStore,
  SessionCounterSink,
} from "./diagnostic-dist/index.mjs";

import { projectFootnotePublication, publishedFootnoteLabels } from "../../packages/markdown-v2-worker/__tests__/footnote-publication";
import { DENSE_FIXTURES, type DenseFixture, generateChunkingPlans } from "./replay-fixtures";
import { runGenerationAndResetInvariants, runLiveReactLayer } from "./lifecycle-invariants";
import { runScalingDiagnostics, type ScalingMeasurement } from "./scaling-diagnostics";
import { verifyCompletedLineTokens } from "./replay-code-parity";

import { verifyRenderedExpectations } from "./replay-semantic-expectations";
import {
  blocksSemanticallyEqual,
  describeBlockSemanticDifference,
  describeProvisionalTailSemanticDifference,
  normalizeSemanticDtoValue,
  provisionalTailBlocksSemanticallyEqual,
  semanticBlockProjection,
  type SemanticBlockComparison,
} from "./semantic-block-comparison";
import { PARITY_INIT, runRootCodeInitializationTrace } from "./replay-code-initialization";
import { capturePriorCodeOwners, verifyCodeWirePatches } from "./replay-code-parity";
import { collectBlocksRecursively, verifyIndependentExpectations } from "./replay-semantic-expectations";
import { recordDivergence, type DivergenceReport } from "./replay-fixtures";


export interface OracleSummary {
  passed: boolean;
  totalFixtures: number;
  passedFixtures: number;
  failedFixtures: number;
  divergenceCount: number;
  divergences: DivergenceReport[];
  scalingMeasurements?: ScalingMeasurement[];
  durationMs: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockSignature(block: Block): string {
  return JSON.stringify(block);
}
interface SemanticStoreNodeSnapshot {
  readonly id: string;
  readonly type: string;
  readonly range: { readonly from: number; readonly to: number } | undefined;
  readonly props: unknown;
  readonly meta: unknown;
  readonly block: SemanticBlockComparison | null;
  readonly children: SemanticStoreNode[];
}
type SemanticStoreNode = SemanticStoreNodeSnapshot | { readonly id: string; readonly missing: true };
interface SemanticStoreForest {
  roots: Array<{ id: string; value: SemanticStoreNode }>;
  missingNodeIds: string[];
  missingCanonicalBlockIds: string[];
}

function captureSemanticStoreForest(
  store: RendererStore,
  blocks: ReadonlyArray<Block>,
  publishedLabels: Set<string>,
): SemanticStoreForest {
  const missingNodeIds: string[] = [];
  const missingCanonicalBlockIds: string[] = [];
  const canonicalBlocks = new Map(
    collectBlocksRecursively(blocks)
      .filter((block) => block.type === "code" || block.type === "table" || block.type === "list")
      .map((block) => [block.id, block] as const),
  );
  const rootIds = new Set(blocks.map((block) => block.id));
  const visit = (id: string): SemanticStoreNode => {
    const node = store.getNode(id);
    if (!node) {
      missingNodeIds.push(id);
      return { id, missing: true };
    }
    const usesTypedBlockProjection = node.type === "code" || node.type === "table";
    const semanticProps = { ...node.props };
    // List depth is a store view cache; rendering derives it from the compared child hierarchy.
    if (node.type === "list" || node.type === "list-item") {
      delete semanticProps.depth;
    }
    const hasCanonicalListLayout = node.type === "list" && typeof semanticProps.loose === "boolean";
    // Root code, table and list layout come from the exported root block. Whether a nested snapshot carries a
    // block is patch history, so nested code and tables project their owners and nested lists their own layout
    // props and children.
    const isRoot = rootIds.has(id);
    const usesCanonicalBlockProjection = isRoot && (usesTypedBlockProjection || hasCanonicalListLayout);
    const coldBlock = semanticProps.block;
    // Generic code-node block DTOs are stale mirrors; code meaning comes from the canonical exported block.
    if (node.type === "code") {
      delete semanticProps.block;
      // Generated pre/code wrapper attributes differ between native and cold HTML projections.
      // Source semantics and ready token styles are checked through their public code owners.
      delete semanticProps.preAttrs;
      delete semanticProps.codeAttrs;
    } else if (
      coldBlock !== null && typeof coldBlock === "object" &&
      "id" in coldBlock && coldBlock.id === node.id &&
      "type" in coldBlock && coldBlock.type === node.type &&
      "payload" in coldBlock && coldBlock.payload !== null && typeof coldBlock.payload === "object" &&
      "raw" in coldBlock.payload && typeof coldBlock.payload.raw === "string"
    ) {
      // The cold DTO bridge is consumed on update; its meaning is compared through node.block below.
      delete semanticProps.block;
    }
    const canonicalBlock = usesCanonicalBlockProjection
      ? canonicalBlocks.get(id)
      : !isRoot && node.type === "table"
        ? store.getTableColdBlock(id)
        : usesTypedBlockProjection || hasCanonicalListLayout ? undefined : node.block;
    if (usesCanonicalBlockProjection && !canonicalBlock) missingCanonicalBlockIds.push(id);
    const nestedCode = !isRoot && node.type === "code" ? store.getCodeBlock(id) : undefined;
    // Block HTML reads its canonical Block, not setHTML's duplicate transport props.
    if (node.type === "html" && canonicalBlock?.type === "html" && canonicalBlock.id === node.id) {
      delete semanticProps.html;
      delete semanticProps.policy;
      delete semanticProps.meta;
    }
    const isFinalized = nestedCode ? nestedCode.source.state === "finalized" : canonicalBlock?.isFinalized ?? true;
    const props = projectFootnotePublication({
      id: node.id,
      type: node.type,
      isFinalized,
      payload: { raw: "", meta: semanticProps },
    }, publishedLabels).payload.meta;
    const meta = node.type === "code"
      ? undefined
      : projectFootnotePublication({
          id: node.id,
          type: node.type,
          isFinalized,
          payload: { raw: "", meta: node.meta },
        }, publishedLabels).payload.meta;
    const semanticMeta = normalizeSemanticDtoValue(meta);
    // Native list props and canonical exports own layout; this metadata is an initial snapshot mirror.
    if (hasCanonicalListLayout && semanticMeta && typeof semanticMeta === "object" && !Array.isArray(semanticMeta)) {
      delete (semanticMeta as Record<string, unknown>).loose;
    }
    return {
      id: node.id,
      type: node.type,
      // Typed code/table source and rows come from owned exports, not cached generic range/block values.
      range: usesTypedBlockProjection ? undefined : node.range ? { ...node.range } : undefined,
      props: normalizeSemanticDtoValue(props),
      meta: semanticMeta,
      block: canonicalBlock
        ? semanticBlockProjection(projectFootnotePublication(canonicalBlock, publishedLabels))
        : nestedCode
          ? {
              id: node.id,
              type: node.type,
              isFinalized,
              raw: "",
              range: undefined,
              inline: null,
              meta: {
                info: nestedCode.info,
                language: nestedCode.language,
                lines: store.getCodeLines(id, 0, nestedCode.lines.length).map((line) => line.text),
              },
            }
          : null,
      // Native code lines/table rows live outside generic children and are compared through their owned exports.
      children: usesTypedBlockProjection ? [] : store.getChildren(id).map(visit),
    };
  };
  return {
    roots: blocks.map((block) => ({ id: block.id, value: visit(block.id) })),
    missingNodeIds,
    missingCanonicalBlockIds,
  };
}

function blockSourceMatches(block: Block, source: string): boolean {
  const range = block.payload.range;
  return range !== undefined &&
    Number.isSafeInteger(range.from) &&
    Number.isSafeInteger(range.to) &&
    range.from >= 0 &&
    range.to >= range.from &&
    range.to <= source.length &&
    block.payload.raw === source.slice(range.from, range.to);
}
function semanticTreeDifference(
  current: SemanticStoreForest,
  baseline: SemanticStoreForest,
  index: number,
  openTailLifecycleDifference = false,
): string | undefined {
  if (current.missingNodeIds.length > 0 || baseline.missingNodeIds.length > 0) {
    return `missing public store nodes (current=${current.missingNodeIds.join(",")} baseline=${baseline.missingNodeIds.join(",")})`;
  }
  if (current.missingCanonicalBlockIds.length > 0 || baseline.missingCanonicalBlockIds.length > 0) {
    return `missing canonical code/table/list block exports (current=${current.missingCanonicalBlockIds.join(",")} baseline=${baseline.missingCanonicalBlockIds.join(",")})`;
  }
  const currentRoot = current.roots[index];
  const baselineRoot = baseline.roots[index];
  if (!currentRoot || !baselineRoot) return "semantic store root is missing";
  if (currentRoot.id !== baselineRoot.id) {
    return `semantic store root ID mismatch (${currentRoot.id} vs ${baselineRoot.id})`;
  }
  if ("missing" in currentRoot.value || "missing" in baselineRoot.value) return "semantic store root is missing";

  // Only the open tail root's duplicated block lifecycle bit can differ; compared props,
  // canonical block meaning, non-code metadata/range and every descendant remain strict.
  const currentValue = openTailLifecycleDifference
    ? {
        ...currentRoot.value,
        block: currentRoot.value.block ? { ...currentRoot.value.block, isFinalized: false } : null,
      }
    : currentRoot.value;
  const baselineValue = openTailLifecycleDifference
    ? {
        ...baselineRoot.value,
        block: baselineRoot.value.block ? { ...baselineRoot.value.block, isFinalized: false } : null,
      }
    : baselineRoot.value;
  return isDeepStrictEqual(currentValue, baselineValue)
    ? undefined
    : "nested semantic store topology or payload differs";
}


// --- Independent Shiki Oracle ---

let sharedHighlighter: Highlighter | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!sharedHighlighter) {
    sharedHighlighter = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript", "javascript", "markdown"],
      themes: ["github-dark", "github-light"],
    });
  }
  return sharedHighlighter;
}

// --- Cold Parse Helpers ---

/** Fresh INIT + APPEND only: this is the open-prefix oracle and deliberately sends no FINALIZE. */
async function coldNonFinalizingParse(
  prefixSource: string,
): Promise<{ blocks: ReadonlyArray<Block>; store: RendererStore }> {
  const store = createRendererStore();
  const engine = new MarkdownEngine({
    post: (msg: WorkerOut) => {
      if (msg.type === "INITIALIZED") {
        store.resetSnapshot(msg.snapshot);
      } else if (msg.type === "PATCH") {
        store.applyPatches(msg.patches);
      }
    },
  });
  try {
    await engine.handle(PARITY_INIT);
    if (prefixSource.length > 0) {
      await engine.handle({ type: "APPEND", text: prefixSource });
    }
    return { blocks: store.getBlocks(), store };
  } finally {
    engine.dispose();
  }
}

/** Full-source canonical baseline: unlike the prefix oracle, this always sends FINALIZE. */
async function coldFinalizeParse(
  fullSource: string,
): Promise<{ blocks: ReadonlyArray<Block>; store: RendererStore }> {
  const store = createRendererStore();
  const engine = new MarkdownEngine({
    post: (msg: WorkerOut) => {
      if (msg.type === "INITIALIZED") {
        store.resetSnapshot(msg.snapshot);
      } else if (msg.type === "PATCH") {
        store.applyPatches(msg.patches);
      }
    },
  });
  try {
    await engine.handle(PARITY_INIT);
    if (fullSource.length > 0) {
      await engine.handle({ type: "APPEND", text: fullSource });
    }
    await engine.handle({ type: "FINALIZE" });
    return { blocks: store.getBlocks(), store };
  } finally {
    engine.dispose();
  }
}



// --- Engine Layer Replay ---

interface CapturedPublication {
  tx: number;
  frontier: number;
  storeBlocks: Block[];
  signatures: Map<string, string>;
  semanticTree: SemanticStoreForest;
}

async function runEngineLayerFixture(
  fixture: DenseFixture,
  seed: number,
  highlighter: Highlighter,
): Promise<DivergenceReport[]> {
  const divergences: DivergenceReport[] = [];
  const chunkings = generateChunkingPlans(fixture.source, seed);

  for (const chunking of chunkings) {
    const sessionSink = new SessionCounterSink();
    const store = createRendererStore(undefined, {
      campaignCounters: sessionSink,
    } as RendererStoreOptions & { campaignCounters?: SessionCounterSink });
    const capturedPublications: CapturedPublication[] = [];
    let lastTx = -1;
    let initializedGeneration: number | undefined;
    let initializationCount = 0;
    let stopChunking = false;
    let offeredFrontier = 0;

    const engine = new MarkdownEngine({
      post: (msg: WorkerOut) => {
        if (msg.type === "ERROR") {
          if (!stopChunking) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "engine:error",
              lastTx,
              offeredFrontier,
              `Worker ERROR after offering ${offeredFrontier} UTF-16 units: ${JSON.stringify(msg.error)}`,
            );
          }
          stopChunking = true;
          return;
        }
        if (msg.type === "INITIALIZED") {
          if (initializationCount > 0) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "invariant:initialized",
              msg.generation,
              sessionSink.processed_frontier,
              `Unexpected additional INITIALIZED message for generation ${msg.generation}`,
            );
          }
          initializationCount += 1;
          initializedGeneration = msg.generation;
          try {
            store.resetSnapshot(msg.snapshot);
          } catch (error) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "invariant:initialized-root",
              msg.generation,
              0,
              `INITIALIZED root snapshot could not reset the renderer store: ${String(error)}`,
            );
            stopChunking = true;
          }
          return;
        }
        if (msg.type === "PATCH") {
          if (initializedGeneration === undefined) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "invariant:initialized-order",
              msg.tx,
              sessionSink.processed_frontier,
              "PATCH arrived before the store consumed INITIALIZED.snapshot",
            );
          }
          // FIFO invariant check
          if (msg.tx <= lastTx) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "invariant:fifo",
              msg.tx,
              sessionSink.processed_frontier,
              `FIFO violation: patch tx ${msg.tx} <= previous tx ${lastTx}`,
            );
            stopChunking = true;
            return;
          }
          lastTx = msg.tx;
          const priorCodeOwners = capturePriorCodeOwners(msg.patches, store);

          // Atomic store mutation
          try {
            store.applyPatches(msg.patches);
          } catch (err) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "invariant:atomic",
              msg.tx,
              sessionSink.processed_frontier,
              `Store applyPatches threw: ${String(err)}`,
            );
            stopChunking = true;
            return;
          }
          for (const failure of verifyCodeWirePatches(
            msg.patches,
            priorCodeOwners,
            store,
            fixture.source,
          )) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              failure.stage,
              msg.tx,
              sessionSink.processed_frontier,
              failure.message,
            );
          }

          const violations = store.getInvariantViolations();
          if (violations.length > 0) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "invariant:store",
              msg.tx,
              sessionSink.processed_frontier,
              `Store invariant violations: ${violations.join("; ")}`,
            );
            stopChunking = true;
            return;
          }

          // Capture immutable publication snapshot at actual processed publication frontier
          const pubFrontier = sessionSink.publications.at(-1)?.frontier ?? sessionSink.processed_frontier;
          const currentBlocks = store.getBlocks().map(cloneBlock);
          const published = publishedFootnoteLabels(currentBlocks);
          capturedPublications.push({
            tx: msg.tx,
            frontier: pubFrontier,
            storeBlocks: currentBlocks,
            signatures: new Map(currentBlocks.map((b) => [b.id, blockSignature(b)])),
            semanticTree: captureSemanticStoreForest(store, currentBlocks, published),
          });
        }
      },
      campaignCounters: sessionSink,
    } as MarkdownEngineOptions & { campaignCounters?: SessionCounterSink });

    try {
      await engine.handle(PARITY_INIT);
      if (initializationCount !== 1 || initializedGeneration === undefined) {
        recordDivergence(
          divergences,
          fixture,
          chunking,
          "invariant:initialized",
          initializationCount,
          0,
          `Expected one INITIALIZED root reset before streaming; observed ${initializationCount}`,
        );
        stopChunking = true;
      }

      // Stream chunks
      for (let c = 0; c < chunking.chunks.length; c++) {
        if (stopChunking) break;
        offeredFrontier += chunking.chunks[c].length;
        await engine.handle({ type: "APPEND", text: chunking.chunks[c] });
      }

      // Check captured publications at their actual frontiers.
      for (const pub of capturedPublications) {
        if (stopChunking) break;
        const historyChanged = pub.signatures.size !== pub.storeBlocks.length ||
          pub.storeBlocks.some((block) => pub.signatures.get(block.id) !== blockSignature(block));
        if (historyChanged) {
          recordDivergence(
            divergences,
            fixture,
            chunking,
            "engine:history",
            pub.tx,
            pub.frontier,
            "A captured publication block changed after its publication frontier",
          );
          stopChunking = true;
          break;
        }

        const prefixSource = fixture.source.slice(0, pub.frontier);
        const coldParse = await coldNonFinalizingParse(prefixSource);
        const coldBlocks = coldParse.blocks;
        const published = publishedFootnoteLabels(pub.storeBlocks);
        const coldTree = captureSemanticStoreForest(coldParse.store, coldBlocks, published);
        if (pub.semanticTree.missingNodeIds.length > 0 || coldTree.missingNodeIds.length > 0) {
          recordDivergence(
            divergences,
            fixture,
            chunking,
            "engine:prefix",
            pub.tx,
            pub.frontier,
            `Missing public semantic store nodes (current=${pub.semanticTree.missingNodeIds.join(",")} cold=${coldTree.missingNodeIds.join(",")})`,
          );
          stopChunking = true;
          break;
        }

        for (let i = 0; i < Math.max(pub.storeBlocks.length, coldBlocks.length); i++) {
          const curr = pub.storeBlocks[i];
          const coldBlock = coldBlocks[i];
          if (!curr || !coldBlock) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "engine:prefix",
              pub.tx,
              pub.frontier,
              curr
                ? `Cold non-finalizing baseline is missing current block ${curr.id} at index ${i}`
                : `Current store is missing cold block ${coldBlock!.id} at index ${i}`,
            );
            stopChunking = true;
            break;
          }

          if (curr.isFinalized) {
            if (!coldBlock.isFinalized) {
              recordDivergence(
                divergences,
                fixture,
                chunking,
                "engine:prefix",
                pub.tx,
                pub.frontier,
                `Finalized block ${curr.id} is provisional in the cold non-finalizing baseline`,
              );
              stopChunking = true;
              break;
            }
            const projectedCold = projectFootnotePublication(coldBlock, published);
            if (!blocksSemanticallyEqual(curr, projectedCold)) {
              recordDivergence(
                divergences,
                fixture,
                chunking,
                "engine:prefix",
                pub.tx,
                pub.frontier,
                `Prefix divergence at index ${i} (${curr.id}) [curr=${curr.type} cold=${coldBlock.type}]: ${describeBlockSemanticDifference(curr, projectedCold)}`,
                {
                  current: { block: curr, tree: pub.semanticTree.roots[i] },
                  cold: { block: coldBlock, tree: coldTree.roots[i] },
                },
              );
              stopChunking = true;
              break;
            }
            const treeDiff = semanticTreeDifference(pub.semanticTree, coldTree, i);
            if (treeDiff) {
              recordDivergence(
                divergences,
                fixture,
                chunking,
                "engine:prefix",
                pub.tx,
                pub.frontier,
                `Prefix semantic store divergence at index ${i} (${curr.id}): ${treeDiff}`,
                {
                  current: { block: curr, tree: pub.semanticTree.roots[i] },
                  cold: { block: coldBlock, tree: coldTree.roots[i] },
                },
              );
              stopChunking = true;
              break;
            }
            continue;
          }

          if (i !== pub.storeBlocks.length - 1) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "engine:prefix",
              pub.tx,
              pub.frontier,
              `Provisional block ${curr.id} is not the current source tail`,
              {
                current: { block: curr, tree: pub.semanticTree.roots[i] },
                cold: { block: coldBlock, tree: coldTree.roots[i] },
              },
            );
            stopChunking = true;
            break;
          }
          if (!blockSourceMatches(curr, prefixSource) || !blockSourceMatches(coldBlock, prefixSource) ||
              curr.id !== coldBlock.id || curr.type !== coldBlock.type ||
              !isDeepStrictEqual(curr.payload.range, coldBlock.payload.range) ||
              curr.payload.raw !== coldBlock.payload.raw) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "engine:prefix",
              pub.tx,
              pub.frontier,
              `Provisional tail ${curr.id} does not retain the same exact authored source range in the current and cold stores`,
              {
                current: { block: curr, tree: pub.semanticTree.roots[i] },
                cold: { block: coldBlock, tree: coldTree.roots[i] },
              },
            );
            stopChunking = true;
            break;
          }
          const openTailLifecycleDifference = !curr.isFinalized && coldBlock.isFinalized;
          const projectedCold = projectFootnotePublication(coldBlock, published);
          if (!provisionalTailBlocksSemanticallyEqual(curr, projectedCold)) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "engine:prefix",
              pub.tx,
              pub.frontier,
              `Provisional tail semantic divergence at index ${i} (${curr.id}): ${describeProvisionalTailSemanticDifference(curr, projectedCold)}`,
              {
                current: { block: curr, tree: pub.semanticTree.roots[i] },
                cold: { block: coldBlock, tree: coldTree.roots[i] },
              },
            );
            stopChunking = true;
            break;
          }
          const treeDiff = semanticTreeDifference(
            pub.semanticTree,
            coldTree,
            i,
            openTailLifecycleDifference,
          );
          if (treeDiff) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "engine:prefix",
              pub.tx,
              pub.frontier,
              `Provisional tail store divergence at index ${i} (${curr.id}): ${treeDiff}`,
              {
                current: { block: curr, tree: pub.semanticTree.roots[i] },
                cold: { block: coldBlock, tree: coldTree.roots[i] },
              },
            );
            stopChunking = true;
            break;
          }
        }
      }
      if (stopChunking) continue;

      // Finalize and verify final semantic store equality against cold finalize.
      await engine.handle({ type: "FINALIZE" });
      const finalStoreBlocks = store.getBlocks();
      const coldFinalize = await coldFinalizeParse(fixture.source);
      const coldCanonicalBlocks = coldFinalize.blocks;

      if (finalStoreBlocks.length !== coldCanonicalBlocks.length) {
        recordDivergence(
          divergences,
          fixture,
          chunking,
          "engine:final",
          362,
          fixture.source.length,
          `Final block count divergence: incremental=${finalStoreBlocks.length} cold=${coldCanonicalBlocks.length}`,
        );
        continue;
      }

      const published = publishedFootnoteLabels(finalStoreBlocks);
      const currentTree = captureSemanticStoreForest(store, finalStoreBlocks, published);
      const coldTree = captureSemanticStoreForest(coldFinalize.store, coldCanonicalBlocks, published);
      if (currentTree.missingNodeIds.length > 0 || coldTree.missingNodeIds.length > 0) {
        recordDivergence(
          divergences,
          fixture,
          chunking,
          "engine:final",
          374,
          fixture.source.length,
          `Missing public semantic store nodes (current=${currentTree.missingNodeIds.join(",")} cold=${coldTree.missingNodeIds.join(",")})`,
        );
      }
      for (let i = 0; i < finalStoreBlocks.length; i++) {
        const curr = finalStoreBlocks[i];
        const base = coldCanonicalBlocks[i];

        if (curr.id !== base.id) {
          recordDivergence(
            divergences,
            fixture,
            chunking,
            "engine:final",
            374,
            fixture.source.length,
            `Final block ID drift at index ${i}: curr=${curr.id} base=${base.id}`,
          );
          break;
        }

        const projectedBase = projectFootnotePublication(base, published);
        if (!blocksSemanticallyEqual(curr, projectedBase)) {
          recordDivergence(
            divergences,
            fixture,
            chunking,
            "engine:final",
            386,
            fixture.source.length,
            `Final block drift at index ${i} (${curr.id}) [curr=${curr.type} base=${base.type}]: ${describeBlockSemanticDifference(curr, projectedBase)}`,
            {
              current: { block: curr, tree: currentTree.roots[i] },
              cold: { block: base, tree: coldTree.roots[i] },
            },
          );
          break;
        }
        const treeDiff = semanticTreeDifference(currentTree, coldTree, i);
        if (treeDiff) {
          recordDivergence(
            divergences,
            fixture,
            chunking,
            "engine:final",
            387,
            fixture.source.length,
            `Final semantic store divergence at index ${i} (${curr.id}): ${treeDiff}`,
            {
              current: { block: curr, tree: currentTree.roots[i] },
              cold: { block: base, tree: coldTree.roots[i] },
            },
          );
          break;
        }
      }

      // Shiki token validation on completed lines (including nested blocks)
      const allFinalBlocks = collectBlocksRecursively(finalStoreBlocks);
      const tokenResult = await verifyCompletedLineTokens(
        allFinalBlocks,
        highlighter,
        engine,
        store,
        fixture.source,
      );
      if (!tokenResult.ok) {
        recordDivergence(
          divergences,
          fixture,
          chunking,
          "shiki:tokens",
          400,
          fixture.source.length,
          tokenResult.message ?? "Shiki token mismatch",
        );
      }

      // Independent CommonMark/GFM expectation validation
      const expResult = verifyIndependentExpectations(allFinalBlocks, fixture, store);
      if (!expResult.ok) {
        recordDivergence(
          divergences,
          fixture,
          chunking,
          "fixture:expectations",
          410,
          fixture.source.length,
          expResult.message ?? "Fixture expectation unmet",
        );
      }
      const renderedResult = verifyRenderedExpectations(fixture, finalStoreBlocks, store);
      if (!renderedResult.ok) {
        recordDivergence(
          divergences,
          fixture,
          chunking,
          "react:semantic-expectations",
          411,
          fixture.source.length,
          renderedResult.message ?? "Rendered fixture expectation unmet",
        );
      }
    } finally {
      engine.dispose();
    }
  }

  return divergences;
}


// --- Main Oracle Runner ---

type ReplaySection = "all" | "engine-fixture" | "mounted-code" | "code-scaling" | "table-scaling";

function summarizeFocusedSection(
  section: Exclude<ReplaySection, "all">,
  startedAt: number,
  divergences: DivergenceReport[],
  jsonPath: string | undefined,
  scalingMeasurements?: ScalingMeasurement[],
): OracleSummary {
  const passed = divergences.length === 0;
  const summary: OracleSummary = {
    passed,
    totalFixtures: 1,
    passedFixtures: passed ? 1 : 0,
    failedFixtures: passed ? 0 : 1,
    divergenceCount: divergences.length,
    divergences,
    scalingMeasurements,
    durationMs: Date.now() - startedAt,
  };
  console.log(`\n=== P2 scoped proof: ${section} ===`);
  console.log(`${passed ? "PASS" : "FAIL"} | divergences: ${divergences.length} | ${summary.durationMs}ms`);
  for (const divergence of divergences) {
    console.log(`  - [${divergence.stage}] ${divergence.message}`);
  }
  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");
    console.log(`Evidence report saved to: ${jsonPath}`);
  }
  return summary;
}

export async function runReplayOracle(options: {
  section?: ReplaySection;
  fixtureId?: string;
  seed?: number;
  bail?: boolean;
  jsonPath?: string;
} = {}): Promise<OracleSummary> {
  const startTime = Date.now();
  const seed = options.seed ?? 42;
  const section = options.section ?? "all";
  if (section === "mounted-code") {
    return summarizeFocusedSection(section, startTime, await runLiveReactLayer(), options.jsonPath);
  }
  if (section === "code-scaling") {
    const result = await runScalingDiagnostics({ codeFamilyOnly: true });
    return summarizeFocusedSection(section, startTime, result.divergences, options.jsonPath, result.measurements);
  }
  if (section === "table-scaling") {
    const result = await runScalingDiagnostics({ tableFamilyOnly: true });
    for (const measurement of result.measurements) {
      if (measurement.tableBoundary) continue;
      result.divergences.push({
        fixtureId: `scaling-${measurement.workload}`,
        planMode: "window-append",
        seed,
        stage: "diagnostic:scaling:missing-table-family",
        commitIndex: 0,
        frontier: 0,
        sourcePrefix: "",
        message: "Table boundary evidence is unavailable",
      });
    }
    return summarizeFocusedSection(section, startTime, result.divergences, options.jsonPath, result.measurements);
  }
  const selectedFixtureId =
    section === "engine-fixture" ? (options.fixtureId ?? "fence-indent-multiline") : options.fixtureId;
  const targetFixtures = selectedFixtureId
    ? DENSE_FIXTURES.filter((fixture) => fixture.id === selectedFixtureId)
    : DENSE_FIXTURES;
  if (targetFixtures.length === 0) {
    throw new Error(`Fixture not found: ${selectedFixtureId}`);
  }
  const highlighter = await getHighlighter();

  const allDivergences: DivergenceReport[] = [];
  let passedFixtures = 0;
  let failedFixtures = 0;
  let rootTraceFixtures = 0;

  console.log(`\n=== StreamMDX ${section === "all" ? "Dense Replay" : "P2 Engine Fixture"} Oracle ===`);
  console.log(`Fixtures: ${targetFixtures.length} | Seed: ${seed} | Environment: In-Process Node`);

  // Phase 1: Engine Layer Replay across seeded chunkings
  for (const fixture of targetFixtures) {
    try {
      const fixtureStart = Date.now();
      const divergences = await runEngineLayerFixture(fixture, seed, highlighter);
      const fixtureElapsed = Date.now() - fixtureStart;

      if (divergences.length === 0) {
        passedFixtures++;
        console.log(`  ✓ [PASS] ${fixture.id} (${fixtureElapsed}ms)`);
      } else {
        failedFixtures++;
        console.log(`  ✗ [FAIL] ${fixture.id} (${fixtureElapsed}ms) - ${divergences.length} divergence(s)`);
        for (const d of divergences) {
          console.log(`    - [${d.stage}] commit=${d.commitIndex} frontier=${d.frontier}: ${d.message}`);
        }
        allDivergences.push(...divergences);
        if (options.bail) break;
      }
    } catch (err) {
      failedFixtures++;
      const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
      console.log(`  ✗ [ERROR] ${fixture.id} - ${errMsg}`);
      allDivergences.push({
        fixtureId: fixture.id,
        planMode: "exception",
        seed,
        stage: "fixture:exception",
        commitIndex: -1,
        frontier: -1,
        sourcePrefix: fixture.source.slice(0, 40),
        message: `Unhandled exception in fixture: ${errMsg}`,
      });
      if (options.bail) break;
    }
  }

  const initializedRootFixture = targetFixtures.find((fixture) => fixture.id === "fence-indent-multiline");
  if (initializedRootFixture) {
    rootTraceFixtures = 1;
    const rootTraceDivergences = await runRootCodeInitializationTrace(initializedRootFixture, highlighter);
    if (rootTraceDivergences.length === 0) {
      passedFixtures += 1;
      console.log("  ✓ [PASS] initialized-root-code-trace");
    } else {
      failedFixtures += 1;
      console.log(`  ✗ [FAIL] initialized-root-code-trace - ${rootTraceDivergences.length} divergence(s)`);
      allDivergences.push(...rootTraceDivergences);
    }
  }

  // Phase 2: Generation, Reset, and Disposal Invariants
  if (section === "all" && (!options.bail || allDivergences.length === 0)) {
    console.log(`\n=== Generation & Reset Invariant Proofs ===`);
    try {
      const genDivergences = await runGenerationAndResetInvariants();
      if (genDivergences.length === 0) {
        console.log(`  ✓ [PASS] generation-and-reset-invariants`);
      } else {
        console.log(`  ✗ [FAIL] generation-and-reset-invariants - ${genDivergences.length} violation(s)`);
        for (const d of genDivergences) {
          console.log(`    - [${d.stage}]: ${d.message}`);
        }
        allDivergences.push(...genDivergences);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
      console.log(`  ✗ [ERROR] generation-and-reset-invariants - ${errMsg}`);
      allDivergences.push({
        fixtureId: "invariant-generation-reset",
        planMode: "exception",
        seed,
        stage: "lifecycle:exception",
        commitIndex: -1,
        frontier: -1,
        sourcePrefix: "",
        message: `Unhandled exception in generation invariants: ${errMsg}`,
      });
    }
  }

  // Phase 3: Live Mounted React Layer under JSDOM createRoot
  if (section === "all" && (!options.bail || allDivergences.length === 0)) {
    console.log(`\n=== Live React Layer (JSDOM createRoot) ===`);
    try {
      const reactDivergences = await runLiveReactLayer();
      if (reactDivergences.length === 0) {
        console.log(`  ✓ [PASS] live-react-layer`);
      } else {
        console.log(`  ✗ [FAIL] live-react-layer - ${reactDivergences.length} divergence(s)`);
        for (const d of reactDivergences) {
          console.log(`    - [${d.stage}]: ${d.message}`);
        }
        allDivergences.push(...reactDivergences);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
      console.log(`  ✗ [ERROR] live-react-layer - ${errMsg}`);
      allDivergences.push({
        fixtureId: "live-react-layer",
        planMode: "exception",
        seed,
        stage: "react:exception",
        commitIndex: -1,
        frontier: -1,
        sourcePrefix: "",
        message: `Unhandled exception in live React layer: ${errMsg}`,
      });
    }
  }

  // Phase 4: Diagnostic Path: N-vs-4N Bounded Equal-Append Scaling
  let scalingMeasurements: ScalingMeasurement[] | undefined;
  if (section === "all" && (!options.bail || allDivergences.length === 0)) {
    console.log(`\n=== Diagnostic Path: N-vs-4N Bounded Equal-Append Scaling ===`);
    try {
      const scalingResult = await runScalingDiagnostics();
      scalingMeasurements = scalingResult.measurements;

      for (const m of scalingMeasurements) {
        const status = m.gatePassed ? "✓ [PASS]" : "✗ [CURRENT SCOPED RED]";
        console.log(
          `  ${status} ${m.workload} (block: ${m.expectedBlockType}): total work/unit N=${m.workPerUnitN.toFixed(4)} 4N=${m.workPerUnit4N.toFixed(4)} (ratio: ${m.totalRatio.toFixed(2)}x, gate <= 1.25x)`,
        );
        for (const stage of Object.keys(m.stageRatios) as (keyof typeof m.stageRatios)[]) {
          for (const [counter, ratioData] of Object.entries(m.stageRatios[stage])) {
            if (ratioData && (ratioData.n > 0 || ratioData.fourN > 0)) {
              console.log(
                `    - stage=${stage} counter=${counter}: N=${ratioData.unitWorkN.toFixed(4)} 4N=${ratioData.unitWork4N.toFixed(4)} ratio=${ratioData.ratio.toFixed(2)}x`,
              );
            }
          }
        }
      }
      allDivergences.push(...scalingResult.divergences);
    } catch (err) {
      const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
      console.log(`  ✗ [ERROR] scaling-diagnostics - ${errMsg}`);
      allDivergences.push({
        fixtureId: "scaling-diagnostics",
        planMode: "exception",
        seed,
        stage: "scaling:exception",
        commitIndex: -1,
        frontier: -1,
        sourcePrefix: "",
        message: `Unhandled exception in scaling diagnostics: ${errMsg}`,
      });
    }
  }
  const durationMs = Date.now() - startTime;
  const passed = allDivergences.length === 0;

  console.log(`\n=== Replay Oracle Summary ===`);
  console.log(`Total Duration: ${durationMs}ms (target < 60,000ms)`);
  console.log(`Fixtures: ${passedFixtures}/${targetFixtures.length + rootTraceFixtures} passed`);
  console.log(`Divergences: ${allDivergences.length}`);

  const summary: OracleSummary = {
    passed,
    totalFixtures: targetFixtures.length + rootTraceFixtures,
    passedFixtures,
    failedFixtures,
    divergenceCount: allDivergences.length,
    divergences: allDivergences,
    scalingMeasurements,
    durationMs,
  };

  if (options.jsonPath) {
    fs.writeFileSync(options.jsonPath, JSON.stringify(summary, null, 2), "utf8");
    console.log(`Evidence report saved to: ${options.jsonPath}`);
  }

  return summary;
}

// --- CLI Execution ---

function parseCliArgs(): {
  section?: ReplaySection;
  fixtureId?: string;
  seed?: number;
  bail?: boolean;
  jsonPath?: string;
} {
  const args = process.argv.slice(2);
  const options: { section?: ReplaySection; fixtureId?: string; seed?: number; bail?: boolean; jsonPath?: string } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--section" && args[i + 1]) {
      const section = args[++i];
      if (section !== "all" && section !== "engine-fixture" && section !== "mounted-code" && section !== "code-scaling" && section !== "table-scaling") {
        throw new Error(`Unknown replay section: ${section}`);
      }
      options.section = section;
    } else if (args[i] === "--fixture" && args[i + 1]) {
      options.fixtureId = args[++i];
    } else if (args[i] === "--seed" && args[i + 1]) {
      options.seed = Number.parseInt(args[++i], 10);
    } else if (args[i] === "--bail") {
      options.bail = true;
    } else if (args[i] === "--json" && args[i + 1]) {
      options.jsonPath = args[++i];
    }
  }

  return options;
}

if (process.argv[1]?.endsWith("replay-oracle.ts")) {
  runReplayOracle(parseCliArgs())
    .then((summary) => {
      // Exit nonzero if product or invariant divergence occurred
      if (!summary.passed) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error("Fatal replay oracle error:", err);
      process.exitCode = 2;
    });
}
