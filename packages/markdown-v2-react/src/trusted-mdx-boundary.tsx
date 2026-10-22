import React, { createContext, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type {
  TrustedMdxDocument,
  TrustedMdxDocumentSnapshot,
  TrustedMdxEngine,
  TrustedMdxRenderProps,
  TrustedMdxRevision,
} from "./trusted-mdx-contract";
import type { TrustedRevisionFeed, TrustedRevisionFeedSnapshot } from "./trusted-revision-feed";
import type { RendererStore } from "./renderer/store";
import { CodeHighlightRequestContext } from "./renderer/code-highlight-context";
import { StreamingActivityContext } from "./renderer/streaming-activity-context";

const EMPTY_PROJECTIONS = Object.freeze({});
const EMPTY_COMPONENTS = Object.freeze({});
const EMPTY_DOCUMENT_SNAPSHOT: TrustedMdxDocumentSnapshot = Object.freeze({
  requestedRevision: 0,
  projectionRevision: null,
  renderedRevision: null,
  status: "idle",
  error: null,
  components: EMPTY_COMPONENTS,
  layout: null,
  projections: EMPTY_PROJECTIONS,
});
const EMPTY_FEED_SNAPSHOT: TrustedRevisionFeedSnapshot = Object.freeze({
  generation: 0,
  version: 0,
  generationCause: "initial",
  pendingSource: null,
  revision: null,
});

function subscribeNothing(): () => void {
  return () => {};
}

function getEmptyDocumentSnapshot(): TrustedMdxDocumentSnapshot {
  return EMPTY_DOCUMENT_SNAPSHOT;
}

function getEmptyFeedSnapshot(): TrustedRevisionFeedSnapshot {
  return EMPTY_FEED_SNAPSHOT;
}

export const TrustedMdxProjectionContext = createContext<TrustedMdxDocumentSnapshot | null>(null);

interface TrustedMdxBoundaryProps {
  readonly engine: TrustedMdxEngine | undefined;
  readonly feed: TrustedRevisionFeed | null;
  readonly captureNativeFrame: () => RendererStore;
  readonly renderNativeFrame: (store: RendererStore) => ReactNode;
  readonly children: ReactNode;
}

interface LeaseState {
  readonly engine: TrustedMdxEngine;
  readonly feed: TrustedRevisionFeed;
  readonly document: TrustedMdxDocument;
}

interface SourceRevisionIdentity {
  readonly document: TrustedMdxDocument;
  readonly engine: TrustedMdxEngine;
  readonly engineGeneration: number;
  readonly feed: TrustedRevisionFeed;
  readonly generation: number;
  readonly version: number;
  readonly revision: TrustedMdxRevision;
  readonly targetRevision: number;
}

interface ConfirmedNativeRevision {
  readonly document: TrustedMdxDocument;
  readonly engine: TrustedMdxEngine;
  readonly engineGeneration: number;
  readonly feed: TrustedRevisionFeed;
  readonly generation: number;
  readonly version: number;
  readonly revision: number;
  readonly sourceRevision: TrustedMdxRevision;
  readonly snapshot: TrustedMdxDocumentSnapshot;
}

interface CommittedNativeFrame extends ConfirmedNativeRevision {
  readonly store: RendererStore;
}


export function TrustedMdxBoundary({
  engine,
  feed,
  captureNativeFrame,
  renderNativeFrame,
  children,
}: TrustedMdxBoundaryProps): React.ReactElement {
  const [leaseState, setLeaseState] = useState<LeaseState | null>(null);
  const [committedFrame, setCommittedFrame] = useState<CommittedNativeFrame | null>(null);
  const committedFrameRef = useRef(committedFrame);
  committedFrameRef.current = committedFrame;
  const lastCommittedFrameRef = useRef<CommittedNativeFrame | null>(null);
  const sourceIdentityRef = useRef<SourceRevisionIdentity | null>(null);
  const captureNativeFrameRef = useRef(captureNativeFrame);
  captureNativeFrameRef.current = captureNativeFrame;
  const renderNativeFrameRef = useRef(renderNativeFrame);
  renderNativeFrameRef.current = renderNativeFrame;

  const subscribeEngineGeneration = useCallback((listener: () => void) => {
    if (!engine) return subscribeNothing();
    return engine.subscribe(() => {
      sourceIdentityRef.current = null;
      lastCommittedFrameRef.current = null;
      committedFrameRef.current = null;
      setCommittedFrame(null);
      listener();
    });
  }, [engine]);
  const getEngineGeneration = useCallback(() => engine?.getGeneration() ?? 0, [engine]);
  const engineGeneration = useSyncExternalStore(
    subscribeEngineGeneration,
    getEngineGeneration,
    getEmptyEngineGeneration,
  );
  const feedSnapshot = useSyncExternalStore(
    feed?.subscribe ?? subscribeNothing,
    feed?.getSnapshot ?? getEmptyFeedSnapshot,
    getEmptyFeedSnapshot,
  );

  useEffect(() => {
    sourceIdentityRef.current = null;
    lastCommittedFrameRef.current = null;
    committedFrameRef.current = null;
    setCommittedFrame(null);
    setLeaseState(null);
    if (!engine || !feed) return undefined;

    const document = engine.createDocument();
    let observedGeneration = feed.getSnapshot().generation;
    const unsubscribe = feed.subscribe(() => {
      const nextFeedSnapshot = feed.getSnapshot();
      if (nextFeedSnapshot.generation !== observedGeneration) {
        const previousGeneration = observedGeneration;
        observedGeneration = nextFeedSnapshot.generation;
        sourceIdentityRef.current = null;
        if (nextFeedSnapshot.generationCause === "reset") {
          lastCommittedFrameRef.current = null;
          committedFrameRef.current = null;
          setCommittedFrame(null);
        } else if (nextFeedSnapshot.generationCause === "replacement" && committedFrameRef.current === null) {
          const committed = lastCommittedFrameRef.current;
          const currentDocument = document.getSnapshot();
          if (
            committed &&
            committed.document === document &&
            committed.engine === engine &&
            committed.engineGeneration === engine.getGeneration() &&
            committed.feed === feed &&
            committed.generation === previousGeneration &&
            committed.snapshot.renderedRevision === committed.revision &&
            currentDocument.renderedRevision === committed.revision &&
            currentDocument.projectionRevision === committed.revision
          ) {
            committedFrameRef.current = committed;
            setCommittedFrame(committed);
          }
        }
        document.clear();
      }
    });
    setLeaseState({ engine, feed, document });

    return () => {
      unsubscribe();
      document.dispose();
    };
  }, [engine, feed]);


  const document = leaseState !== null && leaseState.engine === engine && leaseState.feed === feed ? leaseState.document : null;
  const snapshot = useSyncExternalStore(
    document?.subscribe ?? subscribeNothing,
    document?.getSnapshot ?? getEmptyDocumentSnapshot,
    getEmptyDocumentSnapshot,
  );

  useEffect(() => {
    if (!document || !engine || !feed || !feedSnapshot.revision) {
      sourceIdentityRef.current = null;
      return;
    }
    const identity: SourceRevisionIdentity = Object.freeze({
      document,
      engine,
      engineGeneration: engine.getGeneration(),
      feed,
      generation: feedSnapshot.generation,
      version: feedSnapshot.version,
      revision: feedSnapshot.revision,
      targetRevision: document.getSnapshot().requestedRevision + 1,
    });
    if (!feed.isCurrent(identity)) {
      sourceIdentityRef.current = null;
      return;
    }
    sourceIdentityRef.current = identity;
    void document.compileRevision(feedSnapshot.revision);
  }, [document, engine, feed, feedSnapshot.generation, feedSnapshot.version, feedSnapshot.revision]);

  const confirmRenderedRevision = useCallback((
    targetDocument: TrustedMdxDocument,
    revision: number,
    identity: SourceRevisionIdentity,
  ): void => {
    if (
      !document ||
      !engine ||
      !feed ||
      leaseState?.document !== document ||
      leaseState.engine !== engine ||
      leaseState.feed !== feed ||
      targetDocument !== document ||
      identity.engine !== engine ||
      identity.engineGeneration !== engineGeneration ||
      identity.feed !== feed ||
      sourceIdentityRef.current !== identity ||
      identity.targetRevision !== revision ||
      engine.getGeneration() !== engineGeneration ||
      !feed.isCurrent(identity)
    ) {
      return;
    }
    const alreadyCommitted = lastCommittedFrameRef.current;
    if (
      alreadyCommitted?.document === document &&
      alreadyCommitted.engine === engine &&
      alreadyCommitted.engineGeneration === engineGeneration &&
      alreadyCommitted.feed === feed &&
      alreadyCommitted.generation === identity.generation &&
      alreadyCommitted.version === identity.version &&
      alreadyCommitted.revision === revision &&
      alreadyCommitted.sourceRevision === identity.revision
    ) {
      return;
    }

    const currentFeed = feed.getSnapshot();
    const candidate = document.getSnapshot();
    if (
      currentFeed.generation !== identity.generation ||
      currentFeed.version !== identity.version ||
      currentFeed.revision !== identity.revision ||
      !feed.isCurrent(identity) ||
      candidate.status !== "ready" ||
      candidate.requestedRevision !== revision ||
      candidate.projectionRevision !== revision
    ) {
      return;
    }

    document.confirmRenderedRevision(revision);
    const committedSnapshot = document.getSnapshot();
    if (
      committedSnapshot.status !== "ready" ||
      committedSnapshot.requestedRevision !== revision ||
      committedSnapshot.projectionRevision !== revision ||
      committedSnapshot.renderedRevision !== revision
    ) {
      return;
    }

    const latestFeed = feed.getSnapshot();
    if (
      sourceIdentityRef.current !== identity ||
      latestFeed.generation !== identity.generation ||
      latestFeed.version !== identity.version ||
      latestFeed.revision !== identity.revision ||
      !feed.isCurrent(identity) ||
      engine.getGeneration() !== engineGeneration
    ) {
      return;
    }
    const store = captureNativeFrameRef.current();
    const capturedFeed = feed.getSnapshot();
    if (
      sourceIdentityRef.current !== identity ||
      capturedFeed.generation !== identity.generation ||
      capturedFeed.version !== identity.version ||
      capturedFeed.revision !== identity.revision ||
      !feed.isCurrent(identity) ||
      engine.getGeneration() !== engineGeneration ||
      document.getSnapshot().renderedRevision !== revision
    ) {
      return;
    }
    const confirmed: CommittedNativeFrame = Object.freeze({
      document,
      engine,
      engineGeneration,
      feed,
      generation: identity.generation,
      version: identity.version,
      revision,
      sourceRevision: identity.revision,
      snapshot: committedSnapshot,
      store,
    });
    lastCommittedFrameRef.current = confirmed;
    committedFrameRef.current = null;
    setCommittedFrame(null);
  }, [document, engine, engineGeneration, feed, leaseState]);

  const revision = snapshot.projectionRevision;
  const sourceIdentity = sourceIdentityRef.current;
  const identityMatchesCurrentCandidate = Boolean(
    sourceIdentity !== null &&
    document !== null &&
    engine !== undefined &&
    feed !== null &&
    revision !== null &&
    sourceIdentity.document === document &&
    sourceIdentity.engine === engine &&
    sourceIdentity.engineGeneration === engineGeneration &&
    engine.getGeneration() === engineGeneration &&
    sourceIdentity.feed === feed &&
    sourceIdentity.generation === feedSnapshot.generation &&
    sourceIdentity.version === feedSnapshot.version &&
    sourceIdentity.revision === feedSnapshot.revision &&
    feed.isCurrent(sourceIdentity) &&
    sourceIdentity.targetRevision === revision &&
    snapshot.status === "ready" &&
    snapshot.requestedRevision === revision,
  );
  const candidateRevision = identityMatchesCurrentCandidate ? revision : null;
  const candidateContent = candidateRevision === null
    ? children
    : snapshot.layout
      ? React.createElement(
        snapshot.layout,
        { components: snapshot.components } satisfies TrustedMdxRenderProps,
        children,
      )
      : children;
  const candidate = candidateRevision !== null &&
    sourceIdentity !== null &&
    document !== null
    ? (
      <RenderedRevisionMarker
        document={document}
        revision={candidateRevision}
        identity={sourceIdentity}
        onCommit={confirmRenderedRevision}
      >
        {candidateContent}
      </RenderedRevisionMarker>
    )
    : candidateContent;

  const retainedFrameVisible = Boolean(
    committedFrame &&
    document &&
    engine &&
    feed &&
    committedFrame.document === document &&
    committedFrame.engine === engine &&
    committedFrame.engineGeneration === engineGeneration &&
    committedFrame.feed === feed &&
    committedFrame.generation !== feedSnapshot.generation &&
    feedSnapshot.generationCause !== "reset" &&
    snapshot.status !== "disposed",
  );

  if (!document || !feed || snapshot.status === "disposed") {
    return <TrustedMdxProjectionContext.Provider value={null}>{children}</TrustedMdxProjectionContext.Provider>;
  }

  const retainedNativeContent = committedFrame?.snapshot.layout
    ? React.createElement(
      committedFrame.snapshot.layout,
      { components: committedFrame.snapshot.components } satisfies TrustedMdxRenderProps,
      renderNativeFrameRef.current(committedFrame.store),
    )
    : committedFrame
      ? renderNativeFrameRef.current(committedFrame.store)
      : null;
  const requestedSource = feedSnapshot.revision?.source ?? feedSnapshot.pendingSource;

  return (
    <>
      {retainedFrameVisible && committedFrame ? (
        <section
          aria-label={`Previously committed trusted MDX source generation ${committedFrame.generation}`}
          data-trusted-mdx-retained-frame="true"
          data-trusted-mdx-retained-source-generation={committedFrame.generation}
          data-trusted-mdx-retained-document-revision={committedFrame.revision}
        >
          <p role="status">
            Showing the previously committed trusted MDX source generation {committedFrame.generation}
            while source generation {feedSnapshot.generation} is being rendered.
          </p>
          <details>
            <summary>
              Previously committed source generation {committedFrame.generation}, document revision {committedFrame.revision}
            </summary>
            <pre>{committedFrame.sourceRevision.source}</pre>
          </details>
          <TrustedMdxProjectionContext.Provider value={committedFrame.snapshot}>
            <CodeHighlightRequestContext.Provider value={null}>
              <StreamingActivityContext.Provider value={false}>
                <CapturedNativeFrameErrorBoundary
                  key={`${committedFrame.generation}:${committedFrame.revision}`}
                  sourceGeneration={committedFrame.generation}
                  documentRevision={committedFrame.revision}
                  source={committedFrame.sourceRevision.source}
                >
                  {retainedNativeContent}
                </CapturedNativeFrameErrorBoundary>
              </StreamingActivityContext.Provider>
            </CodeHighlightRequestContext.Provider>
          </TrustedMdxProjectionContext.Provider>
        </section>
      ) : null}
      <TrustedMdxProjectionContext.Provider value={candidateRevision === null ? null : snapshot}>
        {retainedFrameVisible ? (
          <aside data-trusted-mdx-current-candidate={feedSnapshot.generation}>
            <p role="status">
              Current trusted MDX source generation {feedSnapshot.generation} is {snapshot.status === "idle" ? "pending" : snapshot.status}.
            </p>
            {snapshot.error ? (
              <p data-trusted-mdx-current-diagnostic="true" role="alert">{snapshot.error}</p>
            ) : null}
            {requestedSource !== null ? (
              <details>
                <summary>Current requested source generation {feedSnapshot.generation}</summary>
                <pre>{requestedSource}</pre>
              </details>
            ) : null}
          </aside>
        ) : null}
        <TrustedMdxProjectionErrorBoundary
          key={candidateRevision ?? "inert"}
          document={document}
          revision={candidateRevision}
          fallback={children}
        >
          {candidate}
        </TrustedMdxProjectionErrorBoundary>
      </TrustedMdxProjectionContext.Provider>
    </>
  );
}

function getEmptyEngineGeneration(): number {
  return 0;
}

function RenderedRevisionMarker({
  document,
  revision,
  identity,
  onCommit,
  children,
}: {
  readonly document: TrustedMdxDocument;
  readonly revision: number;
  readonly identity: SourceRevisionIdentity;
  readonly onCommit: (
    document: TrustedMdxDocument,
    revision: number,
    identity: SourceRevisionIdentity,
  ) => void;
  readonly children: ReactNode;
}): React.ReactElement {
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  useEffect(() => {
    onCommitRef.current(document, revision, identity);
  }, [document, revision, identity]);
  return <>{children}</>;
}

class TrustedMdxProjectionErrorBoundary extends React.Component<{
  readonly document: TrustedMdxDocument;
  readonly revision: number | null;
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}, { readonly error: Error | null }> {
  state: { readonly error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error): void {
    if (this.props.revision !== null) this.props.document.reportRenderError(this.props.revision, error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return <TrustedMdxProjectionContext.Provider value={null}>{this.props.fallback}</TrustedMdxProjectionContext.Provider>;
    }
    return this.props.children;
  }
}

class CapturedNativeFrameErrorBoundary extends React.Component<{
  readonly sourceGeneration: number;
  readonly documentRevision: number;
  readonly source: string;
  readonly children: ReactNode;
}, { readonly error: Error | null }> {
  state: { readonly error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { readonly error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <section role="alert" data-trusted-mdx-retained-frame-error="true">
        <p>
          Previously committed trusted MDX source generation {this.props.sourceGeneration}, document revision {this.props.documentRevision}
          failed to render: {this.state.error.message}
        </p>
        <details>
          <summary>
            Escaped source for generation {this.props.sourceGeneration}, document revision {this.props.documentRevision}
          </summary>
          <pre>{this.props.source}</pre>
        </details>
      </section>
    );
  }
}
