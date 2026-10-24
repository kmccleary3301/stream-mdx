import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { STREAM_MDX_SCHEMA_VERSION, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine, createRendererStore } from "./diagnostic-dist/index.mjs";

const PREFIX_LINES_N = 256;
const REQUESTED_LINES = 10;
const LINE_NAME_WIDTH = 20;
const GATE_RATIO = 1.25;

function fixedCodeLine(label: string, value: number): string {
  const name = label.padEnd(LINE_NAME_WIDTH, "_").slice(0, LINE_NAME_WIDTH);
  return `const ${name} = ${String(value).padStart(6, "0")};`;
}

function codeFixture(prefixLines: number): { readonly source: string; readonly requested: readonly string[] } {
  const prefix = Array.from({ length: prefixLines }, (_, index) =>
    fixedCodeLine(`prefix_${String(index).padStart(6, "0")}`, index),
  );
  const requested = Array.from({ length: REQUESTED_LINES }, (_, index) =>
    fixedCodeLine(`visible_${String(index).padStart(6, "0")}`, 9000 + index),
  );
  return {
    source: ["```ts", ...prefix, ...requested, "```"].join("\n"),
    requested,
  };
}

async function measure(prefixLines: number): Promise<{ readonly prefixLines: number; readonly patchBytes: number }> {
  const fixture = codeFixture(prefixLines);
  const store = createRendererStore();
  const rangePatches: Extract<WorkerOut, { type: "PATCH" }>[] = [];
  let capturingRange = false;
  const errors: string[] = [];
  const engine = new MarkdownEngine({
    post(message: WorkerOut) {
      if (message.type === "INITIALIZED") {
        store.resetSnapshot(message.snapshot);
        return;
      }
      if (message.type === "PATCH") {
        if (capturingRange) rangePatches.push(message);
        store.applyPatches(message.patches);
        return;
      }
      if (message.type === "ERROR") errors.push(message.error.message);
    },
  });

  const initialize: Extract<WorkerIn, { type: "INIT" }> = {
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: {
      html: true,
      mdx: false,
      math: false,
      tables: false,
      callouts: false,
      lazyTokenization: { enabled: true, thresholdLines: 50 },
      outputMode: "tokens",
      emitHighlightTokens: true,
      emitDiffBlocks: false,
    },
  };
  try {
    await engine.handle(initialize);
    await engine.handle({ type: "APPEND", text: fixture.source });
    await engine.handle({ type: "FINALIZE" });
    assert.deepStrictEqual(errors, [], "engine initialization and finalization must succeed");

    const codeBlock = store.getBlocks().find((block) => block.type === "code");
    assert.ok(codeBlock, "finalized lazy code block must be present in the public store");
    assert.strictEqual(codeBlock.payload.meta?.lazyTokenization, true, "fixture must use lazy highlighting");
    const code = store.getCodeBlock(codeBlock.id);
    assert.ok(code, "finalized code must have a native source owner");
    assert.strictEqual(code.source.lineCount, prefixLines + REQUESTED_LINES);
    assert.deepStrictEqual(
      store.getCodeLines(codeBlock.id, prefixLines, prefixLines + REQUESTED_LINES).map((line) => line.text),
      fixture.requested,
      "the requested source window must match the fixed fixture",
    );
    assert.ok(
      store.getCodeLines(codeBlock.id, prefixLines, prefixLines + REQUESTED_LINES).every((line) => !line.decoration),
      "lazy code must be undecorated before the requested range",
    );
    const childIdsBefore = store.getChildren(codeBlock.id);

    capturingRange = true;
    await engine.handle({
      type: "TOKENIZE_RANGE",
      blockId: codeBlock.id,
      startLine: prefixLines,
      endLine: prefixLines + REQUESTED_LINES,
      priority: "visible",
    });
    capturingRange = false;
    assert.deepStrictEqual(errors, [], "range tokenization must succeed");

    const requestedAfter = store.getCodeLines(codeBlock.id, prefixLines, prefixLines + REQUESTED_LINES);
    assert.deepStrictEqual(requestedAfter.map((line) => line.text), fixture.requested);
    assert.ok(requestedAfter.every((line) => line.decoration), "all requested native source lines must be highlighted");
    assert.ok(
      requestedAfter.every((line) => line.decoration?.tokens.spans.map((span) => span.t).join("") === line.text),
      "native source decorations must preserve each requested line's token text",
    );
    assert.deepStrictEqual(store.getChildren(codeBlock.id), childIdsBefore, "range demand must not add code-line AST records");

    const patchBytes = rangePatches.reduce(
      (total, message) => total + Buffer.byteLength(JSON.stringify(message), "utf8"),
      0,
    );
    return { prefixLines, patchBytes };
  } finally {
    engine.dispose();
  }
}

async function main(): Promise<void> {
  const n = await measure(PREFIX_LINES_N);
  const fourN = await measure(PREFIX_LINES_N * 4);
  const ratio = fourN.patchBytes / Math.max(1, n.patchBytes);
  console.log(JSON.stringify({ metric: "TOKENIZE_RANGE PATCH UTF-8 JSON bytes", requestedLines: REQUESTED_LINES, n, fourN, ratio, gate: GATE_RATIO }, null, 2));
  assert.ok(
    ratio <= GATE_RATIO,
    `fixed-range PATCH bytes scaled with prefix size: 4N/N=${ratio.toFixed(3)} exceeds ${GATE_RATIO}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
