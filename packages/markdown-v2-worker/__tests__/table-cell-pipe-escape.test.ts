import assert from "node:assert/strict";
import type { InlineNode } from "@stream-mdx/core";
import { compileMarkdownSnapshotDirect } from "../src/direct-compile";

// GFM 200: a table cell's `\|` loses its backslash before inline parsing, so a code span holds a bare pipe. Trusted
// MDX source ranges still address the authored cell text, backslash included.
const text = "| f\\|oo  |\n| ------ |\n| b `\\|` az |\n| b **\\|** im |\n";

function inlineText(nodes: readonly InlineNode[]): string {
  return nodes
    .map((node) => {
      if ("children" in node && Array.isArray(node.children)) return inlineText(node.children as InlineNode[]);
      return "text" in node && typeof node.text === "string" ? node.text : "";
    })
    .join("");
}

function rangedNodes(nodes: readonly InlineNode[]): InlineNode[] {
  return nodes.flatMap((node) => [
    ...(node.sourceRange ? [node] : []),
    ...("children" in node && Array.isArray(node.children) ? rangedNodes(node.children as InlineNode[]) : []),
  ]);
}

for (const contentPolicy of [undefined, "trusted-mdx"] as const) {
  const { blocks } = await compileMarkdownSnapshotDirect({
    text,
    init: { prewarmLangs: [], ...(contentPolicy ? { contentPolicy } : {}), docPlugins: { tables: true, html: true, mdx: true } },
  });
  const table = blocks.find((block) => block.type === "table");
  assert.ok(table, `${contentPolicy ?? "default"}: table block`);
  const meta = table.payload.meta as { header: InlineNode[][]; rows: InlineNode[][][] };
  const cells = [...meta.header, ...meta.rows.flat()];
  assert.deepEqual(cells.map(inlineText), ["f|oo", "b | az", "b | im"], `${contentPolicy ?? "default"}: cell text`);
  assert.deepEqual(meta.rows[0]?.[0]?.find((node) => node.kind === "code"), contentPolicy
    ? { kind: "code", text: "|", sourceRange: { from: text.indexOf("`"), to: text.indexOf("`", text.indexOf("`") + 1) + 1 } }
    : { kind: "code", text: "|" });

  const ranged = rangedNodes(cells.flat());
  if (contentPolicy === undefined) {
    assert.deepEqual(ranged, [], "default policy cells carry no source ranges");
    continue;
  }
  assert.ok(ranged.length > 0, "trusted cells carry source ranges");
  for (const node of ranged) {
    const range = node.sourceRange as { from: number; to: number };
    assert.equal(text.slice(range.from, range.to).replace(/`/g, "").replace(/\*\*/g, "").replace(/\\\|/g, "|"), inlineText([node]));
  }
}

console.log("table cell pipe escape tests passed");
