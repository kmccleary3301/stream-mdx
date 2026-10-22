import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Block } from "@stream-mdx/core";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { compileTrustedMdxDocument } from "@stream-mdx/worker/mdx-compile";
import { TrustedMdxProjectionContext } from "../src/trusted-mdx-boundary";
import { TrustedMdxInlineOwner } from "../src/trusted-mdx/native-inline";
import type { TrustedMdxDocument, TrustedMdxDocumentSnapshot } from "../src/trusted-mdx-contract";
import { createTrustedMdxEngine } from "../src/trusted-mdx";

export function installTrustedNativeTestDom(): () => void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Worker: NodeWorker,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previousGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  return () => {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

export async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
}

export function makeEngine(
  Card: React.ComponentType<{ value?: string; title?: string; children?: React.ReactNode }>,
  compile = compileTrustedMdxDocument,
) {
  return createTrustedMdxEngine({
    imports: { "host:widgets": { Card } },
    compile,
  });
}

/** `onTokenizeRange` may return a gate; the request reaches the worker once it settles. */
export function workerFactory(onTokenizeRange?: (blockId: string) => void | Promise<void>): Worker {
  const worker = createInlineEngineWorker() as unknown as Worker;
  if (onTokenizeRange) {
    const postMessage = worker.postMessage.bind(worker);
    Object.defineProperty(worker, "postMessage", {
      configurable: true,
      value(message: unknown) {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TOKENIZE_RANGE" &&
          "blockId" in message &&
          typeof message.blockId === "string"
        ) {
          const gate = onTokenizeRange(message.blockId);
          if (gate) {
            void gate.then(() => postMessage(message as Parameters<typeof worker.postMessage>[0]));
            return;
          }
        }
        postMessage(message as Parameters<typeof worker.postMessage>[0]);
      },
    });
  }
  return worker;
}

export const features = { mdx: true, tables: true, html: false, math: false };
export const RetainedFrameRenderFailureContext = React.createContext(false);
export const nativeTableElements = {
  Table: ({ children, ...props }: React.ComponentProps<"table">) => (
    <div data-native-table-wrapper="true">
      <table {...props}>{children}</table>
    </div>
  ),
};

export type TrustedOwner = { readonly ownerId: string; readonly source: string };

export function trustedOwners(
  blocks: readonly Block[],
  snapshot: TrustedMdxDocumentSnapshot,
): TrustedOwner[] {
  return blocks.flatMap((block) => (block.payload.inline ?? []).flatMap((node) => {
    if (node.kind !== "trusted-mdx-inline") return [];
    const projection = snapshot.projections[node.ownerId];
    return projection?.kind === "render" || projection?.kind === "server-content"
      ? [{ ownerId: node.ownerId, source: node.raw }]
      : [];
  }));
}

function LeaseRenderedRevisionMarker({
  lease,
  revision,
}: {
  readonly lease: TrustedMdxDocument;
  readonly revision: number | null;
}): null {
  React.useEffect(() => {
    if (revision !== null) lease.confirmRenderedRevision(revision);
  }, [lease, revision]);
  return null;
}

class LeaseRenderErrorBoundary extends React.Component<{
  readonly lease: TrustedMdxDocument;
  readonly revision: number | null;
  readonly children: React.ReactNode;
}, { readonly failed: boolean }> {
  state: { readonly failed: boolean } = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    if (this.props.revision !== null) this.props.lease.reportRenderError(this.props.revision, error);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function TrustedDocumentProjection({
  lease,
  owners,
}: {
  readonly lease: TrustedMdxDocument;
  readonly owners: readonly TrustedOwner[];
}): React.ReactElement {
  const snapshot = React.useSyncExternalStore(lease.subscribe, lease.getSnapshot, lease.getSnapshot);
  return (
    <TrustedMdxProjectionContext.Provider value={snapshot}>
      <LeaseRenderErrorBoundary
        key={snapshot.projectionRevision ?? "inert"}
        lease={lease}
        revision={snapshot.projectionRevision}
      >
        <>
          {owners.map(({ ownerId, source }) => (
            <TrustedMdxInlineOwner key={ownerId} ownerId={ownerId} source={source} />
          ))}
          <LeaseRenderedRevisionMarker lease={lease} revision={snapshot.projectionRevision} />
        </>
      </LeaseRenderErrorBoundary>
    </TrustedMdxProjectionContext.Provider>
  );
}
