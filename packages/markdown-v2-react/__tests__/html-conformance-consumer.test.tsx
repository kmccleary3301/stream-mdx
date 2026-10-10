import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, hydrateRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { Block, HtmlOptions, SyntaxRuleSpec, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { ComponentRegistry, MarkdownBlocksRenderer, createRendererStore, type RendererStore } from "../src/server";
import { normalizeHtmlSemantics } from "../../../tests/conformance/normalizer.mts";

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

async function streamed(text: string, config: Pick<Extract<WorkerIn, { type: "INIT" }>, "html" | "syntax" | "docPlugins" | "mdxCompileMode"> = {}): Promise<RendererStore> {
  const worker = createInlineEngineWorker();
  const store = createRendererStore();
  const { promise, resolve, reject } = deferred<RendererStore>();
  worker.onmessage = (event: MessageEvent<WorkerOut>) => {
    const message = event.data;
    if (message.type === "INITIALIZED") store.reset(message.blocks);
    else if (message.type === "PATCH") store.applyPatches(message.patches);
    else if (message.type === "FINALIZED") {
      worker.terminate();
      resolve(store);
    } else if (message.type === "ERROR") {
      worker.terminate();
      reject(new Error(message.error.message));
    }
  };
  worker.postMessage({ type: "INIT", initialContent: "", ...init, ...config });
  for (const char of text) worker.postMessage({ type: "APPEND", text: char });
  worker.postMessage({ type: "FINALIZE" });
  return promise;
}

const examples = JSON.parse(await fs.readFile(new URL("../../../tests/conformance/fixtures/commonmark-spec-0.31.2.json", import.meta.url), "utf8")) as Array<{ number: number; markdown: string; html: string }>;
const assigned = [148, 155, 167, 168, 171, 172, 173, 176, 177, 180, 187, 190, 191, 201, 475, 476, 477, 491, 494, 524, 536, 613, 614, 615, 616, 621, 623, 625, 626, 627, 628, 629, 630, 631, 642, 643];
const failures: string[] = [];
const passing: number[] = [];
for (const number of assigned) {
  const example = examples.find((value) => value.number === number)!;
  const text = example.markdown.replace(/→/g, "\t");
  const expected = normalizeHtmlSemantics(example.html.replace(/→/g, "\t"));
  const compiled = await compileMarkdownSnapshotDirect({ text, init });
  const staticHtml = normalizeHtmlSemantics(render(compiled.blocks));
  const store = await streamed(text);
  const streamingHtml = normalizeHtmlSemantics(render([], undefined, store));
  if (staticHtml !== expected || streamingHtml !== expected) {
    failures.push(`cm_${number}: expected ${expected}\nstatic ${staticHtml}\nstreaming ${streamingHtml}`);
  } else passing.push(number);
}
console.log(`HTML consumer observed passing IDs: ${passing.map((number) => `cm_${number}`).join(", ")}`);
assert.deepEqual(failures, [], failures.join("\n"));

// Actual parsed markdown leaves must survive an HTML owner, rather than becoming raw HTML text.
const syntax: SyntaxRuleSpec[] = [{ name: "ticket", pattern: { source: "#([A-Z]+-\\d+)" }, attrs: { id: 1 } }];
const html: HtmlOptions = { allowedTags: { del: [], span: ["data-safe"], kbd: [] }, literalTagContent: ["kbd"] };
const text = '<del>\n\n**#ABC-123** and <span data-safe="yes" onclick="alert(1)">*nested*</span> <kbd>**literal**</kbd>\n\n</del>\n';
const store = await streamed(text, { html, syntax });
const registry = new ComponentRegistry({}, {
  ticket: ({ attrs }: { attrs: Record<string, string> }) => <mark data-ticket={attrs.id}>{attrs.id}</mark>,
});
registry.setHtmlElements({ del: (props: React.HTMLAttributes<HTMLElement>) => <del {...props} data-mapped="yes" /> });
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
const paragraphRegistry = new ComponentRegistry({
  paragraph: ({ children }) => <p data-paragraph="configured">{children}</p>,
});
const paragraphDocument = new JSDOM(render([], paragraphRegistry, paragraphStore)).window.document;
assert.equal(paragraphDocument.querySelector('p[data-paragraph="configured"]')?.textContent, "A B");
assert.equal(paragraphDocument.querySelectorAll("p").length, 1, "normalized paragraph must use its configured component exactly once");

const captureStore = await streamed('start [[<a href="/outer">[inner](/inner) trailing]] end', {
  syntax: [{ name: "capture", pattern: { source: "\\[\\[([\\s\\S]*?)\\]\\]" }, content: 1 }],
});
const captureRegistry = new ComponentRegistry({}, {
  capture: ({ children }: { children?: React.ReactNode }) => <mark data-capture="configured">{children}</mark>,
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
  captureRoot.render(<MarkdownBlocksRenderer store={captureStore} componentRegistry={captureRegistry} />);
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
const codeInit = { ...init, docPlugins: { ...init.docPlugins, mdx: true }, mdxCompileMode: "server" as const };
const codeCompiled = await compileMarkdownSnapshotDirect({ text: codeSource, init: codeInit });
const codeSerialized = JSON.parse(JSON.stringify(codeCompiled.blocks)) as Block[];
const codeStore = await streamed(codeSource, codeInit);
const customCodeRegistry = new ComponentRegistry({
  paragraph: ({ children }) => <p data-paragraph="configured">{children}</p>,
});
customCodeRegistry.setInlineComponents({
  code: ({ text }) => <code className="inline-code" data-code="configured">{text}</code>,
});
for (const registry of [new ComponentRegistry(), customCodeRegistry]) {
  for (const element of [
    <MarkdownBlocksRenderer blocks={codeCompiled.blocks} componentRegistry={registry} />,
    <MarkdownBlocksRenderer blocks={codeSerialized} componentRegistry={registry} />,
    <MarkdownBlocksRenderer store={codeStore} componentRegistry={registry} />,
  ]) {
    const assertCodeOwnership = (root: ParentNode) => {
      const codes = Array.from(root.querySelectorAll("code.inline-code"));
      assert.deepEqual(codes.map((code) => code.textContent), [
        "{:js}{:js}", "{:js}{:js}", "{:js}{:js}", "{:js}{:js}", "{:js}{:js}",
        "{:js} `literal` {:js}", "{:js}{:js}",
      ], "root, nested paragraphs/list items, double ticks and table cells must retain native inline-code ownership");
      assert.equal(root.querySelector(".markdown-mdx-inline, .markdown-mdx-error, [data-mdx-status]"), null);
      assert.equal(codes[0].closest("p")?.textContent, expectedParagraph, "the fixture's whole paragraph prose must survive");
      assert.equal(codes[1].closest("blockquote p")?.textContent, expectedParagraph);
      assert.equal(codes[2].closest("li")?.textContent, expectedParagraph);
      assert.equal(codes[3].closest("p")?.textContent, expectedParagraph);
      assert.ok(codes[4].closest("li li"));
      assert.equal(codes[6].closest("td")?.textContent, "{:js}{:js}");
      if (registry === customCodeRegistry) {
        assert.equal(root.querySelectorAll('code[data-code="configured"]').length, codes.length);
        assert.ok(codes[0].closest('p[data-paragraph="configured"]'));
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
    assert.equal(document.querySelector("code.inline-code")?.textContent, "{:js}{:js}");
    assert.equal(document.querySelector("em")?.textContent, "HTML");
    assert.deepEqual(Array.from(document.querySelectorAll(".markdown-mdx-inline")).map((span) => span.textContent), ["{outside}", "<InlineChip />"]);
    assert.equal(document.querySelector('[data-mdx-status="error"]'), null);
    assert.equal(document.querySelector('a[href="/safe"]')?.textContent, "link");
    assert.equal(document.querySelector("p")?.textContent, "Code {:js}{:js} with HTML and {outside} <InlineChip /> link tail.");
  }
}
for (const [key, descriptor] of globalDescriptors) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}
console.log("HTML public consumer ownership, scoped plugins, sanitizer and literal content tests passed");
