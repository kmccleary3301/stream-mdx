import assert from "node:assert/strict";
import { STREAM_MDX_SCHEMA_VERSION, type WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const SOURCE = "Use `$$` with <InlineComponent /> here";


// A mixed paragraph's presentation wrapper can read its finalized authored source
// while preserving the native inline view as its child.
async function customParagraphReceivesMixedParagraphSource(): Promise<void> {
  const store = createRendererStore();
  const engine = new MarkdownEngine({
    post: (message: WorkerOut) => {
      if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
      else if (message.type === "PATCH") store.applyPatches(message.patches);
    },
  });
  try {
    await engine.handle({
      type: "INIT",
      schemaVersion: STREAM_MDX_SCHEMA_VERSION,
      initialContent: "",
      prewarmLangs: [],
      docPlugins: { html: true, mdx: true },
    });
    await engine.handle({ type: "APPEND", text: SOURCE });
    await engine.handle({ type: "FINALIZE" });

    const paragraph = store.getBlocks().find((block) => block.type === "paragraph");
    assert.ok(paragraph, "the mixed paragraph is published");
    assert.ok(Array.isArray(paragraph.payload.meta?.mixedSegments), "the paragraph carries mixed segments");

    const registry = new ComponentRegistry();
    registry.setNodePresentations({
      paragraph: {
        wrapper: ({ actions, children }) => (
          <div data-source={actions.readSource()}>
            {children}
          </div>
        ),
      },
    });
    const markup = renderToStaticMarkup(<BlockNodeRenderer store={store} blockId={paragraph.id} registry={registry} />);
    const dom = new JSDOM(markup);
    assert.equal(
      dom.window.document.querySelector("[data-source]")?.getAttribute("data-source"),
      SOURCE,
      "the custom paragraph receives the complete authored source",
    );
    assert.equal(dom.window.document.body.textContent, "Use $$ with <InlineComponent /> here", "the whole paragraph text reaches the custom presentation");
    dom.window.close();
  } finally {
    engine.dispose();
  }
}

await customParagraphReceivesMixedParagraphSource();
console.log("mixed-paragraph-custom-inlines test passed");
