import assert from "node:assert";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import {
  ComponentRegistry,
  type CodeFenceRendererProps,
} from "../src/components";
import { MarkdownBlocksRenderer } from "../src/renderer/blocks-renderer";
import { createRendererStore } from "../src/renderer/store";
import { BlockNodeRenderer } from "../src/renderer/node-views";

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(10);
  }
}

async function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.HTMLElement = window.HTMLElement;
  g.HTMLIFrameElement = window.HTMLIFrameElement;
  g.Node = window.Node;
  g.MessageEvent = window.MessageEvent;
  g.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  g.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return window;
}

// 1. disallowedElements ['img'] removes images in Client and SSR
async function testDisallowedElementsRemovesImages(): Promise<void> {
  const markdown = "Here is an image: ![alt text](https://example.com/pic.png) and text.";
  const { blocks } = await compileMarkdownSnapshotDirect({
    text: markdown,
    init: { docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true } },
  });

  // SSR test
  const ssrHtml = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      disallowedElements: ["img"],
    }),
  );
  assert.ok(!ssrHtml.includes("<img"), `Expected no <img in SSR output: ${ssrHtml}`);
  assert.ok(ssrHtml.includes("Here is an image:"), `Expected text preserved in SSR output: ${ssrHtml}`);

  // Client test
  const window = await setupDom();
  const rootEl = window.document.getElementById("root")!;
  const store = createRendererStore(blocks);
  const registry = new ComponentRegistry({}, {}, { disallowedElements: ["img"] });

  const root = createRoot(rootEl);
  await act(async () => {
    root.render(
      React.createElement(
        "div",
        null,
        blocks.map((b) =>
          React.createElement(BlockNodeRenderer, {
            key: b.id,
            store,
            blockId: b.id,
            registry,
          }),
        ),
      ),
    );
  });
  await waitFor(
    () => rootEl.innerHTML.includes("Here is an image:") && !rootEl.innerHTML.includes("<img"),
    `Client render expected no <img>: ${rootEl.innerHTML}`,
  );
  act(() => {
    root.unmount();
  });
}

// 2. allowedElements with unwrapDisallowed keeps text of removed em
async function testAllowedElementsWithUnwrapDisallowed(): Promise<void> {
  const markdown = "This is *italic* and **bold** text.";
  const { blocks } = await compileMarkdownSnapshotDirect({
    text: markdown,
    init: { docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true } },
  });

  // With unwrapDisallowed: true, em and strong tags are unwrapped so their text remains
  const ssrUnwrapped = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      allowedElements: ["p"],
      unwrapDisallowed: true,
    }),
  );
  assert.ok(!ssrUnwrapped.includes("<em"), `Expected no <em> in unwrapped SSR: ${ssrUnwrapped}`);
  assert.ok(!ssrUnwrapped.includes("<strong"), `Expected no <strong> in unwrapped SSR: ${ssrUnwrapped}`);
  assert.ok(ssrUnwrapped.includes("italic"), `Expected 'italic' text preserved in unwrapped SSR: ${ssrUnwrapped}`);
  assert.ok(ssrUnwrapped.includes("bold"), `Expected 'bold' text preserved in unwrapped SSR: ${ssrUnwrapped}`);

  // Without unwrapDisallowed (default false), disallowed element subtrees are dropped
  const ssrDropped = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      allowedElements: ["p"],
      unwrapDisallowed: false,
    }),
  );
  assert.ok(!ssrDropped.includes("<em"), `Expected no <em> in dropped SSR: ${ssrDropped}`);
  assert.ok(!ssrDropped.includes("italic"), `Expected 'italic' text dropped in dropped SSR: ${ssrDropped}`);
  assert.ok(!ssrDropped.includes("bold"), `Expected 'bold' text dropped in dropped SSR: ${ssrDropped}`);
  assert.ok(ssrDropped.includes("This is"), `Expected 'This is' preserved in dropped SSR: ${ssrDropped}`);

  // Client verification
  const window = await setupDom();
  const rootEl = window.document.getElementById("root")!;
  const store = createRendererStore(blocks);
  const registry = new ComponentRegistry({}, {}, { allowedElements: ["p"], unwrapDisallowed: true });

  const root = createRoot(rootEl);
  await act(async () => {
    root.render(
      React.createElement(
        "div",
        null,
        blocks.map((b) =>
          React.createElement(BlockNodeRenderer, {
            key: b.id,
            store,
            blockId: b.id,
            registry,
          }),
        ),
      ),
    );
  });
  await waitFor(
    () =>
      rootEl.innerHTML.includes("italic") &&
      rootEl.innerHTML.includes("bold") &&
      !rootEl.innerHTML.includes("<em") &&
      !rootEl.innerHTML.includes("<strong"),
    `Client unwrapped render failed: ${rootEl.innerHTML}`,
  );
  act(() => {
    root.unmount();
  });
}

// 3. allowElement callback sees raw HTML iframe with source html
async function testAllowElementCallbackSeesRawHtml(): Promise<void> {
  const markdown = [
    "# Heading",
    "",
    '<iframe src="https://example.com/embed" title="embed"></iframe>',
    "",
    "A paragraph with <span>inline html</span> and [link](https://example.com).",
  ].join("\n");

  const { blocks } = await compileMarkdownSnapshotDirect({
    text: markdown,
    init: {
      html: { allowRaw: true, allowedTags: { iframe: ["src", "title"], span: [] } },
      docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
    },
  });
  const seenCalls: Array<{ tagName: string; properties: Record<string, unknown>; source: string }> = [];

  const allowElement = (
    element: { tagName: string; properties: Record<string, unknown>; blockType?: string },
    context: { source: "markdown" | "html"; parentTagName?: string },
  ): boolean => {
    seenCalls.push({
      tagName: element.tagName,
      properties: element.properties,
      source: context.source,
    });
    // Disallow iframe
    if (element.tagName === "iframe") {
      return false;
    }
    return true;
  };

  const ssrHtml = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      allowElement,
    }),
  );

  // Assert iframe was seen with source: "html"
  const iframeCall = seenCalls.find((c) => c.tagName === "iframe");
  assert.ok(iframeCall, "Expected allowElement to be called for iframe");
  assert.strictEqual(iframeCall?.source, "html", "Expected iframe source to be 'html'");
  assert.ok(!ssrHtml.includes("<iframe"), `Expected iframe to be rejected: ${ssrHtml}`);

  // Assert markdown elements were seen with source: "markdown"
  const h1Call = seenCalls.find((c) => c.tagName === "h1");
  assert.ok(h1Call, "Expected allowElement to be called for h1");
  assert.strictEqual(h1Call?.source, "markdown", "Expected h1 source to be 'markdown'");
}

// 4. codeRenderers language aliases: alias array resolves JS -> renderer case-insensitively
async function testCodeRenderersAliases(): Promise<void> {
  const markdown = [
    "```JS",
    "console.log('hello');",
    "```",
    "",
    "```py",
    "print('hello')",
    "```",
  ].join("\n");

  const { blocks } = await compileMarkdownSnapshotDirect({
    text: markdown,
    init: { docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true } },
  });

  let jsRendered = false;
  const CustomJsRenderer: React.FC<CodeFenceRendererProps> = ({ code }) => {
    jsRendered = true;
    return React.createElement("div", { id: "custom-js-alias" }, code);
  };

  const jsRenderer = { component: CustomJsRenderer, aliases: ["JS", "mjs"] };
  const registry = new ComponentRegistry({}, { javascript: jsRenderer });

  for (const lang of ["JS", "js", "MJS", "JavaScript"]) {
    assert.strictEqual(registry.getCodeRenderer(lang.toLowerCase()), jsRenderer, `Expected '${lang}' to resolve to the javascript renderer`);
  }
  assert.strictEqual(registry.getCodeRenderer("py"), undefined, "Unaliased languages keep the default renderer");

  // SSR test
  const ssrHtml = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      componentRegistry: registry,
    }),
  );
  assert.ok(ssrHtml.includes('id="custom-js-alias"'), `Expected custom JS renderer in SSR: ${ssrHtml}`);
  assert.ok(jsRendered, "Expected CustomJsRenderer to be called");
}

// 5. disableAutolinkProtocols ['mailto']: leaves foo@bar.com as text while explicit [x](mailto:..) remains
async function testDisableAutolinkProtocolsMailto(): Promise<void> {
  const markdown = [
    "Autolink bare: foo@bar.com",
    "",
    "Autolink angle: <mailto:test@example.com>",
    "",
    "Explicit link: [Email Us](mailto:explicit@example.com)",
    "",
    "Web autolink: https://example.com",
  ].join("\n");

  const { blocks } = await compileMarkdownSnapshotDirect({
    text: markdown,
    init: { docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true } },
  });

  // SSR with disableAutolinkProtocols: ["mailto"]
  const ssrHtml = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      disableAutolinkProtocols: ["mailto"],
    }),
  );

  // foo@bar.com and test@example.com should NOT be in an <a href="mailto:foo@bar.com">
  assert.ok(!ssrHtml.includes('href="mailto:foo@bar.com"'), `Expected foo@bar.com not to be linked: ${ssrHtml}`);
  assert.ok(!ssrHtml.includes('href="mailto:test@example.com"'), `Expected angle autolink not to be linked: ${ssrHtml}`);
  assert.ok(ssrHtml.includes("foo@bar.com"), `Expected foo@bar.com plain text preserved: ${ssrHtml}`);
  assert.ok(ssrHtml.includes("test@example.com"), `Expected test@example.com plain text preserved: ${ssrHtml}`);

  // Explicit link [Email Us](mailto:explicit@example.com) MUST remain linked
  assert.ok(
    ssrHtml.includes('href="mailto:explicit@example.com"'),
    `Expected explicit [Email Us] link to remain: ${ssrHtml}`,
  );
  assert.ok(ssrHtml.includes("Email Us"), `Expected link text 'Email Us': ${ssrHtml}`);

  // Web autolink https://example.com should still be linked
  assert.ok(
    ssrHtml.includes('href="https://example.com"'),
    `Expected https://example.com web link to remain: ${ssrHtml}`,
  );

  // Trailing colon case insensitivity test: ["MAILTO:"]
  const ssrColon = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      disableAutolinkProtocols: ["MAILTO:"],
    }),
  );
  assert.ok(!ssrColon.includes('href="mailto:foo@bar.com"'), `Expected MAILTO: to disable mailto autolinks: ${ssrColon}`);
  assert.ok(
    ssrColon.includes('href="mailto:explicit@example.com"'),
    `Expected explicit link preserved with MAILTO:: ${ssrColon}`,
  );
}

// 6. allowedElements and disallowedElements are mutually exclusive, but swapping between them across renders works
async function testMutuallyExclusiveElements(): Promise<void> {
  assert.throws(
    () => new ComponentRegistry({}, {}, { allowedElements: ["p"], disallowedElements: ["img"] }),
    /Cannot specify both allowedElements and disallowedElements/,
  );

  const { blocks } = await compileMarkdownSnapshotDirect({
    text: "Text with *em* and ![alt](https://example.com/a.png)\n\n- item *nested*",
    init: { docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true } },
  });
  const window = await setupDom();
  const rootEl = window.document.getElementById("root")!;
  const registry = new ComponentRegistry();
  const root = createRoot(rootEl);
  await act(async () => {
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks, componentRegistry: registry, allowedElements: ["p", "img", "ul", "li"] }));
  });
  assert.ok(rootEl.innerHTML.includes("<img") && !rootEl.innerHTML.includes("<em"), `allow list applied: ${rootEl.innerHTML}`);
  await act(async () => {
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks, componentRegistry: registry, disallowedElements: ["img"] }));
  });
  const emCount = rootEl.querySelectorAll("em").length;
  assert.ok(!rootEl.innerHTML.includes("<img") && emCount === 2, `swap to deny list re-renders paragraphs and list items: ${rootEl.innerHTML}`);
  await act(async () => {
    root.render(React.createElement(MarkdownBlocksRenderer, { blocks, componentRegistry: registry }));
  });
  assert.ok(rootEl.innerHTML.includes("<img") && rootEl.innerHTML.includes("<em"), `removing filter props restores output: ${rootEl.innerHTML}`);
  act(() => {
    root.unmount();
  });
}

async function testHtmlOwnedParagraphFilters(): Promise<void> {
  const { blocks } = await compileMarkdownSnapshotDirect({
    text: "Before <span>inside</span> after",
    init: { prewarmLangs: [], docPlugins: { html: true, mdx: false } },
  });
  assert.ok(
    blocks.some((block) => block.payload.meta?.htmlParagraphTree?.some((node) => node.kind === "element" && node.paragraphRoot)),
    "fixture must exercise an HTML-owned paragraph root",
  );
  const window = await setupDom();
  for (const filters of [
    { allowedElements: ["span"], unwrapDisallowed: false },
    { disallowedElements: ["p"], unwrapDisallowed: false },
    { disallowedElements: ["p"], unwrapDisallowed: true },
  ]) {
    const registry = new ComponentRegistry({}, {}, filters);
    const element = React.createElement(MarkdownBlocksRenderer, { blocks, componentRegistry: registry });
    const ssrDocument = new JSDOM(renderToStaticMarkup(element)).window.document;
    assert.strictEqual(ssrDocument.querySelector("p"), null, "HTML-owned paragraph must obey tag filtering in SSR");
    // normalizeHtmlParagraph serializes `</p>\n`; that separator text node is a sibling of the paragraph root, not subtree content.
    assert.strictEqual(ssrDocument.body.textContent?.trim(), filters.unwrapDisallowed ? "Before inside after" : "", "paragraph filtering must unwrap or drop the entire subtree");
    const rootEl = window.document.getElementById("root")!;
    const root = createRoot(rootEl);
    await act(async () => { root.render(element); });
    assert.strictEqual(rootEl.querySelector("p"), null, "HTML-owned paragraph must obey tag filtering on the client");
    assert.strictEqual(rootEl.textContent?.trim(), filters.unwrapDisallowed ? "Before inside after" : "", "client paragraph filtering must unwrap or drop the entire subtree");
    await act(async () => { root.unmount(); });
  }
  const seenParagraphs: Array<{ source: string; blockType?: string }> = [];
  const callbackRegistry = new ComponentRegistry({}, {}, {
    unwrapDisallowed: true,
    allowElement: (element, context) => {
      if (element.tagName !== "p") return true;
      seenParagraphs.push({ source: context.source, blockType: element.blockType });
      return false;
    },
  });
  const callbackDocument = new JSDOM(renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, { blocks, componentRegistry: callbackRegistry }),
  )).window.document;
  assert.strictEqual(callbackDocument.querySelector("p"), null, "allowElement must be able to reject the normalized paragraph");
  assert.strictEqual(callbackDocument.body.textContent?.trim(), "Before inside after");
  assert.deepStrictEqual(seenParagraphs, [{ source: "markdown", blockType: "paragraph" }], "normalized paragraph must use the Markdown p filter exactly once");
}

async function runAllTests(): Promise<void> {
  console.log("Running element filtering and code alias tests...");
  await testDisallowedElementsRemovesImages();
  await testAllowedElementsWithUnwrapDisallowed();
  await testAllowElementCallbackSeesRawHtml();
  await testCodeRenderersAliases();
  await testDisableAutolinkProtocolsMailto();
  await testMutuallyExclusiveElements();
  await testHtmlOwnedParagraphFilters();
  console.log("All element filtering and code alias tests passed successfully!");
}

await runAllTests();
