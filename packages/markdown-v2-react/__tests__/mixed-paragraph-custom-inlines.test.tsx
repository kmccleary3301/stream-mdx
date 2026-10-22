import assert from "node:assert/strict";
import { STREAM_MDX_SCHEMA_VERSION, type InlineNode, type WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { ComponentRegistry } from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

const SOURCE = "Use `$$` with <InlineComponent /> here";

function plainText(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => ("text" in node && typeof node.text === "string" ? node.text : "")).join("");
}

// A paragraph containing a component splits into mixed segments; custom paragraph renderers
// still receive the paragraph's full inline content, as on the base path.
async function customParagraphReceivesMixedParagraphInlines(): Promise<void> {
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
    registry.setBlockComponents({
      paragraph: ({ inlines }: { inlines: InlineNode[] }) => (
        <p data-inline-kinds={inlines.map((node) => node.kind).join(",")}>{plainText(inlines)}</p>
      ),
    });
    const markup = renderToStaticMarkup(<BlockNodeRenderer store={store} blockId={paragraph.id} registry={registry} />);
    assert.match(markup, /data-inline-kinds="[^"]*code[^"]*"/, "inline code reaches the custom paragraph");
    assert.match(markup, /Use \$\$ with &lt;InlineComponent \/&gt; here<\/p>/, "the whole paragraph text reaches the custom paragraph");
  } finally {
    engine.dispose();
  }
}

await customParagraphReceivesMixedParagraphInlines();
console.log("mixed-paragraph-custom-inlines test passed");
