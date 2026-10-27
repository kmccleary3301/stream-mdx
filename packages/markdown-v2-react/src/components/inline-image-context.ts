import type { InlineNode } from "@stream-mdx/core";

const standaloneImageContainers: Record<string, true> = {
  p: true,
  div: true,
  li: true,
  td: true,
  th: true,
  figure: true,
  blockquote: true,
};

export function isStandaloneImageContainer(tagName: string | undefined): boolean {
  return tagName !== undefined && standaloneImageContainers[tagName.toLowerCase()] === true;
}

export function containsSingleImage(nodes: readonly InlineNode[]): boolean {
  let imageCount = 0;
  let valid = true;
  const visit = (items: readonly InlineNode[]) => {
    for (const item of items) {
      if (item.kind === "image" || (item.kind === "html" && item.tagName?.toLowerCase() === "img")) imageCount += 1;
      else if (item.kind === "text" && item.text.trim() === "") continue;
      else if (item.kind === "strong" || item.kind === "em" || item.kind === "link") visit(item.children);
      else if (item.kind === "html" && ["a", "strong", "em"].includes(item.tagName?.toLowerCase() ?? "")) visit(item.children ?? []);
      else valid = false;
    }
  };
  visit(nodes);
  return valid && imageCount === 1;
}
