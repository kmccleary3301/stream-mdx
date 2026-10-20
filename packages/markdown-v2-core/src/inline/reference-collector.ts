import type { SyntaxNode, Tree } from "@lezer/common";
import { cleanTitle, cleanUrl } from "./lezer-converter";
import type { LinkReferenceDefinition } from "./types";
import type { SourceSnapshot } from "../source-document";

type SourceText = string | SourceSnapshot;

function readSourceRange(source: SourceText, from: number, to: number): string {
  return typeof source === "string" ? source.slice(from, to) : source.read(from, to);
}

function sourceCharAt(source: SourceText, index: number): string {
  return typeof source === "string" ? (source[index] ?? "") : source.read(index, index + 1);
}

export function normalizeLinkLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/ß|ẞ/g, "ss").replace(/\s+/g, " ");
}

/**
 * Extracts raw source text for a node, removing blockquote quote markers and prefixes
 * per source positions when the node spans across blockquote continuations.
 */
function extractNodeText(node: SyntaxNode, content: SourceText): string {
  const quoteMarks: { from: number; to: number }[] = [];
  const cur = node.cursor();
  function findQuotes(cursor: typeof cur) {
    if (cursor.name === "QuoteMark") {
      quoteMarks.push({ from: cursor.from, to: cursor.to });
    }
    if (cursor.firstChild()) {
      do {
        findQuotes(cursor);
      } while (cursor.nextSibling());
      cursor.parent();
    }
  }
  findQuotes(cur);

  if (quoteMarks.length === 0) {
    return readSourceRange(content, node.from, node.to);
  }

  let result = "";
  let lastPos = node.from;

  for (const qm of quoteMarks) {
    let prefixStart = qm.from;
    while (prefixStart > lastPos && (sourceCharAt(content, prefixStart - 1) === " " || sourceCharAt(content, prefixStart - 1) === "\t")) {
      prefixStart--;
    }
    let prefixEnd = qm.to;
    if (prefixEnd < node.to && sourceCharAt(content, prefixEnd) === " ") {
      prefixEnd++;
    }
    result += readSourceRange(content, lastPos, prefixStart);
    lastPos = prefixEnd;
  }
  result += readSourceRange(content, lastPos, node.to);
  return result;
}

/**
 * Leaf blocks never contain LinkReference nodes (definitions are block-level siblings), and paragraphs and
 * headings hold the inline subtrees that make up most of the tree, so the walk skips them.
 */
const REFERENCE_FREE_BLOCKS = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "CommentBlock",
  "ProcessingInstructionBlock",
  "HorizontalRule",
  "Table",
]);

/**
 * Collects all link reference definitions ([label]: url "title") recursively from a Lezer parse tree.
 */
export function collectLinkReferences(tree: Tree, content: string | SourceSnapshot): Map<string, LinkReferenceDefinition> {
  const references = new Map<string, LinkReferenceDefinition>();

  tree.iterate({
    enter(node) {
      if (REFERENCE_FREE_BLOCKS.has(node.name)) return false;
      if (node.name === "LinkReference") {
        let label = "";
        let rawLabel = "";
        let href: string | undefined;
        let title: string | undefined;

        let child = node.node.firstChild;
        while (child) {
          const type = child.name;
          if (type === "LinkLabel") {
            const rawSlice = extractNodeText(child, content);
            if (rawSlice.startsWith("[") && rawSlice.endsWith("]")) {
              rawLabel = rawSlice.slice(1, -1);
              label = normalizeLinkLabel(rawLabel);
            } else {
              rawLabel = rawSlice;
              label = normalizeLinkLabel(rawSlice);
            }
          } else if (type === "URL") {
            const rawSlice = extractNodeText(child, content);
            href = cleanUrl(rawSlice);
          } else if (type === "LinkTitle") {
            const rawSlice = extractNodeText(child, content);
            title = cleanTitle(rawSlice);
          }
          child = child.nextSibling;
        }

        if (label && href !== undefined && !references.has(label)) {
          references.set(label, { href, title, label: rawLabel });
        }
        return false;
      }
    },
  });

  return references;
}

/**
 * Computes the set of link labels that were added, removed, or changed between two reference maps.
 */
export function diffLinkReferences(
  prevRefs: Map<string, LinkReferenceDefinition> | undefined,
  nextRefs: Map<string, LinkReferenceDefinition>,
): Set<string> {
  const changed = new Set<string>();
  for (const [label, nextDef] of nextRefs) {
    const prevDef = prevRefs?.get(label);
    if (!prevDef || prevDef.href !== nextDef.href || prevDef.title !== nextDef.title) {
      changed.add(label);
    }
  }
  if (prevRefs) {
    for (const label of prevRefs.keys()) {
      if (!nextRefs.has(label)) {
        changed.add(label);
      }
    }
  }
  return changed;
}
