import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { WorkerIn, WorkerOut } from "@stream-mdx/core";
import { cloneBlock } from "@stream-mdx/core";
import {
  MarkdownEngine,
  createRendererStore,
  StreamingMarkdown,
} from "./diagnostic-dist/index.mjs";
import type { StreamingMarkdownHandle } from "@stream-mdx/react";
import { DENSE_FIXTURES, type ChunkingPlan, type DenseFixture } from "./replay-fixtures";
import type { DivergenceReport } from "./replay-fixtures";

const DOM_GLOBALS = [
  "window",
  "document",
  "HTMLElement",
  "Node",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "navigator",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

type DomGlobalSnapshot = {
  [K in (typeof DOM_GLOBALS)[number]]?: PropertyDescriptor;
};

export function captureDomGlobals(): DomGlobalSnapshot {
  const target = globalThis as unknown as Record<string, unknown>;
  const snapshot: DomGlobalSnapshot = {};
  for (const name of DOM_GLOBALS) {
    snapshot[name] = Object.getOwnPropertyDescriptor(target, name);
  }
  return snapshot;
}

export function restoreDomGlobals(snapshot: DomGlobalSnapshot): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const name of DOM_GLOBALS) {
    const descriptor = snapshot[name];
    if (descriptor) {
      Object.defineProperty(target, name, descriptor);
    } else {
      delete target[name];
    }
  }
}

const PARITY_INIT = { type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
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
mdx: { compileMode: "server" }, } satisfies Extract<WorkerIn, { type: "INIT" }>;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await delay(15);
  }
  return predicate();
}

/**
 * Proof of generation advance with exact semantic replacement, post-advance append,
 * and post-disposal rejection to ensure old callbacks cannot mutate store epochs.
 */
export async function runGenerationAndResetInvariants(): Promise<DivergenceReport[]> {
  const divergences: DivergenceReport[] = [];
  const fakeFixture: DenseFixture = {
    id: "invariant-generation-reset",
    name: "Generation & Reset Invariants",
    stage: "lifecycle:generation-reset",
    description: "Asserts exact semantic replacement on INIT, append isolation, and disposed engine rejection",
    source: "# Document 1 Alpha\n\nFirst paragraph text in generation 1.\n",
  };
  const plan: ChunkingPlan = { mode: "whole", seed: 0, chunks: [fakeFixture.source] };

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
    // 1. Initial generation (Doc 1)
    await engine.handle({
      ...PARITY_INIT,
      initialContent: fakeFixture.source,
    });

    const gen1Blocks = store.getBlocks();
    assert.strictEqual(gen1Blocks.length, 2, "Doc 1 must establish exactly 2 blocks (heading + paragraph)");
    assert.strictEqual(gen1Blocks[0].type, "heading", "Doc 1 block 0 must be heading");
    assert.strictEqual(gen1Blocks[1].type, "paragraph", "Doc 1 block 1 must be paragraph");
    assert.strictEqual(gen1Blocks[1].payload.raw, "First paragraph text in generation 1.", "Doc 1 paragraph raw must match exactly");

    const gen1HeadingRange = store.getNode(gen1Blocks[0].id)?.range;
    assert.ok(gen1HeadingRange, "Doc 1 heading must retain its source range");
    assert.strictEqual(
      fakeFixture.source.slice(gen1HeadingRange.from, gen1HeadingRange.to),
      "# Document 1 Alpha",
      "Doc 1 heading range must match the authored source",
    );
    assert.strictEqual(
      gen1Blocks[0].payload.meta?.headingText,
      "Document 1 Alpha",
      "Doc 1 heading semantic text must match",
    );
    const gen2Source = "# Document 2 Beta\n\nSecond paragraph text in generation 2.\n";
    await engine.handle({
      ...PARITY_INIT,
      initialContent: gen2Source,
    });

    const gen2Blocks = store.getBlocks();
    assert.strictEqual(gen2Blocks.length, 2, "Doc 2 must replace store with exactly 2 blocks");
    assert.strictEqual(gen2Blocks[0].type, "heading", "Doc 2 block 0 must be heading");
    const gen2HeadingRange = store.getNode(gen2Blocks[0].id)?.range;
    assert.ok(gen2HeadingRange, "Doc 2 heading must retain its source range");
    assert.strictEqual(
      gen2Source.slice(gen2HeadingRange.from, gen2HeadingRange.to),
      "# Document 2 Beta",
      "Doc 2 heading range must match the authored source",
    );
    assert.strictEqual(
      gen2Blocks[0].payload.meta?.headingText,
      "Document 2 Beta",
      "Doc 2 heading semantic text must match",
    );
    assert.strictEqual(gen2Blocks[1].type, "paragraph", "Doc 2 block 1 must be paragraph");
    assert.strictEqual(gen2Blocks[1].payload.raw, "Second paragraph text in generation 2.", "Doc 2 paragraph raw must match exactly");


    // 3. Append to generation 2
    await engine.handle({ type: "APPEND", text: "\nThird paragraph appended to generation 2.\n" });
    const postAppendBlocks = store.getBlocks();
    assert.strictEqual(postAppendBlocks.length, 3, "Gen 2 post-append must have exactly 3 blocks");
    assert.strictEqual(postAppendBlocks[2].type, "paragraph", "Appended block must be paragraph");
    assert.strictEqual(
      postAppendBlocks[2].payload.raw,
      "Third paragraph appended to generation 2.",
      "Appended paragraph raw must match exactly",
    );

    // Queued work and future calls cannot publish after disposal.
    const versionBefore = store.getVersion();
    const blocksBefore = store.getBlocks().map(cloneBlock);
    const queuedAppend = engine.handle({ type: "APPEND", text: "\nQueued obsolete paragraph.\n" });
    engine.dispose();
    await queuedAppend;
    await engine.handle({ type: "APPEND", text: "\nStale append sent to disposed engine.\n" });

    assert.strictEqual(
      store.getVersion(),
      versionBefore,
      "Disposed engine must not mutate store version",
    );
    assert.deepStrictEqual(
      store.getBlocks().map((b) => b.payload.raw),
      blocksBefore.map((b) => b.payload.raw),
      "Disposed engine must not mutate store content",
    );

  } catch (err) {
    recordDivergence(
      divergences,
      fakeFixture,
      plan,
      "invariant:generation",
      0,
      0,
      `Generation proof failure: ${String(err)}`,
    );
  } finally {
    engine.dispose();
  }

  return divergences;
}

/**
 * Mounted public StreamingMarkdown proof for the native main-thread root-code route.
 * This deliberately sets mdx:false; the pre-P9 legacy MDX bridge and any default-route
 * extra cold work remain unmeasured until that integration lands.
 */
export async function runLiveReactLayer(): Promise<DivergenceReport[]> {
  const divergences: DivergenceReport[] = [];
  const fixture = DENSE_FIXTURES.find((candidate) => candidate.id === "fence-indent-multiline");
  assert.ok(fixture, "the existing fence-indent fixture is required");
  const plan: ChunkingPlan = { mode: "whole", seed: 0, chunks: [fixture.source] };
  console.log(
    "Mounted-code scope: native route with mdx:false; legacy MDX bridge/default-route extra cold work remains unresolved.",
  );
  const snapshot = captureDomGlobals();
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const target = globalThis as unknown as Record<string, unknown>;
  target.window = dom.window;
  target.document = dom.window.document;
  target.HTMLElement = dom.window.HTMLElement;
  target.Node = dom.window.Node;
  target.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  target.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  target.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: dom.window.navigator,
  });

  let root: Root | undefined;
  let unmounted = false;
  let unsubscribe: (() => void) | undefined;
  try {
    const container = dom.window.document.getElementById("root");
    assert.ok(container, "root element exists in JSDOM");
    root = createRoot(container);
    const handleRef = createRef<StreamingMarkdownHandle>();
    let flushCount = 0;
    await act(async () => {
      root?.render(
        createElement(StreamingMarkdown, {
          ref: handleRef,
          engine: "main-thread",
          prewarmLangs: ["typescript", "javascript", "markdown"],
          themes: { dark: "github-dark", light: "github-light" },
          features: {
            footnotes: true,
            html: true,
            mdx: false,
            tables: true,
            callouts: false,
            math: true,
            formatAnticipation: { inline: true, mathInline: true, mathBlock: true, html: true, mdx: false, regex: false },
            codeHighlighting: "incremental",
            liveCodeHighlighting: true,
            liveTokenization: true,
            emitHighlightTokens: true,
            emitDiffBlocks: false,
            themes: { dark: "github-dark", light: "github-light" },
          },
        }),
      );
    });

    const mounted = await waitForCondition(
      () => handleRef.current !== null && Boolean(handleRef.current.getState().workerReady),
    );
    if (!mounted || !handleRef.current) throw new Error("StreamingMarkdown failed to mount its real inline engine");
    const handle = handleRef.current;
    unsubscribe = handle.onFlush(() => {
      flushCount += 1;
    });
    const idleAppend = async (text: string): Promise<void> => {
      await act(async () => {
        handle.append(text);
        await handle.waitForIdle();
        await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
      });
    };

    const source = fixture.source;
    const stableLineStart = source.indexOf("    id: string;");
    const laterLineStart = source.indexOf("    name: string;", stableLineStart);
    const closingFenceStart = source.indexOf("```\n\n", laterLineStart);
    assert.ok(stableLineStart > 0 && laterLineStart > stableLineStart && closingFenceStart > laterLineStart);
    await idleAppend(source.slice(0, stableLineStart));

    const store = handle.getState().store;
    const rootCode = store.getBlocks().find((block) => block.type === "code");
    assert.ok(rootCode, "fixture establishes a root-owned code block");
    const initialView = store.getCodeBlock(rootCode.id);
    assert.ok(initialView, "root code owner has a prepared view");
    assert.equal(initialView.source.state, "open");
    assert.equal(initialView.source.completeLineCount, 1);
    const completedRow = store.getCodeLines(rootCode.id, 0, 1)[0];
    assert.ok(completedRow);
    assert.equal(completedRow.text, "interface User {");
    assert.equal(source.slice(completedRow.sourceRange.from, completedRow.sourceRange.to), `  ${completedRow.text}`);
    assert.equal(completedRow.ending, "\n");
    const renderedCodeRow = (index: number): HTMLElement | null =>
      container.querySelectorAll<HTMLElement>("pre code > .line").item(index);
    const completedRowElement = renderedCodeRow(completedRow.index);
    assert.ok(completedRowElement, "native code renderer exposes the completed row");
    assert.equal(
      completedRowElement.textContent,
      completedRow.text,
      "native code renderer exposes the authored completed row text",
    );
    assert.equal(container.querySelector("pre")?.textContent?.includes(completedRow.text), true);
    const generation = initialView.source.generation;

    const tailUpdate = source.slice(stableLineStart, laterLineStart);
    const remainingOpenCode = source.slice(laterLineStart, closingFenceStart);
    const closeAndFollowingProse = source.slice(closingFenceStart);
    await idleAppend(tailUpdate);
    assert.strictEqual(
      store.getCodeLines(rootCode.id, 0, 1)[0]?.id,
      completedRow.id,
      "typed code owner retains the completed source row ID after tail updates",
    );
    assert.strictEqual(store.getCodeLines(rootCode.id, 0, 1)[0], completedRow);
    assert.strictEqual(
      renderedCodeRow(completedRow.index),
      completedRowElement,
      "completed row DOM identity survives tail updates",
    );
    assert.equal(store.getCodeBlock(rootCode.id)?.source.generation, generation);
    await idleAppend(remainingOpenCode);
    assert.strictEqual(
      store.getCodeLines(rootCode.id, 0, 1)[0]?.id,
      completedRow.id,
      "typed code owner retains the completed source row ID while appending rows",
    );
    assert.strictEqual(store.getCodeLines(rootCode.id, 0, 1)[0], completedRow);
    assert.strictEqual(renderedCodeRow(completedRow.index), completedRowElement);
    await idleAppend(closeAndFollowingProse);
    assert.equal(store.getCodeBlock(rootCode.id)?.source.state, "finalized", "a complete closing fence settles the code owner");

    const authored = fixture.expectations?.codeBlocks?.[0];
    assert.ok(authored, "fixture includes independently specified CommonMark code expectations");
    const finalView = store.getCodeBlock(rootCode.id);
    assert.ok(finalView);
    const finalRows = store.getCodeLines(rootCode.id, 0, authored.codeLines.length);
    assert.deepStrictEqual(finalRows.map((row) => row.text), authored.codeLines);
    assert.deepStrictEqual(
      Array.from(container.querySelectorAll<HTMLElement>("pre code > .line"), (row) => row.textContent),
      authored.codeLines,
      "native code DOM rows must match the authored code lines",
    );
    assert.equal(finalView.language, authored.lang);
    assert.equal(finalView.source.generation, generation);
    for (const row of finalRows) {
      assert.equal(source.slice(row.sourceRange.from, row.sourceRange.to), `  ${row.text}`);
      assert.equal(row.ending, "\n");
    }
    assert.strictEqual(finalRows[0], completedRow);
    const rawExport = store.getBlocks().find((block) => block.id === rootCode.id);
    assert.ok(rawExport);
    assert.equal(
      source.slice(finalView.source.sourceRange.from, finalView.source.sourceRange.to),
      rawExport.payload.raw,
      "cold block export is an exact authored-source range",
    );

    await act(async () => {
      handle.finalize();
      const finalizationApplied = await waitForCondition(
        () => store.getCodeBlock(rootCode.id)?.source.state === "finalized",
      );
      assert.ok(finalizationApplied, "root code finalization PATCH was not applied");
      await handle.waitForIdle();
    });
    assert.equal(store.getCodeBlock(rootCode.id)?.source.state, "finalized");
    assert.equal(store.getCodeBlock(rootCode.id)?.source.generation, generation);
    assert.strictEqual(
      renderedCodeRow(completedRow.index),
      completedRowElement,
      "completed row DOM identity survives finalization",
    );
    const versionBeforeDisposal = store.getVersion();
    const rowsBeforeDisposal = store.getCodeLines(rootCode.id, 0, authored.codeLines.length);
    const flushesBeforeDisposal = flushCount;
    await act(async () => root?.unmount());
    unmounted = true;
    handle.append("\npost-disposal mutation must be ignored\n");
    await handle.waitForIdle();
    await delay(20);
    assert.equal(store.getVersion(), versionBeforeDisposal, "disposed native engine cannot mutate its store");
    assert.deepStrictEqual(store.getCodeLines(rootCode.id, 0, authored.codeLines.length), rowsBeforeDisposal);
    assert.equal(flushCount, flushesBeforeDisposal, "disposed handle emits no later flush");
  } catch (err) {
    recordDivergence(
      divergences,
      fixture,
      plan,
      "lifecycle:native-root-code",
      0,
      fixture.source.length,
      `Native StreamingMarkdown root-code proof failure (mdx:false; legacy MDX bridge not covered): ${String(err)}`,
    );
  } finally {
    unsubscribe?.();
    if (root && !unmounted) root.unmount();
    restoreDomGlobals(snapshot);
    dom.window.close();
  }

  return divergences;
}
