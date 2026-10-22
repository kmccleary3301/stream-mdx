import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import ts from "typescript";

import type { DiffLineKind, Patch, TokenLineV1, WorkerOut } from "@stream-mdx/core";
import { createBlockSnapshot } from "@stream-mdx/core";
import type { Block, NodeSnapshot } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import type { RendererStore } from "../../markdown-v2-react/src/renderer/store";

import { projectConsumerBlocks } from "./consumer-block-projection";
import { createWorkerHarness } from "./worker-test-harness";

function applyMessages(store: RendererStore, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
    else if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
}

async function runDiffTokenizationTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  applyMessages(store, await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: ["typescript"],
    docPlugins: {
      footnotes: false,
      html: false,
      mdx: false,
      tables: false,
      callouts: false,
      codeHighlighting: "incremental",
      outputMode: "tokens",
    },
  }));

  const firstChunk = ["```diff ts", "@@ -1,1 +1,1 @@", "-const a = 1;", ""].join("\n");
  applyMessages(store, await harness.send({ type: "APPEND", text: firstChunk }));
  const secondChunk = ["+const a = 2;", "```", ""].join("\n");
  applyMessages(store, await harness.send({ type: "APPEND", text: secondChunk }));
  applyMessages(store, await harness.send({ type: "FINALIZE" }));

  const codeBlock = store.getBlocks().find((block) => block.type === "code" && block.payload.raw.includes("+const a = 2;"));
  assert.ok(codeBlock, "expected the authored diff fence in the cold export");
  const lines = store.getCodeLines(codeBlock.id, 0, 16);
  const addition = lines.find((line) => line.text === "+const a = 2;");
  assert.ok(addition, "expected an added diff line from the native code-line consumer API");
  assert.strictEqual(addition.diffKind, "add");
  assert.strictEqual(addition.newNo, 1);
  assert.strictEqual(addition.oldNo ?? null, null);

  const additionTokens = addition.decoration?.tokens;
  const additionText = additionTokens?.spans.map((span) => span.t).join("") ?? "";
  assert.strictEqual(additionText, "+const a = 2;", "tokens must reconstruct the rendered addition row");

  const deletion = lines.find((line) => line.text === "-const a = 1;");
  assert.ok(deletion, "cold export must retain the deleted diff row");
  assert.strictEqual(deletion.diffKind, "del");
  const deletionTokens = deletion.decoration?.tokens;
  assert.strictEqual(deletionTokens?.spans.map((span) => span.t).join(""), "-const a = 1;");

  const rendered = projectConsumerBlocks([codeBlock])[0].markup;
  const renderedCode = new JSDOM(rendered).window.document.querySelector("pre code")?.textContent ?? "";
  assert.ok(renderedCode.includes("+const a = 2;"), "static block output must preserve the added diff row");
  assert.ok(renderedCode.includes("-const a = 1;"), "static block output must preserve the deleted diff row");

  const docs = readFileSync(new URL("../../../docs/CLI_USAGE.md", import.meta.url), "utf8");
  const ansiExample = [...docs.matchAll(/```ts\n([\s\S]*?)\n```/g)].find((match) => match[1].includes("function renderDiffLine("))?.[1];
  assert.ok(ansiExample, "the authored public CLI ANSI consumer must be exercised");
  const compiled = ts.transpileModule(ansiExample, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const renderDiffLine = runInNewContext(`${compiled}\nrenderDiffLine;`, { exports: {} }) as (text: string, tokens: TokenLineV1 | null, kind?: DiffLineKind | null) => string;
  const deletionAnsi = renderDiffLine(deletion.text, deletionTokens as TokenLineV1, deletion.diffKind);
  assert.ok(deletionAnsi.startsWith("\u001b[41m"), "the copied CLI consumer must apply deletion background to the actual serialized deletion row");
  assert.strictEqual(deletionAnsi.replace(/\u001b\[[0-9;]*m/g, ""), "-const a = 1;", "the copied CLI consumer must retain actual deletion content");
  assert.ok(deletionAnsi.endsWith("\u001b[0m"), "the copied CLI consumer must reset deletion styling");
  const additionAnsi = renderDiffLine(addition.text, additionTokens as TokenLineV1, addition.diffKind);
  assert.ok(additionAnsi.startsWith("\u001b[42m"), "the same consumer must keep addition background distinct");
}

type DiffRow = { text: string; diffKind: DiffLineKind | undefined; oldNo: number | null; newNo: number | null };

async function streamDiffRows(source: string, chunkSize: number): Promise<DiffRow[]> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  applyMessages(store, await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: false, html: false, mdx: false, tables: false, callouts: false },
  }));
  for (let index = 0; index < source.length; index += chunkSize) {
    applyMessages(store, await harness.send({ type: "APPEND", text: source.slice(index, index + chunkSize) }));
  }
  applyMessages(store, await harness.send({ type: "FINALIZE" }));
  const code = store.getBlocks().find((block) => block.type === "code");
  assert.ok(code, "expected the diff fence in the cold export");
  return store.getCodeLines(code.id, 0, 64).map((line) => ({
    text: line.text,
    diffKind: line.diffKind,
    oldNo: line.oldNo ?? null,
    newNo: line.newNo ?? null,
  }));
}

// Diff numbering depends on every earlier row, so any chunking must yield the single-shot rows.
async function runChunkedDiffNumberingTest(): Promise<void> {
  const source = ["```diff", "@@ -3,2 +3,3 @@", " ctx", "-old", "+new1", "+new2", "@@ -10 +11 @@", "-x", "+y", "```", ""].join("\n");
  const whole = await streamDiffRows(source, source.length);
  const byText = new Map(whole.map((row) => [row.text, row]));
  assert.deepStrictEqual(byText.get(" ctx"), { text: " ctx", diffKind: "context", oldNo: 3, newNo: 3 });
  assert.deepStrictEqual(byText.get("+new2"), { text: "+new2", diffKind: "add", oldNo: null, newNo: 5 });
  assert.deepStrictEqual(byText.get("-x"), { text: "-x", diffKind: "del", oldNo: 10, newNo: null });
  assert.deepStrictEqual(byText.get("+y"), { text: "+y", diffKind: "add", oldNo: null, newNo: 11 });
  for (const chunkSize of [1, 5]) {
    assert.deepStrictEqual(await streamDiffRows(source, chunkSize), whole, `chunk size ${chunkSize} must match single-shot diff rows`);
  }
}

function findNestedCodeBlock(blocks: readonly Block[]): Block {
  const visit = (snapshot: NodeSnapshot): Block | undefined => {
    if (snapshot.type === "code") return snapshot.props?.block as Block | undefined;
    for (const child of snapshot.children ?? []) {
      const code = visit(child);
      if (code) return code;
    }
    return undefined;
  };
  for (const block of blocks) {
    const code = visit(createBlockSnapshot(block));
    if (code) return code;
  }
  throw new Error("expected nested diff code block");
}

async function streamNestedDiffRows(source: string, chunkSize: number | null): Promise<DiffRow[]> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const docPlugins = {
    footnotes: false,
    html: false,
    mdx: false,
    tables: false,
    callouts: false,
    outputMode: "tokens" as const,
    emitHighlightTokens: true,
    emitDiffBlocks: true,
  };
  applyMessages(store, await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: chunkSize === null ? source : "",
    prewarmLangs: [],
    docPlugins,
  }));
  if (chunkSize !== null) {
    for (let index = 0; index < source.length; index += chunkSize) {
      applyMessages(store, await harness.send({ type: "APPEND", text: source.slice(index, index + chunkSize) }));
    }
  }
  applyMessages(store, await harness.send({ type: "FINALIZE" }));
  const code = findNestedCodeBlock(store.getBlocks());
  return store.getCodeLines(code.id, 0, 64).map((line) => ({
    text: line.text,
    diffKind: line.diffKind,
    oldNo: line.oldNo ?? null,
    newNo: line.newNo ?? null,
  }));
}

async function runNestedChunkedDiffNumberingTest(): Promise<void> {
  const source = [
    "- owner",
    "",
    "  ```diff",
    "  @@ -3,2 +3,3 @@",
    "   ctx",
    "  -old",
    "  +new1",
    "  +new2",
    "  @@ -10 +11 @@",
    "  -x",
    "  +y",
    "  ```",
    "",
  ].join("\n");
  const whole = await streamNestedDiffRows(source, null);
  const byText = new Map(whole.map((row) => [row.text, row]));
  assert.deepStrictEqual(byText.get(" ctx"), { text: " ctx", diffKind: "context", oldNo: 3, newNo: 3 });
  assert.deepStrictEqual(byText.get("+new2"), { text: "+new2", diffKind: "add", oldNo: null, newNo: 5 });
  assert.deepStrictEqual(byText.get("-x"), { text: "-x", diffKind: "del", oldNo: 10, newNo: null });
  assert.deepStrictEqual(byText.get("+y"), { text: "+y", diffKind: "add", oldNo: null, newNo: 11 });
  for (const chunkSize of [1, 5]) {
    assert.deepStrictEqual(
      await streamNestedDiffRows(source, chunkSize),
      whole,
      `nested code chunk size ${chunkSize} must match single-shot diff rows`,
    );
  }
}

// A diff fence renders through the diff renderer whether it is a root block or nested in a list, eager or lazy.
async function runNestedDiffRendererTest(): Promise<void> {
  const fence = ["```diff-js", "@@ -1,2 +1,2 @@", "-const a = 0;", "+const a = 1;", " keep();", "```"];
  const sources = {
    root: fence.join("\n"),
    nested: ["- owner", "", ...fence.map((line) => `  ${line}`)].join("\n"),
  };
  for (const [label, source] of Object.entries(sources)) {
    for (const lazy of [false, true]) {
      const harness = await createWorkerHarness();
      const store = createRendererStore();
      applyMessages(store, await harness.send({
        type: "INIT",
        schemaVersion: STREAM_MDX_SCHEMA_VERSION,
        initialContent: source,
        prewarmLangs: [],
        docPlugins: {
          footnotes: false,
          html: false,
          mdx: false,
          tables: false,
          callouts: false,
          outputMode: "tokens",
          emitHighlightTokens: true,
          emitDiffBlocks: true,
          lazyTokenization: lazy ? { enabled: true, thresholdLines: 1 } : { enabled: false },
        },
      }));
      applyMessages(store, await harness.send({ type: "FINALIZE" }));
      const markup = projectConsumerBlocks(store.getBlocks()).map((block) => block.markup).join("");
      assert.match(markup, /stream-mdx-diff-block/, `${label} ${lazy ? "lazy" : "eager"} diff fence must render through the diff renderer`);
    }
  }
}

await runDiffTokenizationTest();
await runChunkedDiffNumberingTest();
await runNestedChunkedDiffNumberingTest();
await runNestedDiffRendererTest();
console.log("worker-diff-tokenization test passed");
