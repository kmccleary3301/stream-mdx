import assert from "node:assert";

import type { NodeSnapshot, Patch } from "@stream-mdx/core";
import React from "react";
import { JSDOM } from "jsdom";
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

async function runCodeBlockTerminalNewlineGuardTest(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
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

  const blockId = "code-terminal-newline-guard";
  const raw = "```txt\nalpha\nbeta";
  const snapshot: NodeSnapshot = {
    id: "__root__",
    type: "__root__",
    children: [{
      id: blockId,
      type: "code",
      props: { lang: "txt" },
      children: [],
      code: {
        codeOwnerId: blockId,
        generation: 1,
        revision: 0,
        state: "open",
        processedTo: raw.length,
        completeLineCount: 1,
        lineCount: 2,
        sourceRange: { from: 0, to: raw.length },
        configurationRevision: 0,
        language: "txt",
        raw,
        lines: [
          { id: `${blockId}::line:0`, index: 0, text: "alpha", ending: "\n", sourceRange: { from: 7, to: 12 }, sourceRevision: 0, isProvisional: false },
          { id: `${blockId}::line:1`, index: 1, text: "beta", ending: "", sourceRange: { from: 13, to: 17 }, sourceRevision: 0, isProvisional: true },
        ],
      },
    }],
  };
  const store = createRendererStore();
  store.resetSnapshot(snapshot);
  const registry = new ComponentRegistry();
  const patch: Patch = {
    op: "appendCode",
    at: { blockId },
    code: {
      codeOwnerId: blockId,
      generation: 1,
      revision: 1,
      state: "open",
      processedTo: 21,
      completeLineCount: 2,
      lineCount: 3,
      sourceRange: { from: 0, to: 21 },
    },
    expectedRevision: 0,
    fromLine: 1,
    lines: [
      { id: `${blockId}::line:1`, index: 1, text: "beta", ending: "\n", sourceRange: { from: 13, to: 17 }, sourceRevision: 1, isProvisional: false },
      { id: `${blockId}::line:2`, index: 2, text: "gam", ending: "", sourceRange: { from: 18, to: 21 }, sourceRevision: 1, isProvisional: true },
    ],
    sourceAppend: "\ngam",
    meta: { kind: "semantic" },
  };
  store.applyPatches([patch]);

  const container = window.document.getElementById("root");
  assert.ok(container, "missing test root container");
  const root = createRoot(container);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId, registry }));
  await sleep(40);

  const code = container.querySelector('div[data-code-block="true"] pre code') as HTMLElement | null;
  assert.ok(code, "expected rendered code element");
  assert.strictEqual(code.textContent, "alpha\nbeta\ngam", "renderer must not synthesize a premature trailing newline");

  root.unmount();
}

runCodeBlockTerminalNewlineGuardTest()
  .then(() => {
    console.log("code-block-terminal-newline-guard test passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
