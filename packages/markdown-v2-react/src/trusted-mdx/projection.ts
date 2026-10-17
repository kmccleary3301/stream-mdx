import type { Block, HtmlTreeNode, TrustedMdxFlowChildSpan, TrustedMdxSourceRegion } from "@stream-mdx/core";
import type {
  TrustedMdxBlockProjection,
  TrustedMdxCompiledRegion,
  TrustedMdxNativeChildOwner,
} from "../trusted-mdx-contract";

interface MdxBlockMatch {
  readonly id: string;
  readonly label: string;
  readonly from: number | null;
  readonly to: number | null;
  readonly regions: TrustedMdxSourceRegion[];
  placement: "flow" | "inline" | null;
  rootElementName: string | null | undefined;
  nativeChildren: boolean;
  nativeChildOwners: TrustedMdxNativeChildOwner[];
  flowChildren: readonly TrustedMdxFlowChildSpan[] | undefined;
  nativeFlowOwnedBlockIds: string[];
  wholeBlockFlowRoot: boolean;
  ambiguous: boolean;
}

interface SourceRange {
  readonly from: number;
  readonly to: number;
}

interface SnapshotFields {
  readonly id: string;
  readonly type: string;
  readonly range: unknown;
  readonly props: unknown;
  readonly children: unknown;
}

function readSourceRange(value: unknown, sourceLength: number): SourceRange | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("from" in value) ||
    !("to" in value)
  ) {
    return null;
  }
  const from = value.from;
  const to = value.to;
  if (
    typeof from !== "number" ||
    typeof to !== "number" ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from ||
    to > sourceLength
  ) {
    return null;
  }
  return { from, to };
}

function readSnapshotFields(value: unknown): SnapshotFields | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("id" in value) ||
    !("type" in value)
  ) {
    return null;
  }
  const id = value.id;
  const type = value.type;
  if (typeof id !== "string" || typeof type !== "string") return null;
  return {
    id,
    type,
    range: "range" in value ? value.range : undefined,
    props: "props" in value ? value.props : undefined,
    children: "children" in value ? value.children : undefined,
  };
}
function hasNativeBlockOwner(tree: unknown): boolean {
  if (!Array.isArray(tree)) return false;
  const pending: unknown[] = [...tree];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || Array.isArray(current)) continue;
    if ("kind" in current && current.kind === "block" && "block" in current) return true;
    if ("children" in current && Array.isArray(current.children)) pending.push(...current.children);
  }
  return false;
}
function collectInlineOwners(
  value: unknown,
  sourceLength: number,
  matches: MdxBlockMatch[],
): void {
  if (!Array.isArray(value)) return;
  const visited = new WeakSet<object>();
  const pending: unknown[] = [...value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if ("kind" in current && current.kind === "trusted-mdx-inline" && "ownerId" in current && typeof current.ownerId === "string") {
      addMdxOwner(
        matches,
        current.ownerId,
        "inline expression",
        "sourceRange" in current ? current.sourceRange : undefined,
        sourceLength,
      );
    }
    if ("children" in current && Array.isArray(current.children)) pending.push(...current.children);
  }
}

function isNestedMdxType(type: string): boolean {
  return type === "paragraph-mdx" || type === "blockquote-mdx" || type === "list-item-mdx";
}

function addMdxOwner(
  matches: MdxBlockMatch[],
  id: string,
  label: string,
  range: unknown,
  sourceLength: number,
): void {
  const sourceRange = readSourceRange(range, sourceLength);
  matches.push({
    id,
    label,
    from: sourceRange?.from ?? null,
    to: sourceRange?.to ?? null,
    regions: [],
    placement: null,
    rootElementName: undefined,
    nativeChildren: false,
    nativeChildOwners: [],
    flowChildren: undefined,
    nativeFlowOwnedBlockIds: [],
    wholeBlockFlowRoot: false,
    ambiguous: false,
  });
}

interface FlowNativeBlocks {
  readonly childOwners: TrustedMdxNativeChildOwner[];
  readonly ownedBlockIds: string[];
}

function readFlowChildRanges(
  flowChildren: readonly TrustedMdxFlowChildSpan[] | undefined,
  flowRange: SourceRange,
  sourceLength: number,
): readonly SourceRange[] | undefined | null {
  if (flowChildren === undefined) return undefined;
  const ranges: SourceRange[] = [];
  let previousTo = flowRange.from;
  for (const child of flowChildren) {
    const range = readSourceRange(child, sourceLength);
    if (
      !range ||
      range.from < flowRange.from ||
      range.to > flowRange.to ||
      range.from < previousTo
    ) {
      return null;
    }
    ranges.push(range);
    previousTo = range.to;
  }
  return ranges;
}

/** Returns the direct-child index, root syntax, or null when a range crosses ownership. */
function classifyFlowRange(
  range: SourceRange,
  childRanges: readonly SourceRange[],
): number | "root-syntax" | null {
  let directChildIndex: number | undefined;
  for (let index = 0; index < childRanges.length; index++) {
    const childRange = childRanges[index];
    if (!childRange) return null;
    if (range.from >= childRange.from && range.to <= childRange.to) {
      if (directChildIndex !== undefined) return null;
      directChildIndex = index;
    } else if (range.from < childRange.to && range.to > childRange.from) {
      return null;
    }
  }
  return directChildIndex ?? "root-syntax";
}

function collectFlowOwnerBlocks(blocks: readonly Block[]): Block[] {
  const flowOwnerBlocks: Block[] = [];
  const seenBlockIds = new Set<string>();
  const pendingBlocks = [...blocks];
  const pendingNodes: HtmlTreeNode[] = [];
  const visitedNodes = new WeakSet<object>();
  for (let blockIndex = 0; blockIndex < pendingBlocks.length; blockIndex++) {
    const block = pendingBlocks[blockIndex];
    if (!block || seenBlockIds.has(block.id)) continue;
    seenBlockIds.add(block.id);
    flowOwnerBlocks.push(block);
    const meta = block.payload.meta;
    if (meta?.trustedMdxNativeChildren) pendingNodes.push(...meta.trustedMdxNativeChildren);
    if (meta?.htmlTree) pendingNodes.push(...meta.htmlTree);
    while (pendingNodes.length > 0) {
      const node = pendingNodes.pop();
      if (!node || visitedNodes.has(node)) continue;
      visitedNodes.add(node);
      if (node.kind === "block") {
        pendingBlocks.push(node.block);
      } else if (node.kind === "element" || node.kind === "component") {
        pendingNodes.push(...node.children);
      }
    }
  }
  return flowOwnerBlocks;
}

function hasWholeFlowRootMatch(
  blockId: string,
  childRange: SourceRange,
  matches: readonly MdxBlockMatch[],
): boolean {
  return matches.some(
    (match) =>
      match.id === blockId &&
      match.wholeBlockFlowRoot &&
      match.from === childRange.from &&
      match.to === childRange.to,
  );
}

function findPreparedTreeBlock(
  tree: readonly HtmlTreeNode[] | undefined,
  childRange: SourceRange,
  sourceLength: number,
  exact = false,
  wholeFlowRoots?: readonly MdxBlockMatch[],
): Block | undefined {
  if (!tree) return undefined;
  const pending: HtmlTreeNode[] = [...tree];
  let owner: Block | undefined;
  let ownerWidth = -1;
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.kind === "block") {
      const range = readSourceRange(node.block.payload.range, sourceLength);
      if (!range) continue;
      const wholeFlowRoot =
        wholeFlowRoots !== undefined &&
        hasWholeFlowRootMatch(node.block.id, childRange, wholeFlowRoots) &&
        range.from === childRange.from &&
        range.to <= childRange.to;
      const rangeMatches = exact
        ? (range.from === childRange.from && range.to === childRange.to) || wholeFlowRoot
        : range.from >= childRange.from && range.to <= childRange.to;
      if (
        rangeMatches &&
        (wholeFlowRoots === undefined || node.block.type === "mdx" || wholeFlowRoot) &&
        range.to - range.from > ownerWidth
      ) {
        owner = node.block;
        ownerWidth = range.to - range.from;
      }
    } else if (node.kind === "element" || node.kind === "component") {
      pending.push(...node.children);
    }
  }
  return owner;
}

function assertPreparedTreeOwnersFitFlowChildren(
  tree: readonly HtmlTreeNode[] | undefined,
  childRanges: readonly SourceRange[] | undefined,
  flowRange: SourceRange,
  sourceLength: number,
): void {
  if (!tree) return;
  const pending: HtmlTreeNode[] = [...tree];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.kind === "block") {
      const range = readSourceRange(node.block.payload.range, sourceLength);
      if (!range) {
        throw new Error("A trusted MDX flow region has a prepared worker block without a source span.");
      }
      if (
        range.from < flowRange.from ||
        range.to > flowRange.to ||
        (range.from === flowRange.from && range.to === flowRange.to)
      ) continue;
      if (childRanges === undefined) {
        throw new Error("A trusted MDX flow region has prepared tree owners but no direct-child spans.");
      }
      if (classifyFlowRange(range, childRanges) === null) {
        throw new Error("A trusted MDX flow region has prepared tree owners crossing direct-child boundaries.");
      }
    } else if (node.kind === "element" || node.kind === "component") {
      pending.push(...node.children);
    }
  }
}

function collectFlowNativeBlocks(
  flowChildren: readonly TrustedMdxFlowChildSpan[] | undefined,
  flowRange: SourceRange,
  blocks: readonly Block[],
  rootOwnerId: string,
  sourceLength: number,
  matches: readonly MdxBlockMatch[],
  flowOwnerBlocks: readonly Block[],
): FlowNativeBlocks {
  const childRanges = readFlowChildRanges(flowChildren, flowRange, sourceLength);
  if (childRanges === null) {
    throw new Error("A trusted MDX flow region has invalid or overlapping direct-child spans.");
  }
  const rootBlock = flowOwnerBlocks.find((block) => block.id === rootOwnerId);
  const meta = rootBlock?.payload.meta;
  const preparedTrees: HtmlTreeNode[][] = [];
  if (meta?.trustedMdxNativeChildren) {
    preparedTrees.push(meta.trustedMdxNativeChildren);
  }
  if (meta?.htmlTree) {
    const tree = meta.htmlTree;
    if (!preparedTrees.includes(tree)) preparedTrees.push(tree);
  }
  const ownedBlockIds: string[] = [];
  for (const block of blocks) {
    if (block.id === rootOwnerId) continue;
    const blockRange = readSourceRange(block.payload.range, sourceLength);
    if (
      !blockRange ||
      blockRange.from < flowRange.from ||
      blockRange.to > flowRange.to ||
      (blockRange.from === flowRange.from && blockRange.to === flowRange.to)
    ) continue;
    if (childRanges === undefined) {
      throw new Error("A trusted MDX flow region has worker owners but no direct-child spans.");
    }
    const ownership = classifyFlowRange(blockRange, childRanges);
    if (ownership === null) {
      throw new Error("A trusted MDX flow region has worker owners crossing direct-child boundaries.");
    }
    // Root syntax is suppressed with the flow root, never assigned to a child below.
    ownedBlockIds.push(block.id);
  }

  for (const tree of preparedTrees) {
    if (hasNativeBlockOwner(tree)) {
      assertPreparedTreeOwnersFitFlowChildren(tree, childRanges, flowRange, sourceLength);
    }
  }
  if (flowChildren === undefined || flowChildren.length === 0) {
    return { childOwners: [], ownedBlockIds };
  }
  const childOwners: TrustedMdxNativeChildOwner[] = [];
  for (let childIndex = 0; childIndex < flowChildren.length; childIndex++) {
    const child = flowChildren[childIndex];
    const childRange = childRanges?.[childIndex];
    if (!child || !childRange) {
      throw new Error("A trusted MDX flow region has invalid direct-child spans.");
    }
    let ownerId: string | undefined;
    let ownerWidth = -1;
    if (child.kind !== "expression") {
      for (const block of blocks) {
        if (block.id === rootOwnerId) continue;
        const blockRange = readSourceRange(block.payload.range, sourceLength);
        if (!blockRange || (blockRange.from === flowRange.from && blockRange.to === flowRange.to)) {
          continue;
        }
        const isDirectChildOwner =
          child.kind === "markdown"
            ? blockRange.from >= childRange.from && blockRange.to <= childRange.to
            : block.type === "mdx"
              ? blockRange.from === childRange.from && blockRange.to === childRange.to
              : blockRange.from === childRange.from &&
                hasWholeFlowRootMatch(block.id, childRange, matches);
        if (!isDirectChildOwner) continue;
        const width = blockRange.to - blockRange.from;
        if (width > ownerWidth) {
          ownerId = block.id;
          ownerWidth = width;
        }
      }
    }
    if (ownerId !== undefined) {
      childOwners.push({ kind: "block", blockId: ownerId });
      continue;
    }
    if (child.kind !== "expression") {
      let preparedOwner: Block | undefined;
      for (const tree of preparedTrees) {
        preparedOwner = findPreparedTreeBlock(
          tree,
          childRange,
          sourceLength,
          child.kind === "jsx",
          child.kind === "jsx" ? matches : undefined,
        );
        if (preparedOwner) break;
      }
      if (preparedOwner) {
        childOwners.push({ kind: "prepared-tree", blockId: preparedOwner.id });
        continue;
      }
    }
    if (child.kind === "markdown") {
      throw new Error("A compiler-authored Markdown child has no prepared native block owner.");
    }
    childOwners.push(null);
  }
  return { childOwners, ownedBlockIds };
}

function collectCompilerFlowBlockOwners(
  source: string,
  blocks: readonly Block[],
  regions: readonly TrustedMdxSourceRegion[],
  matches: MdxBlockMatch[],
): void {
  const ownerIds = new Set(matches.map((match) => match.id));
  for (const region of regions) {
    if (region.kind !== "render" || region.placement !== "flow" || !("rootElementName" in region)) continue;
    const range = readSourceRange(region, source.length);
    if (!range) continue;
    const exactMatches = matches.filter((match) => match.from === range.from && match.to === range.to);
    if (exactMatches.length > 0) {
      for (const match of exactMatches) match.wholeBlockFlowRoot = true;
      continue;
    }
    const block = blocks.find((candidate) => {
      const blockRange = readSourceRange(candidate.payload.range, source.length);
      return blockRange !== null && blockRange.from === range.from && blockRange.to <= range.to;
    });
    if (!block || ownerIds.has(block.id)) continue;
    addMdxOwner(matches, block.id, `${block.type} compiler flow root`, range, source.length);
    matches[matches.length - 1]!.wholeBlockFlowRoot = true;
    ownerIds.add(block.id);
  }
}

function collectPreparedNestedOwners(
  prepared: unknown,
  sourceLength: number,
  matches: MdxBlockMatch[],
): void {
  if (
    typeof prepared !== "object" ||
    prepared === null ||
    Array.isArray(prepared) ||
    !("children" in prepared) ||
    !Array.isArray(prepared.children)
  ) {
    return;
  }
  const visited = new WeakSet<object>();
  const pending: unknown[] = [];
  for (let index = 0; index < prepared.children.length; index++) {
    const child: unknown = prepared.children[index];
    pending.push(child);
  }

  while (pending.length > 0) {
    const value = pending.pop();
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      visited.has(value)
    ) {
      continue;
    }
    visited.add(value);
    const node = readSnapshotFields(value);
    const nodeProps = node?.props && typeof node.props === "object" ? node.props : undefined;
    if (nodeProps && "inline" in nodeProps) {
      collectInlineOwners(nodeProps.inline, sourceLength, matches);
    }
    if (node && isNestedMdxType(node.type)) {
      addMdxOwner(matches, node.id, `${node.type} segment`, node.range, sourceLength);
    }
    if (!node || !Array.isArray(node.children)) continue;
    for (let index = 0; index < node.children.length; index++) {
      const child: unknown = node.children[index];
      pending.push(child);
    }
  }
}
function collectHtmlTreeOwners(
  tree: unknown,
  sourceLength: number,
  matches: MdxBlockMatch[],
): void {
  if (!Array.isArray(tree)) return;
  const pending: unknown[] = [...tree];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if ("kind" in current && current.kind === "block" && "block" in current) {
      const candidate = current.block;
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        "id" in candidate &&
        typeof candidate.id === "string" &&
        "type" in candidate &&
        typeof candidate.type === "string" &&
        "payload" in candidate &&
        typeof candidate.payload === "object" &&
        candidate.payload !== null
      ) {
        const block = candidate as Block;
        const meta = block.payload.meta;
        if (block.type === "mdx") {
          addMdxOwner(
            matches,
            block.id,
            "nested block",
            block.payload.range,
            sourceLength,
          );
        }
        collectInlineOwners(block.payload.inline, sourceLength, matches);
        if (meta) {
          if (block.type === "paragraph" && Array.isArray(meta.mixedSegments)) {
            for (let index = 0; index < meta.mixedSegments.length; index++) {
              const segment: unknown = meta.mixedSegments[index];
              if (
                typeof segment !== "object" ||
                segment === null ||
                Array.isArray(segment) ||
                !("kind" in segment) ||
                segment.kind !== "mdx"
              ) {
                continue;
              }
              addMdxOwner(
                matches,
                `${block.id}::paragraph:segment:${index}`,
                "paragraph segment",
                "range" in segment ? segment.range : undefined,
                sourceLength,
              );
            }
          }
          collectInlineOwners(meta.header, sourceLength, matches);
          collectInlineOwners(meta.rows, sourceLength, matches);
          collectPreparedNestedOwners(meta.preparedNested, sourceLength, matches);
          if (meta.trustedMdxNativeChildren) pending.push(meta.trustedMdxNativeChildren);
          if (meta.htmlTree) pending.push(meta.htmlTree);
        }
      }
    }
    if ("children" in current && Array.isArray(current.children)) pending.push(...current.children);
  }
}

function collectMdxOwners(source: string, blocks: readonly Block[]): MdxBlockMatch[] {
  const matches: MdxBlockMatch[] = [];
  for (const block of blocks) {
    if (block.type === "mdx") {
      addMdxOwner(
        matches,
        block.id,
        "block",
        block.payload.range,
        source.length,
      );
    }
    if (block.type === "paragraph") {
      const segments = block.payload.meta?.mixedSegments;
      if (Array.isArray(segments)) {
        for (let index = 0; index < segments.length; index++) {
          const segment: unknown = segments[index];
          if (
            typeof segment !== "object" ||
            segment === null ||
            Array.isArray(segment) ||
            !("kind" in segment) ||
            segment.kind !== "mdx"
          ) {
            continue;
          }
          addMdxOwner(
            matches,
            `${block.id}::paragraph:segment:${index}`,
            "paragraph segment",
            "range" in segment ? segment.range : undefined,
            source.length,
          );
        }
      }
    }
    collectInlineOwners(block.payload.inline, source.length, matches);
    const tableMeta = block.payload.meta;
    if (tableMeta) {
      collectInlineOwners(tableMeta.header, source.length, matches);
      collectInlineOwners(tableMeta.rows, source.length, matches);
      collectPreparedNestedOwners(tableMeta.preparedNested, source.length, matches);
      collectHtmlTreeOwners(tableMeta.trustedMdxNativeChildren, source.length, matches);
      collectHtmlTreeOwners(tableMeta.htmlTree, source.length, matches);
    }
  }
  const unique = new Map<string, MdxBlockMatch>();
  for (const match of matches) {
    const existing = unique.get(match.id);
    if (!existing) {
      unique.set(match.id, match);
    } else if (existing.from !== match.from || existing.to !== match.to) {
      existing.ambiguous = true;
    }
  }
  return Array.from(unique.values());
}

function describeOwner(match: MdxBlockMatch): string {
  return match.label === "block"
    ? `MDX block "${match.id}"`
    : `MDX ${match.label} "${match.id}"`;
}

function placementFields(match: MdxBlockMatch): { readonly placement?: "flow" | "inline" } {
  return match.placement === null ? {} : { placement: match.placement };
}

/** Maps explicitly MDX-owned blocks and nested worker segment snapshots to evaluated region closures. */
export function projectMdxBlocks(
  source: string,
  blocks: readonly Block[],
  regions: readonly TrustedMdxSourceRegion[],
  regionComponents: Readonly<Record<string, TrustedMdxCompiledRegion>>,
): Readonly<Record<string, TrustedMdxBlockProjection>> {
  const projections = new Map<string, TrustedMdxBlockProjection>();
  const flowOwnerBlocks = collectFlowOwnerBlocks(blocks);
  const matches = collectMdxOwners(source, blocks);
  collectCompilerFlowBlockOwners(source, flowOwnerBlocks, regions, matches);
  const ownersByRegion = new Map<TrustedMdxSourceRegion, MdxBlockMatch[]>();

  for (const region of regions) {
    const regionRange = readSourceRange(region, source.length);
    if (!regionRange) continue;

    const owners: MdxBlockMatch[] = [];
    for (const match of matches) {
      if (match.from === null || match.to === null) continue;
      const ownerFrom = match.from;
      const ownerTo = match.to;
      if (regionRange.to <= match.from || regionRange.from >= match.to) continue;
      const compilerFlowRoot = region.kind === "render" && "rootElementName" in region;
      const regionContainsOwner = regionRange.from <= match.from && regionRange.to >= match.to;
      if (region.kind !== "module" && (regionRange.from < match.from || regionRange.to > match.to)) {
        if (compilerFlowRoot && regionContainsOwner) continue;
        match.ambiguous = true;
        continue;
      }
      const hasIndependentPreparedChildOwner =
        match.nativeChildren &&
        match.placement === "flow" &&
        region.kind === "render" &&
        regionRange.from > match.from &&
        regionRange.to < match.to &&
        matches.some((child) =>
          child !== match &&
          child.from !== null &&
          child.to !== null &&
          child.from >= ownerFrom &&
          child.to <= ownerTo &&
          (child.from > ownerFrom || child.to < ownerTo) &&
          child.from <= regionRange.from &&
          regionRange.to <= child.to
        );
      if (hasIndependentPreparedChildOwner) continue;
      match.regions.push(region);
      if (region.kind !== "module") {
        owners.push(match);
        if (region.placement !== "flow" && region.placement !== "inline") {
          match.ambiguous = true;
        } else if (match.placement !== null && match.placement !== region.placement) {
          match.ambiguous = true;
        } else {
          match.placement = region.placement;
        }
        const exactFlowRoot =
          region.kind === "render" &&
          region.placement === "flow" &&
          "rootElementName" in region &&
          regionRange.from === match.from &&
          regionRange.to === match.to;
        if (exactFlowRoot && region.kind === "render" && "rootElementName" in region) {
          match.wholeBlockFlowRoot = true;
          const flowNativeBlocks = collectFlowNativeBlocks(
            region.flowChildren,
            regionRange,
            blocks,
            match.id,
            source.length,
            matches,
            flowOwnerBlocks,
          );
          match.nativeFlowOwnedBlockIds = flowNativeBlocks.ownedBlockIds;
          match.nativeChildOwners = flowNativeBlocks.childOwners;
          match.flowChildren = region.flowChildren;
        }
        match.nativeChildren =
          match.nativeChildOwners.some((owner) => owner !== null) &&
          match.placement === "flow";
        if ("rootElementName" in region) {
          if (match.rootElementName !== undefined && match.rootElementName !== region.rootElementName) {
            match.ambiguous = true;
          } else {
            match.rootElementName = region.rootElementName;
          }
        }
      }
    }
    if (owners.length > 1) {
      ownersByRegion.set(region, owners);
    }
  }

  for (const owners of ownersByRegion.values()) {
    for (const owner of owners) owner.ambiguous = true;
  }

  for (const match of matches) {
    const description = describeOwner(match);
    if (match.from === null || match.to === null) {
      projections.set(match.id, {
        kind: "unmapped",
        diagnostic: `${description} has no valid authored source range.`,
      });
      continue;
    }
    if (!match.ambiguous && match.regions.length > 0) {
      const orderedRegions = match.regions
        .slice()
        .sort((left, right) => left.from - right.from || left.to - right.to);
      let coveredUntil = match.from;
      for (const region of orderedRegions) {
        // One compiler ESM region may cover several native paragraph owners. Its authored
        // provenance stays intact; only its coverage of this owner's source is intersected.
        const from = Math.max(match.from, region.from);
        const to = Math.min(match.to, region.to);
        if (from < coveredUntil || source.slice(coveredUntil, from).trim().length > 0) {
          match.ambiguous = true;
          break;
        }
        coveredUntil = to;
      }
      if (!match.ambiguous && source.slice(coveredUntil, match.to).trim().length > 0) {
        match.ambiguous = true;
      }
    }

    if (match.ambiguous || match.regions.length === 0) {
      projections.set(match.id, {
        kind: "unmapped",
        diagnostic: match.ambiguous
          ? `${description} cannot be mapped exactly to unique authored regions.`
          : `${description} (${match.from}..${match.to}) has no corresponding authored MDX region.`,
        ...placementFields(match),
      });
      continue;
    }

    const renderRegions = match.regions.filter((region) => region.kind === "render");
    if (renderRegions.length > 0) {
      const placement = match.placement;
      if (placement === null) {
        projections.set(match.id, {
          kind: "unmapped",
          diagnostic: `${description} has render regions without compiler placement provenance.`,
        });
        continue;
      }
      if (match.nativeChildren && match.rootElementName === undefined) {
        projections.set(match.id, {
          kind: "unmapped",
          diagnostic: `${description} has prepared native children but no compiler-authored flow JSX root.`,
          placement,
        });
        continue;
      }
      const components: TrustedMdxCompiledRegion[] = [];
      let missingKey: string | null = null;
      for (const region of renderRegions) {
        if (!Object.prototype.hasOwnProperty.call(regionComponents, region.key)) {
          missingKey = region.key;
          break;
        }
        const component = regionComponents[region.key];
        if (typeof component !== "function") {
          missingKey = region.key;
          break;
        }
        components.push(component);
      }

      projections.set(
        match.id,
        missingKey === null
          ? {
              kind: "render",
              regions: Object.freeze(components),
              placement,
              ...(match.nativeChildren ? { nativeChildren: true as const } : {}),
              ...(match.nativeChildOwners.length > 0
                ? { nativeChildOwners: Object.freeze([...match.nativeChildOwners]) }
                : {}),
              ...(match.flowChildren ? { flowChildren: match.flowChildren } : {}),
              ...(match.nativeFlowOwnedBlockIds.length > 0
                ? { nativeFlowOwnedBlockIds: Object.freeze([...match.nativeFlowOwnedBlockIds]) }
                : {}),
              ...(match.wholeBlockFlowRoot ? { wholeBlockFlowRoot: true as const } : {}),
              ...(match.rootElementName === undefined ? {} : { rootElementName: match.rootElementName }),
            }
          : {
              kind: "unmapped",
              diagnostic: `No evaluated renderer exists for MDX region "${missingKey}".`,
              placement,
            },
      );
      continue;
    }

    if (match.regions.some((region) => region.kind === "module")) {
      projections.set(match.id, { kind: "module" });
      continue;
    }

    projections.set(match.id, {
      kind: "unmapped",
      diagnostic: `${description} has no renderable or module region.`,
    });
  }

  const moduleRanges: SourceRange[] = [];
  for (const region of regions) {
    if (region.kind !== "module") continue;
    const range = readSourceRange(region, source.length);
    if (range) moduleRanges.push(range);
  }
  for (const block of blocks) {
    const range = readSourceRange(block.payload.range, source.length);
    if (range && moduleRanges.some((module) => module.from <= range.from && module.to >= range.to)) {
      projections.set(block.id, { kind: "module" });
    }
  }

  const nativeChildIds = new Set<string>();
  for (const projection of projections.values()) {
    if (projection.kind !== "render") continue;
    for (const id of projection.nativeFlowOwnedBlockIds ?? []) nativeChildIds.add(id);
  }
  for (const id of nativeChildIds) {
    const projection = projections.get(id);
    if (!projection) {
      projections.set(id, { kind: "native-child", nativeFlowParent: true });
    } else {
      projections.set(id, { ...projection, nativeFlowParent: true });
    }
  }
  return Object.freeze(Object.fromEntries(projections));
}
