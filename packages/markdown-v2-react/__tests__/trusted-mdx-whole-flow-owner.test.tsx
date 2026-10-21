import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { MarkdownBlocksRenderer, TrustedMdxServerRegionProvider } from "@stream-mdx/react/server";
import { compileTrustedMdxDocument } from "@stream-mdx/worker/mdx-compile";
import { compileMarkdownSnapshot } from "@stream-mdx/worker/node";
import { MarkdownEngine } from "../../markdown-v2-worker/src/engine/engine";
import { createRendererStore } from "../src/renderer/store";
import { projectTrustedMdxServerDocument } from "../src/trusted-mdx/server";
import { installTrustedNativeTestDom } from "./trusted-native-fixture";

const previewRoot = [
  "<Preview codeblock>",
  "  ### Native preview heading",
  "  Native preview body paragraph.",
  "  <PreviewExample/>",
  "</Preview>",
].join("\n");
const followingNative = [
  "```text",
  'const native = "exact";',
  "```",
  "",
  "Following native prose stays exact.",
].join("\n");
const lifecycleSource = `${previewRoot}\n${followingNative}`;
const source = [
  lifecycleSource,
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
async function compileAppendSnapshot(): Promise<Block[]> {
  const messages: WorkerOut[] = [];
  const store = createRendererStore();
  const engine = new MarkdownEngine({
    post(message) {
      messages.push(message);
      if (message.type === "INITIALIZED") store.reset(message.blocks);
      else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
    },
  });

  try {
    await engine.handle({
      type: "INIT",
      initialContent: "",
      prewarmLangs: [],
      contentPolicy: "trusted-mdx",
      docPlugins: { html: true, tables: true, math: true, mdx: true, footnotes: true, callouts: true, codeHighlighting: "final" },
    });
    await engine.handle({ type: "APPEND", text: previewRoot });
    const provisionalPreview = store.getBlocks().find((block) => block.payload.raw?.includes("<Preview codeblock>"));
    assert.ok(provisionalPreview, "the first APPEND exposes the complete but still-provisional Preview root");
    assert.equal(provisionalPreview.isFinalized, false);

    await engine.handle({ type: "APPEND", text: `\n${followingNative}` });
    assert.equal(messages.some((message) => message.type === "FINALIZED"), false, "APPEND must not finalize the document");
    assert.equal(messages.some((message) => message.type === "ERROR"), false, "both APPENDs must succeed");
    return [...store.getBlocks()];
  } finally {
    engine.dispose();
  }
}


const restoreDom = installTrustedNativeTestDom();
try {
  const appendBlocks = await compileAppendSnapshot();
  const appendArtifact = await compileTrustedMdxDocument(lifecycleSource);
  const appendProjection = await projectTrustedMdxServerDocument({
    source: lifecycleSource,
    blocks: appendBlocks,
    artifact: appendArtifact,
    components: { Preview, PreviewExample },
  });
  const appendContainer = document.createElement("div");
  appendContainer.innerHTML = renderToStaticMarkup(
    <TrustedMdxServerRegionProvider regions={appendProjection.regions}>
      <MarkdownBlocksRenderer blocks={appendBlocks} />
    </TrustedMdxServerRegionProvider>,
  );
  const appendPreview = appendContainer.querySelector("section[data-preview]");
  assert.ok(appendPreview, "the completed Preview renders before document FINALIZE");
  assert.equal(appendPreview.querySelector("h3")?.textContent, "Native preview heading");
  assert.equal(appendPreview.querySelector("p")?.textContent, "Native preview body paragraph.");
  assert.equal(appendPreview.querySelector("[data-preview-example]")?.textContent, "Native preview example");
  const appendNativeCode = Array.from(appendContainer.querySelectorAll("pre code"))
    .filter((code) => code.textContent === 'const native = "exact";');
  assert.equal(appendNativeCode.length, 1, "the following native fence renders once before FINALIZE");
  assert.equal(appendNativeCode[0]?.closest("section[data-preview]"), null);
  const appendNativeProse = Array.from(appendContainer.querySelectorAll("p"))
    .filter((paragraph) => paragraph.textContent === "Following native prose stays exact.");
  assert.equal(appendNativeProse.length, 1, "following native prose renders once before FINALIZE");
  assert.equal(appendNativeProse[0]?.closest("section[data-preview]"), null);

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
  assert.equal(panels.length, 2);
  assert.equal(panels[0]?.querySelector("h3")?.textContent, "Native preview heading");
  assert.equal(panels[0]?.querySelector("p")?.textContent, "Native preview body paragraph.");
  assert.equal(panels[0]?.querySelector("[data-preview-example]")?.textContent, "Native preview example");
  assert.equal(panels[1]?.querySelector("figure")?.getAttribute("data-video-id"), "by9PUlqtJlM");
  assert.equal(panels[1]?.querySelector("figcaption")?.textContent, "A Test Video");
  const nativeCode = Array.from(container.querySelectorAll("pre code"))
    .filter((code) => code.textContent === 'const native = "exact";');
  assert.equal(nativeCode.length, 1, "the adjacent native fence renders once outside its Preview owner");
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
