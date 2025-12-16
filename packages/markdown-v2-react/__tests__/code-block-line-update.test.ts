import assert from "node:assert";

import type { Patch } from "@stream-mdx/core";
import type { Block } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCodeBlockLineUpdateTest(): Promise<void> {
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

  const block: Block = {
    id: "code-block",
    type: "code",
    isFinalized: true,
    payload: {
      raw: 'print("old")',
      meta: { lang: "python" },
    },
  };
  const store = createRendererStore([block]);
  const registry = new ComponentRegistry();

  const container = window.document.getElementById("root");
  assert.ok(container, "missing test root container");

  const root = createRoot(container);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
  await sleep(30);

  assert.ok(container.textContent?.includes('print("old")'), "expected initial code line to render");

  store.applyPatches(
    [
      {
        op: "setProps",
        at: { blockId: block.id, nodeId: `${block.id}::line:0` },
        props: { text: 'print("new")' },
      } satisfies Patch,
    ],
    { captureMetrics: false },
  );
  await sleep(30);

  assert.ok(container.textContent?.includes('print("new")'), "expected updated code line to render");
  assert.ok(!container.textContent?.includes('print("old")'), "expected old code line to be replaced");

  root.unmount();
}

await runCodeBlockLineUpdateTest();
console.log("code-block-line-update test passed");

