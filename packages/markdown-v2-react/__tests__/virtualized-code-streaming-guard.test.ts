import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Block, WorkerOut } from "@stream-mdx/core";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { CodeHighlightRequestContext, type CodeHighlightRequest } from "../src/renderer/code-highlight-context";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";
import type { BlockComponents } from "../src/types";

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(10);
  }
}

async function testInlineWorkerCustomCodeHighlighting(): Promise<void> {
  const authoredCode = Array.from({ length: 64 }, (_, index) => `const item${index} = ${index};`).join("\n");
  const markdown = `\`\`\`ts\n${authoredCode}\n\`\`\``;
  const expectedLineCount = authoredCode.split("\n").length;
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const globalKeys = ["window", "document", "HTMLElement", "Node", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
  const previousGlobals = Object.fromEntries(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof globalKeys)[number], PropertyDescriptor | undefined>;
  let cancelledFrames = 0;
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: (id: number) => {
      cancelledFrames++;
      window.cancelAnimationFrame(id);
    },
    ResizeObserver: ResizeObserverStub,
  });

  const store = createRendererStore();
  const worker = createInlineEngineWorker();
  let finalized = false;
  let workerError: Error | null = null;
  worker.onmessage = (event: MessageEvent<WorkerOut>) => {
    const message = event.data;
    if (message.type === "INITIALIZED") store.reset(message.blocks);
    else if (message.type === "PATCH") store.applyPatches(message.patches);
    else if (message.type === "FINALIZED") finalized = true;
    else if (message.type === "ERROR") workerError = new Error(message.error.message);
  };
  const container = window.document.getElementById("root");
  assert.ok(container, "missing worker-backed test root container");
  let root: Root | null = null;
  try {
    worker.postMessage({
      type: "INIT",
      initialContent: "",
      prewarmLangs: [],
      docPlugins: {
        html: false,
        mdx: false,
        tables: false,
        math: false,
        outputMode: "html",
        lazyTokenization: { enabled: true, thresholdLines: 50 },
      },
    });
    worker.postMessage({ type: "APPEND", text: markdown });
    worker.postMessage({ type: "FINALIZE" });
    await waitFor(() => finalized || workerError !== null, "inline engine finalizes the custom-code fixture");
    assert.equal(workerError, null, workerError?.message);
    const block = store.getBlocks().find((candidate) => candidate.type === "code");
    assert.ok(block, "inline worker should parse the authored code fence");
    assert.equal(block.payload.meta?.lazyTokenization, true, "fixture should use real lazy tokenization");
    assert.equal(block.payload.meta?.lazyTokenizedUntil, 0, "fixture must start without highlighted lines");

    const customCode: BlockComponents["code"] = ({ meta }) => {
      const highlightedLines = Array.isArray(meta?.highlightedLines) ? meta.highlightedLines : [];
      return React.createElement(
        "div",
        { "data-custom-code": "true" },
        React.createElement(
          "pre",
          { "data-authored-source": "true" },
          typeof meta?.code === "string" ? meta.code : "",
        ),
        React.createElement(
          "code",
          { "data-highlighted-code": "true" },
          ...highlightedLines.map((line, index) =>
            typeof line === "string"
              ? React.createElement("span", {
                  key: index,
                  "data-highlighted-line": index,
                  dangerouslySetInnerHTML: { __html: line },
                })
              : null,
          ),
        ),
      );
    };
    const registry = new ComponentRegistry({ code: customCode });
    const requests: CodeHighlightRequest[] = [];
    root = createRoot(container);
    root.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(
          CodeHighlightRequestContext.Provider,
          {
            value: (request) => {
              requests.push({ ...request });
              worker.postMessage({
                type: "TOKENIZE_RANGE",
                blockId: request.blockId,
                startLine: request.startLine,
                endLine: request.endLine,
                priority: request.priority,
              });
            },
          },
          React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }),
        ),
      ),
    );

    await waitFor(() => {
      const updated = store.getBlocks().find((candidate) => candidate.id === block.id);
      const meta = updated?.payload.meta;
      return meta?.lazyTokenizedUntil === expectedLineCount
        && container.querySelector('[data-highlighted-code] [data-highlighted-line] span[style]') !== null;
    }, "custom component receives real worker-highlighted code after lazy completion");

    const updated = store.getBlocks().find((candidate) => candidate.id === block.id);
    assert.equal(updated?.payload.meta?.lazyTokenizedUntil, expectedLineCount);
    assert.equal(container.querySelector("[data-authored-source]")?.textContent, authoredCode);
    assert.equal(
      container.querySelector('[data-highlighted-code] [data-highlighted-line] span[style]')?.textContent,
      "const",
      "custom code output should contain actual syntax-highlighted token markup",
    );
    assert.deepStrictEqual(
      requests.map(({ blockId, startLine, endLine, priority, reason }) => ({ blockId, startLine, endLine, priority, reason })),
      [{ blockId: block.id, startLine: 0, endLine: expectedLineCount, priority: "visible", reason: "finalize-full" }],
      "strict-effect replay should leave one full-range request",
    );
    assert.ok(cancelledFrames > 0, "StrictMode effect replay cancels the abandoned animation frame");
  } finally {
    root?.unmount();
    worker.terminate();
    window.close();
    for (const key of globalKeys) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function renderBlock(
  block: Block,
  registry = new ComponentRegistry(),
): Promise<{ pre: HTMLElement; requests: Array<Record<string, unknown>> }> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  (globalThis as any).window = window;
  (globalThis as any).document = window.document;
  (globalThis as any).HTMLElement = window.HTMLElement;
  (globalThis as any).Node = window.Node;
  (globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
  (globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  (globalThis as any).ResizeObserver = ResizeObserverStub;

  const store = createRendererStore([block]);
  const container = window.document.getElementById("root");
  const requests: Array<Record<string, unknown>> = [];
  assert.ok(container, "missing test root container");

  const root = createRoot(container);
  root.render(
    React.createElement(
      CodeHighlightRequestContext.Provider,
      { value: (request) => requests.push({ ...request }) },
      React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }),
    ),
  );
  await sleep(60);
  for (let attempt = 0; attempt < 10 && requests.length === 0; attempt += 1) {
    await sleep(20);
  }

  const pre = container.querySelector('pre[data-code-block="true"]') as HTMLElement | null;
  assert.ok(pre, "expected code block to render");
  root.unmount();
  return { pre, requests };
}

async function runVirtualizedCodeStreamingGuardTest(): Promise<void> {
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "virtualized-code.md");
  const raw = fs.readFileSync(fixturePath, "utf8");

  const finalizedLazyBlock: Block = {
    id: "code-block-lazy",
    type: "code",
    isFinalized: true,
    payload: {
      raw,
      meta: { lang: "ts", lazyTokenization: true, code: raw.replace(/^```[^\n]*\n/, "").replace(/\n```$/, "") },
    },
  };
  const expectedLineCount = finalizedLazyBlock.payload.meta?.code?.split("\n").length ?? 0;
  const { pre, requests } = await renderBlock(finalizedLazyBlock);
  assert.strictEqual(pre.getAttribute("data-code-virtualized"), "false", "lazy-tokenized code must remain non-virtualized");
  assert.ok(requests.length > 0, "finalized lazy non-virtualized code should request a full highlight pass");
  const fullRequest = requests.find((request) => request.blockId === finalizedLazyBlock.id);
  assert.ok(fullRequest, "expected a lazy highlight request for the finalized lazy code block");
  assert.deepStrictEqual(
    { startLine: fullRequest?.startLine, endLine: fullRequest?.endLine, priority: fullRequest?.priority, reason: fullRequest?.reason },
    { startLine: 0, endLine: expectedLineCount, priority: "visible", reason: "finalize-full" },
    "finalized lazy non-virtualized code should request the entire code range",
  );

  await testInlineWorkerCustomCodeHighlighting();

  const eagerBlock: Block = {
    id: "code-block-eager",
    type: "code",
    isFinalized: true,
    payload: {
      raw,
      meta: { lang: "ts" },
    },
  };

  const { pre: eagerPre } = await renderBlock(eagerBlock);
  assert.strictEqual(eagerPre.getAttribute("data-code-virtualized"), "true", "eager finalized code should still virtualize");
}

runVirtualizedCodeStreamingGuardTest()
  .then(() => {
    console.log("virtualized-code-streaming-guard test passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

