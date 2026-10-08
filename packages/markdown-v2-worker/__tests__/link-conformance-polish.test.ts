import assert from "node:assert";
import type { InlineNode, Patch, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createRendererStore, type RendererStore } from "@stream-mdx/react/renderer/store";
import { createInlineEngineWorker } from "../src/engine/index";

function findLinkNodes(nodes: InlineNode[]): Array<{ href: string; title?: string; text: string }> {
  const links: Array<{ href: string; title?: string; text: string }> = [];
  for (const node of nodes) {
    if (node.kind === "link") {
      const text = (node.children ?? [])
        .map((c) => (c.kind === "text" ? c.text : ""))
        .join("");
      links.push({ href: node.href, title: node.title, text });
    }
    if ("children" in node && Array.isArray(node.children)) {
      links.push(...findLinkNodes(node.children as InlineNode[]));
    }
  }
  return links;
}

function compileDirect(text: string): Promise<RendererStore> {
  const { promise, resolve, reject } = Promise.withResolvers<RendererStore>();
  const worker = createInlineEngineWorker();
  const store = createRendererStore();

  worker.onmessage = (event: MessageEvent<WorkerOut>) => {
    const msg = event.data;
    if (msg.type === "INITIALIZED") {
      store.reset(msg.blocks);
    } else if (msg.type === "PATCH") {
      store.applyPatches(msg.patches as Patch[]);
    } else if (msg.type === "FINALIZED") {
      worker.terminate();
      resolve(store);
    } else if (msg.type === "ERROR") {
      worker.terminate();
      reject(new Error(msg.error.message));
    }
  };

  worker.postMessage({
    type: "INIT",
    initialContent: text,
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true },
  } as WorkerIn);

  worker.postMessage({ type: "FINALIZE" } as WorkerIn);
  return promise;
}

function compileStreamed(text: string, chunkSize = 5): Promise<RendererStore> {
  const { promise, resolve, reject } = Promise.withResolvers<RendererStore>();
  const worker = createInlineEngineWorker();
  const store = createRendererStore();

  worker.onmessage = (event: MessageEvent<WorkerOut>) => {
    const msg = event.data;
    if (msg.type === "INITIALIZED") {
      store.reset(msg.blocks);
    } else if (msg.type === "PATCH") {
      store.applyPatches(msg.patches as Patch[]);
    } else if (msg.type === "FINALIZED") {
      worker.terminate();
      resolve(store);
    } else if (msg.type === "ERROR") {
      worker.terminate();
      reject(new Error(msg.error.message));
    }
  };

  worker.postMessage({
    type: "INIT",
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true },
  } as WorkerIn);

  for (let i = 0; i < text.length; i += chunkSize) {
    worker.postMessage({ type: "APPEND", text: text.slice(i, i + chunkSize) } as WorkerIn);
  }

  worker.postMessage({ type: "FINALIZE" } as WorkerIn);
  return promise;
}

async function testPercentAndDecodedEntityLinks(): Promise<void> {
  // CommonMark cm503
  const doc1 = "[link](foo%20b&auml;)\n";
  const store1 = await compileDirect(doc1);
  const blocks1 = store1.getBlocks();
  assert.strictEqual(blocks1.length, 1);
  const links1 = findLinkNodes(blocks1[0].payload.inline ?? []);
  assert.strictEqual(links1.length, 1);
  assert.strictEqual(
    links1[0].href,
    "foo%20b%C3%A4",
    "cm503: href must preserve %20 and encode decoded &auml; entity to %C3%A4",
  );

  // Complex URL with %25 and entities
  const doc2 = "[complex](https://example.com/api?q=100%25%20done&amp;tag=caf&eacute;)\n";
  const store2 = await compileDirect(doc2);
  const blocks2 = store2.getBlocks();
  const links2 = findLinkNodes(blocks2[0].payload.inline ?? []);
  assert.strictEqual(links2.length, 1);
  assert.strictEqual(
    links2[0].href,
    "https://example.com/api?q=100%25%20done&tag=caf%C3%A9",
    "Must preserve %25 and %20 while decoding &amp; and encoding café Unicode",
  );
}

async function testNestedDefinitionsCm218(): Promise<void> {
  // CommonMark cm218: definition inside blockquote resolves earlier link
  const doc1 = "[foo]\n\n> [foo]: /url 'my title'\n";
  const store1 = await compileDirect(doc1);
  const blocks1 = store1.getBlocks();
  assert.ok(blocks1.length >= 1);
  const links1 = findLinkNodes(blocks1[0].payload.inline ?? []);
  assert.strictEqual(links1.length, 1, "cm218: earlier paragraph [foo] must be resolved to a link");
  assert.strictEqual(links1[0].href, "/url");
  assert.strictEqual(links1[0].title, "my title");

  // Multi-line blockquote definition with continuation QuoteMarks
  const doc2 = "[multi]\n\n> [multi]: /multi-url \"line 1\n> line 2\"\n";
  const store2 = await compileDirect(doc2);
  const blocks2 = store2.getBlocks();
  const links2 = findLinkNodes(blocks2[0].payload.inline ?? []);
  assert.strictEqual(links2.length, 1);
  assert.strictEqual(links2[0].href, "/multi-url");
  assert.strictEqual(links2[0].title, "line 1\nline 2");

  // Nested in list item
  const doc3 = "[listref]\n\n- [listref]: /list-target\n";
  const store3 = await compileDirect(doc3);
  const blocks3 = store3.getBlocks();
  const links3 = findLinkNodes(blocks3[0].payload.inline ?? []);
  assert.strictEqual(links3.length, 1);
  assert.strictEqual(links3[0].href, "/list-target");
}

async function testStreamingFinalParity(): Promise<void> {
  const fullText = [
    "[foo]",
    "",
    "> [foo]: /streaming-url \"streaming title\"",
    "",
    "Check [link](foo%20b&auml;) and [complex](https://example.com/?q=100%25%20done&amp;tag=caf&eacute;).",
  ].join("\n");

  const directStore = await compileDirect(fullText);
  const streamedStore = await compileStreamed(fullText, 4);

  const directBlocks = directStore.getBlocks();
  const streamedBlocks = streamedStore.getBlocks();

  assert.strictEqual(
    streamedBlocks.length,
    directBlocks.length,
    `Streaming block count (${streamedBlocks.length}) should match direct compile block count (${directBlocks.length})`,
  );

  // Verify first block link was resolved in both streaming and direct
  const streamedLinks0 = findLinkNodes(streamedBlocks[0].payload.inline ?? []);
  const directLinks0 = findLinkNodes(directBlocks[0].payload.inline ?? []);
  assert.strictEqual(streamedLinks0.length, 1);
  assert.strictEqual(directLinks0.length, 1);
  assert.strictEqual(streamedLinks0[0].href, "/streaming-url");
  assert.strictEqual(directLinks0[0].href, "/streaming-url");
  assert.strictEqual(streamedLinks0[0].title, "streaming title");
  assert.strictEqual(directLinks0[0].title, "streaming title");

  // Verify cm503 and percent preservation in last paragraph
  const streamedLinksLast = findLinkNodes(streamedBlocks[streamedBlocks.length - 1].payload.inline ?? []);
  const directLinksLast = findLinkNodes(directBlocks[directBlocks.length - 1].payload.inline ?? []);
  assert.strictEqual(streamedLinksLast.length, 2);
  assert.strictEqual(directLinksLast.length, 2);

  assert.strictEqual(streamedLinksLast[0].href, "foo%20b%C3%A4");
  assert.strictEqual(directLinksLast[0].href, "foo%20b%C3%A4");

  assert.strictEqual(streamedLinksLast[1].href, "https://example.com/?q=100%25%20done&tag=caf%C3%A9");
  assert.strictEqual(directLinksLast[1].href, "https://example.com/?q=100%25%20done&tag=caf%C3%A9");
}

async function run(): Promise<void> {
  await testPercentAndDecodedEntityLinks();
  await testNestedDefinitionsCm218();
  await testStreamingFinalParity();
  console.log("link-conformance-polish worker regression tests passed!");
}

run();
