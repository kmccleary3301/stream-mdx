import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyPatchBatch, createInitialSnapshot } from "@stream-mdx/core";
import type { Block } from "@stream-mdx/core";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import type { RendererStore } from "@stream-mdx/react/renderer/store";
import { MarkdownEngine } from "../src/engine/engine";

const inputs = [
  "> Quote with ref[^a].\n\n[^a]: Note.\n",
  "- item\n\n  ```ts\n  const a = 1;\n  const b = 2;\n  ```\n\nafter\n",
  "> - one\n> - two\n>\n> para\n",
] as const;

function splitEvery(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) chunks.push(text.slice(offset, offset + size));
  return chunks;
}

function render(blocks: Block[], store: RendererStore): string {
  return renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks, store }));
}

async function runCase(markdown: string, chunks: string[], label: string): Promise<void> {
  const store = createRendererStore();
  let document = createInitialSnapshot();
  const engine = new MarkdownEngine({
    post(message) {
      if (message.type === "INITIALIZED") {
        document = createInitialSnapshot(message.snapshot);
        store.resetSnapshot(message.snapshot);
      } else if (message.type === "PATCH") {
        applyPatchBatch(document, message.patches);
        store.applyPatches(message.patches, { captureMetrics: false });
      } else if (message.type === "ERROR") {
        throw new Error(`${message.phase}: ${message.error.message}`);
      }
      const coreBlocks = document.getBlocks();
      const reactBlocks = store.getBlocks();
      assert.deepStrictEqual(
        coreBlocks,
        reactBlocks,
        `${label} after ${message.type}: core and React cold exports must agree`,
      );
    },
  });

  try {
    await engine.handle({
      type: "INIT",
      schemaVersion: STREAM_MDX_SCHEMA_VERSION,
      initialContent: "",
      prewarmLangs: [],
      docPlugins: {
        html: true,
        mdx: true,
        math: true,
        tables: true,
        footnotes: true,
        callouts: true,
        codeHighlighting: "incremental",
      },
    });
    for (const chunk of chunks) await engine.handle({ type: "APPEND", text: chunk });
    await engine.handle({ type: "FINALIZE" });

    const liveBlocks = store.getBlocks();
    const coldStore = createRendererStore(JSON.parse(JSON.stringify(liveBlocks)) as Block[]);
    assert.equal(
      render(coldStore.getBlocks(), coldStore),
      render(liveBlocks, store),
      `${label}: JSON-reset export must render the same static markup as the live store`,
    );
  } finally {
    engine.dispose();
  }
}

for (const [index, markdown] of inputs.entries()) {
  await runCase(markdown, splitEvery(markdown, 3), `input ${index + 1}, 3-character chunks`);
  await runCase(markdown, [markdown], `input ${index + 1}, whole input`);
}

console.log("cold-export parity test passed");
