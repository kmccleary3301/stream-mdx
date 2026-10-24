import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { compileSyntaxRuleToExtension, type InlineNode, type SyntaxRuleSpec } from "@stream-mdx/core";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ComponentRegistry } from "../src/components";
import { StreamingMarkdown, type StreamingMarkdownHandle, type StreamingMarkdownProps } from "../src/streaming-markdown";
import type { NodePresentations } from "../src/types";

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    DOMParser: window.DOMParser,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = window.document.getElementById("root");
  assert.ok(container);
  return { dom, container };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for consumer render");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function renderHtml(props: StreamingMarkdownProps, check: (container: HTMLElement) => void) {
  const { dom, container } = setupDom();
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  try {
    root.render(<StreamingMarkdown ref={handle} engine="main-thread" {...props} />);
    await waitUntil(() => Boolean(handle.current?.getState().workerReady && container.querySelector("span")));
    await handle.current?.waitForIdle();
    check(container);
    const registry = new ComponentRegistry({ components: props.components, contentComponents: props.contentComponents });
    registry.setLiteralTagContent(props.html?.literalTagContent);
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: undefined });
    try {
      const serverHtml = renderToStaticMarkup(<>{handle.current?.getState().blocks.map((block) => registry.renderBlock(block))}</>);
      const serverContainer = dom.window.document.createElement("div");
      serverContainer.innerHTML = serverHtml;
      check(serverContainer);
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: dom.window });
    }
  } finally {
    root.unmount();
    dom.window.close();
  }
}

async function testBlockHtmlLiteralOptIn() {
  const text = "<div><span>**bold**</span></div>";
  await renderHtml({ text }, (container) => {
    assert.equal(container.querySelector("span")?.textContent, "**bold**");
    assert.equal(container.querySelector("strong"), null, "native CommonMark HTML blocks stay raw by default");
  });
  await renderHtml({ text, html: { allowedTags: { span: [] } } }, (container) => {
    assert.equal(container.querySelector("span")?.textContent, "**bold**", "allowedTags alone does not opt into markdown");
    assert.equal(container.querySelector("strong"), null);
  });
  await renderHtml({ text, html: { literalTagContent: [] } }, (container) => {
    assert.equal(container.querySelector("span strong")?.textContent, "bold", "an explicit empty literal list opts HTML text into markdown");
  });
  await renderHtml({ text, html: { literalTagContent: ["SPAN"] } }, (container) => {
    assert.equal(container.querySelector("span")?.textContent, "**bold**");
    assert.equal(container.querySelector("strong"), null, "configured literal tags are case insensitive");
  });
  await renderHtml({
    text: "<div><span>**bold**</span><code>**code**</code><pre><span>**pre**</span></pre></div>",
    html: { literalTagContent: [] },
  }, (container) => {
    assert.equal(container.querySelector("span strong")?.textContent, "bold");
    assert.equal(container.querySelector("code")?.textContent, "**code**");
    assert.equal(container.querySelector("pre span")?.textContent, "**pre**");
    assert.equal(container.querySelector("pre strong, code strong"), null, "native raw tags override the opt-in");
  });
}

const ticket: SyntaxRuleSpec = {
  name: "ticket",
  pattern: { source: "#([A-Z]+-\\d+)" },
  attrs: { id: 1 },
};
const consumerComponents = {
  "inline:strong": { view: ({ children }: { children?: React.ReactNode }) => <b className="mapped-bold">{children}</b> },
  "extension:ticket": { view: ({ node }: { node: InlineNode }) => node.kind === "plugin" ? <mark className="mapped-ticket">{String(node.attrs?.id ?? "")}</mark> : null },
} satisfies NodePresentations;

async function testOwnedHtmlParser() {
  await renderHtml({
    text: "<div><span>**#ABC-1** $x$</span></div>",
    syntax: [ticket],
    html: { literalTagContent: [] },
    components: consumerComponents,
    features: { math: false },
  }, (container) => {
    assert.equal(container.querySelector(".mapped-bold .mapped-ticket")?.textContent, "ABC-1");
    assert.equal(container.querySelector("span")?.textContent, "ABC-1 $x$", "owned parser honors disabled math");
  });
  const nativeWorker = createInlineEngineWorker({ extensions: { inline: [compileSyntaxRuleToExtension(ticket)] } });
  // Worker mode checks browser availability before calling the supplied factory.
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: NodeWorker });
  try {
    await renderHtml({
      text: "<div><span>**#ABC-2**</span></div>",
      engine: "worker",
      worker: () => nativeWorker,
      components: consumerComponents,
      html: { literalTagContent: [] },
    }, (container) => {
      assert.equal(container.querySelector(".mapped-bold .mapped-ticket")?.textContent, "ABC-2", "native engine extensions survive HTML mapping");
    });
  } finally {
    nativeWorker.terminate();
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else delete globalThis.Worker;
  }
  await renderHtml({ text: "<div><span>**#ABC-3**</span></div>", html: { literalTagContent: [] } }, (container) => {
    assert.equal(container.querySelector("strong")?.textContent, "#ABC-3");
    assert.equal(container.querySelector(".mapped-ticket"), null, "parser and components do not leak between consumers");
  });
}

/**
 * File-local deferred (Node 20 has no `Promise.withResolvers`) with the same resolve/reject
 * surface, so the stream gate settles exactly as before.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function testPartialCloser(open: string, close: string, pattern: string) {
  const { dom, container } = setupDom();
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  const nextChunk = deferred<void>();
  async function* stream() {
    yield `prefix ${open}value${close.slice(0, -1)}`;
    await nextChunk.promise;
    yield `${close.slice(-1)} end`;
  }
  try {
    root.render(<StreamingMarkdown
      ref={handle}
      engine="main-thread"
      stream={stream()}
      syntax={[{ name: "delimited", pattern: { source: pattern }, attrs: { value: 1 }, anticipation: { open, close } }]}
      components={{
        "extension:delimited": {
          view: ({ node }) => node.kind === "plugin" ? <mark className="delimited">{String(node.attrs?.value ?? "")}</mark> : null,
        },
      }}
    />);
    await waitUntil(() => Boolean(container.querySelector(".delimited")));
    await handle.current?.waitForIdle();
    assert.equal(container.querySelector(".delimited")?.textContent, "value");
    assert.equal(container.textContent, "prefix value", `partial ${close} closer must not leak a raw trailing marker`);
    nextChunk.resolve();
    await waitUntil(() => container.textContent?.includes(" end") ?? false);
    await handle.current?.waitForIdle();
    assert.equal(container.textContent, "prefix value end", "final output must be exact");
    assert.equal(container.querySelectorAll(".delimited").length, 1);
  } finally {
    nextChunk.resolve();
    root.unmount();
    dom.window.close();
  }
}

const failures: Error[] = [];
for (const [name, test] of [
  ["HTML block literal opt-in", testBlockHtmlLiteralOptIn],
  ["owned HTML parser", testOwnedHtmlParser],
  ["identical closer overlap", () => testPartialCloser("::", "::", "::([^:]+)::")],
  ["different closer overlap", () => testPartialCloser("[[", "]]", "\\[\\[([^\\]]+)\\]\\]")],
] as const) {
  try {
    await test();
    console.log(`plugin contract passed: ${name}`);
  } catch (error) {
    assert.ok(error instanceof Error);
    console.error(`plugin contract failed: ${name}`, error.message);
    failures.push(error);
  }
}
assert.equal(failures.length, 0, "consumer plugin contract regressions failed");
