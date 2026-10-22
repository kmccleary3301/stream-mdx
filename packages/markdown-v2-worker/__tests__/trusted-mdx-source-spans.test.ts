import assert from "node:assert";
import { describe, it } from "node:test";
import type { TrustedMdxFlowChildSpan, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { compileTrustedMdxDocument } from "../src/mdx-compile";
import { parseTrustedMdxSourceSpans } from "../src/mdx-source-spans";
import { VFileMessage } from "vfile-message";
import { createWorkerHarness } from "./worker-test-harness";

function childSources(source: string, children?: readonly TrustedMdxFlowChildSpan[]) {
  return children?.map((child) => ({ kind: child.kind, source: source.slice(child.from, child.to) }));
}

describe("trusted MDX source-only spans", () => {
  it("matches compiler MDAST placement and exact spans for fragments, inline JSX, and native children", async () => {
    const panelSource = [
      "<Panel>",
      "",
      "## Native heading",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "$$",
      "x^2",
      "$$",
      "",
      "| A | B |",
      "| --- | --- |",
      "| x | y |",
      "",
      "</Panel>",
    ].join("\n");
    const fragmentSource = [
      "<>",
      "Native paragraph with <Inline value={4} /> in one block.",
      "",
      panelSource,
      "",
      "</>",
    ].join("\n");
    const prefix = "😀 preceding native text.\n\n";
    const source = prefix + fragmentSource;

    const parsed = parseTrustedMdxSourceSpans(source);
    assert.strictEqual(parsed.kind, "parsed");
    if (parsed.kind !== "parsed") throw new Error("valid MDX source was not recognized");
    assert.deepStrictEqual(parseTrustedMdxSourceSpans(source), parsed, "cold and repeated parses retain identical spans");

    const artifact = await compileTrustedMdxDocument(source);
    const parsedProjection = parsed.regions.map((region) => ({
      source: source.slice(region.from, region.to),
      placement: region.placement,
      rootElementName: region.rootElementName,
      flowChildren: childSources(source, region.flowChildren),
    }));
    const compilerProjection = artifact.regions
      .filter((region): region is Extract<(typeof artifact.regions)[number], { kind: "render" }> => region.kind === "render")
      .map((region) => ({
        source: source.slice(region.from, region.to),
        placement: region.placement,
        rootElementName: region.rootElementName,
        flowChildren: childSources(source, region.flowChildren),
      }));
    assert.deepStrictEqual(parsedProjection, compilerProjection);

    const fragment = parsed.regions.find((region) => source.slice(region.from, region.to) === fragmentSource);
    assert.ok(fragment, "unnamed fragment must be retained as an exact flow root");
    assert.strictEqual(fragment.placement, "flow");
    assert.strictEqual(fragment.rootElementName, null);
    assert.strictEqual(fragment.from, source.indexOf(fragmentSource), "offsets use authored UTF-16 source positions");
    assert.deepStrictEqual(
      childSources(source, fragment.flowChildren),
      [
        { kind: "markdown", source: "Native paragraph with <Inline value={4} /> in one block." },
        { kind: "jsx", source: panelSource },
      ],
    );

    const panel = parsed.regions.find((region) => source.slice(region.from, region.to) === panelSource);
    assert.ok(panel, "nested panel must retain its own flow provenance");
    assert.deepStrictEqual(
      childSources(source, panel.flowChildren),
      [
        { kind: "markdown", source: "## Native heading" },
        { kind: "markdown", source: "```ts\nconst answer = 42;\n```" },
        { kind: "markdown", source: "$$\nx^2\n$$" },
        { kind: "markdown", source: "| A | B |\n| --- | --- |\n| x | y |" },
      ],
    );
    const inline = parsed.regions.find((region) => source.slice(region.from, region.to) === "<Inline value={4} />");
    assert.ok(inline);
    assert.strictEqual(inline.placement, "inline");
  });

  it("returns not-complete for MDX syntax errors but preserves the host compiler diagnostic", async () => {
    const source = "<Panel>\n\n{unfinished expression\n\n</Panel>";
    assert.deepStrictEqual(parseTrustedMdxSourceSpans(source), { kind: "not-complete" });
    await assert.rejects(
      () => compileTrustedMdxDocument(source),
      (error) => error instanceof VFileMessage && error.source === "micromark-extension-mdx-expression",
    );
  });

  it("does not convert unexpected parser failures into incomplete-source results", () => {
    const unexpected = new Error("unexpected parser failure");
    assert.throws(
      () => parseTrustedMdxSourceSpans("<Panel />", () => { throw unexpected; }),
      (error) => error === unexpected,
    );
  });

  it("allows native FINALIZED to preserve malformed MDX source without worker compilation", async () => {
    const harness = await createWorkerHarness();
    const source = "<Panel>\n\n{unfinished expression\n\n</Panel>";
    const initMessages = await harness.send({
      type: "INIT",
      initialContent: "",
      prewarmLangs: [],
      contentPolicy: "trusted-mdx",
      docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true },
    });
    const initialized = initMessages.find(
      (message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED",
    );
    assert.ok(initialized, "worker initializes before trusted syntax recognition");

    const store = createRendererStore();
    store.reset(initialized.blocks);
    const appendMessages = await harness.send({ type: "APPEND", text: source });
    const finalizeMessages = await harness.send({ type: "FINALIZE" });
    const finalized = finalizeMessages.find((message) => message.type === "FINALIZED");
    assert.ok(finalized, "native FINALIZED does not wait for trusted module compilation");
    assert.ok(
      ![...initMessages, ...appendMessages, ...finalizeMessages].some((message) => message.type === "ERROR"),
      "an expected MDX syntax message is not promoted to a worker failure",
    );
    for (const message of [...appendMessages, ...finalizeMessages]) {
      if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
    }
    const sourceBlock = store.getBlocks().find((block) => block.payload.raw === source);
    assert.ok(sourceBlock, "the native snapshot keeps the exact authored invalid source");
    assert.strictEqual(sourceBlock.isFinalized, true);
  });
});
