import assert from "node:assert/strict";
import { InlineParser } from "../src/inline-parser";
import { compileSyntaxRuleToExtension } from "../src/inline/plugin-adapter";
import { sanitizeHtmlInWorker } from "../src/worker-html-sanitizer";

const parser = new InlineParser({
  enableMath: false,
  html: { allowedTags: { span: ["data-safe"], kbd: [] }, literalTagContent: ["kbd"] },
  extensions: [compileSyntaxRuleToExtension({ name: "ticket", pattern: { source: "#([A-Z]+-\\d+)" }, attrs: { id: 1 } })],
});
const nodes = parser.parse('before <span data-safe="&ouml;" onclick="bad()">**#ABC-123** and *nested*</span> after');
const span = nodes.find((node) => node.kind === "html");
assert.ok(span?.kind === "html");
assert.equal(span.tagName, "span");
assert.equal(span.attributes?.dataSafe, "ö");
assert.equal(span.attributes?.onClick, undefined);
assert.equal(span.attributes?.onclick, undefined);
assert.equal(span.children?.[0]?.kind, "strong");
const strong = span.children?.[0];
assert.ok(strong?.kind === "strong");
assert.equal(strong.children[0]?.kind, "plugin");
assert.deepEqual(nodes[nodes.length - 1], { kind: "text", text: " after" });

assert.deepEqual(parser.parse("<kbd>**literal**</kbd>"), [{ kind: "html", raw: "<kbd>**literal**</kbd>", tagName: "kbd", isSelfClosing: false, attributes: {}, sanitized: undefined, children: [{ kind: "text", text: "**literal**" }] }]);
assert.deepEqual(parser.parse('<a h*#ref="hi">'), [{ kind: "text", text: '<a h*#ref="hi">' }]);
const quoted = parser.parse('*<img src="foo" title="*"/>');
assert.deepEqual(quoted[0], { kind: "text", text: "*" });
assert.equal(quoted[1]?.kind, "html");
const multiline = parser.parse('<a href="foo  \nbar">');
assert.equal(multiline[0]?.kind, "html");
assert.equal(parser.parse("foo <!-- comment --> bar").filter((node) => node.kind === "html").length, 1);
assert.equal(parser.parse("foo <?php echo 1; ?> bar").filter((node) => node.kind === "html").length, 1);
assert.equal(sanitizeHtmlInWorker('<script>secret()</script><style>secret-style</style><b>safe</b>', { allowedTags: { script: [], style: [], b: [] } }), "<b>safe</b>");
console.log("typed inline HTML AST tests passed");
