import assert from "node:assert";

import type { Block } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

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

async function runStreamingListAnticipationTest(): Promise<void> {
  const window = await setupDom();

  const block: Block = {
    id: "list-streaming-anticipation",
    type: "list",
    isFinalized: false,
    payload: {
      raw: "- Parent\n  - *italic",
      meta: { ordered: false },
    },
  };

  const store = createRendererStore([block]);
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const registry = new ComponentRegistry();
  const root = createRoot(container!);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
  await sleep(30);

  const emphasisNodes = container!.querySelectorAll("em");
  assert.ok(emphasisNodes.length >= 1, "expected anticipated nested list emphasis to render as <em>");
  assert.ok(container!.textContent?.includes("italic"), "expected anticipated nested list text");
  assert.ok(!container!.textContent?.includes("*italic"), "expected raw marker to be withheld for anticipated list inline");

  root.unmount();
}

await runStreamingListAnticipationTest();
console.log("streaming list anticipation test passed");
