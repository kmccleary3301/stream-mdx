import type { Block, HtmlTreeNode, NodeSnapshot, PreparedNestedSnapshot } from "@stream-mdx/core";
import { getActiveHtmlTreeKey } from "./html-ownership";
import {
  compareLazyPriority,
  mergeLazyRequests,
  type LazyTokenizationPriority,
  type LazyTokenizationRequest,
} from "../lazy-tokenization";
import type { LazyTokenizationState } from "./types";

export const DEFAULT_LAZY_TOKENIZATION_THRESHOLD = 200;
export type LazyTokenizationQueue = Map<string, Map<LazyTokenizationPriority, LazyTokenizationRequest>>;

export const MIN_LAZY_TOKENIZATION_THRESHOLD = 50;
export const MAX_LAZY_TOKENIZATION_THRESHOLD = 10000;

export function makeLazySignature(codeBody: string, lang: string, tokenLang: string, diffEnabled: boolean): string {
  const head = codeBody.slice(0, 32);
  const tail = codeBody.slice(Math.max(0, codeBody.length - 32));
  return `${lang}|${tokenLang}|${diffEnabled ? "diff" : "plain"}|${codeBody.length}|${head}|${tail}`;
}

export function getOrInitLazyState(
  states: Map<string, LazyTokenizationState>,
  blockId: string,
  signature: string,
  lineCount: number,
  lang: string,
  tokenLang: string,
  diffEnabled: boolean,
): LazyTokenizationState {
  const existing = states.get(blockId);
  if (existing && existing.signature === signature && existing.lineCount === lineCount) {
    return existing;
  }
  const fresh: LazyTokenizationState = {
    signature,
    lineCount,
    processedLines: 0,
    highlightedLines: new Array(lineCount).fill(null),
    tokenLines: new Array(lineCount).fill(null),
    diffKind: [],
    oldNo: [],
    newNo: [],
    diffCursor: diffEnabled ? { oldLine: null, newLine: null } : undefined,
    grammarState: undefined,
    inProgressRange: null,
  };
  states.set(blockId, fresh);
  return fresh;
}

export function shouldLazyTokenizeBlock(
  enabled: boolean,
  lineCount: number,
  thresholdLines: number,
  hasHighlighter: boolean,
  hasHighlightableContent: boolean,
): boolean {
  if (!enabled || !hasHighlighter || !hasHighlightableContent) return false;
  return lineCount >= thresholdLines;
}

export function pruneLazyTokenizationStates(states: Map<string, LazyTokenizationState>, nextBlocks: Block[]): void {
  if (states.size === 0) return;
  const ids = new Set(nextBlocks.map((block) => block.id));
  const seen = new WeakSet<object>();
  const visitTree = (tree: HtmlTreeNode[]) => {
    for (const node of tree) {
      if (node.kind === "block") visitBlock(node.block);
      else if (node.kind === "element") visitTree(node.children);
    }
  };
  const visitSnapshots = (children: NodeSnapshot[]) => {
    for (const child of children) {
      if (seen.has(child)) continue;
      seen.add(child);
      const block = child.props?.block as Block | undefined;
      if (block) visitBlock(block);
      if (child.type === "code") ids.add(child.id);
      else visitSnapshots(child.children ?? []);
    }
  };
  const visitBlock = (block: Block) => {
    if (seen.has(block)) return;
    seen.add(block);
    if (block.type === "code") ids.add(block.id);
    const prepared = block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (prepared) visitSnapshots(prepared.children);
    const treeKey = getActiveHtmlTreeKey(block.payload.meta);
    if (treeKey) {
      const tree = block.payload.meta?.[treeKey] as HtmlTreeNode[] | undefined;
      if (tree) visitTree(tree);
    }
  };
  for (const block of nextBlocks) visitBlock(block);
  for (const key of states.keys()) {
    if (!ids.has(key)) {
      states.delete(key);
    }
  }
}

export function enqueueLazyTokenization(
  queue: LazyTokenizationQueue,
  enabled: boolean,
  request: LazyTokenizationRequest,
): void {
  if (!enabled) return;
  const requests = queue.get(request.blockId);
  const existing = requests?.get(request.priority);
  const next = existing ? mergeLazyRequests(existing, request) : request;
  if (requests) {
    requests.set(request.priority, next);
  } else {
    queue.set(request.blockId, new Map([[request.priority, next]]));
  }
}

export function selectNextLazyRequest(queue: LazyTokenizationQueue): LazyTokenizationRequest | null {
  let selected: LazyTokenizationRequest | null = null;
  for (const requests of queue.values()) {
    for (const request of requests.values()) {
      if (!selected) {
        selected = request;
        continue;
      }
      const priorityDiff = compareLazyPriority(request.priority, selected.priority);
      if (priorityDiff > 0) {
        selected = request;
        continue;
      }
      if (priorityDiff === 0 && request.requestedAt < selected.requestedAt) {
        selected = request;
      }
    }
  }
  return selected;
}
