import assert from "node:assert";

import { InlineParser } from "../src/inline-parser";

async function main() {
  const parser = new InlineParser({ maxCacheEntries: 0 });

  {
    const input = "Text above  \nText below";
    const nodes = parser.parse(input, { cache: false });
    assert.deepStrictEqual(
      nodes,
      [{ kind: "text", text: "Text above" }, { kind: "br" }, { kind: "text", text: "Text below" }],
      "expected two trailing spaces + newline to produce a hard line break",
    );
  }

  {
    const input = "Text above\\\nText below";
    const nodes = parser.parse(input, { cache: false });
    assert.deepStrictEqual(
      nodes,
      [{ kind: "text", text: "Text above" }, { kind: "br" }, { kind: "text", text: "Text below" }],
      "expected backslash + newline to produce a hard line break",
    );
  }

  console.log("Inline parser hard-break regression test passed");
}

await main();

