import assert from "node:assert/strict";
import { StreamingMarkdown, NativeNodeView, useNode, useNodeChildren, createRendererStore, type NodeHandle, type NodeHandleMetadata, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Block } from "@stream-mdx/core";

type QuoteSnapshot = {
  readonly metadata: NodeHandleMetadata;
  readonly children: readonly NodeHandle[];
};

const snapshots: QuoteSnapshot[] = [];

function HeadlessQuote({ handle }: { readonly handle: NodeHandle }): React.ReactElement {
  const metadata = useNode(handle);
  const children = useNodeChildren(handle, { from: 0, to: metadata.childCount });
  snapshots.push({ metadata, children });
  return (
    <blockquote data-headless-quote data-child-count={metadata.childCount}>
      {children.map((child) => <NativeNodeView key={child.id} handle={child} />)}
    </blockquote>
  );
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${message}`);
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  }
}


function createMetadataTestBlock(text: string): Block {
  return {
    id: "shared-node",
    type: "paragraph",
    isFinalized: true,
    payload: { raw: text, inline: [{ kind: "text", text }] },
  };
}

async function staleMetadataSubscriptionsStayBoundToTheirGeneration(): Promise<void> {
  const store = createRendererStore([createMetadataTestBlock("A")]);
  const staleHandle = store.getNodeHandle("shared-node");
  assert.ok(staleHandle);
  let notifications = 0;
  staleHandle.subscribeMetadata(() => { notifications += 1; });

  store.reset([createMetadataTestBlock("B")]);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(notifications, 0, "metadata listeners stop when their captured record is replaced");

  store.reset([createMetadataTestBlock("A")]);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  staleHandle.subscribeMetadata(() => { notifications += 1; });
  store.reset([createMetadataTestBlock("A again")]);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(notifications, 0, "a stale handle cannot subscribe to a reused node ID after an A-B-A reset");
}

async function runNodeHandleHooksTest(): Promise<void> {
  await staleMetadataSubscriptionsStayBoundToTheirGeneration();
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.fromEntries(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<keyof typeof globals, PropertyDescriptor | undefined>;
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root: Root = createRoot(container);
  const stream = React.createRef<StreamingMarkdownHandle>();
  snapshots.length = 0;
  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={stream}
          engine="main"
          components={{ blockquote: { view: HeadlessQuote } }}
          features={{ html: false, mdx: false, tables: false, math: false }}
          caret={false}
        />,
      );
    });
    assert.ok(stream.current);
    await act(async () => {
      stream.current!.append("> first\n>\n");
    });
    await waitFor(() => snapshots.some(({ metadata }) => metadata.childCount === 1), "the first quote child");
    const firstSnapshot = snapshots.find(({ metadata }) => metadata.childCount === 1);
    assert.ok(firstSnapshot);
    await waitFor(() => container.querySelector("[data-headless-quote] p")?.textContent === "first", "native paragraph fallback");
    assert.equal(container.querySelectorAll("[data-headless-quote]").length, 1, "the headless quote does not recursively re-enter its presentation");

    await act(async () => {
      stream.current!.append("> > second\n");
    });
    await waitFor(() => snapshots.some(({ metadata }) => metadata.childCount === 2), "the appended quote child range");
    await waitFor(() => container.querySelectorAll("[data-headless-quote] p").length === 2, "both native child paragraphs");
    assert.equal(container.querySelector("[data-headless-quote] blockquote p")?.textContent, "second", "a nested quote child uses its native fallback instead of recursively re-entering its headless view");
    const appendedSnapshot = snapshots.slice().reverse().find(({ metadata }) => metadata.childCount === 2);
    assert.ok(appendedSnapshot);
    assert.equal(appendedSnapshot.children[0], firstSnapshot.children[0], "the unchanged child handle remains stable across append");
    assert.deepEqual(
      Array.from(container.querySelectorAll("[data-headless-quote] p"), (paragraph) => paragraph.textContent),
      ["first", "second"],
    );
    assert.equal(container.querySelectorAll("[data-headless-quote]").length, 1, "native children render without quote-view recursion");
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

void runNodeHandleHooksTest();
