import assert from "node:assert/strict";
import { InlineParser } from "../src/inline-parser";

const parser = new InlineParser({ maxCacheEntries: 0 });

for (const source of ["[ok]", "_foo_"]) {
  assert.deepEqual(parser.parseSettledPrefix(source).nodes, []);
}
assert.equal(parser.parse("[ok](/destination)")[0]?.kind, "link");
assert.deepEqual(parser.parse("_foo_x"), [{ kind: "text", text: "_foo_x" }]);
assert.deepEqual(parser.parseSettledPrefix("x `code`").nodes, [{ kind: "text", text: "x " }]);
assert.deepEqual(parser.parseSettledPrefix("foo  ").nodes, []);
assert.deepEqual(parser.parse("foo  \nbar"), [
  { kind: "text", text: "foo" },
  { kind: "br" },
  { kind: "text", text: "bar" },
]);

const reference = parser.parseSettledPrefix("[foo][A B] word ");
assert.deepEqual(reference.nodes, [{ kind: "text", text: "[foo][A B] " }]);
assert.deepEqual([...reference.attemptedReferences], ["a b"]);
assert.deepEqual(parser.parseSettledPrefix("[foo][A B] ").nodes, []);

const pendingCitation = parser.parseSettledPrefix("prefix {cite:unfinished later ");
assert.deepEqual(pendingCitation.nodes, [{ kind: "text", text: "prefix " }]);
assert.equal(parser.parse("prefix {cite:unfinished later } next ")[1]?.kind, "citation");
const references = new InlineParser({ references: { ref: { href: "/reference" } } });
const held = references.parseSettledPrefix("{cite:unfinished [later][ref] continued ");
assert.equal(held.settledTo, 0);
assert.deepEqual([...held.attemptedReferences], []);

const opaque = parser.parseSettledPrefix("prefix `{cite:` safe more ");
assert.deepEqual(opaque.nodes, [
  { kind: "text", text: "prefix " },
  { kind: "code", text: "{cite:" },
  { kind: "text", text: " safe " },
]);
const opaqueUrl = parser.parseSettledPrefix("x `http://a.com` next ");
assert.deepEqual(opaqueUrl.nodes, [
  { kind: "text", text: "x " },
  { kind: "code", text: "http://a.com" },
  { kind: "text", text: " " },
]);

const declared = new InlineParser({
  syntax: [{
    name: "bounded",
    pattern: { source: "\\{\\{([^}]+)\\}\\}" },
    anticipation: { open: "{{", close: "}}" },
  }],
});
assert.deepEqual(declared.parseSettledPrefix("before {{unfinished later ").nodes, [
  { kind: "text", text: "before " },
]);
declared.registerExtension({
  name: "bounded",
  lezer: { parseInline: [{ name: "Custom_Rule_bounded", parse: () => -1 }] },
  toInline: () => null,
});
assert.equal(declared.parseSettledPrefix("before {{bounded}} later ").settledTo, 0);

const unicode = "before\r\n😀 final ";
const settled = parser.parseSettledPrefix(unicode);
assert.ok(settled.settledTo > 0);
assert.ok(!(unicode.charCodeAt(settled.settledTo - 1) === 13 && unicode.charCodeAt(settled.settledTo) === 10));
assert.ok(!(
  unicode.charCodeAt(settled.settledTo - 1) >= 0xd800 &&
  unicode.charCodeAt(settled.settledTo - 1) <= 0xdbff &&
  unicode.charCodeAt(settled.settledTo) >= 0xdc00 &&
  unicode.charCodeAt(settled.settledTo) <= 0xdfff
));

console.log("Native inline settlement behavior tests passed");
