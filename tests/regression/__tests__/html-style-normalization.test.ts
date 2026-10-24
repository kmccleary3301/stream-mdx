import assert from "node:assert/strict";

import { chromium } from "@playwright/test";

import {
  canonicalizeAttributeOrder,
  normalizeInlineStyleSerialization,
} from "../../../scripts/regression/html-style-normalization";

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {

    assert.equal(
      await normalizeInlineStyleSerialization(page, '<div class="output" style="contain:content"></div>'),
      await normalizeInlineStyleSerialization(page, '<div class="output" style="contain: content;"></div>'),
      "spacing and a trailing semicolon do not change parsed inline-style semantics",
    );
    const normalizedContain = await normalizeInlineStyleSerialization(
      page,
      '<div class="output" style="contain:content"></div>',
    );
    assert.equal(
      await normalizeInlineStyleSerialization(page, normalizedContain),
      normalizedContain,
      "normalization is idempotent",
    );

    const styleMentionInText = '<div>literal style="contain:content"</div>';
    assert.equal(
      await normalizeInlineStyleSerialization(page, styleMentionInText),
      styleMentionInText,
      "text that resembles an inline-style attribute remains byte-identical",
    );

    const unicodePrefix = '<div data-label="𝄞" style="';
    const unicodeSuffix = '" data-after="preserved"></div>';
    const unicodeHtml = `${unicodePrefix}contain:content${unicodeSuffix}`;
    const normalizedUnicodeHtml = await normalizeInlineStyleSerialization(page, unicodeHtml);
    assert.notEqual(normalizedUnicodeHtml, unicodeHtml, "style after supplementary Unicode is canonicalized");
    assert.ok(normalizedUnicodeHtml.startsWith(unicodePrefix), "source bytes before the style value remain exact");
    assert.ok(normalizedUnicodeHtml.endsWith(unicodeSuffix), "source bytes after the style value remain exact");
    assert.notEqual(
      await normalizeInlineStyleSerialization(page, '<div style="color:red"></div>'),
      await normalizeInlineStyleSerialization(page, '<div style="color:blue"></div>'),
      "different CSS values remain distinguishable",
    );
    assert.notEqual(
      await normalizeInlineStyleSerialization(page, '<div style="color:red!important"></div>'),
      await normalizeInlineStyleSerialization(page, '<div style="color:red"></div>'),
      "CSS priority remains distinguishable",
    );

    const quotedDelimiter = await normalizeInlineStyleSerialization(page, `<div style='--payload:"a;b"'></div>`);
    assert.equal(
      quotedDelimiter,
      await normalizeInlineStyleSerialization(page, `<div style='--payload: "a;b" ;'></div>`),
      "a semicolon inside a quoted custom-property value is not treated as a declaration boundary",
    );
    assert.notEqual(
      quotedDelimiter,
      await normalizeInlineStyleSerialization(page, `<div style='--payload:"a;c"'></div>`),
      "quoted custom-property content remains part of the compared CSS value",
    );
    assert.equal(
      await normalizeInlineStyleSerialization(page, quotedDelimiter),
      quotedDelimiter,
      "quoted custom-property normalization remains idempotent",
    );

    const dataUrl = await normalizeInlineStyleSerialization(
      page,
      '<div style="background-image:url(&quot;data:image/svg+xml,a;b&quot;)"></div>',
    );
    assert.equal(
      dataUrl,
      await normalizeInlineStyleSerialization(
        page,
        '<div style="background-image: url(&quot;data:image/svg+xml,a;b&quot;);"></div>',
      ),
      "semicolons inside quoted data URLs are parsed as CSS value content",
    );

    assert.notEqual(
      await normalizeInlineStyleSerialization(page, '<div style="margin:1px;margin-left:2px"></div>'),
      await normalizeInlineStyleSerialization(page, '<div style="margin-left:2px;margin:1px"></div>'),
      "overlapping shorthand and longhand declarations retain cascade order",
    );

    assert.notEqual(
      await normalizeInlineStyleSerialization(page, '<div class="before" style="contain:content"></div>'),
      await normalizeInlineStyleSerialization(page, '<div class="after" style="contain: content;"></div>'),
      "non-style HTML differences remain strict",
    );

    assert.equal(
      await normalizeInlineStyleSerialization(page, '<pre style="--shiki-dark-bg:#24292e;--shiki-dark:#e1e4e8"></pre>'),
      await normalizeInlineStyleSerialization(page, '<pre style="--shiki-dark:#e1e4e8;--shiki-dark-bg:#24292e"></pre>'),
      "declaration order of distinct properties records style mutation history, not meaning",
    );
    assert.equal(
      await normalizeInlineStyleSerialization(page, '<code class="language-text" style="">x</code>'),
      await normalizeInlineStyleSerialization(page, '<code class="language-text">x</code>'),
      "an empty inline style is equivalent to no inline style",
    );
    assert.equal(
      await normalizeInlineStyleSerialization(page, '<code style="" class="language-text">x</code>'),
      await normalizeInlineStyleSerialization(page, '<code class="language-text">x</code>'),
      "removing a leading empty inline style leaves no stray whitespace",
    );

    const laterStyle = '<pre><code data-language="js" class="language-js" style="">x</code></pre>';
    const earlierStyle = '<pre><code style="" data-language="js" class="language-js">x</code></pre>';
    assert.equal(
      canonicalizeAttributeOrder(laterStyle),
      canonicalizeAttributeOrder(earlierStyle),
      "attribute order reflects DOM mutation history, not rendered meaning",
    );
    assert.equal(
      canonicalizeAttributeOrder(canonicalizeAttributeOrder(laterStyle)),
      canonicalizeAttributeOrder(laterStyle),
      "attribute ordering is idempotent",
    );
    assert.notEqual(
      canonicalizeAttributeOrder('<code class="a" data-x="1"></code>'),
      canonicalizeAttributeOrder('<code data-x="2" class="a"></code>'),
      "attribute values remain strict after ordering",
    );
    const attributeLikeText = '<div>b="1" a="2"</div>';
    assert.equal(canonicalizeAttributeOrder(attributeLikeText), attributeLikeText, "text content is byte-identical");
    const malformed = '<div b="1" a="2" a="3"></div>';
    assert.equal(canonicalizeAttributeOrder(malformed), malformed, "malformed HTML falls back to strict comparison");
  } finally {
    await page.close();
    await browser.close();
  }

  console.log("inline-style HTML normalization tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
