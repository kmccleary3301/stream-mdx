import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import { applyPatchBatch, createInitialSnapshot, PATCH_ROOT_ID, type Block, type CodeHighlightOutputMode, type HtmlTreeNode, type NodeSnapshot, type ParagraphBlockSnapshot, type ParagraphSpanRecord, type PreparedNestedSnapshot, type WorkerOut } from "@stream-mdx/core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComponentRegistry, MarkdownBlocksRenderer, type CodeFenceRendererProps } from "@stream-mdx/react/server";
import { createRendererStore, type RendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";
import { JSDOM } from "jsdom";
import { CODE_HIGHLIGHT_THEMES, getSharedHighlighter } from "../src/engine/highlight";
import type { ShikiThemedToken } from "../src/engine/types";

function buildSnippet(lineCount: number): string {
  const lines = Array.from({ length: lineCount }, (_, idx) => `const value_${idx} = ${idx};`);
  return ["```js", ...lines, "```"].join("\n");
}

function projectConsumerBlocks(blocks: readonly Block[]): unknown[] {
  function projectBlock(block: Block): unknown {
    const meta = block.payload.meta;
    const nested: unknown[] = [];
    for (const key of ["htmlTree", "htmlParagraphTree"]) {
      const tree = meta?.[key] as HtmlTreeNode[] | undefined;
      if (Array.isArray(tree)) nested.push(...projectTree(tree));
    }
    const visible = {
      id: block.id,
      type: block.type,
      isFinalized: block.isFinalized,
      raw: block.payload.raw,
      range: block.payload.range,
      nested,
    };
    if (block.type !== "code") return visible;

    const code = meta?.code;
    assert.ok(typeof code === "string", `code block ${block.id} must expose its authored source`);
    return {
      ...visible,
      code: code.split("\n"),
      info: meta?.info,
      lang: meta?.lang,
      highlightLang: meta?.highlightLang,
      lazyTokenization: meta?.lazyTokenization,
    };
  }

  function projectTree(tree: readonly HtmlTreeNode[]): unknown[] {
    return tree.flatMap((node) => node.kind === "block"
      ? [projectBlock(node.block)]
      : node.kind === "element" ? projectTree(node.children) : []);
  }

  return blocks.map(projectBlock);
}

async function renderWithWorker(snippet: string, lazyEnabled: boolean, outputMode: CodeHighlightOutputMode = "html", emitDiffBlocks = false, beforeFinalize?: (store: RendererStore) => void) {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
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
  }, });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker did not initialize");
  store.resetSnapshot(init.snapshot);
  const document = createInitialSnapshot(init.snapshot);
  const consume = (messages: WorkerOut[]) => {
    for (const message of messages) {
      if (message.type === "PATCH") {
        applyPatchBatch(document, message.patches);
        store.applyPatches(message.patches, { captureMetrics: false });
      } else if (message.type === "ERROR") {
        throw new Error(message.error.message);
      }
    }
    assert.deepStrictEqual(
      projectConsumerBlocks(document.getBlocks()),
      projectConsumerBlocks(store.getBlocks()),
      "Core and React must expose identical authored source, ranges, completion, and nested structure",
    );
    assert.deepStrictEqual(store.getInvariantViolations(), []);
  };

  const appendMessages = await harness.send({ type: "APPEND", text: snippet });
  consume(appendMessages);
  beforeFinalize?.(store);

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  consume(finalizeMessages);

  return { store, harness, document, consume };
}

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
    // React DOM reads the bare global navigator once a window exists (Node 20 has no global navigator).
    Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: dom.window.navigator });
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;

  const snippet = buildSnippet(60);

  const fullRender = await renderWithWorker(snippet, false);
  const fullBlock = fullRender.store.getBlocks().find((block) => block.type === "code");
  assert.ok(fullBlock, "missing full highlight code block");
  const codeLines = snippet.split("\n").slice(1, -1);
  const fullCode = fullRender.store.getCodeBlock(fullBlock.id);
  assert.ok(fullCode, "missing native full-highlight code owner");
  assert.strictEqual(fullCode.source.lineCount, codeLines.length);
  const fullLines = fullRender.store.getCodeLines(fullBlock.id, 0, fullCode.source.lineCount);
  assert.deepStrictEqual(fullLines.map((line) => line.text), codeLines);
  assert.ok(fullLines.every((line) => line.decoration), "eager Shiki output must decorate every native source line");

  const lazyRender = await renderWithWorker(snippet, true);
  const lazyBlock = lazyRender.store.getBlocks().find((block) => block.type === "code");
  assert.ok(lazyBlock, "missing lazy highlight code block");
  const lazyCode = lazyRender.store.getCodeBlock(lazyBlock.id);
  assert.ok(lazyCode, "missing native lazy-highlight code owner");
  assert.deepStrictEqual(
    lazyRender.store.getCodeLines(lazyBlock.id, 0, lazyCode.source.lineCount).map((line) => line.text),
    codeLines,
    "lazy source owner must preserve the complete authored fence body",
  );

  const rangeMessages = await lazyRender.harness.send({
    type: "TOKENIZE_RANGE",
    blockId: lazyBlock.id,
    startLine: 0,
    endLine: codeLines.length,
    priority: "visible",
  });
  lazyRender.consume(rangeMessages);

  const lazyLines = lazyRender.store.getCodeLines(lazyBlock.id, 0, lazyCode.source.lineCount);
  assert.ok(lazyLines.every((line) => line.decoration), "the requested range must decorate all native source lines");
  const sampleIndices = [0, 1, 2, codeLines.length - 3, codeLines.length - 2, codeLines.length - 1].filter(
    (idx) => idx >= 0 && idx < codeLines.length,
  );
  for (const idx of sampleIndices) {
    assert.deepStrictEqual(
      lazyLines[idx]?.decoration?.tokens,
      fullLines[idx]?.decoration?.tokens,
      `lazy native tokens for line ${idx} should match eager Shiki output`,
    );
  }

}

async function runNestedLazyConsumers(): Promise<void> {
  const lines = ["/* open", ...Array.from({ length: 217 }, (_, index) => `  carried_${index}`), "*/", "const tail = 219;"];
  const findCodeId = (store: RendererStore) => {
    type Candidate = { id: string; sourceType: string; hasNativeOwner: boolean; storeNodeType?: string; sourceLineCount?: number };
    type Discovery = { codeId: string | undefined; candidates: Candidate[] };
    const candidates: Candidate[] = [];
    const seenBlocks = new WeakSet<object>();
    const seenSnapshots = new WeakSet<object>();
    const discovery = (codeId?: string): Discovery => ({ codeId, candidates });
    const codeOwnerFor = (id: string, type: string) => {
      const owner = store.getCodeBlock(id);
      if (candidates.length < 8 && !candidates.some((candidate) => candidate.id === id)) {
        candidates.push({
          id,
          sourceType: type,
          hasNativeOwner: owner !== undefined,
          storeNodeType: store.getNode(id)?.type,
          sourceLineCount: owner?.source.lineCount,
        });
      }
      return owner;
    };
    // Inspect explicit cold HTML slots as well as prepared paragraph families.
    const findCodeBlock = (block: Block): string | undefined => {
      if (block.type === "code" && codeOwnerFor(block.id, block.type)) return block.id;
      if (seenBlocks.has(block)) return undefined;
      seenBlocks.add(block);
      const paragraph = block.payload.meta?.paragraph as ParagraphBlockSnapshot | undefined;
      if (paragraph) {
        for (const span of paragraph.spans) {
          const nested = findParagraphSpan(span);
          if (nested) return nested;
        }
      }
      const prepared = block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
      if (prepared) {
        for (const child of prepared.children) {
          const nested = findSnapshot(child);
          if (nested) return nested;
        }
      }
      for (const key of ["htmlTree", "htmlParagraphTree"]) {
        const treeValue = block.payload.meta?.[key];
        const tree = Array.isArray(treeValue) ? treeValue as HtmlTreeNode[] : undefined;
        const nested = tree ? findTree(tree) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };
    const findSnapshot = (snapshot: NodeSnapshot): string | undefined => {
      if (seenSnapshots.has(snapshot)) return undefined;
      seenSnapshots.add(snapshot);
      if (snapshot.type === "code" && codeOwnerFor(snapshot.id, snapshot.type)) return snapshot.id;
      const treeValue = snapshot.props?.htmlTree;
      const tree = Array.isArray(treeValue) ? treeValue as HtmlTreeNode[] : undefined;
      const nestedTree = tree ? findTree(tree) : undefined;
      if (nestedTree) return nestedTree;
      if (snapshot.type === "code") return undefined;
      for (const child of snapshot.children ?? []) {
        const nested = findSnapshot(child);
        if (nested) return nested;
      }
      return undefined;
    };
    const findTree = (tree: readonly HtmlTreeNode[]): string | undefined => {
      for (const entry of tree) {
        const nested = entry.kind === "block"
          ? findCodeBlock(entry.block)
          : entry.kind === "element" ? findTree(entry.children) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };
    const findParagraphSpan = (span: ParagraphSpanRecord | undefined): string | undefined => {
      for (const child of span?.children ?? []) {
        if (child.type !== "paragraph-html") continue;
        const treeValue = child.props?.htmlTree;
        const tree = Array.isArray(treeValue) ? treeValue as HtmlTreeNode[] : undefined;
        const nested = tree ? findTree(tree) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };
    const findParagraphOwner = (nodeId: string): string | undefined => {
      const paragraph = store.getParagraphBlock(nodeId);
      if (!paragraph) return undefined;
      for (let index = 0; index < paragraph.spans.length; index += 1) {
        const nested = findParagraphSpan(paragraph.spans.get(index));
        if (nested) return nested;
      }
      return undefined;
    };
    const stack = [...store.getChildren(PATCH_ROOT_ID)].reverse();
    while (stack.length > 0) {
      const nodeId = stack.pop();
      if (!nodeId) continue;
      const node = store.getNode(nodeId);
      if (!node) continue;
      if (node.type === "paragraph") {
        const nested = findParagraphOwner(node.id);
        if (nested) return discovery(nested);
      }
      if (node.type === "code" && codeOwnerFor(node.id, node.type)) return discovery(node.id);
      if (node.block) {
        const nested = findCodeBlock(node.block);
        if (nested) return discovery(nested);
      }
      const treeValue = node.props?.htmlTree;
      const tree = Array.isArray(treeValue) ? treeValue as HtmlTreeNode[] : undefined;
      const nestedTree = tree ? findTree(tree) : undefined;
      if (nestedTree) return discovery(nestedTree);
      const children = store.getChildren(nodeId);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]);
      }
    }
    for (const block of store.getBlocks()) {
      const nested = findCodeBlock(block);
      if (nested) return discovery(nested);
    }
    return discovery();
  };
  const ownedCodeLines = (store: RendererStore, blockId: string) => {
    const owner = store.getCodeBlock(blockId);
    assert.ok(owner, `missing native source owner for code block ${blockId}`);
    return store.getCodeLines(blockId, 0, owner.source.lineCount);
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
    if (ownership !== "prepared") {
      // Code inside HTML elements declines native ownership; eager and lazy consumers must still render the authored code.
      for (const lazyEnabled of [false, true]) {
        const { store } = await renderWithWorker(snippet, lazyEnabled, outputMode);
        const dom = new JSDOM(renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: store.getBlocks(), store })));
        const code = dom.window.document.querySelector("[data-code-block]");
        const totalLines = code?.getAttribute("data-code-total-lines");
        const text = code?.textContent ?? "";
        dom.window.close();
        assert.strictEqual(totalLines, String(lines.length), `${ownership}/${outputMode}/lazy=${lazyEnabled} must own every authored code line`);
        // The virtualized code view mounts a leading window of the lines.
        assert.ok(lines.slice(0, 100).every((line) => text.includes(line)), `${ownership}/${outputMode}/lazy=${lazyEnabled} must render the authored code window`);
      }
      continue;
    }
    const assertStreamingCode = (store: RendererStore) => {
      const discovery = findCodeId(store);
      assert.ok(discovery.codeId, `${ownership}/${outputMode} must publish a native code owner before FINALIZE: ${JSON.stringify(discovery.candidates)}`);
      assert.deepStrictEqual(
        ownedCodeLines(store, discovery.codeId).map((line) => line.text),
        lines,
        `${ownership}/${outputMode} must retain exact native code source before FINALIZE`,
      );
    };
    const full = await renderWithWorker(snippet, false, outputMode, false, assertStreamingCode);
    const fullDiscovery = findCodeId(full.store);
    if (!fullDiscovery.codeId) {
      assert.fail(`eager nested source lacks a native code owner: ${JSON.stringify({
        ownership,
        outputMode,
        candidates: fullDiscovery.candidates,
      })}`);
    }
    const fullCodeId = fullDiscovery.codeId;
    const fullOwner = full.store.getCodeBlock(fullCodeId);
    assert.ok(fullOwner, "eager nested code must have a native source owner");
    assert.strictEqual(fullOwner.source.codeOwnerId, fullCodeId);
    const fullOwnedLines = ownedCodeLines(full.store, fullCodeId);
    assert.deepStrictEqual(fullOwnedLines.map((line) => line.text), lines);
    if (!fullOwnedLines.every((line) => line.decoration)) {
      const missingLines = fullOwnedLines.filter((line) => !line.decoration).map((line) => line.index);
      assert.fail(`eager nested highlighting must decorate native source lines: ${JSON.stringify({
        ownership,
        outputMode,
        state: fullOwner.source.state,
        revision: fullOwner.source.revision,
        missingCount: missingLines.length,
        firstMissing: missingLines.slice(0, 12),
      })}`);
    }

    const lazy = await renderWithWorker(snippet, true, outputMode, false, assertStreamingCode);
    const lazyDiscovery = findCodeId(lazy.store);
    if (!lazyDiscovery.codeId) {
      assert.fail(`lazy nested source lacks a native code owner: ${JSON.stringify({
        ownership,
        outputMode,
        candidates: lazyDiscovery.candidates,
      })}`);
    }
    const codeId = lazyDiscovery.codeId;
    const codeOwner = lazy.store.getCodeBlock(codeId);
    assert.ok(codeOwner, "lazy nested code must have a native source owner");
    assert.strictEqual(codeOwner.source.codeOwnerId, codeId);
    assert.ok(!lazy.store.getBlocks().some((root) => root.id === codeId), "the request must target a descendant ID, not an accidental top-level code block");
    assert.strictEqual(codeOwner.source.state, "finalized");
    assert.strictEqual(codeOwner.source.lineCount, lines.length);
    const sourceGeneration = codeOwner.source.generation;
    const sourceRevision = codeOwner.source.revision;
    const initialOwnedLines = ownedCodeLines(lazy.store, codeId);
    assert.deepStrictEqual(initialOwnedLines.map((line) => line.text), lines, "nested source keeps only authored code indentation");
    assert.ok(initialOwnedLines.every((line) => line.decoration === undefined), "lazy code starts without highlight decorations");
    const registry = new ComponentRegistry({}, {}, {
      javascript: (props: CodeFenceRendererProps) => React.createElement("section", { "data-owned-code": props.blockId }, props.renderCode),
    });
    const render = (store: RendererStore = lazy.store) => renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: store.getBlocks(), store, componentRegistry: registry }));
    const request = async (startLine: number, endLine: number) => {
      const messages = await lazy.harness.send({ type: "TOKENIZE_RANGE", blockId: codeId, startLine, endLine, priority: "visible" });
      lazy.consume(messages);
    };
    await request(0, 20);
    const initialRange = ownedCodeLines(lazy.store, codeId);
    assert.ok(initialRange.slice(0, 20).every((line) => line.decoration), "the requested prefix receives real highlight tokens");
    assert.ok(initialRange.slice(20).every((line) => line.decoration === undefined), "lines outside the requested range stay uncolored");
    assert.strictEqual(ownedCodeLines(lazy.store, codeId)[219]?.decoration, undefined, "tail remains uncolored until requested");
    await request(200, lines.length);
    const currentOwner = lazy.store.getCodeBlock(codeId);
    assert.ok(currentOwner, "highlighting must retain the native source owner");
    assert.strictEqual(currentOwner.source.generation, sourceGeneration, "highlighting must not replace the native owner generation");
    assert.strictEqual(currentOwner.source.revision, sourceRevision, "highlighting must not revise authored source");
    const completedLines = ownedCodeLines(lazy.store, codeId);
    assert.strictEqual(completedLines.length, lines.length);
    assert.ok(completedLines.slice(200).every((line) => line.decoration), "the requested tail receives real highlight tokens");
    assert.ok(
      completedLines.slice(20, 200).every((line) => line.decoration === undefined),
      "the unrequested middle range stays uncolored",
    );
    for (const [startLine, endLine] of [[0, 20], [200, lines.length]] as const) {
      for (let index = startLine; index < endLine; index += 1) {
        const line = completedLines[index];
        const expected = fullOwnedLines[index];
        assert.ok(line?.decoration, `native line ${index} in a requested range must retain its actual decoration`);
        assert.strictEqual(line.decoration.index, index);
        assert.strictEqual(line.decoration.lineId, line.id);
        assert.strictEqual(line.decoration.sourceRevision, line.sourceRevision);
        assert.strictEqual(line.decoration.configurationRevision, currentOwner.configurationRevision);
        assert.ok(expected?.decoration, `eager line ${index} must have a native decoration`);
        assert.deepStrictEqual(line.decoration.tokens, expected.decoration.tokens, `native line ${index} tokens must match full compile`);
      }
    }
    const assertRequestedDecorationsRetained = (records: typeof completedLines, operation: string) => {
      assert.deepStrictEqual(records.map((line) => line.text), lines, `${operation} must retain exact authored code source`);
      assert.ok(records.slice(20, 200).every((line) => line.decoration === undefined), `${operation} must retain the unrequested middle`);
      for (const [startLine, endLine] of [[0, 20], [200, lines.length]] as const) {
        for (let index = startLine; index < endLine; index += 1) {
          const line = records[index];
          const expected = completedLines[index];
          assert.ok(line?.decoration, `${operation} must retain the requested native line ${index}`);
          assert.strictEqual(line.id, expected?.id, `${operation} must retain line identity ${index}`);
          assert.strictEqual(line.sourceRevision, expected?.sourceRevision, `${operation} must retain source revision ${index}`);
          assert.deepStrictEqual(line.decoration, expected?.decoration, `${operation} must retain native decoration ${index}`);
        }
      }
    };
    const assertColdDecorationsRetained = (records: typeof completedLines, configurationRevision: number, operation: string) => {
      assert.strictEqual(records.length, lines.length, `${operation} must retain every native source line`);
      assert.deepStrictEqual(records.map((line) => line.text), lines, `${operation} must retain exact authored code source`);
      const lineIds = new Set<string>();
      for (let index = 0; index < records.length; index += 1) {
        const line = records[index];
        assert.ok(line, `${operation} must retain native source line ${index}`);
        assert.strictEqual(line.index, index, `${operation} must retain native line index ${index}`);
        assert.ok(line.id.length > 0 && !lineIds.has(line.id), `${operation} must keep line IDs nonempty and unique`);
        lineIds.add(line.id);
        assert.ok(Number.isSafeInteger(line.sourceRevision) && line.sourceRevision >= 0, `${operation} must keep a valid source revision for line ${index}`);
        if (index >= 20 && index < 200) {
          assert.strictEqual(line.decoration, undefined, `${operation} must leave the unrequested middle line ${index} undecorated`);
          continue;
        }
        const decoration = line.decoration;
        assert.ok(decoration, `${operation} must retain requested native line ${index}`);
        assert.strictEqual(decoration.index, index);
        assert.strictEqual(decoration.lineId, line.id);
        assert.strictEqual(decoration.sourceRevision, line.sourceRevision);
        assert.strictEqual(decoration.configurationRevision, configurationRevision);
        assert.deepStrictEqual(
          decoration.tokens,
          fullOwnedLines[index]?.decoration?.tokens,
          `${operation} must retain eager-equivalent native tokens for line ${index}`,
        );
      }
    };
    const assertVisibleRowsMatchNativeRecords = (root: ParentNode, records: typeof completedLines, operation: string) => {
      const visibleRows = Array.from(root.querySelectorAll<HTMLElement>("[data-line]"));
      assert.ok(visibleRows.length > 0, `${operation} must render visible native code rows`);
      for (const row of visibleRows) {
        const lineIndex = Number(row.dataset.line) - 1;
        const record = records[lineIndex];
        assert.ok(record, `${operation} row must map to native source line ${lineIndex}`);
        assert.strictEqual(row.textContent, record.text, `${operation} must preserve visible native source line ${lineIndex}`);
        assert.deepStrictEqual(
          Array.from(row.children).map((token) => [
            token.textContent,
            (token as HTMLElement).style.getPropertyValue("--shiki-dark"),
            (token as HTMLElement).style.getPropertyValue("--shiki-light"),
          ]),
          record.decoration?.tokens.spans.map((token) => [token.t, token.v?.dark?.fg ?? "", token.v?.light?.fg ?? ""]) ?? [],
          `${operation} must render visible native tokens and both Shiki theme styles for line ${lineIndex}`,
        );
      }
    };
    const dom = new JSDOM(render());
    const ownedCode = dom.window.document.querySelector<HTMLElement>("[data-owned-code]");
    assert.ok(ownedCode, "custom code renderer must wrap its real native renderCode output");
    assert.strictEqual(ownedCode.getAttribute("data-owned-code"), codeId);
    assertVisibleRowsMatchNativeRecords(ownedCode, completedLines, `${ownership}/${outputMode} renderCode`);
    dom.window.close();
    lazy.consume(await lazy.harness.send({ type: "APPEND", text: "\n\nFollowing\n" }));
    const afterAppendOwner = lazy.store.getCodeBlock(codeId);
    assert.ok(afterAppendOwner, "an unrelated paragraph append must retain the native code owner");
    assert.strictEqual(afterAppendOwner.source.generation, sourceGeneration);
    assert.strictEqual(afterAppendOwner.source.revision, sourceRevision);
    assertRequestedDecorationsRetained(ownedCodeLines(lazy.store, codeId), "append");
    lazy.consume(await lazy.harness.send({ type: "FINALIZE" }));
    assertRequestedDecorationsRetained(ownedCodeLines(lazy.store, codeId), "finalize");
    const appendedDom = new JSDOM(render());
    assert.ok(appendedDom.window.document.body.textContent?.includes("Following"), "the appended paragraph must remain visible beside the highlighted code");
    appendedDom.window.close();
    const serializedBlocks = JSON.parse(JSON.stringify(lazy.store.getBlocks())) as Block[];
    const reset = createRendererStore(serializedBlocks);
    const resetLines = ownedCodeLines(reset, codeId);
    const resetOwner = reset.getCodeBlock(codeId);
    assert.ok(resetOwner, "cold Block[] reset must reconstruct the nested native code owner");
    assert.strictEqual(resetOwner.source.codeOwnerId, codeId);
    assert.strictEqual(resetOwner.source.lineCount, lines.length);
    assert.strictEqual(resetOwner.source.state, "finalized");
    assertColdDecorationsRetained(resetLines, resetOwner.configurationRevision, `${ownership}/${outputMode} serialized cold Block[] export`);
    const coldDom = new JSDOM(render(reset));
    const coldCode = coldDom.window.document.querySelector<HTMLElement>("[data-owned-code]");
    assert.ok(coldCode, "cold Block[] reset must keep the custom renderer around native code");
    assert.strictEqual(coldCode.getAttribute("data-owned-code"), codeId);
    assertVisibleRowsMatchNativeRecords(coldCode, resetLines, `${ownership}/${outputMode} cold Block[] reset renderCode`);
    coldDom.window.close();
    assert.deepStrictEqual(reset.getInvariantViolations(), []);
  }
}

async function runPublicTokenThemeConsumers(): Promise<void> {
  const lines = ["# Heading", "*italic*", "**bold**", "***both***", ...Array.from({ length: 56 }, (_, index) => `text ${index}`)];
  const code = lines.join("\n");
  const lazy = await renderWithWorker(["```markdown", code, "```"].join("\n"), true, "tokens");
  const block = lazy.store.getBlocks().find((candidate) => candidate.type === "code");
  assert.ok(block);
  lazy.consume(await lazy.harness.send({ type: "TOKENIZE_RANGE", blockId: block.id, startLine: 0, endLine: lines.length, priority: "visible" }));
  const codeState = lazy.store.getCodeBlock(block.id);
  assert.ok(codeState, "expected the markdown fence to have a native code owner");
  const nativeLines = lazy.store.getCodeLines(block.id, 0, codeState.source.lineCount);
  assert.strictEqual(nativeLines.length, lines.length);
  assert.ok(nativeLines.every((line) => line.decoration), "the requested native lines must carry real token decorations");
  const highlighter = await getSharedHighlighter();
  const expected = highlighter.codeToTokensWithThemes(code, { lang: "markdown", themes: CODE_HIGHLIGHT_THEMES }) as ShikiThemedToken[][];
  assert.ok(expected.flat().some((token) => (token.variants.dark?.fontStyle ?? 0) & 1), "fixture must exercise real italic syntax");
  assert.ok(expected.flat().some((token) => (token.variants.dark?.fontStyle ?? 0) & 2), "fixture must exercise real bold syntax");
  for (let lineIndex = 0; lineIndex < expected.length; lineIndex += 1) {
    const nativeSpans = nativeLines[lineIndex]?.decoration?.tokens.spans;
    assert.ok(nativeSpans, `native line ${lineIndex} must retain its token spans`);
    assert.strictEqual(nativeSpans.length, expected[lineIndex].length);
    expected[lineIndex].forEach((token, index) => {
      const ownedSpan = nativeSpans[index];
      assert.ok(ownedSpan);
      assert.strictEqual(ownedSpan.t, token.content);
      assert.strictEqual(ownedSpan.v?.dark?.fg ?? ownedSpan.s?.fg ?? "", token.variants.dark?.color ?? "", "native dark foreground must match independent raw Shiki output");
      assert.strictEqual(ownedSpan.v?.light?.fg ?? ownedSpan.s?.fg ?? "", token.variants.light?.color ?? "", "native light foreground must match independent raw Shiki output");
      assert.strictEqual(ownedSpan.v?.dark?.fs ?? ownedSpan.s?.fs ?? 0, token.variants.dark?.fontStyle ?? 0);
      assert.strictEqual(ownedSpan.v?.light?.fs ?? ownedSpan.s?.fs ?? 0, token.variants.light?.fontStyle ?? 0);
    });
  }
  const registry = new ComponentRegistry({}, {}, {
    markdown: (props: CodeFenceRendererProps) => React.createElement("section", { "data-public-code": props.blockId }, props.renderCode),
  });
  const rendered = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: lazy.store.getBlocks(), store: lazy.store, componentRegistry: registry }));
  const dom = new JSDOM(rendered);
  const publicCode = dom.window.document.querySelector<HTMLElement>("[data-public-code]");
  assert.ok(publicCode, "custom code renderer must contain the real native renderCode view");
  assert.strictEqual(publicCode.getAttribute("data-public-code"), block.id);
  const renderedRows = Array.from(publicCode.querySelectorAll<HTMLElement>("[data-line]"));
  assert.strictEqual(renderedRows.length, lines.length);
  for (let lineIndex = 0; lineIndex < expected.length; lineIndex += 1) {
    const actual = Array.from(renderedRows[lineIndex].children) as HTMLElement[];
    assert.strictEqual(actual.length, expected[lineIndex].length);
    const nativeSpans = nativeLines[lineIndex]?.decoration?.tokens.spans;
    assert.ok(nativeSpans);
    expected[lineIndex].forEach((token, index) => {
      const element = actual[index];
      const ownedSpan = nativeSpans[index];
      assert.ok(element);
      assert.ok(ownedSpan);
      assert.strictEqual(element.textContent, token.content);
      assert.strictEqual(element.style.getPropertyValue("--shiki-dark"), token.variants.dark?.color ?? "", "renderCode dark theme style must match independent Shiki");
      assert.strictEqual(element.style.getPropertyValue("--shiki-light"), token.variants.light?.color ?? "", "renderCode light theme style must match independent Shiki");
      const flags = ownedSpan.v?.light?.fs ?? ownedSpan.v?.dark?.fs ?? ownedSpan.s?.fs ?? 0;
      assert.strictEqual(element.style.fontStyle, flags & 1 ? "italic" : "");
      assert.strictEqual(element.style.fontWeight, flags & 2 ? "bold" : "");
      const decorations = [
        flags & 4 ? "underline" : "",
        flags & 8 ? "line-through" : "",
      ].filter(Boolean).join(" ");
      assert.strictEqual(element.style.textDecoration, decorations);
    });
  }
  dom.window.close();
  const diff = await renderWithWorker(["```diff-markdown", "@@ -0,0 +1,60 @@", ...lines.map((line) => `+${line}`), "```"].join("\n"), true, "tokens", true);
  const diffCode = diff.store.getBlocks().find((candidate) => candidate.type === "code");
  assert.ok(diffCode);
  diff.consume(await diff.harness.send({ type: "TOKENIZE_RANGE", blockId: diffCode.id, startLine: 0, endLine: lines.length + 1, priority: "visible" }));
  const diffOwner = diff.store.getCodeBlock(diffCode.id);
  assert.ok(diffOwner, "diff source must retain its native code owner");
  const diffSourceLines = diff.store.getCodeLines(diffCode.id, 0, diffOwner.source.lineCount);
  assert.deepStrictEqual(
    diffSourceLines.map((line) => line.text),
    ["@@ -0,0 +1,60 @@", ...lines.map((line) => `+${line}`)],
    "native diff source records must retain authored prefixes and content",
  );
  // Additions form the new-side grammar track: Shiki sees authored content without diff markers.
  const rawDiff = highlighter.codeToTokensWithThemes(lines.join("\n"), { lang: "markdown", themes: CODE_HIGHLIGHT_THEMES }) as ShikiThemedToken[][];
  for (let row = 0; row < lines.length; row += 1) {
    const nativeSpans = diffSourceLines[row + 1]?.decoration?.tokens.spans;
    assert.ok(nativeSpans, `native diff addition ${row} must carry its requested tokens`);
    assert.deepStrictEqual(
      nativeSpans.map((span) => span.t),
      rawDiff[row].map((token) => token.content),
      `native diff addition ${row} must retain independent Shiki token content`,
    );
  }
  const diffHtml = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, {
    blocks: diff.store.getBlocks(),
    store: diff.store,
    componentRegistry: new ComponentRegistry(),
  }));
  const diffDom = new JSDOM(diffHtml);
  const diffRows = diffDom.window.document.querySelectorAll<HTMLElement>('[data-diff-kind="add"]');
  assert.strictEqual(diffRows.length, lines.length, "the public diff renderer must retain each added line");
  const expectedDiff = rawDiff;
  expectedDiff.forEach((line, row) => {
    const tokens = diffRows[row].querySelectorAll<HTMLElement>(".stream-mdx-diff-content > span");
    assert.strictEqual(tokens.length, line.length);
    line.forEach((token, index) => {
      const color = diffDom.window.document.createElement("span");
      color.style.color = token.variants.dark?.color ?? "";
      const flags = token.variants.dark?.fontStyle ?? 0;
      assert.strictEqual(tokens[index].textContent, token.content);
      assert.strictEqual(tokens[index].style.color, color.style.color, "the public diff renderer must preserve independent Shiki foregrounds");
      assert.strictEqual(tokens[index].style.fontStyle, flags & 1 ? "italic" : "");
      assert.strictEqual(tokens[index].style.fontWeight, flags & 2 ? "bold" : "");
    });
  });
  diffDom.window.close();

}
await main();
await runNestedLazyConsumers();
await runPublicTokenThemeConsumers();
console.log("lazy tokenization, nested consumers, public themes and diff parity passed");
