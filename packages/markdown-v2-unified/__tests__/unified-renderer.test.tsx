import assert from "node:assert";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import rehypeSlug from "rehype-slug";
import { visit } from "unist-util-visit";
import type { Block } from "@stream-mdx/core";
import type { Node } from "unist";
import { MarkdownBlocksRenderer } from "@stream-mdx/react";
import { createUnifiedRenderer } from "../src";

// Initialize JSDOM environment for client/async lifecycle tests
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
(globalThis as any).cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

function normalizeHtml(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function runTests() {
  console.log("Starting @stream-mdx/unified acceptance tests...");

  // Test 1: rehype-slug plugin adds id to finalized heading (sync SSR)
  {
    console.log("Test 1: rehype-slug on finalized heading (sync SSR)...");
    const unifiedRenderer = createUnifiedRenderer({
      rehypePlugins: [rehypeSlug],
    });

    const headingBlock: Block = {
      id: "h1-test",
      type: "heading",
      isFinalized: true,
      payload: {
        raw: "## Quick Start Guide",
      },
    };

    const defaultElement = React.createElement("h2", null, "Quick Start Guide");
    const rendered = unifiedRenderer({
      block: headingBlock,
      element: defaultElement,
    });

    const html = ReactDOMServer.renderToStaticMarkup(rendered as React.ReactElement);
    assert.match(html, /id="quick-start-guide"/, "Finalized heading should have slugified id");
    assert.match(html, />Quick Start Guide<\/h2>/, "Heading text should match");
    console.log("✓ Test 1 passed: Finalized heading received id attribute from rehype-slug synchronously");
  }

  // Test 2: remark uppercase plugin changes output only after finalize
  {
    console.log("Test 2: remark uppercase plugin changes output only after finalize...");
    function remarkUppercase() {
      return (tree: unknown) => {
        visit(tree as Node, "text", (node: { value: string }) => {
          node.value = node.value.toUpperCase();
        });
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [remarkUppercase],
    });

    const unfinalizedBlock: Block = {
      id: "p1-streaming",
      type: "paragraph",
      isFinalized: false,
      payload: {
        raw: "streaming text",
      },
    };

    const defaultElement = React.createElement("p", null, "streaming text");

    // While streaming (unfinalized), unified renderer leaves it unchanged
    const streamingRendered = unifiedRenderer({
      block: unfinalizedBlock,
      element: defaultElement,
    });
    assert.strictEqual(
      streamingRendered,
      defaultElement,
      "Streaming block must return original default element untouched",
    );

    // After finalize, remark plugin executes
    const finalizedBlock: Block = {
      ...unfinalizedBlock,
      isFinalized: true,
    };

    const finalizedRendered = unifiedRenderer({
      block: finalizedBlock,
      element: defaultElement,
    });
    const finalizedHtml = ReactDOMServer.renderToStaticMarkup(finalizedRendered as React.ReactElement);
    assert.strictEqual(
      finalizedHtml,
      "<p>STREAMING TEXT</p>",
      "Finalized block must be transformed by unified remark plugin",
    );
    console.log("✓ Test 2 passed: Remark plugin only transforms after block is finalized");
  }

  // Test 3: reference links resolve inside a routed paragraph using meta.linkReferences
  {
    console.log("Test 3: reference links resolve inside a routed paragraph...");
    const unifiedRenderer = createUnifiedRenderer({
      components: {
        a: (props) => React.createElement("a", { ...props, className: "custom-ref-link" }),
      },
    });

    const paragraphBlock: Block = {
      id: "p-ref-test",
      type: "paragraph",
      isFinalized: true,
      payload: {
        raw: "Visit [stream-docs] for more.",
        meta: {
          linkReferences: [
            {
              label: "stream-docs",
              href: "https://stream-mdx.dev",
              title: "Official Docs",
            },
          ],
        },
      },
    };

    const defaultElement = React.createElement("p", null, "Visit [stream-docs] for more.");
    const rendered = unifiedRenderer({
      block: paragraphBlock,
      element: defaultElement,
    });

    const html = ReactDOMServer.renderToStaticMarkup(rendered as React.ReactElement);
    assert.match(
      html,
      /href="https:\/\/stream-mdx\.dev"/,
      "Reference link should resolve destination URL",
    );
    assert.match(
      html,
      /title="Official Docs"/,
      "Reference link should resolve title attribute",
    );
    assert.match(
      html,
      /class="custom-ref-link"/,
      "Custom component mapping should be applied to resolved link",
    );
    console.log("✓ Test 3 passed: Reference links resolve properly using block.payload.meta.linkReferences");
  }

  // Test 4: 1-char chunk streaming yields identical final DOM to static
  {
    console.log("Test 4: 1-char chunk streaming yields identical final DOM to static...");
    const unifiedRenderer = createUnifiedRenderer({
      rehypePlugins: [rehypeSlug],
      components: {
        h1: (props) => React.createElement("h1", { ...props, className: "custom-h1" }),
      },
    });

    const staticBlocks: Block[] = [
      {
        id: "b-static-1",
        type: "heading",
        isFinalized: true,
        payload: { raw: "# Title" },
      },
      {
        id: "b-static-2",
        type: "paragraph",
        isFinalized: true,
        payload: { raw: "This is a paragraph with **bold** text and [link](https://example.com)." },
      },
      {
        id: "b-static-3",
        type: "blockquote",
        isFinalized: true,
        payload: { raw: "> Blockquote text" },
      },
    ];

    const staticHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, {
        blocks: staticBlocks,
        blockRenderer: unifiedRenderer,
      }),
    );

    // Simulate 1-char streaming where blocks finalize one by one
    const blocksData = [
      { id: "b-stream-1", type: "heading", raw: "# Title" },
      { id: "b-stream-2", type: "paragraph", raw: "This is a paragraph with **bold** text and [link](https://example.com)." },
      { id: "b-stream-3", type: "blockquote", raw: "> Blockquote text" },
    ];

    let streamedBlocks: Block[] = [];
    for (let i = 0; i < blocksData.length; i++) {
      const b = blocksData[i];
      for (let len = 1; len <= b.raw.length; len++) {
        const partialRaw = b.raw.slice(0, len);
        const isLastChar = len === b.raw.length;
        streamedBlocks = [
          ...blocksData.slice(0, i).map((prev) => ({
            id: prev.id,
            type: prev.type,
            isFinalized: true,
            payload: { raw: prev.raw },
          })),
          {
            id: b.id,
            type: b.type,
            isFinalized: isLastChar,
            payload: { raw: partialRaw },
          },
        ];
      }
    }

    streamedBlocks = blocksData.map((b) => ({
      id: b.id,
      type: b.type,
      isFinalized: true,
      payload: { raw: b.raw },
    }));

    const finalStreamedHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, {
        blocks: streamedBlocks,
        blockRenderer: unifiedRenderer,
      }),
    );

    assert.strictEqual(
      normalizeHtml(finalStreamedHtml),
      normalizeHtml(staticHtml),
      "Streaming in 1-char chunks must yield identical final DOM to static rendering",
    );
    console.log("✓ Test 4 passed: 1-char chunk streaming produces identical final DOM to static");
  }

  // Test 5: Cache efficiency
  {
    console.log("Test 5: Cache avoids recomputing finalized blocks...");
    let parseCalls = 0;
    function countingPlugin() {
      return () => {
        parseCalls += 1;
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [countingPlugin],
    });

    const block: Block = {
      id: "cached-p",
      type: "paragraph",
      isFinalized: true,
      payload: {
        raw: "Hello world cached",
      },
    };

    // First render
    const el1 = unifiedRenderer({ block, element: React.createElement("p") });
    ReactDOMServer.renderToStaticMarkup(el1 as React.ReactElement);
    assert.strictEqual(parseCalls, 1, "First render should parse and transform");

    // Second render (same block id and content)
    const el2 = unifiedRenderer({ block, element: React.createElement("p") });
    ReactDOMServer.renderToStaticMarkup(el2 as React.ReactElement);
    assert.strictEqual(parseCalls, 1, "Second render should use cached output without re-running plugin");

    // Clear cache
    unifiedRenderer.clearCache();
    const el3 = unifiedRenderer({ block, element: React.createElement("p") });
    ReactDOMServer.renderToStaticMarkup(el3 as React.ReactElement);
    assert.strictEqual(parseCalls, 2, "After clearCache(), plugin should run again");
    console.log("✓ Test 5 passed: Finalized block caching works as expected");
  }

  // Test 6: Bounded LRU cache eviction and key uniqueness with linkReferences
  {
    console.log("Test 6: Bounded LRU cache eviction and key uniqueness...");
    let runs = 0;
    function trackingPlugin() {
      return () => {
        runs += 1;
      };
    }

    const smallCacheRenderer = createUnifiedRenderer({
      remarkPlugins: [trackingPlugin],
      cacheSize: 2,
    });

    const b1: Block = { id: "b1", type: "paragraph", isFinalized: true, payload: { raw: "one" } };
    const b2: Block = { id: "b2", type: "paragraph", isFinalized: true, payload: { raw: "two" } };
    const b3: Block = { id: "b3", type: "paragraph", isFinalized: true, payload: { raw: "three" } };

    // Fill cache with b1 and b2
    ReactDOMServer.renderToStaticMarkup(smallCacheRenderer({ block: b1, element: React.createElement("p") }) as React.ReactElement);
    ReactDOMServer.renderToStaticMarkup(smallCacheRenderer({ block: b2, element: React.createElement("p") }) as React.ReactElement);
    assert.strictEqual(runs, 2, "b1 and b2 should compute");

    // Adding b3 should evict b1 (oldest)
    ReactDOMServer.renderToStaticMarkup(smallCacheRenderer({ block: b3, element: React.createElement("p") }) as React.ReactElement);
    assert.strictEqual(runs, 3, "b3 should compute and evict b1");

    // b2 is still in cache
    ReactDOMServer.renderToStaticMarkup(smallCacheRenderer({ block: b2, element: React.createElement("p") }) as React.ReactElement);
    assert.strictEqual(runs, 3, "b2 should still be cached");

    // b1 was evicted so re-rendering it recomputes
    ReactDOMServer.renderToStaticMarkup(smallCacheRenderer({ block: b1, element: React.createElement("p") }) as React.ReactElement);
    assert.strictEqual(runs, 4, "evicted b1 should recompute");

    // Cache key includes linkReferences: same raw text but different linkReferences must recompute
    const bWithRefs: Block = {
      id: "b-refs",
      type: "paragraph",
      isFinalized: true,
      payload: {
        raw: "link [x]",
        meta: { linkReferences: [{ label: "x", href: "https://a.com" }] },
      },
    };
    const bWithDifferentRefs: Block = {
      id: "b-refs",
      type: "paragraph",
      isFinalized: true,
      payload: {
        raw: "link [x]",
        meta: { linkReferences: [{ label: "x", href: "https://b.com" }] },
      },
    };

    const r1 = smallCacheRenderer({ block: bWithRefs, element: React.createElement("p") });
    const html1 = ReactDOMServer.renderToStaticMarkup(r1 as React.ReactElement);
    assert.match(html1, /https:\/\/a\.com/);

    const r2 = smallCacheRenderer({ block: bWithDifferentRefs, element: React.createElement("p") });
    const html2 = ReactDOMServer.renderToStaticMarkup(r2 as React.ReactElement);
    assert.match(html2, /https:\/\/b\.com/);
    console.log("✓ Test 6 passed: LRU cache is bounded and cache key incorporates linkReferences");
  }

  // Test 7: Normal non-async function returning Promise
  {
    console.log("Test 7: Normal non-async function returning Promise...");
    let promiseCalls = 0;
    function promiseReturningPlugin() {
      // Regular non-async function returning Promise
      return (tree: unknown) => {
        promiseCalls += 1;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(() => {
          visit(tree as Node, "text", (node: { value: string }) => {
            node.value = node.value + " [PROMISE TRANSFORMED]";
          });
          resolve();
        }, 20);
        return promise;
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [promiseReturningPlugin],
    });

    const block: Block = {
      id: "p-promise-test",
      type: "paragraph",
      isFinalized: true,
      payload: { raw: "Standard promise paragraph" },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const defaultElement = React.createElement("p", null, "Standard promise paragraph");
    root.render(unifiedRenderer({ block, element: defaultElement }));

    // While pending, default element is shown
    await delay(5);
    assert.strictEqual(container.textContent, "Standard promise paragraph");

    // After promise resolves, transformed content is committed
    await delay(35);
    assert.strictEqual(
      container.textContent,
      "Standard promise paragraph [PROMISE TRANSFORMED]",
    );
    assert.strictEqual(promiseCalls, 1, "Promise plugin must be called exactly once");

    root.unmount();
    container.remove();
    console.log("✓ Test 7 passed: Non-async function returning Promise operates cleanly");
  }

  // Test 8: Callback-style transformer ((tree, file, next) => ...)
  {
    console.log("Test 8: Callback-style transformer...");
    let callbackCalls = 0;
    function callbackStylePlugin() {
      // Arity 3 callback-style transformer
      return (tree: unknown, _file: unknown, next: (err?: Error | null) => void) => {
        callbackCalls += 1;
        setTimeout(() => {
          visit(tree as Node, "text", (node: { value: string }) => {
            node.value = node.value + " [CALLBACK TRANSFORMED]";
          });
          next();
        }, 20);
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [callbackStylePlugin],
    });

    const block: Block = {
      id: "p-callback-test",
      type: "paragraph",
      isFinalized: true,
      payload: { raw: "Callback transformer text" },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const defaultElement = React.createElement("p", null, "Callback transformer text");
    root.render(unifiedRenderer({ block, element: defaultElement }));

    // Pending state shows default element
    await delay(5);
    assert.strictEqual(container.textContent, "Callback transformer text");

    // After next() callback fires, transformed content is committed
    await delay(35);
    assert.strictEqual(
      container.textContent,
      "Callback transformer text [CALLBACK TRANSFORMED]",
    );
    assert.strictEqual(callbackCalls, 1, "Callback transformer must be called exactly once");

    root.unmount();
    container.remove();
    console.log("✓ Test 8 passed: Callback-style transformer operates cleanly");
  }

  // Test 9: Exact plugin invocation count is 1 per cache key (no duplicated execution, no pipeline restart)
  {
    console.log("Test 9: Exact plugin invocation count is 1 per cache key...");
    let pluginRuns = 0;
    function singleInvocationPlugin() {
      return (tree: unknown) => {
        pluginRuns += 1;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(() => {
          visit(tree as Node, "text", (node: { value: string }) => {
            node.value = node.value + " [ONE SHOT]";
          });
          resolve();
        }, 25);
        return promise;
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [singleInvocationPlugin],
    });

    const block: Block = {
      id: "p-single-invoc",
      type: "paragraph",
      isFinalized: true,
      payload: { raw: "Exact count test" },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const defaultElement = React.createElement("p", null, "Exact count test");

    // Initial render initiates job
    root.render(unifiedRenderer({ block, element: defaultElement }));

    // Re-render the same block at 10ms while in-flight
    await delay(10);
    root.render(unifiedRenderer({ block, element: defaultElement }));

    // Wait until completed
    await delay(35);
    assert.strictEqual(container.textContent, "Exact count test [ONE SHOT]");

    // Re-render again after completion (hits cache)
    root.render(unifiedRenderer({ block, element: defaultElement }));
    await delay(10);
    assert.strictEqual(container.textContent, "Exact count test [ONE SHOT]");

    assert.strictEqual(
      pluginRuns,
      1,
      "Plugin must be invoked exactly once across initial render, in-flight rerenders, and cache hits",
    );

    root.unmount();
    container.remove();
    console.log("✓ Test 9 passed: Exactly 1 plugin invocation per cache key with no duplicate execution");
  }

  // Test 10: Real Error('async failed') goes to onError without retry, and renders safe default fallback
  {
    console.log("Test 10: Real Error('async failed') goes to onError without retry...");
    let failureInvocations = 0;
    let capturedError: Error | null = null;
    let capturedBlock: Block | null = null;

    function failingAsyncPlugin() {
      return () => {
        failureInvocations += 1;
        const { promise, reject } = Promise.withResolvers<void>();
        setTimeout(() => {
          reject(new Error("async failed"));
        }, 20);
        return promise;
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [failingAsyncPlugin],
      onError: (err, b) => {
        capturedError = err;
        capturedBlock = b;
      },
    });

    const block: Block = {
      id: "p-fail-test",
      type: "paragraph",
      isFinalized: true,
      payload: { raw: "Error trigger content" },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const defaultElement = React.createElement("p", null, "Safe fallback default");
    root.render(unifiedRenderer({ block, element: defaultElement }));

    // Wait for failure
    await delay(45);
    assert.ok(capturedError, "onError must be called on plugin failure");
    assert.strictEqual(capturedError?.message, "async failed", "Exact error message must be passed to onError");
    assert.strictEqual(capturedBlock?.id, "p-fail-test", "Exact block must be passed to onError");
    assert.strictEqual(failureInvocations, 1, "Failing plugin must be invoked exactly once (no retry)");
    assert.strictEqual(container.textContent, "Safe fallback default", "Safe default element is retained");

    root.unmount();
    container.remove();
    console.log("✓ Test 10 passed: Real Error('async failed') dispatches to onError without retry");
  }

  // Test 11: Key change while pending immediately shows new default, NOT stale previous async result
  {
    console.log("Test 11: Key change while pending immediately shows new default...");
    function slowKeyPlugin() {
      return (tree: unknown) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(() => {
          visit(tree as Node, "text", (node: { value: string }) => {
            node.value = node.value + " [TRANSFORMED]";
          });
          resolve();
        }, 50);
        return promise;
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [slowKeyPlugin],
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const blockK1: Block = {
      id: "p-key-switch",
      type: "paragraph",
      isFinalized: true,
      payload: { raw: "Content Alpha" },
    };
    const defaultK1 = React.createElement("p", null, "Default Alpha");

    // Render K1 (triggers 50ms slow async job)
    root.render(unifiedRenderer({ block: blockK1, element: defaultK1 }));
    await delay(5);
    assert.strictEqual(container.textContent, "Default Alpha");

    // At 15ms, while K1 is still pending, key changes to K2
    await delay(10);
    const blockK2: Block = {
      id: "p-key-switch",
      type: "paragraph",
      isFinalized: true,
      payload: { raw: "Content Beta" },
    };
    const defaultK2 = React.createElement("p", null, "Default Beta");

    // Rerender with K2
    root.render(unifiedRenderer({ block: blockK2, element: defaultK2 }));
    await delay(5);

    // Container MUST immediately show Default Beta, not stale previous pending or async result
    assert.strictEqual(
      container.textContent,
      "Default Beta",
      "Key change while pending must immediately display new default element",
    );

    // After K2 completes (at 15ms + 50ms = 65ms total), it displays K2 transformed output
    await delay(60);
    assert.strictEqual(
      container.textContent,
      "Content Beta [TRANSFORMED]",
      "Completed K2 must display transformed output",
    );

    root.unmount();
    container.remove();
    console.log("✓ Test 11 passed: Key change while pending immediately shows new default, not stale result");
  }

  // Test 12: Newer reference metadata does not get overwritten by older slow async job
  {
    console.log("Test 12: Newer reference metadata doesn't get overwritten by older async job...");
    function asyncDelayPlugin() {
      return (tree: unknown) => {
        let isSlow = false;
        visit(tree as Node, "link", (node: { url?: string }) => {
          if (node.url && node.url.includes("slow-v1")) {
            isSlow = true;
          }
        });
        const { promise, resolve } = Promise.withResolvers<void>();
        const waitMs = isSlow ? 60 : 10;
        setTimeout(resolve, waitMs);
        return promise;
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [asyncDelayPlugin],
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const blockV1: Block = {
      id: "p-stale-race",
      type: "paragraph",
      isFinalized: true,
      payload: {
        raw: "See documentation at [doc-ref].",
        meta: {
          linkReferences: [{ label: "doc-ref", href: "https://slow-v1.example.com" }],
        },
      },
    };

    // Step 1: Render with v1 (triggers slow 60ms job)
    root.render(unifiedRenderer({ block: blockV1, element: React.createElement("p", null, "default") }));

    // Step 2: At 15ms, update block to v2 with newer metadata (triggers fast 10ms job)
    await delay(15);
    const blockV2: Block = {
      id: "p-stale-race",
      type: "paragraph",
      isFinalized: true,
      payload: {
        raw: "See documentation at [doc-ref].",
        meta: {
          linkReferences: [{ label: "doc-ref", href: "https://fast-v2.example.com" }],
        },
      },
    };
    root.render(unifiedRenderer({ block: blockV2, element: React.createElement("p", null, "default") }));

    // Step 3: At 35ms (15ms + 20ms), v2 has finished
    await delay(20);
    assert.match(container.innerHTML, /https:\/\/fast-v2\.example\.com/, "Fast v2 should have committed its output");

    // Step 4: At 85ms, slow v1 has finished. It must NOT overwrite fast v2!
    await delay(50);
    assert.match(container.innerHTML, /https:\/\/fast-v2\.example\.com/, "Newer metadata must not be overwritten by older async job");
    assert.ok(!container.innerHTML.includes("slow-v1.example.com"), "Slow v1 url must not overwrite newer v2");

    root.unmount();
    container.remove();
    console.log("✓ Test 12 passed: Stale older async jobs do not overwrite newer reference metadata");
  }

  // Test 13: Streaming blocks stay completely normal and bypass unified
  {
    console.log("Test 13: streaming blocks stay normal...");
    let pluginCalls = 0;
    function countPlugin() {
      return () => {
        pluginCalls += 1;
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [countPlugin],
    });

    const streamingBlock: Block = {
      id: "p-stream",
      type: "paragraph",
      isFinalized: false,
      payload: { raw: "Streaming in progress..." },
    };

    const defaultElement = React.createElement("p", { className: "default-stream" }, "Streaming in progress...");
    const rendered = unifiedRenderer({ block: streamingBlock, element: defaultElement });

    // Returns default element directly
    assert.strictEqual(rendered, defaultElement, "Unfinalized block returns default element directly");
    assert.strictEqual(pluginCalls, 0, "Plugin is never called for unfinalized streaming blocks");
    console.log("✓ Test 13 passed: Streaming blocks stay completely normal and bypass unified");
  }

  console.log("All @stream-mdx/unified tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
