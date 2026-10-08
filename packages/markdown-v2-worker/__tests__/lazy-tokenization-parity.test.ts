import assert from "node:assert";
import { applyPatchBatch, createInitialSnapshot, extractHighlightedLines, sanitizeCodeHTML, type Block, type CodeHighlightOutputMode, type DiffBlock, type HtmlTreeNode, type Patch, type TokenLineV1, type WorkerOut } from "@stream-mdx/core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComponentRegistry, MarkdownBlocksRenderer, type BlockComponents, type CodeFenceRendererProps } from "@stream-mdx/react/server";
import { createRendererStore, type RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";
import { JSDOM } from "jsdom";
import { CODE_HIGHLIGHT_THEMES, getSharedHighlighter } from "../src/engine/highlight";
import type { ShikiThemedToken } from "../src/engine/types";

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

async function renderWithWorker(snippet: string, lazyEnabled: boolean, outputMode: CodeHighlightOutputMode = "html", emitDiffBlocks = false) {
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
      emitDiffBlocks,
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
  const findCode = (blocks: readonly Block[]): Block | undefined => {
    const document = createInitialSnapshot(blocks as Block[]);
    const code = [...document.nodes.values()].find((node) => node.type === "code")?.block;
    if (code) return code;
    const findTree = (tree: HtmlTreeNode[]): Block | undefined => {
      for (const node of tree) {
        const block = node.kind === "block" ? findCode([node.block])
          : node.kind === "element" ? findTree(node.children) : undefined;
        if (block) return block;
      }
      return undefined;
    };
    for (const node of document.nodes.values()) {
      for (const key of ["htmlTree", "htmlParagraphTree"]) {
        const tree = node.block?.payload.meta?.[key] as HtmlTreeNode[] | undefined;
        const owned = tree ? findTree(tree) : undefined;
        if (owned) return owned;
      }
    }
    return undefined;
  };
  const getCode = (blocks: readonly Block[]): Block => {
    const block = findCode(blocks);
    assert.ok(block, "serialized prepared or HTML-owned code must remain available to its real consumer");
    return block;
  };
  const codeStore = (store: RendererStore) => {
    const block = getCode(store.getBlocks());
    return store.getNode(block.id) ? store : createRendererStore([block]);
  };
  for (const [ownership, outputMode] of [
    ["prepared", "tokens"], ["prepared", "both"],
    ["html", "tokens"], ["html", "both"],
    ["root-html", "tokens"], ["root-html", "both"],
  ] as const) {
    const codeLines = ["```js", ...lines, "```"];
    const ownedLines = ["<div>", "", ...codeLines, "", "</div>"];
    const snippet = ownership === "root-html" ? ownedLines.join("\n")
      : ownership === "prepared" ? ["- outer", "", ...codeLines.map((line) => `  > ${line}`)].join("\n")
      : ["- outer", "", ...ownedLines.map((line) => `  ${line}`)].join("\n");
    const full = await renderWithWorker(snippet, false, outputMode);
    const fullCode = getCode(full.store.getBlocks());
    const lazy = await renderWithWorker(snippet, true, outputMode);
    const code = getCode(lazy.store.getBlocks());
    assert.ok(!lazy.store.getBlocks().some((root) => root.id === code.id), "the request must target a descendant ID, not an accidental top-level code block");
    assert.strictEqual(code.isFinalized, true);
    assert.strictEqual(code.payload.meta?.code, lines.join("\n"), "nested container indentation must not leak into highlight input");
    assert.strictEqual(code.payload.meta?.lazyTokenization, true);
    assert.strictEqual(code.payload.meta?.lazyTokenizedUntil, 0);
    assert.strictEqual(codeStore(lazy.store).getChildren(code.id).length, lines.length, "producer must emit every code-line before lazy highlighting");
    if (ownership !== "prepared") assert.ok(!lazy.store.getNode(code.id), "this case must cross HTML ownership slots, not a normal prepared child lookup");
    let notifications = 0;
    const unsubscribe = lazy.store.subscribe(() => notifications++);
    const captured: CodeFenceRendererProps[] = [];
    const registry = new ComponentRegistry({}, {}, { javascript: (props: CodeFenceRendererProps) => {
      captured.push(props);
      return React.createElement("section", { "data-owned-code": props.blockId }, props.renderCode);
    } });
    const render = () => renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: lazy.store.getBlocks(), store: lazy.store, componentRegistry: registry }));
    render();
    const before = captured.at(-1);
    assert.ok(before);
    assert.strictEqual(before.code, lines.join("\n"));
    assert.strictEqual(before.language, "javascript", "callbacks use the canonical native language alias");
    assert.strictEqual(before.blockId, code.id);
    assert.strictEqual(before.isFinalized, true);
    assert.strictEqual(before.meta?.lazyTokenizedUntil, 0);
    const request = async (startLine: number, endLine: number) => {
      const messages = await lazy.harness.send({ type: "TOKENIZE_RANGE", blockId: code.id, startLine, endLine, priority: "visible" });
      assert.ok(messages.some((message) => message.type === "PATCH"), "a descendant highlight request must emit real transport patches");
      lazy.consume(messages);
    };
    await request(0, 20);
    assert.strictEqual(getCode(lazy.store.getBlocks()).payload.meta?.lazyTokenizedUntil, 20);
    assert.strictEqual(codeStore(lazy.store).getNode(`${code.id}::line:219`)?.props?.tokens, null, "tail remains uncolored until requested");
    await request(200, lines.length);
    const completed = getCode(lazy.store.getBlocks());
    assert.strictEqual(completed.payload.meta?.lazyTokenizedUntil, lines.length);
    assert.deepStrictEqual(completed.payload.meta?.tokenLines, fullCode.payload.meta?.tokenLines, "continued grammar state and final tail colors must match a full compile");
    for (const index of [0, 19, 20, 217, 218, 219]) {
      const actual = codeStore(lazy.store).getNode(`${code.id}::line:${index}`);
      const expected = codeStore(full.store).getNode(`${fullCode.id}::line:${index}`);
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
    assert.strictEqual(codeStore(reset).getChildren(code.id).length, lines.length);
    assert.deepStrictEqual(getCode(reset.getBlocks()).payload.meta?.tokenLines, fullCode.payload.meta?.tokenLines, "serialized nested snapshots must retain fully highlighted child metadata");
    assert.notStrictEqual(JSON.stringify(serialized), published, "the appended paragraph remains visible beside the highlighted owning root");
    assert.deepStrictEqual(reset.getInvariantViolations(), []);
    unsubscribe();
  }
}

async function runPublicTokenThemeConsumers(): Promise<void> {
  const lines = ["# Heading", "*italic*", "**bold**", "***both***", ...Array.from({ length: 56 }, (_, index) => `text ${index}`)];
  const code = lines.join("\n");
  const lazy = await renderWithWorker(["```markdown", code, "```"].join("\n"), true, "tokens");
  const block = lazy.store.getBlocks().find((candidate) => candidate.type === "code");
  assert.ok(block);
  lazy.consume(await lazy.harness.send({ type: "TOKENIZE_RANGE", blockId: block.id, startLine: 0, endLine: lines.length, priority: "visible" }));
  const highlighter = await getSharedHighlighter();
  const expected = highlighter.codeToTokensWithThemes(code, { lang: "markdown", themes: CODE_HIGHLIGHT_THEMES }) as ShikiThemedToken[][];
  assert.ok(expected.flat().some((token) => (token.variants.dark?.fontStyle ?? 0) & 1), "fixture must exercise real italic syntax");
  assert.ok(expected.flat().some((token) => (token.variants.dark?.fontStyle ?? 0) & 2), "fixture must exercise real bold syntax");
  assert.ok(expected.flat().some((token) => token.variants.dark?.color !== token.variants.light?.color), "fixture must exercise distinct theme foregrounds");
  for (const theme of ["dark", "light"] as const) {
    const Code: BlockComponents["code"] = ({ meta }) => React.createElement("pre", {}, React.createElement("code", {},
      (meta?.tokenLines as ReadonlyArray<TokenLineV1 | null> | undefined)?.map((line, lineIndex) => React.createElement("span", { key: lineIndex, "data-token-line": lineIndex },
        line?.spans.map((span, index) => {
          const style = span.s ?? span.v?.[theme];
          assert.ok(!style || (!Object.hasOwn(style, "color") && !Object.hasOwn(style, "fontStyle")), "public IR must use compact style fields only");
          const flags = style?.fs ?? 0;
          return React.createElement("span", { key: index, "data-token-index": index, "data-font-flags": flags,
            style: { color: style?.fg, fontStyle: flags & 1 ? "italic" : undefined, fontWeight: flags & 2 ? "bold" : undefined, textDecoration: flags & 4 ? "underline" : undefined } }, span.t);
        })))));
    const registry = new ComponentRegistry({ code: Code });
    const rendered = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: lazy.store.getBlocks(), store: lazy.store, componentRegistry: registry }));
    const dom = new JSDOM(rendered);
    const rows = dom.window.document.querySelectorAll<HTMLElement>("[data-token-line]");
    assert.strictEqual(rows.length, lines.length);
    for (let lineIndex = 0; lineIndex < expected.length; lineIndex++) {
      const actual = rows[lineIndex].querySelectorAll<HTMLElement>("[data-token-index]");
      assert.strictEqual(actual.length, expected[lineIndex].length);
      expected[lineIndex].forEach((token, index) => {
        const style = token.variants[theme];
        const color = dom.window.document.createElement("span");
        color.style.color = style?.color ?? "";
        const flags = style?.fontStyle ?? 0;
        assert.strictEqual(actual[index].textContent, token.content);
        assert.strictEqual(actual[index].style.color, color.style.color, `${theme} foreground must match independent raw Shiki output`);
        assert.strictEqual(Number(actual[index].dataset.fontFlags), flags);
        assert.strictEqual(actual[index].style.fontStyle, flags & 1 ? "italic" : "");
        assert.strictEqual(actual[index].style.fontWeight, flags & 2 ? "bold" : "");
        assert.strictEqual(actual[index].style.textDecoration, flags & 4 ? "underline" : "");
      });
    }
    dom.window.close();
  }
  const diff = await renderWithWorker(["```diff-markdown", "@@ -0,0 +1,60 @@", ...lines.map((line) => `+${line}`), "```"].join("\n"), true, "tokens", true);
  const diffCode = diff.store.getBlocks().find((candidate) => candidate.type === "code");
  assert.ok(diffCode);
  diff.consume(await diff.harness.send({ type: "TOKENIZE_RANGE", blockId: diffCode.id, startLine: 0, endLine: lines.length + 1, priority: "visible" }));
  const Diff: BlockComponents["code"] = ({ meta }) => React.createElement("pre", {}, React.createElement("code", {},
    (meta?.diffBlocks as DiffBlock[] | undefined)?.flatMap((block) => block.lines.filter((line) => line.kind === "add")).map((line, index) =>
      React.createElement("span", { key: index, "data-diff-row": index }, line.tokens?.map((token, index) => React.createElement("span", { key: index,
        style: { color: token.color, fontStyle: (token.fontStyle ?? 0) & 1 ? "italic" : undefined, fontWeight: (token.fontStyle ?? 0) & 2 ? "bold" : undefined } }, token.content))))));
  const diffHtml = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: diff.store.getBlocks(), store: diff.store, componentRegistry: new ComponentRegistry({ code: Diff }, {}, { diff: (props: CodeFenceRendererProps) => props.renderCode }) }));
  const diffDom = new JSDOM(diffHtml);
  const diffRows = diffDom.window.document.querySelectorAll<HTMLElement>("[data-diff-row]");
  assert.strictEqual(diffRows.length, lines.length);
  expected.forEach((line, row) => {
    const tokens = diffRows[row].querySelectorAll<HTMLElement>("span");
    assert.strictEqual(tokens.length, line.length);
    line.forEach((token, index) => {
      const color = diffDom.window.document.createElement("span");
      color.style.color = token.variants.dark?.color ?? "";
      const flags = token.variants.dark?.fontStyle ?? 0;
      assert.strictEqual(tokens[index].textContent, token.content);
      assert.strictEqual(tokens[index].style.color, color.style.color, "actual diff metadata must preserve compact foreground conversion");
      assert.strictEqual(tokens[index].style.fontStyle, flags & 1 ? "italic" : "");
      assert.strictEqual(tokens[index].style.fontWeight, flags & 2 ? "bold" : "");
    });
  });
  diffDom.window.close();
}

await main();
await runNestedLazyConsumers();
await runPublicTokenThemeConsumers();
console.log("nested lazy tokenization consumer parity passed");
