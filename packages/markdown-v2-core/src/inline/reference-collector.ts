import type { Tree } from "@lezer/common";
import { cleanTitle, cleanUrl } from "./lezer-converter";
import type { LinkReferenceDefinition } from "./types";

export function normalizeLinkLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/ß|ẞ/g, "ss").replace(/\s+/g, " ");
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
      let rawLabel = "";
      let href: string | undefined;
      let title: string | undefined;

      if (cursor.firstChild()) {
        do {
          const type: string = cursor.type.name;
          const slice = content.slice(cursor.from, cursor.to);

          if (type === "LinkLabel") {
            // Strip outer [ and ]
            if (slice.startsWith("[") && slice.endsWith("]")) {
              rawLabel = slice.slice(1, -1);
              label = normalizeLinkLabel(rawLabel);
            } else {
              rawLabel = slice;
              label = normalizeLinkLabel(slice);
            }
          } else if (type === "URL") {
            href = cleanUrl(slice);
          } else if (type === "LinkTitle") {
            title = cleanTitle(slice);
          }
        } while (cursor.nextSibling());
        cursor.parent();
      }

      if (label && href !== undefined && !references.has(label)) {
        references.set(label, { href, title, label: rawLabel });
      }
    }
  } while (cursor.nextSibling());

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
