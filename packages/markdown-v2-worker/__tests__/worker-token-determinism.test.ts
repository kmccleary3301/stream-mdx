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

async function collectTokenLines(codeLines: readonly string[] = ["const alpha = 1;", "const beta = 2;"]): Promise<TokenConsumerOutput> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const content = ["```ts", ...codeLines, "```"].join("\n");

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
    codeLines,
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

// A loaded or cold thread must not change highlighting: every clock read here advances one second.
// The slow run highlights code no earlier run cached; the reference appends a line, so it cannot reuse
// the slow result, and line-by-line tokenization keeps the shared lines comparable.
async function runSlowClockTokenTest(): Promise<void> {
  const codeLines = ["function add(a: number, b: number) {", "  return a + b;"];
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => (now += 1000);
  let slow: TokenConsumerOutput;
  try {
    slow = await collectTokenLines(codeLines);
  } finally {
    Date.now = realNow;
  }
  const reference = await collectTokenLines([...codeLines, "}"]);
  assert.deepStrictEqual(slow.tokenLines, reference.tokenLines.slice(0, codeLines.length), "highlighting must not depend on elapsed time");
}

await runTokenDeterminismTest();
await runSlowClockTokenTest();
console.log("worker token determinism test passed");
