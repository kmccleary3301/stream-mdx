import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Block } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { CodeHighlightRequestContext } from "../src/renderer/code-highlight-context";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function renderBlock(block: Block): Promise<{ pre: HTMLElement; requests: Array<Record<string, unknown>> }> {
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
  const registry = new ComponentRegistry();
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

  const { pre, requests } = await renderBlock(finalizedLazyBlock);
  assert.strictEqual(pre.getAttribute("data-code-virtualized"), "false", "lazy-tokenized code must remain non-virtualized");
  assert.ok(requests.length > 0, "finalized lazy non-virtualized code should request a full highlight pass");
  const fullRequest = requests.find((request) => request.blockId === finalizedLazyBlock.id);
  assert.ok(fullRequest, "expected a lazy highlight request for the finalized lazy code block");
  const expectedLineCount = finalizedLazyBlock.payload.meta?.code?.split("\n").length ?? 0;
  assert.deepStrictEqual(
    { startLine: fullRequest?.startLine, endLine: fullRequest?.endLine, priority: fullRequest?.priority, reason: fullRequest?.reason },
    { startLine: 0, endLine: expectedLineCount, priority: "visible", reason: "finalize-full" },
    "finalized lazy non-virtualized code should request the entire code range",
  );

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
