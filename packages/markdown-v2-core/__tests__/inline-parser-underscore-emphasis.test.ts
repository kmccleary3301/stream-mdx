import assert from "node:assert";

import { InlineParser } from "../src/inline-parser";

async function main() {
  const parser = new InlineParser({ maxCacheEntries: 0 });

  {
    const nodes = parser.parse("alpha _italic_ omega", { cache: false });
    assert.deepStrictEqual(
      nodes,
      [
        { kind: "text", text: "alpha " },
        { kind: "em", children: [{ kind: "text", text: "italic" }] },
        { kind: "text", text: " omega" },
      ],
      "expected underscore-wrapped text to parse as emphasis",
    );
  }

  {
    const nodes = parser.parse("alpha __strong__ omega", { cache: false });
    assert.deepStrictEqual(
      nodes,
      [
        { kind: "text", text: "alpha " },
        { kind: "strong", children: [{ kind: "text", text: "strong" }] },
        { kind: "text", text: " omega" },
      ],
      "expected double-underscore-wrapped text to parse as strong emphasis",
    );
  }

  {
    const nodes = parser.parse("snake_case_value", { cache: false });
    assert.deepStrictEqual(nodes, [{ kind: "text", text: "snake_case_value" }], "expected intraword underscores to remain plain text");
  }

  console.log("Inline parser underscore emphasis regression test passed");
}

await main();
