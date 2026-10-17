/** Exact MDAST child placement and semantics in authored UTF-16 source offsets. */
export interface TrustedMdxFlowChildSpan {
  readonly from: number;
  readonly to: number;
  readonly kind: "markdown" | "jsx" | "expression";
}

/** Source spans are authored UTF-16 offsets, not offsets into repaired or concatenated blocks. */
export type TrustedMdxSourceRegion =
  | {
      readonly key: string;
      readonly from: number;
      readonly to: number;
      readonly kind: "render";
      /** Authored root name from an mdxJsxFlowElement; null denotes its unnamed fragment. */
      readonly rootElementName?: string | null;
      /** Placement comes from the compiler MDAST node type, not authored tag spelling. */
      readonly placement: "flow" | "inline";
      /** Exact UTF-16 spans of direct MDAST children for compiler-authored flow JSX roots. */
      readonly flowChildren?: readonly TrustedMdxFlowChildSpan[];
    }
  | {
      readonly key: string;
      readonly from: number;
      readonly to: number;
      readonly kind: "module";
    };

/** Pure compilation output. Possessing an artifact does not authorize its evaluation. */
export interface TrustedMdxArtifact {
  readonly code: string;
  readonly dependencies: readonly string[];
  readonly regions: readonly TrustedMdxSourceRegion[];
  readonly compilerIdentity: string;
}
