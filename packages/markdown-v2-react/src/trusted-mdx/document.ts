import type { ComponentType, ElementType } from "react";
import type { TrustedMdxArtifact } from "@stream-mdx/core";
import type {
  TrustedMdxBlockProjection,
  TrustedMdxDocument,
  TrustedMdxDocumentSnapshot,
  TrustedMdxEngineOptions,
  TrustedMdxRenderProps,
  TrustedMdxRevision,
} from "../trusted-mdx-contract";
import { evaluateCompiledMdx } from "./evaluate";
import type { EvaluatedMdxModule } from "./evaluate";
import { projectMdxBlocks } from "./projection";

const EMPTY_PROJECTIONS: Readonly<Record<string, TrustedMdxBlockProjection>> = Object.freeze({});

export interface DocumentLeaseContext {
  readonly options: TrustedMdxEngineOptions;
  readonly getFactoryEpoch: () => number;
  readonly getOrCompileArtifact: (source: string) => Promise<TrustedMdxArtifact>;
  readonly onDispose: () => void;
}

export function createTrustedMdxDocumentLease(context: DocumentLeaseContext): TrustedMdxDocument {
  const { options, getFactoryEpoch, getOrCompileArtifact, onDispose } = context;

  let leaseEpoch = 0;
  let isDisposed = false;
  let requestedRevision = 0;
  let projectionRevision: number | null = null;
  let renderedRevision: number | null = null;
  let status: TrustedMdxDocumentSnapshot["status"] = "idle";
  let error: string | null = null;

  const components: Readonly<Record<string, ElementType>> = Object.freeze({
    ...options.components,
  });
  let layout: ComponentType<TrustedMdxRenderProps> | null = null;
  let projections = EMPTY_PROJECTIONS;

  let candidateRevision: number | null = null;
  let candidateProjections: Readonly<Record<string, TrustedMdxBlockProjection>> | null = null;
  let candidateLayout: ComponentType<TrustedMdxRenderProps> | null = null;

  let committedRevision: number | null = null;
  let committedProjections: Readonly<Record<string, TrustedMdxBlockProjection>> | null = null;
  let committedLayout: ComponentType<TrustedMdxRenderProps> | null = null;

  const listeners = new Set<() => void>();

  const createSnapshot = (): TrustedMdxDocumentSnapshot => Object.freeze({
    requestedRevision,
    projectionRevision,
    renderedRevision,
    status,
    error,
    components,
    layout,
    projections,
  });
  let currentSnapshot = createSnapshot();

  const publishIfChanged = (): void => {
    const previous = currentSnapshot;
    if (
      previous.requestedRevision === requestedRevision &&
      previous.projectionRevision === projectionRevision &&
      previous.renderedRevision === renderedRevision &&
      previous.status === status &&
      previous.error === error &&
      previous.components === components &&
      previous.layout === layout &&
      previous.projections === projections
    ) {
      return;
    }

    currentSnapshot = createSnapshot();
    // Listener failures are observable by the caller, never classified as compiler failures.
    for (const listener of listeners) listener();
  };

  const getSnapshot = (): TrustedMdxDocumentSnapshot => currentSnapshot;

  const subscribe = (listener: () => void): (() => void) => {
    if (!isDisposed) listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const ownsRevision = (targetRevision: number, startLeaseEpoch: number, startFactoryEpoch: number): boolean =>
    !isDisposed &&
    leaseEpoch === startLeaseEpoch &&
    getFactoryEpoch() === startFactoryEpoch &&
    requestedRevision === targetRevision;

  const failRevision = (
    targetRevision: number,
    startLeaseEpoch: number,
    startFactoryEpoch: number,
    cause: unknown,
  ): void => {
    if (!ownsRevision(targetRevision, startLeaseEpoch, startFactoryEpoch)) return;

    candidateRevision = null;
    candidateProjections = null;
    candidateLayout = null;
    projectionRevision = committedRevision;
    projections = committedProjections ?? EMPTY_PROJECTIONS;
    layout = committedLayout;
    status = "error";
    error = cause instanceof Error ? cause.message : String(cause);
    publishIfChanged();
  };

  const compileRevision = async (revision: TrustedMdxRevision): Promise<void> => {
    if (isDisposed) return;

    const targetRevision = ++requestedRevision;
    const startLeaseEpoch = leaseEpoch;
    const startFactoryEpoch = getFactoryEpoch();
    const isCurrent = (): boolean =>
      ownsRevision(targetRevision, startLeaseEpoch, startFactoryEpoch);

    status = "compiling";
    error = null;
    publishIfChanged();
    if (!isCurrent()) return;

    let artifact: TrustedMdxArtifact;
    try {
      artifact = await getOrCompileArtifact(revision.source);
    } catch (cause) {
      failRevision(targetRevision, startLeaseEpoch, startFactoryEpoch, cause);
      return;
    }
    if (!isCurrent()) return;

    let evaluated: EvaluatedMdxModule | null;
    try {
      evaluated = await evaluateCompiledMdx(
        artifact.code,
        { imports: options.imports },
        isCurrent,
      );
    } catch (cause) {
      failRevision(targetRevision, startLeaseEpoch, startFactoryEpoch, cause);
      return;
    }
    if (!isCurrent() || evaluated === null) return;

    let nextProjections: Readonly<Record<string, TrustedMdxBlockProjection>>;
    let nextLayout: ComponentType<TrustedMdxRenderProps> | null;
    try {
      if (!isCurrent()) return;
      const regionComponents = evaluated.createRegions({ components });
      if (!isCurrent()) return;
      nextProjections = projectMdxBlocks(revision.source, revision.blocks, artifact.regions, regionComponents);
      nextLayout = evaluated.layout ?? null;
    } catch (cause) {
      failRevision(targetRevision, startLeaseEpoch, startFactoryEpoch, cause);
      return;
    }
    if (!isCurrent()) return;

    candidateRevision = targetRevision;
    candidateProjections = nextProjections;
    candidateLayout = nextLayout;
    projectionRevision = targetRevision;
    projections = nextProjections;
    layout = nextLayout;
    status = "ready";
    error = null;
    publishIfChanged();
  };

  const confirmRenderedRevision = (revision: number): void => {
    if (
      isDisposed ||
      candidateRevision !== revision ||
      candidateProjections === null ||
      (renderedRevision === revision && committedRevision === revision)
    ) {
      return;
    }

    renderedRevision = revision;
    committedRevision = revision;
    committedProjections = candidateProjections;
    committedLayout = candidateLayout;
    candidateRevision = null;
    candidateProjections = null;
    candidateLayout = null;
    publishIfChanged();
  };

  const reportRenderError = (revision: number, cause: unknown): void => {
    if (isDisposed || candidateRevision !== revision || candidateProjections === null) return;

    candidateRevision = null;
    candidateProjections = null;
    candidateLayout = null;
    projectionRevision = committedRevision;
    projections = committedProjections ?? EMPTY_PROJECTIONS;
    layout = committedLayout;
    status = "error";
    error = cause instanceof Error ? cause.message : String(cause);
    publishIfChanged();
  };

  const clear = (): void => {
    if (isDisposed) return;
    leaseEpoch += 1;
    candidateRevision = null;
    candidateProjections = null;
    candidateLayout = null;
    committedRevision = null;
    committedProjections = null;
    committedLayout = null;
    projectionRevision = null;
    renderedRevision = null;
    status = "idle";
    error = null;
    projections = EMPTY_PROJECTIONS;
    layout = null;
    publishIfChanged();
  };

  const dispose = (): void => {
    if (isDisposed) return;
    isDisposed = true;
    leaseEpoch += 1;
    candidateRevision = null;
    candidateProjections = null;
    candidateLayout = null;
    committedRevision = null;
    committedProjections = null;
    committedLayout = null;
    projectionRevision = null;
    renderedRevision = null;
    status = "disposed";
    error = null;
    projections = EMPTY_PROJECTIONS;
    layout = null;
    listeners.clear();
    currentSnapshot = createSnapshot();
    onDispose();
  };

  return {
    getSnapshot,
    subscribe,
    compileRevision,
    confirmRenderedRevision,
    reportRenderError,
    clear,
    dispose,
  };
}
