import assert from "node:assert";
import { createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { Patch, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { cloneBlock } from "@stream-mdx/core";
import {
  MarkdownEngine,
  createRendererStore,
  StreamingMarkdown,
} from "./diagnostic-dist/index.mjs";
import type { StreamingMarkdownHandle } from "@stream-mdx/react";
import type { ChunkingPlan, DenseFixture } from "./replay-fixtures";
import type { DivergenceReport } from "./scaling-diagnostics";

const DOM_GLOBALS = [
  "window",
  "document",
  "HTMLElement",
  "Node",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "navigator",
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
        store.reset(msg.blocks);
      } else if (msg.type === "PATCH") {
        store.applyPatches(msg.patches as Patch[]);
      }
    },
  });

  try {
    // 1. Initial generation (Doc 1)
    await engine.handle({
      ...PARITY_INIT,
      initialContent: "# Document 1 Alpha\n\nFirst paragraph text in generation 1.\n",
    });

    const gen1Blocks = store.getBlocks();
    assert.strictEqual(gen1Blocks.length, 2, "Doc 1 must establish exactly 2 blocks (heading + paragraph)");
    assert.strictEqual(gen1Blocks[0].type, "heading", "Doc 1 block 0 must be heading");
    assert.strictEqual(gen1Blocks[0].payload.raw, "Document 1 Alpha", "Doc 1 heading raw must match normalized text");
    assert.strictEqual(gen1Blocks[1].type, "paragraph", "Doc 1 block 1 must be paragraph");
    assert.strictEqual(gen1Blocks[1].payload.raw, "First paragraph text in generation 1.", "Doc 1 paragraph raw must match exactly");

    // 2. Advance generation via INIT with complete semantic replacement (Doc 2)
    await engine.handle({
      ...PARITY_INIT,
      initialContent: "# Document 2 Beta\n\nSecond paragraph text in generation 2.\n",
    });

    const gen2Blocks = store.getBlocks();
    assert.strictEqual(gen2Blocks.length, 2, "Doc 2 must replace store with exactly 2 blocks");
    assert.strictEqual(gen2Blocks[0].type, "heading", "Doc 2 block 0 must be heading");
    assert.strictEqual(gen2Blocks[0].payload.raw, "Document 2 Beta", "Doc 2 heading raw must match normalized text");
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
 * Live Mounted React Layer under JSDOM createRoot.
 * Exercises real append/update/unmount lifecycles, store subscriptions,
 * and exact authored DOM elements without SSR-only shortcuts.
 */
export async function runLiveReactLayer(): Promise<DivergenceReport[]> {
  const divergences: DivergenceReport[] = [];
  const fakeFixture: DenseFixture = {
    id: "live-react-layer",
    name: "Live React Layer",
    stage: "lifecycle:react-layer",
    description: "Validates mounted React createRoot lifecycle, DOM updates, and ambient cleanup",
    source: "# React Head\n\n| H1 | H2 |\n| :--- | :--- |\n| R1 | R2 |\n\n```typescript\nconst initial = 1;\n",
  };
  const plan: ChunkingPlan = { mode: "whole", seed: 0, chunks: [fakeFixture.source] };

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
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: dom.window.navigator,
  });

  try {
    const container = dom.window.document.getElementById("root");
    assert.ok(container, "root element exists in JSDOM");
    const root = createRoot(container);

    try {
      const handleRef = createRef<StreamingMarkdownHandle>();
      root.render(
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

      // Wait for handle and worker initialization
      const handleReady = await waitForCondition(
        () => handleRef.current !== null && Boolean(handleRef.current.getState?.()?.workerReady),
        5000,
      );
      if (!handleReady || !handleRef.current) {
        recordDivergence(divergences, fakeFixture, plan, "react:mount", 0, 0, "StreamingMarkdown handleRef failed to mount");
        return divergences;
      }

      // Initial feed
      handleRef.current.append("# React Head\n\n| H1 | H2 |\n| :--- | :--- |\n| R1 | R2 |\n\n```typescript\nconst initial = 1;\n");

      // Verify DOM content presence
      const headingRendered = await waitForCondition(() => {
        const h1 = container.querySelector("h1");
        return h1 !== null && (h1.textContent ?? "").includes("React Head");
      }, 5000);

      if (!headingRendered) {
        recordDivergence(divergences, fakeFixture, plan, "react:append", 0, 0, "Rendered DOM missing expected heading content");
      }

      // Verify code block rendered
      const codeRendered = await waitForCondition(() => {
        const pre = container.querySelector("pre");
        return pre !== null && (pre.textContent ?? "").includes("const initial = 1;");
      }, 5000);

      if (!codeRendered) {
        recordDivergence(divergences, fakeFixture, plan, "react:code", 0, 0, "Rendered DOM missing expected code content");
      }

      // Verify table rendered
      const tableRendered = await waitForCondition(() => {
        const td = container.querySelector("td");
        return td !== null && (td.textContent ?? "").includes("R1");
      }, 5000);

      if (!tableRendered) {
        recordDivergence(divergences, fakeFixture, plan, "react:table", 0, 0, "Rendered DOM missing expected table cells");
      }

      // Complete the existing streaming code block.
      handleRef.current.append("const appended = 2;\n```\n\n");

      const codeUpdated = await waitForCondition(() => {
        const pre = container.querySelector("pre");
        return pre !== null && (pre.textContent ?? "").includes("const appended = 2;");
      }, 5000);

      if (!codeUpdated) {
        recordDivergence(divergences, fakeFixture, plan, "react:append-code", 0, 0, "Rendered DOM failed to update with appended code line");
      }

      // Restart document session through public handle and wait for new worker session to be ready
      handleRef.current.restart();
      const resetReady = await waitForCondition(
        () => Boolean(handleRef.current?.getState?.()?.workerReady) && (handleRef.current?.getState?.()?.blocks.length ?? 0) === 0,
        5000,
      );
      if (!resetReady || !handleRef.current) {
        recordDivergence(divergences, fakeFixture, plan, "react:reset", 0, 0, "StreamingMarkdown session restart failed to become ready");
        return divergences;
      }
      handleRef.current.append("# Clean Replacement\n\nFresh paragraph after reset.\n");
      const resetCompleted = await waitForCondition(() => {
        const h1 = container.querySelector("h1");
        const hasOld = container.textContent?.includes("React Head") ?? false;
        return h1 !== null && (h1.textContent ?? "").includes("Clean Replacement") && !hasOld;
      }, 5000);

      if (!resetCompleted) {
        recordDivergence(divergences, fakeFixture, plan, "react:reset", 0, 0, "DOM failed to cleanly replace content on reset");
      }
    } finally {
      root.unmount();
    }
  } finally {
    restoreDomGlobals(snapshot);
    dom.window.close();
  }

  return divergences;
}
