import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { JSDOM } from "jsdom";
import type { InlineExtension, InlineNode } from "@stream-mdx/core";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { createMarkdownSnapshotCompiler } from "@stream-mdx/worker/direct";
import type { NodePresentations } from "@stream-mdx/react";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";

function nativeBadge(label: string): InlineExtension {
  return {
    name: "SnapshotBadge",
    lezer: {
      defineNodes: ["SnapshotBadge"],
      parseInline: [{
        name: "SnapshotBadge",
        before: "Emphasis",
        parse(cx, next, pos) {
          if (next !== 64 || cx.slice(pos, pos + 2) !== "@@") return -1;
          return cx.addElement(cx.elt("SnapshotBadge", pos, pos + 2));
        },
      }],
    },
    toInline(element, source) {
      return { kind: "plugin", name: "snapshot-badge", attrs: { label }, raw: source.slice(element.from, element.to) };
    },
  };
}

function findBadge(blocks: readonly { payload: { inline?: InlineNode[] } }[]): InlineNode | undefined {
  return blocks.flatMap((block) => block.payload.inline ?? []).find(
    (node) => node.kind === "plugin" && node.name === "snapshot-badge",
  );
}

async function extensionAwareSnapshotCompilesAndRendersOnClient(): Promise<void> {
  const extensionId = "snapshot-badge-v1";
  const compiler = createMarkdownSnapshotCompiler({
    extensions: { inline: [nativeBadge("stored snapshot")] },
    extensionId,
  });
  const snapshot = await compiler.compile({ text: "Finalized @@ document" });
  const badge = findBadge(snapshot.blocks);
  assert.equal(badge?.kind, "plugin");
  if (badge?.kind !== "plugin") throw new Error("Expected the native snapshot badge");
  assert.equal(badge.attrs.label, "stored snapshot");

  const presentations = {
    "extension:snapshot-badge": {
      view: ({ node }: { node: InlineNode }) => node.kind === "plugin"
        ? React.createElement("mark", { "data-rendered-from-snapshot": "true" }, String(node.attrs.label ?? ""))
        : null,
    },
  } satisfies NodePresentations;
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const globals = ["window", "document", "Node", "Element", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const original: Record<typeof globals[number], PropertyDescriptor | undefined> = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    Node: Object.getOwnPropertyDescriptor(globalThis, "Node"),
    Element: Object.getOwnPropertyDescriptor(globalThis, "Element"),
    HTMLElement: Object.getOwnPropertyDescriptor(globalThis, "HTMLElement"),
    IS_REACT_ACT_ENVIRONMENT: Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  };
  const target = globalThis as unknown as Record<string, unknown>;
  Object.assign(target, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    act(() => {
      flushSync(() => {
        root.render(React.createElement(MarkdownBlocksRenderer, {
          blocks: snapshot.blocks,
          components: presentations,
        }));
      });
    });
    assert.equal(container.querySelector("mark[data-rendered-from-snapshot='true']")?.textContent, "stored snapshot");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const name of globals) {
      const descriptor = original[name];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

async function hostWorkerSnapshotQueueIsSerializedAndBounded(): Promise<void> {
  const extensionId = "hosted-snapshot-badge-v1";
  const worker = createInlineEngineWorker({ extensions: { inline: [nativeBadge("host worker")] }, extensionId });
  const compiler = createMarkdownSnapshotCompiler({ worker, extensionId, maxQueueSize: 2 });
  try {
    const first = compiler.compile({ text: "First @@ document" });
    const second = compiler.compile({ text: "Second @@ document" });
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    assert.equal(findBadge(firstSnapshot.blocks)?.kind, "plugin");
    assert.equal(findBadge(secondSnapshot.blocks)?.kind, "plugin");

    const bounded = createMarkdownSnapshotCompiler({ worker, extensionId, maxQueueSize: 1 });
    const active = bounded.compile({ text: "Active @@ document" });
    await assert.rejects(bounded.compile({ text: "Over capacity @@ document" }), /queue is full/);
    await active;
  } finally {
    worker.terminate();
  }
}

await extensionAwareSnapshotCompilesAndRendersOnClient();
await hostWorkerSnapshotQueueIsSerializedAndBounded();
console.log("extension-aware client snapshots passed");
