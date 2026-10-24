import assert from "node:assert";
import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import type { Block, HtmlTreeNode, NodeSnapshot, Patch, WorkerOut } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { MarkdownEngine } from "../src/engine/engine";

const CODE_LINE_COUNT = 600;
const VISIBLE_END_LINE = 260;
function findCodeBlock(blocks: readonly Block[]): Block | undefined {
  const visitTree = (tree: readonly HtmlTreeNode[]): Block | undefined => {
    for (const node of tree) {
      const found = node.kind === "block" ? visitBlock(node.block)
        : node.kind === "element" || node.kind === "component" ? visitTree(node.children) : undefined;
      if (found) return found;
    }
    return undefined;
  };
  const visitSnapshots = (children: readonly NodeSnapshot[]): Block | undefined => {
    for (const snapshot of children) {
      const block = snapshot.props?.block as Block | undefined;
      const found = block ? visitBlock(block) : undefined;
      if (found) return found;
      if (snapshot.type !== "code") {
        const nested = visitSnapshots(snapshot.children ?? []);
        if (nested) return nested;
      }
    }
    return undefined;
  };
  const visitBlock = (block: Block): Block | undefined => {
    if (block.type === "code") return block;
    const meta = block.payload.meta;
    const prepared = meta?.preparedNested as { children?: readonly NodeSnapshot[] } | undefined;
    const nested = prepared ? visitSnapshots(prepared.children ?? []) : undefined;
    if (nested) return nested;
    for (const key of ["htmlTree", "htmlParagraphTree"]) {
      const tree = meta?.[key] as HtmlTreeNode[] | undefined;
      if (tree) {
        const found = visitTree(tree);
        if (found) return found;
      }
    }
    return undefined;
  };
  for (const block of blocks) {
    const found = visitBlock(block);
    if (found) return found;
  }
  return undefined;
}

function buildSnippet(lineCount: number): string {
  const lines = Array.from({ length: lineCount }, (_, index) => `const value${index} = ${index};`);
  return ["```js", ...lines, "```"].join("\n");
}

async function main(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: dom.window });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, writable: true, value: dom.window.Node });

  const store = createRendererStore();
  let tracking = false;
  let codeBlockId = "";
  let visibleRequestSent = false;
  let visibleRangeReached = false;
  let orderingViolation: string | undefined;
  let previousFrontier = 0;
  const frontiers: number[] = [];
  let resolveComplete!: () => void;
  const complete = new Promise<void>((resolve) => { resolveComplete = resolve; });
  let engine!: MarkdownEngine;

  engine = new MarkdownEngine({
    post(message: WorkerOut) {
      if (message.type === "INITIALIZED") {
        store.resetSnapshot(message.snapshot);
        return;
      }
      if (message.type !== "PATCH") return;
      store.applyPatches(message.patches as Patch[], { captureMetrics: false });
      if (!tracking) return;

      const block = store.getBlocks().find((candidate) => candidate.id === codeBlockId);
      const frontier = block?.payload.meta?.lazyTokenizedUntil;
      if (typeof frontier !== "number" || frontier <= previousFrontier) return;
      frontiers.push(frontier);
      previousFrontier = frontier;

      if (!visibleRequestSent) {
        if (frontier >= VISIBLE_END_LINE) {
          orderingViolation = `background prefetch reached ${frontier} before the visible request arrived`;
        }
        visibleRequestSent = true;
        void engine.handle({
          type: "TOKENIZE_RANGE",
          blockId: codeBlockId,
          startLine: VISIBLE_END_LINE - 10,
          endLine: VISIBLE_END_LINE,
          priority: "visible",
        });
      } else if (!visibleRangeReached && frontier >= VISIBLE_END_LINE) {
        if (frontier !== VISIBLE_END_LINE) {
          orderingViolation = `background prefetch advanced to ${frontier} before the visible range ended at ${VISIBLE_END_LINE}`;
        }
        visibleRangeReached = frontier === VISIBLE_END_LINE;
      }

      if (frontier === CODE_LINE_COUNT) resolveComplete();
    },
  });

  try {
    await engine.handle({
      type: "INIT",
      schemaVersion: STREAM_MDX_SCHEMA_VERSION,
      initialContent: "",
      contentPolicy: "trusted-mdx",
      docPlugins: {
        html: true,
        mdx: true,
        math: false,
        tables: false,
        callouts: false,
        lazyTokenization: { enabled: true, thresholdLines: 50 },
      },
    });
    await engine.handle({ type: "APPEND", text: buildSnippet(CODE_LINE_COUNT) });
    await engine.handle({ type: "FINALIZE" });

    const codeBlock = findCodeBlock(store.getBlocks());
    assert.ok(codeBlock, "expected a finalized code block");
    codeBlockId = codeBlock.id;
    tracking = true;

    await engine.handle({
      type: "TOKENIZE_RANGE",
      blockId: codeBlockId,
      startLine: 0,
      endLine: CODE_LINE_COUNT,
      priority: "prefetch",
    });
    await complete;

    assert.strictEqual(visibleRequestSent, true, "worker must publish a prefetch slice before processing the later visible request");
    assert.strictEqual(visibleRangeReached, true, `visible demand must finish before background prefetch resumes: ${JSON.stringify({ visibleRequestSent, visibleRangeReached, orderingViolation, frontiers })}`);
    assert.strictEqual(orderingViolation, undefined, orderingViolation);
    assert.ok(frontiers.length > 1, "a large prefetch must publish multiple bounded slices");
    for (let index = 1; index < frontiers.length; index += 1) {
      assert.ok(frontiers[index]! > frontiers[index - 1]!, "tokenized line progress must not duplicate or move backwards");
      assert.ok(frontiers[index]! - frontiers[index - 1]! <= 128, "each tokenization slice must stay within the bounded line cap");
    }
    assert.strictEqual(frontiers.at(-1), CODE_LINE_COUNT, "the full background range must eventually complete");

    const lines = store.getCodeLines(codeBlockId, 0, CODE_LINE_COUNT);
    assert.strictEqual(lines.length, CODE_LINE_COUNT);
    assert.ok(lines.every((line) => line.decoration), "every requested source line must retain its token decoration");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      assert.strictEqual(line.decoration?.index, index, `line ${index} must be tokenized exactly at its source index`);
      assert.strictEqual(
        line.decoration?.tokens.spans.map((span) => span.t).join(""),
        line.text,
        `line ${index} must preserve its authored text in the token stream`,
      );
    }

    console.log("lazy tokenization preemption test passed");
  } finally {
    engine.dispose();
    dom.window.close();
  }
}

await main();
