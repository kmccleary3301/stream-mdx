import assert from "node:assert";

import type { Block, WorkerOut } from "@stream-mdx/core";
import { createWorkerHarness } from "./worker-test-harness";

function extractHeadingMeta(blocks: ReadonlyArray<Block>): Array<{ id: string; text: string; level: number }> {
  return blocks
    .filter((block) => block.type === "heading")
    .map((block) => {
      const meta = (block.payload.meta ?? {}) as Record<string, unknown>;
      return {
        id: typeof meta.headingId === "string" ? meta.headingId : "",
        text: typeof meta.headingText === "string" ? meta.headingText : "",
        level: typeof meta.headingLevel === "number" ? meta.headingLevel : 0,
      };
    });
}

function getDump(messages: WorkerOut[]): Extract<WorkerOut, { type: "DUMP_BLOCKS" }> {
  const dump = messages.find((message): message is Extract<WorkerOut, { type: "DUMP_BLOCKS" }> => message.type === "DUMP_BLOCKS");
  assert.ok(dump, "expected DUMP_BLOCKS response");
  return dump;
}

async function run(): Promise<void> {
  const harness = await createWorkerHarness();
  const initialContent = ["# Alpha", "", "## Beta", "", "### Gamma"].join("\n");

  await harness.send({
    type: "INIT",
    initialContent,
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true },
  });

  const firstDump = getDump(await harness.send({ type: "DUMP_BLOCKS" }));
  const baseline = extractHeadingMeta(firstDump.blocks);
  assert.ok(baseline.length >= 3, "expected heading blocks in baseline");

  const secondDump = getDump(await harness.send({ type: "DUMP_BLOCKS" }));
  assert.deepStrictEqual(
    extractHeadingMeta(secondDump.blocks),
    baseline,
    "repeated TOC/block snapshots should not mutate heading metadata",
  );

  await harness.send({ type: "APPEND", text: "\n\nTrailing paragraph." });
  await harness.send({ type: "FINALIZE" });

  const afterAppendDump = getDump(await harness.send({ type: "DUMP_BLOCKS" }));
  const afterAppend = extractHeadingMeta(afterAppendDump.blocks);
  assert.deepStrictEqual(
    afterAppend,
    baseline,
    "rebuilding TOC for non-heading updates should not retroactively mutate heading ids/text/levels",
  );
}

await run();
console.log("worker toc purity test passed");
