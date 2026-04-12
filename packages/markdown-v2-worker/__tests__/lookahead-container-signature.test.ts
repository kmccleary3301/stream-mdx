import assert from "node:assert";

import type { WorkerOut } from "@stream-mdx/core";

import { createWorkerHarness } from "./worker-test-harness";

function findParagraphMeta(messages: WorkerOut[]) {
  const init = messages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  if (!init) return null;
  const paragraph = init.blocks.find((block) => block.type === "paragraph" || block.type === "heading" || block.type === "blockquote");
  return paragraph?.payload.meta as Record<string, unknown> | undefined;
}

async function testParagraphGetsContainerSignatureAndRegexDecision(): Promise<void> {
  const harness = await createWorkerHarness();
  const messages = await harness.send({
    type: "INIT",
    initialContent: "Ref {cite:5",
    prewarmLangs: [],
    docPlugins: {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: { inline: true, regex: true },
    },
  });

  const meta = findParagraphMeta(messages);
  assert.ok(meta, "expected paragraph metadata");
  assert.strictEqual(typeof meta?.inlineContainerSignature, "string");
  const lookahead = Array.isArray(meta?.inlineLookahead) ? (meta?.inlineLookahead as Array<Record<string, unknown>>) : [];
  const regexDecision = lookahead.find((entry) => entry.providerId === "regex-provider");
  assert.ok(regexDecision, "expected regex-provider decision");
}

async function testContainerSignatureDiffersAcrossContainerTypes(): Promise<void> {
  const paragraphHarness = await createWorkerHarness();
  const paragraphMessages = await paragraphHarness.send({
    type: "INIT",
    initialContent: "plain paragraph",
    prewarmLangs: [],
    docPlugins: {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: true,
    },
  });
  const paragraphMeta = findParagraphMeta(paragraphMessages);
  assert.ok(paragraphMeta?.inlineContainerSignature, "expected paragraph signature");

  const quoteHarness = await createWorkerHarness();
  const quoteMessages = await quoteHarness.send({
    type: "INIT",
    initialContent: "> quoted line",
    prewarmLangs: [],
    docPlugins: {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: true,
    },
  });
  const quoteMeta = findParagraphMeta(quoteMessages);
  assert.ok(quoteMeta?.inlineContainerSignature, "expected blockquote signature");
  assert.notStrictEqual(quoteMeta?.inlineContainerSignature, paragraphMeta?.inlineContainerSignature);
}

await testParagraphGetsContainerSignatureAndRegexDecision();
await testContainerSignatureDiffersAcrossContainerTypes();
console.log("lookahead container signature tests passed");
