import assert from "node:assert";
import type { Patch, TocHeading, WorkerOut } from "@stream-mdx/core";
import { PATCH_ROOT_ID } from "@stream-mdx/core";
import { createWorkerHarness } from "./worker-test-harness";

async function runTocHeadingsTest(): Promise<void> {
  const harness = await createWorkerHarness();

  const content = ["# Hello", "", "## Hello", "", "### World"].join("\n");
  const initMessages = await harness.send({
    type: "INIT",
    initialContent: content,
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  });

  const patchMessages = initMessages.filter((m): m is Extract<WorkerOut, { type: "PATCH" }> => m.type === "PATCH");
  assert.ok(patchMessages.length > 0, "expected PATCH messages during INIT");

  const patches = patchMessages.flatMap((msg) => msg.patches as Patch[]);
  const tocPatch = patches.find(
    (patch) => patch.op === "setProps" && patch.at?.blockId === PATCH_ROOT_ID && patch.props && Object.prototype.hasOwnProperty.call(patch.props, "tocHeadings"),
  ) as Extract<Patch, { op: "setProps" }> | undefined;

  assert.ok(tocPatch, "expected setProps patch with tocHeadings");

  const tocHeadings = (tocPatch.props as { tocHeadings?: TocHeading[] }).tocHeadings ?? [];
  assert.deepStrictEqual(
    tocHeadings.map((heading) => ({ id: heading.id, text: heading.text, level: heading.level })),
    [
      { id: "hello", text: "Hello", level: 1 },
      { id: "hello-2", text: "Hello", level: 2 },
      { id: "world", text: "World", level: 3 },
    ],
    "tocHeadings should include stable slug ids and levels",
  );
}

await runTocHeadingsTest();
console.log("Worker toc headings test passed");
