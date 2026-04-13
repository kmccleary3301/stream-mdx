import assert from "node:assert";

import type { WorkerOut } from "@stream-mdx/core";

import { createWorkerHarness } from "./worker-test-harness";

function findParagraphMeta(messages: WorkerOut[]) {
  const init = messages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  if (!init) return null;
  const paragraph = init.blocks.find((block) => block.type === "paragraph" || block.type === "blockquote" || block.type === "mdx");
  return paragraph?.payload.meta as Record<string, unknown> | undefined;
}

async function testHtmlInlineProviderAppearsInMixedLookahead(): Promise<void> {
  const harness = await createWorkerHarness();
  const messages = await harness.send({
    type: "INIT",
    initialContent: "Prefix <kbd>code",
    prewarmLangs: [],
    docPlugins: {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: { inline: true, html: true },
    },
  });

  const meta = findParagraphMeta(messages);
  assert.ok(meta, "expected paragraph metadata");
  const decisions = Array.isArray(meta?.mixedLookahead) ? (meta?.mixedLookahead as Array<Record<string, unknown>>) : [];
  const htmlDecision = decisions.find((entry) => entry.providerId === "html-inline-provider");
  assert.ok(htmlDecision, "expected html-inline-provider mixed lookahead decision");
}

async function testMdxTagProviderAppearsInMixedLookahead(): Promise<void> {
  const harness = await createWorkerHarness();
  const messages = await harness.send({
    type: "INIT",
    initialContent: "Prefix <InlineChip tone=\"warm\"> suffix",
    prewarmLangs: [],
    docPlugins: {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: { inline: true, mdx: true },
      mdxComponentNames: ["InlineChip"],
    },
  });

  const meta = findParagraphMeta(messages);
  assert.ok(meta, "expected paragraph metadata");
  const decisions = Array.isArray(meta?.mixedLookahead) ? (meta?.mixedLookahead as Array<Record<string, unknown>>) : [];
  const mdxDecision = decisions.find((entry) => entry.providerId === "mdx-tag-provider");
  assert.ok(mdxDecision, "expected mdx-tag-provider mixed lookahead decision");
}

async function testMdxExpressionProviderAppearsInMixedLookahead(): Promise<void> {
  const harness = await createWorkerHarness();
  const messages = await harness.send({
    type: "INIT",
    initialContent: "Prefix {expr and trailing prose",
    prewarmLangs: [],
    docPlugins: {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: { inline: true, mdx: true },
      mdxComponentNames: ["InlineChip"],
    },
  });

  const meta = findParagraphMeta(messages);
  assert.ok(meta, "expected paragraph metadata");
  const decisions = Array.isArray(meta?.mixedLookahead) ? (meta?.mixedLookahead as Array<Record<string, unknown>>) : [];
  const mdxExpressionDecision = decisions.find((entry) => entry.providerId === "mdx-expression-provider");
  assert.ok(mdxExpressionDecision, "expected mdx-expression-provider mixed lookahead decision");
  assert.strictEqual(mdxExpressionDecision?.decision, "terminate");
}

await testHtmlInlineProviderAppearsInMixedLookahead();
await testMdxTagProviderAppearsInMixedLookahead();
await testMdxExpressionProviderAppearsInMixedLookahead();
console.log("mixed lookahead provider tests passed");
