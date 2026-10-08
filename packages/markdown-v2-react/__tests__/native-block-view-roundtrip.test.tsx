import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { createElement, createRef, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { ComponentRegistry } from "../src/components";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "../src/streaming-markdown";

const fixture = readFileSync(
  fileURLToPath(new URL("../../../tests/regression/fixtures/list-code-nested.md", import.meta.url)),
  "utf8",
);

type CustomCodeProps = {
  html?: string;
  lines?: ReadonlyArray<{ text?: string }>;
  raw?: string;
};

/** Docs-style custom code component: highlighted HTML when available, escaped line text otherwise. */
const CustomCode = (props: CustomCodeProps): ReactElement => {
  const lines = Array.isArray(props.lines) ? props.lines.map((line) => line.text ?? "").join("\n") : "";
  if (props.html && props.html.length > 0) {
    return createElement("pre", {
      "data-custom-code": "true",
      dangerouslySetInnerHTML: { __html: props.html },
    });
  }
  const text = lines.length > 0 ? lines : (props.raw ?? "");
  return createElement("pre", { "data-custom-code": "true" }, text.length > 0 ? createElement("code", null, text) : null);
};

async function setupDom(): Promise<Window & typeof globalThis> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  // The renderer reads browser globals; the test installs the jsdom window as the ambient DOM.
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  globalRecord.window = window;
  globalRecord.document = window.document;
  globalRecord.HTMLElement = window.HTMLElement;
  globalRecord.Node = window.Node;
  globalRecord.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalRecord.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  return window as unknown as Window & typeof globalThis;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 15000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 25);
    await promise;
  }
  assert.fail(`timed out waiting for ${message}`);
}

async function runRoundTripTest(): Promise<void> {
  // 1. Registry semantics: re-passing the built-in map must not mark block types custom.
  const registry = new ComponentRegistry();
  registry.setBlockComponents({ code: CustomCode as never });
  assert.strictEqual(registry.hasCustomBlockComponent("code"), true, "replaced code component must be custom");
  assert.strictEqual(registry.hasCustomBlockComponent("list"), false, "built-in list component is not custom");

  const roundTrip = new ComponentRegistry();
  roundTrip.setBlockComponents(registry.getBlockComponentMap() as never);
  assert.strictEqual(
    roundTrip.hasCustomBlockComponent("list"),
    false,
    "re-passing the built-in component map must keep native list rendering",
  );
  assert.strictEqual(roundTrip.hasCustomBlockComponent("code"), true, "replaced code component stays custom after round-trip");

  // 2. Consumer path: StreamingMarkdown receives the round-tripped map (docs harness shape) and must
  //    still render nested list children, with the custom code component applied to nested fences.
  const domWindow = await setupDom();
  const container = domWindow.document.getElementById("root");
  assert.ok(container, "missing render root");
  const root = createRoot(container);
  const handleRef = createRef<StreamingMarkdownHandle>();
  root.render(
    createElement(StreamingMarkdown, {
      ref: handleRef,
      engine: "main-thread",
      text: fixture,
      className: "markdown-v2-output",
      components: registry.getBlockComponentMap(),
      prewarmLangs: [],
    } as never),
  );

  await waitFor(() => container.querySelectorAll("li").length >= 3, "three list items");
  handleRef.current?.finalize();
  await handleRef.current?.waitForIdle();

  await waitFor(
    () => container.querySelectorAll("pre[data-custom-code]").length >= 3,
    "three nested code blocks rendered through the custom code component",
  );

  const childrenRegions = container.querySelectorAll(".markdown-list-item-children");
  assert.ok(
    childrenRegions.length >= 3,
    `expected nested list-item children regions, found ${childrenRegions.length}`,
  );
  const nestedLists = container.querySelectorAll(".markdown-list .markdown-list");
  assert.ok(nestedLists.length >= 1, `expected a nested list inside the outer list, found ${nestedLists.length}`);
  const nestedCode = container.querySelectorAll("pre[data-custom-code]");
  assert.strictEqual(nestedCode.length, 3, `expected three nested code blocks, found ${nestedCode.length}`);
  const text = container.textContent ?? "";
  assert.ok(text.includes("const value = 1;"), "nested TypeScript fence content must be retained");
  assert.ok(text.includes('echo "nested"'), "nested shell fence content must be retained");
  assert.ok(text.includes("export const answer = 42;"), "nested JavaScript fence content must be retained");

  root.unmount();
}

await runRoundTripTest();
console.log("native-block-view-roundtrip test passed");
