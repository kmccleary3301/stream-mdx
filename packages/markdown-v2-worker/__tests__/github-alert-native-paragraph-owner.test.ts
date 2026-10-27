import assert from "node:assert/strict";
import { STREAM_MDX_SCHEMA_VERSION, type Block, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { createMarkdownSnapshotCompiler } from "../src/direct-compile";
import { MarkdownEngine } from "../src/engine/engine";
import type { EngineExtensions } from "../src/engine/types";

const INIT = {
  docPlugins: {
    tables: true,
    math: true,
    html: true,
    footnotes: true,
    callouts: "github-alerts",
    listIndentation: true,
    softBreaks: "preserve",
    codeHighlighting: "incremental",
  },
  prewarmLangs: [],
  html: {
    mode: "sanitize",
    unmatchedAnchors: "literal-bare",
    standaloneSvg: "code",
  },
} as const;

const NOOP_EXTENSIONS = {
  inline: [{ name: "no-op-inline", lezer: {}, toInline: () => undefined }],
  documentPlugins: [{ name: "no-op", process: () => undefined }],
} satisfies EngineExtensions;

const CASES = [
  {
    label: "note",
    source: "> [!NOTE]\n> The content of the note.",
    kind: "note",
    bodyText: ["The content of the note."],
  },
  {
    label: "warning with nested blocks",
    source: "> [!WARNING]\n>\n> ### A heading\n>\n> And a paragraph.",
    kind: "warning",
    bodyText: ["A heading", "And a paragraph."],
  },
  {
    label: "lower-case note marker",
    source: "> [!note]\n> text",
    kind: "note",
    bodyText: ["text"],
  },
  {
    label: "bold tip",
    source: "> [!TIP]\n> **bold** content",
    kind: "tip",
    bodyText: ["bold", "content"],
  },
] as const;

function semanticProjection(blocks: readonly Block[]): unknown[] {
  return blocks.map((block) => ({
    type: block.type,
    raw: block.payload.raw,
    calloutKind: block.payload.meta?.calloutKind,
    inline: block.payload.inline,
  }));
}

function assertCalloutBody(blocks: readonly Block[], calloutKind: string, bodyText: readonly string[], context: string): void {
  const callout = blocks.find((block) => block.type === "callout");
  assert.ok(callout, `${context}: recognized alert must become a callout`);
  assert.equal(callout.payload.meta?.calloutKind, calloutKind, `${context}: callout kind`);
  const inline = JSON.stringify(callout.payload.inline ?? []);
  assert.doesNotMatch(inline, /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i, `${context}: inline callout body must omit the marker`);
  for (const text of bodyText) {
    assert.ok(inline.includes(text), `${context}: inline callout body must contain ${JSON.stringify(text)}`);
  }
}

function assertNoErrors(messages: readonly WorkerOut[], context: string): void {
  for (const message of messages) {
    if (message.type === "ERROR") {
      assert.fail(`${context}: ${message.phase} error: ${message.error.message}`);
    }
  }
}

async function compileOneShot(source: string, useExtensions: boolean): Promise<Block[]> {
  const compiler = createMarkdownSnapshotCompiler({
    ...(useExtensions ? { extensions: NOOP_EXTENSIONS } : {}),
    extensionId: useExtensions ? "github-alert-owner-extensions" : "github-alert-owner-plain",
  });
  const result = await compiler.compile({ text: source, init: INIT });
  return result.blocks;
}

async function compileStreaming(source: string, useExtensions: boolean, split: number): Promise<Block[]> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({
    ...(useExtensions ? { extensions: NOOP_EXTENSIONS } : {}),
    post: (message) => messages.push(message),
  });
  const store = createRendererStore();
  const send = async (message: WorkerIn): Promise<WorkerOut[]> => {
    await engine.handle(message);
    const received = messages.splice(0);
    assertNoErrors(received, `stream ${useExtensions ? "with" : "without"} extensions at split ${split}`);
    return received;
  };
  const apply = (received: readonly WorkerOut[]): void => {
    for (const message of received) {
      if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
    }
  };

  const initialized = await send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    ...INIT,
  });
  const initialSnapshot = initialized.find(
    (message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED",
  );
  assert.ok(initialSnapshot, "streaming engine must initialize before appending alert content");
  store.resetSnapshot(initialSnapshot.snapshot);
  apply(initialized);

  for (const chunk of [source.slice(0, split), source.slice(split)]) {
    apply(await send({ type: "APPEND", text: chunk }));
  }
  const finalized = await send({ type: "FINALIZE" });
  apply(finalized);
  assert.equal(finalized.at(-1)?.type, "FINALIZED", "streaming engine must finalize after alert content");
  return store.getBlocks();
}

for (const testCase of CASES) {
  const extendedOneShot = await compileOneShot(testCase.source, true);
  assertCalloutBody(extendedOneShot, testCase.kind, testCase.bodyText, `${testCase.label}, one-shot with extensions`);
  const expected = semanticProjection(extendedOneShot);

  for (const useExtensions of [true, false]) {
    const mode = useExtensions ? "with extensions" : "without extensions";
    const oneShot = useExtensions ? extendedOneShot : await compileOneShot(testCase.source, false);
    assertCalloutBody(oneShot, testCase.kind, testCase.bodyText, `${testCase.label}, one-shot ${mode}`);
    assert.deepEqual(semanticProjection(oneShot), expected, `${testCase.label}: one-shot ${mode} must match the extended result`);

    for (let split = 0; split <= testCase.source.length; split += 1) {
      const streamed = await compileStreaming(testCase.source, useExtensions, split);
      assertCalloutBody(streamed, testCase.kind, testCase.bodyText, `${testCase.label}, streaming ${mode}, split ${split}`);
      assert.deepEqual(
        semanticProjection(streamed),
        expected,
        `${testCase.label}: streaming ${mode} must match the extended result at split ${split}`,
      );
    }
  }
}

console.log("GitHub alert native paragraph owner regressions passed");
