import type { NodeRecord } from "./store";

type NodeMap = Map<string, NodeRecord>;

export function updateNodeDepth(node: NodeRecord | undefined, depth: number): boolean {
  if (!node) return false;
  const currentDepth = typeof node.props?.depth === "number" ? (node.props.depth as number) : undefined;
  if (currentDepth === depth) {
    return false;
  }
  const nextProps = { ...(node.props ?? {}) };
  nextProps.depth = depth;
  node.props = nextProps;
  node.version++;
  return true;
}

export function normalizeAllListDepths(map: NodeMap, touched: Set<string>, rootId = "__root__"): void {
  const root = map.get(rootId);
  if (!root) return;
  for (const childId of root.children) {
    const child = map.get(childId);
    if (child && child.type === "list") {
      normalizeListDepthRecursive(map, child, 0, touched);
    }
  }
}

export function normalizeListDepthsForIds(
  map: NodeMap,
  touched: Set<string>,
  listIds: Set<string>,
  rootId = "__root__",
): void {
  if (listIds.size === 0) {
    normalizeAllListDepths(map, touched, rootId);
    return;
  }

  const visited = new Set<string>();
  for (const listId of listIds) {
    const base = map.get(listId);
    if (!base) continue;
    const listNode = base.type === "list" ? base : findNearestListAncestor(map, base);
    if (!listNode || visited.has(listNode.id)) continue;
    visited.add(listNode.id);
    const depth = computeListDepth(map, listNode, rootId);
    normalizeListDepthRecursive(map, listNode, depth, touched);
  }
}

function normalizeListDepthRecursive(map: NodeMap, listNode: NodeRecord, depth: number, touched: Set<string>) {
  if (!listNode) return;
  if (updateNodeDepth(listNode, depth)) {
    touched.add(listNode.id);
  }
  for (const childId of listNode.children) {
    const child = map.get(childId);
    if (!child) continue;
    if (child.type === "list-item") {
      if (updateNodeDepth(child, depth)) {
        touched.add(child.id);
      }
      for (const grandchildId of child.children) {
        const grandchild = map.get(grandchildId);
        if (!grandchild) continue;
        if (grandchild.type === "list") {
          normalizeListDepthRecursive(map, grandchild, depth + 1, touched);
        }
      }
    } else if (child.type === "list") {
      normalizeListDepthRecursive(map, child, depth + 1, touched);
    }
  }
}

function findNearestListAncestor(map: NodeMap, node: NodeRecord): NodeRecord | undefined {
  let current: NodeRecord | undefined = node;
  while (current) {
    if (current.type === "list") return current;
    if (!current.parentId) return undefined;
    current = map.get(current.parentId);
  }
  return undefined;
}

function computeListDepth(map: NodeMap, listNode: NodeRecord, rootId: string): number {
  let depth = 0;
  let current: NodeRecord | undefined = listNode;
  while (current && current.parentId && current.parentId !== rootId) {
    const parent = map.get(current.parentId);
    if (!parent) break;
    if (parent.type === "list") {
      depth += 1;
    }
    current = parent;
  }
  return depth;
}
