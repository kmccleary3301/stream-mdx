import assert from "node:assert/strict";
import { AppendSourceDocument, InlineParser, type Block, type FootnoteItem, type InlineNode } from "@stream-mdx/core";
import type { DocumentContext, DocumentState, FootnoteParagraphTargetUpdate } from "../src/plugins/document";
import { FootnotesPlugin } from "../src/plugins/footnotes";

function paragraph(raw: string, from: number, inline: InlineNode[] = []): Block {
  return {
    id: `paragraph-${from}`,
    type: "paragraph",
    isFinalized: true,
    payload: {
      raw,
      inline,
      range: { from, to: from + raw.length },
    },
  };
}

function context(blocks: Block[], state: DocumentState, prefix = ""): DocumentContext {
  const source = new AppendSourceDocument();
  source.append(prefix);
  for (const block of blocks) {
    const from = block.payload.range?.from ?? source.length;
    assert.ok(from >= source.length, "fixture blocks must follow their authored source");
    source.append("\n".repeat(from - source.length) + block.payload.raw);
  }
  return {
    source: source.snapshot(),
    blocks,
    readBlocks: () => blocks,
    hasProvisionalTail: false,
    state,
  };
}

function footerItems(blocks: Block[]): FootnoteItem[] {
  const footer = blocks.find((block) => block.type === "footnotes");
  assert.ok(footer, "expected the plugin to publish a synthetic footnotes block");
  const items = (footer.payload.meta as { items?: FootnoteItem[] } | undefined)?.items;
  assert.ok(items, "expected the synthetic footnotes block to contain items");
  return items;
}

function runPlugin(ctx: DocumentContext): Block[] {
  FootnotesPlugin.onBegin?.(ctx);
  const contribution = FootnotesPlugin.process(ctx);
  return [...ctx.blocks, ...(contribution?.syntheticBlocks ?? [])];
}

function runConfiguredDefinitionParserTest(): void {
  const state: DocumentState = { inlineParser: new InlineParser({ enableMath: true }) };
  const blocks = [
    paragraph("A reference [^note].", 0, [{ kind: "footnote-ref", label: "note" }]),
    paragraph("[^note]: $x + 1$", 40),
  ];

  const processed = runPlugin(context(blocks, state));
  const items = footerItems(processed);
  assert.deepEqual(items[0]?.inlines, [{ kind: "math-inline", tex: "x + 1" }]);
  assert.deepEqual(blocks[0]?.payload.inline, [{ kind: "footnote-ref", label: "note", defined: true, number: 1, occurrence: 1 }]);
}

function runLegacyNoBridgeUpdateTest(): void {
  const state: DocumentState = {};
  const makeBlocks = (reference: "alpha" | "beta") => [
    paragraph(`Reference [^${reference}].`, 0, [{ kind: "footnote-ref", label: reference }]),
    paragraph("[^alpha]: first definition", 40),
    paragraph("[^beta]: second definition", 90),
  ];

  runPlugin(context(makeBlocks("alpha"), state));
  const updatedBlocks = makeBlocks("beta");
  const updated = runPlugin(context(updatedBlocks, state));

  assert.deepEqual(footerItems(updated).map((item) => [item.label, item.number]), [["beta", 1]]);
  assert.deepEqual(updatedBlocks[0]?.payload.inline, [{ kind: "footnote-ref", label: "beta", defined: true, number: 1, occurrence: 1 }]);
}

function runBridgeTargetGenerationTest(): void {
  const state: DocumentState = {};
  const makeBlocks = (reference: "alpha" | "beta") => [
    paragraph(`Reference [^${reference}].`, 30, [{ kind: "footnote-ref", label: reference }]),
    paragraph("[^alpha]: first definition", 90),
    paragraph("[^beta]: second definition", 140),
  ];
  const rootSpan = (generation: number) => ({
    ownerId: "root-owner",
    generation,
    spans: [{
      index: 0,
      sourceRevision: generation,
      sourceRange: { from: 0, to: "Reference [^alpha].".length },
      nodes: [{ kind: "footnote-ref" as const, label: "alpha" }],
      attemptedReferences: ["alpha"],
    }],
  });

  const firstContext = context(makeBlocks("beta"), state, "Reference [^alpha].");
  let firstUpdates: readonly FootnoteParagraphTargetUpdate[] = [];
  firstContext.footnoteParagraphTargets = {
    deltas: [rootSpan(4)],
    applyUpdates(updates) {
      firstUpdates = updates;
    },
  };
  const first = runPlugin(firstContext);
  assert.deepEqual(footerItems(first).map((item) => [item.label, item.number]), [["alpha", 1], ["beta", 2]]);
  assert.equal(firstUpdates[0]?.generation, 4);
  assert.deepEqual(firstUpdates[0]?.updates[0]?.nodes, [
    { kind: "footnote-ref", label: "alpha", defined: true, number: 1, occurrence: 1 },
  ]);

  const removedContext = context(makeBlocks("beta"), state);
  let staleUpdates: readonly FootnoteParagraphTargetUpdate[] = [];
  removedContext.footnoteParagraphTargets = {
    removedOwnerIds: ["root-owner"],
    deltas: [rootSpan(4)],
    applyUpdates(updates) {
      staleUpdates = updates;
    },
  };
  const removed = runPlugin(removedContext);
  assert.deepEqual(footerItems(removed).map((item) => [item.label, item.number]), [["beta", 1]]);
  assert.deepEqual(staleUpdates, [], "a retired generation must not receive numbering writes");

  const reopenedContext = context(makeBlocks("beta"), state, "Reference [^alpha].");
  let reopenedUpdates: readonly FootnoteParagraphTargetUpdate[] = [];
  reopenedContext.footnoteParagraphTargets = {
    deltas: [rootSpan(5)],
    applyUpdates(updates) {
      reopenedUpdates = updates;
    },
  };
  const reopened = runPlugin(reopenedContext);
  assert.deepEqual(footerItems(reopened).map((item) => [item.label, item.number]), [["alpha", 1], ["beta", 2]]);
  assert.equal(reopenedUpdates[0]?.generation, 5);
  assert.deepEqual(reopenedUpdates[0]?.updates[0]?.nodes, [
    { kind: "footnote-ref", label: "alpha", defined: true, number: 1, occurrence: 1 },
  ]);
}

runConfiguredDefinitionParserTest();
runLegacyNoBridgeUpdateTest();
runBridgeTargetGenerationTest();
