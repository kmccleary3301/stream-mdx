type SerializedOwnership = {
  type?: string;
  isFinalized?: boolean;
  lazyTokenization?: boolean;
  lazyTokenizedUntil?: number;
  code?: string;
  highlightedLines?: readonly unknown[];
  tokenLines?: readonly unknown[];
  payload?: { meta?: SerializedOwnership };
  props?: SerializedOwnership;
  meta?: SerializedOwnership;
  block?: SerializedOwnership;
  preparedNested?: SerializedOwnership;
  children?: SerializedOwnership[];
  htmlTree?: SerializedOwnership[];
  htmlParagraphTree?: SerializedOwnership[];
};

// These public serialized ownership fields are optional on baseline 4350a2a.
// Keep the benchmark compatible with its built exports, which predate HtmlTreeNode.
export function collectCodeReadiness(type: string, meta: Record<string, unknown>): { allFinalized: boolean; pendingLazyCode: boolean } {
  let allFinalized = true;
  let pendingLazyCode = false;
  const visited = new WeakSet<object>();
  const visit = (value: SerializedOwnership | undefined, nodeType?: string): void => {
    if (!value || visited.has(value)) return;
    visited.add(value);
    const currentType = value.type ?? nodeType;
    if (value.isFinalized === false) allFinalized = false;
    if (currentType === "code" && value.lazyTokenization) {
      const highlighted = value.highlightedLines?.length ?? 0;
      const tokens = value.tokenLines?.length ?? 0;
      const source = value.code ? value.code.split("\n").length : 0;
      const until = value.lazyTokenizedUntil ?? 0;
      if (until < Math.max(highlighted, tokens, source)) pendingLazyCode = true;
    }
    // Blocks, NodeSnapshots, PreparedNestedSnapshot and HtmlTreeNode.kind=block
    // all keep ownership through these fields. No outer-store lookup is needed.
    visit(value.payload?.meta, currentType);
    visit(value.props, currentType);
    visit(value.meta, currentType);
    visit(value.block);
    visit(value.preparedNested);
    for (const key of ["children", "htmlTree", "htmlParagraphTree"] as const) {
      for (const child of value[key] ?? []) visit(child);
    }
  };
  // The caller supplies public Block metadata or NodeSnapshot props, not IPC.
  visit(meta as SerializedOwnership, type);
  return { allFinalized, pendingLazyCode };
}
