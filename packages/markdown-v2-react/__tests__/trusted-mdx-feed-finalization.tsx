import assert from "node:assert/strict";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { Block, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { compileTrustedMdxDocument } from "@stream-mdx/worker/mdx-compile";
import type { TrustedMdxEngine } from "../src/trusted-mdx-contract";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "../src/streaming-markdown";
import {
  deferred,
  features,
  makeEngine,
  waitFor,
  workerFactory,
} from "./trusted-native-fixture";

export async function testTrustedFeedFinalizationBarrier(): Promise<void> {
  const Card: React.FC<{ value?: string }> = ({ value }) => (
    <span data-feed-barrier-value={value}>{value}</span>
  );
  const sourceFor = (value: string) => [
    'import { Card } from "host:widgets";',
    `export const sourceValue = ${JSON.stringify(value)};`,
    "",
    "<Card value={sourceValue} />",
    "",
    "```js",
    `const nativeValue = ${JSON.stringify(value)};`,
    "```",
  ].join("\n");
  const committedSource = sourceFor("committed");
  const pendingSource = sourceFor("candidate");
  const nextGenerationSource = sourceFor("accepted after reset");
  const sameTickSource = sourceFor("same tick rejected");
  const forbiddenAppend = '\n\n<Card value="forbidden append" />';
  const compileGate = deferred<void>();
  let pendingCompileStarted = false;
  const engine: TrustedMdxEngine = makeEngine(Card, async (source) => {
    if (source === pendingSource) {
      pendingCompileStarted = true;
      await compileGate.promise;
    }
    return compileTrustedMdxDocument(source);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = createRef<StreamingMarkdownHandle>();
  const workerRef: { current: Worker | null } = { current: null };
  const trackedWorkerFactory = (): Worker => {
    const worker = workerFactory();
    workerRef.current = worker;
    return worker;
  };
  const renderSource = async (source: string | undefined): Promise<void> => {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          engine="worker"
          worker={trackedWorkerFactory}
          contentPolicy="trusted-mdx"
          engines={{ mdx: engine }}
          features={features}
          text={source}
          caret={false}
        />,
      );
    });
  };
  const nativeBlockImage = (): string => JSON.stringify(
    (handle.current?.getState().blocks ?? []).map((block: Block) => ({
      id: block.id,
      type: block.type,
      isFinalized: block.isFinalized,
      raw: block.payload.raw,
      range: block.payload.range,
    })),
  );

  try {
    await renderSource(committedSource);
    await waitFor(
      () => container.querySelector('[data-feed-barrier-value="committed"]') !== null,
      "the initial complete trusted source is host committed",
    );

    await renderSource(pendingSource);
    await waitFor(
      () => pendingCompileStarted && container.querySelector("[data-trusted-mdx-retained-frame]") !== null,
      "a held candidate compile leaves the prior captured native frame visible",
    );
    await act(async () => { await handle.current?.waitForIdle(); });
    const retainedFrame = container.querySelector<HTMLElement>("[data-trusted-mdx-retained-frame]");
    if (retainedFrame === null) throw new Error("Expected the previously committed native frame");
    const retainedMarkup = retainedFrame.innerHTML;
    assert.ok(
      Array.from(retainedFrame.querySelectorAll("pre")).some((pre) => pre.textContent === committedSource),
      "the retained frame labels its exact committed source",
    );
    assert.match(retainedMarkup, /data-feed-barrier-value="committed"/);
    assert.match(retainedMarkup, /nativeValue = "committed"/);
    const candidateBlockImage = nativeBlockImage();
    const candidateSource = container.querySelector("[data-trusted-mdx-current-candidate] pre")?.textContent ?? null;
    assert.equal(candidateSource, pendingSource, "the held candidate keeps its exact current source");

    const publicAppendError: { current: Error | null } = { current: null };
    await act(async () => {
      try {
        handle.current?.append(forbiddenAppend);
      } catch (error) {
        publicAppendError.current = error instanceof Error ? error : new Error(String(error));
      }
    });
    if (publicAppendError.current === null) throw new Error("The public append API accepted input after FINALIZE");

    const directWorker = workerRef.current;
    if (directWorker === null) throw new Error("Expected the inline worker adapter");
    const directAppendError: { current: Extract<WorkerOut, { type: "ERROR" }> | null } = { current: null };
    const observeDirectAppendError = (event: MessageEvent<WorkerOut>): void => {
      if (event.data.type === "ERROR" && event.data.phase === "APPEND") {
        directAppendError.current = event.data;
      }
    };
    directWorker.addEventListener("message", observeDirectAppendError);
    const directAppend: WorkerIn = { type: "APPEND", text: forbiddenAppend };
    directWorker.postMessage(directAppend);
    await waitFor(() => directAppendError.current !== null, "the inline worker adapter rejects a post-finalize APPEND");
    directWorker.removeEventListener("message", observeDirectAppendError);
    if (directAppendError.current === null) throw new Error("The inline worker adapter accepted post-finalize APPEND");
    assert.equal(nativeBlockImage(), candidateBlockImage, "rejected appends leave candidate blocks unchanged");
    assert.equal(
      container.querySelector("[data-trusted-mdx-current-candidate] pre")?.textContent ?? null,
      candidateSource,
      "rejected appends leave current candidate source unchanged",
    );
    assert.equal(container.querySelector("[data-trusted-mdx-retained-frame]") === retainedFrame, true);
    assert.equal(retainedFrame.innerHTML, retainedMarkup, "the prior captured source and native frame remain exact");
    assert.equal(container.querySelector('[data-feed-barrier-value="forbidden append"]'), null);

    compileGate.resolve();
    await waitFor(
      () => container.querySelector('[data-feed-barrier-value="candidate"]') !== null
        && container.querySelector("[data-trusted-mdx-retained-frame]") === null,
      "the held candidate commits after the finalization barrier rejects later input",
    );

    const previousWorker = workerRef.current;
    await renderSource(undefined);
    await act(async () => {
      handle.current?.restart();
      assert.equal(handle.current?.getState().workerReady, false, "restart closes readiness synchronously");
      handle.current?.append(sameTickSource);
    });
    assert.equal(handle.current?.getState().blocks.length, 0, "a same-tick append cannot reach the old worker");
    await waitFor(
      () => workerRef.current !== previousWorker && handle.current?.getState().workerReady === true,
      "reset starts a new worker generation and waits for INITIALIZED",
    );
    await act(async () => {
      handle.current?.append(nextGenerationSource);
      handle.current?.finalize();
    });
    await waitFor(
      () => container.querySelector('[data-feed-barrier-value="accepted after reset"]') !== null,
      "an APPEND accepted before FINALIZE drains and commits in the new generation",
    );
    assert.equal(container.querySelector('[data-feed-barrier-value="same tick rejected"]'), null);
  } finally {
    compileGate.resolve();
    await act(async () => { root.unmount(); });
    container.remove();
    engine.dispose();
  }
}
