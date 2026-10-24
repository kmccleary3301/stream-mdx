import assert from "node:assert/strict";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { StreamingMarkdown } from "../src/streaming-markdown";
import type { StreamingMarkdownHandle } from "../src/streaming-markdown";

const DOM_GLOBALS = [
  "window",
  "document",
  "HTMLElement",
  "Node",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "navigator",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

type GlobalSnapshot = Partial<Record<(typeof DOM_GLOBALS)[number], PropertyDescriptor>>;

async function waitForInlineEngine(handle: StreamingMarkdownHandle): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!handle.getState().workerReady) {
    assert.ok(Date.now() < deadline, "inline engine did not become ready");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function nextFrame(window: Window): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function runFirstCodeRowFrameTest(): Promise<void> {
  const saved: GlobalSnapshot = {};
  for (const name of DOM_GLOBALS) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);

  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  const target = globalThis as unknown as Record<string, unknown>;
  target.window = dom.window;
  target.document = dom.window.document;
  target.HTMLElement = dom.window.HTMLElement;
  target.Node = dom.window.Node;
  target.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  target.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  target.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: dom.window.navigator,
  });

  const container = dom.window.document.getElementById("root");
  assert.ok(container, "render root exists");
  const root = createRoot(container);
  const handleRef = createRef<StreamingMarkdownHandle>();

  try {
    await act(async () => {
      root.render(createElement(StreamingMarkdown, { ref: handleRef, engine: "main", caret: false }));
    });
    assert.ok(handleRef.current, "StreamingMarkdown exposes its public handle");
    await waitForInlineEngine(handleRef.current);

    await act(async () => {
      handleRef.current!.append("Intro\n\n```ts\ninterface User {\n");
      await handleRef.current!.waitForIdle();
      await nextFrame(dom.window as unknown as Window);
    });

    assert.ok(
      container.querySelector("pre code > .line"),
      "the first completed native code row renders within one animation frame after waitForIdle",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const name of DOM_GLOBALS) {
      const descriptor = saved[name];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete target[name];
    }
  }
}

await runFirstCodeRowFrameTest();
