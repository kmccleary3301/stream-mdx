import assert from "node:assert";

import type { TocHeading, WorkerOut } from "@stream-mdx/core";
import { createWorkerHarness } from "./worker-test-harness";

const DOC_PLUGINS = {
  footnotes: true,
  html: true,
  mdx: true,
  tables: true,
  callouts: true,
  math: true,
};

function extractTocFromDump(messages: WorkerOut[]): TocHeading[] {
  const dump = messages.find((message): message is Extract<WorkerOut, { type: "DUMP_BLOCKS" }> => message.type === "DUMP_BLOCKS");
  return dump?.tocHeadings ?? [];
}

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

async function collectTocForChunks(chunks: string[]): Promise<TocHeading[]> {
  assert.ok(chunks.length > 0, "expected at least one chunk");
  const harness = await createWorkerHarness();

  await harness.send({
    type: "INIT",
    initialContent: chunks[0],
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
  });

  for (const chunk of chunks.slice(1)) {
    await harness.send({ type: "APPEND", text: chunk });
  }

  await harness.send({ type: "FINALIZE" });
  const dumpMessages = await harness.send({ type: "DUMP_BLOCKS" });
  return extractTocFromDump(dumpMessages);
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
}

await runHeadingIdConformanceTest();
await runChunkingInvariantTest();
console.log("worker heading id conformance test passed");
