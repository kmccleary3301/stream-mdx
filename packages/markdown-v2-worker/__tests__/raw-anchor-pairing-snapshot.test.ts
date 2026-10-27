import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { createMarkdownSnapshotCompiler } from "@stream-mdx/worker/direct";

// KM's custom document plugin selects the snapshot's legacy nested-paragraph path.
// A no-op plugin reproduces that path without coupling worker tests to KM's application package.
const compiler = createMarkdownSnapshotCompiler({
  extensionId: "km-markdown-stream-mdx-1.1-v2",
  extensions: {
    documentPlugins: [{ name: "km-snapshot-extension-probe", process: () => {} }],
  },
});
const KM_INIT = {
  docPlugins: {
    tables: true,
    math: true,
    html: true,
    footnotes: true,
    callouts: "github-alerts",
    softBreaks: "preserve",
    codeHighlighting: "incremental",
    listIndentation: true,
  },
  themes: { light: "github-light", dark: "github-dark" },
  highlightEngine: "oniguruma",
  html: {
    mode: "sanitize",
    sanitization: {
      tagNames: ["a", "div", "p", "script"],
      attributes: { a: ["href"] },
      protocols: { href: ["http", "https"] },
    },
    unmatchedAnchors: "literal-bare",
    standaloneSvg: "code",
  },
  mathOptions: { singleDollar: "currency-safe" },
  linkDestinations: { windowsDrivePaths: "preserve" },
} as const;

async function renderDocument(source: string): Promise<Document> {
  const { blocks } = await compiler.compile({ text: source, init: KM_INIT });
  const markup = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks }));
  return new JSDOM(markup).window.document;
}

const listDocument = await renderDocument(
  '- **"From <A/>"** appears in the header.\n\n- **Tests:** cover inheritance.\n\nThe deferred move continues on B.\n\nSee <a href="https://example.com">the link</a>.',
);
const pairedParagraphTexts: Array<string | undefined> = [];
for (const closing of ["</a>  ", "<div>more</div>\n</a>"]) {
  const document = await renderDocument(`See <a>label\n\n${closing}\n\nfinish`);
  pairedParagraphTexts.push(document.querySelector("p")?.textContent);
}
const scriptDocument = await renderDocument("See <a>label<script><!-- </script> --></a>");
const scriptParagraphText = scriptDocument.querySelector("p")?.textContent;

assert.deepStrictEqual(
  {
    firstStrong: listDocument.querySelector("ul li strong")?.textContent,
    pairedParagraphTexts,
    scriptParagraphText,
  },
  {
    firstStrong: '"From <A/>"',
    pairedParagraphTexts: ["See label", "See label"],
    scriptParagraphText: "See label -->",
  },
);
