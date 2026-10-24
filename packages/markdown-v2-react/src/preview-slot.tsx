import React from "react";
import type { CodeNodeHandle } from "@stream-mdx/core";
import type { NodeHandle } from "./types";
import { useNodePresentationSourceReader } from "./renderer/node-views";

/** Immutable identity and revision state for one generation-bound node. */
export interface NodeRevisionSnapshot {
  readonly id: string;
  readonly type: string;
  readonly generation: number;
  readonly revision: number;
  readonly isFinalized: boolean;
}

/** Revision observation and an explicit cold read of the node's authored source. */
export interface NodeRevisionFeed {
  readonly getSnapshot: () => NodeRevisionSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly readSource: () => string;
}

export interface PreviewRuntime {
  readonly id: string;
  readonly view: React.ComponentType<{
    readonly feed: NodeRevisionFeed;
    readonly snapshot: NodeRevisionSnapshot;
    readonly fallback: React.ReactNode;
  }>;
}

type NodeRevisionHandle = NodeHandle | CodeNodeHandle;

function isCodeNodeHandle(handle: NodeRevisionHandle): handle is CodeNodeHandle {
  return "readSource" in handle;
}

function createNodeRevisionFeed(
  handle: NodeRevisionHandle,
  readSource: () => string,
): NodeRevisionFeed {
  let snapshot: NodeRevisionSnapshot | undefined;
  const getSnapshot = (): NodeRevisionSnapshot => {
    let id: string;
    let type: string;
    let generation: number;
    let revision: number;
    let isFinalized: boolean;
    if (isCodeNodeHandle(handle)) {
      const metadata = handle.readMetadata();
      id = metadata.codeOwnerId;
      type = "code";
      generation = metadata.generation;
      revision = metadata.revision;
      isFinalized = metadata.state !== "open";
    } else {
      const metadata = handle.readMetadata();
      id = metadata.id;
      type = metadata.type;
      generation = metadata.generation;
      revision = metadata.revision;
      isFinalized = metadata.isFinalized;
    }
    if (
      snapshot &&
      snapshot.id === id &&
      snapshot.type === type &&
      snapshot.generation === generation &&
      snapshot.revision === revision &&
      snapshot.isFinalized === isFinalized
    ) {
      return snapshot;
    }
    snapshot = Object.freeze({ id, type, generation, revision, isFinalized });
    return snapshot;
  };
  return Object.freeze({
    getSnapshot,
    subscribe: (listener: () => void) => handle.subscribeMetadata(listener),
    readSource,
  });
}

/** Subscribe to one node revision and receive its stable feed plus current snapshot. */
export function useNodeRevisionFeed(handle: NodeRevisionHandle): {
  readonly feed: NodeRevisionFeed;
  readonly snapshot: NodeRevisionSnapshot;
} {
  const readSource = useNodePresentationSourceReader(handle);
  const feed = React.useMemo(() => createNodeRevisionFeed(handle, readSource), [handle, readSource]);
  const snapshot = React.useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
  return { feed, snapshot };
}

/** An inert native presentation unless the host supplies an explicit runtime. */
export function PreviewSlot({
  handle,
  runtime,
  children,
}: {
  readonly handle: NodeRevisionHandle;
  readonly runtime?: PreviewRuntime;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  const { feed, snapshot } = useNodeRevisionFeed(handle);
  if (!runtime) {
    return (
      <div data-stream-mdx-preview-slot data-preview-runtime="none">
        {children}
      </div>
    );
  }
  const RuntimeView = runtime.view;
  return <RuntimeView feed={feed} snapshot={snapshot} fallback={children ?? null} />;
}
