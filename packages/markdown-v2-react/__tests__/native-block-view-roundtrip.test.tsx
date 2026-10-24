import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { createElement, createRef, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { StreamingMarkdown, type StreamingMarkdownHandle } from "../src/streaming-markdown";
import type { NodeViewProps } from "../src/index";

const fixture = readFileSync(
  fileURLToPath(new URL("../../../tests/regression/fixtures/list-code-nested.md", import.meta.url)),
  "utf8",
);

type CustomCodeProps = NodeViewProps;

/** Docs-style native code wrapper; highlighted children remain owned by the renderer. */
const CustomCode = ({ children, metadata }: CustomCodeProps): ReactElement =>
  createElement("div", { "data-custom-code": "true", "data-language": metadata.language }, children);

const DOM_GLOBALS = ["window", "document", "HTMLElement", "Node", "requestAnimationFrame", "cancelAnimationFrame"] as const;

type DomGlobalSnapshot = ReturnType<typeof captureDomGlobals>;

function captureDomGlobals(): Array<{ name: (typeof DOM_GLOBALS)[number]; descriptor: PropertyDescriptor | undefined }> {
  const target = globalThis as unknown as Record<string, unknown>;
  return DOM_GLOBALS.map((name) => ({ name, descriptor: Object.getOwnPropertyDescriptor(target, name) }));
}

function restoreDomGlobals(snapshot: DomGlobalSnapshot): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const { name, descriptor } of snapshot) {
    if (descriptor) {
      Object.defineProperty(target, name, descriptor);
    } else {
      delete target[name];
    }
  }
}

/**
 * Runs `body` with a jsdom window installed as the ambient DOM.
 * The test runner imports every file into one process, so the previous global property
 * descriptors/absence are restored and the jsdom window closed on success and on failure.
 */
async function withDom(body: (window: Window & typeof globalThis) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const snapshot = captureDomGlobals();
  const target = globalThis as unknown as Record<string, unknown>;
  target.window = window;
  target.document = window.document;
  target.HTMLElement = window.HTMLElement;
  target.Node = window.Node;
  target.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  target.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  try {
    await body(window as unknown as Window & typeof globalThis);
  } finally {
    restoreDomGlobals(snapshot);
    dom.window.close();
  }
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 15000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${message}`);
}

async function runRoundTripTest(): Promise<void> {
  // 2. Consumer path: StreamingMarkdown uses the unified registry and keeps nested native list
  //    children while wrapping each prepared code view.
  const globalsBefore = captureDomGlobals();
  await withDom(async (window) => {
    const container = window.document.getElementById("root");
    assert.ok(container, "missing render root");
    const root = createRoot(container);
    try {
      const handleRef = createRef<StreamingMarkdownHandle>();
      root.render(
        createElement(StreamingMarkdown, {
          ref: handleRef,
          engine: "main",
          text: fixture,
          className: "markdown-v2-output",
          components: { code: { wrapper: CustomCode } },
          prewarmLangs: [],
        }),
      );

      await waitFor(() => container.querySelectorAll("li").length >= 3, "three list items");
      await handleRef.current?.finalize();
      await handleRef.current?.waitForIdle();

      await waitFor(
        () => container.querySelectorAll("[data-custom-code]").length >= 3,
        "three nested code blocks rendered through the custom native wrapper",
      );

      const childrenRegions = container.querySelectorAll(".markdown-list-item-children");
      assert.ok(
        childrenRegions.length >= 3,
        `expected nested list-item children regions, found ${childrenRegions.length}`,
      );
      const nestedLists = container.querySelectorAll(".markdown-list .markdown-list");
      assert.ok(nestedLists.length >= 1, `expected a nested list inside the outer list, found ${nestedLists.length}`);
      const nestedCode = container.querySelectorAll("[data-custom-code]");
      assert.strictEqual(nestedCode.length, 3, `expected three nested code blocks, found ${nestedCode.length}`);
      const text = container.textContent ?? "";
      assert.ok(text.includes("const value = 1;"), "nested TypeScript fence content must be retained");
      assert.ok(text.includes('echo "nested"'), "nested shell fence content must be retained");
      assert.ok(text.includes("export const answer = 42;"), "nested JavaScript fence content must be retained");
      // The native wrapper receives the renderer-produced Shiki markup of nested fences.
      await waitFor(
        () => Array.from(container.querySelectorAll("[data-custom-code]")).every(
          (wrapper) => wrapper.querySelector('span.line span[style*="--shiki-"]') !== null,
        ),
        "highlighted html for every nested fence rendered through the custom native wrapper",
      );
      assert.ok(text.includes("const value = 1;"), "highlighted markup keeps the authored code text");
    } finally {
      root.unmount();
    }
  });

  // 3. Ambient-globals contract: following tests in this process (SSR suites included) must see the
  //    exact pre-test global state, whether this test passed or threw.
  assert.deepStrictEqual(
    captureDomGlobals(),
    globalsBefore,
    "dom globals must be restored after the DOM phase",
  );
}

await runRoundTripTest();
console.log("native-block-view-roundtrip test passed");
