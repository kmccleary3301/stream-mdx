import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Block, WorkerOut } from "@stream-mdx/core";
import { createRendererStore, type RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { ComponentRegistry } from "../../markdown-v2-react/src/components";
import { BlockNodeRenderer } from "../../markdown-v2-react/src/renderer/node-views";
import { createWorkerHarness, type WorkerHarness } from "./worker-test-harness";

function ensureDom(): void {
  if (typeof window !== "undefined") {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
}

ensureDom();

// Deterministic pseudo-random number generator
function createRng(seed = 123456789) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function runSession(harness: WorkerHarness, chunks: string[]): Promise<RendererStore> {
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: ["typescript"],
    docPlugins: { footnotes: true, html: true, mdx: true, math: true, tables: true, callouts: true },
    mdx: { compileMode: "worker" },
  });
  assertNoErrors(initMessages);
  const init = initMessages.find((m): m is Extract<WorkerOut, { type: "INITIALIZED" }> => m.type === "INITIALIZED");
  assert.ok(init, "worker must initialize before applying patches");
  store.reset(init.blocks);
  for (const msg of initMessages) {
    if (msg.type === "PATCH") store.applyPatches(msg.patches, { captureMetrics: false });
  }

  for (const chunk of chunks) {
    const appendMessages = await harness.send({ type: "APPEND", text: chunk });
    assertNoErrors(appendMessages);
    for (const msg of appendMessages) {
      if (msg.type === "PATCH") {
        store.applyPatches(msg.patches, { captureMetrics: false });
      }
    }
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  assertNoErrors(finalizeMessages);
  for (const msg of finalizeMessages) {
    if (msg.type === "PATCH") {
      store.applyPatches(msg.patches, { captureMetrics: false });
    }
  }

  assert.strictEqual(finalizeMessages.at(-1)?.type, "FINALIZED", "final store requires terminal FINALIZED after all patches");
  assert.ok(store.getBlocks().every((block) => block.isFinalized), "terminal blocks must all be finalized");
  return store;
}


function assertNoErrors(messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "ERROR") {
      assert.fail(`Worker error during ${message.phase}: ${message.error.message}`);
    }
  }
}

const ARTIFACT_FIXTURE = [
  "```ts",
  "const answer = 42;",
  "```",
  "",
  '<div><strong>Safe HTML</strong><img src="https://example.com/image.png" onerror="alert(1)"><a href="javascript:alert(1)">unsafe link</a><a href="https://example.com/safe" onclick="alert(1)">safe link</a><script>alert(1)</script></div>',
  "",
  "Inline math $E = mc^2$.",
  "",
  "$$",
  "x^2",
  "$$",
  "",
  "MDX result: {Math.imul(6, 7)}.",
  "",
].join("\n");

function assertArtifacts(blocks: ReadonlyArray<Block>): void {
  const code = blocks.find((block) => block.type === "code");
  assert.ok(code?.payload.highlightedHtml, "code must carry highlighted HTML");
  const highlighted = new JSDOM(code.payload.highlightedHtml).window.document;
  assert.strictEqual(highlighted.querySelector("code")?.textContent?.trim(), "const answer = 42;");
  assert.ok(
    highlighted.querySelector('.line span[style*="--shiki-dark:"][style*="--shiki-light:"]'),
    "highlighting must contain dark and light token colors",
  );

  const html = blocks.find((block) => block.type === "html");
  assert.ok(html?.payload.sanitizedHtml, "HTML must carry a sanitized artifact");
  const sanitized = new JSDOM(html.payload.sanitizedHtml).window.document;
  assertSafeHtml(sanitized.body);

  const mdx = blocks.find((block) => block.type === "mdx");
  assert.ok(mdx?.payload.compiledMdxModule, "MDX must carry its compiled module, not just raw source");
  assert.strictEqual(mdx.payload.meta?.mdxStatus, "compiled");
  assert.strictEqual(mdx.payload.compiledMdxModule.source, "worker");
  assert.strictEqual(mdx.payload.compiledMdxRef?.id, mdx.payload.compiledMdxModule.id, "reference must resolve to the module");
  assert.notStrictEqual(mdx.payload.compiledMdxRef?.id, "pending");
  assert.ok(mdx.payload.compiledMdxModule.code.includes("Math.imul(6, 7)"), "compiled module must retain the expression");
  assert.deepStrictEqual(mdx.payload.compiledMdxModule.dependencies, []);
}

function assertSafeHtml(container: Element): void {
  assert.strictEqual(container.querySelector("strong")?.textContent, "Safe HTML");
  assert.strictEqual(container.querySelector('a[href="https://example.com/safe"]')?.textContent, "safe link");
  assert.strictEqual(container.querySelector("img")?.getAttribute("src"), "https://example.com/image.png");
  assert.strictEqual(container.querySelector("script, [onerror], [onclick]"), null, "executable HTML must be stripped");
  assert.strictEqual(container.querySelector('a[href^="javascript:"]'), null, "unsafe link scheme must be stripped");
}

async function assertArtifactDom(store: RendererStore): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const ownerWindow = container.ownerDocument.defaultView;
  assert.ok(ownerWindow, "mounted artifact consumer requires its actual DOM window");
  const registry = new ComponentRegistry();
  // This is only a failure deadline. Success waits for real consumer DOM mutations
  // from the KaTeX and MDX dynamic imports, not a guessed rendering delay.
  const signal = AbortSignal.timeout(10_000);
  try {
    await new Promise<void>((resolve, reject) => {
      const observer = new ownerWindow.MutationObserver(check);
      function cleanup() {
        observer.disconnect();
        signal.removeEventListener("abort", fail);
      }
      function fail() {
        cleanup();
        reject(new Error(`Consumer artifacts did not render: ${container.innerHTML}`));
      }
      function check() {
        if (
          container.querySelector(".math-inline .katex") &&
          container.querySelector(".math-display .katex") &&
          container.querySelector(".mdx-p")?.textContent === "MDX result: 42."
        ) {
          cleanup();
          resolve();
        }
      }
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      signal.addEventListener("abort", fail, { once: true });
      root.render(
        React.createElement(
          React.Fragment,
          null,
          store.getBlocks().map((block) =>
            React.createElement(BlockNodeRenderer, { key: block.id, store, blockId: block.id, registry }),
          ),
        ),
      );
      check();
    });
    assert.strictEqual(container.querySelector("pre code")?.textContent?.trim(), "const answer = 42;");
    assert.ok(
      container.querySelector('pre code .line span[style*="--shiki-dark:"][style*="--shiki-light:"]'),
      `DOM must use highlighted code for both themes: ${container.querySelector("pre")?.outerHTML}`,
    );
    assert.strictEqual(container.querySelector(".math-inline .katex annotation")?.textContent, "E = mc^2");
    assert.strictEqual(container.querySelector(".math-display .katex annotation")?.textContent, "x^2");
    assert.strictEqual(container.querySelector(".mdx-p")?.textContent, "MDX result: 42.", "DOM must evaluate compiled MDX");
    assert.strictEqual(container.querySelector(".mdx-error"), null, "MDX fallback is not successful compilation");
    assertSafeHtml(container);
    return container.innerHTML;
  } finally {
    root.unmount();
    container.remove();
  }
}

async function runParityTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const artifactSingle = await runSession(harness, [ARTIFACT_FIXTURE]);
  const artifactStreamed = await runSession(harness, Array.from(ARTIFACT_FIXTURE));
  // Worker artifact IDs are deterministic content references, so retain them too.
  assert.deepStrictEqual(artifactStreamed.getBlocks(), artifactSingle.getBlocks(), "character chunking must retain every consumer artifact");
  for (const store of [artifactSingle, artifactStreamed]) assertArtifacts(store.getBlocks());
  assert.strictEqual(await assertArtifactDom(artifactStreamed), await assertArtifactDom(artifactSingle), "artifact DOM must match single-shot output");
  const fixturesDir = join(import.meta.dirname, "../../../apps/docs/public/perf/fixtures");
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".md")).sort();
  assert.ok(files.length > 0, "expected fixtures to be found");

  const rng = createRng(42);

  for (const file of files) {
    const content = readFileSync(join(fixturesDir, file), "utf8");
    if (!content.trim()) continue;

    // 1. Single-shot parse
    const singleShotStore = await runSession(harness, [content]);

    // 2. Random chunking parse
    const chunks: string[] = [];
    let pos = 0;
    while (pos < content.length) {
      const chunkSize = Math.max(16, Math.floor(rng() * 112) + 16);
      chunks.push(content.slice(pos, pos + chunkSize));
      pos += chunkSize;
    }

    const streamedStore = await runSession(harness, chunks);
    const singleShotBlocks = singleShotStore.getBlocks();
    const streamedBlocks = streamedStore.getBlocks();

    assert.strictEqual(
      streamedBlocks.length,
      singleShotBlocks.length,
      `block count mismatch for fixture ${file}: streamed=${streamedBlocks.length} single=${singleShotBlocks.length}`,
    );

    assert.deepStrictEqual(
      streamedBlocks,
      singleShotBlocks,
      `blocks differ between random chunking and single-shot parse for fixture ${file}`,
    );
  }

  console.log("incremental-chunking-parity test passed");
}

await runParityTest();
