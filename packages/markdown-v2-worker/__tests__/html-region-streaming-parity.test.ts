import assert from "node:assert";

import { STREAM_MDX_SCHEMA_VERSION, type ContentPolicy, type WorkerOut, type WorkerIn } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness, projectConsumerBlocks, type WorkerHarness } from "./worker-test-harness";

// An HTML region opened by an unclosed tag can be closed by a later block. Every append boundary must
// produce the blocks of a single-shot parse: the region may not split, drop, or duplicate its members.
const DOCUMENTS: ReadonlyArray<{
  readonly name: string;
  readonly source: string;
  readonly contentPolicy: ContentPolicy;
  readonly contentComponents?: Extract<WorkerIn, { type: "INIT" }>["contentComponents"];
}> = [
  {
    name: "closer as its own HTML block after a list",
    source: "Plain para.\n\n<section>\nlead:\n\n1. a\n2. b\n</section>\n\nafter\n",
    contentPolicy: "markdown",
  },
  {
    name: "closer lazily continuing the last list item",
    source: "Plain para.\n\n<Preview codeblock>\nlead:\n\n1. a\n2. b\n</Preview>\n\nafter\n",
    contentPolicy: "markdown",
  },
  {
    name: "closer after a paragraph",
    source: "Intro.\n\n<div>\n\nInside paragraph.\n\n</div>\n\nafter\n",
    contentPolicy: "markdown",
  },
  // "</P" alone opens an HTML block that interrupts the preceding block; "</Pre>" does not, so the interruption seen
  // at an append boundary inside that line is provisional.
  {
    name: "partial last line that briefly interrupts a list",
    source: "Plain para.\n\n1. a\n2. b\n</Pre>\n\nafter\n",
    contentPolicy: "markdown",
  },
  {
    name: "partial last line that briefly interrupts a paragraph",
    source: "Intro.\n\ntext line\n</Pre>\n\nafter\n",
    contentPolicy: "markdown",
  },
  {
    name: "partial last line that briefly interrupts a blockquote",
    source: "Intro.\n\n> quoted\n</Pre>\n\nafter\n",
    contentPolicy: "markdown",
  },
  {
    name: "restricted Preview wrapping a list",
    source: "Plain para.\n\n<Preview>\n\n1. a\n2. b\n</Preview>\n\nafter\n",
    contentPolicy: "restricted",
    contentComponents: [{ name: "Preview", renderWhen: "open" }],
  },
  {
    name: "trusted-mdx details wrapping a blockquote",
    source: "<details>\n\n> quote\n</details>\n\n",
    contentPolicy: "trusted-mdx",
  },
];

async function finalBlocks(
  harness: WorkerHarness,
  chunks: readonly string[],
  contentPolicy: ContentPolicy,
  contentComponents?: Extract<WorkerIn, { type: "INIT" }>["contentComponents"],
): Promise<unknown[]> {
  const store = createRendererStore();
  const apply = (messages: WorkerOut[]) => {
    for (const message of messages) {
      if (message.type === "ERROR") assert.fail(`Worker error during ${message.phase}: ${message.error.message}`);
      if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
      else if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
    }
  };
  apply(await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    contentPolicy,
    docPlugins: { footnotes: true, html: true, mdx: true, math: true, tables: true, callouts: true },
    contentComponents,
  }));
  for (const chunk of chunks) apply(await harness.send({ type: "APPEND", text: chunk }));
  apply(await harness.send({ type: "FINALIZE" }));
  return projectConsumerBlocks(store.getBlocks());
}

const harness = await createWorkerHarness();
for (const document of DOCUMENTS) {
  const expected = await finalBlocks(harness, [document.source], document.contentPolicy, document.contentComponents);
  for (let cut = 1; cut < document.source.length; cut += 1) {
    const streamed = await finalBlocks(
      harness,
      [document.source.slice(0, cut), document.source.slice(cut)],
      document.contentPolicy,
      document.contentComponents,
    );
    assert.deepStrictEqual(
      streamed,
      expected,
      `${document.name}: append boundary after ${JSON.stringify(document.source.slice(0, cut))} changed the final blocks`,
    );
  }
}

console.log("html-region streaming parity test passed");
