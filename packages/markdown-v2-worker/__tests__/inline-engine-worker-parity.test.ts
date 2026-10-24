import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import type { WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createRendererStore, type RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComponentRegistry } from "../../markdown-v2-react/src/components";
import { BlockNodeRenderer } from "../../markdown-v2-react/src/renderer/node-views";
import { createInlineEngineWorker } from "../src/engine/index";
import { createWorkerThread } from "../src/node/index";

function ensureDom(): void {
  if (typeof window !== "undefined") {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
  });
  // React DOM reads the bare global navigator once a window exists (Node 20 has no global navigator).
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: dom.window.navigator });
}

const FIXTURE = `# Section Heading

Here is a paragraph with a footnote[^ref] and **bold** text.

- First item
- Second item
- Third item

| Name | Score |
| :--- | :--- |
| Alice | 100 |
| Bob | 85 |

\`\`\`ts
function add(a: number, b: number): number {
  return a + b;
}
\`\`\`

[^ref]: Footnote definition content.
`;

function runWorkerStream(
  worker: {
    postMessage: (msg: WorkerIn) => void;
    onMessage: (handler: (msg: WorkerOut) => void) => void;
  },
  fixture: string,
  chunkSize: number,
  docPlugins: Extract<WorkerIn, { type: "INIT" }>["docPlugins"],
): Promise<{ store: RendererStore; messages: WorkerOut[] }> {
  return new Promise((resolve, reject) => {
    ensureDom();
    const store = createRendererStore();
    const messages: WorkerOut[] = [];

    worker.onMessage((msg) => {
      messages.push(msg);
      if (msg.type === "INITIALIZED") {
        store.resetSnapshot(msg.snapshot);
      } else if (msg.type === "PATCH") {
        store.applyPatches(msg.patches, { captureMetrics: false });
      } else if (msg.type === "FINALIZED") {
        resolve({ store, messages });
      } else if (msg.type === "ERROR") {
        reject(new Error(`Worker error: ${msg.error.message}`));
      }
    });

    const initMsg: WorkerIn = { type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
    prewarmLangs: ["ts", "typescript"],
    docPlugins, };
    worker.postMessage(initMsg);

    for (let i = 0; i < fixture.length; i += chunkSize) {
      worker.postMessage({ type: "APPEND", text: fixture.slice(i, i + chunkSize) });
    }

    worker.postMessage({ type: "FINALIZE" });
  });
}

function renderStore(store: RendererStore): string {
  const registry = new ComponentRegistry();
  return renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      store.getBlocks().map((block) =>
        React.createElement(BlockNodeRenderer, { key: block.id, store, blockId: block.id, registry }),
      ),
    ),
  );
}

async function runParitySession(enabled: boolean): Promise<void> {
  ensureDom();
  const inlineWorker = createInlineEngineWorker();
  const threadWorker = createWorkerThread({ stdout: true, stderr: true });

  try {
    const chunkSize = 20;
    const docPlugins = { footnotes: enabled, tables: enabled };

    const inlinePromise = runWorkerStream(
      {
        postMessage: (msg) => inlineWorker.postMessage(msg),
        onMessage: (handler) => {
          inlineWorker.onmessage = (e: MessageEvent<WorkerOut>) => handler(e.data);
        },
      },
      FIXTURE,
      chunkSize,
      docPlugins,
    );

    const threadPromise = runWorkerStream(
      {
        postMessage: (msg) => threadWorker.postMessage(msg),
        onMessage: (handler) => {
          threadWorker.on("message", handler);
        },
      },
      FIXTURE,
      chunkSize,
      docPlugins,
    );

    const [inlineResult, threadResult] = await Promise.all([inlinePromise, threadPromise]);

    const inlineBlocks = inlineResult.store.getBlocks();
    const threadBlocks = threadResult.store.getBlocks();

    for (const result of [inlineResult, threadResult]) {
      assert.strictEqual(result.messages.at(-1)?.type, "FINALIZED", "comparison must wait for terminal FINALIZED");
      const blocks = result.store.getBlocks();
      const types = blocks.map((block) => block.type);
      for (const type of ["heading", "paragraph", "list", "code"]) {
        assert.ok(types.includes(type), `missing ${type} block`);
      }
      assert.strictEqual(types.includes("table"), enabled, "table configuration must reach the engine");
      assert.strictEqual(types.includes("footnotes"), enabled, "footnote configuration must reach the engine");

      const document = new JSDOM(renderStore(result.store)).window.document;
      assert.strictEqual(document.querySelector("h1")?.textContent, "Section Heading");
      assert.strictEqual(document.querySelector("strong")?.textContent, "bold");
      assert.ok(document.querySelector("pre")?.textContent?.includes("return a + b;"));
      assert.strictEqual(document.querySelectorAll("table").length, enabled ? 1 : 0);
      assert.strictEqual(document.querySelectorAll('sup a[href="#fn:1"]').length, enabled ? 1 : 0);
      if (enabled) {
        assert.strictEqual(document.querySelector("tbody td")?.textContent, "Alice");
        assert.ok(document.querySelector('[id="fn:1"]')?.textContent?.includes("Footnote definition content."));
      } else {
        assert.ok(document.body.textContent?.includes("[^ref]"), "disabled footnotes must remain literal text");
        assert.ok(document.body.textContent?.includes("| Alice | 100 |"), "disabled tables must remain literal text");
      }
    }
    assert.strictEqual(renderStore(inlineResult.store), renderStore(threadResult.store), "final consumer DOM must match");

    // All blocks must be finalized
    assert.ok(inlineBlocks.every((b) => b.isFinalized), "all inline blocks must be finalized");
    assert.ok(threadBlocks.every((b) => b.isFinalized), "all thread blocks must be finalized");

    // Assert that the streamed output (final blocks) deep-equals between inline and hosted worker
    assert.deepStrictEqual(
      inlineBlocks,
      threadBlocks,
      "inline worker output must deep-equal real worker_threads hosted worker",
    );

    // Verify initial message was emitted by both
    const inlineInit = inlineResult.messages.find((m) => m.type === "INITIALIZED");
    const threadInit = threadResult.messages.find((m) => m.type === "INITIALIZED");
    assert.ok(inlineInit, "inline worker missing INITIALIZED message");
    assert.ok(threadInit, "thread worker missing INITIALIZED message");
    assert.deepStrictEqual(inlineInit.snapshot, threadInit.snapshot, "initial root snapshots must match");

    // Verify neither worker produced errors
    assert.strictEqual(
      inlineResult.messages.some((m) => m.type === "ERROR"),
      false,
      "inline worker should not produce errors",
    );
    assert.strictEqual(
      threadResult.messages.some((m) => m.type === "ERROR"),
      false,
      "thread worker should not produce errors",
    );
  } finally {
    inlineWorker.terminate();
    await threadWorker.terminate();
  }
}

async function runParityTest(): Promise<void> {
  await runParitySession(true);
  await runParitySession(false);
}

runParityTest()
  .then(() => {
    console.log("inline worker parity test passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
