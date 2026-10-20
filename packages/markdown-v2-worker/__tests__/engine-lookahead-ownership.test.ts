import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import { createInitialSnapshot } from "@stream-mdx/core";
import type { Block, InlineLookaheadPrepareResult, NodeSnapshot, PreparedNestedSnapshot, WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "../src/engine/engine";

type LookaheadDecisionTrace = InlineLookaheadPrepareResult["trace"][number];

function initializedBlocks(messages: WorkerOut[]): Block[] {
  const initialized = messages.find((message) => message.type === "INITIALIZED");
  assert.ok(initialized && initialized.type === "INITIALIZED");
  return createInitialSnapshot(initialized.snapshot).getBlocks();
}

function owners(blocks: Block[]): Block[] {
  const result: Block[] = [];
  const visit = (block: Block): void => {
    result.push(block);
    const prepared = block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
    for (const child of prepared?.children ?? []) visitSnapshot(child);
  };
  const visitSnapshot = (snapshot: NodeSnapshot): void => {
    const block = snapshot.props?.block as Block | undefined;
    if (block) visit(block);
    else for (const child of snapshot.children ?? []) visitSnapshot(child);
  };
  for (const block of blocks) visit(block);
  return result;
}

function decisions(block: Block, field: "inlineLookahead" | "mixedLookahead"): LookaheadDecisionTrace[] {
  return (block.payload.meta?.[field] as LookaheadDecisionTrace[] | undefined) ?? [];
}

async function testNativeOwnersAndFinalization(): Promise<void> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
  await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "> - Parent\n>   - Ref {cite:5\n>\n>   Prefix <kbd>code",
  prewarmLangs: [],
  docPlugins: { mdx: false, formatAnticipation: { inline: true, regex: true, html: true } }, });
  const blocks = initializedBlocks(messages);
  const quote = blocks.find((block) => block.type === "blockquote");
  assert.ok(quote);
  assert.match(String(quote.payload.meta?.inlineContainerSignature), /^blockquote\|root\|l0\|bq1\|/);
  const nested = owners(blocks);
  const citation = nested.find((block) => block.type === "list-item" && block.payload.raw.startsWith("- Ref {cite:5"));
  assert.ok(citation);
  const signature = String(citation.payload.meta?.inlineContainerSignature);
  assert.match(signature, /^list-item\|blockquote>list>list-item>list\|l2\|bq1\|/);
  const regex = decisions(citation, "inlineLookahead").find((decision) => decision.providerId === "regex-provider");
  assert.ok(regex);
  assert.equal(regex.contextSignature, signature);
  const expressions = decisions(citation, "mixedLookahead").filter((decision) => decision.providerId === "mdx-expression-provider");
  assert.equal(expressions.length, 1, "expected one expression decision for the native primary tail");
  for (const expression of expressions) {
    assert.match(expression.contextSignature ?? "", /^list-item\|blockquote>list>list-item>list\|l2\|bq1\|html0\|mdx1\|mixed-content\|mdx\|p1\|/);
  }
  const htmlOwner = nested.find((block) => block.type === "paragraph" && block.payload.raw.includes("<kbd>"));
  assert.ok(htmlOwner);
  const html = decisions(htmlOwner, "mixedLookahead").find((decision) => decision.providerId === "html-inline-provider");
  assert.ok(html);
  assert.match(html.contextSignature ?? "", /^paragraph\|blockquote>list>list-item\|l1\|bq1\|html1\|mdx0\|mixed-content\|html\|p1\|/);

  messages.length = 0;
  await engine.handle({ type: "FINALIZE" });
  await engine.handle({ type: "DUMP_BLOCKS" });
  const dump = messages.find((message) => message.type === "DUMP_BLOCKS");
  assert.ok(dump && dump.type === "DUMP_BLOCKS");
  for (const block of owners(dump.blocks)) {
    assert.equal(block.payload.meta?.inlineContainerSignature, undefined);
    assert.equal(block.payload.meta?.inlineLookahead, undefined);
    assert.equal(block.payload.meta?.inlineLookaheadInvalidated, undefined);
    assert.equal(block.payload.meta?.mixedLookahead, undefined);
  }
  engine.dispose();
}

async function testInstanceAndDocumentIsolation(): Promise<void> {
  const firstMessages: WorkerOut[] = [];
  const secondMessages: WorkerOut[] = [];
  const first = new MarkdownEngine({ post: (message) => firstMessages.push(message) });
  const second = new MarkdownEngine({ post: (message) => secondMessages.push(message) });
  await first.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "Ref {cite:5", prewarmLangs: [], docPlugins: { mdx: false, formatAnticipation: { regex: true } } });
  await second.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "Ref {cite:5", prewarmLangs: [], docPlugins: { mdx: false, formatAnticipation: false } });
  assert.ok(decisions(initializedBlocks(firstMessages)[0], "inlineLookahead").some((decision) => decision.providerId === "regex-provider"));
  assert.ok(!decisions(initializedBlocks(secondMessages)[0], "inlineLookahead").some((decision) => decision.providerId === "regex-provider"));
  firstMessages.length = 0;
  await first.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "New document", prewarmLangs: [], docPlugins: { formatAnticipation: false } });
  const reset = initializedBlocks(firstMessages)[0];
  assert.ok(!decisions(reset, "inlineLookahead").some((decision) => decision.providerId === "regex-provider"));
  assert.equal(reset.payload.meta?.mixedLookahead, undefined);
  first.dispose();
  second.dispose();
}

async function testNativeFenceTailPolicy(): Promise<void> {
  for (const prefix of ["", "> ", "- "]) {
    const messages: WorkerOut[] = [];
    const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
    const continuation = prefix === "- " ? "  " : prefix;
    const raw = `${prefix}\`\`\`js\n${continuation}const x = 1;\n${continuation}\``;
    await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: raw, prewarmLangs: [] });
    const code = owners(initializedBlocks(messages)).find((block) => block.type === "code");
    assert.ok(code, `expected native code for ${JSON.stringify(prefix)}`);
    assert.equal(code.payload.meta?.code, "const x = 1;");
    messages.length = 0;
    await engine.handle({ type: "FINALIZE" });
    await engine.handle({ type: "DUMP_BLOCKS" });
    const dump = messages.find((message) => message.type === "DUMP_BLOCKS");
    assert.ok(dump && dump.type === "DUMP_BLOCKS");
    const finalized = owners(dump.blocks).find((block) => block.type === "code");
    assert.ok(finalized);
    assert.equal(finalized.payload.meta?.code, "const x = 1;\n`");
    engine.dispose();
  }
}

await testNativeOwnersAndFinalization();
await testInstanceAndDocumentIsolation();
await testNativeFenceTailPolicy();
console.log("engine lookahead ownership tests passed");
