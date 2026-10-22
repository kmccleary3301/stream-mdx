import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import type { CodeTokenLine, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import type { RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

import { projectConsumerBlocks } from "./consumer-block-projection";
import type { ConsumerBlockProjection } from "./consumer-block-projection";

type ConsumerTokenLine = {
  index: number;
  text: string;
  tokens: CodeTokenLine | null;
};

type TokenConsumerOutput = {
  tokenLines: ConsumerTokenLine[];
  renderedBlock: ConsumerBlockProjection[];
};

function applyMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
}

async function collectTokenLines(): Promise<TokenConsumerOutput> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const content = ["```ts", "const alpha = 1;", "const beta = 2;", "```"].join("\n");

  const initMessages = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: content,
    prewarmLangs: ["typescript"],
    docPlugins: {
      footnotes: false,
      html: false,
      mdx: false,
      tables: false,
      callouts: false,
      codeHighlighting: "final",
      outputMode: "tokens",
      emitHighlightTokens: true,
      liveTokenization: false,
    },
  });
  const init = initMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED");
  assert.ok(init, "worker did not emit INITIALIZED message");
  applyMessages(store, initMessages);
  applyMessages(store, await harness.send({ type: "FINALIZE" }));

  const codeBlock = store.getBlocks().find((block) => block.type === "code");
  assert.ok(codeBlock, "expected a finalized code block in the cold export");
  const tokenLines = store.getCodeLines(codeBlock.id, 0, 16).map((line) => ({
    index: line.index,
    text: line.text,
    tokens: line.decoration?.tokens ?? null,
  }));
  assert.deepStrictEqual(
    tokenLines.map((line) => line.text),
    ["const alpha = 1;", "const beta = 2;"],
    "consumer code lines must preserve source order",
  );
  for (const line of tokenLines) {
    const tokens = line.tokens;
    assert.ok(tokens, `expected tokens for code line ${line.index}`);
    assert.strictEqual(tokens.spans.map((span) => span.t).join(""), line.text, `tokens must reconstruct code line ${line.index}`);
  }

  return { tokenLines, renderedBlock: projectConsumerBlocks([codeBlock]) };
}

async function runTokenDeterminismTest(): Promise<void> {
  const first = await collectTokenLines();
  const second = await collectTokenLines();
  assert.deepStrictEqual(second, first, "consumer code lines, tokens, and rendered output must be deterministic across runs");
}

await runTokenDeterminismTest();
console.log("worker token determinism test passed");
