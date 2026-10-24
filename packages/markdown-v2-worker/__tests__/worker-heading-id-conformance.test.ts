import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";

import type { Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

const DOC_PLUGINS = {
  footnotes: true,
  html: true,
  mdx: true,
  tables: true,
  callouts: true,
  math: true,
};

type ConsumerHeading = { id: unknown; text: unknown; level: unknown };

function splitBySizes(text: string, sizes: number[]): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  for (const size of sizes) {
    if (cursor >= text.length) break;
    const take = Math.max(0, Math.min(size, text.length - cursor));
    if (take === 0) continue;
    chunks.push(text.slice(cursor, cursor + take));
    cursor += take;
  }
  if (cursor < text.length) {
    chunks.push(text.slice(cursor));
  }
  return chunks;
}

// Heading ids as a consumer renders them: the finalized store's heading blocks.
async function collectTocForChunks(chunks: string[]): Promise<ConsumerHeading[]> {
  assert.ok(chunks.length > 0, "expected at least one chunk");
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const apply = (messages: WorkerOut[]): void => {
    for (const message of messages) {
      if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
      else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
    }
  };

  apply(await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: chunks[0],
  prewarmLangs: [],
  docPlugins: DOC_PLUGINS, }));

  for (const chunk of chunks.slice(1)) {
    apply(await harness.send({ type: "APPEND", text: chunk }));
  }

  apply(await harness.send({ type: "FINALIZE" }));
  return store.getBlocks()
    .filter((block) => block.type === "heading")
    .map((block) => ({ id: block.payload.meta?.headingId, text: block.payload.meta?.headingText, level: block.payload.meta?.headingLevel }));
}

async function runHeadingIdConformanceTest(): Promise<void> {
  const text = [
    "# Hello, World!",
    "",
    "## `Code` + API",
    "",
    "### Résumé / naïve",
    "",
    "### Résumé / naïve",
    "",
    "#### 100% Ready?",
    "",
    "#### 100% Ready?",
  ].join("\n");

  const toc = await collectTocForChunks([text]);
  assert.deepStrictEqual(
    toc.map((heading) => ({ id: heading.id, level: heading.level })),
    [
      { id: "hello-world", level: 1 },
      { id: "code-api", level: 2 },
      { id: "r-sum-na-ve", level: 3 },
      { id: "r-sum-na-ve-2", level: 3 },
      { id: "100-ready", level: 4 },
      { id: "100-ready-2", level: 4 },
    ],
    "heading IDs should follow deterministic slug/collision policy",
  );
}

async function runChunkingInvariantTest(): Promise<void> {
  const text = [
    "# Title",
    "",
    "## Repeat",
    "",
    "## Repeat",
    "",
    "## Repeat",
    "",
    "### `Inline` + punctuation?!",
    "",
    "### `Inline` + punctuation?!",
  ].join("\n");

  const baseline = await collectTocForChunks([text]);

  const chunkedA = await collectTocForChunks(splitBySizes(text, [7, 11, 3, 19, 2, 5]));
  assert.deepStrictEqual(
    chunkedA.map((heading) => ({ id: heading.id, text: heading.text, level: heading.level })),
    baseline.map((heading) => ({ id: heading.id, text: heading.text, level: heading.level })),
    "toc headings should be stable across uneven chunk sizes",
  );

  const oneCharChunks = await collectTocForChunks(splitBySizes(text, new Array(text.length).fill(1)));
  assert.deepStrictEqual(
    oneCharChunks.map((heading) => ({ id: heading.id, text: heading.text, level: heading.level })),
    baseline.map((heading) => ({ id: heading.id, text: heading.text, level: heading.level })),
    "toc headings should be stable with one-character streaming chunks",
  );

  // A closing root fence resumes parsing after it; earlier headings still count toward collisions.
  const afterFence = ["## Lists", "", "```text", "code", "```", "", "# Lists"].join("\n");
  const afterFenceBaseline = await collectTocForChunks([afterFence]);
  assert.deepStrictEqual(afterFenceBaseline.map((heading) => heading.id), ["lists", "lists-2"]);
  for (const size of [1, 4, 9]) {
    assert.deepStrictEqual(
      await collectTocForChunks(splitBySizes(afterFence, new Array(Math.ceil(afterFence.length / size)).fill(size))),
      afterFenceBaseline,
      `heading ids after a closed root fence must match single-shot with chunk size ${size}`,
    );
  }
}

await runHeadingIdConformanceTest();
await runChunkingInvariantTest();
console.log("worker heading id conformance test passed");
