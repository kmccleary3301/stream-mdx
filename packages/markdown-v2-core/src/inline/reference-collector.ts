import type { Tree } from "@lezer/common";
import type { LinkReferenceDefinition } from "./types";

export function normalizeLinkLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Collects all link reference definitions ([label]: url "title") from a Lezer parse tree.
 */
export function collectLinkReferences(tree: Tree, content: string): Map<string, LinkReferenceDefinition> {
  const references = new Map<string, LinkReferenceDefinition>();
  const cursor = tree.cursor();

  if (!cursor.firstChild()) {
    return references;
  }

  do {
    if (cursor.type.name === "LinkReference") {
      let label = "";
      let href = "";
      let title: string | undefined;

      if (cursor.firstChild()) {
        do {
          const type: string = cursor.type.name;
          const slice = content.slice(cursor.from, cursor.to);

          if (type === "LinkLabel") {
            // Strip outer [ and ]
            if (slice.startsWith("[") && slice.endsWith("]")) {
              label = normalizeLinkLabel(slice.slice(1, -1));
            } else {
              label = normalizeLinkLabel(slice);
            }
          } else if (type === "URL") {
            if (slice.startsWith("<") && slice.endsWith(">")) {
              href = slice.slice(1, -1);
            } else {
              href = slice;
            }
          } else if (type === "LinkTitle") {
            if (
              (slice.startsWith('"') && slice.endsWith('"')) ||
              (slice.startsWith("'") && slice.endsWith("'")) ||
              (slice.startsWith("(") && slice.endsWith(")"))
            ) {
              title = slice.slice(1, -1);
            } else {
              title = slice;
            }
          }
        } while (cursor.nextSibling());
        cursor.parent();
      }

      if (label && href && !references.has(label)) {
        references.set(label, { href, title });
      }
    }
  } while (cursor.nextSibling());

  return references;
}
