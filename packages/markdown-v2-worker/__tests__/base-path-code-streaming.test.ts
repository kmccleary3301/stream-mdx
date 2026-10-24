import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import type { Patch, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import type { RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { micromark } from "micromark";
import { createWorkerHarness } from "./worker-test-harness";

// Registered components decline native ownership, so fences stream through the base block path.
const restricted = {
  contentPolicy: "restricted",
  contentComponents: [{ name: "Card", renderWhen: "open" }],
} as const;

const cases: ReadonlyArray<{ name: string; source: string; init?: Partial<Extract<WorkerIn, { type: "INIT" }>> }> = [
  { name: "restricted fence", source: "```\naaa\nbbb\n```\n\nafter", init: restricted },
  { name: "restricted indented fence", source: " ```\n   aaa\n    bbb\n  ```\n\n<Card>x</Card>", init: restricted },
  { name: "fence after an html block", source: "<div>\n\n```\naaa\n```\n" },
  { name: "restricted unclosed fence", source: " ```\naaa\nbbb\n", init: restricted },
];

function codeLines(store: RendererStore): string[] | null {
  const code = store.getBlocks().find((block) => block.type === "code");
  return code ? store.getCodeLines(code.id, 0, 64).map((line) => line.text) : null;
}

/** CommonMark code content lines; the case sources contain no characters micromark escapes. */
function commonMarkCodeLines(source: string): string[] | null {
  const content = micromark(source).match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1];
  return content === undefined ? null : content.replace(/\n$/, "").split("\n");
}

async function main(): Promise<void> {
  // The reference engine re-initializes per prefix, so it must not share the streaming engine.
  const streaming = await createWorkerHarness();
  const reference = await createWorkerHarness();
  type Harness = typeof streaming;
  const start = async (harness: Harness, store: RendererStore, initialContent: string, init: Partial<Extract<WorkerIn, { type: "INIT" }>> | undefined) => {
    apply(store, await harness.send({
      type: "INIT",
      schemaVersion: STREAM_MDX_SCHEMA_VERSION,
      initialContent,
      prewarmLangs: [],
      docPlugins: { footnotes: true, html: true, mdx: true, math: true, tables: true, callouts: true },
      ...init,
    } as WorkerIn));
  };

  for (const { name, source, init } of cases) {
    const streamed = createRendererStore();
    await start(streaming, streamed, "", init);
    for (let end = 1; end <= source.length; end += 1) {
      apply(streamed, await streaming.send({ type: "APPEND", text: source[end - 1]! }));
      const single = createRendererStore();
      await start(reference, single, source.slice(0, end), init);
      assert.deepStrictEqual(codeLines(streamed), codeLines(single), `${name}: live code lines after ${JSON.stringify(source.slice(0, end))}`);
    }
    apply(streamed, await streaming.send({ type: "FINALIZE" }));
    const single = createRendererStore();
    await start(reference, single, source, init);
    apply(single, await reference.send({ type: "FINALIZE" }));
    assert.deepStrictEqual(codeLines(streamed), codeLines(single), `${name}: finalized code lines`);
    assert.deepStrictEqual(codeLines(single), commonMarkCodeLines(source), `${name}: finalized code lines must match CommonMark`);
  }
}

function apply(store: RendererStore, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
}

await main();
console.log("base-path code streaming test passed");
