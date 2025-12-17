import assert from "node:assert";

import type { Block, InlineNode } from "@stream-mdx/core";
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

async function runStreamingParagraphAnticipationTest(): Promise<void> {
  const registry = new ComponentRegistry();

  // Without inlineStatus, streaming paragraphs preserve raw fallback.
  const window1 = await setupDom();
  const blockRaw: Block = {
    id: "p-raw",
    type: "paragraph",
    isFinalized: false,
    payload: {
      raw: "*italic",
      inline: [{ kind: "text", text: "*italic" }] satisfies InlineNode[],
      meta: {},
    },
  };
  const store1 = createRendererStore([blockRaw]);
  const container1 = window1.document.getElementById("root");
  assert.ok(container1, "missing first test root container");
  const root1 = createRoot(container1);
  root1.render(React.createElement(BlockNodeRenderer, { store: store1, blockId: blockRaw.id, registry }));
  await sleep(30);

  assert.ok(container1.textContent?.includes("*italic"), "expected raw marker to remain when inlineStatus is not provided");
  assert.strictEqual(container1.querySelector("em"), null, "did not expect <em> rendering without inlineStatus");
  root1.unmount();

  // With inlineStatus=anticipated, streaming paragraphs render inline nodes (markers withheld).
  const window2 = await setupDom();
  const blockAnticipated: Block = {
    id: "p-anticipated",
    type: "paragraph",
    isFinalized: false,
    payload: {
      raw: "*italic",
      inline: [{ kind: "em", children: [{ kind: "text", text: "italic" }] }] satisfies InlineNode[],
      meta: { inlineStatus: "anticipated" },
    },
  };
  const store2 = createRendererStore([blockAnticipated]);
  const container2 = window2.document.getElementById("root");
  assert.ok(container2, "missing second test root container");
  const root2 = createRoot(container2);
  root2.render(React.createElement(BlockNodeRenderer, { store: store2, blockId: blockAnticipated.id, registry }));
  await sleep(30);

  assert.ok(container2.textContent?.includes("italic"), "expected anticipated content to render");
  assert.ok(!container2.textContent?.includes("*italic"), "expected marker to be withheld when anticipated");
  assert.ok(container2.querySelector("em"), "expected <em> element to be rendered");
  root2.unmount();
}

await runStreamingParagraphAnticipationTest();
console.log("streaming paragraph anticipation test passed");

