import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { Block, HtmlOptions, SyntaxRuleSpec, WorkerOut } from "@stream-mdx/core";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { ComponentRegistry, MarkdownBlocksRenderer, createRendererStore, type RendererStore } from "../src/server";
import { normalizeHtmlSemantics } from "../../../tests/conformance/normalizer.mts";

const window = new JSDOM("").window;
Object.assign(globalThis, { window, document: window.document, DOMParser: window.DOMParser, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement });
const init = { prewarmLangs: [], docPlugins: { html: true, mdx: false, tables: true, math: false } };

function render(blocks: Block[], registry = new ComponentRegistry(), store?: RendererStore): string {
  return renderToStaticMarkup(<MarkdownBlocksRenderer blocks={blocks} componentRegistry={registry} store={store} />);
}

async function streamed(text: string, config: { html?: HtmlOptions; syntax?: SyntaxRuleSpec[] } = {}): Promise<RendererStore> {
  const worker = createInlineEngineWorker();
  const store = createRendererStore();
  const { promise, resolve, reject } = Promise.withResolvers<RendererStore>();
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
console.log("HTML public consumer ownership, scoped plugins, sanitizer and literal content tests passed");
