import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GFM, parser } from "@lezer/markdown";
import { createBlockSnapshot, inlineNodesToPlainText } from "../src/block-snapshot";
import { createBlockCompatibilityExtension } from "../src/block-compatibility";
import { InlineParser } from "../src/inline-parser";
import { prepareNestedBlockSnapshot } from "../src/nested-block-snapshot";
import type { Block, InlineNode, NodeSnapshot } from "../src/types";
import { parseCodeFenceInfo } from "../src/utils";

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

const quotedRaw = ">>> foo\n> bar\n>>baz\n";
const quoted: Block = { id: "quote", type: "blockquote", isFinalized: true, payload: { raw: quotedRaw } };
const paragraph = flatten(createBlockSnapshot(quoted)).find((node) => node.type === "paragraph");
assert.ok(paragraph);
const paragraphBlock = paragraph.props?.block as Block;
assert.deepEqual(paragraphBlock.payload.range, { from: 4, to: 19 });
assert.equal(paragraphBlock.payload.raw, quotedRaw.slice(4, 19));
assert.equal(paragraph.props?.text, "foo\nbar\nbaz");

for (const type of ["list", "blockquote"] as const) {
  for (const isFinalized of [false, true]) {
    for (const mathEnabled of [false, true, undefined]) {
      const text = "$x$ and $$y$$";
      const block: Block = {
        id: `math-${type}-${isFinalized}-${mathEnabled}`,
        type,
        isFinalized,
        payload: {
          raw: `${type === "list" ? "-" : ">"} ${text}`,
          meta: { mathEnabled },
        },
      };
      const node = flatten(createBlockSnapshot(block)).find((child) => child.type === (type === "list" ? "list-item" : "paragraph"));
      assert.ok(node, "expected visible container content");
      const inline = node.props?.inline as Array<{ kind: string; text?: string }>;
      if (mathEnabled === false) {
        assert.deepEqual(inline, [{ kind: "text", text }], "fallback must preserve disabled math as visible literal text");
        assert.equal(node.props?.text, text);
      } else {
        assert.ok(inline.some((child) => child.kind === "math-inline"), "fallback must retain enabled inline math");
        assert.ok(inline.some((child) => child.kind === "math-display"), "fallback must retain enabled display math");
      }
    }
  }
}

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

for (const [rawHtml, expectedHtml] of [
  ["- <pre>\n      literal\n  </pre>\n", "<pre>\n    literal\n</pre>"],
  ["> <pre>\n>     literal\n> </pre>\n", "<pre>\n    literal\n</pre>"],
] as const) {
  const container: Block = { id: "html", type: rawHtml.startsWith(">") ? "blockquote" : "list", isFinalized: true, payload: { raw: rawHtml } };
  const html = flatten(createBlockSnapshot(container)).find((node) => node.type === "html");
  assert.ok(html);
  const htmlBlock = html.props?.block as Block;
  const sourceFrom = rawHtml.indexOf("<pre>");
  const closingTag = "</pre>";
  const sourceTo = rawHtml.indexOf(closingTag, sourceFrom) + closingTag.length;
  assert.deepEqual(htmlBlock.payload.range, { from: sourceFrom, to: sourceTo });
  assert.equal(htmlBlock.payload.raw, expectedHtml, "nested HTML renders from container-marker-free text");
}

const htmlQuoteRaw = "> <div>\n> literal\n>\n> #ABC-12\n>\n> ```js\n> const x=1;\n> ```\n>\n> </div>\n";
const htmlQuote: Block = {
  id: "html-context",
  type: "blockquote",
  isFinalized: true,
  payload: { raw: htmlQuoteRaw, range: { from: 400, to: 400 + htmlQuoteRaw.length } },
};
const htmlQuotePrepared = prepareNestedBlockSnapshot(htmlQuote, instance, parser.configure([GFM, createBlockCompatibilityExtension()]));
const htmlQuoteSnapshots = htmlQuotePrepared.children.flatMap(flatten);
const htmlQuoteCode = htmlQuoteSnapshots.find((node) => node.type === "code");
assert.equal((htmlQuoteCode?.props?.block as Block).payload.meta?.code, "const x=1;");
assert.equal(htmlQuoteCode?.range?.from, 400 + htmlQuoteRaw.indexOf("```js"), "native source offset survives quoted HTML boundary");
const htmlQuoteParagraph = htmlQuoteSnapshots.find((node) => node.type === "paragraph");
assert.ok((htmlQuoteParagraph?.props?.inline as Array<{ kind: string; name?: string }>).some((node) => node.kind === "plugin" && node.name === "ticket"), "owning inline plugin is retained after quoted HTML");
const htmlQuoteOpening = htmlQuoteSnapshots.find((node) => node.type === "html");
const htmlQuoteOpeningBlock = htmlQuoteOpening?.props?.block as Block;
const htmlOpeningFrom = htmlQuoteRaw.indexOf("<div>");
const htmlOpeningTo = htmlQuoteRaw.indexOf("\n>\n", htmlOpeningFrom);
assert.ok(htmlQuoteOpening);
assert.ok(htmlOpeningTo > htmlOpeningFrom);
assert.deepEqual(htmlQuoteOpeningBlock.payload.range, {
  from: 400 + htmlOpeningFrom,
  to: 400 + htmlOpeningTo,
});
assert.equal(htmlQuoteOpeningBlock.payload.raw, "<div>\nliteral", "native continuation QuoteMarks are removed, not parsed independently");
assert.equal(htmlQuoteOpening.type, "html");

const nativeParser = parser.configure([GFM, createBlockCompatibilityExtension()]);
for (const [fixture, itemPrefixes] of [
  ["inline-html-allowlist.md", []],
  ["nested-formatting-ancestors.md", ["Quoted list item with **nested strong text**", "Quoted list item with *nested italic text*"]],
  ["nested-math-inline.md", ["Quoted nested item with inline math:"]],
  ["nested-blockquote-list-crossover.md", ["Nested list in quote with cite {cite:12", "Another nested item with inline math $x + y"]],
  ["mdx-expression-no-swallow-negative.mdx", ["Quoted list item with {quotedNestedExpr and quoted sibling prose that must remain visible."]],
] as const) {
  const source = readFileSync(new URL(`../../../tests/regression/fixtures/${fixture}`, import.meta.url), "utf8");
  const roots: NodeSnapshot[] = [];
  for (let node = nativeParser.parse(source).topNode.firstChild; node; node = node.nextSibling) {
    if (!["BulletList", "OrderedList", "Blockquote"].includes(node.type.name)) continue;
    const block: Block = {
      id: `${fixture}:${node.from}`,
      type: node.type.name === "Blockquote" ? "blockquote" : "list",
      isFinalized: true,
      payload: { raw: source.slice(node.from, node.to), range: { from: node.from, to: node.to } },
    };
    block.payload.meta = { preparedNested: prepareNestedBlockSnapshot(block, new InlineParser(), nativeParser) };
    roots.push(createBlockSnapshot(block));
  }
  const quote = roots.flatMap(flatten).find((node) => node.type === "blockquote");
  assert.ok(quote, `${fixture}: native quote must remain present`);
  assert.deepEqual(quote.children?.map((child) => child.type), itemPrefixes.length ? ["paragraph", "list"] : ["paragraph"], `${fixture}: prose and nested lists must remain separate ordered blocks`);
  if (!itemPrefixes.length) {
    const paragraphNode = quote.children?.[0];
    assert.ok(paragraphNode);
    const paragraphSource = "Blockquote with nested inline HTML: <code>npm run docs:dev</code> and trailing prose.";
    const paragraphFrom = source.indexOf(paragraphSource);
    assert.ok(paragraphFrom >= 0, `${fixture}: authored paragraph must be present in the source`);
    const paragraphBlock = paragraphNode.props?.block as Block;
    assert.deepEqual(paragraphBlock.payload.range, {
      from: paragraphFrom,
      to: paragraphFrom + paragraphSource.length,
    });
    assert.equal(paragraphBlock.payload.raw, source.slice(paragraphFrom, paragraphFrom + paragraphSource.length));
    assert.equal(paragraphNode.props?.text, "Blockquote with nested inline HTML: npm run docs:dev and trailing prose.");
    const paragraphInline = paragraphNode.props?.inline as InlineNode[];
    const inlineCode = paragraphInline.find((node) => node.kind === "html" && node.tagName === "code");
    assert.ok(inlineCode?.kind === "html", `${fixture}: nested inline code must retain its HTML element`);
    assert.equal(inlineNodesToPlainText(inlineCode.children ?? []), "npm run docs:dev");
    continue;
  }
  const list = quote.children?.[1];
  assert.equal(list?.children?.length, itemPrefixes.length, `${fixture}: quoted item count must match authored source`);
  itemPrefixes.forEach((prefix, index) => {
    const inline = list?.children?.[index].props?.inline as Array<{ kind: string; text?: string }> | undefined;
    const itemRaw = (list?.children?.[index].props?.block as Block).payload.raw;
    assert.ok(itemRaw.includes(prefix), `${fixture}: quoted item ${index} retains its exact source`);
    assert.ok(inline?.length, `${fixture}: quoted item ${index} retains inline content`);
  });
  if (fixture === "nested-blockquote-list-crossover.md") {
    assert.deepEqual(roots[0].children?.[0].children?.map((child) => child.type), ["blockquote", "list"], "returning nested list must be the quote's independent following sibling");
  }
}

const orderedQuote: Block = {
  id: "ordered-quote",
  type: "blockquote",
  isFinalized: true,
  payload: { raw: "> before\n>\n> 3. first\n> 4. second\n>\n> after\n" },
};
const orderedQuotePrepared = prepareNestedBlockSnapshot(orderedQuote, new InlineParser(), nativeParser);
assert.deepEqual(orderedQuotePrepared.children.map((child) => child.type), ["paragraph", "list", "paragraph"]);
assert.equal(orderedQuotePrepared.children[1].props?.ordered, true);
assert.equal(orderedQuotePrepared.children[1].props?.start, 3);
assert.deepEqual(orderedQuotePrepared.children[1].children?.map((item) => item.props?.text), ["first", "second"]);
assert.deepEqual([orderedQuotePrepared.children[0].props?.text, orderedQuotePrepared.children[2].props?.text], ["before", "after"]);

for (const raw of [
  "- Inline code: `{:js}{:js}`.\n",
  "> - Inline code: `{:js}{:js}`.\n",
  "- parent\n  - Inline code: `{:js}{:js}`.\n",
  "- [x] Inline code: `{:js}{:js}`.\n",
  "- Inline code: `` {:js} `literal` {:js} ``.\n",
]) {
  const block: Block = {
    id: "native-code",
    type: raw.startsWith(">") ? "blockquote" : "list",
    isFinalized: true,
    payload: { raw, range: { from: 700, to: 700 + raw.length } },
  };
  block.payload.meta = { preparedNested: prepareNestedBlockSnapshot(block, new InlineParser(), nativeParser) };
  for (const value of [block, JSON.parse(JSON.stringify(block)) as Block]) {
    const nodes = flatten(createBlockSnapshot(value));
    assert.equal(nodes.some((node) => node.type === "list-item-mdx"), false, raw);
    const item = nodes.find((node) => node.type === "list-item" && (node.props?.text as string).startsWith("Inline code:"));
    assert.ok(item, raw);
    assert.deepEqual((item.props?.inline as Array<{ kind: string; text?: string }>).filter((node) => node.kind === "code"), [
      { kind: "code", text: raw.includes("``") ? "{:js} `literal` {:js}" : "{:js}{:js}" },
    ]);
    assert.equal(item.props?.text, raw.includes("``") ? "Inline code: {:js} `literal` {:js}." : "Inline code: {:js}{:js}.");
  }
}

const mixedCodeRaw = "- Before <em>HTML</em> `{:js}{:js}` after {outside} <InlineChip /> tail.\n";
const mixedCodeBlock: Block = {
  id: "native-code-outside",
  type: "list",
  isFinalized: true,
  payload: { raw: mixedCodeRaw, range: { from: 900, to: 900 + mixedCodeRaw.length } },
};
mixedCodeBlock.payload.meta = { preparedNested: prepareNestedBlockSnapshot(mixedCodeBlock, new InlineParser(), nativeParser) };
const mixedCodeNodes = flatten(createBlockSnapshot(JSON.parse(JSON.stringify(mixedCodeBlock)) as Block));
assert.deepEqual(mixedCodeNodes.filter((node) => node.type === "list-item-mdx").map((node) => node.props?.raw), ["{outside}", "<InlineChip />"]);
assert.deepEqual(mixedCodeNodes.filter((node) => node.type === "list-item-html").map((node) => node.props?.raw), ["<em>HTML</em>"]);
assert.deepEqual(mixedCodeNodes.filter((node) => node.type === "list-item-text").flatMap((node) => node.props?.inline as Array<{ kind: string; text?: string }>).filter((node) => node.kind === "code"), [
  { kind: "code", text: "{:js}{:js}" },
]);
const coldCrlfRegressionRaw = "> **Quoted paragraph**\r\n> continuation\r\n";
const coldCrlfRegression: Block = {
  id: "cold-crlf-regression",
  type: "blockquote",
  isFinalized: true,
  payload: { raw: coldCrlfRegressionRaw },
};
const coldCrlfRegressionParagraph = flatten(createBlockSnapshot(coldCrlfRegression)).find((node) => node.type === "paragraph");
assert.ok(coldCrlfRegressionParagraph, "cold CRLF container must expose its quoted paragraph");
assert.equal(
  coldCrlfRegressionParagraph.props?.text,
  "Quoted paragraph\ncontinuation",
  "cold CRLF meaning must not retain a dangling carriage return",
);
const coldCrlfRegressionBlock = coldCrlfRegressionParagraph.props?.block as Block;
assert.deepEqual(coldCrlfRegressionBlock.payload.range, { from: 2, to: 38 }, "cold CRLF child range must use physical UTF-16 offsets");
assert.equal(
  coldCrlfRegressionBlock.payload.raw,
  "**Quoted paragraph**\r\n> continuation",
  "cold CRLF child raw must preserve the exact authored source",
);
const coldCrlfRaw = "> **Quoted paragraph😀**\r\n> continuation\r\n";
const coldCrlfBlock: Block = {
  id: "cold-crlf-quote",
  type: "blockquote",
  isFinalized: true,
  payload: { raw: coldCrlfRaw, range: { from: 700, to: 700 + coldCrlfRaw.length } },
};
const coldCrlfParagraph = flatten(createBlockSnapshot(coldCrlfBlock)).find((node) => node.type === "paragraph");
assert.ok(coldCrlfParagraph, "cold CRLF parsing must retain the quoted paragraph");
assert.equal(coldCrlfParagraph.props?.text, "Quoted paragraph😀\ncontinuation", "cold CRLF text must normalize line endings and preserve astral text");
const coldCrlfParagraphBlock = coldCrlfParagraph.props?.block as Block;
assert.deepEqual(coldCrlfParagraphBlock.payload.range, { from: 702, to: 740 }, "cold CRLF range must map through its nonzero container offset");
assert.equal(coldCrlfParagraphBlock.payload.raw, "**Quoted paragraph😀**\r\n> continuation", "cold CRLF raw must retain its physical source");
assert.equal(coldCrlfParagraphBlock.payload.raw, coldCrlfRaw.slice(2, 40), "cold CRLF range must select the exact physical UTF-16 source");

const coldLoneCrRaw = "> first\r> second\r";
const coldLoneCrBlock: Block = {
  id: "cold-lone-cr-quote",
  type: "blockquote",
  isFinalized: true,
  payload: { raw: coldLoneCrRaw, range: { from: 900, to: 917 } },
};
const coldLoneCrParagraph = flatten(createBlockSnapshot(coldLoneCrBlock)).find((node) => node.type === "paragraph");
assert.ok(coldLoneCrParagraph, "cold lone-CR parsing must retain the quoted paragraph");
assert.equal(coldLoneCrParagraph.props?.text, "first\nsecond", "cold lone-CR meaning must use a Markdown line break");
const coldLoneCrParagraphBlock = coldLoneCrParagraph.props?.block as Block;
assert.deepEqual(coldLoneCrParagraphBlock.payload.range, { from: 902, to: 916 }, "cold lone-CR child range must retain its nonzero physical offset");
assert.equal(coldLoneCrParagraphBlock.payload.raw, "first\r> second", "cold lone-CR child raw must preserve the authored carriage return");
assert.equal(coldLoneCrParagraphBlock.payload.raw, coldLoneCrRaw.slice(2, 16), "cold lone-CR range must select the exact physical source");

console.log("nested block snapshot conformance passed");
