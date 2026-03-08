import assert from "node:assert";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";

class RNG {
  private seed: number;
  constructor(seed = 1337) {
    this.seed = seed >>> 0;
  }
  next(): number {
    this.seed = (1664525 * this.seed + 1013904223) >>> 0;
    return this.seed / 0xffffffff;
  }
  int(min: number, max: number): number {
    if (max <= min) return min;
    const span = max - min + 1;
    return min + Math.floor(this.next() * span);
  }
  pick<T>(values: readonly T[]): T {
    return values[this.int(0, values.length - 1)];
  }
}

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "lambda", "omega"] as const;

function randomWords(rng: RNG, count: number): string {
  const words: string[] = [];
  for (let i = 0; i < count; i += 1) {
    words.push(rng.pick(WORDS));
  }
  return words.join(" ");
}

function randomComponentName(rng: RNG): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const tail = "abcdefghijklmnopqrstuvwxyz";
  const head = rng.pick(letters.split(""));
  const len = rng.int(3, 8);
  let name = head;
  for (let i = 0; i < len; i += 1) {
    name += rng.pick(tail.split(""));
  }
  return name;
}

async function renderSnippet(snippet: string): Promise<Block[]> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { html: true, mdx: true, math: true, tables: true, callouts: true },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not initialize");
  store.reset(init.blocks);

  const appendMessages = await harness.send({ type: "APPEND", text: snippet });
  appendMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  finalizeMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  return store.getBlocks();
}

async function main() {
  const rng = new RNG(424242);

  for (let i = 0; i < 50; i += 1) {
    const component = randomComponentName(rng);
    const sentinel = `MDX_SENTINEL_${i}`;
    const codeLines = Array.from({ length: rng.int(5, 25) }, () => randomWords(rng, rng.int(2, 6)));

    const snippet = [
      `Intro ${randomWords(rng, 6)}.`,
      "",
      "```js",
      ...codeLines,
      "```",
      "",
      "$$",
      `\\text{${sentinel} <${component} />}`,
      "$$",
      "",
      `Outro ${randomWords(rng, 5)}.`,
    ].join("\n");

    const blocks = await renderSnippet(snippet);

    const codeBlocks = blocks.filter((block) => block.type === "code");
    assert.ok(codeBlocks.length > 0, "expected at least one code block");
    for (const block of codeBlocks) {
      const highlighted = (block.payload as { highlightedHtml?: string }).highlightedHtml;
      assert.ok(typeof highlighted === "string" && highlighted.length > 0, "code block highlighting missing");
      assert.ok(!highlighted.includes("```"), "code fence should not appear in highlighted HTML");
    }

    const sentinelBlock = blocks.find((block) => typeof block.payload.raw === "string" && block.payload.raw.includes(sentinel));
    assert.ok(sentinelBlock, "sentinel block missing");
    assert.notStrictEqual(sentinelBlock.type, "mdx", "math sentinel should not be tagged as mdx");
    const segments = (sentinelBlock.payload.meta as { mixedSegments?: Array<{ kind?: string }> } | undefined)?.mixedSegments ?? [];
    assert.ok(segments.every((segment) => segment?.kind !== "mdx"), "protected math should not emit mdx segments");
  }

  console.log("worker invariants property test passed");
}

await main();
