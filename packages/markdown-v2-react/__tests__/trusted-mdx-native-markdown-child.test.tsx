import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBlocksRenderer, TrustedMdxServerRegionProvider } from "@stream-mdx/react/server";
import { compileTrustedMdxDocument } from "@stream-mdx/worker/mdx-compile";
import { compileMarkdownSnapshot } from "@stream-mdx/worker/node";
import { projectTrustedMdxServerDocument } from "../src/trusted-mdx/server";
import { installTrustedNativeTestDom } from "./trusted-native-fixture";

// Uses the article's div+footnote and nested JSX shapes; rich phrasing guards native preparation.
const source = [
  "<div>The invention of the printing press revolutionized the spread of information in Europe during the 15th century.[^2]</div>",
  "",
  "[^2]: Johannes Gutenberg is credited with inventing the movable-type printing press around 1440 in Mainz, Germany.",
  "",
  "<div>",
  "    <h1>Heading 1</h1>",
  "    <div/>",
  "    <h2>Heading 2</h2>",
  "    <h3>  **rich** `x{1 + 2}` [safe](https://example.com/native) <em>native</em> {1 + 2}  </h3>",
  "  </div>",
].join("\n");

const restoreDom = installTrustedNativeTestDom();
try {
  const [{ blocks }, artifact] = await Promise.all([
    compileMarkdownSnapshot({
      text: source,
      init: {
        contentPolicy: "trusted-mdx",
        docPlugins: {
          html: true,
          tables: true,
          math: true,
          mdx: true,
          footnotes: true,
          callouts: true,
          codeHighlighting: "final",
        },
      },
    }),
    compileTrustedMdxDocument(source),
  ]);
  const projection = await projectTrustedMdxServerDocument({ source, blocks, artifact });
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <TrustedMdxServerRegionProvider regions={projection.regions}>
      <MarkdownBlocksRenderer blocks={blocks} />
    </TrustedMdxServerRegionProvider>,
  );

  const articleFlow = container.querySelector("div");
  assert.ok(articleFlow);
  assert.equal(articleFlow.querySelectorAll(".footnote-ref a").length, 1);
  const reference = articleFlow.querySelector(".footnote-ref a");
  assert.ok(reference);
  assert.equal(reference.getAttribute("href"), "#fn:1");
  assert.equal(reference.id, "fnref:1");
  const footnote = container.querySelector(".footnotes li");
  assert.ok(footnote);
  assert.equal(footnote.id, "fn:1");
  const backlinks = footnote.querySelectorAll(".footnote-backref");
  assert.equal(backlinks.length, 1);
  assert.equal(backlinks[0]?.getAttribute("href"), "#fnref:1");

  const headings = Array.from(container.querySelectorAll("h1, h2"));
  assert.deepEqual(
    headings.map((heading) => [heading.tagName.toLowerCase(), heading.textContent]),
    [["h1", "Heading 1"], ["h2", "Heading 2"]],
    "nested authored Markdown children render once inside their native JSX headings",
  );
  assert.equal(container.querySelector("h1 p, h2 p, h3 p"), null, "authored inline heading children do not gain invalid paragraph wrappers");
  const rich = container.querySelector("h3");
  assert.ok(rich);
  assert.equal(rich.querySelector("strong")?.textContent, "rich");
  assert.equal(rich.querySelector("code")?.textContent, "x{1 + 2}");
  assert.equal(rich.querySelector("a")?.getAttribute("href"), "https://example.com/native");
  assert.equal(rich.querySelector("em")?.textContent, "native");
  assert.equal(rich.textContent, "  rich x{1 + 2} safe native 3  ", "native inline whitespace, literal code and trusted expression meaning are preserved");
  console.log("trusted MDX nested Markdown child readonly consumer regression passed");
} finally {
  restoreDom();
}
