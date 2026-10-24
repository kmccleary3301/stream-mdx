import type { Patch } from "@stream-mdx/core";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  defineContentComponent,
  MarkdownBlocksRenderer,
  StreamingMarkdown,
  type ContentComponentHostProps,
  type NodePresentations,
  type StreamingMarkdownHandle,
} from "../src";
import { installTrustedNativeTestDom, waitFor, workerFactory } from "./trusted-native-fixture";

async function inlineHtmlAndComponentActionsRejectOwnerUpdates(): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const presentationContainer = document.createElement("div");
  document.body.append(presentationContainer);
  const presentationRoot = createRoot(presentationContainer);
  const stream = React.createRef<StreamingMarkdownHandle>();
  const saved = new Map<string, () => string>();
  const capture = (key: string) => ({
    wrapper: ({ children, actions }: { children?: React.ReactNode; actions: { readSource: () => string } }) => {
      if (!saved.has(key)) saved.set(key, actions.readSource);
      return <>{children}</>;
    },
  });
  const components = {
    "inline:strong": capture("inline"),
    "html:span": capture("html"),
    "component:Callout": capture("component"),
  } satisfies NodePresentations;
  const Callout: React.FC<ContentComponentHostProps & Record<string, unknown>> = ({ children }) => <aside>{children}</aside>;
  const contentComponents = {
    Callout: defineContentComponent({ component: Callout, renderWhen: "open" }),
  };
  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={stream}
          worker={() => workerFactory()}
          engine="worker"
          contentPolicy="restricted"
          contentComponents={contentComponents}
          syntax={{ contractVersion: 1, containers: [{ name: "callout", component: "Callout" }] }}
          features={{ html: true, mdx: true, tables: false, math: false }}
          caret={false}
        />,
      );
    });
    await waitFor(() => stream.current?.getState().workerReady === true, "stale action worker ready");
    await act(async () => {
      stream.current?.append(":::callout\n**inline-old** <span>html-old</span>\n");
      await stream.current?.waitForIdle();
    });
    const store = stream.current!.getState().store;
    await waitFor(() => store.getBlocks().length > 0, "the stream store contains the callout owner");
    const owner = store.getBlocks()[0];
    assert.ok(owner, "the open callout owns a block");
    await act(async () => {
      presentationRoot.render(
        <MarkdownBlocksRenderer
          blocks={store.getBlocks()}
          store={store}
          components={components}
          contentComponents={contentComponents}
        />,
      );
    });
    await waitFor(() => saved.size === 3, "inline, HTML, and registered component actions are captured");
    const ownerRecord = store.getNode(owner.id);
    assert.ok(ownerRecord, "the open callout has a store record");
    const nextBlock = {
      ...owner,
      payload: { ...owner.payload, raw: `${owner.payload.raw}\nappended` },
    };
    await act(async () => {
      store.applyPatches([{
        op: "setProps",
        at: { blockId: owner.id, nodeId: owner.id },
        props: { block: nextBlock },
        meta: { kind: "semantic", blockEpoch: ownerRecord.blockEpoch },
      } satisfies Patch]);
    });
    assert.ok(
      store.getNode(owner.id)!.version > ownerRecord.version,
      "the owner revision advances before saved source actions are read",
    );

    for (const kind of ["inline", "html", "component"]) {
      const readSource = saved.get(kind);
      assert.ok(readSource, `${kind} presentation exposes readSource`);
      assert.throws(readSource, /stale|current|owner/i, `${kind} action rejects after its owner revision changes`);
    }
  } finally {
    await act(async () => root.unmount());
    await act(async () => presentationRoot.unmount());
    restore();
  }
}

await inlineHtmlAndComponentActionsRejectOwnerUpdates();
console.log("stale readSource action regressions passed");
