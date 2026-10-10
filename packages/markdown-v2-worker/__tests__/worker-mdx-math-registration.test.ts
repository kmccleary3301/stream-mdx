import assert from "node:assert";
import { readFileSync } from "node:fs";
import { detectMDX, type Block, type InlineNode, type MixedContentSegment, type Patch, type WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";
import { collectMathProtectedRanges } from "../src/engine/parse-extract";

const SAMPLE_SNIPPET = [
  "Inline math $a^2 + b^2 = c^2$ lives next to an embedded MDX component:",
  "",
  '<Callout tone="info">Remember that $$E=mc^2$$ holds even inside MDX.</Callout>',
].join("\n");
const MATH_SENTINEL_SNIPPET = ["$$", "\\text{MDX\\_IN\\_MATH\\_SENTINEL <InlineComponent />} + \\text{\\{not-mdx\\}}", "$$"].join("\n");

function containsMathNodes(nodes: InlineNode[] | undefined): boolean {
  if (!nodes || nodes.length === 0) return false;
  for (const node of nodes) {
    if (node.kind === "math-inline" || node.kind === "math-display") {
      return true;
    }
    if ("children" in node && Array.isArray((node as { children?: InlineNode[] }).children)) {
      if (containsMathNodes((node as { children?: InlineNode[] }).children ?? [])) {
        return true;
      }
    }
  }
  return false;
}

async function renderSnippetWithPlugins(snippet: string): Promise<Block[]> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { html: true, mdx: true, math: true, tables: true, callouts: true },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not initialize before streaming snippet");
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

async function testNestedNegativeMathFallback(): Promise<void> {
  const source = readFileSync(new URL("../../../tests/regression/fixtures/math-left-right-nested-negative.md", import.meta.url), "utf8");
  const tex = "\\left( \\frac{\\left[a+b}{c}";
  const harness = await createWorkerHarness();
  await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    mdx: { compileMode: "worker" },
    docPlugins: { html: true, mdx: true, math: true, formatAnticipation: { mathInline: true, mathBlock: true, mdx: true, html: true } },
  });
  const assertFallback = (blocks: Block[]): void => {
    const math = blocks.find((block) => block.payload.raw.includes(tex));
    assert.ok(math, "the actual nested-negative math source must remain visible");
    assert.equal(math.type, "paragraph", "raw math must not compile through MDX's EOF math closure");
    assert.ok(math.payload.inline?.every((node) => node.kind === "text"), "unsupported math must remain literal, not speculative math or JSX");
    assert.equal(math.payload.inline?.map((node) => node.kind === "text" ? node.text : "").join(""), math.payload.raw);
    assert.equal(math.payload.compiledMdxModule, undefined);
    assert.equal(math.payload.meta?.mixedSegments, undefined);
    const protectedRanges = math.payload.meta?.protectedRanges as Array<{ from: number; to: number; kind: string }> | undefined;
    assert.ok(protectedRanges?.some((range) => range.kind === "math-display" && range.from === 0 && range.to === math.payload.raw.length));
  };
  let received = "";
  for (const character of source) {
    received += character;
    await harness.send({ type: "APPEND", text: character });
    if (!received.includes(tex)) continue;
    const messages = await harness.send({ type: "DUMP_BLOCKS" });
    const dump = messages.find((message) => message.type === "DUMP_BLOCKS");
    assert.ok(dump && dump.type === "DUMP_BLOCKS");
    assertFallback(dump.blocks);
  }
  await harness.send({ type: "FINALIZE" });
  const messages = await harness.send({ type: "DUMP_BLOCKS" });
  const dump = messages.find((message) => message.type === "DUMP_BLOCKS");
  assert.ok(dump && dump.type === "DUMP_BLOCKS");
  assertFallback(dump.blocks);
  for (const text of [
    "Trailing prose must remain visible after the nested left-right negative case.",
    "Final paragraph after the nested left-right negative case.",
  ]) {
    assert.ok(dump.blocks.some((block) => block.type === "paragraph" && block.payload.raw === text), "math fallback must stop at its native paragraph boundary");
  }

  const closed = "$$\\left(x+y\\right)$$";
  const mixed = `${closed} <InlineComponent />`;
  assert.deepEqual(collectMathProtectedRanges(mixed), [{ from: 0, to: closed.length, kind: "math-display" }], "confirmed math must not protect later JSX");
  const supported = await renderSnippetWithPlugins("Inline $\\left(x+y\\right)$ and display $$\\left[x+y\\right]$$.");
  const nodes = supported.flatMap((block) => block.payload.inline ?? []);
  assert.ok(nodes.some((node) => node.kind === "math-inline" && node.tex === "\\left(x+y\\right)"));
  assert.ok(nodes.some((node) => node.kind === "math-display" && node.tex === "\\left[x+y\\right]"));
  for (const [codeAndMdx, mdxSource] of [
    ["`$$` <InlineComponent />", "<InlineComponent />"],
    ["``$$ ` literal`` <InlineComponent />", "<InlineComponent />"],
    ["`$$` {Math.imul(6, 7)}", "{Math.imul(6, 7)}"],
  ]) {
    const protectedRanges = collectMathProtectedRanges(codeAndMdx);
    assert.deepEqual(protectedRanges, [], "code-owned dollars must not protect later MDX");
    assert.ok(detectMDX(codeAndMdx, { protectedRanges }), "MDX after a completed code span must remain eligible");
    const blocks = await renderSnippetWithPlugins(codeAndMdx);
    const paragraph = blocks.find((block) => block.payload.raw === codeAndMdx && (
      block.type === "paragraph" || (block.type === "mdx" && block.payload.meta?.originalType === "paragraph")
    ));
    assert.ok(paragraph, "inline code and MDX must retain their semantic paragraph projection");
    assert.equal(paragraph.payload.raw, codeAndMdx);
    assert.ok(paragraph.payload.inline?.some((node) => node.kind === "code" && node.text.includes("$$")), "literal dollars must remain visible as inline code");
    assert.ok(!containsMathNodes(paragraph.payload.inline), "code-owned dollars must not create math nodes");
    if (mdxSource.startsWith("<")) {
      const segments = paragraph.payload.meta?.mixedSegments as MixedContentSegment[] | undefined;
      assert.ok(segments?.some((segment) => segment.kind === "mdx" && segment.value === mdxSource), "the component must remain a separate inline projection");
    } else {
      // Check the observed native inline projection, not expression evaluation
      // or the DOM produced by the separate MDX compilation path.
      assert.ok(paragraph.payload.inline?.some((node) => node.kind === "text" && node.text.includes(mdxSource)), "expression source must remain in the inline projection");
    }
  }
}

async function main() {
  const blocks = await renderSnippetWithPlugins(SAMPLE_SNIPPET);
  const mdxBlock = blocks.find((block) => block.type === "mdx");
  assert.ok(mdxBlock, "expected MDX detection plugin to retag Callout block to type 'mdx'");

  const mathParagraph = blocks.find((block) => block.type === "paragraph" && typeof block.payload.raw === "string" && block.payload.raw.includes("$a^2"));
  assert.ok(mathParagraph, "expected inline paragraph to survive next to MDX");
  assert.ok(containsMathNodes(mathParagraph.payload.inline), "paragraph inline nodes should include math markers when math plugin is enabled");

  const sentinelBlocks = await renderSnippetWithPlugins(MATH_SENTINEL_SNIPPET);
  const sentinelBlock = sentinelBlocks.find(
    (block) => typeof block.payload.raw === "string" && block.payload.raw.includes("MDX\\_IN\\_MATH\\_SENTINEL"),
  );
  assert.ok(sentinelBlock, "expected sentinel math block to render");
  assert.notStrictEqual(sentinelBlock.type, "mdx", "math sentinel should not be tagged as mdx");
  const sentinelRanges = (sentinelBlock.payload.meta as { protectedRanges?: Array<{ kind?: string }> } | undefined)?.protectedRanges ?? [];
  assert.ok(sentinelRanges.some((range) => range?.kind === "math-display"), "math sentinel should carry math-display protected range");
  assert.ok(containsMathNodes(sentinelBlock.payload.inline), "math sentinel should remain inline math content, not raw text");

  await testNestedNegativeMathFallback();

  console.log("worker mdx/math registration test passed");
}

await main();
