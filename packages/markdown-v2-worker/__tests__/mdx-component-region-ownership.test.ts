import assert from "node:assert";
import { readFile } from "node:fs/promises";

import { createBlockSnapshot, type Block, type InlineNode, type NodeSnapshot, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { createRendererStore, type RendererStore } from "../../markdown-v2-react/src/renderer/store";
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
 * A window installed by an earlier test file is borrowed only when it already provides the DOM APIs
 * this fixture installs; otherwise an owned JSDOM is installed over the earlier descriptors, which
 * are restored without closing the earlier window. An owned JSDOM is closed on cleanup.
 */
function ensureDom(): () => void {
  const previous = new Map(DOM_GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
  const candidate = (globalThis as { window?: Window }).window;
  const borrowedWindow = candidate && typeof candidate.MutationObserver === "function" && typeof candidate.HTMLElement === "function" ? candidate : null;
  const dom = borrowedWindow ? null : new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const target = dom ? dom.window : (borrowedWindow as Window);
  // Prepare every value before the first defineProperty call so a setup failure cannot leave a
  // partially installed fixture.
  const values = new Map<string, unknown>(DOM_GLOBAL_KEYS.map((key) => [key, key === "navigator" ? target.navigator : target[key]]));
  for (const [key, value] of values) {
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

async function renderBlocks(blocks: Block[], existingStore?: RendererStore, registry = new ComponentRegistry(), projection: "native" | "registry" = "native"): Promise<{ container: HTMLElement; unmount: () => void }> {
  const store = existingStore ?? createRendererStore();
  if (!existingStore) store.reset(blocks);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(
    React.createElement(
      React.Fragment,
      null,
      blocks.map((block) => projection === "registry" ? registry.renderBlock(block) : React.createElement(BlockNodeRenderer, { key: block.id, store, blockId: block.id, registry })),
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

async function testUnfinishedHtmlFixtureOwnership(): Promise<void> {
  const source = await readFile(new URL("../../../tests/regression/fixtures/block-html-no-swallow.md", import.meta.url), "utf8");
  const paragraph = "This paragraph must remain visible as plain markdown text after the unfinished block tag.";
  const item = "The following list item must also remain visible.";
  for (const mdx of [false, true]) {
    const harness = await createWorkerHarness();
    const blocks = await finalBlocks(harness, initMessage(source, mdx));
    assert.deepStrictEqual(blocks.map((block) => block.type), ["heading", "paragraph", "html", "paragraph", "list"], "an unfinished HTML owner must stop at its native blank-line boundary");
    assert.strictEqual(blocks[2]?.payload.raw, '<div class="callout">\nThis block-style HTML never closes in the streamed input.', "the HTML owner must retain only its authored native range");
    assert.strictEqual(blocks[3]?.payload.raw, paragraph, "the following paragraph must remain a complete sibling");
    assert.strictEqual(blocks[4]?.payload.raw, `- ${item}`, "the following list must remain a complete sibling");
    const streamed = await finalBlocks(harness, initMessage("", mdx), Array.from(source));
    assert.deepStrictEqual(streamed, blocks, "unfinished HTML must reach the same conservative ownership through character streaming");
    const { container, unmount } = await renderBlocks(blocks);
    try {
      await waitForDom(container, () => container.textContent?.includes(paragraph) === true && container.textContent.includes(item), "the unfinished HTML fixture must retain its following paragraph and list");
      const callout = container.querySelector("div.callout");
      const sibling = Array.from(container.querySelectorAll("p")).find((node) => node.textContent === paragraph);
      const list = container.querySelector("ul");
      assert.ok(callout && sibling && list, "the authored HTML, paragraph, and list must all render");
      assert.strictEqual(callout.textContent?.trim(), "This block-style HTML never closes in the streamed input.", "the unfinished element must not acquire following block text");
      assert.strictEqual(sibling.parentElement, container, "the following paragraph must render at the root");
      assert.strictEqual(list.parentElement, container, "the following list must render at the root");
      assert.strictEqual(sibling.closest(".callout"), null, "the paragraph must have no speculative HTML ancestor");
      assert.strictEqual(list.closest(".callout"), null, "the list must have no speculative HTML ancestor");
      assert.deepStrictEqual(Array.from(list.querySelectorAll("li")).map((node) => node.textContent), [item], "the list must retain its authored item order and text");
      assert.strictEqual(sibling.nextElementSibling, list, "the paragraph and list must retain their sibling order");
    } finally {
      unmount();
    }

    const balanced = await finalBlocks(harness, initMessage(['<div class="callout">', "", paragraph, "", `- ${item}`, "", "</div>", "", "Outside the balanced region.", ""].join("\n"), mdx));
    assert.deepStrictEqual(balanced.map((block) => block.type), ["html", "paragraph"], "an authored close must keep the balanced region owning its content across blank lines");
    assert.strictEqual(balanced[0]?.payload.meta?.htmlOwnership, true, "the balanced control must remain a grouped HTML owner");
    const rendered = await renderBlocks(balanced);
    try {
      await waitForDom(rendered.container, () => Boolean(rendered.container.querySelector(".callout ul li")), "the balanced HTML control must render its owned list");
      assert.strictEqual(rendered.container.querySelector(".callout p")?.textContent, paragraph, "the balanced region must retain its paragraph inside the authored ancestor");
      assert.deepStrictEqual(Array.from(rendered.container.querySelectorAll(".callout li")).map((node) => node.textContent), [item], "the balanced region must retain its list topology and text");
      const outside = Array.from(rendered.container.querySelectorAll("p")).find((node) => node.textContent === "Outside the balanced region.");
      assert.ok(outside, "the balanced control must retain its following paragraph");
      assert.strictEqual(outside.parentElement, rendered.container, "the authored close must end HTML ownership");
    } finally {
      rendered.unmount();
    }
  }
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

function assertPreparedProjection(store: RendererStore, snapshot: NodeSnapshot, fixture: string): void {
  const node = store.getNode(snapshot.id);
  assert.ok(node, `${fixture}: PATCH consumer must retain ${snapshot.id}`);
  assert.strictEqual(node.type, snapshot.type, `${fixture}: native node type must survive PATCH projection`);
  assert.deepStrictEqual(store.getChildren(snapshot.id), (snapshot.children ?? []).map((child) => child.id), `${fixture}: PATCH child order must match the serialized native tree at ${snapshot.id}`);
  assert.deepStrictEqual(store.getChildrenWithVersion(snapshot.id).children, store.getChildren(snapshot.id), `${fixture}: subscribed renderer children must match structural children at ${snapshot.id}`);
  if (snapshot.props?.block) {
    assert.strictEqual(node.block?.payload.raw, (snapshot.props.block as Block).payload.raw, `${fixture}: authored block source must survive PATCH projection`);
  }
  for (const child of snapshot.children ?? []) assertPreparedProjection(store, child, fixture);
}

async function testRegressionFixtureParagraphOwnership(): Promise<void> {
  const fixtures = ["inline-html-allowlist.md", "mdx-tag-allowlist-inline.mdx", "mdx-tag-no-swallow-negative.mdx", "mdx-expression-no-swallow-negative.mdx", "nested-formatting-ancestors.md", "nested-math-inline.md", "nested-blockquote-list-crossover.md"];
  const cases = fixtures.flatMap((fixture) => fixture.startsWith("mdx-tag-")
    ? [{ fixture, chunkSize: 1 }, { fixture, chunkSize: 19 }]
    : [{ fixture, chunkSize: 1 }]).flatMap((scenario) =>
      scenario.fixture.startsWith("nested-") ? [{ ...scenario, custom: false }] : [{ ...scenario, custom: false }, { ...scenario, custom: true }],
    );
  for (const { fixture, chunkSize, custom } of cases) {
    const source = await readFile(new URL(`../../../tests/regression/fixtures/${fixture}`, import.meta.url), "utf8");
    const harness = await createWorkerHarness();
    const store = createRendererStore();
    const init = initMessage("");
    assert.strictEqual(init.type, "INIT");
    if (init.type !== "INIT") throw new Error("fixture initialization requires INIT");
    init.docPlugins = {
      ...DOC_PLUGINS,
      formatAnticipation: { inline: true, html: true, mdx: true },
      mdxComponentNames: ["InlineChip", "DangerChip", "Preview", "PreviewExample", "YouTube", "Image"],
    };
    const initialized = findMessage(await harness.send(init), "INITIALIZED");
    assert.ok(initialized, `${fixture} must initialize`);
    store.reset(initialized.blocks);
    const apply = (messages: WorkerOut[]) => {
      assertNoErrors(messages, fixture);
      for (const message of messages) {
        if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
        // Exercise the subscription caches throughout streaming, not only after FINALIZE.
        for (const block of store.getBlocks()) {
          const visit = (id: string): void => {
            store.getNodeWithVersion(id);
            for (const child of store.getChildrenWithVersion(id).children) visit(child);
          };
          visit(block.id);
        }
      }
    };
    // Replay the complete browser fixture through real worker patches, not a cold consumer reset.
    const chunks = Array.from({ length: Math.ceil(source.length / chunkSize) }, (_, index) => source.slice(index * chunkSize, (index + 1) * chunkSize));
    for (const text of chunks) {
      apply(await harness.send({ type: "SET_CREDITS", credits: 1 }));
      apply(await harness.send({ type: "APPEND", text }));
    }
    apply(await harness.send({ type: "FINALIZE" }));
    apply(await harness.send({ type: "SET_CREDITS", credits: 1 }));
    const dump = findMessage(await harness.send({ type: "DUMP_BLOCKS" }), "DUMP_BLOCKS");
    assert.ok(dump, `${fixture} must publish its final blocks`);
    assert.ok(!dump.blocks.flatMap((block) => nestedBlocks(block)).some((block) => block.type === "mdx"), `${fixture} prose must never compile as a block module`);
    assert.deepStrictEqual(store.getInvariantViolations(), [], `${fixture}: real PATCH projection must retain store invariants`);
    const resetStore = createRendererStore(JSON.parse(JSON.stringify(dump.blocks)) as Block[]);
    for (const block of dump.blocks) {
      const snapshot = createBlockSnapshot(block);
      assertPreparedProjection(store, snapshot, fixture);
      assertPreparedProjection(resetStore, snapshot, `${fixture}: serialized reset`);
    }
    const registry = new ComponentRegistry();
    if (custom) {
      // Exercise the real extension contract used by configureDemoRegistry, not only default views.
      registry.setBlockComponents({
        paragraph: ({ children }: { inlines: InlineNode[]; children?: React.ReactNode }) =>
          React.createElement("p", { className: "markdown-paragraph", "data-custom-paragraph": true }, children),
        blockquote: ({ renderedContent }: { inlines: InlineNode[]; renderedContent?: React.ReactNode }) =>
          React.createElement("blockquote", { className: "markdown-blockquote", "data-custom-quote": true }, renderedContent),
      });
    }
    const { container, unmount } = await renderBlocks(dump.blocks, store, registry);
    try {
      const required = fixture === "inline-html-allowlist.md"
        ? ["Blockquote with nested inline HTML:", "npm run docs:dev", "and trailing prose."]
        : fixture === "mdx-tag-allowlist-inline.mdx"
          ? ["Prefix text with", "trailing prose that must remain visible", "sibling text afterward.", "trailing content."]
          : fixture === "mdx-tag-no-swallow-negative.mdx"
            ? ["Prefix text with", "trailing prose that must stay visible", "This following paragraph must remain outside any speculative MDX repair."]
            : fixture === "nested-formatting-ancestors.md"
              ? ["Blockquote line with", "Quoted list item with nested strong text", "Quoted list item with nested italic text"]
              : fixture === "nested-math-inline.md"
                ? ["Blockquote with inline math:", "Quoted nested item with inline math:", "Final sibling after nested math"]
                : fixture === "nested-blockquote-list-crossover.md"
                  ? ["Blockquote layer with partial code `beta", "Nested list in quote with cite {cite:12", "Another nested item with inline math $x + y", "Return to sibling list item"]
                  : ["Prefix text with {expr and trailing prose that must stay visible.", "sibling prose that must remain visible", "quoted sibling prose that must remain visible"];
      await waitForDom(container, () => required.every((text) => container.textContent?.includes(text)), `${fixture} must preserve every prose owner`);
      if (fixture === "inline-html-allowlist.md") {
        assert.ok(container.querySelector("blockquote code"), "normalized quoted HTML must retain the code element");
        assert.strictEqual(container.querySelector("blockquote > p")?.textContent, "Blockquote with nested inline HTML: npm run docs:dev and trailing prose.", "the complete quoted sentence must remain one native paragraph");
      } else if (fixture === "mdx-tag-allowlist-inline.mdx") {
        assert.ok(container.querySelector('.markdown-mdx-inline[data-mdx-status="pending"]'), "allowed inline JSX must retain its pending marker at FINALIZE");
        assert.strictEqual(container.querySelector('.markdown-mdx-inline[data-mdx-status="pending"]')?.textContent, '<InlineChip tone="warm"/>', "the allowed tag must retain the source-derived self-closing lookahead projection");
        assert.ok(container.querySelector("blockquote")?.textContent?.includes('<InlineChip tone="sharp"/>'), "the quoted inline tag must retain its bounded MDX projection");
        const direct = await renderBlocks(dump.blocks.filter((block) => block.type === "paragraph"), undefined, registry, "registry");
        try {
          await waitForDom(direct.container, () => Boolean(direct.container.querySelector('.markdown-mdx-inline[data-mdx-status="pending"]')), "direct registry rendering must preserve pending inline ownership");
          assert.strictEqual(direct.container.querySelector("p p"), null, "direct default/custom registry rendering must not nest paragraph groups");
          if (custom) assert.ok(direct.container.querySelector("[data-custom-paragraph]"), "direct registry projection must retain the registered wrapper");
        } finally {
          direct.unmount();
        }
      } else if (fixture === "mdx-tag-no-swallow-negative.mdx") {
        assert.ok(container.textContent?.includes("<DangerChip/>{expr"), "registered inline JSX before an incomplete expression must retain its bounded tag projection and literal expression tail");
      }
      if (["nested-formatting-ancestors.md", "nested-math-inline.md", "nested-blockquote-list-crossover.md", "mdx-expression-no-swallow-negative.mdx"].includes(fixture)) {
        const quote = container.querySelector("blockquote");
        assert.ok(quote, `${fixture}: native quote must remain present`);
        assert.deepStrictEqual(Array.from(quote.children, (child) => child.tagName), ["P", "UL"], `${fixture}: prose and list must remain separate ordered quote children`);
        const items = Array.from(quote.querySelectorAll(":scope > ul > li"));
        const prefixes = fixture === "nested-formatting-ancestors.md"
          ? ["Quoted list item with nested strong text", "Quoted list item with nested italic text"]
          : fixture === "nested-math-inline.md"
            ? ["Quoted nested item with inline math:"]
            : fixture === "nested-blockquote-list-crossover.md"
              ? ["Nested list in quote with cite {cite:12", "Another nested item with inline math $x + y"]
              : ["Quoted list item with {quotedNestedExpr and quoted sibling prose that must remain visible."];
        assert.strictEqual(items.length, prefixes.length, `${fixture}: quoted list item count must match the native cold tree`);
        prefixes.forEach((prefix, index) => assert.ok(items[index]?.textContent?.startsWith(prefix), `${fixture}: quoted list item ${index} must retain its authored text and order`));
        assert.ok(!quote.firstElementChild?.textContent?.includes(prefixes[0]), `${fixture}: list text must not fuse into the preceding paragraph`);
        if (fixture === "nested-blockquote-list-crossover.md") {
          const parentItem = quote.parentElement?.closest("li");
          assert.ok(parentItem, "crossover quote must stay inside the original root list item");
          const structural = parentItem.querySelector(":scope > .markdown-list-item-children");
          assert.deepStrictEqual(Array.from(structural?.children ?? [], (child) => child.tagName), ["BLOCKQUOTE", "UL"], "returning nested list must follow the quote as an independent sibling");
          assert.ok(structural?.lastElementChild?.textContent?.startsWith("Return to sibling list item"), "the returning sibling list must retain its authored text");
        }
      }
      assert.strictEqual(container.querySelector('[data-mdx-status="compiled"]'), null, "inline expressions and tags must not gain module evaluation");
      if (custom) {
        assert.ok(container.querySelector("[data-custom-paragraph]"), "mixed projections must retain the registered paragraph wrapper");
        if (dump.blocks.flatMap((block) => nestedBlocks(block)).some((block) => block.type === "blockquote")) {
          assert.ok(container.querySelector("[data-custom-quote]"), "prepared projections must retain the registered quote wrapper");
        }
        assert.strictEqual(container.querySelector("p p"), null, "projected paragraph groups must not nest default paragraphs inside custom wrappers");
      }
    } finally {
      unmount();
    }
  }
}

async function testMixedHtmlRegistryPolicies(): Promise<void> {
  const source = 'prefix <a href="/original">rewrite-me</a> <a href="/deny">deny-me</a> <em>unwrap-me</em> <code>drop-me</code> <InlineChip /> suffix\n\n> quoted <a href="/original">quoted-rewrite</a> <InlineChip /> trailing quote\n\n- listed <a href="/original">listed-rewrite</a> <InlineChip /> trailing item';
  const harness = await createWorkerHarness();
  const init = initMessage(source);
  assert.strictEqual(init.type, "INIT");
  if (init.type !== "INIT") throw new Error("policy fixture requires INIT");
  init.docPlugins = { ...DOC_PLUGINS, mdxComponentNames: ["InlineChip"] };
  const blocks = await finalBlocks(harness, init);
  for (const custom of [false, true]) {
    for (const projection of ["native", "registry"] as const) {
      for (const unwrap of [false, true]) {
        const registry = new ComponentRegistry();
        registry.setUrlTransform((url) => url === "/deny" ? null : url === "/original" ? "/rewritten" : url);
        registry.setElementFilters({ disallowedElements: ["code"], allowElement: (element) => element.tagName !== "em", unwrapDisallowed: unwrap });
        if (custom) {
          registry.setBlockComponents({
            paragraph: ({ children }: { inlines: InlineNode[]; children?: React.ReactNode }) =>
              React.createElement("p", { "data-policy-paragraph": true }, children),
          });
        }
        const selected = projection === "registry" ? blocks.filter((block) => block.type === "paragraph") : blocks;
        // Exercise serialized native HTML ownership, not only in-process object references.
        const rendered = await renderBlocks(JSON.parse(JSON.stringify(selected)) as Block[], undefined, registry, projection);
        try {
          await waitForDom(rendered.container, () => Boolean(rendered.container.querySelector(".markdown-mdx-inline")), "mixed HTML policy fixture must keep pending JSX");
          assert.ok(rendered.container.querySelector('a[href="/rewritten"]'), "configured URL rewrites must apply inside mixed HTML");
          const denied = Array.from(rendered.container.querySelectorAll("a")).find((node) => node.textContent === "deny-me");
          assert.ok(denied, "denied URL must retain its text owner");
          assert.strictEqual(denied.getAttribute("href"), null, "configured URL denial must remove the URL");
          assert.strictEqual(rendered.container.querySelector("em, code"), null, "descendant element policies must apply inside mixed HTML");
          assert.strictEqual(rendered.container.textContent?.includes("unwrap-me"), unwrap, "allowElement denial must honor drop versus unwrap");
          assert.strictEqual(rendered.container.textContent?.includes("drop-me"), unwrap, "disallowedElements must honor drop versus unwrap");
          assert.ok(rendered.container.textContent?.includes("prefix") && rendered.container.textContent?.includes("suffix"), "policy application must retain surrounding prose");
          assert.strictEqual(rendered.container.querySelector("p p"), null, "policy projection must not introduce nested paragraphs");
          if (custom) assert.ok(rendered.container.querySelector("[data-policy-paragraph]"), "policy application must preserve custom paragraph ownership");
          if (projection === "native") {
            assert.strictEqual(rendered.container.querySelector("blockquote a")?.getAttribute("href"), "/rewritten", "prepared quoted HTML must retain URL context after serialization");
            assert.ok(rendered.container.querySelector("blockquote .markdown-mdx-inline"), "prepared quoted JSX must retain its projection");
          }
        } finally {
          rendered.unmount();
        }
      }
      if (custom) {
        const registry = new ComponentRegistry();
        registry.setElementFilters({
          allowElement: (element, context) => element.tagName !== "a" || context.parentTagName !== "p",
          unwrapDisallowed: true,
        });
        registry.setBlockComponents({
          paragraph: ({ children }: { inlines: InlineNode[]; children?: React.ReactNode }) =>
            React.createElement("p", { "data-context-paragraph": true }, children),
        });
        const selected = projection === "registry" ? blocks.filter((block) => block.type === "paragraph") : blocks;
        const rendered = await renderBlocks(selected, undefined, registry, projection);
        try {
          await waitForDom(rendered.container, () => Boolean(rendered.container.querySelector(".markdown-mdx-inline")), "context policy fixture must retain pending JSX");
          assert.strictEqual(rendered.container.querySelector("p a"), null, "mixed HTML roots must retain the owning paragraph context for allowElement");
          if (projection === "native") assert.ok(rendered.container.querySelector("li a"), "paragraph-only denial must not leak into tight list HTML context");
          assert.ok(rendered.container.textContent?.includes("rewrite-me"), "context-based unwrap must retain the denied anchor text");
          assert.ok(rendered.container.querySelector("[data-context-paragraph]"), "context policy must retain the registered wrapper");
        } finally {
          rendered.unmount();
        }
      }
      if (custom && projection === "native") {
        const registry = new ComponentRegistry();
        registry.setElementFilters({
          allowElement: (element, context) => element.tagName !== "a" || context.parentTagName !== "li",
          unwrapDisallowed: true,
        });
        registry.setBlockComponents({
          paragraph: ({ children }: { inlines: InlineNode[]; children?: React.ReactNode }) =>
            React.createElement("p", { "data-list-context-paragraph": true }, children),
        });
        const rendered = await renderBlocks(blocks, undefined, registry);
        try {
          await waitForDom(rendered.container, () => Boolean(rendered.container.querySelector("li .markdown-mdx-inline")), "tight list context fixture must retain pending JSX");
          assert.strictEqual(rendered.container.querySelector("li a"), null, "tight list HTML roots must retain li context for allowElement");
          assert.ok(rendered.container.querySelector("li")?.textContent?.includes("listed-rewrite"), "list-context unwrap must retain the denied anchor text");
          assert.ok(rendered.container.querySelector('p a[href="/original"]'), "list-only denial must not leak into paragraph HTML context");
        } finally {
          rendered.unmount();
        }
      }
    }
  }
}

async function testMixedHtmlLiteralPolicies(): Promise<void> {
  const source = "prefix <span>**bold**</span> <code>**literal**</code> <InlineChip /> suffix";
  for (const literalTagContent of [undefined, [], ["span"]]) {
    const harness = await createWorkerHarness();
    const init = initMessage(source);
    assert.strictEqual(init.type, "INIT");
    if (init.type !== "INIT") throw new Error("literal policy fixture requires INIT");
    init.docPlugins = { ...DOC_PLUGINS, mdxComponentNames: ["InlineChip"] };
    if (literalTagContent !== undefined) init.html = { literalTagContent };
    const blocks = await finalBlocks(harness, init);
    for (const custom of [false, true]) {
      for (const projection of ["native", "registry"] as const) {
        const registry = new ComponentRegistry();
        if (custom) {
          registry.setBlockComponents({
            paragraph: ({ children }: { inlines: InlineNode[]; children?: React.ReactNode }) =>
              React.createElement("p", { "data-literal-paragraph": true }, children),
          });
        }
        const rendered = await renderBlocks(blocks, undefined, registry, projection);
        try {
          await waitForDom(rendered.container, () => Boolean(rendered.container.querySelector(".markdown-mdx-inline")), "literal policy fixture must retain pending JSX");
          if (literalTagContent?.includes("span")) {
            assert.strictEqual(rendered.container.querySelector("strong"), null, "configured literal HTML tags must not parse nested Markdown");
            assert.ok(rendered.container.textContent?.includes("**bold**"), "configured literal tag content must remain literal");
          } else {
            assert.strictEqual(rendered.container.querySelector("span > strong")?.textContent, "bold", "mixed inline HTML must preserve Markdown parsing with omitted/default-empty HTML configuration");
          }
          assert.strictEqual(rendered.container.querySelector("code")?.textContent, "**literal**", "code content must remain literal under every configured policy");
          assert.strictEqual(rendered.container.querySelector("code strong"), null, "empty literalTagContent must not change intrinsic code ownership");
          if (custom) assert.ok(rendered.container.querySelector("[data-literal-paragraph]"), "literal policies must retain the registered paragraph wrapper");
        } finally {
          rendered.unmount();
        }
      }
    }
  }
}

async function testPreparedCustomQuoteStates(): Promise<void> {
  for (const source of ["> streamed quote", ">"]) {
    const harness = await createWorkerHarness();
    const init = initMessage(source);
    const blocks = source === ">" ? await finalBlocks(harness, init) : findMessage(await harness.send(init), "INITIALIZED")?.blocks;
    assert.ok(blocks, "quote states require actual worker output");
    const quote = blocks.find((block) => block.type === "blockquote");
    assert.ok(quote, "native quote must own the input");
    assert.strictEqual(quote.isFinalized, source === ">", "the nonempty quote must be exercised before FINALIZE");
    const registry = new ComponentRegistry();
    registry.setElementFilters({ disallowedElements: ["em"] });
    registry.setBlockComponents({
      blockquote: ({ renderedContent }: { inlines: InlineNode[]; renderedContent?: React.ReactNode }) =>
        React.createElement("blockquote", { "data-custom-state-quote": true }, renderedContent),
    });
    const rendered = await renderBlocks(blocks, undefined, registry);
    try {
      await waitForDom(rendered.container, () => Boolean(rendered.container.querySelector("[data-custom-state-quote]")), "streaming and empty prepared quotes must invoke the registered wrapper");
      assert.strictEqual(rendered.container.querySelector("[data-custom-state-quote]")?.textContent, source === ">" ? "" : "streamed quote", "the registered quote must receive the native child projection in every state");
    } finally {
      rendered.unmount();
    }
  }
}

async function testStandaloneComponentsFixtureOwnership(): Promise<void> {
  const source = await readFile(new URL("../../../tests/regression/fixtures/mdx-components.mdx", import.meta.url), "utf8");
  const harness = await createWorkerHarness();
  const blocks = await finalBlocks(harness, initMessage(""), Array.from(source));
  for (const name of ["YouTube", "Image"]) {
    const owner = blocks.find((block) => block.payload.raw.startsWith(`<${name} `));
    assert.ok(owner, `${name} must retain its own standalone root`);
    assert.strictEqual(owner.type, "mdx", `${name} must compile as block MDX`);
    assert.strictEqual(owner.payload.meta?.mdxStatus, "compiled", `${name} must compile at FINALIZE`);
    assert.ok(owner.payload.compiledMdxModule?.code.includes(`_jsx(${name}`), `${name} must have an evaluable component module`);
    assert.strictEqual(owner.payload.meta?.mixedSegments, undefined, `${name} must not route through the pending prose projection`);
  }
}

try {
  await testMultilineComponentOwnership();
  await testCharacterStreamingMatchesStatic();
  await testIncompleteComponentStaysPending();
  await testSiblingsAndNestingRetained();
  await testNestedContainerOwnership();
  await testMdxDisabledAndRawHtmlUnchanged();
  await testUnfinishedHtmlFixtureOwnership();
  await testMdxDomRender();
  await testNestedRegionDomRender();
  await testQuotedComponentWithFencedCode();
  await testUnclosedNestedComponentsErrorAtFinalize();
  await testCapitalizedComponentNames();
  await testQuotedTextareaCommonMark();
  await testRegressionFixtureParagraphOwnership();
  await testStandaloneComponentsFixtureOwnership();
  await testMixedHtmlRegistryPolicies();
  await testMixedHtmlLiteralPolicies();
  await testPreparedCustomQuoteStates();
  console.log("mdx component region ownership test passed");
} finally {
  restoreDom();
}
