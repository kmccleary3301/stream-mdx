import assert from "node:assert";

import type { Block } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

import { useMdxCoordinator } from "../src/mdx-coordinator";
import { useRendererBlocks } from "../src/renderer/hooks";
import { createRendererStore } from "../src/renderer/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createMdxBlock(id: string, raw: string): Block {
  return {
    id,
    type: "mdx",
    isFinalized: true,
    payload: {
      raw,
      meta: {
        mdxStatus: "pending",
      },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("Timed out waiting for predicate");
}

function installDom(): () => void {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const previous = {
    window: (globalThis as typeof globalThis & { window?: Window }).window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    navigator: globalThis.navigator,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const { window } = dom;
  (globalThis as any).window = window;
  (globalThis as any).document = window.document;
  (globalThis as any).HTMLElement = window.HTMLElement;
  (globalThis as any).Node = window.Node;
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: window.navigator,
    });
  } catch {
    // ignore readonly navigator environments
  }
  (globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
  (globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  return () => {
    (globalThis as any).window = previous.window;
    (globalThis as any).document = previous.document;
    (globalThis as any).HTMLElement = previous.HTMLElement;
    (globalThis as any).Node = previous.Node;
    try {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        writable: true,
        value: previous.navigator,
      });
    } catch {
      // ignore readonly navigator environments
    }
    (globalThis as any).requestAnimationFrame = previous.requestAnimationFrame;
    (globalThis as any).cancelAnimationFrame = previous.cancelAnimationFrame;
    window.close();
  };
}

const CoordinatorBridge: React.FC<{ store: ReturnType<typeof createRendererStore>; endpoint: string }> = ({ store, endpoint }) => {
  const blocks = useRendererBlocks(store);
  useMdxCoordinator(blocks, endpoint, { store, mode: "server" });
  return null;
};

async function runCoordinatorTest(): Promise<void> {
  const restoreDom = installDom();
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  try {
    console.warn = (...args: unknown[]) => {
      const [first] = args;
      if (typeof first === "string" && first.includes("MDX compile failed for block")) {
        return;
      }
      originalWarn(...args);
    };

    const store = createRendererStore([
      createMdxBlock("mdx-success", "<Demo>alpha</Demo>"),
      createMdxBlock("mdx-error", "<Broken>beta</Broken>"),
    ]);

    const requests: Array<{ blockId: string; content: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.strictEqual(String(input), "http://mdx.test/api");
      assert.strictEqual(init?.method, "POST");
      const payload = JSON.parse(String(init?.body ?? "{}")) as { blockId: string; content: string };
      requests.push(payload);
      if (payload.blockId === "mdx-success") {
        return {
          ok: true,
          async json() {
            return {
              id: "compiled-success",
              code: "return { default: function MDXContent(){ return React.createElement('div', null, 'compiled'); } };",
              dependencies: [],
              cached: false,
            };
          },
        } as Response;
      }
      return {
        ok: false,
        statusText: "compile failed",
        async json() {
          return { error: "synthetic compile failure" };
        },
      } as Response;
    }) as typeof fetch;

    const container = globalThis.document.getElementById("root");
    assert.ok(container, "missing root");
    const root = createRoot(container);
    root.render(React.createElement(CoordinatorBridge, { store, endpoint: "http://mdx.test/api" }));

    await waitFor(() => {
      const blocks = store.getBlocks();
      const success = blocks.find((block) => block.id === "mdx-success");
      const failure = blocks.find((block) => block.id === "mdx-error");
      const successStatus = success?.payload.meta && typeof success.payload.meta === "object" ? (success.payload.meta as Record<string, unknown>).mdxStatus : undefined;
      const failureStatus = failure?.payload.meta && typeof failure.payload.meta === "object" ? (failure.payload.meta as Record<string, unknown>).mdxStatus : undefined;
      return successStatus === "compiled" && failureStatus === "error";
    });

    const blocks = store.getBlocks();
    const success = blocks.find((block) => block.id === "mdx-success");
    const failure = blocks.find((block) => block.id === "mdx-error");
    assert.ok(success, "expected success block");
    assert.ok(failure, "expected failure block");
    assert.deepStrictEqual(
      requests.map((entry) => entry.blockId).sort(),
      ["mdx-error", "mdx-success"],
      "expected coordinator to compile both finalized MDX blocks",
    );
    assert.strictEqual(success.payload.compiledMdxRef?.id, "compiled-success", "success block should store compiled ref");
    assert.strictEqual(
      (success.payload.meta as Record<string, unknown> | undefined)?.mdxStatus,
      "compiled",
      "success block should be marked compiled",
    );
    assert.strictEqual(failure.payload.compiledMdxRef, undefined, "error block should not retain a compiled ref");
    assert.strictEqual(
      (failure.payload.meta as Record<string, unknown> | undefined)?.mdxStatus,
      "error",
      "error block should be marked error",
    );
    assert.strictEqual(
      (failure.payload.meta as Record<string, unknown> | undefined)?.mdxError,
      "MDX compilation failed: synthetic compile failure",
      "error block should preserve the coordinator failure message",
    );

    root.unmount();
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    restoreDom();
  }
}

runCoordinatorTest()
  .then(() => {
    console.log("mdx-coordinator-store-path test passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
