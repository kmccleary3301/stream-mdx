import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBlocksRenderer, TrustedMdxServerRegionProvider } from "@stream-mdx/react/server";
import { compileTrustedMdxDocument } from "@stream-mdx/worker/mdx-compile";
import { compileMarkdownSnapshot } from "@stream-mdx/worker/node";
import { projectTrustedMdxServerDocument } from "../src/trusted-mdx/server";
import { installTrustedNativeTestDom } from "./trusted-native-fixture";

const source = [
  "",
  "<Preview codeblock>",
  "  <PreviewExample/>",
  "</Preview>",
  "```text",
  'const native = "exact";',
  "```",
  "",
  "Following native prose stays exact.",
  "",
  "",
  "",
  "<Preview>",
  "  <YouTube ",
  '    videoId="by9PUlqtJlM"',
  '    className="rounded-xl"',
  '    caption="A Test Video"',
  "  />",
  "</Preview>",
].join("\n");

const Preview: React.FC<React.PropsWithChildren> = ({ children }) => (
  <section data-preview="true">{children}</section>
);
const PreviewExample: React.FC = () => <aside data-preview-example="true">Native preview example</aside>;
const YouTube: React.FC<{ videoId: string; caption: string }> = ({ videoId, caption }) => (
  <figure data-video-id={videoId}><figcaption>{caption}</figcaption></figure>
);

const restoreDom = installTrustedNativeTestDom();
try {
  const [{ blocks }, artifact] = await Promise.all([
    compileMarkdownSnapshot({
      text: source,
      init: {
        contentPolicy: "trusted-mdx",
        docPlugins: { html: true, tables: true, math: true, mdx: true, footnotes: true, callouts: true, codeHighlighting: "final" },
      },
    }),
    compileTrustedMdxDocument(source),
  ]);
  const projection = await projectTrustedMdxServerDocument({
    source, blocks, artifact, components: { Preview, PreviewExample, YouTube },
  });
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <TrustedMdxServerRegionProvider regions={projection.regions}>
      <MarkdownBlocksRenderer blocks={blocks} />
    </TrustedMdxServerRegionProvider>,
  );
  const panels = Array.from(container.querySelectorAll("section[data-preview]"));
  assert.deepEqual(
    panels.map((panel) => Array.from(panel.children).map((child) => child.tagName)),
    [["ASIDE"], ["FIGURE"]],
    "nested whole-flow JSX renders once under its native wrapper, without stray paragraph wrappers",
  );
  assert.equal(panels[0]?.querySelector("[data-preview-example]")?.textContent, "Native preview example");
  assert.equal(panels[1]?.querySelector("figure")?.getAttribute("data-video-id"), "by9PUlqtJlM");
  assert.equal(panels[1]?.querySelector("figcaption")?.textContent, "A Test Video");
  const nativeCode = container.querySelectorAll("pre code");
  assert.equal(nativeCode.length, 1, "the adjacent native fence renders once outside its Preview owner");
  assert.equal(nativeCode[0]?.textContent, 'const native = "exact";');
  assert.equal(nativeCode[0]?.closest("section[data-preview]"), null, "the adjacent native fence does not become Preview children");
  const nativeProse = Array.from(container.querySelectorAll("p"))
    .filter((paragraph) => paragraph.textContent === "Following native prose stays exact.");
  assert.equal(nativeProse.length, 1, "following native prose renders exactly once");
  assert.equal(nativeProse[0]?.closest("section[data-preview]"), null, "following native prose stays outside its Preview owner");
  assert.equal(container.querySelectorAll("[data-preview-example]").length, 1);
  assert.equal(container.querySelectorAll("[data-video-id]").length, 1);
  console.log("trusted MDX nested whole-flow readonly consumer regression passed");
} finally {
  restoreDom();
}
