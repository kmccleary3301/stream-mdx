import type { Block, NodeSnapshot, Patch } from "@stream-mdx/core";
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
import { createRendererStore } from "../src/renderer/store";

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
async function headingActionRejectsResetWithReusedOwnerEpoch(): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const headingBlock = (raw: string): Block => ({
    id: "reset-heading",
    type: "heading",
    isFinalized: true,
    payload: {
      raw,
      inline: [{ kind: "text", text: raw.replace(/^#+\s*/, "") }],
      meta: { headingLevel: 2 },
    },
  });
  const snapshot = (block: Block): NodeSnapshot => ({
    id: "__root__",
    type: "__root__",
    children: [{
      id: block.id,
      type: block.type,
      props: { block },
      meta: { blockEpoch: 41 },
    }],
  });
  const store = createRendererStore();
  store.resetSnapshot(snapshot(headingBlock("## initial heading")));
  const initialOwner = store.getNode("reset-heading");
  assert.ok(initialOwner, "the initial heading owner is present");
  let readSource: (() => string) | undefined;
  const components = {
    heading: {
      wrapper: ({ children, actions }: { children?: React.ReactNode; actions: { readSource: () => string } }) => {
        readSource = actions.readSource;
        return <>{children}</>;
      },
    },
  } satisfies NodePresentations;
  try {
    await act(async () => {
      root.render(<MarkdownBlocksRenderer blocks={store.getBlocks()} store={store} components={components} />);
    });
    await waitFor(() => readSource !== undefined, "heading wrapper exposes its source action");

    store.resetSnapshot(snapshot(headingBlock("## replacement heading")));
    const replacementOwner = store.getNode("reset-heading");
    assert.ok(replacementOwner, "the reset reuses the heading owner ID");
    assert.equal(replacementOwner.type, initialOwner.type, "the reset reuses the heading type");
    assert.equal(replacementOwner.blockEpoch, initialOwner.blockEpoch, "the reset reuses the block epoch");
    assert.equal(replacementOwner.block?.payload.raw, "## replacement heading", "the reset installs different source");
    assert.throws(readSource, /Cannot read source from a stale or removed node/);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}


async function legacyTableCellActionRejectsCellPatch(): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const tableId = "legacy-table";
  const cellId = `${tableId}::body::row:0::cell:0`;
  const tableBlock: Block = {
    id: tableId,
    type: "table",
    isFinalized: true,
    payload: {
      raw: "| Heading |\n| --- |\n| old cell |",
      meta: {
        header: [[{ kind: "text", text: "Heading" }]],
        rows: [[[ { kind: "text", text: "old cell" } ]]],
        align: [null],
      },
    },
  };
  const snapshot: NodeSnapshot = {
    id: "__root__",
    type: "__root__",
    children: [{
      id: tableId,
      type: "table",
      props: { block: tableBlock },
      meta: { blockEpoch: 17 },
      children: [
        {
          id: `${tableId}::header`,
          type: "table-header",
          props: {},
          children: [{
            id: `${tableId}::header::cell:0`,
            type: "table-header-cell",
            props: { raw: "Heading", inline: [{ kind: "text", text: "Heading" }] },
          }],
        },
        {
          id: `${tableId}::body`,
          type: "table-body",
          props: {},
          children: [{
            id: `${tableId}::body::row:0`,
            type: "table-row",
            props: {},
            children: [{
              id: cellId,
              type: "table-cell",
              props: { raw: "old cell", inline: [{ kind: "text", text: "old cell" }] },
            }],
          }],
        },
      ],
    }],
  };
  const store = createRendererStore();
  store.resetSnapshot(snapshot);
  assert.equal(store.getTableBlock(tableId), undefined, "the fixture selects the legacy table renderer");
  const cellRecord = store.getNode(cellId);
  assert.ok(cellRecord, "the legacy table cell has a store record");
  let readSource: (() => string) | undefined;
  const components = {
    "table-cell": {
      wrapper: ({ metadata, children, actions }: {
        metadata: { id: string };
        children?: React.ReactNode;
        actions: { readSource: () => string };
      }) => {
        if (metadata.id === cellId && readSource === undefined) readSource = actions.readSource;
        return <>{children}</>;
      },
    },
  } satisfies NodePresentations;
  try {
    await act(async () => {
      root.render(<MarkdownBlocksRenderer blocks={store.getBlocks()} store={store} components={components} />);
    });
    await waitFor(() => readSource !== undefined, "legacy table cell exposes its source action");
    assert.equal(readSource!(), "old cell");

    await act(async () => {
      store.applyPatches([{
        op: "setProps",
        at: { blockId: tableId, nodeId: cellId },
        props: { raw: "replacement cell", inline: [{ kind: "text", text: "replacement cell" }] },
        meta: { kind: "semantic", blockEpoch: cellRecord.blockEpoch },
      } satisfies Patch]);
    });
    await waitFor(() => container.querySelector("td")?.textContent === "replacement cell", "the legacy cell patch reaches the view");
    assert.ok(store.getNode(cellId)!.version > cellRecord.version, "the cell record revision advances");
    assert.throws(readSource, /Cannot read source from a stale or removed node/);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}

await inlineHtmlAndComponentActionsRejectOwnerUpdates();
await legacyTableCellActionRejectsCellPatch();
await headingActionRejectsResetWithReusedOwnerEpoch();
console.log("stale readSource action regressions passed");
