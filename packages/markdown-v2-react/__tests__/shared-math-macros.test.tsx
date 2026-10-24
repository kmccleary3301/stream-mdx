import assert from "node:assert/strict";
import React from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { StreamingMarkdown, type StreamingMarkdownHandle, type StreamingMarkdownProps } from "../src/streaming-markdown";

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
const { window } = dom;
for (const [name, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
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
const root = createRoot(container);
const handle = React.createRef<StreamingMarkdownHandle>();

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `${message}\n${container.innerHTML}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function findMathExpression(tex: string): HTMLElement | undefined {
  const expressions = container.querySelectorAll<HTMLElement>("[data-tex]");
  for (const expression of expressions) {
    if (expression.getAttribute("data-tex") === tex) return expression;
  }
  return undefined;
}

async function renderTextDocument(
  text: string,
  mathOptions: StreamingMarkdownProps["mathOptions"],
  ready: () => boolean,
  message: string,
): Promise<void> {
  const props: StreamingMarkdownProps = {
    text,
    features: { math: true },
    mathOptions,
    caret: false,
  };
  root.render(React.createElement(StreamingMarkdown, { ref: handle, engine: "main", ...props }));
  await waitFor(ready, message);
  await handle.current?.waitForIdle();
}

const renderedText = (tex: string): string | undefined =>
  findMathExpression(tex)?.querySelector(".katex-html")?.textContent?.trim();
const renderedError = (tex: string): boolean => Boolean(findMathExpression(tex)?.querySelector(".katex-error"));

try {
  const text = "$\\gdef\\v{x}$\n\n$\\v$";
  await renderTextDocument(text, undefined, () => renderedError("\\v"), "default math expressions remain isolated");

  await renderTextDocument(
    text,
    { macroScope: "document" },
    () => renderedText("\\v") === "x",
    "the explicit document scope shares macros in document order",
  );

  await renderTextDocument("$\\v$", { macroScope: "document" }, () => renderedError("\\v"), "replacing source starts a fresh macro scope");
  const unsafeLink = "$\\href{javascript:alert(1)}{unsafe}$";
  await renderTextDocument(
    unsafeLink,
    { macroScope: "document" },
    () => Boolean(findMathExpression("\\href{javascript:alert(1)}{unsafe}")?.querySelector(".katex, .katex-error")),
    "the untrusted link expression should be prepared",
  );
  assert.equal(container.querySelector('a[href^="javascript:"]'), null, "KaTeX trust remains disabled");

  const stream = (async function* () {
    yield "$\\gdef\\w{y}$\n\n";
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    yield "$\\w$";
  })();
  root.render(
    <StreamingMarkdown
      ref={handle}
      engine="main"
      stream={stream}
      features={{ math: true }}
      mathOptions={{ macroScope: "document" }}
      caret={false}
    />,
  );
  await waitFor(
    () => findMathExpression("\\w")?.querySelector(".katex-html")?.textContent?.trim() === "y",
    "a later streamed expression should see the earlier chunk's macro",
  );
  await handle.current?.waitForIdle();

  const provisionalStream = (async function* () {
    yield "$\\gdef\\u{x";
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    yield "\n\n$\\u$";
  })();
  root.render(
    <StreamingMarkdown
      ref={handle}
      engine="main"
      stream={provisionalStream}
      features={{ math: true, formatAnticipation: { mathInline: true } }}
      mathOptions={{ macroScope: "document" }}
      caret={false}
    />,
  );
  await waitFor(
    () => Boolean(findMathExpression("\\u")?.querySelector(".katex-error")),
    "an incomplete earlier definition must not commit a shared macro",
  );
  await handle.current?.waitForIdle();
} finally {
  root.unmount();
  dom.window.close();
}

console.log("document-scoped KaTeX macros test passed");
