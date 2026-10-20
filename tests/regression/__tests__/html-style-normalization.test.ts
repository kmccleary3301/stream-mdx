import assert from "node:assert/strict";

import { chromium } from "@playwright/test";

import { normalizeInlineStyleSerialization } from "../../../scripts/regression/html-style-normalization";

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
