#!/usr/bin/env tsx
/**
 * P1 Dense Replay Oracle
 * Implements validation-plan.md §2, baseline-protocol.md, and P1 repair contract.
 * Runs in-process under Node (>=20), targeting < 60s.
 *
 * Imports directly from ./diagnostic-dist/index.mjs to execute with __STREAM_MDX_COUNTERS__ = true.
 *
 * Verifies:
 * 1. Committed-prefix equality against cold non-finalizing parse at every actual PATCH publication frontier
 * 2. Final semantic store equality against cold canonical finalize
 * 3. Independent pinned Shiki validation for completed-line code tokens (with deferred TOKENIZE_RANGE resolution)
 * 4. Independent CommonMark/GFM syntax expectations (fence indent dedent, table escaping/alignment, footnotes, looseness)
 * 5. FIFO monotonic tx, atomic patch application, and generation reset/disposal invariants
 * 6. Live React mounted createRoot append, update, unmount, exact DOM content, and ambient global cleanup
 * 7. Bounded equal-append N-vs-4N scaling diagnostic using SessionCounterSink with real view consumer work
 *
 * Usage:
 *   npx tsx scripts/perf/replay-oracle.ts [--fixture <id>] [--seed <number>] [--bail] [--json <path>]
 */

import fs from "node:fs";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { createHighlighter, type Highlighter } from "shiki";

import type { Block, FootnoteItem, InlineNode, Patch, TokenLineV1, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { blocksStructurallyEqual, cloneBlock } from "@stream-mdx/core";
import type { RendererStore, RendererStoreOptions } from "@stream-mdx/react/renderer/store";
import type { MarkdownEngineOptions } from "../../packages/markdown-v2-worker/src/engine/types";
import {
  MarkdownEngine,
  createRendererStore,
  SessionCounterSink,
} from "./diagnostic-dist/index.mjs";

import { projectFootnotePublication, publishedFootnoteLabels } from "../../packages/markdown-v2-worker/__tests__/footnote-publication";
import { DENSE_FIXTURES, type DenseFixture, type ChunkingPlan, generateChunkingPlans } from "./replay-fixtures";
import { runGenerationAndResetInvariants, runLiveReactLayer } from "./lifecycle-invariants";
import {
  runScalingDiagnostics,
  type DivergenceReport,
  type ScalingMeasurement,
} from "./scaling-diagnostics";
import {
  getCodeBlockLang,
  verifyCompletedLineTokens,
} from "./replay-code-parity";

import { verifyRenderedExpectations } from "./replay-semantic-expectations";
// --- Configuration & Constants ---

const PARITY_INIT: WorkerIn = {
  type: "INIT",
  initialContent: "",
  prewarmLangs: ["typescript", "javascript", "markdown"],
  docPlugins: {
    footnotes: true,
    html: true,
    mdx: false,
    tables: true,
    callouts: false,
    math: true,
    formatAnticipation: { inline: true, mathInline: true, mathBlock: true, html: true, mdx: false, regex: false },
    codeHighlighting: "incremental",
    outputMode: "both",
    emitHighlightTokens: true,
    emitDiffBlocks: false,
    themes: { dark: "github-dark", light: "github-light" },
  },
  mdx: { compileMode: "server" },
};

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
  return JSON.stringify({
    id: block.id,
    type: block.type,
    isFinalized: block.isFinalized,
    raw: block.payload.raw ?? "",
    meta: block.payload.meta ?? null,
  });
}

function recordDivergence(
  divergences: DivergenceReport[],
  fixture: DenseFixture,
  plan: ChunkingPlan,
  stage: string,
  tx: number,
  frontier: number,
  message: string,
): void {
  divergences.push({
    fixtureId: fixture.id,
    planMode: plan.mode,
    seed: plan.seed,
    stage,
    commitIndex: tx,
    frontier,
    sourcePrefix: fixture.source.slice(0, Math.min(frontier, 80)),
    message,
  });
}
function diffBlockFields(curr: Block, other: Block): string {
  const diffs: string[] = [];
  if (curr.type !== other.type) {
    diffs.push(`type (${curr.type} vs ${other.type})`);
  }
  if (curr.isFinalized !== other.isFinalized) {
    diffs.push(`isFinalized (${curr.isFinalized} vs ${other.isFinalized})`);
  }
  if ((curr.payload.raw ?? "") !== (other.payload.raw ?? "")) {
    diffs.push(`raw (len ${(curr.payload.raw ?? "").length} vs ${(other.payload.raw ?? "").length})`);
  }
  const currInlineStr = JSON.stringify(curr.payload.inline ?? []);
  const otherInlineStr = JSON.stringify(other.payload.inline ?? []);
  if (currInlineStr !== otherInlineStr) {
    diffs.push(`inline mismatch (curr=${currInlineStr.slice(0, 50)} other=${otherInlineStr.slice(0, 50)})`);
  }
  const currMetaStr = JSON.stringify(curr.payload.meta ?? null);
  const otherMetaStr = JSON.stringify(other.payload.meta ?? null);
  if (currMetaStr !== otherMetaStr) {
    const currKeys = Object.keys((curr.payload.meta as Record<string, unknown>) ?? {});
    const otherKeys = Object.keys((other.payload.meta as Record<string, unknown>) ?? {});
    const diffKeys = new Set(
      [...currKeys, ...otherKeys].filter(
        (k) =>
          JSON.stringify((curr.payload.meta as Record<string, unknown>)?.[k]) !==
          JSON.stringify((other.payload.meta as Record<string, unknown>)?.[k]),
      ),
    );
    diffs.push(`meta mismatch on keys [${Array.from(diffKeys).join(", ")}]`);
  }
  return diffs.length > 0 ? diffs.join("; ") : "payload structural difference";
}

function collectBlocksRecursively(blocks: ReadonlyArray<Block>): Block[] {
  const result: Block[] = [];
  const seen = new Set<string>();

  function visitBlock(b: Block) {
    if (seen.has(b.id)) return;
    seen.add(b.id);
    result.push(b);

    const meta = b.payload.meta as Record<string, unknown> | undefined;
    const prepared = meta?.preparedNested as
      | { children?: Array<{ props?: { block?: Block }; type?: string; children?: unknown[] }> }
      | undefined;
    if (prepared?.children) {
      for (const child of prepared.children) {
        visitNode(child);
      }
    }
  }

  function visitNode(node: { props?: { block?: Block }; type?: string; children?: unknown[] }) {
    if (node.props?.block) {
      visitBlock(node.props.block);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child && typeof child === "object") {
          visitNode(child as { props?: { block?: Block }; type?: string; children?: unknown[] });
        }
      }
    }
  }

  for (const b of blocks) {
    visitBlock(b);
  }
  return result;
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

async function coldNonFinalizingParse(prefixSource: string): Promise<ReadonlyArray<Block>> {
  const store = createRendererStore();
  const engine = new MarkdownEngine({
    post: (msg: WorkerOut) => {
      if (msg.type === "INITIALIZED") {
        store.reset(msg.blocks);
      } else if (msg.type === "PATCH") {
        store.applyPatches(msg.patches as Patch[]);
      }
    },
  });
  try {
    await engine.handle(PARITY_INIT);
    if (prefixSource.length > 0) {
      await engine.handle({ type: "APPEND", text: prefixSource });
    }
    return store.getBlocks();
  } finally {
    engine.dispose();
  }
}

async function coldFinalizeParse(fullSource: string): Promise<ReadonlyArray<Block>> {
  const store = createRendererStore();
  const engine = new MarkdownEngine({
    post: (msg: WorkerOut) => {
      if (msg.type === "INITIALIZED") {
        store.reset(msg.blocks);
      } else if (msg.type === "PATCH") {
        store.applyPatches(msg.patches as Patch[]);
      }
    },
  });
  try {
    await engine.handle(PARITY_INIT);
    if (fullSource.length > 0) {
      await engine.handle({ type: "APPEND", text: fullSource });
    }
    await engine.handle({ type: "FINALIZE" });
    return store.getBlocks();
  } finally {
    engine.dispose();
  }
}


function collectCodeLinesFromStore(store: RendererStore | undefined, blockId: string): string[] {
  if (!store) return [];
  const lineIds = store.getChildren(blockId);
  const lines: Array<{ index: number; text: string }> = [];
  for (const lineId of lineIds) {
    const lineNode = store.getNode(lineId);
    if (!lineNode || lineNode.type !== "code-line") continue;
    const index = typeof lineNode.props?.index === "number" ? (lineNode.props.index as number) : lines.length;
    const text = typeof lineNode.props?.text === "string" ? (lineNode.props.text as string) : "";
    lines.push({ index, text });
  }
  lines.sort((a, b) => a.index - b.index);
  return lines.map((l) => l.text);
}

// --- Independent CommonMark/GFM Expectations ---

function extractInlineText(node: InlineNode): string {
  if (node.kind === "text") return node.text;
  if ("children" in node && Array.isArray(node.children)) {
    const children = node.children;
    return children.map(extractInlineText).join("");
  }
  if ("raw" in node && typeof node.raw === "string") {
    return node.raw;
  }
  return "";
}

function extractFootnoteItemText(item: FootnoteItem): string {
  if (!Array.isArray(item.inlines)) return "";
  return item.inlines.map(extractInlineText).join("");
}

function verifyIndependentExpectations(
  blocks: ReadonlyArray<Block>,
  fixture: DenseFixture,
  store?: RendererStore,
): { ok: boolean; message?: string } {
  const exp = fixture.expectations;
  if (!exp) return { ok: true };

  const allBlocks = collectBlocksRecursively(blocks);
  const codeBlocks = allBlocks.filter((b) => b.type === "code");
  const listBlock = allBlocks.find((b) => b.type === "list");

  if (exp.codeBlocks) {
    for (const expCb of exp.codeBlocks) {
      const match = codeBlocks.find((cb) => {
        const meta = cb.payload.meta as Record<string, unknown> | undefined;
        return getCodeBlockLang(meta) === expCb.lang;
      });
      if (!match) {
        return {
          ok: false,
          message: `Missing expected code block with lang='${expCb.lang}' (observed code langs: [${codeBlocks
            .map((c) => getCodeBlockLang(c.payload.meta as Record<string, unknown> | undefined))
            .filter(Boolean)
            .join(", ")}])`,
        };
      }

      // Explicit code fixture expectations compare exact ordered prepared/emitted code lines (not raw.includes)
      let actualLines: string[] = [];
      if (store) {
        actualLines = collectCodeLinesFromStore(store, match.id);
      }
      if (actualLines.length === 0 && typeof match.payload.meta?.code === "string") {
        actualLines = (match.payload.meta.code as string).split("\n");
      }
      if (actualLines.length === 0 && Array.isArray(match.payload.meta?.tokenLines)) {
        actualLines = (match.payload.meta.tokenLines as TokenLineV1[]).map((tl) =>
          tl ? tl.spans.map((s) => s.t).join("").replace(/\r$/, "") : ""
        );
      }

      if (actualLines.length !== expCb.codeLines.length) {
        return {
          ok: false,
          message: `Code block lang='${expCb.lang}' line count mismatch: actual=${actualLines.length} expected=${expCb.codeLines.length}`,
        };
      }

      for (let l = 0; l < expCb.codeLines.length; l++) {
        const expectedLine = expCb.codeLines[l];
        const actualLine = actualLines[l]?.replace(/\r$/, "");
        if (actualLine !== expectedLine) {
          return {
            ok: false,
            message: `Code block lang='${expCb.lang}' line ${l} mismatch: actual=${JSON.stringify(actualLine)} expected=${JSON.stringify(expectedLine)}`,
          };
        }
      }
    }
  }


  if (exp.footnotes) {
    const fnFooter = allBlocks.find((b) => b.type === "footnotes");
    if (!fnFooter) {
      return { ok: false, message: "Missing expected footnotes footer block" };
    }
    const items = (fnFooter.payload.meta?.items as FootnoteItem[] | undefined) ?? [];
    for (const expFn of exp.footnotes) {
      const item = items.find((it) => it.label === expFn.label);
      if (!item) {
        return { ok: false, message: `Footnotes footer missing definition for '${expFn.label}'` };
      }
      if (item.number !== expFn.number) {
        return {
          ok: false,
          message: `Footnote '${expFn.label}' expected number ${expFn.number} but got ${item.number}`,
        };
      }
      if (typeof item.refCount === "number" && item.refCount < 1) {
        return {
          ok: false,
          message: `Footnote '${expFn.label}' has zero occurrence count`,
        };
      }
      if (expFn.textSnippet) {
        const itemText = extractFootnoteItemText(item);
        if (!itemText.includes(expFn.textSnippet)) {
          return {
            ok: false,
            message: `Footnote '${expFn.label}' body text ${JSON.stringify(itemText)} missing expected snippet: ${JSON.stringify(expFn.textSnippet)}`,
          };
        }
      }
    }
  }

  if (exp.listLooseness) {
    if (listBlock) {
      const isLoose = Boolean(listBlock.payload.meta?.loose);
      if (!isLoose) {
        return { ok: false, message: "Inherited red: list with blank-line separated item not marked loose" };
      }
    }
  }

  return { ok: true };
}

// --- Engine Layer Replay ---

interface CapturedPublication {
  tx: number;
  frontier: number;
  storeBlocks: Block[];
  signatures: Map<string, string>;
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
    let stopChunking = false;

    const engine = new MarkdownEngine({
      post: (msg: WorkerOut) => {
        if (msg.type === "PATCH") {
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

          // Atomic store mutation
          try {
            store.applyPatches(msg.patches as Patch[]);
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
          capturedPublications.push({
            tx: msg.tx,
            frontier: pubFrontier,
            storeBlocks: currentBlocks,
            signatures: new Map(currentBlocks.map((b) => [b.id, blockSignature(b)])),
          });
        }
      },
      campaignCounters: sessionSink,
    } as MarkdownEngineOptions & { campaignCounters?: SessionCounterSink });

    try {
      await engine.handle(PARITY_INIT);

      // Stream chunks
      for (let c = 0; c < chunking.chunks.length; c++) {
        if (stopChunking) break;
        await engine.handle({ type: "APPEND", text: chunking.chunks[c] });
      }

      // Check captured publications at their actual frontiers
      for (const pub of capturedPublications) {
        if (stopChunking) break;
        const prefixSource = fixture.source.slice(0, pub.frontier);
        const coldBlocks = await coldNonFinalizingParse(prefixSource);

        const published = publishedFootnoteLabels(pub.storeBlocks);
        const coldFinalized = coldBlocks.filter((b) => b.isFinalized);

        for (let i = 0; i < coldFinalized.length; i++) {
          const coldBlock = coldFinalized[i];
          const curr = pub.storeBlocks[i];
          if (!curr) {
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "engine:prefix",
              pub.tx,
              pub.frontier,
              `Finalized block ${coldBlock.id} (index ${i}) missing in non-finalizing baseline`,
            );
            stopChunking = true;
            break;
          }

          const projectedCold = projectFootnotePublication(coldBlock, published);
          if (!blocksStructurallyEqual(curr, projectedCold)) {
            const fieldDiff = diffBlockFields(curr, projectedCold);
            recordDivergence(
              divergences,
              fixture,
              chunking,
              "engine:prefix",
              pub.tx,
              pub.frontier,
              `Prefix divergence at index ${i} (${curr.id}) [curr=${curr.type} cold=${coldBlock.type}]: ${fieldDiff}`,
            );
            stopChunking = true;
            break;
          }
        }
      }

      if (stopChunking) continue;

      // Finalize and verify final semantic store equality against cold finalize
      await engine.handle({ type: "FINALIZE" });
      const finalStoreBlocks = store.getBlocks();
      const coldCanonicalBlocks = await coldFinalizeParse(fixture.source);

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
        if (!blocksStructurallyEqual(curr, projectedBase)) {
          const fieldDiff = diffBlockFields(curr, projectedBase);
          recordDivergence(
            divergences,
            fixture,
            chunking,
            "engine:final",
            386,
            fixture.source.length,
            `Final block drift at index ${i} (${curr.id}) [curr=${curr.type} base=${base.type}]: ${fieldDiff}`,
          );
          break;
        }
      }

      // Shiki token validation on completed lines (including nested blocks)
      const allFinalBlocks = collectBlocksRecursively(finalStoreBlocks);
      const tokenResult = await verifyCompletedLineTokens(allFinalBlocks, highlighter, engine, store, fixture.source);
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

export async function runReplayOracle(options: {
  fixtureId?: string;
  seed?: number;
  bail?: boolean;
  jsonPath?: string;
} = {}): Promise<OracleSummary> {
  const startTime = Date.now();
  const seed = options.seed ?? 42;
  const highlighter = await getHighlighter();

  const targetFixtures = options.fixtureId
    ? DENSE_FIXTURES.filter((f) => f.id === options.fixtureId)
    : DENSE_FIXTURES;

  if (targetFixtures.length === 0) {
    throw new Error(`Fixture not found: ${options.fixtureId}`);
  }

  const allDivergences: DivergenceReport[] = [];
  let passedFixtures = 0;
  let failedFixtures = 0;

  console.log(`\n=== StreamMDX P1 Dense Replay Oracle ===`);
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

  // Phase 2: Generation, Reset, and Disposal Invariants
  if (!options.bail || allDivergences.length === 0) {
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
  if (!options.bail || allDivergences.length === 0) {
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
  if (!options.bail || allDivergences.length === 0) {
    console.log(`\n=== Diagnostic Path: N-vs-4N Bounded Equal-Append Scaling ===`);
    try {
      const scalingResult = await runScalingDiagnostics();
      scalingMeasurements = scalingResult.measurements;

      for (const m of scalingMeasurements) {
        const status = m.gatePassed ? "✓ [PASS]" : "✗ [INHERITED RED]";
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
  console.log(`Fixtures: ${passedFixtures}/${targetFixtures.length} passed`);
  console.log(`Divergences: ${allDivergences.length}`);

  const summary: OracleSummary = {
    passed,
    totalFixtures: targetFixtures.length,
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
  fixtureId?: string;
  seed?: number;
  bail?: boolean;
  jsonPath?: string;
} {
  const args = process.argv.slice(2);
  const options: { fixtureId?: string; seed?: number; bail?: boolean; jsonPath?: string } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fixture" && args[i + 1]) {
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
