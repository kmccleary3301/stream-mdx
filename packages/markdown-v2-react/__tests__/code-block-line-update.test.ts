import assert from "node:assert";

import type { Patch, TokenLineV1 } from "@stream-mdx/core";
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

function runCodeLineHtmlClearTest(): void {
  const text = "const value = 1;";
  const block: Block = {
    id: "lazy-code",
    type: "code",
    isFinalized: true,
    payload: {
      raw: ["```js", text, "```"].join("\n"),
      meta: { lang: "js", code: text, tokenLines: [null] },
    },
  };
  const store = createRendererStore([block]);
  const lineId = `${block.id}::line:0`;
  const update = (props: Record<string, unknown>) => store.applyPatches(
    [{ op: "setProps", at: { blockId: block.id, nodeId: lineId }, props }],
    { captureMetrics: false },
  );
  const tokens: TokenLineV1 = {
    spans: [{ t: text, v: { dark: { fg: "#ff0000" }, light: { fg: "#0000ff" } } }],
  };
  assert.strictEqual(store.getNode(lineId)?.props?.html, text, "untokenized rows retain a plain fallback");
  const plainProps = store.getNode(lineId)?.props;
  update({ index: 0, text, html: null, tokens: null });
  assert.strictEqual(store.getNode(lineId)?.props, plainProps, "equivalent plain fallback must retain props identity");
  update({ index: 0, text, html: null, tokens });
  assert.strictEqual(store.getNode(lineId)?.props?.html, null, "explicit null must clear stale fallback HTML for token-only enrichment");
  assert.deepStrictEqual(store.getNode(lineId)?.props?.tokens, tokens);
  const tokenProps = store.getNode(lineId)?.props;
  update({ index: 0, text, html: null, tokens });
  assert.strictEqual(store.getNode(lineId)?.props, tokenProps, "repeated token-only normalization must retain props identity");

  const highlightedHtml = `<span style="color:#ff0000">${text}</span>`;
  update({ html: highlightedHtml, tokens });
  const retainedHtml = store.getNode(lineId)?.props?.html;
  assert.ok(typeof retainedHtml === "string" && retainedHtml.includes("<span"), "both-mode rows retain actual highlight HTML");
  const nextTokens: TokenLineV1 = { spans: [{ t: text, s: { fg: "#00ff00" } }] };
  update({ tokens: nextTokens });
  assert.strictEqual(store.getNode(lineId)?.props?.html, retainedHtml, "omitted HTML must preserve an existing highlight");
  update({ html: undefined, tokens });
  assert.strictEqual(store.getNode(lineId)?.props?.html, retainedHtml, "undefined HTML must preserve an existing highlight");
  update({ html: null, tokens });
  assert.strictEqual(store.getNode(lineId)?.props?.html, null, "explicit null must also clear an actual highlight");
  assert.deepStrictEqual(store.getInvariantViolations(), []);
}

await runCodeBlockLineUpdateTest();
runCodeLineHtmlClearTest();
console.log("code-block-line-update test passed");

