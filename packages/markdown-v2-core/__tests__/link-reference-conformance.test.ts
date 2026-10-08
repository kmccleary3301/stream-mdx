import assert from "node:assert";
import { parser } from "@lezer/markdown";
import { cleanTitle, cleanUrl } from "../src/inline/lezer-converter";
import { collectLinkReferences } from "../src/inline/reference-collector";

function testCleanUrlPercentPreservation(): void {
  // CommonMark cm503: preserve valid existing %-encoded octets while encoding decoded entity Unicode
  assert.strictEqual(
    cleanUrl("foo%20b&auml;"),
    "foo%20b%C3%A4",
    "cm503: foo%20b&auml; must decode entity and preserve %20",
  );

  // Preserve %25 (percent sign itself) when valid hex
  assert.strictEqual(
    cleanUrl("https://example.com/?q=100%25%20done&amp;tag=caf&eacute;"),
    "https://example.com/?q=100%25%20done&tag=caf%C3%A9",
    "Must preserve %25 and %20 while decoding &amp; and encoding café Unicode",
  );

  // Invalid percent sequence should be encoded
  assert.strictEqual(
    cleanUrl("foo%2"),
    "foo%252",
    "Invalid percent sequence %2 should be encoded to %252",
  );

  assert.strictEqual(
    cleanUrl("foo%2z"),
    "foo%252z",
    "Non-hex percent sequence %2z should be encoded to %252z",
  );

  // Normal characters and spaces
  assert.strictEqual(cleanUrl("foo bar"), "foo%20bar", "Unencoded spaces should be percent-encoded");
  assert.strictEqual(cleanUrl("foo%20bar"), "foo%20bar", "Pre-encoded %20 should remain %20");
}

function testCleanTitleMultiline(): void {
  assert.strictEqual(cleanTitle('"simple"'), "simple");
  assert.strictEqual(
    cleanTitle('"multi\n   line\n   title"'),
    "multi\nline\ntitle",
    "Multi-line title continuation lines must be trimmed of leading/trailing spaces",
  );
  assert.strictEqual(
    cleanTitle("'\ntitle\nline1\nline2\n'"),
    "\ntitle\nline1\nline2\n",
    "Preserve empty lines in title",
  );
}

function testRecursiveCollectLinkReferences(): void {
  // Top-level definition
  const md1 = "[foo]: /url1 'title1'\n\n[foo]\n";
  const tree1 = parser.parse(md1);
  const refs1 = collectLinkReferences(tree1, md1);
  assert.strictEqual(refs1.get("foo")?.href, "/url1");
  assert.strictEqual(refs1.get("foo")?.title, "title1");

  // CommonMark cm218: Nested in blockquote
  const md2 = "[foo]\n\n> [foo]: /url2 'nested title'\n";
  const tree2 = parser.parse(md2);
  const refs2 = collectLinkReferences(tree2, md2);
  assert.strictEqual(refs2.get("foo")?.href, "/url2", "cm218: LinkReference inside blockquote must be collected");
  assert.strictEqual(refs2.get("foo")?.title, "nested title");

  // Multi-line nested in blockquote with continuation QuoteMarks
  const md3 = "> [foo]: /url3 \"multi\n> line\n> title\"\n";
  const tree3 = parser.parse(md3);
  const refs3 = collectLinkReferences(tree3, md3);
  assert.strictEqual(refs3.get("foo")?.href, "/url3");
  assert.strictEqual(
    refs3.get("foo")?.title,
    "multi\nline\ntitle",
    "QuoteMarks and following space must be removed from continuation lines per source positions",
  );

  // Multi-line nested in blockquote with URL on continuation line
  const md4 = "> [foo]:\n> /url4\n> \"title4\"\n";
  const tree4 = parser.parse(md4);
  const refs4 = collectLinkReferences(tree4, md4);
  assert.strictEqual(refs4.get("foo")?.href, "/url4");
  assert.strictEqual(refs4.get("foo")?.title, "title4");

  // Nested inside list item
  const md5 = "- [listref]: /list-url 'list title'\n";
  const tree5 = parser.parse(md5);
  const refs5 = collectLinkReferences(tree5, md5);
  assert.strictEqual(refs5.get("listref")?.href, "/list-url");
  assert.strictEqual(refs5.get("listref")?.title, "list title");

  // Multi-level nested: blockquote inside list item
  const md6 = "* > [deep]: /deep-url\n";
  const tree6 = parser.parse(md6);
  const refs6 = collectLinkReferences(tree6, md6);
  assert.strictEqual(refs6.get("deep")?.href, "/deep-url");
}

testCleanUrlPercentPreservation();
testCleanTitleMultiline();
testRecursiveCollectLinkReferences();
console.log("link-reference-conformance unit tests passed!");
