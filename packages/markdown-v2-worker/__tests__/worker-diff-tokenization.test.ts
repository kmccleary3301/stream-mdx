import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { applyPatchBatch, createInitialSnapshot, type DiffLineKind, type Patch, type TokenLineV1, type WorkerOut } from "@stream-mdx/core";

import { createWorkerHarness } from "./worker-test-harness";

async function runDiffTokenizationTest(): Promise<void> {
  const harness = await createWorkerHarness();

  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
  prewarmLangs: ["typescript"],
  docPlugins: {
    footnotes: false,
    html: false,
    mdx: false,
    tables: false,
    callouts: false,
    codeHighlighting: "incremental",
    outputMode: "tokens",
  }, });
  const init = initMessages.find((msg) => msg.type === "INITIALIZED") as Extract<WorkerOut, { type: "INITIALIZED" }> | undefined;
  assert.ok(init, "worker did not emit INITIALIZED message");
  const snapshot = createInitialSnapshot(init.snapshot);

  const firstChunk = ["```diff ts", "@@ -1,1 +1,1 @@", "-const a = 1;", ""].join("\n");
  const firstMessages = await harness.send({ type: "APPEND", text: firstChunk });
  const firstPatchMessages = firstMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  for (const message of firstPatchMessages) {
    applyPatchBatch(snapshot, message.patches as Patch[]);
  }

  const secondChunk = ["+const a = 2;", "```", ""].join("\n");
  const appendMessages = await harness.send({ type: "APPEND", text: secondChunk });
  const patchMessages = appendMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  for (const message of patchMessages) {
    applyPatchBatch(snapshot, message.patches as Patch[]);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  const finalizePatches = finalizeMessages.filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH");
  for (const message of finalizePatches) {
    applyPatchBatch(snapshot, message.patches as Patch[]);
  }

  const target = Array.from(snapshot.nodes.values()).find((node) => node.type === "code-line" && node.props?.text === "+const a = 2;");
  assert.ok(target, "expected diff code line to be present in snapshot");

  assert.strictEqual(target.props?.diffKind, "add");
  assert.strictEqual(target.props?.newNo, 1);
  assert.strictEqual(target.props?.oldNo ?? null, null);

  const tokenLine = target.props?.tokens as { spans: Array<{ t: string }> } | undefined;
  const tokenText = tokenLine ? tokenLine.spans.map((span) => span.t).join("") : "";
  assert.strictEqual(tokenText, "+const a = 2;", "expected tokens to reconstruct full diff line");

  const deleted = Array.from(snapshot.nodes.values()).find((node) => node.type === "code-line" && node.props?.text === "-const a = 1;");
  assert.ok(deleted, "serialized diff must retain its deletion row");
  assert.strictEqual(deleted.props?.diffKind, "del");
  const docs = readFileSync(new URL("../../../docs/CLI_USAGE.md", import.meta.url), "utf8");
  const ansiExample = [...docs.matchAll(/```ts\n([\s\S]*?)\n```/g)].find((match) => match[1].includes("function renderDiffLine("))?.[1];
  assert.ok(ansiExample, "the authored public CLI ANSI consumer must be exercised");
  const compiled = ts.transpileModule(ansiExample, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const renderDiffLine = runInNewContext(`${compiled}\nrenderDiffLine;`, { exports: {} }) as (text: string, tokens: TokenLineV1 | null, kind?: DiffLineKind | null) => string;
  const deletion = renderDiffLine(String(deleted.props?.text), deleted.props?.tokens as TokenLineV1, deleted.props?.diffKind as DiffLineKind);
  assert.ok(deletion.startsWith("\u001b[41m"), "the copied CLI consumer must apply deletion background to the actual serialized del row");
  assert.strictEqual(deletion.replace(/\u001b\[[0-9;]*m/g, ""), "-const a = 1;", "the copied CLI consumer must retain actual deletion content");
  assert.ok(deletion.endsWith("\u001b[0m"), "the copied CLI consumer must reset deletion styling");
  const addition = renderDiffLine(String(target.props?.text), target.props?.tokens as TokenLineV1, target.props?.diffKind as DiffLineKind);
  assert.ok(addition.startsWith("\u001b[42m"), "the same consumer must keep addition background distinct");
}

await runDiffTokenizationTest();
console.log("worker-diff-tokenization test passed");
