import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { Block, InlineNode } from "@stream-mdx/core";
import {
  ComponentRegistry,
  MarkdownBlocksRenderer,
  defaultInlineComponents,
  renderInlineNodes,
} from "../src";
import { renderHtmlInlineNode } from "../src/utils/inline-html";

// 1. SSR path tests with MarkdownBlocksRenderer and ComponentRegistry
function createBlockWithInline(id: string, inline: InlineNode[]): Block {
  return {
    id,
    type: "paragraph",
    isFinalized: true,
    payload: {
      raw: "test",
      inline,
    },
  };
}

// Test A: Dangerous links blocked in SSR (attribute omitted)
const dangerousLinkBlock = createBlockWithInline("b1", [
  { kind: "link", href: "javascript:alert(1)", children: [{ kind: "text", text: "js-link" }] },
  { kind: "link", href: "vbscript:msgbox(1)", children: [{ kind: "text", text: "vbs-link" }] },
  { kind: "link", href: "data:text/html,<script>alert(1)</script>", children: [{ kind: "text", text: "data-link" }] },
  { kind: "link", href: "file:///etc/passwd", children: [{ kind: "text", text: "file-link" }] },
  { kind: "link", href: "made-up-scheme:payload", children: [{ kind: "text", text: "custom-link" }] },
  { kind: "link", href: "https://example.com/safe", children: [{ kind: "text", text: "safe-link" }] },
]);

const ssrMarkup = renderToStaticMarkup(
  React.createElement(MarkdownBlocksRenderer, {
    blocks: [dangerousLinkBlock],
    componentRegistry: new ComponentRegistry(),
  }),
);

assert.ok(!ssrMarkup.includes('href="javascript:'), "javascript: href must be omitted in SSR");
assert.ok(!ssrMarkup.includes('href="vbscript:'), "vbscript: href must be omitted in SSR");
assert.ok(!ssrMarkup.includes('href="data:'), "data:text/html href must be omitted in SSR");
assert.ok(!ssrMarkup.includes('href="file:'), "file: href must be omitted in SSR");
assert.ok(ssrMarkup.includes('href="made-up-scheme:payload"'), "arbitrary custom scheme must survive");
assert.ok(ssrMarkup.includes('href="https://example.com/safe"'), "https link must survive");

// Test B: Dangerous image src blocked, safe data:image/png allowed in SSR
const imageBlock = createBlockWithInline("b2", [
  { kind: "image", src: "javascript:alert(1)", alt: "bad-js-img" },
  { kind: "image", src: "data:text/html,<script>alert(1)</script>", alt: "bad-data-img" },
  { kind: "image", src: "data:image/png;base64,iVBORw0KGgo=", alt: "safe-png-img" },
  { kind: "image", src: "https://example.com/pic.png", alt: "safe-http-img" },
]);

const ssrImageMarkup = renderToStaticMarkup(
  React.createElement(MarkdownBlocksRenderer, {
    blocks: [imageBlock],
    componentRegistry: new ComponentRegistry(),
  }),
);

assert.ok(!ssrImageMarkup.includes('src="javascript:'), "javascript: image src must be omitted in SSR");
assert.ok(!ssrImageMarkup.includes('src="data:text/html'), "data:text/html image src must be omitted in SSR");
assert.ok(ssrImageMarkup.includes('src="data:image/png;base64,iVBORw0KGgo="'), "data:image/png src must be allowed in SSR");
assert.ok(ssrImageMarkup.includes('src="https://example.com/pic.png"'), "https image src must be allowed in SSR");

// Test C: Custom urlTransform rewrites or drops
const customRegistry = new ComponentRegistry();
customRegistry.setUrlTransform((url, attribute) => {
  if (url.startsWith("https://")) {
    return url.replace("https://", "safe://");
  }
  return null;
});

const customSsrMarkup = renderToStaticMarkup(
  React.createElement(MarkdownBlocksRenderer, {
    blocks: [dangerousLinkBlock],
    componentRegistry: customRegistry,
  }),
);

assert.ok(customSsrMarkup.includes('href="safe://example.com/safe"'), "custom urlTransform rewrote https to safe://");
assert.ok(!customSsrMarkup.includes("made-up-scheme"), "custom urlTransform dropped made-up-scheme returning null");

// 2. Raw HTML attribute policy in React
// A: onclick, on* stripped; srcdoc stripped; unsafe style props dropped while color survives
const rawHtmlElement = renderHtmlInlineNode(
  {
    kind: "html",
    tagName: "a",
    attributes: {
      href: "javascript:alert(1)",
      onclick: "bad()",
      onClick: "bad()",
      style: "position: absolute; color: red; background-image: url('javascript:bad')",
    },
    raw: '<a href="javascript:alert(1)" onclick="bad()" style="...">',
    sanitized: "<a>",
  },
  "click me",
);

const rawHtmlMarkup = renderToStaticMarkup(rawHtmlElement);
assert.ok(!rawHtmlMarkup.includes("javascript:"), "raw HTML javascript: href stripped");
assert.ok(!rawHtmlMarkup.includes("onclick"), "raw HTML onclick stripped");
assert.ok(!rawHtmlMarkup.includes("position"), "raw HTML style position stripped");
assert.ok(!rawHtmlMarkup.includes("url("), "raw HTML style url() stripped");
assert.ok(rawHtmlMarkup.includes("color:red") || rawHtmlMarkup.includes("color: red"), "raw HTML style color: red survives");

// B: action, formaction, xlink:href sanitized in raw HTML
const rawFormElement = renderHtmlInlineNode(
  {
    kind: "html",
    tagName: "form",
    attributes: {
      action: "javascript:alert(1)",
      formaction: "javascript:alert(2)",
      "xlink:href": "javascript:alert(3)",
      srcdoc: "alert(4)",
    },
    raw: "<form>",
    sanitized: "<form>",
  },
  null,
);

const rawFormMarkup = renderToStaticMarkup(rawFormElement);
assert.ok(!rawFormMarkup.includes("javascript:"), "raw HTML form action/formaction/xlink:href stripped");
assert.ok(!rawFormMarkup.includes("srcdoc"), "raw HTML srcdoc stripped");

// 3. Client rendering & navigation safety
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "https://host.test/app",
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;

// Client renderInlineNodes
const clientRender = renderInlineNodes(
  [
    { kind: "link", href: "javascript:alert(1)", children: [{ kind: "text", text: "client-bad" }] },
    { kind: "image", src: "data:image/png;base64,iVBORw==", alt: "client-img" },
  ],
  defaultInlineComponents,
);

const clientMarkup = renderToStaticMarkup(React.createElement(React.Fragment, null, clientRender));
assert.ok(!clientMarkup.includes('href="javascript:'), "client link has no javascript: href");
assert.ok(clientMarkup.includes('src="data:image/png;base64,iVBORw=="'), "client image has safe data: src");

console.log("React security URL, attribute, and style policy tests passed successfully.");
