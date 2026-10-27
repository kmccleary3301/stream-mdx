import assert from "node:assert/strict";
import {
  STREAM_MDX_SCHEMA_VERSION,
  type Block,
  type InlineNode,
  type WorkerIn,
  type WorkerOut,
} from "@stream-mdx/core";
import { createRendererStore, type RendererStore } from "@stream-mdx/react/renderer/store";
import { createMarkdownSnapshotCompiler } from "../src/direct-compile";
import { MarkdownEngine } from "../src/engine/engine";
import type { EngineExtensions } from "../src/engine/types";

const RICH_PARAGRAPH = "***x*** **y** *z* `c` [l](x)";
const PARAGRAPH_CASES = [
  {
    name: "bullet-list reproduction",
    source: "- one\n- two\n\nan ending paragraph with ***nested style*** active",
    paragraphText: "an ending paragraph with ***nested style*** active",
    requireCodeAndLink: false,
  },
  {
    name: "bullet list",
    source: `- a\n- b\n\n${RICH_PARAGRAPH}`,
    paragraphText: RICH_PARAGRAPH,
    requireCodeAndLink: true,
  },
  {
    name: "ordered list",
    source: `1. a\n2. b\n\n${RICH_PARAGRAPH}`,
    paragraphText: RICH_PARAGRAPH,
    requireCodeAndLink: true,
  },
  {
    name: "nested list",
    source: `- a\n  - b\n\n${RICH_PARAGRAPH}`,
    paragraphText: RICH_PARAGRAPH,
    requireCodeAndLink: true,
  },
  {
    name: "blockquote",
    source: `> q\n\n${RICH_PARAGRAPH}`,
    paragraphText: RICH_PARAGRAPH,
    requireCodeAndLink: true,
  },
  {
    name: "table",
    source: `|a|\n|---|\n|b|\n\n${RICH_PARAGRAPH}`,
    paragraphText: RICH_PARAGRAPH,
    requireCodeAndLink: true,
  },
];
const DOC_PLUGINS = {
  tables: true,
  math: true,
  html: true,
  footnotes: true,
  callouts: "github-alerts" as const,
  softBreaks: "preserve" as const,
  codeHighlighting: "incremental" as const,
};
const NOOP_EXTENSIONS = {
  inline: [{ name: "no-op-inline", lezer: {}, toInline: () => undefined }],
  documentPlugins: [{ name: "no-op", process: () => undefined }],
} satisfies EngineExtensions;

function flattenInline(nodes: readonly InlineNode[], flattened: InlineNode[] = []): InlineNode[] {
  for (const node of nodes) {
    flattened.push(node);
    if ("children" in node) flattenInline(node.children, flattened);
  }
  return flattened;
}

function assertRichParagraph(
  blocks: readonly Block[],
  paragraphText: string,
  requireCodeAndLink: boolean,
  label: string,
): void {
  const paragraphs = blocks.filter((block) => block.type === "paragraph");
  assert.equal(paragraphs.length, 1, `${label}: expected one root paragraph after its container`);
  const paragraph = paragraphs[0]!;
  assert.equal(paragraph.payload.raw, paragraphText, `${label}: paragraph source`);
  const nodes = flattenInline(paragraph.payload.inline ?? []);
  assert.ok(nodes.some((node) => node.kind === "strong"), `${label}: paragraph has a strong node`);
  assert.ok(nodes.some((node) => node.kind === "em"), `${label}: paragraph has an emphasis node`);
  if (requireCodeAndLink) {
    assert.ok(nodes.some((node) => node.kind === "code"), `${label}: paragraph has an inline-code node`);
    assert.ok(nodes.some((node) => node.kind === "link"), `${label}: paragraph has a link node`);
  }
}

function assertNoErrors(messages: readonly WorkerOut[], context: string): void {
  for (const message of messages) {
    if (message.type === "ERROR") {
      assert.fail(`Worker error during ${context} (${message.phase}): ${message.error.message}`);
    }
  }
}

function applyPatches(store: RendererStore, messages: readonly WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "PATCH") store.applyPatches(message.patches, { captureMetrics: false });
  }
}

async function runStreaming(
  chunks: readonly string[],
  listIndentation: boolean,
  useExtensions: boolean,
  htmlMode: "literal" | "sanitize",
): Promise<Block[]> {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({
    post: (message) => messages.push(message),
    ...(useExtensions ? { extensions: NOOP_EXTENSIONS } : {}),
  });
  const store = createRendererStore();
  const send = async (message: WorkerIn): Promise<WorkerOut[]> => {
    messages.length = 0;
    await engine.handle(message);
    const sent = messages.splice(0);
    assertNoErrors(sent, message.type);
    return sent;
  };

  try {
    const initializedMessages = await send({
      type: "INIT",
      schemaVersion: STREAM_MDX_SCHEMA_VERSION,
      initialContent: "",
      prewarmLangs: [],
      docPlugins: { ...DOC_PLUGINS, listIndentation },
      html: { mode: htmlMode },
    });
    const initialized = initializedMessages.find(
      (message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED",
    );
    assert.ok(initialized, "streaming engine must initialize before applying patches");
    store.resetSnapshot(initialized.snapshot);
    applyPatches(store, initializedMessages);

    for (const text of chunks) {
      applyPatches(store, await send({ type: "APPEND", text }));
    }

    const finalizedMessages = await send({ type: "FINALIZE" });
    applyPatches(store, finalizedMessages);
    assert.equal(finalizedMessages.at(-1)?.type, "FINALIZED", "streaming engine must emit FINALIZED");
    return store.getBlocks();
  } finally {
    engine.dispose();
  }
}

for (const listIndentation of [false, true]) {
  for (const useExtensions of [false, true]) {
    for (const htmlMode of ["literal", "sanitize"] as const) {
      for (const testCase of PARAGRAPH_CASES) {
        const label = `${testCase.name}, listIndentation=${listIndentation}, extensions=${useExtensions}, html=${htmlMode}`;
        const compiler = createMarkdownSnapshotCompiler({
          extensionId: `paragraph-after-container-inline-${label}`,
          ...(useExtensions ? { extensions: NOOP_EXTENSIONS } : {}),
        });
        const compiled = await compiler.compile({
          text: testCase.source,
          init: {
            docPlugins: { ...DOC_PLUGINS, listIndentation },
            html: { mode: htmlMode },
            prewarmLangs: [],
          },
        });
        assertRichParagraph(compiled.blocks, testCase.paragraphText, testCase.requireCodeAndLink, `${label}, one-shot`);

        for (let split = 1; split < testCase.source.length; split += 1) {
          const streamed = await runStreaming(
            [testCase.source.slice(0, split), testCase.source.slice(split)],
            listIndentation,
            useExtensions,
            htmlMode,
          );
          assertRichParagraph(
            streamed,
            testCase.paragraphText,
            testCase.requireCodeAndLink,
            `${label}, split ${split}`,
          );
        }
      }
    }
  }
}

console.log("paragraph-after-container inline regressions passed");
