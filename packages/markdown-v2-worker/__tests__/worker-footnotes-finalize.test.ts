import assert from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";

import { applyPatchBatch, createBlockSnapshot, createInitialSnapshot, type Block, type FootnoteItem, type InlineNode, type NodeSnapshot, type Patch, type WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { createWorkerHarness } from "./worker-test-harness";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import { createWorkerThread } from "@stream-mdx/worker/node";

function findInlineFootnoteNumber(nodes: InlineNode[], label: string): number | undefined {
  for (const node of nodes) {
    if (node.kind === "footnote-ref" && node.label === label) {
      return node.number;
    }
    if ("children" in node && Array.isArray(node.children)) {
      const nested = findInlineFootnoteNumber(node.children, label);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

async function runFootnotesFinalizeTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true },
  });
  const init = initMessages.find((m) => m.type === "INITIALIZED") as Extract<WorkerOut, { type: "INITIALIZED" }> | undefined;
  assert.ok(init, "worker did not emit INITIALIZED message");
  store.reset(init.blocks);

  const content = [
    "> This is a blockquote with a footnote.[^1]\\",
    "> Second line",
    "",
    "",
    "[^1]: This is the definition for the footnote.",
    "",
  ].join("\n");

  const appendMessages = await harness.send({ type: "APPEND", text: content });
  const appendPatches = appendMessages.filter((m): m is Extract<WorkerOut, { type: "PATCH" }> => m.type === "PATCH");
  assert.ok(appendPatches.length > 0, "missing patch message after append");
  for (const patchMsg of appendPatches) {
    store.applyPatches(patchMsg.patches as Patch[], { captureMetrics: false });
  }

  const blocksBeforeFinalize = store.getBlocks();
  assert.ok(blocksBeforeFinalize.some((block) => !block.isFinalized), "expected dirty blocks prior to FINALIZE");
  assert.ok(!blocksBeforeFinalize.some((block) => block.type === "footnotes"), "synthetic footnotes block should not appear while tail is dirty");

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  const finalizePatchMessages = finalizeMessages.filter((m): m is Extract<WorkerOut, { type: "PATCH" }> => m.type === "PATCH");
  assert.ok(finalizePatchMessages.length > 0, "FINALIZE should emit PATCH message when blocks are dirty");
  for (const patchMsg of finalizePatchMessages) {
    store.applyPatches(patchMsg.patches as Patch[], { captureMetrics: false });
  }

  const blocksAfterFinalize = store.getBlocks();
  const footnotesBlock = blocksAfterFinalize.find((block) => block.type === "footnotes") as Block | undefined;
  assert.ok(footnotesBlock, "expected synthetic footnotes block after FINALIZE");
  const meta = (footnotesBlock.payload.meta ?? {}) as { items?: Array<{ number: number; label: string; inlines: InlineNode[] }> };
  assert.ok(Array.isArray(meta.items) && meta.items.length === 1, "expected exactly one footnote item");
  assert.strictEqual(meta.items[0]?.number, 1, "footnote item should be numbered");
  assert.strictEqual(meta.items[0]?.label, "1", "footnote label should be preserved");

  const quoteBlock = blocksAfterFinalize.find((block) => block.type === "blockquote");
  assert.ok(quoteBlock, "expected blockquote to be present after finalize");
  const quoteMeta = (quoteBlock.payload.meta ?? {}) as { mixedSegments?: Array<{ inline?: InlineNode[] }> };
  const segments = Array.isArray(quoteMeta.mixedSegments) ? quoteMeta.mixedSegments : [];
  const segmentInline = segments.flatMap((segment) => (Array.isArray(segment.inline) ? segment.inline : []));
  const numberFromSegments = findInlineFootnoteNumber(segmentInline, "1");
  const numberFromInline = Array.isArray(quoteBlock.payload.inline) ? findInlineFootnoteNumber(quoteBlock.payload.inline, "1") : undefined;
  assert.strictEqual(
    numberFromSegments ?? numberFromInline,
    1,
    "footnote number should be assigned in the finalized blockquote inline representation",
  );
}


async function runPreparedFootnoteConsumerTest(): Promise<void> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const document = createInitialSnapshot();
  const consume = (messages: WorkerOut[]) => {
    for (const emitted of messages) {
      const message = structuredClone(emitted);
      if (message.type === "INITIALIZED") {
        store.reset(message.blocks);
        Object.assign(document, createInitialSnapshot(message.blocks));
      } else if (message.type === "PATCH") {
        applyPatchBatch(document, message.patches);
        store.applyPatches(message.patches, { captureMetrics: false });
      } else if (message.type === "ERROR") {
        throw new Error(message.error.message);
      }
    }
    assert.deepStrictEqual(document.blocks, store.getBlocks(), "core and React must consume the same numbered prepared artifacts");
    assert.deepStrictEqual(store.getInvariantViolations(), []);
  };
  const numbers = new Map([["beta", 1], ["alpha", 2], ["gamma", 3]]);
  const assertNumbered = (blocks: Block[]) => {
    const seen = new Set<string>();
    const visitInline = (nodes: InlineNode[]) => {
      for (const node of nodes) {
        if (node.kind === "footnote-ref") {
          assert.strictEqual(node.number, numbers.get(node.label), `number metadata for ${node.label}`);
          seen.add(node.label);
        }
        if ("children" in node && Array.isArray(node.children)) visitInline(node.children);
      }
    };
    const visitSnapshot = (snapshot: NodeSnapshot) => {
      const block = snapshot.props?.block as Block | undefined;
      if (block?.payload.inline) visitInline(block.payload.inline);
      if (Array.isArray(snapshot.props?.inline)) visitInline(snapshot.props.inline as InlineNode[]);
      for (const child of snapshot.children ?? []) visitSnapshot(child);
    };
    for (const block of blocks) visitSnapshot(createBlockSnapshot(block));
    assert.deepStrictEqual(seen, new Set(numbers.keys()), "nested consumers must retain every reference, not just root compatibility inline");
  };
  const content = [
    "- first<span>[^beta]</span>",
    "",
    "  > # Heading[^alpha]",
    "  >",
    "  > repeat<span>[^beta]</span>",
    "  >",
    "  > - third[^gamma]",
    "  >",
    "  > ```js",
    "  > // [^ignored]",
    "  > ```",
    "",
    "> quote<span>[^alpha]</span> and again[^beta]",
    "",
    "Tail",
  ].join("\n");
  const initialMessages = await harness.send({ type: "INIT", initialContent: content, prewarmLangs: [], docPlugins: { footnotes: true, html: true, mdx: false, tables: false, callouts: false } });
  const initialBlocks = initialMessages.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED")?.blocks;
  assert.ok(initialBlocks);
  const initialSerialized = JSON.stringify(initialBlocks);
  consume(initialMessages);
  assertNumbered(store.getBlocks());
  const beforeDefinitions = JSON.stringify(store.getBlocks());
  consume(await harness.send({ type: "APPEND", text: "\n\n[^gamma]: Third\n\n[^beta]: First\n\n[^alpha]: Second\n" }));
  assertNumbered(store.getBlocks());
  assert.strictEqual(JSON.stringify(initialBlocks), initialSerialized, "document numbering must not mutate already-published root/subtree artifacts");
  assert.notStrictEqual(JSON.stringify(store.getBlocks()), beforeDefinitions, "forward definitions must cross the real PATCH boundary");
  consume(await harness.send({ type: "FINALIZE" }));
  assertNumbered(store.getBlocks());
  const blocks = JSON.parse(JSON.stringify(store.getBlocks())) as Block[];
  const reset = createRendererStore(blocks);
  assertNumbered(reset.getBlocks());
  assert.deepStrictEqual(reset.getInvariantViolations(), []);
  const items = blocks.find((block) => block.type === "footnotes")?.payload.meta?.items as Array<{ label: string; number: number; inlines: InlineNode[] }> | undefined;
  assert.ok(items);
  const patchedDom = new JSDOM(renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: store.getBlocks(), store })));
  const serializedDom = new JSDOM(renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: reset.getBlocks(), store: reset })));
  const numbersInDom = (dom: JSDOM) => [...dom.window.document.querySelectorAll("sup.footnote-ref a")].map((anchor) => [anchor.getAttribute("href"), anchor.textContent]);
  assert.deepStrictEqual(numbersInDom(patchedDom), numbersInDom(serializedDom), "HTML-owned native inline slots must retain numbers after serialized reset");
  assert.ok(numbersInDom(patchedDom).some(([href, text]) => href === "#fn:1" && text === "1"), "real nested HTML consumer must render the numbered native footnote");
  assert.ok([...patchedDom.window.document.querySelectorAll("span sup.footnote-ref a")].some((anchor) => anchor.textContent === "1"), "HTML paragraph ownership descriptors must not retain pre-document-plugin numbers");
  patchedDom.window.close();
  serializedDom.window.close();
  assert.deepStrictEqual(items.map(({ label, number }) => [label, number]), [...numbers.entries()], "first-reference order must survive repeated references and later definitions");
  assert.ok(items.every((item) => item.inlines.some((node) => node.kind === "text" && /First|Second|Third/.test(node.text))), "forward definition text must populate the synthetic consumer artifact");
  for (const quote of blocks.filter((block) => block.type === "blockquote")) {
    assert.strictEqual(findInlineFootnoteNumber(quote.payload.inline ?? [], "alpha"), 2, "root compatibility inline must expose the actual numbered child content");
  }
}
async function runRepeatedReferenceTargetsTest(): Promise<void> {
  const content = "Missing[^missing] then outer[^note].\n\n> repeated<span>[^note]</span>\n\n[^note]: Body with **emphasis**.\n";
  const init = { prewarmLangs: [], docPlugins: { footnotes: true, html: true, mdx: false, math: false, tables: false, callouts: false } };
  const compiled = await compileMarkdownSnapshotDirect({ text: content, init });
  const worker = createWorkerThread();
  const store = createRendererStore();
  let document = createInitialSnapshot();
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onMessage = (message: WorkerOut) => {
        try {
          if (message.type === "INITIALIZED") {
            store.reset(message.blocks);
            document = createInitialSnapshot(message.blocks);
          } else if (message.type === "PATCH") {
            applyPatchBatch(document, message.patches);
            store.applyPatches(message.patches, { captureMetrics: false });
          } else if (message.type === "ERROR") {
            finish(new Error(message.error.message));
            return;
          }
          assert.deepStrictEqual(document.blocks, store.getBlocks());
          assert.deepStrictEqual(store.getInvariantViolations(), []);
          if (message.type === "FINALIZED") finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.postMessage({ type: "INIT", initialContent: "", ...init });
      for (let index = 0; index < content.length; index += 7) worker.postMessage({ type: "APPEND", text: content.slice(index, index + 7) });
      worker.postMessage({ type: "FINALIZE" });
    });
  } finally {
    await worker.terminate();
  }
  const items = store.getBlocks().find((block) => block.type === "footnotes")?.payload.meta?.items as FootnoteItem[] | undefined;
  assert.ok(items);
  assert.deepStrictEqual(items.map(({ label, number, refCount }) => [label, number, refCount]), [["note", 1, 2]], "missing refs must not create empty items or consume displayed numbers; metadata aliases must not double-count");
  const assertTargets = (container: HTMLElement) => {
    const refs = [...container.querySelectorAll<HTMLAnchorElement>("sup.footnote-ref a")];
    assert.deepStrictEqual(refs.map((ref) => [ref.id, ref.getAttribute("href"), ref.textContent]), [["fnref:1", "#fn:1", "1"], ["fnref:1:2", "#fn:1", "1"]]);
    assert.ok(!refs[0].closest("blockquote") && refs[1].closest("blockquote span"), "occurrences must retain their distinct source locations, including HTML ownership");
    const footer = container.querySelector<HTMLElement>('[id="fn:1"]');
    assert.ok(footer?.querySelector("strong")?.textContent === "emphasis");
    const backrefs = [...footer.querySelectorAll<HTMLAnchorElement>("a.footnote-backref")];
    assert.deepStrictEqual(backrefs.map((ref) => ref.getAttribute("href")), ["#fnref:1", "#fnref:1:2"]);
    const idNodes = [...container.querySelectorAll<HTMLElement>("[id]")];
    assert.strictEqual(new Set(idNodes.map((node) => node.id)).size, idNodes.length, "all generated targets must be unique");
    for (const ref of refs) assert.strictEqual(footer.ownerDocument.getElementById(ref.hash.slice(1)), footer, "every visible reference must resolve to the real definition");
    for (let index = 0; index < backrefs.length; index++) assert.strictEqual(footer.ownerDocument.getElementById(backrefs[index].hash.slice(1)), refs[index], "each backlink must resolve to its own occurrence, not the first alias");
    assert.ok(container.textContent?.includes("[^missing]"), "missing references must remain literal");
    return { refs, backrefs, footer };
  };
  for (const blocks of [store.getBlocks(), compiled.blocks, JSON.parse(JSON.stringify(store.getBlocks())) as Block[]]) {
    const dom = new JSDOM(renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks })));
    assertTargets(dom.window.document.body);
    dom.window.close();
  }
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", { url: "http://localhost/footnote-consumer", pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const container = dom.window.document.querySelector("main");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.timeout(10_000);
      const finish = (error?: Error) => {
        observer.disconnect();
        signal.removeEventListener("abort", fail);
        if (error) reject(error);
        else resolve();
      };
      const fail = () => finish(new Error("real footnote consumer did not mount"));
      const check = () => {
        if (container.querySelectorAll("sup.footnote-ref a").length === 2 && container.querySelectorAll("a.footnote-backref").length === 2) finish();
      };
      const observer = new dom.window.MutationObserver(check);
      observer.observe(container, { childList: true, subtree: true });
      signal.addEventListener("abort", fail, { once: true });
      root.render(React.createElement(MarkdownBlocksRenderer, { blocks: store.getBlocks(), store }));
      check();
    });
    const { refs, backrefs, footer } = assertTargets(container);
    const click = async (anchor: HTMLAnchorElement) => {
      await new Promise<void>((resolve, reject) => {
        const signal = AbortSignal.timeout(10_000);
        const finish = (error?: Error) => {
          dom.window.removeEventListener("hashchange", changed);
          signal.removeEventListener("abort", fail);
          if (error) reject(error);
          else resolve();
        };
        const fail = () => finish(new Error("real footnote anchor did not navigate"));
        const changed = () => {
          try {
            assert.strictEqual(dom.window.location.hash, anchor.hash);
            finish();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        };
        dom.window.addEventListener("hashchange", changed);
        signal.addEventListener("abort", fail, { once: true });
        anchor.click();
      });
    };
    await click(refs[0]);
    assert.strictEqual(dom.window.document.getElementById(dom.window.location.hash.slice(1)), footer);
    await click(backrefs[1]);
    assert.strictEqual(dom.window.document.getElementById(dom.window.location.hash.slice(1)), refs[1], "mounted second backlink must navigate to the second nested HTML occurrence");
  } finally {
    root.unmount();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

await runFootnotesFinalizeTest();
await runPreparedFootnoteConsumerTest();
await runRepeatedReferenceTargetsTest();
console.log("worker-footnotes-finalize test passed");
