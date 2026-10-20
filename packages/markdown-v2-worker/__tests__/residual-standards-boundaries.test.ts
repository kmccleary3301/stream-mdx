import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { micromark } from "micromark";
import { JSDOM } from "jsdom";
import type { WorkerOut } from "@stream-mdx/core";
import { ComponentRegistry, MarkdownBlocksRenderer, createRendererStore, type RendererStore } from "@stream-mdx/react/server";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import { createWorkerThread } from "@stream-mdx/worker/node";
import { normalizeHtmlSemantics } from "../../../tests/conformance/normalizer.mts";

const { window } = new JSDOM("");
Object.assign(globalThis, { window, document: window.document, DOMParser: window.DOMParser, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement });
// React DOM reads the bare global navigator once a window exists (Node 20 has no global navigator).
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: window.navigator });
const init = {
  docPlugins: { html: true, tables: true, footnotes: true, math: true, callouts: true, mdx: false },
  mdx: { compileMode: "server" as const },
  prewarmLangs: [],
};
const code = "<pre><code>chunk1\n  \n  chunk2\n</code></pre>";
const cases = [
  ...[
    { name: "quoted Type6 HTML blank lines expose native fenced code", markdown: "- outer\n\n  > <div>\n  >\n  > ```js\n  > const x=1;\n  > ```\n  >\n  > </div>" },
    { name: "root quote Type6 retains HTML continuation marks", markdown: "> <div>\n> literal\n>\n> ```js\n> const x=1;\n> ```\n>\n> </div>\n" },
    { name: "nested quotes Type6 contextual whitespace", markdown: ">> <div>\n>> \t\n>> ```js\n>> const x=1;\n>> ```\n>>\n>> </div>\n" },
    { name: "quoted Type7 HTML blank lines expose native fenced code", markdown: "> <span>\n>\n> ```js\n> const x=1;\n> ```\n>\n> </span>\n" },
    { name: "quoted Type1 pre remains literal through blank lines", markdown: "> <pre>\n>\n> ```js\n> const x=1;\n> ```\n>\n> </pre>\n" },
    { name: "quoted Type6 exits before a sibling list item", markdown: "- outer\n\n  > <div>\n  > literal\n- sibling\n" },
    { name: "list-only Type6 keeps native code boundary", markdown: "- outer\n\n  <div>\n  \n  ```js\n  const x=1;\n  ```\n  \n  </div>\n" },
    { name: "root Type6 keeps native code boundary", markdown: "<div>\n\n```js\nconst x=1;\n```\n\n</div>\n" },
  ].map((fixture) => ({ ...fixture, html: micromark(fixture.markdown, { allowDangerousHtml: true }) })),
  { name: "cm112 internal blank spaces", markdown: "    chunk1\n      \n      chunk2\n", html: code },
  { name: "quoted internal blank spaces", markdown: ">     chunk1\n>       \n>       chunk2\n", html: `<blockquote>${code}</blockquote>` },
  { name: "listed internal blank spaces", markdown: "- a\n\n      chunk1\n        \n        chunk2\n", html: `<ul><li><p>a</p>${code}</li></ul>` },
  { name: "blank tabs beyond four columns", markdown: "\tchunk1\n\t\t\n\tchunk2\n", html: "<pre><code>chunk1\n\t\nchunk2\n</code></pre>" },
  { name: "blank lines with insufficient indentation", markdown: "    chunk1\n  \n      \n      chunk2\n", html: "<pre><code>chunk1\n\n  \n  chunk2\n</code></pre>" },
  { name: "cm317 invisible definition loosens list", markdown: "- a\n- b\n\n  [ref]: /url\n- d\n", html: "<ul><li><p>a</p></li><li><p>b</p></li><li><p>d</p></li></ul>" },
  { name: "quoted invisible definition loosens list", markdown: "> - a\n> - b\n>\n>   [ref]: /url\n> - d\n", html: "<blockquote><ul><li><p>a</p></li><li><p>b</p></li><li><p>d</p></li></ul></blockquote>" },
  { name: "adjacent invisible definition stays tight", markdown: "- a\n- [ref]: /url\n  b\n- d\n", html: "<ul><li>a</li><li>b</li><li>d</li></ul>" },
  { name: "gfm628 FTP punctuation", markdown: "Anonymous FTP is available at ftp://foo.bar.baz.\n", html: '<p>Anonymous FTP is available at <a href="ftp://foo.bar.baz">ftp://foo.bar.baz</a>.</p>' },
  { name: "FTP balanced parentheses and trailing punctuation", markdown: "(ftp://foo.bar/a(b))!?\n", html: '<p>(<a href="ftp://foo.bar/a(b)">ftp://foo.bar/a(b)</a>)!?</p>' },
  { name: "FTP trailing entity", markdown: "ftp://foo.bar/a&copy;\n", html: '<p><a href="ftp://foo.bar/a">ftp://foo.bar/a</a>©</p>' },
  { name: "FTP native heading and list contexts", markdown: "# ftp://foo.bar\n\n- ftp://foo.bar/a.\n", html: '<h1><a href="ftp://foo.bar">ftp://foo.bar</a></h1><ul><li><a href="ftp://foo.bar/a">ftp://foo.bar/a</a>.</li></ul>' },
  { name: "FTP code and word boundaries", markdown: "`ftp://foo.bar` xftp://foo.bar ftp://foo.under_score ftp://localhost\n", html: '<p><code>ftp://foo.bar</code> xftp://foo.bar ftp://foo.under_score ftp://localhost</p>' },
  { name: "existing explicit FTP Markdown policy", markdown: "[ftp](ftp://foo.bar) <ftp://foo.bar>\n", html: '<p><a href="ftp://foo.bar">ftp</a> <a href="ftp://foo.bar">ftp://foo.bar</a></p>' },
];

function renderStore(store: RendererStore): string {
  return normalizeHtmlSemantics(renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: [], store, componentRegistry: new ComponentRegistry() })));
}

const worker = createWorkerThread();
try {
  for (const fixture of cases) {
    const expected = normalizeHtmlSemantics(fixture.html);
    const compiled = await compileMarkdownSnapshotDirect({ text: fixture.markdown, init });
    assert.equal(renderStore(createRendererStore(compiled.blocks)), expected, `${fixture.name}: compile/client`);
    const ssr = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: compiled.blocks, componentRegistry: new ComponentRegistry() }));
    assert.equal(normalizeHtmlSemantics(ssr), expected, `${fixture.name}: SSR`);
    for (const chunkSize of [1, 7, 64]) {
      const store = createRendererStore();
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          worker.off("message", onMessage);
          worker.off("error", onError);
          if (error) reject(error);
          else resolve();
        };
        const onError = (error: Error) => finish(error);
        const onMessage = (message: WorkerOut) => {
          if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
          else if (message.type === "PATCH") store.applyPatches(message.patches);
          else if (message.type === "ERROR") finish(new Error(message.error.message));
          else if (message.type === "FINALIZED") finish();
        };
        worker.on("message", onMessage);
        worker.on("error", onError);
        worker.postMessage({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "", ...init });
        for (let index = 0; index < fixture.markdown.length; index += chunkSize) {
          worker.postMessage({ type: "APPEND", text: fixture.markdown.slice(index, index + chunkSize) });
        }
        worker.postMessage({ type: "FINALIZE" });
      });
      assert.equal(renderStore(store), expected, `${fixture.name}: hosted FINALIZED chunks=${chunkSize}`);
    }
  }
} finally {
  await worker.terminate();
  window.close();
}
console.log(`Residual standards boundaries passed: ${cases.length} fixtures, compile/client + SSR + hosted FINALIZED chunks 1/7/64`);
