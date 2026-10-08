import assert from "node:assert";

import type { Block, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { registerInlineMdxModule, registerMDXComponents } from "../../markdown-v2-react/src/mdx-client";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { ComponentRegistry } from "../../markdown-v2-react/src/components";
import { BlockNodeRenderer } from "../../markdown-v2-react/src/renderer/node-views";

import { createWorkerHarness, type WorkerHarness } from "./worker-test-harness";

function ensureDom(): void {
  // Unchecked cast: jsdom provides browser globals that React DOM expects on globalThis.
  const globalScope = globalThis as typeof globalThis & { window?: unknown };
  if (globalScope.window !== undefined) {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
  });
}

async function waitForDom(container: Element, predicate: () => boolean, message: string): Promise<void> {
  if (predicate()) return;
  const ownerWindow = container.ownerDocument.defaultView;
  assert.ok(ownerWindow, "mounted MDX consumer requires its actual DOM window");
  // This is only a failure deadline. Success waits for real consumer DOM mutations.
  const signal = AbortSignal.timeout(10_000);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const observer = new ownerWindow.MutationObserver(() => {
    if (predicate()) settle();
  });
  const settle = () => {
    observer.disconnect();
    signal.removeEventListener("abort", fail);
    resolve();
  };
  const fail = () => {
    observer.disconnect();
    reject(new Error(`${message}: ${container.innerHTML}`));
  };
  signal.addEventListener("abort", fail, { once: true });
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  if (predicate()) settle();
  return promise;
}

async function renderBlocks(blocks: Block[]): Promise<{ container: HTMLElement; unmount: () => void }> {
  ensureDom();
  const store = createRendererStore();
  store.reset(blocks);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const registry = new ComponentRegistry();
  root.render(
    React.createElement(
      React.Fragment,
      null,
      blocks.map((block) => React.createElement(BlockNodeRenderer, { key: block.id, store, blockId: block.id, registry })),
    ),
  );
  return {
    container,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

// A complete JSX/MDX component whose block has blank lines inside. Native CommonMark HTML block
// type 7 stops at the blank line, so the engine must keep the balanced component as one region
// owning root when MDX is enabled instead of compiling an opening-only block.
const MULTILINE_COMPONENT = ["<SmokeBox>", "", "native mdx &copy; $x$", "", "</SmokeBox>", ""].join("\n");

const DOC_PLUGINS = { html: true, math: true, mdx: true, footnotes: false, callouts: false, tables: true };

function initMessage(initialContent: string, mdx = true): WorkerIn {
  return {
    type: "INIT",
    initialContent,
    prewarmLangs: [],
    docPlugins: { ...DOC_PLUGINS, mdx },
    mdx: { compileMode: "worker" },
  };
}

function findMessage<T extends WorkerOut["type"]>(messages: WorkerOut[], type: T): Extract<WorkerOut, { type: T }> | undefined {
  return messages.find((message): message is Extract<WorkerOut, { type: T }> => message.type === type);
}

function assertNoErrors(messages: WorkerOut[], phase: string): void {
  for (const message of messages) {
    if (message.type === "ERROR") {
      assert.fail(`worker error during ${phase}: ${message.error.message}`);
    }
  }
}

async function finalBlocks(harness: WorkerHarness, init: WorkerIn, appends: string[] = []): Promise<Block[]> {
  const initMessages = await harness.send(init);
  assertNoErrors(initMessages, "INIT");
  for (const chunk of appends) {
    assertNoErrors(await harness.send({ type: "APPEND", text: chunk }), "APPEND");
  }
  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  assertNoErrors(finalizeMessages, "FINALIZE");
  const dump = await harness.send({ type: "DUMP_BLOCKS" });
  const dumpMessage = findMessage(dump, "DUMP_BLOCKS");
  assert.ok(dumpMessage, "worker must answer DUMP_BLOCKS");
  return dumpMessage.blocks;
}

async function testMultilineComponentOwnership(): Promise<void> {
  const harness = await createWorkerHarness();
  const blocks = await finalBlocks(harness, initMessage(MULTILINE_COMPONENT));

  assert.strictEqual(blocks.length, 1, "a balanced component must be one owning root with no outside paragraph or end tag");
  const [component] = blocks;
  assert.ok(component, "component root must exist");
  assert.strictEqual(component.type, "mdx", "the owning root must render as MDX");
  assert.strictEqual(component.payload.raw, MULTILINE_COMPONENT.trimEnd(), "the root must own the complete component source");
  assert.strictEqual(component.isFinalized, true, "finalized parse must finalize the owning root");
  assert.strictEqual(component.payload.meta?.originalType, "html", "the root must record its native html block origin");
  assert.strictEqual(component.payload.meta?.htmlOwnership, true, "the root must be an owned html region");

  const module = component.payload.compiledMdxModule;
  assert.ok(module, "the owning root must carry a compiled module, not a pending placeholder");
  assert.strictEqual(module.source, "worker", "worker compile mode must mark the module source");
  assert.strictEqual(component.payload.compiledMdxRef?.id, module.id, "compiled reference must resolve to the module");
  assert.notStrictEqual(component.payload.compiledMdxRef?.id, "pending", "the owning root must not stay pending after finalize");
  assert.ok(module.code.includes("_jsx(SmokeBox"), "the compiled module must render the component as its MDX root");
  assert.ok(module.code.includes("native mdx \u00A9 "), "entities inside the component must decode in the compiled module");
  assert.ok(module.code.includes("katex"), "math inside the component must compile through the worker math pipeline");
  assert.ok(!module.code.includes("</SmokeBox>"), "the compiled module must not retain the raw closing tag");
}

async function testCharacterStreamingMatchesStatic(): Promise<void> {
  const harness = await createWorkerHarness();
  const staticBlocks = await finalBlocks(harness, initMessage(MULTILINE_COMPONENT));
  const streamedBlocks = await finalBlocks(
    harness,
    initMessage(""),
    Array.from(MULTILINE_COMPONENT),
  );
  assert.deepStrictEqual(streamedBlocks, staticBlocks, "one-character streaming must reach the same final IR as a static parse");
}

async function testIncompleteComponentStaysPending(): Promise<void> {
  const harness = await createWorkerHarness();
  const open = "<SmokeBox>\n\nnative mdx $x$";
  const initMessages = await harness.send(initMessage(open));
  assertNoErrors(initMessages, "INIT");
  const initialized = findMessage(initMessages, "INITIALIZED");
  assert.ok(initialized, "worker must initialize");
  const openBlocks = initialized.blocks;
  assert.strictEqual(openBlocks.length, 1, "an incomplete component must remain one pending root");
  assert.strictEqual(openBlocks[0]?.type, "html", "an unclosed container must not be compiled as MDX before its close");
  assert.strictEqual(openBlocks[0]?.isFinalized, false, "an incomplete component must not finalize");
  assert.strictEqual(openBlocks[0]?.payload.compiledMdxModule, undefined, "an incomplete component must not compile eagerly");

  const finalized = await finalBlocks(harness, initMessage(open));
  assert.strictEqual(finalized[0]?.type, "mdx", "an unclosed component is MDX at finalization");
  assert.strictEqual(finalized[0]?.payload.meta?.mdxStatus, "error", "an unclosed component must report its compile error when finalized");
  assert.ok(finalized[0]?.payload.meta?.mdxError, "the finalized error must carry the native compiler message");
}

async function testSiblingsAndNestingRetained(): Promise<void> {
  const harness = await createWorkerHarness();
  const withTrailing = await finalBlocks(
    harness,
    initMessage(["<SmokeBox>", "", "inside", "", "</SmokeBox>", "", "after paragraph", ""].join("\n")),
  );
  assert.strictEqual(withTrailing.length, 2, "a following paragraph must stay outside the component root");
  assert.strictEqual(withTrailing[0]?.type, "mdx", "the component root must remain MDX");
  assert.strictEqual(withTrailing[1]?.payload.raw, "after paragraph", "the following paragraph must be retained as its own block");

  const nested = await finalBlocks(
    harness,
    initMessage(["<Outer>", "", "<Inner>", "", "x", "", "</Inner>", "", "</Outer>", ""].join("\n")),
  );
  assert.strictEqual(nested.length, 1, "nested component tags must stay one owning root");
  assert.strictEqual(nested[0]?.type, "mdx", "nested components must compile as MDX");

  const selfClosing = await finalBlocks(harness, initMessage(["<Logo />", "", "following paragraph", ""].join("\n")));
  assert.strictEqual(selfClosing.length, 2, "a self-closing component must not swallow the following paragraph");
  assert.strictEqual(selfClosing[0]?.type, "mdx", "a self-closing component is a standalone MDX root");
  assert.strictEqual(selfClosing[1]?.type, "paragraph", "the paragraph after a self-closing component must be retained");

  const dottedChild = await finalBlocks(
    harness,
    initMessage(["<SmokeBox>", "", "<Foo.Bar x={1} />", "", "inside", "", "</SmokeBox>", ""].join("\n")),
  );
  assert.strictEqual(dottedChild.length, 1, "dotted child tags must not break the component balance");
  assert.strictEqual(dottedChild[0]?.type, "mdx", "a component with dotted child tags must compile as MDX");
}

async function testNestedContainerOwnership(): Promise<void> {
  const harness = await createWorkerHarness();
  const blocks = await finalBlocks(
    harness,
    initMessage(["> <SmokeBox>", ">", "> native mdx $x$", ">", "> </SmokeBox>", ""].join("\n")),
  );
  assert.strictEqual(blocks.length, 1, "the quoted component must stay one blockquote root");
  const nested = blocks[0]?.payload.meta?.preparedNested as { children?: Array<{ props?: { block?: Block } }> } | undefined;
  const childBlocks = (nested?.children ?? []).map((child) => child.props?.block).filter((block): block is Block => Boolean(block));
  assert.strictEqual(childBlocks.length, 1, "the quoted component must become one nested owning root");
  assert.strictEqual(childBlocks[0]?.type, "mdx", "the nested owning root must compile as MDX");
  assert.strictEqual(childBlocks[0]?.payload.compiledMdxModule?.source, "worker", "the nested owning root must compile in the worker");
  assert.strictEqual(childBlocks[0]?.payload.raw, "<SmokeBox>\n\nnative mdx $x$\n\n</SmokeBox>", "the nested owner must hold marker-free component source");
}

async function testMdxDisabledAndRawHtmlUnchanged(): Promise<void> {
  const harness = await createWorkerHarness();
  const htmlOnly = await finalBlocks(harness, initMessage(MULTILINE_COMPONENT, false));
  assert.strictEqual(htmlOnly.length, 1, "mdx:false must keep the native ownership region");
  assert.strictEqual(htmlOnly[0]?.type, "html", "mdx:false must not retag the component as MDX");
  assert.strictEqual(htmlOnly[0]?.payload.meta?.htmlOwnership, true, "mdx:false must keep the native html ownership root");
  assert.strictEqual(htmlOnly[0]?.payload.compiledMdxModule, undefined, "mdx:false must not compile MDX artifacts");

  const lowercase = await finalBlocks(harness, initMessage(["<div>", "", "content **b**", "", "</div>", ""].join("\n")));
  assert.strictEqual(lowercase.length, 1, "ordinary raw HTML must keep its owned region");
  assert.strictEqual(lowercase[0]?.type, "html", "ordinary lowercase raw HTML must not become MDX");
  assert.strictEqual(lowercase[0]?.payload.raw, "<div>\n\ncontent **b**\n\n</div>", "raw HTML regions must keep their full source");
}

function SmokeSection(props: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement("section", { "data-smoke": "true" }, props.children);
}

async function testMdxDomRender(): Promise<void> {
  const harness = await createWorkerHarness();
  const blocks = await finalBlocks(harness, initMessage(MULTILINE_COMPONENT));
  const module = blocks[0]?.payload.compiledMdxModule;
  assert.ok(module, "the owning root must expose its compiled module to the renderer");
  registerMDXComponents({ SmokeBox: SmokeSection }, { replace: true });
  registerInlineMdxModule({ id: module.id, code: module.code, dependencies: module.dependencies });
  const { container, unmount } = await renderBlocks(blocks);
  try {
    await waitForDom(
      container,
      () => Boolean(container.querySelector('section[data-smoke="true"] .katex')),
      "the owned multiline MDX root must render its component with compiled math",
    );
    assert.ok(
      container.querySelector('section[data-smoke="true"]')?.textContent?.includes("native mdx \u00A9"),
      "the rendered MDX must include the decoded entity text",
    );
    assert.strictEqual(container.querySelector(".mdx-error"), null, "the rendered MDX must not fall back to an error view");
  } finally {
    unmount();
  }
}

async function testNestedRegionDomRender(): Promise<void> {
  const harness = await createWorkerHarness();
  const blocks = await finalBlocks(
    harness,
    initMessage(["> <SmokeBox>", ">", "> native mdx $x$", ">", "> </SmokeBox>", ""].join("\n")),
  );
  registerMDXComponents({ SmokeBox: SmokeSection }, { replace: true });
  const nested = blocks[0]?.payload.meta?.preparedNested as { children?: Array<{ props?: { block?: Block } }> } | undefined;
  for (const child of nested?.children ?? []) {
    const compiled = child.props?.block?.payload.compiledMdxModule;
    if (compiled && typeof compiled.code === "string") {
      registerInlineMdxModule({ id: compiled.id, code: compiled.code, dependencies: compiled.dependencies });
    }
  }
  const { container, unmount } = await renderBlocks(blocks);
  try {
    await waitForDom(
      container,
      () => Boolean(container.querySelector("blockquote section[data-smoke='true'] .katex")),
      "the nested owned MDX region must render inside its blockquote",
    );
  } finally {
    unmount();
  }
}

await testMultilineComponentOwnership();
await testCharacterStreamingMatchesStatic();
await testIncompleteComponentStaysPending();
await testSiblingsAndNestingRetained();
await testNestedContainerOwnership();
await testMdxDisabledAndRawHtmlUnchanged();
await testMdxDomRender();
await testNestedRegionDomRender();
console.log("mdx component region ownership test passed");
