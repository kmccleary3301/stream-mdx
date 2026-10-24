import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { applyPatchBatch, createBlockSnapshot, createInitialSnapshot, type Block, type InlineExtension, type InlineNode, type NodeSnapshot, type PreparedNestedSnapshot, type WorkerOut } from "@stream-mdx/core";
import { ComponentRegistry, MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { createRendererStore } from "@stream-mdx/react/renderer/store";
import { MarkdownEngine } from "../src/engine/engine";

function nativeBadge(label: string): InlineExtension {
  return {
    name: "NativeBadge",
    lezer: {
      defineNodes: ["NativeBadge"],
      parseInline: [{ name: "NativeBadge", before: "Emphasis", parse(cx, next, pos) {
        if (next !== 64 || cx.slice(pos, pos + 2) !== "@@") return -1;
        return cx.addElement(cx.elt("NativeBadge", pos, pos + 2));
      } }],
    },
    // The callback closes over state that cannot be recreated from INIT JSON.
    toInline(element, text) {
      return { kind: "plugin", name: "native-badge", attrs: { label }, raw: text.slice(element.from, element.to) };
    },
  };
}

function descendants(snapshot: NodeSnapshot): NodeSnapshot[] {
  const result = [snapshot];
  for (const child of snapshot.children ?? []) result.push(...descendants(child));
  return result;
}

function inlineNodes(snapshot: NodeSnapshot): InlineNode[] {
  const block = snapshot.props?.block as Block | undefined;
  const nodes = block?.payload.inline ?? snapshot.props?.inline as InlineNode[] | undefined ?? [];
  return nodes.flatMap((node) => [node, ...("children" in node && Array.isArray(node.children) ? node.children : [])]);
}

async function run(): Promise<void> {
  let snapshot = createInitialSnapshot();
  const store = createRendererStore();
  const emitted: WorkerOut[] = [];
  const engine = new MarkdownEngine({ extensions: { inline: [nativeBadge("first-instance")] }, post(message) {
    emitted.push(message);
    if (message.type === "INITIALIZED") {
      store.resetSnapshot(message.snapshot);
      snapshot = createInitialSnapshot(message.snapshot);
    } else if (message.type === "PATCH") {
      applyPatchBatch(snapshot, message.patches);
      store.applyPatches(message.patches, { captureMetrics: false });
    } else if (message.type === "ERROR") throw new Error(message.error.message);
  } });
  const markdown = "- @@ #ABC-12 [forward]\n\n  > # @@ #ABC-12 [forward]\n\n  ```js\n  const nested = 1;\n  ```";
  await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: markdown, prewarmLangs: [],
    syntax: {
      contractVersion: 1,
      inline: [{ name: "ticket", pattern: { source: "#([A-Z]+-\\d+)" }, attrs: { id: 1 } }],
    },
    docPlugins: { html: true, tables: true, mdx: false, math: true, callouts: false, footnotes: false } });
  assert.equal(emitted.some((message) => message.type === "ERROR"), false);
  const initialList = store.getBlocks().find((block) => block.type === "list");
  assert.ok(initialList);
  const initialChildren = descendants(createBlockSnapshot(initialList));
  const initialHeading = initialChildren.find((child) => child.type === "heading");
  const initialCode = initialChildren.find((child) => child.type === "code");
  assert.ok(initialHeading);
  assert.ok(initialCode);
  for (const target of [initialChildren.find((child) => child.type === "list-item"), initialHeading]) {
    assert.ok(target);
    const nodes = inlineNodes(target);
    assert.ok(nodes.some((node) => node.kind === "plugin" && node.name === "native-badge" && node.attrs.label === "first-instance"));
    assert.ok(nodes.some((node) => node.kind === "plugin" && node.name === "ticket" && node.attrs.id === "ABC-12"));
  }
  await engine.handle({ type: "APPEND", text: "\n\n[forward]: /resolved \"title\"\n" });
  await engine.handle({ type: "FINALIZE" });
  const list = store.getBlocks().find((block) => block.type === "list");
  assert.ok(list);
  assert.ok(list.payload.meta?.preparedNested);
  const final = createBlockSnapshot(JSON.parse(JSON.stringify(list)) as Block);
  const nested = descendants(final);
  for (const target of nested.filter((node) => node.type === "heading" || node.type === "list-item")) {
    assert.ok(inlineNodes(target).some((node) => node.kind === "link" && node.href === "/resolved" && node.title === "title"), "forward definition must re-enrich nested content");
  }
  const code = nested.find((node) => node.type === "code");
  assert.ok(code);
  assert.deepEqual(store.getInvariantViolations(), []);
  assert.deepStrictEqual(snapshot.getBlocks(), store.getBlocks(), "core and React patch consumers must retain equivalent blocks");
  const resetStore = createRendererStore(JSON.parse(JSON.stringify(store.getBlocks())) as Block[]);
  const registry = new ComponentRegistry({
    components: {
      "extension:native-badge": {
        view: ({ node }: { node: InlineNode }) => node.kind === "plugin"
          ? React.createElement("b", null, String(node.attrs.label ?? ""))
          : null,
      },
      "extension:ticket": {
        view: ({ node }: { node: InlineNode }) => node.kind === "plugin"
          ? React.createElement("i", null, String(node.attrs.id ?? ""))
          : null,
      },
    },
  });
  const htmlFromPatches = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: store.getBlocks(), store, componentRegistry: registry }));
  const htmlFromSerialized = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: resetStore.getBlocks(), store: resetStore, componentRegistry: registry }));
  assert.equal(htmlFromSerialized, htmlFromPatches);
  const serializedDom = new JSDOM(htmlFromSerialized);
  assert.equal(serializedDom.window.document.querySelector("pre code")?.textContent, "const nested = 1;\n", "nested code content must survive JSON reset");
  serializedDom.window.close();
  assert.ok(htmlFromSerialized.includes("first-instance"));
  assert.ok(htmlFromSerialized.includes('href="/resolved"'));
  engine.dispose();

  const other: Block[] = [];
  const second = new MarkdownEngine({ extensions: { inline: [nativeBadge("second-instance")] }, post(message) {
    if (message.type === "INITIALIZED") other.push(...createInitialSnapshot(message.snapshot).getBlocks());
    if (message.type === "ERROR") throw new Error(message.error.message);
  } });
  await second.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "> @@", prewarmLangs: [], docPlugins: { mdx: false, callouts: false } });
  const secondPrepared = other[0].payload.meta?.preparedNested as PreparedNestedSnapshot;
  assert.ok(descendants({ id: "root", type: "root", children: secondPrepared.children }).some((node) => inlineNodes(node).some((inline) => inline.kind === "plugin" && inline.attrs.label === "second-instance")));
  assert.equal(JSON.stringify(other).includes("first-instance"), false, "owning parser state must not leak across engines");
  other.length = 0;
  await second.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "> <pre>\n>     literal\n> </pre>\n", prewarmLangs: [], docPlugins: { mdx: false, callouts: false } });
  const literalHtml = renderToStaticMarkup(React.createElement(MarkdownBlocksRenderer, { blocks: other }));
  assert.equal(new JSDOM(literalHtml).window.document.querySelector("pre")?.textContent, "    literal\n", "native pre consumes only the first source LF and preserves nested indentation");
  second.dispose();
}

await run();
console.log("nested owning engine snapshots passed");
