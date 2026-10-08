import assert from "node:assert/strict";
import { GFM, parser } from "@lezer/markdown";
import { createBlockSnapshot } from "../src/block-snapshot";
import { createBlockCompatibilityExtension } from "../src/block-compatibility";
import { InlineParser } from "../src/inline-parser";
import { prepareNestedBlockSnapshot } from "../src/nested-block-snapshot";
import { parseCodeFenceInfo } from "../src/utils";
import type { Block, NodeSnapshot } from "../src/types";

function flatten(snapshot: NodeSnapshot): NodeSnapshot[] {
  return [snapshot, ...(snapshot.children ?? []).flatMap(flatten)];
}

for (const [raw, expected] of [
  ["- foo\n\n\t\tbar\n", "  bar"],
  [">\t\tfoo\n", "  foo"],
  ["-\t\tfoo\n", "  foo"],
  ["- Foo\n\n      bar\n\n\n      baz\n", "bar\n\n\nbaz"],
  ["1.      indented code\n\n   paragraph\n\n       more code\n", " indented code"],
  ["-\n      baz\n", "baz"],
] as const) {
  const block: Block = { id: "container", type: raw.startsWith(">") ? "blockquote" : "list", isFinalized: true, payload: { raw } };
  const code = flatten(createBlockSnapshot(block)).find((node) => node.type === "code");
  assert.ok(code, raw);
  assert.equal((code.props?.block as Block).payload.meta?.code, expected, raw);
}

const raw = "1. ```\n   foo\n   ```\n\n   bar\n";
const ordered: Block = { id: "ordered", type: "list", isFinalized: false, payload: { raw } };
const snapshot = createBlockSnapshot(ordered);
assert.deepEqual(snapshot.children?.[0].children?.map((node) => node.type), ["code", "paragraph"]);
for (const child of flatten(snapshot).filter((node) => node.props?.block)) assert.equal((child.props?.block as Block).isFinalized, false);

const quoted: Block = { id: "quote", type: "blockquote", isFinalized: true, payload: { raw: ">>> foo\n> bar\n>>baz\n" } };
const paragraph = flatten(createBlockSnapshot(quoted)).find((node) => node.type === "paragraph");
assert.equal((paragraph?.props?.block as Block).payload.raw, "foo\nbar\nbaz");

const instance = new InlineParser({ syntax: [{ name: "ticket", pattern: { source: "#([A-Z]+-\\d+)" }, attrs: { id: 1 } }] });
const custom: Block = { id: "custom", type: "list", isFinalized: true, payload: { raw: "- #ABC-12" } };
custom.payload.meta = { preparedNested: prepareNestedBlockSnapshot(custom, instance, parser.configure([GFM, createBlockCompatibilityExtension()])) };
const prepared = createBlockSnapshot(JSON.parse(JSON.stringify(custom)) as Block);
assert.ok((prepared.children?.[0].props?.inline as Array<{ kind: string; name?: string }>).some((node) => node.kind === "plugin" && node.name === "ticket"));
assert.equal(JSON.stringify(prepared.children), JSON.stringify(createBlockSnapshot(custom).children));

const emptyQuote: Block = { id: "definition", type: "blockquote", isFinalized: true, payload: { raw: "> [foo]: /url\n" } };
assert.deepEqual(createBlockSnapshot(emptyQuote).children, []);
for (const raw of [">\n", ">\n>  \n> \n"]) {
  assert.deepEqual(createBlockSnapshot({ ...emptyQuote, payload: { raw } }).children, []);
}
const table: Block = { id: "table", type: "table", isFinalized: true, payload: { raw: "|a|\n|-|", meta: { header: [[{ kind: "text", text: "a" }]], rows: [] } } };
assert.equal(createBlockSnapshot(table).children?.some((node) => node.type === "table-body"), false, "GFM205 omits an empty tbody");

assert.equal(parseCodeFenceInfo("unknown\\+&amp;").lang, "unknown+&");
assert.equal(parseCodeFenceInfo("\\&amp;").lang, "&amp;", "escaped entity opener is not decoded a second time");
assert.equal(parseCodeFenceInfo("unknown&madeup;").lang, "unknown&madeup;");
console.log("nested block snapshot conformance passed");

for (const [rawHtml, expectedHtml] of [
  ["- <pre>\n      literal\n  </pre>\n", "<pre>\n    literal\n</pre>"],
  ["> <pre>\n>     literal\n> </pre>\n", "<pre>\n    literal\n</pre>"],
] as const) {
  const container: Block = { id: "html", type: rawHtml.startsWith(">") ? "blockquote" : "list", isFinalized: true, payload: { raw: rawHtml } };
  const html = flatten(createBlockSnapshot(container)).find((node) => node.type === "html");
  assert.equal((html?.props?.block as Block).payload.raw, expectedHtml);
}
