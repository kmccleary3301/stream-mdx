import assert from "node:assert";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { MarkdownEngine } from "../src/engine/engine";

// Info-less and explicit `text` fences resolve to the same Shiki grammar and share the
// process-wide highlight cache, but only the authored info string may add a language class.
async function highlightedCode(source: string): Promise<string> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (msg) => messages.push(msg) });
  await engine.handle({
    type: "INIT",
    initialContent: source,
    docPlugins: { codeHighlighting: "final", outputMode: "html", lazyTokenization: { enabled: false } },
  });
  await engine.handle({ type: "FINALIZE" });
  engine.dispose();
  const store = createRendererStore();
  for (const msg of messages) {
    if (msg.type === "INITIALIZED") store.reset(msg.blocks);
    else if (msg.type === "PATCH") store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
  }
  const block = store.getBlocks().find((b: Block) => b.type === "code");
  assert.ok(block?.payload.highlightedHtml, `expected highlighted code for ${JSON.stringify(source)}`);
  return block.payload.highlightedHtml;
}

const body = "shared cache body\n";
const labeled = await highlightedCode(`\`\`\`text\n${body}\`\`\`\n`);
const bare = await highlightedCode(`\`\`\`\n${body}\`\`\`\n`);
const labeledAgain = await highlightedCode(`\`\`\`text\n${body}\`\`\`\n`);

assert.ok(labeled.includes("language-text"), "explicit text fence keeps its language class");
assert.ok(!bare.includes("language-"), "info-less fence must not inherit a cached language class");
assert.ok(!bare.includes("data-language"), "info-less fence has no data-language");
assert.strictEqual(labeledAgain, labeled, "cached explicit fence renders identically");
console.log("code language class cache test passed");
