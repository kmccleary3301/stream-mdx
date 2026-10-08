import assert from "node:assert";
import { applyPatchBatch, createInitialSnapshot, extractHighlightedLines, sanitizeCodeHTML, type Block, type CodeHighlightOutputMode, type Patch, type WorkerOut } from "@stream-mdx/core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComponentRegistry, MarkdownBlocksRenderer, type CodeFenceRendererProps } from "@stream-mdx/react/server";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";
import { JSDOM } from "jsdom";

function buildSnippet(lineCount: number): string {
  const lines = Array.from({ length: lineCount }, (_, idx) => `const value_${idx} = ${idx};`);
  return ["```js", ...lines, "```"].join("\n");
}

function stripOuterLineSpan(html: string): string | null {
  const openTag = '<span class="line"';
  const startIndex = html.indexOf(openTag);
  if (startIndex === -1) return null;
  const contentStart = html.indexOf(">", startIndex);
  if (contentStart === -1) return null;
  const endIndex = html.lastIndexOf("</span>");
  if (endIndex === -1 || endIndex < contentStart) return null;
  return html.slice(contentStart + 1, endIndex);
}

function sanitizeLineInnerHtml(innerHtml: string | null, fallbackText: string): string {
  if (innerHtml && innerHtml.trim().length > 0) {
    const wrapped = `<span class=\"line\">${innerHtml}</span>`;
    const sanitized = sanitizeCodeHTML(wrapped);
    const inner = stripOuterLineSpan(typeof sanitized === "string" ? sanitized : String(sanitized));
    if (inner !== null) {
      return inner;
    }
  }
  return fallbackText;
}

async function renderWithWorker(snippet: string, lazyEnabled: boolean, outputMode: CodeHighlightOutputMode = "html") {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: {
      html: true,
      mdx: false,
      math: false,
      tables: false,
      callouts: false,
      outputMode,
      emitHighlightTokens: true,
      footnotes: false,
      lazyTokenization: { enabled: lazyEnabled, thresholdLines: 10 },
    },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not initialize");
  store.reset(init.blocks);
  const document = createInitialSnapshot(init.blocks);
  const consume = (messages: WorkerOut[]) => {
    for (const message of messages) {
      if (message.type === "PATCH") {
        applyPatchBatch(document, message.patches);
        store.applyPatches(message.patches, { captureMetrics: false });
      } else if (message.type === "ERROR") {
        throw new Error(message.error.message);
      }
    }
    assert.deepStrictEqual(document.blocks, store.getBlocks(), "core and React must retain the same lazy nested artifact");
    assert.deepStrictEqual(store.getInvariantViolations(), []);
  };

  const appendMessages = await harness.send({ type: "APPEND", text: snippet });
  consume(appendMessages);

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  consume(finalizeMessages);

  return { store, harness, document, consume };
}

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;

  const snippet = buildSnippet(60);

  const fullRender = await renderWithWorker(snippet, false);
  const fullBlock = fullRender.store.getBlocks().find((block) => block.type === "code");
  assert.ok(fullBlock, "missing full highlight code block");
  const fullLinesRaw = extractHighlightedLines(fullBlock.payload.highlightedHtml ?? "", 60);
  const codeLines = snippet.split("\n").slice(1, -1);
  const fullLines = fullLinesRaw.map((line, idx) => sanitizeLineInnerHtml(line, codeLines[idx] ?? ""));

  const lazyRender = await renderWithWorker(snippet, true);
  const lazyBlock = lazyRender.store.getBlocks().find((block) => block.type === "code");
  assert.ok(lazyBlock, "missing lazy highlight code block");

  const rangeMessages = await lazyRender.harness.send({
    type: "TOKENIZE_RANGE",
    blockId: lazyBlock.id,
    startLine: 0,
    endLine: codeLines.length,
    priority: "visible",
  });
  rangeMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => lazyRender.store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  const sampleIndices = [0, 1, 2, codeLines.length - 3, codeLines.length - 2, codeLines.length - 1].filter(
    (idx) => idx >= 0 && idx < codeLines.length,
  );
  for (const idx of sampleIndices) {
    const node = lazyRender.store.getNode(`${lazyBlock.id}::line:${idx}`);
    const html = node?.props?.html as string | undefined;
    assert.ok(html, `missing html for line ${idx}`);
    assert.strictEqual(html, fullLines[idx], `lazy line ${idx} should match full highlight`);
  }

  console.log("lazy tokenization parity test passed");
}

async function runNestedLazyConsumers(): Promise<void> {
  const lines = ["/* open", ...Array.from({ length: 217 }, (_, index) => `  carried_${index}`), "*/", "const tail = 219;"];
  const snippet = ["- outer", "", "  > ```js", ...lines.map((line) => `  > ${line}`), "  > ```"].join("\n");
  const getCode = (blocks: readonly Block[]): Block => {
    const document = createInitialSnapshot(blocks as Block[]);
    const node = [...document.nodes.values()].find((node) => node.type === "code");
    assert.ok(node, "prepared code must be addressable below the root container");
    const block = node.block;
    assert.ok(block);
    return block;
  };
  for (const outputMode of ["tokens", "both"] as const) {
    const full = await renderWithWorker(snippet, false, outputMode);
    const fullCode = getCode(full.store.getBlocks());
    const lazy = await renderWithWorker(snippet, true, outputMode);
    const code = getCode(lazy.store.getBlocks());
    assert.ok(!lazy.store.getBlocks().some((root) => root.id === code.id), "the request must target a descendant ID, not an accidental top-level code block");
    assert.strictEqual(code.isFinalized, true);
    assert.strictEqual(code.payload.meta?.code, lines.join("\n"), "nested container indentation must not leak into highlight input");
    assert.strictEqual(code.payload.meta?.lazyTokenization, true);
    assert.strictEqual(code.payload.meta?.lazyTokenizedUntil, 0);
    assert.strictEqual(lazy.store.getChildren(code.id).length, lines.length, "producer must emit every code-line before lazy highlighting");
    let notifications = 0;
    const unsubscribe = lazy.store.subscribe(() => notifications++);
    const captured: CodeFenceRendererProps[] = [];
    const registry = new ComponentRegistry({}, {}, { js: (props: CodeFenceRendererProps) => {
      captured.push(props);
      return React.createElement("section", { "data-owned-code": props.blockId }, props.renderCode);
    } });
    const render = () => renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: lazy.store.getBlocks(), store: lazy.store, componentRegistry: registry }));
    render();
    const before = captured.at(-1);
    assert.ok(before);
    assert.strictEqual(before.code, lines.join("\n"));
    assert.strictEqual(before.isFinalized, true);
    assert.strictEqual(before.meta?.lazyTokenizedUntil, 0);
    const request = async (startLine: number, endLine: number) => {
      const messages = await lazy.harness.send({ type: "TOKENIZE_RANGE", blockId: code.id, startLine, endLine, priority: "visible" });
      assert.ok(messages.some((message) => message.type === "PATCH"), "a descendant highlight request must emit real transport patches");
      lazy.consume(messages);
    };
    await request(0, 20);
    assert.strictEqual(getCode(lazy.store.getBlocks()).payload.meta?.lazyTokenizedUntil, 20);
    assert.strictEqual(lazy.store.getNode(`${code.id}::line:219`)?.props?.tokens, null, "tail remains uncolored until requested");
    await request(200, lines.length);
    const completed = getCode(lazy.store.getBlocks());
    assert.strictEqual(completed.payload.meta?.lazyTokenizedUntil, lines.length);
    assert.deepStrictEqual(completed.payload.meta?.tokenLines, fullCode.payload.meta?.tokenLines, "continued grammar state and final tail colors must match a full compile");
    for (const index of [0, 19, 20, 217, 218, 219]) {
      const actual = lazy.store.getNode(`${code.id}::line:${index}`);
      const expected = full.store.getNode(`${fullCode.id}::line:${index}`);
      assert.deepStrictEqual(actual?.props?.tokens, expected?.props?.tokens);
      assert.strictEqual(actual?.props?.html, expected?.props?.html, "canonical line HTML must match full compile in each mode");
    }
    const html = render();
    const after = captured.at(-1);
    assert.ok(after);
    assert.strictEqual(after.meta?.lazyTokenizedUntil, lines.length, "custom code callback must receive updated descendant metadata");
    assert.deepStrictEqual(after.meta?.tokenLines, fullCode.payload.meta?.tokenLines);
    assert.ok(captured.length >= 2);
    assert.ok(notifications >= 2, "React store subscribers must observe descendant request updates");
    const dom = new JSDOM(html);
    assert.strictEqual(dom.window.document.querySelectorAll(".line").length, lines.length, "lazy code view must render its full producer-owned line rows");
    assert.ok(dom.window.document.body.textContent?.includes("const tail = 219;"));
    dom.window.close();
    const published = JSON.stringify(lazy.store.getBlocks());
    lazy.consume(await lazy.harness.send({ type: "APPEND", text: "\n\nFollowing\n" }));
    assert.strictEqual(getCode(lazy.store.getBlocks()).payload.meta?.lazyTokenizedUntil, lines.length, "append must retain descendant lazy state");
    lazy.consume(await lazy.harness.send({ type: "FINALIZE" }));
    assert.deepStrictEqual(getCode(lazy.store.getBlocks()).payload.meta?.tokenLines, fullCode.payload.meta?.tokenLines);
    const serialized = JSON.parse(JSON.stringify(lazy.store.getBlocks())) as Block[];
    const reset = createRendererStore(serialized);
    assert.strictEqual(reset.getChildren(code.id).length, lines.length);
    assert.deepStrictEqual(getCode(reset.getBlocks()).payload.meta?.tokenLines, fullCode.payload.meta?.tokenLines, "serialized nested snapshots must retain fully highlighted child metadata");
    assert.notStrictEqual(JSON.stringify(serialized), published, "the appended paragraph remains visible beside the highlighted owning root");
    assert.deepStrictEqual(reset.getInvariantViolations(), []);
    unsubscribe();
  }
}

await main();
await runNestedLazyConsumers();
console.log("nested lazy tokenization consumer parity passed");
