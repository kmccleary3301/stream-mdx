import assert from "node:assert/strict";
import { STREAM_MDX_SCHEMA_VERSION, type HtmlTreeNode, type InlineNode } from "@stream-mdx/core";
import { MarkdownEngine } from "../src/engine/index";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";

const source = "Reference [a][late]\n\n[late]: /a\n\nInline a *em* **strong** `code` [link](/path) [ref][late] [^note] <kbd>key</kbd> <sub>2</sub>\n[late]: /target\n[^note]: a\n\n> quote a\n> continuation";
const store = createRendererStore();
const engine = new MarkdownEngine({ post: (message) => {
  if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
  else if (message.type === "PATCH") store.applyPatches(message.patches);
  else if (message.type === "ERROR") throw new Error(message.error.message);
} });

function assertReference(reference: InlineNode | undefined): void {
  assert.ok(reference?.kind === "footnote-ref");
  assert.deepEqual(
    { label: reference.label, number: reference.number, occurrence: reference.occurrence },
    { label: "note", number: 1, occurrence: 1 },
    "a re-extracted HTML paragraph must retain its reference number and occurrence",
  );
}

async function main(): Promise<void> {
  try {
    for (const boundaries of [[20, 21, 32, 33, 127, 143, 154, 155, 165, source.length], Array.from({ length: source.length }, (_, index) => index + 1)]) {
      await engine.handle({
        type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "", prewarmLangs: [],
        docPlugins: { footnotes: true, html: true, mdx: false, tables: true, codeHighlighting: "none" },
      });
      let from = 0;
      for (const to of boundaries) {
        await engine.handle({ type: "APPEND", text: source.slice(from, to) });
        from = to;
      }
      const paragraph = store.getBlocks().find((block) => block.payload.raw.startsWith("Inline a"));
      assert.ok(paragraph);
      assertReference(paragraph.payload.inline?.find((node) => node.kind === "footnote-ref"));
      const tree = paragraph.payload.meta?.htmlParagraphTree as HtmlTreeNode[] | undefined;
      const htmlParagraph = tree?.find((node) => node.kind === "element" && node.paragraphRoot);
      assert.ok(htmlParagraph?.kind === "element");
      const preparedReference = htmlParagraph.children.find((node) => node.kind === "element" && node.inlineNode?.kind === "footnote-ref");
      assert.ok(preparedReference?.kind === "element");
      assertReference(preparedReference.inlineNode);
      await engine.handle({ type: "FINALIZE" });
      const finalParagraph = store.getBlocks().find((block) => block.payload.raw.startsWith("Inline a"));
      assertReference(finalParagraph?.payload.inline?.find((node) => node.kind === "footnote-ref"));
    }
    console.log("native HTML footnote streaming test passed");
  } finally {
    engine.dispose();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
