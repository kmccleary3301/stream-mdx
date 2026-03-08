import assert from "node:assert";
import type { Patch, WorkerOut } from "@stream-mdx/core";
import { extractHighlightedLines, sanitizeCodeHTML } from "@stream-mdx/core";
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

async function renderWithWorker(snippet: string, lazyEnabled: boolean) {
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
      lazyTokenization: { enabled: lazyEnabled, thresholdLines: 10 },
    },
  });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not initialize");
  store.reset(init.blocks);

  const appendMessages = await harness.send({ type: "APPEND", text: snippet });
  appendMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  finalizeMessages
    .filter((msg): msg is Extract<WorkerOut, { type: "PATCH" }> => msg.type === "PATCH")
    .forEach((msg) => store.applyPatches(msg.patches as Patch[], { captureMetrics: false }));

  return { store, harness };
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

await main();
