import assert from "node:assert";

import { createCompileMarkdownSnapshotPool } from "../src/node/index";

async function run(): Promise<void> {
  const pool = createCompileMarkdownSnapshotPool({ size: 2, maxMemoryEntries: 8 });
  try {
    const textA = ["# Title", "", "Hello world", "", "```js", "console.log(1)", "```", ""].join("\n");
    const textB = ["# Other", "", "- a", "- b", ""].join("\n");

    const [a1, a2, b1] = await Promise.all([
      pool.compile({ text: textA, init: { docPlugins: { html: true, tables: true, footnotes: true }, prewarmLangs: [] }, hashSalt: "pool-test" }),
      pool.compile({ text: textA, init: { docPlugins: { html: true, tables: true, footnotes: true }, prewarmLangs: [] }, hashSalt: "pool-test" }),
      pool.compile({ text: textB, init: { docPlugins: { html: true, tables: true, footnotes: true }, prewarmLangs: [] }, hashSalt: "pool-test" }),
    ]);

    assert.strictEqual(a1.blocks.length, a2.blocks.length, "same input should produce same block count");
    assert.deepStrictEqual(
      a1.blocks.map((b) => ({ id: b.id, type: b.type, raw: b.payload.raw })),
      a2.blocks.map((b) => ({ id: b.id, type: b.type, raw: b.payload.raw })),
      "same input should produce stable blocks (id/type/raw)",
    );

    assert.ok(b1.blocks.length > 0, "expected blocks for textB");
  } finally {
    await pool.close();
  }
}

await run();
console.log("node snapshot pool test passed");

