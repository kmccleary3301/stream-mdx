import assert from "node:assert";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

import type { Block, NodeSnapshot, Patch } from "@stream-mdx/core";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setupDom() {
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
  return window;
}

async function runEmptyNestedListGuardTest(): Promise<void> {
  const window = await setupDom();
  const raw = "1. Parent item";
  const block: Block = {
    id: "list-root",
    type: "list",
    isFinalized: true,
    payload: {
      raw,
      meta: { ordered: true },
      range: { from: 0, to: raw.length },
    },
  };

  const store = createRendererStore([block]);
  const rootListItemId = `${block.id}::item:0`;
  const emptyNestedList: NodeSnapshot = {
    id: `${rootListItemId}::list:phantom`,
    type: "list",
    props: { ordered: false },
    children: [],
  };

  const patch: Patch = {
    op: "insertChild",
    at: { blockId: block.id, nodeId: rootListItemId },
    index: 0,
    node: emptyNestedList,
  };
  store.applyPatches([patch], { captureMetrics: false });

  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const registry = new ComponentRegistry();
  const root = createRoot(container!);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
  await sleep(30);

  const phantomNestedList = container!.querySelector(".markdown-list-item-children > ul.markdown-list");
  assert.strictEqual(phantomNestedList, null, "empty nested list container should not render");
  assert.ok(container!.textContent?.includes("Parent item"), "expected primary list item content to render");

  root.unmount();
}

await runEmptyNestedListGuardTest();
console.log("empty nested list guard test passed");
