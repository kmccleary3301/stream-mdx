import type { InlineNode, ParagraphSpanChildSnapshot } from "@stream-mdx/core";

/** HTML left inside a mixed text segment was not admitted as a native HTML child. */
export function literalizeFallbackHtml(nodes: InlineNode[]): InlineNode[];
export function literalizeFallbackHtml(nodes: readonly InlineNode[]): readonly InlineNode[];
export function literalizeFallbackHtml(nodes: readonly InlineNode[]): readonly InlineNode[] {
  let result: InlineNode[] | undefined;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    let nextNode = node;
    if (node.kind === "html") {
      nextNode = { kind: "text", text: node.raw };
    } else if ("children" in node && Array.isArray(node.children)) {
      const children = literalizeFallbackHtml(node.children);
      if (children !== node.children) nextNode = { ...node, children };
    }
    if (result) result.push(nextNode);
    else if (nextNode !== node) {
      result = [];
      for (let prior = 0; prior < index; prior += 1) result.push(nodes[prior]!);
      result.push(nextNode);
    }
  }
  return result ?? nodes;
}

export function literalizeFallbackHtmlInChildren(
  children: readonly ParagraphSpanChildSnapshot[],
): readonly ParagraphSpanChildSnapshot[] {
  let result: ParagraphSpanChildSnapshot[] | undefined;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const props = child.props;
    const inline = child.type === "paragraph-text" && props && Array.isArray(props.inline)
      ? props.inline as readonly InlineNode[]
      : undefined;
    const literalInline = inline ? literalizeFallbackHtml(inline) : undefined;
    const nextChild = inline && literalInline !== inline
      ? { ...child, props: { ...(props ?? {}), inline: literalInline } }
      : child;
    if (result) result.push(nextChild);
    else if (nextChild !== child) {
      result = [];
      for (let prior = 0; prior < index; prior += 1) result.push(children[prior]!);
      result.push(nextChild);
    }
  }
  return result ?? children;
}

export function stringListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function stringRecordsEqual(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || left[key] !== right[key]) return false;
  }
  return true;
}

function optionalInlineNodesEqual(
  left: readonly InlineNode[] | undefined,
  right: readonly InlineNode[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return inlineNodesEqual(left, right);
}

export function inlineNodesEqual(left: readonly InlineNode[], right: readonly InlineNode[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftNode = left[index];
    const rightNode = right[index];
    if (!leftNode || !rightNode || !inlineNodeEqual(leftNode, rightNode)) return false;
  }
  return true;
}

function inlineNodeEqual(left: InlineNode, right: InlineNode): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "text":
      return right.kind === "text" && left.text === right.text;
    case "strong":
      return right.kind === "strong" && inlineNodesEqual(left.children, right.children);
    case "em":
      return right.kind === "em" && inlineNodesEqual(left.children, right.children);
    case "strike":
      return right.kind === "strike" && inlineNodesEqual(left.children, right.children);
    case "code":
      return right.kind === "code" && left.text === right.text;
    case "link":
      return right.kind === "link"
        && left.href === right.href
        && left.title === right.title
        && left.autolink === right.autolink
        && inlineNodesEqual(left.children, right.children);
    case "image":
      return right.kind === "image"
        && left.src === right.src
        && left.alt === right.alt
        && left.title === right.title;
    case "br":
      return right.kind === "br";
    case "html":
      return right.kind === "html"
        && left.raw === right.raw
        && left.openingRaw === right.openingRaw
        && left.closingRaw === right.closingRaw
        && left.sanitized === right.sanitized
        && left.tagName === right.tagName
        && left.isClose === right.isClose
        && left.isSelfClosing === right.isSelfClosing
        && stringRecordsEqual(left.attributes, right.attributes)
        && optionalInlineNodesEqual(left.children, right.children);
    case "mention":
      return right.kind === "mention" && left.handle === right.handle;
    case "citation":
      return right.kind === "citation" && left.id === right.id;
    case "math-inline":
      return right.kind === "math-inline" && left.tex === right.tex;
    case "math-display":
      return right.kind === "math-display" && left.tex === right.tex;
    case "footnote-ref":
      return right.kind === "footnote-ref"
        && left.label === right.label
        && left.number === right.number
        && left.occurrence === right.occurrence
        && left.defined === right.defined;
    case "plugin":
      return right.kind === "plugin"
        && left.name === right.name
        && left.raw === right.raw
        && stringRecordsEqual(left.attrs, right.attrs)
        && optionalInlineNodesEqual(left.children, right.children);
    default: {
      const unreachable: never = left;
      return unreachable;
    }
  }
}
