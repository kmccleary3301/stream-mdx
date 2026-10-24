import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import type { CodeNodeHandle } from "@stream-mdx/core";
import {
  NativeNodeView,
  PreviewSlot,
  StreamingMarkdown,
  type NodeHandle,
  type NodeRevisionFeed,
  type NodeRevisionSnapshot,
  type PreviewRuntime,
  type StreamingMarkdownHandle,
} from "@stream-mdx/react";
import type { PreviewRuntime as UmbrellaPreviewRuntime } from "stream-mdx";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type CapturedRevision = {
  readonly feed: NodeRevisionFeed;
  readonly snapshot: NodeRevisionSnapshot;
  readonly source: string;
};
type CaptureRevision = (entry: CapturedRevision) => void;
const CaptureRevisionContext = React.createContext<CaptureRevision>(() => {});

function NativeCodeSlot({ handle }: { readonly handle: CodeNodeHandle }): React.ReactElement {
  return (
    <PreviewSlot handle={handle}>
      <NativeNodeView handle={handle} />
    </PreviewSlot>
  );
}

function GenericParagraphSlot({ handle }: { readonly handle: NodeHandle }): React.ReactElement {
  return (
    <PreviewSlot handle={handle} runtime={fakeRuntime}>
      <NativeNodeView handle={handle} />
    </PreviewSlot>
  );
}


function FakePreviewView({
  feed,
  snapshot,
  fallback,
}: {
  readonly feed: NodeRevisionFeed;
  readonly snapshot: NodeRevisionSnapshot;
  readonly fallback: React.ReactNode;
}): React.ReactElement {
  const capture = React.useContext(CaptureRevisionContext);
  capture({ feed, snapshot, source: feed.readSource() });
  return (
    <section data-fake-preview data-revision={snapshot.revision} data-finalized={snapshot.isFinalized}>
      {fallback}
    </section>
  );
}

function RuntimeCodeSlot({ handle }: { readonly handle: CodeNodeHandle }): React.ReactElement {
  return (
    <PreviewSlot handle={handle} runtime={fakeRuntime}>
      <NativeNodeView handle={handle} />
    </PreviewSlot>
  );
}

const fakeRuntime: PreviewRuntime = { id: "fake", view: FakePreviewView };
const umbrellaRuntimeTypeCheck: UmbrellaPreviewRuntime = fakeRuntime;
void umbrellaRuntimeTypeCheck;

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${message}`);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
}

type PreviewTestComponents = React.ComponentProps<typeof StreamingMarkdown>["components"];

async function withStreamingView(
  components: PreviewTestComponents,
  capture: CaptureRevision,
  onReady: (streamRef: React.RefObject<StreamingMarkdownHandle | null>, container: HTMLElement) => Promise<void>,
): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Worker: NodeWorker,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const globalKeys = Object.keys(globals) as Array<keyof typeof globals>;
  const previousGlobals = Object.fromEntries(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<keyof typeof globals, PropertyDescriptor | undefined>;
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const streamRef = React.createRef<StreamingMarkdownHandle>();
  const worker = createInlineEngineWorker() as unknown as Worker;
  let root: Root | undefined;
  try {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <CaptureRevisionContext.Provider value={capture}>
          <StreamingMarkdown
            ref={streamRef}
            engine="worker"
            worker={() => worker}
            components={components}
            features={{ html: false, mdx: false, tables: false, math: false }}
            caret={false}
          />
        </CaptureRevisionContext.Provider>,
      );
    });
    await waitFor(() => streamRef.current?.getState().workerReady === true, "the worker to become ready");
    assert.ok(streamRef.current, "the public streaming handle is available");
    await onReady(streamRef, container);
  } finally {
    try {
      if (root) await act(async () => root!.unmount());
    } finally {
      await worker.terminate();
      container.remove();
      for (const key of globalKeys) {
        const descriptor = previousGlobals[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  }
}

async function testNativeFallbackIsInert(): Promise<void> {
  await withStreamingView({ code: { view: NativeCodeSlot } }, () => {}, async (streamRef) => {
    await act(async () => {
      streamRef.current!.append("```typescript\nconst preview = 42;\n");
    });
    await waitFor(
      () => document.querySelector("[data-stream-mdx-preview-slot] pre code")?.textContent?.includes("const preview = 42;") === true,
      "native code inside an inert slot",
    );
    const slot = document.querySelector<HTMLElement>("[data-stream-mdx-preview-slot]");
    assert.ok(slot, "the native presentation is wrapped by PreviewSlot");
    assert.equal(slot.dataset.previewRuntime, "none");
    assert.equal(slot.querySelector("pre code")?.textContent, "const preview = 42;\n");
    assert.equal(document.querySelector("[data-fake-preview]"), null, "no preview runtime is invoked without an explicit runtime");
  });
}

async function testRuntimeFeedStreamsAndBecomesStale(): Promise<void> {
  const entries: CapturedRevision[] = [];
  const capture: CaptureRevision = (entry) => entries.push(entry);
  await withStreamingView({ code: { view: RuntimeCodeSlot } }, capture, async (streamRef) => {
    await act(async () => {
      streamRef.current!.append("```typescript\nconst first = 1;\n");
    });
    await waitFor(() => entries.length > 0, "the fake runtime to receive its initial code revision");
    const firstStreaming = entries.find((entry) => !entry.snapshot.isFinalized);
    assert.ok(firstStreaming, "the runtime receives an open code revision");
    await act(async () => {
      streamRef.current!.append("const second = 2;\n");
    });
    await waitFor(
      () => entries.some((entry) => !entry.snapshot.isFinalized && entry.snapshot.revision > firstStreaming.snapshot.revision),
      "a newer streaming code revision",
    );
    await act(async () => {
      await streamRef.current!.finalize();
    });
    await waitFor(() => entries.some((entry) => entry.snapshot.isFinalized), "the finalized code revision");

    const streamingEntries = entries.filter((entry) => !entry.snapshot.isFinalized);
    assert.ok(streamingEntries.length >= 2, "the runtime observes multiple streaming revisions");
    assert.ok(
      streamingEntries.at(-1)!.snapshot.revision > streamingEntries[0]!.snapshot.revision,
      "streaming revisions increase",
    );
    const finalEntry = entries.at(-1)!;
    assert.equal(finalEntry.snapshot.isFinalized, true);
    assert.equal(finalEntry.source, "```typescript\nconst first = 1;\nconst second = 2;\n");
    assert.equal(finalEntry.feed.readSource(), "```typescript\nconst first = 1;\nconst second = 2;\n");
    assert.ok(Object.isFrozen(finalEntry.snapshot), "revision snapshots are immutable");
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1]!;
      const current = entries[index]!;
      if (
        previous.snapshot.revision === current.snapshot.revision &&
        previous.snapshot.isFinalized === current.snapshot.isFinalized
      ) {
        assert.strictEqual(current.snapshot, previous.snapshot, "unchanged revisions preserve snapshot identity");
      }
    }

    const retainedFeed = finalEntry.feed;
    const previousHandle = streamRef.current!;
    await act(async () => {
      previousHandle.restart();
    });
    await waitFor(
      () => streamRef.current !== previousHandle && streamRef.current?.getState().workerReady === true,
      "the restarted document generation",
    );
    assert.throws(
      () => retainedFeed.readSource(),
      /Code node handle no longer refers to the current code document/,
      "a previously captured feed rejects source reads after restart",
    );
  });
}


async function testGenericHandleReadsStoreSource(): Promise<void> {
  const entries: CapturedRevision[] = [];
  const capture: CaptureRevision = (entry) => entries.push(entry);
  await withStreamingView({ paragraph: { view: GenericParagraphSlot } }, capture, async (streamRef) => {
    await act(async () => {
      streamRef.current!.append("store-backed paragraph source");
      await streamRef.current!.finalize();
    });
    await waitFor(
      () => entries.some((entry) => entry.source === "store-backed paragraph source"),
      "the store-backed generic node source",
    );
    const paragraph = entries.find((entry) => entry.snapshot.type === "paragraph");
    assert.ok(paragraph, "the generic handle publishes a paragraph revision");
    assert.equal(paragraph.source, "store-backed paragraph source");
    assert.equal(paragraph.feed.readSource(), "store-backed paragraph source");
  });
}

await testNativeFallbackIsInert();
await testRuntimeFeedStreamsAndBecomesStale();
await testGenericHandleReadsStoreSource();
console.log("preview slot tests passed");
