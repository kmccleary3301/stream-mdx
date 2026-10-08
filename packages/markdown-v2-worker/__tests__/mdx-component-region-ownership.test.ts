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

const DOM_GLOBAL_KEYS = ["window", "document", "HTMLElement", "Node", "MutationObserver", "navigator"] as const;

/**
 * Installs the browser globals React DOM's client runtime expects. `navigator` comes from the real
 * JSDOM window (Node 20 has no global navigator) and every key is installed with defineProperty
 * because Node 22 already owns a read-only `navigator` accessor that Object.assign cannot replace.
 * Descriptors are captured for exact restore: a window installed by an earlier test file is
 * borrowed and never closed, while an owned JSDOM is closed on cleanup.
 */
function ensureDom(): () => void {
  const previous = new Map(DOM_GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
  const borrowedWindow = (globalThis as { window?: Window }).window;
  const dom = borrowedWindow ? null : new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const target = dom ? dom.window : (borrowedWindow as Window);
  for (const key of DOM_GLOBAL_KEYS) {
    const value = key === "navigator" ? target.navigator : target[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom?.window.close();
  };
}

const restoreDom = ensureDom();

async function waitForDom(container: Element, predicate: () => boolean, message: string): Promise<void> {
  if (predicate()) return;
  const ownerWindow = container.ownerDocument.defaultView;
  assert.ok(ownerWindow, "mounted MDX consumer requires its actual DOM window");
  // This is only a failure deadline. Success waits for real consumer DOM mutations.
  const signal = AbortSignal.timeout(10_000);
  // A typed executor keeps this observer wait compatible with the Node 20 CI runtime
  // (`Promise.withResolvers` only exists from Node 22).
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
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

const QUOTED_FENCED_COMPONENT = ["> <SmokeBox>", ">", "> ```js", "> x", "> ```", ">", "> </SmokeBox>", ""].join("\n");
const QUOTED_OPEN_COMPONENT = ["> <SmokeBox>", ">", "> native mdx $x$", ""].join("\n");
const LIST_OPEN_COMPONENT = ["- <SmokeBox>", "", "  native mdx $x$", ""].join("\n");
const CAPITALIZED_COMPONENT = ["<Input>", "", "inside", "", "</Input>", ""].join("\n");

/** Every block reachable through prepared nested children, containers included. */
function nestedBlocks(block: Block): Block[] {
  const nested = block.payload.meta?.preparedNested as { children?: Array<{ props?: { block?: Block } }> } | undefined;
  const children = (nested?.children ?? [])
    .map((child) => child.props?.block)
    .filter((child): child is Block => Boolean(child));
  return [block, ...children.flatMap((child) => nestedBlocks(child))];
}

async function testQuotedComponentWithFencedCode(): Promise<void> {
  const harness = await createWorkerHarness();
  const blocks = await finalBlocks(harness, initMessage(QUOTED_FENCED_COMPONENT));
  assert.strictEqual(blocks.length, 1, "a quoted component with a fenced block must stay one blockquote root");
  const [root] = blocks;
  assert.ok(root, "the blockquote root must exist");
  assert.strictEqual(root.type, "blockquote", "the quoted component must not escape its blockquote");
  const owner = nestedBlocks(root).find((candidate) => candidate.type === "mdx");
  assert.ok(owner, "the quoted component must become one nested MDX owning root");
  assert.strictEqual(
    owner.payload.raw,
    "<SmokeBox>\n\n```js\nx\n```\n\n</SmokeBox>",
    "the nested owner source must be container-stripped markdown, not a fence carrying quote markers",
  );
  assert.strictEqual(owner.payload.meta?.mdxStatus, "compiled", "a closed quoted component containing a fence must compile");
  assert.ok(owner.payload.compiledMdxModule?.code.includes("_jsx(SmokeBox"), "the compiled module must render the component as its root");
  assert.ok(!owner.payload.compiledMdxModule?.code.includes("</SmokeBox>"), "the compiled module must not retain the raw closing tag");

  const streamed = await finalBlocks(harness, initMessage(""), Array.from(QUOTED_FENCED_COMPONENT));
  assert.deepStrictEqual(streamed, blocks, "character streaming must reach the same final IR for a quoted component with a fence");
}

async function testUnclosedNestedComponentsErrorAtFinalize(): Promise<void> {
  const harness = await createWorkerHarness();
  const streaming = await harness.send(initMessage(QUOTED_OPEN_COMPONENT));
  assertNoErrors(streaming, "INIT");
  const initialized = findMessage(streaming, "INITIALIZED");
  assert.ok(initialized, "worker must initialize");
  const pendingRoot = initialized.blocks[0];
  assert.ok(pendingRoot, "an open quoted component must keep its blockquote root");
  const pendingOwner = nestedBlocks(pendingRoot).find((candidate) => candidate.type === "html");
  assert.ok(pendingOwner, "an open quoted component must stay a native html owner while streaming");
  assert.strictEqual(pendingOwner.isFinalized, false, "an open quoted component must not finalize mid-stream");
  assert.strictEqual(pendingOwner.payload.compiledMdxModule, undefined, "an open quoted component must not compile eagerly");

  const quoted = await finalBlocks(harness, initMessage(QUOTED_OPEN_COMPONENT));
  const quotedOwner = nestedBlocks(quoted[0]!).find((candidate) => candidate.type === "mdx");
  assert.ok(quotedOwner, "finalization must retag the unclosed quoted component as MDX");
  assert.strictEqual(quotedOwner.isFinalized, true, "FINALIZE must finalize the unclosed nested component");
  assert.strictEqual(quotedOwner.payload.meta?.mdxStatus, "error", "an unclosed quoted component must report the native compile error");
  assert.match(String(quotedOwner.payload.meta?.mdxError ?? ""), /closing tag/, "the error must be the native compiler's closing-tag message");

  const listed = await finalBlocks(harness, initMessage(LIST_OPEN_COMPONENT));
  const listOwner = nestedBlocks(listed[0]!).find((candidate) => candidate.type === "mdx");
  assert.ok(listOwner, "finalization must retag an unclosed list component as MDX");
  assert.strictEqual(listOwner.isFinalized, true, "FINALIZE must finalize the unclosed list component");
  assert.strictEqual(listOwner.payload.meta?.mdxStatus, "error", "an unclosed list component must report the native compile error");

  registerMDXComponents({ SmokeBox: SmokeSection }, { replace: true });
  const { container, unmount } = await renderBlocks(quoted);
  try {
    await waitForDom(
      container,
      () => Boolean(container.querySelector('blockquote [data-mdx-status="error"]')),
      "the finalized unclosed quoted component must render its error state",
    );
    const errorNode = container.querySelector('blockquote [data-mdx-status="error"]');
    assert.ok(errorNode?.textContent?.includes("MDX failed"), "the rendered error view must announce the MDX failure");
    assert.ok(errorNode?.textContent?.includes("closing tag"), "the rendered error view must carry the native compiler message");
  } finally {
    unmount();
  }
}

async function testCapitalizedComponentNames(): Promise<void> {
  const harness = await createWorkerHarness();
  const input = await finalBlocks(harness, initMessage(CAPITALIZED_COMPONENT));
  assert.strictEqual(input.length, 1, "a multiline <Input> component must be one owning root");
  assert.strictEqual(input[0]?.type, "mdx", "<Input> must compile as an MDX component");
  assert.strictEqual(input[0]?.payload.meta?.mdxStatus, "compiled", "<Input> is a component, not the void html element");
  assert.ok(input[0]?.payload.compiledMdxModule?.code.includes("_jsx(Input"), "the compiled module must render the Input component");

  const link = await finalBlocks(harness, initMessage(["<Link href=\"/x\">", "", "inside", "", "</Link>", ""].join("\n")));
  assert.strictEqual(link.length, 1, "a multiline <Link> component must be one owning root");
  assert.strictEqual(link[0]?.payload.meta?.mdxStatus, "compiled", "<Link> is a component, not the void html element");
  assert.ok(link[0]?.payload.compiledMdxModule?.code.includes("_jsx(Link"), "the compiled module must render the Link component");

  const commonmark = await finalBlocks(harness, initMessage(CAPITALIZED_COMPONENT, false));
  assert.deepStrictEqual(commonmark.map((block) => block.type), ["html", "paragraph", "html"], "mdx:false must keep CommonMark's blank-line termination for a capitalized tag");
  assert.deepStrictEqual(commonmark.map((block) => block.payload.raw), ["<Input>", "inside", "</Input>"], "mdx:false must keep the raw html fragments untouched");
}

async function testQuotedTextareaCommonMark(): Promise<void> {
  const harness = await createWorkerHarness();
  const doc = ["> <textarea>", ">literal", "> </textarea>", ""].join("\n");
  const quoted = await finalBlocks(harness, initMessage(doc, false));
  assert.strictEqual(quoted.length, 1, "a quoted textarea must stay one blockquote root");
  assert.strictEqual(quoted[0]?.payload.raw, doc.trimEnd(), "the blockquote must own the complete quoted textarea");
  const textarea = nestedBlocks(quoted[0]!).find((block) => block.type === "html");
  assert.ok(textarea, "the textarea must stay a nested html block in CommonMark mode");
  assert.ok(textarea.payload.raw.includes("literal"), "a same-quote continuation line must remain inside the textarea");

  const escapedDoc = ["> <textarea>", ">literal", "outside", ""].join("\n");
  const escaped = await finalBlocks(harness, initMessage(escapedDoc, false));
  assert.strictEqual(escaped.length, 2, "a line outside the quote must end the quoted textarea");
  assert.strictEqual(escaped[0]?.payload.raw, "> <textarea>\n>literal", "the textarea must stop at the blockquote boundary");
  assert.strictEqual(escaped[1]?.payload.raw, "outside", "the outside line must parse as its own paragraph");

  const mdxQuoted = await finalBlocks(harness, initMessage(doc));
  assert.strictEqual(mdxQuoted.length, 1, "mdx:true must keep the same CommonMark textarea shape");
  assert.strictEqual(
    nestedBlocks(mdxQuoted[0]!).find((block) => block.type === "html")?.payload.raw.includes("literal"),
    true,
    "a lowercase textarea must not become MDX",
  );
}

try {
  await testMultilineComponentOwnership();
  await testCharacterStreamingMatchesStatic();
  await testIncompleteComponentStaysPending();
  await testSiblingsAndNestingRetained();
  await testNestedContainerOwnership();
  await testMdxDisabledAndRawHtmlUnchanged();
  await testMdxDomRender();
  await testNestedRegionDomRender();
  await testQuotedComponentWithFencedCode();
  await testUnclosedNestedComponentsErrorAtFinalize();
  await testCapitalizedComponentNames();
  await testQuotedTextareaCommonMark();
  console.log("mdx component region ownership test passed");
} finally {
  restoreDom();
}
