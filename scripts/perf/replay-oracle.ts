#!/usr/bin/env tsx
import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

/**
 * P2 Root-Code Replay Oracle
 * Preserves the frozen P1 dense replay on the no-flag path while exposing focused P2 proofs.
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
 * The no-flag command retains the complete P1 fixture matrix and aggregate path.
 * Section selection runs only the named proof; engine-fixture defaults to the root-code fixture.
 */

import fs from "node:fs";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { createHighlighter, type Highlighter } from "shiki";

import type {
  Block,
  CodeBlockSourceMetadata,
  CodeLineRecord,
  FootnoteItem,
  InlineNode,
  Patch,
  WorkerIn,
  WorkerOut,
} from "@stream-mdx/core";
import { blocksStructurallyEqual, cloneBlock, PATCH_ROOT_ID } from "@stream-mdx/core";
import type { MarkdownEngineOptions } from "../../packages/markdown-v2-worker/src/engine/types";
import type { RendererStore, RendererStoreOptions } from "../../packages/markdown-v2-react/src/renderer/store";
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
  verifyAuthoredCodeExpectations,
  verifyCompletedLineTokens,
} from "./replay-code-parity";

import { verifyRenderedExpectations } from "./replay-semantic-expectations";
// --- Configuration & Constants ---

const PARITY_INIT: WorkerIn = { type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
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
mdx: { compileMode: "server" }, };

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
interface PriorCodeOwnerState {
  readonly source: CodeBlockSourceMetadata;
  readonly completedRows: ReadonlyArray<CodeLineRecord>;
}

interface CodeWireFailure {
  readonly stage: "wire:appendCode" | "wire:decorateCode";
  readonly message: string;
}

function capturePriorCodeOwners(
  patches: ReadonlyArray<Patch>,
  store: RendererStore,
): Map<string, PriorCodeOwnerState> {
  const prior = new Map<string, PriorCodeOwnerState>();
  for (const patch of patches) {
    if (patch.op !== "appendCode" || prior.has(patch.code.codeOwnerId)) continue;
    const view = store.getCodeBlock(patch.code.codeOwnerId);
    if (!view) continue;
    prior.set(patch.code.codeOwnerId, {
      source: view.source,
      completedRows: store.getCodeLines(patch.code.codeOwnerId, 0, view.source.completeLineCount),
    });
  }
  return prior;
}

function verifyCodeWirePatches(
  patches: ReadonlyArray<Patch>,
  prior: ReadonlyMap<string, PriorCodeOwnerState>,
  store: RendererStore,
  authoredSource: string,
  initializedGeneration: number,
): CodeWireFailure[] {
  const failures: CodeWireFailure[] = [];
  for (const patch of patches) {
    if (patch.op === "appendCode") {
      const ownerId = patch.code.codeOwnerId;
      const before = prior.get(ownerId);
      if (!before) {
        failures.push({
          stage: "wire:appendCode",
          message: `appendCode for ${ownerId} has no previously initialized owner state`,
        });
        continue;
      }
      if (patch.meta?.kind !== "semantic" || patch.at.blockId !== ownerId) {
        failures.push({
          stage: "wire:appendCode",
          message: `appendCode for ${ownerId} is not a semantic patch addressed to its owner`,
        });
      }
      if (
        patch.expectedRevision !== before.source.revision ||
        patch.code.revision !== before.source.revision + 1 ||
        patch.code.codeOwnerId !== ownerId ||
        patch.code.generation !== before.source.generation ||
        patch.code.generation !== initializedGeneration ||
        patch.code.sourceRange.from !== before.source.sourceRange.from
      ) {
        failures.push({
          stage: "wire:appendCode",
          message: `appendCode owner/revision/generation envelope mismatch for ${ownerId}`,
        });
      }
      const sourceFrom = before.source.sourceRange.to;
      const sourceTo = patch.code.sourceRange.to;
      if (
        sourceFrom < 0 ||
        sourceTo < sourceFrom ||
        sourceTo > authoredSource.length ||
        patch.sourceAppend !== authoredSource.slice(sourceFrom, sourceTo) ||
        sourceFrom + patch.sourceAppend.length !== sourceTo
      ) {
        failures.push({
          stage: "wire:appendCode",
          message: `appendCode sourceAppend for ${ownerId} differs from its exact authored source interval`,
        });
      }
      if (
        patch.fromLine !== before.source.completeLineCount ||
        patch.code.completeLineCount < before.source.completeLineCount ||
        patch.code.lineCount !== patch.fromLine + patch.lines.length
      ) {
        failures.push({
          stage: "wire:appendCode",
          message: `appendCode for ${ownerId} did not carry only its bounded changed line tail`,
        });
      }
      const current = store.getCodeBlock(ownerId);
      if (!current) {
        failures.push({ stage: "wire:appendCode", message: `appendCode owner ${ownerId} is absent after apply` });
        continue;
      }
      const changedRows = store.getCodeLines(ownerId, patch.fromLine, patch.code.lineCount);
      if (changedRows.length !== patch.lines.length) {
        failures.push({
          stage: "wire:appendCode",
          message: `appendCode for ${ownerId} installed ${changedRows.length} changed rows for ${patch.lines.length} records`,
        });
      } else {
        for (let offset = 0; offset < patch.lines.length; offset += 1) {
          const sent = patch.lines[offset];
          const stored = changedRows[offset];
          if (
            !sent ||
            !stored ||
            sent.id !== stored.id ||
            sent.index !== stored.index ||
            sent.text !== stored.text ||
            sent.ending !== stored.ending ||
            sent.sourceRange.from !== stored.sourceRange.from ||
            sent.sourceRange.to !== stored.sourceRange.to ||
            sent.sourceRevision !== stored.sourceRevision ||
            sent.isProvisional !== stored.isProvisional ||
            stored.index !== patch.fromLine + offset
          ) {
            failures.push({
              stage: "wire:appendCode",
              message: `appendCode changed record ${offset} for ${ownerId} differs from the bounded prepared store row`,
            });
            break;
          }
        }
      }
      const stableRows = store.getCodeLines(ownerId, 0, before.source.completeLineCount);
      if (
        stableRows.length !== before.completedRows.length ||
        stableRows.some((row, index) => row !== before.completedRows[index])
      ) {
        failures.push({
          stage: "wire:appendCode",
          message: `appendCode for ${ownerId} replaced a previously completed source row`,
        });
      }
    } else if (patch.op === "decorateCode") {
      const ownerId = patch.codeOwnerId;
      const current = store.getCodeBlock(ownerId);
      if (
        patch.meta?.kind !== "enrichment" ||
        patch.at.blockId !== ownerId ||
        !current ||
        patch.generation !== current.source.generation ||
        patch.generation !== initializedGeneration ||
        patch.configurationRevision !== current.configurationRevision
      ) {
        failures.push({
          stage: "wire:decorateCode",
          message: `decorateCode enrichment owner/generation/configuration envelope mismatch for ${ownerId}`,
        });
        continue;
      }
      for (const decoration of patch.decorations) {
        const rows = store.getCodeLines(ownerId, decoration.index, decoration.index + 1);
        const row = rows[0];
        const identityMatches =
          row !== undefined &&
          row.id === decoration.lineId &&
          row.sourceRevision === decoration.sourceRevision &&
          decoration.configurationRevision === patch.configurationRevision;
        const storedDecorationMatches =
          decoration.tokens === null
            ? row?.decoration === undefined
            : row?.decoration?.lineId === decoration.lineId &&
              row?.decoration?.sourceRevision === decoration.sourceRevision &&
              row?.decoration?.configurationRevision === patch.configurationRevision;
        if (!identityMatches || !storedDecorationMatches) {
          failures.push({
            stage: "wire:decorateCode",
            message: `decorateCode row identity/source revision/configuration mismatch for ${ownerId} line ${decoration.index}`,
          });
          break;
        }
      }
    }
  }
  return failures;
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
    return store.getBlocks();
  } finally {
    engine.dispose();
  }
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
  store: RendererStore,
): { ok: boolean; message?: string } {
  const exp = fixture.expectations;
  if (!exp) return { ok: true };

  const allBlocks = collectBlocksRecursively(blocks);
  const codeBlocks = allBlocks.filter((b) => b.type === "code");
  const listBlock = allBlocks.find((b) => b.type === "list");

  if (exp.codeBlocks) {
    const authoredResult = verifyAuthoredCodeExpectations(fixture.source, exp.codeBlocks);
    if (!authoredResult.ok) return authoredResult;

    for (const expCb of exp.codeBlocks) {
      const match = codeBlocks.find((cb) => {
        const meta = cb.payload.meta as Record<string, unknown> | undefined;
        return getCodeBlockLang(meta) === expCb.lang;
      });
      if (!match) {
        return {
          ok: false,
          message: `Missing expected code block with lang='${expCb.lang}' (observed code langs: [${codeBlocks
            .map((codeBlock) => getCodeBlockLang(codeBlock.payload.meta as Record<string, unknown> | undefined))
            .filter(Boolean)
            .join(", ")}])`,
        };
      }

      const codeView = store.getCodeBlock(match.id);
      if (!codeView) {
        return { ok: false, message: `Missing prepared code owner state for block ${match.id}` };
      }
      if (codeView.source.lineCount !== expCb.codeLines.length) {
        return {
          ok: false,
          message: `Code block lang='${expCb.lang}' line count mismatch: actual=${codeView.source.lineCount} expected=${expCb.codeLines.length}`,
        };
      }
      const actualLines = store.getCodeLines(match.id, 0, codeView.source.lineCount);
      if (actualLines.length !== expCb.codeLines.length) {
        return {
          ok: false,
          message: `Bounded prepared code read returned ${actualLines.length} rows for lang='${expCb.lang}'; expected=${expCb.codeLines.length}`,
        };
      }

      for (let lineIndex = 0; lineIndex < expCb.codeLines.length; lineIndex += 1) {
        const expectedLine = expCb.codeLines[lineIndex];
        const actualLine = actualLines[lineIndex];
        if (actualLine?.text !== expectedLine) {
          return {
            ok: false,
            message: `Code block lang='${expCb.lang}' line ${lineIndex} mismatch: actual=${JSON.stringify(actualLine?.text)} expected=${JSON.stringify(expectedLine)}`,
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
    let initializedGeneration: number | undefined;
    let initializationCount = 0;
    const codeInsertions = new Map<string, number>();
    let stopChunking = false;

    const engine = new MarkdownEngine({
      post: (msg: WorkerOut) => {
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
          for (const patch of msg.patches) {
            if (patch.op !== "insertChild" || patch.at.blockId !== PATCH_ROOT_ID || patch.node.type !== "code") continue;
            const insertions = (codeInsertions.get(patch.node.id) ?? 0) + 1;
            codeInsertions.set(patch.node.id, insertions);
            if (insertions > 1) {
              recordDivergence(
                divergences,
                fixture,
                chunking,
                "invariant:duplicate-code-insert",
                msg.tx,
                sessionSink.processed_frontier,
                `Root code owner ${patch.node.id} was inserted ${insertions} times after INITIALIZED.snapshot`,
              );
            }
          }
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
            initializedGeneration ?? -1,
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
      const tokenResult = await verifyCompletedLineTokens(
        allFinalBlocks,
        highlighter,
        engine,
        store,
        fixture.source,
        initializedGeneration ?? -1,
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

async function runRootCodeInitializationTrace(
  fixture: DenseFixture,
  highlighter: Highlighter,
): Promise<DivergenceReport[]> {
  const divergences: DivergenceReport[] = [];
  const plan: ChunkingPlan = { mode: "whole", seed: 0, chunks: [] };
  const followup = "\nPost-initialization source append.\n";
  const fullSource = fixture.source + followup;
  const store = createRendererStore();
  let initializationCount = 0;
  let initializedGeneration: number | undefined;
  let initialCodeOwners = new Set<string>();
  let patchTx = -1;
  const engine = new MarkdownEngine({
    post: (msg: WorkerOut) => {
      if (msg.type === "INITIALIZED") {
        initializationCount += 1;
        if (initializationCount > 1) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:duplicate",
            msg.generation,
            0,
            `Root-code trace received ${initializationCount} INITIALIZED messages`,
          );
        }
        if (msg.schemaVersion !== STREAM_MDX_SCHEMA_VERSION) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:schema",
            msg.generation,
            0,
            `INITIALIZED schema ${msg.schemaVersion} does not match ${STREAM_MDX_SCHEMA_VERSION}`,
          );
        }
        initializedGeneration = msg.generation;
        try {
          store.resetSnapshot(msg.snapshot);
        } catch (error) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:store-reset",
            msg.generation,
            0,
            `INITIALIZED root snapshot could not reset the renderer store: ${String(error)}`,
          );
          return;
        }
        initialCodeOwners = new Set(
          store.getBlocks()
            .filter((block) => block.type === "code" && store.getNode(block.id)?.parentId === PATCH_ROOT_ID)
            .map((block) => block.id),
        );
        return;
      }
      if (msg.type === "PATCH") {
        if (initializationCount !== 1) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:patch-order",
            msg.tx,
            0,
            "PATCH was published outside the single INITIALIZED root generation",
          );
        }
        if (msg.tx <= patchTx) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:fifo",
            msg.tx,
            0,
            `PATCH tx ${msg.tx} did not advance beyond ${patchTx}`,
          );
        }
        patchTx = msg.tx;
        const prior = capturePriorCodeOwners(msg.patches, store);
        try {
          store.applyPatches(msg.patches);
        } catch (error) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:patch-apply",
            msg.tx,
            0,
            `Store rejected root-code followup PATCH: ${String(error)}`,
          );
          return;
        }
        for (const patch of msg.patches) {
          if (
            patch.op === "insertChild" &&
            patch.at.blockId === PATCH_ROOT_ID &&
            initialCodeOwners.has(patch.node.id)
          ) {
            recordDivergence(
              divergences,
              fixture,
              plan,
              "initialized-root:duplicate-code-insert",
              msg.tx,
              fixture.source.length,
              `INITIALIZED code owner ${patch.node.id} was inserted again by PATCH`,
            );
          }
        }
        for (const failure of verifyCodeWirePatches(
          msg.patches,
          prior,
          store,
          fullSource,
          initializedGeneration ?? -1,
        )) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            `initialized-root:${failure.stage}`,
            msg.tx,
            fixture.source.length,
            failure.message,
          );
        }
        return;
      }
      if (msg.type === "ERROR" || msg.type === "RESET") {
        recordDivergence(
          divergences,
          fixture,
          plan,
          `initialized-root:${msg.type.toLowerCase()}`,
          -1,
          0,
          msg.type === "ERROR" ? msg.error.message : msg.reason,
        );
      }
    },
  });

  try {
    await engine.handle({ ...PARITY_INIT, initialContent: fixture.source });
    if (initializationCount !== 1 || initializedGeneration === undefined) {
      recordDivergence(
        divergences,
        fixture,
        plan,
        "initialized-root:missing",
        initializationCount,
        0,
        `Expected one INITIALIZED root snapshot; observed ${initializationCount}`,
      );
      return divergences;
    }

    const blocks = store.getBlocks();
    const rootCodeBlocks = blocks.filter(
      (block) => block.type === "code" && store.getNode(block.id)?.parentId === PATCH_ROOT_ID,
    );
    if (rootCodeBlocks.length !== fixture.expectations?.codeBlocks?.length) {
      recordDivergence(
        divergences,
        fixture,
        plan,
        "initialized-root:code-owner-count",
        0,
        fixture.source.length,
        `INITIALIZED root code owners=${rootCodeBlocks.length} expected=${fixture.expectations?.codeBlocks?.length ?? 0}`,
      );
    }
    for (const block of rootCodeBlocks) {
      const codeView = store.getCodeBlock(block.id);
      if (!codeView) {
        recordDivergence(
          divergences,
          fixture,
          plan,
          "initialized-root:code-state",
          0,
          fixture.source.length,
          `INITIALIZED code owner ${block.id} has no prepared store view`,
        );
        continue;
      }
      if (
        codeView.source.codeOwnerId !== block.id ||
        codeView.source.generation !== initializedGeneration ||
        codeView.source.state !== "closed" ||
        store.getChildren(block.id).length !== 0
      ) {
        recordDivergence(
          divergences,
          fixture,
          plan,
          "initialized-root:code-state",
          0,
          fixture.source.length,
          `INITIALIZED code owner ${block.id} has mismatched owner/generation/state or per-line NodeRecords`,
        );
      }
      const { from, to } = codeView.source.sourceRange;
      if (
        block.payload.range?.from !== from ||
        block.payload.range?.to !== to ||
        block.payload.raw !== fixture.source.slice(from, to)
      ) {
        recordDivergence(
          divergences,
          fixture,
          plan,
          "initialized-root:authored-source",
          0,
          fixture.source.length,
          `INITIALIZED code owner ${block.id} did not cold-export its exact authored source range`,
        );
      }
      const expected = fixture.expectations?.codeBlocks?.find(
        (code) => code.lang === codeView.language,
      );
      if (expected) {
        const rows = store.getCodeLines(block.id, 0, codeView.source.lineCount);
        if (rows.length !== expected.codeLines.length) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:bounded-lines",
            0,
            fixture.source.length,
            `INITIALIZED code owner ${block.id} returned ${rows.length} rows; expected ${expected.codeLines.length}`,
          );
        } else {
          for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index];
            const expectedText = expected.codeLines[index];
            const authoredLine = fixture.source.slice(row.sourceRange.from, row.sourceRange.to);
            const expectedAuthoredLine = `${" ".repeat(expected.openingFenceIndent ?? 0)}${expectedText}`;
            const authoredEnding = fixture.source.slice(
              row.sourceRange.to,
              row.sourceRange.to + row.ending.length,
            );
            if (
              row.text !== expectedText ||
              authoredLine !== expectedAuthoredLine ||
              authoredEnding !== row.ending
            ) {
              recordDivergence(
                divergences,
                fixture,
                plan,
                "initialized-root:authored-line",
                0,
                row.sourceRange.to,
                `INITIALIZED code owner ${block.id} line ${index} lost dedented text or authored source/ending`,
              );
              break;
            }
            if (store.getNode(row.id)) {
              recordDivergence(
                divergences,
                fixture,
                plan,
                "initialized-root:line-record",
                0,
                row.sourceRange.to,
                `INITIALIZED source-owned code line ${row.id} was materialized as a NodeRecord`,
              );
              break;
            }
          }
        }
      }
    }

    const expectationResult = verifyIndependentExpectations(blocks, fixture, store);
    if (!expectationResult.ok) {
      recordDivergence(
        divergences,
        fixture,
        plan,
        "initialized-root:expectations",
        0,
        fixture.source.length,
        expectationResult.message ?? "CommonMark root-code expectation failed",
      );
    }
    const tokenResult = await verifyCompletedLineTokens(
      collectBlocksRecursively(blocks),
      highlighter,
      engine,
      store,
      fixture.source,
      initializedGeneration,
    );
    if (!tokenResult.ok) {
      recordDivergence(
        divergences,
        fixture,
        plan,
        "initialized-root:tokens",
        0,
        fixture.source.length,
        tokenResult.message ?? "INITIALIZED root-code token parity failed",
      );
    }

    const initialRowsByOwner = new Map<string, ReadonlyArray<CodeLineRecord>>();
    for (const block of rootCodeBlocks) {
      const view = store.getCodeBlock(block.id);
      if (view) initialRowsByOwner.set(block.id, store.getCodeLines(block.id, 0, view.source.lineCount));
    }
    await engine.handle({ type: "APPEND", text: followup });
    if (initializationCount !== 1) {
      recordDivergence(
        divergences,
        fixture,
        plan,
        "initialized-root:followup-reset",
        initializationCount,
        fixture.source.length,
        "Tail append promoted the existing initialized root code through a new snapshot generation",
      );
    }
    for (const block of rootCodeBlocks) {
      const view = store.getCodeBlock(block.id);
      const rows = view ? store.getCodeLines(block.id, 0, view.source.lineCount) : [];
      const initialRows = initialRowsByOwner.get(block.id) ?? [];
      if (
        !view ||
        view.source.generation !== initializedGeneration ||
        view.source.state !== "closed" ||
        rows.length !== initialRows.length ||
        rows.some((row, index) => row !== initialRows[index])
      ) {
        recordDivergence(
          divergences,
          fixture,
          plan,
          "initialized-root:followup-stability",
          patchTx,
          fixture.source.length,
          `Post-INITIALIZED tail append changed root code owner ${block.id}`,
        );
      }
    }
  } catch (error) {
    recordDivergence(
      divergences,
      fixture,
      plan,
      "initialized-root:exception",
      -1,
      -1,
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
  } finally {
    engine.dispose();
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
    if (result.measurements.length !== 1) {
      result.divergences.push({
        fixtureId: "scaling-code-lines",
        planMode: "window-append",
        seed,
        stage: "diagnostic:scaling:missing-code-family",
        commitIndex: 0,
        frontier: 0,
        sourcePrefix: "",
        message: `Expected exactly one code-family measurement; observed ${result.measurements.length}`,
      });
    }
    return summarizeFocusedSection(section, startTime, result.divergences, options.jsonPath, result.measurements);
  }
  if (section === "table-scaling") {
    const result = await runScalingDiagnostics({ tableFamilyOnly: true });
    if (result.measurements.length !== 1 || !result.measurements[0]?.tableBoundary) {
      result.divergences.push({
        fixtureId: "scaling-table-rows",
        planMode: "window-append",
        seed,
        stage: "diagnostic:scaling:missing-table-family",
        commitIndex: 0,
        frontier: 0,
        sourcePrefix: "",
        message: `Expected one complete table boundary measurement; observed ${result.measurements.length}`,
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

  console.log(`\n=== StreamMDX ${section === "all" ? "P1 Dense Replay" : "P2 Engine Fixture"} Oracle ===`);
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
