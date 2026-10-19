import type { Block, TrustedMdxArtifact, TrustedMdxFlowChildSpan } from "@stream-mdx/core";
import type { ComponentType, ElementType, ReactNode } from "react";

export interface TrustedMdxRenderProps {
  readonly components?: Readonly<Record<string, ElementType>>;
  readonly children?: ReactNode;
}

export type TrustedMdxNativeChildFallback = (index: number) => ReactNode;
export type TrustedMdxNativeChildrenFactory = (
  fallback: TrustedMdxNativeChildFallback,
) => ReactNode;

export type TrustedMdxNativeChildOwner =
  | { readonly kind: "block"; readonly blockId: string }
  | { readonly kind: "prepared-tree"; readonly blockId: string }
  | { readonly kind: "continuation"; readonly ownerIndex: number }
  | null;

/** Guards typed continuations against suppressing anything outside one inline run. */
export function assertTrustedMdxNativeChildContinuations(
  owners: readonly TrustedMdxNativeChildOwner[],
  flowChildren: readonly TrustedMdxFlowChildSpan[],
): void {
  if (owners.length !== flowChildren.length) {
    throw new Error("A trusted MDX native child continuation has misaligned owner and source spans.");
  }
  let continuationOwnerIndex: number | undefined;
  for (let index = 0; index < owners.length; index++) {
    const owner = owners[index];
    if (owner?.kind !== "continuation") {
      continuationOwnerIndex = undefined;
      continue;
    }
    const ownerIndex = owner.ownerIndex;
    const ownerForRun = owners[ownerIndex];
    const previousChild = flowChildren[index - 1];
    const child = flowChildren[index];
    if (
      !Number.isSafeInteger(ownerIndex) ||
      ownerIndex < 0 ||
      ownerIndex >= index ||
      (continuationOwnerIndex === undefined ? ownerIndex !== index - 1 : ownerIndex !== continuationOwnerIndex) ||
      ownerForRun === null ||
      ownerForRun === undefined ||
      ownerForRun.kind === "continuation" ||
      previousChild?.kind !== "inline" ||
      child?.kind !== "inline" ||
      previousChild.to <= previousChild.from ||
      child.to <= child.from ||
      previousChild.to !== child.from
    ) {
      throw new Error("A trusted MDX native child continuation does not cover one exact contiguous inline run.");
    }
    continuationOwnerIndex = ownerIndex;
  }
}

/** Private compiler-region invocation props; host components receive TrustedMdxRenderProps only. */
export interface TrustedMdxCompiledRegionProps extends Omit<TrustedMdxRenderProps, "children"> {
  readonly children?: ReactNode | TrustedMdxNativeChildrenFactory;
}

/** The compiler closure is invoked locally, not transported as an ordinary React component prop. */
export type TrustedMdxCompiledRegion = (
  props: TrustedMdxCompiledRegionProps,
) => ReactNode;

export interface TrustedMdxRevision {
  /** The entire accepted authored document, without per-block concatenation or repair. */
  readonly source: string;
  /** Blocks belonging to that document's completed, committed worker revision. */
  readonly blocks: readonly Block[];
}

export type TrustedMdxBlockProjection =
  | {
      readonly kind: "render";
      readonly regions: readonly TrustedMdxCompiledRegion[];
      readonly placement: "flow" | "inline";
      readonly rootElementName?: string | null;
      /** The compiler-authored flow root replaces only children represented by its worker owners. */
      readonly nativeChildren?: true;
      /** Per-child owner, inline-run continuation, or null for a compiler-only child. */
      readonly nativeChildOwners?: readonly TrustedMdxNativeChildOwner[];
      readonly flowChildren?: readonly TrustedMdxFlowChildSpan[];
      /** Top-level worker blocks consumed or replaced by this exact flow region. */
      readonly nativeFlowOwnedBlockIds?: readonly string[];
      /** The exact full worker block is the compiler-authored flow root. */
      readonly wholeBlockFlowRoot?: true;
      /** This block is rendered only inside its compiler-authored flow parent. */
      readonly nativeFlowParent?: true;
    }
  | {
      /** Server projection carries React content, never evaluated closures or component maps. */
      readonly kind: "server-content";
      readonly content: ReactNode;
      readonly placement: "flow" | "inline";
      readonly nativeChildren?: true;
      readonly nativeChildOwners?: readonly TrustedMdxNativeChildOwner[];
      readonly flowChildren?: readonly TrustedMdxFlowChildSpan[];
      readonly nativeFlowOwnedBlockIds?: readonly string[];
      readonly wholeBlockFlowRoot?: true;
      readonly nativeFlowParent?: true;
      readonly rootElementName?: string | null;
    }
  | { readonly kind: "native-child"; readonly nativeFlowParent: true }
  | { readonly kind: "module"; readonly nativeFlowParent?: true }
  | { readonly kind: "unmapped"; readonly diagnostic: string; readonly placement?: "flow" | "inline"; readonly nativeFlowParent?: true };
export interface TrustedMdxDocumentSnapshot {
  readonly requestedRevision: number;
  /** Revision supplying the currently projected bindings; may be older than requested. */
  readonly projectionRevision: number | null;
  /** Advances only when a host confirms that projected content actually committed. */
  readonly renderedRevision: number | null;
  readonly status: "idle" | "compiling" | "ready" | "error" | "disposed";
  readonly error: string | null;
  readonly components: Readonly<Record<string, ElementType>>;
  readonly layout: ComponentType<TrustedMdxRenderProps> | null;
  readonly projections: Readonly<Record<string, TrustedMdxBlockProjection>>;
}

/** Evaluation and component identities are owned by this lease, never another document. */
export interface TrustedMdxDocument {
  readonly getSnapshot: () => TrustedMdxDocumentSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly compileRevision: (revision: TrustedMdxRevision) => Promise<void>;
  readonly confirmRenderedRevision: (revision: number) => void;
  /** Rejects that candidate and restores the last actually committed module, if any. */
  readonly reportRenderError: (revision: number, error: unknown) => void;
  readonly clear: () => void;
  readonly dispose: () => void;
}

export interface TrustedMdxEngine {
  readonly createDocument: () => TrustedMdxDocument;
  /** Changes whenever the engine invalidates existing authorization/cache state. */
  readonly getGeneration: () => number;
  readonly subscribe: (listener: () => void) => () => void;
  /** Invalidates shared pure compilation artifacts and all extant lease revisions. */
  readonly clearCache: () => void;
  readonly dispose: () => void;
}

export interface TrustedMdxEngineOptions {
  readonly components?: Readonly<Record<string, ElementType>>;
  /** Explicit host bindings; absent authored imports are rejected, not fetched. */
  readonly imports?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Optional explicit host compiler. The addon otherwise compiles locally. */
  readonly compile?: (source: string) => Promise<TrustedMdxArtifact>;
  readonly compilerIdentity?: string;
}
