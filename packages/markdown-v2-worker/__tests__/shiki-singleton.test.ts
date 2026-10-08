import assert from "node:assert";
import { MarkdownEngine } from "../src/engine/engine";

async function runShikiSingletonTest(): Promise<void> {
  const initialCount = MarkdownEngine.getHighlighterInstanceCount();

  // Run 100 separate engine initializations
  for (let i = 0; i < 100; i++) {
    const engine = new MarkdownEngine({ post: () => {} });
    await engine.processMessage({
      type: "INIT",
      initialContent: "",
      prewarmLangs: ["javascript", "typescript"],
    });
  }

  const finalCount = MarkdownEngine.getHighlighterInstanceCount();
  assert.strictEqual(finalCount, 1, `expected exactly 1 Shiki instance across 100 INITs, got ${finalCount}`);
  assert.ok(initialCount <= 1, "initial count before test should be at most 1");

  console.log(`Shiki singleton test passed: instance count is ${finalCount} across 100 INITs`);
}

await runShikiSingletonTest();
