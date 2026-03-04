import assert from "node:assert";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

import type { Block, InlineNode } from "@stream-mdx/core";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function textNode(text: string): InlineNode {
  return { kind: "text", text };
}

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

function createOrderedListBlock(): Block {
  const rows = Array.from({ length: 12 }, (_, index) => `${index + 1}. Item ${index + 1}`).join("\n");
  return {
    id: "ordered-list-width",
    type: "list",
    isFinalized: true,
    payload: {
      raw: rows,
      meta: {
        ordered: true,
        items: Array.from({ length: 12 }, (_, index) => [textNode(`Item ${index + 1}`)]),
      },
    },
  };
}

function createUnorderedListBlock(): Block {
  return {
    id: "unordered-list-width",
    type: "list",
    isFinalized: true,
    payload: {
      raw: "- Alpha\n- Beta",
      meta: {
        ordered: false,
        items: [[textNode("Alpha")], [textNode("Beta")]],
      },
    },
  };
}

async function renderBlockAndGetListElement(block: Block): Promise<HTMLElement> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing root container");

  const store = createRendererStore([block]);
  const registry = new ComponentRegistry();
  const root = createRoot(container!);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
  await sleep(30);

  const list = container!.querySelector(".markdown-list");
  assert.ok(list instanceof window.HTMLElement, "expected rendered markdown list element");
  root.unmount();
  return list as HTMLElement;
}

async function runListMarkerWidthTest(): Promise<void> {
  const ordered = await renderBlockAndGetListElement(createOrderedListBlock());
  assert.strictEqual(ordered.getAttribute("data-marker-digits"), "2", "ordered list should advertise 2-digit marker width");
  assert.strictEqual(
    ordered.style.getPropertyValue("--list-marker-digits").trim(),
    "2",
    "ordered list should expose marker-digit CSS variable",
  );

  const unordered = await renderBlockAndGetListElement(createUnorderedListBlock());
  assert.strictEqual(unordered.getAttribute("data-marker-digits"), "1", "unordered list should stay on 1-digit marker width");
  assert.strictEqual(
    unordered.style.getPropertyValue("--list-marker-digits").trim(),
    "1",
    "unordered list should expose 1-digit marker CSS variable",
  );
}

await runListMarkerWidthTest();
console.log("list marker width test passed");
