import assert from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { MixedContentSegment } from "@stream-mdx/core";
import { defaultBlockComponents } from "../src/components";

function renderParagraphFromSegments(segments: MixedContentSegment[]): string {
  const Paragraph = defaultBlockComponents.paragraph;
  const raw = segments.map((segment) => segment.value).join("");
  const element = React.createElement(Paragraph, {
    inlines: [],
    raw,
    meta: { mixedSegments: segments },
  });
  return renderToStaticMarkup(element);
}

function testBlockLevelHtmlSplitsParagraph(): void {
  const segments: MixedContentSegment[] = [
    {
      kind: "text",
      value: "Equation:",
      inline: [{ kind: "text", text: "Equation:" }],
    },
    {
      kind: "html",
      value: '<div class="katex-block-wrapper"><div class="katex-block">E = mc^2</div></div>',
      sanitized: '<div class="katex-block-wrapper"><div class="katex-block">E = mc^2</div></div>',
    },
  ];

  const html = renderParagraphFromSegments(segments);
  assert.ok(/<p class="markdown-paragraph">Equation:<\/p>/.test(html), "text segment should remain inside its own paragraph wrapper");
  assert.ok(/<div class="katex-block-wrapper">/.test(html), "wrapper div should render as sibling element");
  assert.ok(/<div class="katex-block">E = mc\^2<\/div>/.test(html), "inner KaTeX div should render");
  assert.ok(
    !/<p class="markdown-paragraph">[^<]*<div class="katex-block-wrapper">/.test(html),
    "block-level HTML must not be nested inside the paragraph element",
  );
}

function testKbdBacktickNormalization(): void {
  const segments: MixedContentSegment[] = [
    {
      kind: "text",
      value: "Press ",
      inline: [{ kind: "text", text: "Press " }],
    },
    {
      kind: "html",
      value: "<kbd>`Ctrl`</kbd>",
      sanitized: "<kbd>`Ctrl`</kbd>",
    },
    {
      kind: "text",
      value: " then ",
      inline: [{ kind: "text", text: " then " }],
    },
    {
      kind: "html",
      value: "<kbd>Enter</kbd>",
      sanitized: "<kbd>Enter</kbd>",
    },
  ];

  const html = renderParagraphFromSegments(segments);
  assert.ok(html.startsWith('<p class="markdown-paragraph">'), "paragraph should wrap inline content");
  assert.ok(/<kbd><code class="inline-code">Ctrl<\/code><\/kbd>/.test(html), "backtick content should render as code within kbd");
  const fallbackSpans = html.match(/<span class="markdown-inline-html">/g)?.length ?? 0;
  assert.ok(fallbackSpans <= 1, "only plain kbd segments may fall back to sanitized span");
  assert.ok(html.includes('<span class="markdown-inline-html"><kbd>Enter</kbd></span>'), "plain kbd fallback should preserve sanitized markup");
}

function testKbdWithoutBackticks(): void {
  const segments: MixedContentSegment[] = [
    {
      kind: "text",
      value: "Tap ",
      inline: [{ kind: "text", text: "Tap " }],
    },
    {
      kind: "html",
      value: "<kbd>Esc</kbd>",
      sanitized: "<kbd>Esc</kbd>",
    },
  ];

  const html = renderParagraphFromSegments(segments);
  assert.ok(html.includes("Tap "), "paragraph should include leading text");
  assert.ok(html.includes("<kbd>Esc</kbd>"), "plain kbd content should be preserved inside sanitized wrapper or element");
}

async function main() {
  testBlockLevelHtmlSplitsParagraph();
  testKbdBacktickNormalization();
  testKbdWithoutBackticks();
  console.log("inline-html-rendering tests passed");
}

await main();
