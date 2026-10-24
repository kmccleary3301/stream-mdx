import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import rehypeSlug from "rehype-slug";
import { visit } from "unist-util-visit";
import type { Block, CodeNodeHandle, WorkerOut } from "@stream-mdx/core";
import type { Node } from "unist";
import { MarkdownBlocksRenderer, createRendererStore, type NodePresentations, type NodeViewProps } from "@stream-mdx/react";
import type { UnifiedBlockErrorContext } from "../src";
import { MarkdownEngine, createInlineEngineWorker } from "../../markdown-v2-worker/src/engine";
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

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function compileBlocks(text: string): Promise<ReadonlyArray<Block>> {
  const store = createRendererStore();
  let finalized = false;
  const engine = new MarkdownEngine({
    post(message) {
      if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
      if (message.type === "PATCH") store.applyPatches(message.patches);
      if (message.type === "ERROR") throw new Error(message.error.message);
      if (message.type === "FINALIZED") finalized = true;
    },
  });
  try {
    await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: text, prewarmLangs: [] });
    await engine.handle({ type: "SET_CREDITS", credits: 10000 });
    await engine.handle({ type: "FINALIZE" });
    assert.ok(finalized, "Compiler must reach terminal FINALIZED");
    return store.getBlocks();
  } finally {
    engine.dispose();
  }
}
async function compileBlocksWithAppend(
  initialContent: string,
  appendedContent: string,
): Promise<{
  readonly beforeDefinition: ReadonlyArray<Block>;
  readonly afterDefinition: ReadonlyArray<Block>;
  readonly blocks: ReadonlyArray<Block>;
}> {
  const store = createRendererStore();
  let finalized = false;
  const engine = new MarkdownEngine({
    post(message) {
      if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
      if (message.type === "PATCH") store.applyPatches(message.patches);
      if (message.type === "ERROR") throw new Error(message.error.message);
      if (message.type === "FINALIZED") finalized = true;
    },
  });
  try {
    await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent, prewarmLangs: [] });
    await engine.handle({ type: "SET_CREDITS", credits: 10000 });
    const beforeDefinition = store.getBlocks();
    await engine.handle({ type: "APPEND", text: appendedContent });
    const afterDefinition = store.getBlocks();
    await engine.handle({ type: "FINALIZE" });
    assert.ok(finalized, "Compiler must reach terminal FINALIZED");
    return { beforeDefinition, afterDefinition, blocks: store.getBlocks() };
  } finally {
    engine.dispose();
  }
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(5);
  }
}

async function runTests() {
  console.log("Starting @stream-mdx/unified acceptance tests...");

  // Test 1: rehype-slug plugin adds id to finalized heading (sync SSR)
  {
    console.log("Test 1: rehype-slug on finalized heading (sync SSR)...");
    const unifiedRenderer = createUnifiedRenderer({
      rehypePlugins: [rehypeSlug],
    });

    const blocks = await compileBlocks(
      "## Quick Start Guide\n\nSetext **heading**\n===\n\n###### *emphasis*\n\nFoo **bold**\nbar *soft*\n===\n\nSecond *heading*\nwith **continuation**\n---\n\n## # literal **heading**\n\n\\# literal *start*\ncontinued **body**\n---",
    );
    const heading = blocks.find((block) => block.type === "heading");
    assert.strictEqual(heading?.payload.raw, "## Quick Start Guide");
    assert.strictEqual(heading?.payload.meta?.headingLevel, 2);
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, { blocks, components: unifiedRenderer }),
    );
    assert.match(html, /id="quick-start-guide"/, "Finalized heading should have slugified id");
    assert.match(html, />Quick Start Guide<\/h2>/, "Heading text should match");
    assert.match(html, /<h1 id="setext-heading">Setext <strong>heading<\/strong><\/h1>/);
    assert.match(html, /<h6 id="emphasis"><em>emphasis<\/em><\/h6>/);
    const renderedDocument = new JSDOM(html).window.document;
    const multilineH1 = renderedDocument.querySelectorAll("h1")[1];
    assert.strictEqual(multilineH1?.innerHTML, "Foo <strong>bold</strong>\nbar <em>soft</em>",
      "Multiline Setext h1 must retain all inline content and its soft break");
    assert.strictEqual(multilineH1?.id, "foo-boldbar-soft");
    const multilineH2 = renderedDocument.querySelectorAll("h2")[1];
    assert.strictEqual(multilineH2?.innerHTML, "Second <em>heading</em>\nwith <strong>continuation</strong>",
      "Multiline Setext h2 must retain all inline content and its soft break");
    assert.strictEqual(multilineH2?.id, "second-headingwith-continuation");
    assert.strictEqual(renderedDocument.querySelectorAll("h2")[2]?.innerHTML, "# literal <strong>heading</strong>",
      "Normalized heading text beginning with a literal marker must remain heading content");
    assert.strictEqual(renderedDocument.querySelectorAll("h2")[3]?.innerHTML,
      "# literal <em>start</em>\ncontinued <strong>body</strong>",
      "Multiline heading reconstruction must preserve escaped literal markers and inline emphasis");
    assert.strictEqual(renderedDocument.querySelectorAll("p").length, 0,
      "A heading must not split into an extra paragraph");
    console.log("✓ Test 1 passed: Finalized heading received id attribute from rehype-slug synchronously");
  }

  // Node presentations use the same finalized block dispatch as streaming.
  {
    const blocks = await compileBlocks("## Shared presentation");
    const heading = blocks.find((block) => block.type === "heading");
    assert.ok(heading, "the finalized heading is available for presentation");
    const components = {
      heading: {
        wrapper: ({ children, metadata }: NodeViewProps) => (
          <section data-unified-heading data-finalized={metadata.isFinalized}>{children}</section>
        ),
      },
    } satisfies NodePresentations;
    const unifiedRenderer = createUnifiedRenderer({ components });
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, { blocks: [heading], components: unifiedRenderer }),
    );
    assert.match(html, /<section data-unified-heading="true" data-finalized="true"><h2>Shared presentation<\/h2><\/section>/);
  }

  // A headless code presentation replaces the unified renderer's prepared native output.
  {
    const blocks = await compileBlocks("```text\nfirst line\nsecond line\n```");
    const code = blocks.find((block) => block.type === "code");
    assert.ok(code, "the finalized code block is available for presentation");
    const CodeView: React.FC<{ readonly handle: CodeNodeHandle }> = ({ handle }) => (
      <output data-unified-code-view>{handle.readSource()}</output>
    );
    const components = {
      code: { view: CodeView },
    } satisfies NodePresentations;
    const renderer = createUnifiedRenderer({ components });
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, { blocks: [code], components: renderer }),
    );
    assert.match(html, /<output data-unified-code-view="true">```text\nfirst line\nsecond line\n```<\/output>/);
  }

  // Test 3: late reference definitions reach the cold export and unified renderer
  {
    console.log("Test 3: late reference definitions reach the cold export...");
    const unifiedRenderer = createUnifiedRenderer({
      hastComponents: {
        a: (props) => React.createElement("a", { ...props, className: "custom-ref-link" }),
      },
    });

    const { beforeDefinition, afterDefinition, blocks } = await compileBlocksWithAppend(
      "Visit [stream-docs] for more.\n\n",
      '[stream-docs]: https://stream-mdx.dev "Official Docs"\n',
    );
    const beforeParagraph = beforeDefinition.find((block) => block.type === "paragraph");
    assert.ok(beforeParagraph, "Cold export contains the paragraph owner before its definition");
    assert.strictEqual(beforeParagraph.payload.meta?.linkReferences, undefined,
      "The unresolved source does not publish a definition that has not arrived");
    const updatedParagraph = afterDefinition.find((block) => block.type === "paragraph");
    assert.ok(updatedParagraph, "Cold export retains the paragraph after its definition arrives");
    assert.deepStrictEqual(updatedParagraph.payload.meta?.linkReferences, [
      { label: "stream-docs", href: "https://stream-mdx.dev", title: "Official Docs" },
    ], "The definition must reach the paragraph through the PATCH export");
    const paragraph = blocks.find((block) => block.type === "paragraph");
    assert.ok(paragraph, "Final cold export contains the paragraph owner");
    assert.ok(paragraph.payload.inline?.some((node) =>
      node.kind === "link" && node.href === "https://stream-mdx.dev" && node.title === "Official Docs",
    ), "Cold export also carries the resolved reference in inline owner data");
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, { blocks, components: unifiedRenderer }),
    );
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
    console.log("✓ Test 3 passed: Late references remain available to unified through the cold export");
  }

  // Real one-character transport updates reach the store and mounted consumer.
  {
    console.log("Test 4: real incremental transport and finalized DOM parity...");
    const text = "## Stream Title\n\n> ## Quoted title\n> See [docs].\n\n- List **item**\n\nThis is a paragraph with **bold** text and [docs].\n\n[docs]: https://example.com \"Docs\"\n\nTail **text**";
    function remarkUppercase() {
      return (tree: unknown) => {
        visit(tree as Node, "text", (node: { value: string }) => {
          node.value = node.value.toUpperCase();
        });
      };
    }
    const options = { remarkPlugins: [remarkUppercase], rehypePlugins: [rehypeSlug] };
    const staticBlocks = await compileBlocks(text);
    const staticHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, {
        blocks: staticBlocks,
        components: createUnifiedRenderer(options),
      }),
    );
    const staticContainer = document.createElement("div");
    staticContainer.innerHTML = staticHtml;
    const store = createRendererStore();
    const worker = createInlineEngineWorker();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let initialized = false;
    let finalized = false;
    let failure: Error | undefined;
    let patchCount = 0;
    worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      const message = event.data;
      if (message.type === "INITIALIZED") {
        store.resetSnapshot(message.snapshot);
        initialized = true;
      } else if (message.type === "PATCH") {
        store.applyPatches(message.patches);
        patchCount += 1;
      } else if (message.type === "FINALIZED") {
        finalized = true;
      } else if (message.type === "ERROR") {
        failure = new Error(message.error.message);
      }
    };
    worker.onerror = (event) => { failure = new Error(event.message); };
    try {
      root.render(React.createElement(MarkdownBlocksRenderer, {
        blocks: [],
        store,
        components: createUnifiedRenderer(options),
      }));
      worker.postMessage({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "", prewarmLangs: [] });
      await waitUntil(() => initialized || failure !== undefined, "INITIALIZED");
      if (failure) throw failure;
      worker.postMessage({ type: "SET_CREDITS", credits: 10000 });
      for (const character of text) worker.postMessage({ type: "APPEND", text: character });
      // The unfinished tail renders closed inline spans through the normal streaming renderer.
      await waitUntil(
        () => failure !== undefined || container.querySelector(".markdown-renderer > p:last-child")?.textContent === "Tail text",
        "provisional tail DOM",
      );
      if (failure) throw failure;
      assert.ok(patchCount > 1, "Character APPEND messages must produce incremental patches");
      assert.ok(store.getBlocks().some((block) => !block.isFinalized), "Tail must remain provisional");
      assert.strictEqual(container.querySelector(".markdown-renderer > p:last-child strong")?.textContent, "text",
        "Provisional DOM must use the normal streaming renderer, not the uppercase plugin");
      assert.ok(!finalized, "Provisional assertion must precede terminal finalization");
      worker.postMessage({ type: "FINALIZE" });
      await waitUntil(() => finalized || failure !== undefined, "FINALIZED");
      if (failure) throw failure;
      assert.ok(store.getBlocks().every((block) => block.isFinalized));
      await waitUntil(
        () => container.querySelector(".markdown-renderer > p:last-child strong")?.textContent === "TEXT",
        "finalized plugin output in mounted DOM",
      );
      assert.strictEqual(
        container.firstElementChild?.innerHTML,
        staticContainer.firstElementChild?.innerHTML,
        "Terminal streamed markdown DOM must match compiled static output",
      );
      assert.strictEqual(container.querySelector("h2")?.id, "stream-title");
      assert.strictEqual(container.querySelector("h2")?.textContent, "STREAM TITLE");
      assert.strictEqual(container.querySelector("a")?.getAttribute("href"), "https://example.com");
      assert.strictEqual(container.querySelector("blockquote h2")?.textContent, "QUOTED TITLE");
      assert.strictEqual(container.querySelector("li strong")?.textContent, "ITEM");
      assert.strictEqual(container.querySelector(".markdown-renderer > p:last-child strong")?.textContent, "TEXT");
    } finally {
      worker.terminate();
      root.unmount();
      container.remove();
    }
  }

  // Cached plugin output must remain observable through the consumer.
  {
    console.log("Test 5: consumer reuses transformed finalized output...");
    let runs = 0;
    function remarkUppercase() {
      return (tree: unknown) => {
        runs += 1;
        visit(tree as Node, "text", (node: { value: string }) => {
          node.value = node.value.toUpperCase();
        });
      };
    }
    const blocks = await compileBlocks("Cached **paragraph**");
    const renderer = createUnifiedRenderer({ remarkPlugins: [remarkUppercase] });
    const [first, second] = [0, 1].map(() => ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownBlocksRenderer, { blocks, components: renderer }),
    ));
    assert.match(first, /CACHED <strong>PARAGRAPH<\/strong>/);
    assert.strictEqual(second, first, "Repeated consumer render must retain transformed output");
    assert.strictEqual(runs, 1, "Repeated finalized block must not rerun its plugin");
  }

  // Test 7: Normal non-async function returning Promise
  {
    console.log("Test 7: Normal non-async function returning Promise...");
    let promiseCalls = 0;
    function promiseReturningPlugin() {
      // Regular non-async function returning Promise
      return (tree: unknown) => {
        promiseCalls += 1;
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            visit(tree as Node, "text", (node: { value: string }) => {
              node.value = node.value + " [PROMISE TRANSFORMED]";
            });
            resolve();
          }, 20);
        });
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [promiseReturningPlugin],
    });

    const block: Block = {
      id: "p-promise-test",
      type: "paragraph",
      isFinalized: true,
      payload: {
        raw: "Standard promise paragraph",
        inline: [{ kind: "text", text: "Standard promise paragraph" }],
      },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [block], components: unifiedRenderer }));

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
      payload: { raw: "Callback transformer text", inline: [{ kind: "text", text: "Callback transformer text" }] },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [block], components: unifiedRenderer }));

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
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            visit(tree as Node, "text", (node: { value: string }) => {
              node.value = node.value + " [ONE SHOT]";
            });
            resolve();
          }, 25);
        });
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [singleInvocationPlugin],
    });

    const block: Block = {
      id: "p-single-invoc",
      type: "paragraph",
      isFinalized: true,
      payload: { raw: "Exact count test", inline: [{ kind: "text", text: "Exact count test" }] },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);


    // Initial render initiates job
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [block], components: unifiedRenderer }));

    // Re-render the same block at 10ms while in-flight
    await delay(10);
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [block], components: unifiedRenderer }));

    // Wait until completed
    await delay(35);
    assert.strictEqual(container.textContent, "Exact count test [ONE SHOT]");

    // Re-render again after completion (hits cache)
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [block], components: unifiedRenderer }));
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

  // Promise rejection and callback errors retain the fallback without retries.
  for (const callbackError of [false, true]) {
    console.log(`Test 10: ${callbackError ? "callback error" : "Promise rejection"} fallback...`);
    let failureInvocations = 0;
    let capturedError: Error | null = null;
    let capturedContext: UnifiedBlockErrorContext | null = null;
    function failingAsyncPlugin() {
      return () => {
        failureInvocations += 1;
        return new Promise<void>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("async failed"));
          }, 20);
        });
      };
    }

    function failingCallbackPlugin() {
      return (_tree: unknown, _file: unknown, next: (error?: Error) => void) => {
        failureInvocations += 1;
        setTimeout(() => next(new Error("async failed")), 20);
      };
    }

    const unifiedRenderer = createUnifiedRenderer({
      remarkPlugins: [callbackError ? failingCallbackPlugin : failingAsyncPlugin],
      onError: (err, context) => {
        capturedError = err;
        capturedContext = context;
      },
    });

    const block: Block = {
      id: "p-fail-test",
      type: "paragraph",
      isFinalized: true,
      payload: { raw: "Error trigger content", inline: [{ kind: "text", text: "Error trigger content" }] },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [block], components: unifiedRenderer }));

    // Wait for failure
    await delay(45);
    assert.ok(capturedError, "onError must be called on plugin failure");
    assert.strictEqual(capturedError?.message, "async failed", "Exact error message must be passed to onError");
    assert.strictEqual(capturedContext?.id, "p-fail-test", "Exact block ID must be passed to onError");
    assert.strictEqual(capturedContext?.type, "paragraph", "Block type must be passed to onError");
    assert.strictEqual(capturedContext?.finalized, true, "Finalized state must be passed to onError");
    assert.strictEqual(failureInvocations, 1, "Failing plugin must be invoked exactly once (no retry)");
    assert.strictEqual(container.textContent, "Error trigger content", "Safe default element is retained");

    root.unmount();
    container.remove();
    console.log("✓ Test 10 passed: Real Error('async failed') dispatches to onError without retry");
  }

  // Test 11: Key change while pending immediately shows new default, NOT stale previous async result
  {
    console.log("Test 11: Key change while pending immediately shows new default...");
    function createGate() {
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    }

    const keyK1 = { started: createGate(), release: createGate(), transformed: createGate() };
    const keyK2 = { started: createGate(), release: createGate(), transformed: createGate() };

    function slowKeyPlugin() {
      return (tree: unknown) => {
        let raw = "";
        visit(tree as Node, "text", (node: { value: string }) => {
          raw += node.value;
        });
        const gate = raw.includes("Alpha") ? keyK1 : keyK2;
        gate.started.resolve();
        return gate.release.promise.then(() => {
          visit(tree as Node, "text", (node: { value: string }) => {
            node.value = node.value + " [TRANSFORMED]";
          });
          gate.transformed.resolve();
        });
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
      payload: { raw: "Content Alpha", inline: [{ kind: "text", text: "Content Alpha" }] },
    };

    const waitForText = (expected: string): Promise<void> => {
      if (container.textContent === expected) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const observer = new dom.window.MutationObserver(() => {
          if (container.textContent !== expected) return;
          clearTimeout(timeout);
          observer.disconnect();
          resolve();
        });
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Timed out waiting for ${JSON.stringify(expected)}`));
        }, 10000);
        observer.observe(container, { childList: true, characterData: true, subtree: true });
      });
    };

    // The plugin gate keeps K1 pending until after the key switch.
    const defaultAlphaVisible = waitForText("Content Alpha");
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [blockK1], components: unifiedRenderer }));
    await Promise.all([keyK1.started.promise, defaultAlphaVisible]);
    assert.strictEqual(container.textContent, "Content Alpha");

    const blockK2: Block = {
      id: "p-key-switch",
      type: "paragraph",
      isFinalized: true,
      payload: { raw: "Content Beta", inline: [{ kind: "text", text: "Content Beta" }] },
    };

    const defaultBetaVisible = waitForText("Content Beta");
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [blockK2], components: unifiedRenderer }));
    await Promise.all([keyK2.started.promise, defaultBetaVisible]);

    // Container MUST immediately show Default Beta, not stale previous pending or async result
    assert.strictEqual(
      container.textContent,
      "Content Beta",
      "Key change while pending must immediately display new default element",
    );

    keyK1.release.resolve();
    await keyK1.transformed.promise;
    const transformedBetaVisible = waitForText("Content Beta [TRANSFORMED]");
    keyK2.release.resolve();
    await Promise.all([keyK2.transformed.promise, transformedBetaVisible]);
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
        const waitMs = isSlow ? 60 : 10;
        return new Promise<void>((resolve) => {
          setTimeout(resolve, waitMs);
        });
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
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [blockV1], components: unifiedRenderer }));

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
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [blockV2], components: unifiedRenderer }));

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

  // Test 13: urlTransform default security policy
  {
    console.log("Test 13: urlTransform default security policy on links and images...");
    const renderer = createUnifiedRenderer();
    const block: Block = {
      id: "p-sec-1",
      type: "paragraph",
      isFinalized: true,
      payload: {
        raw: "[js](javascript:alert(1)) [vbs](vbscript:msgbox(1)) [data-html](data:text/html,<script>alert(1)</script>) [custom](custom-scheme:target) ![safe-img](data:image/png;base64,iVBORw==) ![bad-img](javascript:alert(2))",
      },
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [block], components: renderer }));
    await delay(35);

    assert.ok(!container.innerHTML.includes('href="javascript:'), "javascript: link href must be stripped");
    assert.ok(!container.innerHTML.includes('href="vbscript:'), "vbscript: link href must be stripped");
    assert.ok(!container.innerHTML.includes('href="data:text/html'), "data:text/html link href must be stripped");
    assert.ok(container.innerHTML.includes('href="custom-scheme:target"'), "custom scheme href must be preserved");
    assert.ok(container.innerHTML.includes('src="data:image/png;base64,iVBORw=="'), "data:image/png src must be preserved");
    assert.ok(!container.innerHTML.includes('src="javascript:'), "javascript: image src must be stripped");

    root.unmount();
    container.remove();
    console.log("✓ Test 13 passed: Default urlTransform blocks dangerous schemes and allows safe schemes");
  }

  // Test 14: Custom urlTransform
  {
    console.log("Test 14: Custom urlTransform rewrites and drops URLs...");
    const renderer = createUnifiedRenderer({
      urlTransform: (url) => {
        if (url.startsWith("https://allowed.com")) {
          return url.replace("https://allowed.com", "https://rewritten.com");
        }
        return null;
      },
    });
    const block: Block = {
      id: "p-sec-2",
      type: "paragraph",
      isFinalized: true,
      payload: {
        raw: "[allowed](https://allowed.com/path) [other](https://other.com/path)",
      },
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks: [block], components: renderer }));
    await delay(35);

    assert.ok(container.innerHTML.includes('href="https://rewritten.com/path"'), "custom urlTransform rewrote allowed url");
    assert.ok(!container.innerHTML.includes('href="https://other.com'), "custom urlTransform dropped non-allowed url");

    root.unmount();
    container.remove();
    console.log("✓ Test 14 passed: Custom urlTransform rewrites and drops correctly");
  }

  console.log("All @stream-mdx/unified tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
