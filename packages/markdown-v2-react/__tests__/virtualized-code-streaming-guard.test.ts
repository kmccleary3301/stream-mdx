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
  const replacementCode = authoredCode;
  const replacementMarkdown = markdown;
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const globalKeys = ["window", "document", "HTMLElement", "Node", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
  const previousGlobals = Object.fromEntries(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof globalKeys)[number], PropertyDescriptor | undefined>;
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: ResizeObserverStub,
  });

  const store = createRendererStore();
  const worker = createInlineEngineWorker();
  let finalized = false;
  let replacementRequested = false;
  let replacementRequest: CodeHighlightRequest | null = null;
  let workerError: Error | null = null;
  worker.onmessage = (event: MessageEvent<WorkerOut>) => {
    const message = event.data;
    if (message.type === "INITIALIZED") {
      store.reset(message.blocks);
      if (replacementRequested) worker.postMessage({ type: "FINALIZE" });
    } else if (message.type === "PATCH") store.applyPatches(message.patches);
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
    root = createRoot(container);
    root.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(
          CodeHighlightRequestContext.Provider,
          {
            value: (request) => {
              if (replacementRequested) {
                replacementRequest = request;
                return;
              }
              worker.postMessage({
                type: "TOKENIZE_RANGE",
                blockId: request.blockId,
                startLine: request.startLine,
                endLine: request.endLine,
                priority: request.priority,
              });
              replacementRequested = true;
              finalized = false;
              worker.postMessage({
                type: "INIT",
                initialContent: replacementMarkdown,
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
            },
          },
          React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }),
        ),
      ),
    );

    await waitFor(() => replacementRequest !== null, "replacement consumer requests a fresh lazy range");
    const replacementBeforeHighlight = store.getBlocks().find((candidate) => candidate.type === "code");
    assert.ok(replacementBeforeHighlight, "replacement INIT should retain the code block");
    assert.equal(replacementBeforeHighlight.payload.meta?.lazyTokenizedUntil, 0, "invalidated first-document work must not commit to the replacement");
    assert.equal(
      container.querySelector('[data-highlighted-code] [data-highlighted-line]'),
      null,
      "replacement output stays unhighlighted until its own range is sent",
    );
    const pendingReplacementRequest = replacementRequest;
    assert.ok(pendingReplacementRequest, "replacement range request should be captured");
    // Check invalidated work before forwarding the replacement's own real worker request.
    worker.postMessage({
      type: "TOKENIZE_RANGE",
      blockId: pendingReplacementRequest.blockId,
      startLine: pendingReplacementRequest.startLine,
      endLine: pendingReplacementRequest.endLine,
      priority: pendingReplacementRequest.priority,
    });
    await waitFor(() => {
      const updated = store.getBlocks().find((candidate) => candidate.id === block.id);
      const meta = updated?.payload.meta;
      return meta?.lazyTokenizedUntil === expectedLineCount
        && container.querySelector('[data-highlighted-code] [data-highlighted-line] span[style]') !== null;
    }, "custom component receives real worker-highlighted code after lazy completion");

    const replacementBlock = store.getBlocks().find((candidate) => candidate.type === "code");
    assert.ok(replacementBlock, "replacement INIT should retain the code block");
    assert.equal(replacementBlock.id, block.id, "replacement INIT should reuse the code block ID");
    assert.equal(replacementBlock.payload.meta?.lazyTokenizedUntil, expectedLineCount);
    assert.equal(container.querySelector("[data-authored-source]")?.textContent, replacementCode);
    const highlightedRows = Array.from(container.querySelectorAll("[data-highlighted-code] [data-highlighted-line]"));
    assert.equal(highlightedRows.length, expectedLineCount, "replacement should render every highlighted source line");
    assert.equal(
      highlightedRows.map((row) => row.textContent).join("\n"),
      replacementCode,
      "replacement code should render every authored line from its real syntax-highlighted output",
    );
  } finally {
    try {
      root?.unmount();
    } finally {
      try {
        worker.terminate();
      } finally {
        try {
          window.close();
        } finally {
          for (const key of globalKeys) {
            const descriptor = previousGlobals[key];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
          }
        }
      }
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
): Promise<{ pre: HTMLElement }> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const globalKeys = ["window", "document", "HTMLElement", "Node", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
  const previousGlobals = Object.fromEntries(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof globalKeys)[number], PropertyDescriptor | undefined>;
  const container = window.document.getElementById("root");
  let root: Root | null = null;
  try {
    assert.ok(container, "missing test root container");
    Object.assign(globalThis, {
      window,
      document: window.document,
      HTMLElement: window.HTMLElement,
      Node: window.Node,
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      ResizeObserver: ResizeObserverStub,
    });
    const store = createRendererStore([block]);
    root = createRoot(container);
    root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
    let pre: HTMLElement | null = null;
    await waitFor(() => {
      pre = container.querySelector<HTMLElement>('pre[data-code-block="true"]');
      return pre !== null;
    }, "expected code block to render");
    assert.ok(pre, "expected code block to render");
    return { pre };
  } finally {
    try {
      root?.unmount();
    } finally {
      try {
        window.close();
      } finally {
        for (const key of globalKeys) {
          const descriptor = previousGlobals[key];
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      }
    }
  }
}

async function runVirtualizedCodeStreamingGuardTest(): Promise<void> {
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "virtualized-code.md");
  const raw = fs.readFileSync(fixturePath, "utf8");
  const authoredSource = raw
    .replace(/\r\n?/g, "\n")
    .replace(/^```[^\n]*\n/, "")
    .replace(/\n```[\s\S]*$/, "");

  const finalizedLazyBlock: Block = {
    id: "code-block-lazy",
    type: "code",
    isFinalized: true,
    payload: {
      raw,
      meta: { lang: "ts", lazyTokenization: true, code: authoredSource },
    },
  };
  const { pre } = await renderBlock(finalizedLazyBlock);
  assert.strictEqual(pre.getAttribute("data-code-virtualized"), "false", "lazy-tokenized code must remain non-virtualized");
  assert.equal(
    Array.from(pre.querySelectorAll(".line"), (line) => line.textContent ?? "").join("\n").replace(/\n$/, ""),
    authoredSource,
    "lazy non-virtualized code should preserve every authored line in the DOM",
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

