import {
  sanitizeHtmlTreeInWorker,
  type HtmlOptions,
  type HtmlTreeNode,
  type InlineNode,
} from "@stream-mdx/core";

export const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");

export function inlineHtml(nodes: InlineNode[]): string {
  return nodes.map((node): string => {
    switch (node.kind) {
      case "text": return escapeHtml(node.text);
      // Ownership markup is inert; the marked native slot retains its MDX projection.
      case "trusted-mdx-inline": return escapeHtml(node.raw);
      case "code": return `<code>${escapeHtml(node.text)}</code>`;
      case "br": return "<br>\n";
      case "strong": return `<strong>${inlineHtml(node.children)}</strong>`;
      case "em": return `<em>${inlineHtml(node.children)}</em>`;
      case "strike": return `<del>${inlineHtml(node.children)}</del>`;
      case "link": return `<a${node.href === undefined ? "" : ` href="${escapeHtml(node.href)}"`}>${inlineHtml(node.children)}</a>`;
      case "image": return `<img src="${escapeHtml(node.src)}" alt="${escapeHtml(node.alt ?? "")}">`;
      case "html": {
        if (node.isClose) return node.raw;
        if (!node.tagName || node.tagName === "script" || node.tagName === "style") return "";
        const attrs = Object.entries(node.attributes ?? {}).map(([key, value]) => ` ${key === "className" ? "class" : key}="${escapeHtml(value)}"`).join("");
        return `<${node.tagName}${attrs}>${node.isSelfClosing ? "" : `${inlineHtml(node.children ?? [])}</${node.tagName}>`}`;
      }
      case "plugin": return node.children ? inlineHtml(node.children) : escapeHtml(node.raw);
      case "math-inline": case "math-display": return escapeHtml(node.tex);
      case "mention": return escapeHtml(`@${node.handle}`);
      case "citation": return escapeHtml(node.id);
      case "footnote-ref": return escapeHtml(`[^${node.label}]`);
    }
  }).join("");
}

/** Serializes one native inline range through the existing identity-preserving HTML-tree path. */
export function normalizeNativeInlineParagraph(
  source: string,
  nativeInline: InlineNode[],
  options?: HtmlOptions,
  inlineReplacements?: ReadonlyMap<InlineNode, readonly InlineNode[]>,
  inlineNodeMetadata?: ReadonlyMap<InlineNode, InlineNode>,
): HtmlTreeNode[] {
  let attribute = "smdxinline";
  const lower = source.toLowerCase();
  while (lower.includes(attribute)) attribute += "x";
  const inline: InlineNode[] = [];
  const serialize = (nodes: readonly InlineNode[]): string => nodes.map((node): string => {
    const replacement = inlineReplacements?.get(node);
    if (replacement !== undefined) return serialize(replacement);
    if (node.kind === "text") return escapeHtml(node.text);
    if (node.kind === "html") {
      if (node.isClose) return node.raw;
      const open = node.openingRaw ?? node.raw;
      if (node.isSelfClosing) return open;
      const literal = ["pre", "code", "textarea", ...(options?.literalTagContent ?? [])]
        .some((tag) => tag.toLowerCase() === node.tagName);
      const children = literal
        ? (node.children ?? []).map((child) => child.kind === "text" ? escapeHtml(child.text) : inlineHtml([child])).join("")
        : serialize(node.children ?? []);
      // Paragraph-local sanitization cannot see a matching close tag in a later HTML block.
      const closesMatchedBareAnchor =
        !node.closingRaw &&
        options?.mode !== "literal" &&
        options?.unmatchedAnchors === "literal-bare" &&
        node.tagName?.toLowerCase() === "a" &&
        /^<a\s*>$/i.test(open);
      return open + children + (node.closingRaw ?? (closesMatchedBareAnchor ? "</a>" : ""));
    }
    const index = inline.push(inlineNodeMetadata?.get(node) ?? node) - 1;
    const slot = ` ${attribute}="${index}"`;
    if (node.kind === "strong" || node.kind === "em" || node.kind === "strike" || node.kind === "link") {
      const tag = node.kind === "strike" ? "del" : node.kind === "link" ? "a" : node.kind;
      const href = node.kind === "link" && node.href !== undefined ? ` href="${escapeHtml(node.href)}"` : "";
      return `<${tag}${slot}${href}>${serialize(node.children)}</${tag}>`;
    }
    if (node.kind === "plugin" && node.children) {
      return `<span${slot}>${serialize(node.children)}</span>`;
    }
    return `<span${slot}>${inlineHtml([node])}</span>`;
  }).join("");
  const normalized = sanitizeHtmlTreeInWorker(
    `<p class="markdown-paragraph" ${attribute}="paragraph">${serialize(nativeInline)}</p>\n`,
    options,
    { attribute, inline },
  );
  return normalized;
}
