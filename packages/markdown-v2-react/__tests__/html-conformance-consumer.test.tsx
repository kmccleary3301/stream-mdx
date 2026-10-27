import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, hydrateRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { Block, CodeNodeHandle, HtmlOptions, SyntaxRuleSpec, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { useCodeBlock } from "../src/renderer/code-handle-hooks";
import { ComponentRegistry, MarkdownBlocksRenderer, createRendererStore } from "../src/server";
import { normalizeHtmlSemantics } from "../../../tests/conformance/normalizer.mts";
import type { HtmlNodeViewProps, InlineNodeViewProps } from "../src/types";
import type { RendererStore } from "../src/renderer/store";

const globalDescriptors = new Map(["window", "document", "DOMParser", "Node", "Element", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
const window = new JSDOM("").window;
Object.assign(globalThis, { window, document: window.document, DOMParser: window.DOMParser, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement });
const init = { prewarmLangs: [], docPlugins: { html: true, mdx: false, tables: true, math: false } };

function render(blocks: Block[], registry = new ComponentRegistry(), store?: RendererStore): string {
  return renderToStaticMarkup(<MarkdownBlocksRenderer blocks={blocks} componentRegistry={registry} store={store} />);
}

/**
 * File-local deferred (Node 20 has no `Promise.withResolvers`) with the same resolve/reject
 * surface, so the worker messages settle this compile promise exactly as before.
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

async function streamed(text: string, config: Pick<Extract<WorkerIn, { type: "INIT" }>, "html" | "syntax" | "docPlugins"> = {}): Promise<RendererStore> {
  const worker = createInlineEngineWorker();
  const store = createRendererStore();
  const { promise, resolve, reject } = deferred<RendererStore>();
  worker.onmessage = (event: MessageEvent<WorkerOut>) => {
    const message = event.data;
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches);
    else if (message.type === "FINALIZED") {
      worker.terminate();
      resolve(store);
    } else if (message.type === "ERROR") {
      worker.terminate();
      reject(new Error(message.error.message));
    }
  };
  worker.postMessage({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "", ...init, ...config });
  for (const char of text) worker.postMessage({ type: "APPEND", text: char });
  worker.postMessage({ type: "FINALIZE" });
  return promise;
}
async function staticAndStreamDocuments(text: string, html: HtmlOptions): Promise<readonly [Document, Document]> {
  const workerConfig = { ...init, html };
  const compiled = await compileMarkdownSnapshotDirect({ text, init: workerConfig });
  const store = await streamed(text, { html });
  const staticMarkup = render(compiled.blocks);
  const streamingMarkup = render([], undefined, store);
  assert.equal(normalizeHtmlSemantics(streamingMarkup), normalizeHtmlSemantics(staticMarkup));
  return [
    new JSDOM(staticMarkup).window.document,
    new JSDOM(streamingMarkup).window.document,
  ];
}

const examples = JSON.parse(await fs.readFile(new URL("../../../tests/conformance/fixtures/commonmark-spec-0.31.2.json", import.meta.url), "utf8")) as Array<{ number: number; markdown: string; html: string }>;
const assigned = [148, 155, 167, 168, 171, 172, 173, 176, 177, 180, 187, 190, 191, 201, 475, 476, 477, 491, 494, 524, 536, 613, 614, 615, 616, 621, 623, 625, 626, 627, 628, 629, 630, 631, 642, 643];
const failures: string[] = [];
const passing: number[] = [];
for (const number of assigned) {
  const example = examples.find((value) => value.number === number)!;
  const text = example.markdown.replace(/→/g, "\t");
  const expected = normalizeHtmlSemantics(example.html.replace(/→/g, "\t"));
  const compiled = await compileMarkdownSnapshotDirect({ text, init }).catch((error: unknown) => {
    throw new Error(`cm_${number} static compilation failed for ${JSON.stringify(text)}`, { cause: error });
  });
  const staticHtml = normalizeHtmlSemantics(render(compiled.blocks));
  const store = await streamed(text).catch((error: unknown) => {
    throw new Error(`cm_${number} streaming failed for ${JSON.stringify(text)}`, { cause: error });
  });
  const streamingHtml = normalizeHtmlSemantics(render([], undefined, store));
  if (staticHtml !== expected || streamingHtml !== expected) {
    failures.push(`cm_${number}: expected ${expected}\nstatic ${staticHtml}\nstreaming ${streamingHtml}`);
  } else passing.push(number);
}
console.log(`HTML consumer observed passing IDs: ${passing.map((number) => `cm_${number}`).join(", ")}`);
assert.deepEqual(failures, [], failures.join("\n"));

// Actual parsed markdown leaves must survive an HTML owner, rather than becoming raw HTML text.
const syntax = {
  contractVersion: 1 as const,
  inline: [{ name: "ticket", pattern: { source: "#([A-Z]+-\\d+)" }, attrs: { id: 1 } }] as readonly SyntaxRuleSpec[],
};
const html: HtmlOptions = { allowedTags: { del: [], span: ["data-safe"], kbd: [] }, literalTagContent: ["kbd"] };
const text = '<del>\n\n**#ABC-123** and <span data-safe="yes" onclick="alert(1)">*nested*</span> <kbd>**literal**</kbd>\n\n</del>\n';
const store = await streamed(text, { html, syntax });
const registry = new ComponentRegistry({
  components: {
    "extension:ticket": {
      view: ({ node }) => node.kind === "plugin" ? <mark data-ticket={String(node.attrs?.id ?? "")}>{String(node.attrs?.id ?? "")}</mark> : null,
    },
    "html:del": {
      view: ({ properties, children }) => React.createElement("del", { ...properties, "data-mapped": "yes" } as React.HTMLAttributes<HTMLElement>, children),
    },
  },
});
const document = new JSDOM(render([], registry, store)).window.document;
assert.equal(document.querySelector('del[data-mapped="yes"] p strong mark')?.textContent, "ABC-123");
assert.equal(document.querySelector('del p span[data-safe="yes"] em')?.textContent, "nested");
assert.equal(document.querySelector("[onclick]"), null);
assert.equal(document.querySelector("kbd")?.textContent, "**literal**");
assert.equal(document.querySelector("kbd strong"), null);

const unsafe = await streamed('<script>\nunsafe-script\n\nunsafe-tail\n</script>\n<style>unsafe-style</style>\n\nsafe\n');
const safeDocument = new JSDOM(render([], undefined, unsafe)).window.document;
assert.equal(safeDocument.querySelector("script,style"), null);
assert.equal(safeDocument.body.textContent?.includes("unsafe"), false);
assert.ok(safeDocument.body.textContent?.includes("safe"));

const voidStore = await streamed('before <wbr>tail <input disabled checked aria-hidden="false"> end', {
  html: { allowedTags: { wbr: [], input: ["disabled", "checked", "aria-hidden"] } },
});
const voidDocument = new JSDOM(render([], undefined, voidStore)).window.document;
assert.ok(voidDocument.querySelector("wbr"));
assert.ok(voidDocument.body.textContent?.includes("tail"));
const input = voidDocument.querySelector("input");
assert.ok(input);
assert.equal(input.disabled, true);
assert.equal(input.checked, true);
assert.equal(input.getAttribute("aria-hidden"), "false");

const textareaStore = await streamed("prefix <textarea>hello</textarea>");
assert.equal(new JSDOM(render([], undefined, textareaStore)).window.document.querySelector("textarea")?.value, "hello");
const forged = await streamed('**native** <span smdxinline="0" smdxinlinex="0">forged</span>', {
  html: { allowedTags: { span: ["smdxinline", "smdxinlinex"] } },
});
const forgedDocument = new JSDOM(render([], undefined, forged)).window.document;
assert.equal(forgedDocument.querySelector("span")?.textContent, "forged");
assert.equal(forgedDocument.querySelectorAll("strong").length, 1);

const paragraphStore = await streamed("A <span>B</span>");
const paragraphRegistry = new ComponentRegistry();
paragraphRegistry.setNodePresentations({
  paragraph: { wrapper: ({ children }) => <div data-paragraph="configured">{children}</div> },
});
const paragraphDocument = new JSDOM(render([], paragraphRegistry, paragraphStore)).window.document;
assert.equal(paragraphDocument.querySelector('div[data-paragraph="configured"]')?.textContent?.trim(), "A B");
assert.equal(paragraphDocument.querySelector('div[data-paragraph="configured"] p')?.textContent?.trim(), "A B");
assert.equal(paragraphDocument.querySelectorAll("p").length, 1, "normalized paragraph must use its configured component exactly once");

const captureStore = await streamed('start [[<a href="/outer">[inner](/inner) trailing]] end', {
  syntax: {
    contractVersion: 1,
    inline: [{ name: "capture", pattern: { source: "\\[\\[([\\s\\S]*?)\\]\\]" }, content: 1 }],
  },
});
const captureRegistry = new ComponentRegistry({
  components: {
    "extension:capture": {
      view: ({ children }) => <mark data-capture="configured">{children}</mark>,
    },
  },
});
const captureDocument = new JSDOM(render([], captureRegistry, captureStore)).window.document;
assert.ok(captureDocument.querySelector('mark[data-capture="configured"]'));
assert.equal(captureDocument.querySelector('mark a[href="/inner"]')?.textContent, "inner");
assert.equal(captureDocument.querySelector("mark")?.textContent, "inner trailing");

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
const captureMounted = window.document.createElement("div");
const captureRoot = createRoot(captureMounted);
await act(async () => {
  captureRoot.render(<MarkdownBlocksRenderer blocks={captureStore.getBlocks()} store={captureStore} componentRegistry={captureRegistry} />);
});
assert.equal(captureMounted.querySelector("mark a a"), null, "captured plugins must mount the reconstructed children, not invalid original anchors");
assert.equal(captureMounted.querySelector("mark")?.textContent, "inner trailing");
await act(async () => { captureRoot.unmount(); });
for (const [source, expected] of [
  ["> <pre>\n>     literal\n> </pre>\n", "    literal\n"],
  ["> <pre>\n>\n>     literal\n> </pre>\n", "\n    literal\n"],
] as const) {
  const compiled = await compileMarkdownSnapshotDirect({ text: source, init });
  const element = <MarkdownBlocksRenderer blocks={compiled.blocks} />;
  const server = renderToStaticMarkup(element);
  assert.equal(new JSDOM(server).window.document.querySelector("pre")?.textContent, expected);
  const mounted = window.document.createElement("div");
  const root = createRoot(mounted);
  await act(async () => { root.render(element); });
  assert.equal(mounted.querySelector("pre")?.textContent, expected);
  await act(async () => { root.unmount(); });
  const hydrated = window.document.createElement("div");
  hydrated.innerHTML = server;
  const errors: unknown[] = [];
  let hydrationRoot!: ReturnType<typeof hydrateRoot>;
  await act(async () => {
    hydrationRoot = hydrateRoot(hydrated, element, { onRecoverableError: (error) => errors.push(error) });
  });
  assert.equal(hydrated.querySelector("pre")?.textContent, expected);
  assert.deepEqual(errors, [], "literal HTML hydration must not replace mismatched server text");
  await act(async () => { hydrationRoot.unmount(); });
}

const legacyHtmlBlock: Block = {
  id: "legacy-html",
  type: "html",
  isFinalized: true,
  payload: {
    raw: "<div>",
    meta: {
      htmlTree: [{
        kind: "element",
        tagName: "div",
        attributes: {},
        children: [{
          kind: "block",
          block: {
            id: "legacy-html-code",
            type: "code",
            isFinalized: true,
            payload: { raw: "const coldSnapshot = true;", meta: { code: "const coldSnapshot = true;", lang: "js" } },
          },
        }],
      }],
    },
  },
};
const legacyHtmlMarkup = renderToStaticMarkup(<MarkdownBlocksRenderer blocks={[legacyHtmlBlock]} />);
assert.equal(
  new JSDOM(legacyHtmlMarkup).window.document.querySelector("pre")?.textContent,
  "const coldSnapshot = true;",
  "a static HTML tree must render its actual embedded Block slot",
);

// The authored HTML fixture contains braces owned by native code, not MDX.
const inlineHtmlFixture = await fs.readFile(new URL("../../../tests/regression/fixtures/inline-html.md", import.meta.url), "utf8");
const codeParagraph = "Inline code with language hint: `{:js}{:js}`.";
const expectedParagraph = "Inline code with language hint: {:js}{:js}.";
const codeSource = [
  inlineHtmlFixture.trimEnd(),
  "",
  `> ${codeParagraph}`,
  "",
  `- ${codeParagraph}`,
  "",
  "- parent",
  "",
  `  ${codeParagraph}`,
  "",
  `  - ${codeParagraph}`,
  "",
  "Double ticks: `` {:js} `literal` {:js} ``.",
  "",
  "| Code |",
  "| --- |",
  "| `{:js}{:js}` |",
  "",
].join("\n");
const codeInit = { ...init, contentPolicy: "trusted-mdx" as const, docPlugins: { ...init.docPlugins, mdx: true } };
const codeCompiled = await compileMarkdownSnapshotDirect({ text: codeSource, init: codeInit });
const codeSerialized = JSON.parse(JSON.stringify(codeCompiled.blocks)) as Block[];
const codeStore = await streamed(codeSource, codeInit);
const customCodeRegistry = new ComponentRegistry();
customCodeRegistry.setNodePresentations({
  paragraph: { wrapper: ({ children }) => <div data-paragraph="configured">{children}</div> },
  "inline:code": {
    view: ({ node }) => node.kind === "code" ? <code className="inline-code" data-code="configured">{node.text}</code> : null,
  },
});
for (const registry of [new ComponentRegistry(), customCodeRegistry]) {
  for (const element of [
    <MarkdownBlocksRenderer blocks={codeCompiled.blocks} componentRegistry={registry} />,
    <MarkdownBlocksRenderer blocks={codeSerialized} componentRegistry={registry} />,
    <MarkdownBlocksRenderer blocks={codeCompiled.blocks} store={codeStore} componentRegistry={registry} />,
  ]) {
    const assertCodeOwnership = (root: ParentNode) => {
      const codes = Array.from(root.querySelectorAll("code"));
      assert.deepEqual(codes.map((code) => code.textContent), [
        "{:js}{:js}", "{:js}{:js}", "{:js}{:js}", "{:js}{:js}", "{:js}{:js}",
        "{:js} `literal` {:js}", "{:js}{:js}",
      ], "root, nested paragraphs/list items, double ticks and table cells must retain native inline-code ownership");
      assert.equal(codes[0].closest("p")?.textContent, expectedParagraph, "the fixture's whole paragraph prose must survive");
      assert.equal(codes[1].closest("blockquote p")?.textContent, expectedParagraph);
      assert.equal(codes[2].closest("li")?.textContent, expectedParagraph);
      assert.equal(codes[3].closest("p")?.textContent, expectedParagraph);
      assert.ok(codes[4].closest("li li"));
      assert.equal(codes[6].closest("td")?.textContent, "{:js}{:js}");
      if (registry === customCodeRegistry) {
        assert.equal(root.querySelectorAll('code[data-code="configured"]').length, codes.length);
        assert.ok(codes[0].closest('div[data-paragraph="configured"]'));
      }
    };
    assertCodeOwnership(new JSDOM(renderToStaticMarkup(element)).window.document);
    const mounted = window.document.createElement("div");
    const root = createRoot(mounted);
    try {
      await act(async () => { root.render(element); });
      assertCodeOwnership(mounted);
    } finally {
      await act(async () => { root.unmount(); });
    }
  }
}
const outsideCodeSource = "Code `{:js}{:js}` with <em>HTML</em> and {outside} <InlineChip /> [link](/safe) tail.";
const outsideCodeCompiled = await compileMarkdownSnapshotDirect({ text: outsideCodeSource, init: codeInit });
const outsideCodeStore = await streamed(outsideCodeSource, codeInit);
for (const registry of [new ComponentRegistry(), customCodeRegistry]) {
  for (const markup of [
    render(JSON.parse(JSON.stringify(outsideCodeCompiled.blocks)) as Block[], registry),
    render([], registry, outsideCodeStore),
  ]) {
    const document = new JSDOM(markup).window.document;
    assert.equal(document.querySelector("code")?.textContent, "{:js}{:js}");
    assert.equal(document.querySelector("em")?.textContent, "HTML");
    assert.equal(document.querySelector('a[href="/safe"]')?.textContent, "link");
    assert.equal(document.querySelector("p")?.textContent, "Code {:js}{:js} with HTML and {outside} <InlineChip /> link tail.");
  }
}
const unmatchedAnchorHtml: HtmlOptions = {
  unmatchedAnchors: "literal-bare",
  allowedTags: { details: [], summary: [] },
};
for (const token of ["<A>", "<a>", "<a >", "<a/>", "<A/>", "<a />"]) {
  const source = `- **"From ${token}"** appears in the header.\n\n- **Tests:** cover inheritance.\n\nThe deferred move continues on B.\n\nSee <a href="https://example.com">the link</a>.`;
  for (const document of await staticAndStreamDocuments(source, unmatchedAnchorHtml)) {
    assert.equal(document.querySelector("strong")?.textContent, `"From ${token}"`);
    assert.deepEqual([...document.querySelectorAll("a")].map((link) => link.textContent), ["the link"]);
    assert.equal(document.querySelectorAll("li").length, 2);
    assert.ok([...document.querySelectorAll("p")].some((paragraph) => paragraph.textContent === "The deferred move continues on B."));
  }
}
for (const closing of ["</a>  ", "<div>more</div>\n</a>"]) {
  const source = `See <a>label\n\n${closing}\n\nfinish`;
  for (const document of await staticAndStreamDocuments(source, unmatchedAnchorHtml)) {
    assert.equal(document.querySelector("p")?.textContent, "See <a>label");
    assert.equal(document.querySelectorAll("a").length, 0);
  }
}
for (const document of await staticAndStreamDocuments(
  "See <a>label<script><!-- </script> --></a>",
  unmatchedAnchorHtml,
)) {
  assert.equal(document.querySelector("p")?.textContent, "See label -->");
}
for (const html of ["<!-- </a> -->", '<div title="</a>">more</div>', '<script>"</a>"</script>']) {
  for (const document of await staticAndStreamDocuments(`Before <A>.\n\n${html}\n\nAfter.`, unmatchedAnchorHtml)) {
    assert.equal(document.querySelector("p")?.textContent, "Before <A>.");
    assert.equal(document.querySelectorAll("a").length, 0);
  }
}
const pairedAnchorSource = 'Bare <a>label</a>, <a id="section"></a>, `<A>`, and [docs](https://example.com).\n\n<details><summary>More</summary>Details</details>';
for (const document of await staticAndStreamDocuments(pairedAnchorSource, unmatchedAnchorHtml)) {
  assert.deepEqual([...document.querySelectorAll("a")].map((link) => link.textContent), ["label", "", "docs"]);
  assert.equal(document.querySelector("code")?.textContent, "<A>");
  assert.ok(document.querySelector("details")?.textContent?.includes("More"));
}

const literalHtml: HtmlOptions = { mode: "literal" };
for (const { source, raw } of [
  {
    source: "before <custom-widget value='2'>**not bold**</custom-widget> after **bold**",
    raw: "<custom-widget value='2'>**not bold**</custom-widget>",
  },
  {
    source: "before <script>alert('x')</script> after **markdown**",
    raw: "<script>alert('x')</script>",
  },
  { source: 'before <x-widget data-test="unfinished', raw: '<x-widget data-test="unfinished' },
  { source: "<svg><circle /></svg>\n\n**outside svg**", raw: "<svg><circle /></svg>" },
]) {
  for (const document of await staticAndStreamDocuments(source, literalHtml)) {
    assert.ok(document.body.textContent?.includes(raw), raw);
    assert.equal(document.querySelector("script,svg,custom-widget"), null);
  }
}
for (const document of await staticAndStreamDocuments(
  "**before** <span>**literal**</span> and **after**.\n\n<div>**block literal**</div>\n\n**outside**",
  literalHtml,
)) {
  assert.deepEqual([...document.querySelectorAll("strong")].map((node) => node.textContent), ["before", "after", "outside"]);
  assert.ok(document.body.textContent?.includes("<span>**literal**</span>"));
  assert.ok(document.body.textContent?.includes("<div>**block literal**</div>"));
}

const htmlProtocolPolicy: HtmlOptions = {
  sanitization: {
    tagNames: ["p", "a", "img"],
    attributes: { "*": ["title"], a: ["href"], img: ["src", "alt", "title"] },
    protocols: {
      href: ["file", "t3-citation", "t3-context", "t3-thread", "https"],
      src: ["file", "t3-context"],
    },
    stripAttributes: ["title"],
  },
};
const protocolSource = '[file](file:///tmp/file) [citation](t3-citation://v1/item) [mail](mailto:user@example.com) ![context](t3-context://v1/image) <a href="t3-thread://v1/1">thread</a> <a href="javascript:bad()">unsafe</a> <img src="file:///tmp/raw.png" title="raw image">';
const protocolCompiled = await compileMarkdownSnapshotDirect({ text: protocolSource, init: { ...init, html: htmlProtocolPolicy } });
const protocolStore = await streamed(protocolSource, { html: htmlProtocolPolicy });
const protocolRegistry = new ComponentRegistry({ html: htmlProtocolPolicy });
for (const markup of [
  render(protocolCompiled.blocks, protocolRegistry),
  render([], protocolRegistry, protocolStore),
]) {
  const document = new JSDOM(markup).window.document;
  assert.ok(document.querySelector('a[href="file:///tmp/file"]'));
  assert.ok(document.querySelector('a[href="t3-citation://v1/item"]'));
  assert.ok(document.querySelector('a[href="t3-thread://v1/1"]'));
  assert.ok([...document.querySelectorAll("a")].some((link) => link.textContent === "mail" && !link.hasAttribute("href")));
  assert.ok(document.querySelector('img[src="t3-context://v1/image"]'));
  assert.ok(document.querySelector('img[src="file:///tmp/raw.png"][data-markdown-title="raw image"]'));
  assert.equal(document.querySelector('a[href^="javascript:"]'), null);
}

function MarkdownImageView({ node, context }: InlineNodeViewProps): React.ReactElement | null {
  if (node.kind !== "image") return null;
  return <img data-image-presentation="markdown" data-standalone={String(context?.isStandalone)} data-src={node.src} alt={node.alt ?? ""} />;
}

function HtmlImageView({ properties, context }: HtmlNodeViewProps): React.ReactElement {
  return (
    <img
      data-image-presentation="html"
      data-standalone={String(context?.isStandalone)}
      data-src={typeof properties.src === "string" ? properties.src : ""}
      data-width={typeof properties.width === "string" ? properties.width : ""}
      data-height={typeof properties.height === "string" ? properties.height : ""}
      data-id={typeof properties.id === "string" ? properties.id : ""}
      data-align={typeof properties.align === "string" ? properties.align : ""}
      data-title={typeof properties["data-markdown-title"] === "string" ? properties["data-markdown-title"] : ""}
    />
  );
}

const standaloneHtml: HtmlOptions = {
  sanitization: {
    tagNames: ["div", "figure", "a", "strong", "em", "img"],
    attributes: { "*": [], a: ["href"], img: ["src", "alt", "title", "width", "height", "id", "align"] },
    protocols: { href: ["http", "https"], src: ["http", "https"] },
    stripAttributes: ["title"],
  },
};
const standaloneSource = [
  "![paragraph](/paragraph)",
  "",
  "**![strong](/strong)**",
  "",
  "*![emphasis](/emphasis)*",
  "",
  "[![link](/link)](/target)",
  "",
  "- ![list](/list)",
  "",
  "> ![quote](/quote)",
  "",
  "| ![header](/header) |",
  "| --- |",
  "| ![cell](/cell) |",
  "",
  '<div><img src="/html-div" width="31" height="17" id="photo" align="center" title="div title"></div>',
  "",
  '<figure><a href="/wrapper"><strong><em><img src="/html-figure" width="41" height="27" title="figure title"></em></strong></a></figure>',
  "",
  "![sibling](/sibling) text",
].join("\n");
const standaloneCompiled = await compileMarkdownSnapshotDirect({ text: standaloneSource, init: { ...init, html: standaloneHtml } });
const standaloneStore = await streamed(standaloneSource, { html: standaloneHtml });
const standaloneRegistry = new ComponentRegistry({
  html: standaloneHtml,
  components: {
    "inline:image": { view: MarkdownImageView },
    "html:img": { view: HtmlImageView },
  },
});
for (const markup of [
  render(standaloneCompiled.blocks, standaloneRegistry),
  render([], standaloneRegistry, standaloneStore),
]) {
  const document = new JSDOM(markup).window.document;
  for (const path of ["/paragraph", "/strong", "/emphasis", "/link", "/list", "/quote", "/header", "/cell", "/html-div", "/html-figure"]) {
    assert.equal(document.querySelector(`img[data-src="${path}"]`)?.getAttribute("data-standalone"), "true", path);
  }
  assert.equal(document.querySelector('img[data-src="/sibling"]')?.getAttribute("data-standalone"), "false");
  assert.equal(document.querySelector('img[data-src="/html-div"]')?.getAttribute("data-width"), "31");
  assert.equal(document.querySelector('img[data-src="/html-div"]')?.getAttribute("data-height"), "17");
  assert.equal(document.querySelector('img[data-src="/html-div"]')?.getAttribute("data-title"), "div title");
  assert.equal(document.querySelector('img[data-src="/html-div"]')?.getAttribute("data-id"), "user-content-photo");
  assert.equal(document.querySelector('img[data-src="/html-div"]')?.getAttribute("data-align"), "center");
  assert.equal(document.querySelector('img[data-src="/html-figure"]')?.getAttribute("data-title"), "figure title");
}

function RawSvgCodeView({ handle }: { readonly handle: CodeNodeHandle }): React.ReactElement {
  const metadata = useCodeBlock(handle);
  return (
    <pre data-source-kind={metadata.sourceKind} data-source-complete={String(metadata.sourceComplete)}>
      {handle.readSource()}
    </pre>
  );
}

const svgOptions: HtmlOptions = { standaloneSvg: "code" };
const svgRegistry = new ComponentRegistry();
svgRegistry.setNodePresentations({ code: { view: RawSvgCodeView } });
for (const [svgSource, complete] of [
  ['<svg onload="raw"><script>keep source</script><circle /></svg>', true],
  ['<svg onload="raw"><circle />', false],
] as const) {
  const svgCompiled = await compileMarkdownSnapshotDirect({ text: svgSource, init: { ...init, html: svgOptions } });
  const svgStore = await streamed(svgSource, { html: svgOptions });
  const codeBlock = svgCompiled.blocks.find((block) => block.type === "code");
  assert.equal(codeBlock?.payload.meta?.sourceKind, "raw-svg");
  assert.equal(codeBlock?.payload.meta?.sourceComplete, complete);
  for (const markup of [
    render(svgCompiled.blocks, svgRegistry),
    render([], svgRegistry, svgStore),
  ]) {
    const document = new JSDOM(markup).window.document;
    const codeView = document.querySelector("pre[data-source-kind='raw-svg']");
    assert.equal(codeView?.getAttribute("data-source-complete"), String(complete));
    assert.equal(codeView?.textContent, svgSource);
    assert.equal(document.querySelector("svg,script"), null);
  }
}

for (const [key, descriptor] of globalDescriptors) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}
console.log("HTML public consumer ownership, scoped plugins, sanitizer and literal content tests passed");
