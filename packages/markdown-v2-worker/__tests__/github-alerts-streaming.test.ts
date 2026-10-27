import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STREAM_MDX_SCHEMA_VERSION, type Block, type Patch, type WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

const fixture = readFileSync(new URL("./fixtures/github-alerts.md", import.meta.url), "utf8");

async function parse(chunks: readonly string[]): Promise<Block[]> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initialized = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { callouts: "github-alerts" },
  });
  const init = initialized.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(init, "worker emitted INITIALIZED");
  store.resetSnapshot(init.snapshot);

  const apply = (messages: readonly WorkerOut[]) => {
    for (const message of messages) {
      if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
    }
  };
  for (const chunk of chunks) apply(await harness.send({ type: "APPEND", text: chunk }));
  apply(await harness.send({ type: "FINALIZE" }));
  return store.getBlocks();
}

function semanticProjection(blocks: readonly Block[]): unknown[] {
  return blocks.map((block) => ({
    type: block.type,
    raw: block.payload.raw,
    range: block.payload.range,
    calloutKind: block.payload.meta?.calloutKind,
    inline: block.payload.inline,
  }));
}

function chunkStream(source: string): string[] {
  const sizes = [1, 1, 1, 2, 3, 5, 8, 13] as const;
  const chunks: string[] = [];
  let offset = 0;
  let sizeIndex = 0;
  while (offset < source.length) {
    const end = Math.min(source.length, offset + sizes[sizeIndex % sizes.length]!);
    chunks.push(source.slice(offset, end));
    offset = end;
    sizeIndex += 1;
  }
  return chunks;
}

const source = `😀\r\n${fixture.replace(/\n/g, "\r\n")}`;
const oneShotBlocks = await parse([source]);
const everySplitPatternBlocks = await parse(chunkStream(source));
assert.deepEqual(semanticProjection(everySplitPatternBlocks), semanticProjection(oneShotBlocks));

const alerts = oneShotBlocks.filter((block) => block.payload.meta?.calloutKind !== undefined);
assert.deepEqual(alerts.map((block) => block.payload.meta?.calloutKind), ["note", "tip", "important", "warning", "caution"]);
assert.ok(alerts.every((block) => !JSON.stringify(block.payload.inline ?? []).includes("[!")), "recognized marker lines are removed from the prepared body");
assert.deepEqual(
  oneShotBlocks.filter((block) => block.type === "blockquote").map((block) => block.payload.meta?.calloutKind),
  [undefined, undefined],
  "same-line text and unknown markers remain ordinary blockquotes",
);
console.log("GitHub alert streaming parity checks passed");
