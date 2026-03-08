import assert from "node:assert";

import type { TocHeading, WorkerOut } from "@stream-mdx/core";
import { createWorkerHarness } from "./worker-test-harness";

function getToc(messages: WorkerOut[]): TocHeading[] {
  const dump = messages.find((message): message is Extract<WorkerOut, { type: "DUMP_BLOCKS" }> => message.type === "DUMP_BLOCKS");
  assert.ok(dump, "expected DUMP_BLOCKS response");
  return dump.tocHeadings ?? [];
}

async function collectToc(content: string): Promise<Array<{ id: string; text: string; level: number }>> {
  const harness = await createWorkerHarness();
  await harness.send({
    type: "INIT",
    initialContent: content,
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true },
  });
  await harness.send({ type: "FINALIZE" });
  const dump = await harness.send({ type: "DUMP_BLOCKS" });
  return getToc(dump).map((heading) => ({ id: heading.id, text: heading.text, level: heading.level }));
}

async function run(): Promise<void> {
  const content = [
    "# Root",
    "",
    "## Alpha",
    "",
    "## Alpha",
    "",
    "### `Code` + API",
    "",
    "### `Code` + API",
    "",
    "### Résumé / naïve",
    "",
    "### Résumé / naïve",
  ].join("\n");

  const baseline = await collectToc(content);
  assert.ok(baseline.length > 0, "expected toc headings in baseline");

  for (let i = 0; i < 20; i += 1) {
    const current = await collectToc(content);
    assert.deepStrictEqual(current, baseline, `toc heading ids should be repeatable (run ${i + 1})`);
  }
}

await run();
console.log("worker toc repeatability test passed");
