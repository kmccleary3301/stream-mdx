import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Block } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function runVirtualizedCodeMetadataTest(): Promise<void> {
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "virtualized-code.md");
  const raw = fs.readFileSync(fixturePath, "utf8");

  const block: Block = {
    id: "code-block",
    type: "code",
    isFinalized: true,
    payload: {
      raw,
      meta: { lang: "ts" },
    },
  };

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
  assert.ok(container, "missing test root container");

  const root = createRoot(container);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
  await sleep(30);

  const pre = container.querySelector('pre[data-code-block="true"]') as HTMLElement | null;
  assert.ok(pre, "expected code block to render");
  assert.strictEqual(pre.getAttribute("data-code-virtualized"), "true", "expected code block to be virtualized");

  const totalLines = Number(pre.getAttribute("data-code-total-lines"));
  const mountedLines = Number(pre.getAttribute("data-code-mounted-lines"));
  const windowSize = Number(pre.getAttribute("data-code-window-size"));

  assert.ok(totalLines >= 500, `expected 500+ total lines, got ${totalLines}`);
  assert.ok(mountedLines > 0 && mountedLines < totalLines, "expected mounted lines to be a subset of total lines");
  assert.ok(windowSize >= 100, `expected window size >= 100, got ${windowSize}`);

  root.unmount();
}

runVirtualizedCodeMetadataTest()
  .then(() => {
    console.log("virtualized-code-metadata test passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
