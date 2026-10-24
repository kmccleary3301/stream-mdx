import assert from "node:assert/strict";
import type { CodeNodeHandle } from "@stream-mdx/core";
import { useCodeLines } from "@stream-mdx/react";
import { createCodeDocument } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

function CodeRangeRow({ handle, index }: { readonly handle: CodeNodeHandle; readonly index: number }): React.ReactElement {
  const lines = useCodeLines(handle, { from: index, to: index + 1 });
  return <p data-row={index}>{lines[0]?.text}</p>;
}

async function runManyCodeRangeConsumersTest(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const source = Array.from({ length: 500 }, (_, index) => `const item${index} = ${index};`).join("\n");
  const owner = createCodeDocument({ language: "typescript", initialContent: source });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <>
          {Array.from({ length: 500 }, (_, index) => <CodeRangeRow key={index} handle={owner.handle} index={index} />)}
        </>,
      );
    });
    assert.equal(host.querySelector('[data-row="0"]')?.textContent, "const item0 = 0;");
    assert.equal(host.querySelector('[data-row="249"]')?.textContent, "const item249 = 249;");
    assert.equal(host.querySelector('[data-row="499"]')?.textContent, "const item499 = 499;");

    await act(async () => { owner.append(" tail"); });
    assert.equal(host.querySelector('[data-row="499"]')?.textContent, "const item499 = 499; tail");
    assert.equal(host.querySelector('[data-row="0"]')?.textContent, "const item0 = 0;");
  } finally {
    try {
      if (root) await act(async () => root!.unmount());
    } finally {
      owner.dispose();
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
}

await runManyCodeRangeConsumersTest();
console.log("many-view code handle tests passed");
