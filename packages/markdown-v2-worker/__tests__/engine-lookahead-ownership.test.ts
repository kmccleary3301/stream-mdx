import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import { JSDOM } from "jsdom";

import type { Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import type { RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { MarkdownEngine } from "../src/engine/engine";

import { projectConsumerBlocks } from "./consumer-block-projection";

function applyMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
    else if (message.type === "ERROR") assert.fail(`worker ${message.phase} failed: ${message.error.message}`);
  }
}

async function testNativeFenceTailConsumerOutput(): Promise<void> {
  for (const prefix of ["", "> ", "- "]) {
    const messages: WorkerOut[] = [];
    const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
    const store = createRendererStore();
    const continuation = prefix === "- " ? "  " : prefix;
    const raw = `${prefix}\`\`\`js\n${continuation}const x = 1;\n${continuation}\``;
    try {
      await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: raw, prewarmLangs: [] });
      applyMessages(store, messages.splice(0));
      const initialBlock = store.getBlocks().find((block) => block.payload.raw.includes("const x = 1;"));
      assert.ok(initialBlock, `expected cold export for code source under ${JSON.stringify(prefix)}`);
      assert.equal(initialBlock.payload.raw, raw, "cold export raw must preserve the authored fence source");
      const initialMarkup = projectConsumerBlocks([initialBlock])[0].markup;
      assert.ok(new JSDOM(initialMarkup).window.document.querySelector("pre code")?.textContent?.includes("const x = 1;"));

      await engine.handle({ type: "FINALIZE" });
      applyMessages(store, messages.splice(0));
      const finalizedBlock = store.getBlocks().find((block) => block.payload.raw.includes("const x = 1;"));
      assert.ok(finalizedBlock, "FINALIZE must retain the authored code block in the cold export");
      assert.equal(finalizedBlock.payload.raw, raw);
      assert.equal(finalizedBlock.isFinalized, true);
      const finalMarkup = projectConsumerBlocks([finalizedBlock])[0].markup;
      const renderedCode = new JSDOM(finalMarkup).window.document.querySelector("pre code");
      assert.equal(renderedCode?.textContent, "const x = 1;\n`", "FINALIZE must render the trailing authored fence character as code");
    } finally {
      engine.dispose();
    }
  }
}

await testNativeFenceTailConsumerOutput();
console.log("engine native fence consumer test passed");
