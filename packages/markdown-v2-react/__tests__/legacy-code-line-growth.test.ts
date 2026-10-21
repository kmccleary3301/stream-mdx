import assert from "node:assert/strict";
import { STREAM_MDX_SCHEMA_VERSION, type WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { createRendererStore } from "../src/renderer/store";

// Trusted MDX documents decline native ownership, so fences stream through the legacy code-line diff.
async function legacyCodeLinesFollowTheStream(): Promise<void> {
  const store = createRendererStore();
  const engine = new MarkdownEngine({
    post: (message: WorkerOut) => {
      if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
      else if (message.type === "PATCH") store.applyPatches(message.patches);
    },
  });
  await engine.handle({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    contentPolicy: "trusted-mdx",
    docPlugins: { codeHighlighting: "incremental" },
  });

  const readLines = () => {
    const code = store.getBlocks().find((block) => block.type === "code");
    assert.ok(code, "code block is published");
    return store.getCodeLines(code.id, 0, 64).map((line) => line.text);
  };

  try {
    await engine.handle({ type: "APPEND", text: "```text\nalpha\n" });
    await engine.handle({ type: "APPEND", text: "beta\ngam" });
    assert.deepEqual(readLines(), ["alpha", "beta", "gam"], "a line added while streaming is readable");

    await engine.handle({ type: "APPEND", text: "ma\ndelta\n```\n" });
    assert.deepEqual(readLines(), ["alpha", "beta", "gamma", "delta"], "a line added while streaming keeps growing");
    assert.deepEqual(store.getInvariantViolations(), []);

    await engine.handle({ type: "FINALIZE" });
    assert.deepEqual(readLines(), ["alpha", "beta", "gamma", "delta"]);
    assert.deepEqual(store.getInvariantViolations(), []);
  } finally {
    engine.dispose();
  }
}

await legacyCodeLinesFollowTheStream();
console.log("legacy-code-line-growth test passed");
