import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { Block } from "@stream-mdx/core";
import type { MarkdownBlocksRendererProps } from "../../packages/markdown-v2-react/src/renderer/blocks-renderer";
import type { RendererStore } from "@stream-mdx/react/renderer/store";
import {
  ComponentRegistry,
  MarkdownBlocksRenderer,
} from "./diagnostic-dist/index.mjs";
import type { DenseFixture } from "./replay-fixtures";
import type { FootnoteItem, InlineNode } from "@stream-mdx/core";
import { getCodeBlockLang, verifyAuthoredCodeExpectations } from "./replay-code-parity";

/**
 * Verifies SSR-rendered semantic expectations for a DenseFixture against
 * the blocks and store produced by replay chunking.
 *
 * Renders actual native MarkdownBlocksRenderer with ComponentRegistry from
 * the counter-enabled diagnostic bundle with real required props.
 * Verifies declared headings, links, safe HTML visible text, table geometry/content,
 * footnote reference and backlink target topology, list looseness paragraph wrapping,
 * and baseline HTML execution-safety invariants.
 *
 * Cleans up and disposes DOM resources per call.
 */
export function verifyRenderedExpectations(
  fixture: DenseFixture,
  blocks: ReadonlyArray<Block>,
  store: RendererStore,
): { ok: boolean; message?: string } {
  const exp = fixture.expectations;
  if (!exp) {
    return { ok: true };
  }

  // 1. SSR render with actual native components and real required props
  const registry = new ComponentRegistry();
  const rendererProps: MarkdownBlocksRendererProps = {
    blocks,
    componentRegistry: registry,
    store,
  };
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, rendererProps),
  );

  // 2. Parse finite DOM and guarantee disposal per call
  const dom = new JSDOM(markup);
  try {
    const root: HTMLElement = dom.window.document.body;

    // 3. Baseline HTML safety: assert no execution-capable authored DOM routes (<script>, on*, javascript:)
    const scripts = root.querySelectorAll("script");
    if (scripts.length > 0) {
      return {
        ok: false,
        message: `Execution-capable <script> element (${scripts.length}) found in rendered DOM`,
      };
    }

    const allElements = Array.from(root.querySelectorAll("*"));
    for (const el of allElements) {
      for (const attr of Array.from(el.attributes)) {
        if (/^on[a-z]/i.test(attr.name)) {
          return {
            ok: false,
            message: `Execution-capable event handler attribute '${attr.name}' found on <${el.tagName.toLowerCase()}>`,
          };
        }
      }

      for (const attrName of ["href", "src", "action", "formaction", "xlink:href"]) {
        const val = el.getAttribute(attrName);
        if (
          val &&
          /^(?:javascript|vbscript|data(?!\s*:\s*image\/(?:png|gif|jpeg|webp|avif))):/i.test(val.trim())
        ) {
          return {
            ok: false,
            message: `Execution-capable URL scheme '${val}' found in '${attrName}' on <${el.tagName.toLowerCase()}>`,
          };
        }
      }
    }

    // 4. Declared headings: exact level and exact text
    if (exp.headings && exp.headings.length > 0) {
      const headingElements = Array.from(
        root.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6"),
      ).filter((h) => {
        // Exclude generated screen-reader-only footnote section headers
        if (h.id === "footnote-label" || h.classList.contains("sr-only")) {
          return false;
        }
        return true;
      });

      if (headingElements.length !== exp.headings.length) {
        return {
          ok: false,
          message: `Heading count mismatch: expected ${exp.headings.length}, got ${headingElements.length}`,
        };
      }

      for (let i = 0; i < exp.headings.length; i++) {
        const expected = exp.headings[i];
        const actualEl = headingElements[i];
        const actualLevel = Number(actualEl.tagName.slice(1));
        const clone = actualEl.cloneNode(true) as HTMLElement;
        for (const hidden of Array.from(clone.querySelectorAll("[aria-hidden='true']"))) {
          hidden.remove();
        }
        const actualText = (clone.textContent ?? "").trim();

        if (actualLevel !== expected.level) {
          return {
            ok: false,
            message: `Heading [${i}] level mismatch: expected h${expected.level}, got h${actualLevel}`,
          };
        }

        if (actualText !== expected.text) {
          return {
            ok: false,
            message: `Heading [${i}] text mismatch: expected ${JSON.stringify(expected.text)}, got ${JSON.stringify(actualText)}`,
          };
        }
      }
    }

    // 5. Declared links: exact href and exact title
    if (exp.links && exp.links.length > 0) {
      const contentLinks = Array.from(
        root.querySelectorAll<HTMLAnchorElement>("a"),
      ).filter((a) => {
        if (
          a.classList.contains("footnote-backref") ||
          a.hasAttribute("data-footnote-backref")
        ) {
          return false;
        }
        if (
          a.closest("sup.footnote-ref") ||
          a.hasAttribute("data-footnote-ref")
        ) {
          return false;
        }
        return a.hasAttribute("href");
      });

      if (contentLinks.length !== exp.links.length) {
        return {
          ok: false,
          message: `Link count mismatch: expected ${exp.links.length}, got ${contentLinks.length}`,
        };
      }

      for (let i = 0; i < exp.links.length; i++) {
        const expected = exp.links[i];
        const actualEl = contentLinks[i];
        const actualHref = actualEl.getAttribute("href");
        const actualTitle = actualEl.getAttribute("title") ?? undefined;

        if (actualHref !== expected.href) {
          return {
            ok: false,
            message: `Link [${i}] href mismatch: expected ${JSON.stringify(expected.href)}, got ${JSON.stringify(actualHref)}`,
          };
        }

        if (actualTitle !== expected.title) {
          return {
            ok: false,
            message: `Link [${i}] title mismatch: expected ${JSON.stringify(expected.title)}, got ${JSON.stringify(actualTitle)}`,
          };
        }
      }
    }

    // 6. Safe HTML: decoded visible text
    if (exp.htmlSnippets && exp.htmlSnippets.length > 0) {
      const visibleText = root.textContent ?? "";
      for (const snippet of exp.htmlSnippets) {
        if (!visibleText.includes(snippet)) {
          return {
            ok: false,
            message: `Safe HTML missing decoded visible snippet: ${JSON.stringify(snippet)}`,
          };
        }
      }
    }

    // 7. Declared tables: column count, all row widths, alignments, and rendered cell strings
    if (exp.tables && exp.tables.length > 0) {
      const tables = Array.from(root.querySelectorAll<HTMLTableElement>("table"));
      if (tables.length < exp.tables.length) {
        return {
          ok: false,
          message: `Missing expected table: expected at least ${exp.tables.length}, found ${tables.length}`,
        };
      }

      for (let t = 0; t < exp.tables.length; t++) {
        const expTable = exp.tables[t];
        const table = tables[t];

        const theadRows = Array.from(table.querySelectorAll("thead tr"));
        const tbodyRows = Array.from(table.querySelectorAll("tbody tr")).filter(
          (row) => !row.classList.contains("markdown-table-spacer"),
        );

        if (theadRows.length === 0) {
          return {
            ok: false,
            message: `Table [${t}] missing <thead> header row`,
          };
        }

        // Explicit rowCount assertion
        if (expTable.rowCount !== undefined && tbodyRows.length !== expTable.rowCount) {
          return {
            ok: false,
            message: `Table [${t}] row count mismatch: expected ${expTable.rowCount} body rows, got ${tbodyRows.length}`,
          };
        }

        // Header column count
        const headerCells = Array.from(theadRows[0].querySelectorAll("th, td"));
        if (headerCells.length !== expTable.columnCount) {
          return {
            ok: false,
            message: `Table [${t}] column count mismatch: expected ${expTable.columnCount}, got ${headerCells.length}`,
          };
        }

        // All row widths (every row must match columnCount)
        const allRows = [...theadRows, ...tbodyRows];
        for (let r = 0; r < allRows.length; r++) {
          const cells = Array.from(allRows[r].querySelectorAll("th, td"));
          if (cells.length !== expTable.columnCount) {
            return {
              ok: false,
              message: `Table [${t}] row [${r}] width mismatch: expected ${expTable.columnCount} cells, got ${cells.length}`,
            };
          }
        }

        // Column alignments across all rows
        if (expTable.alignments && expTable.alignments.length > 0) {
          for (let colIdx = 0; colIdx < expTable.columnCount; colIdx++) {
            const expectedAlign = expTable.alignments[colIdx];
            for (let r = 0; r < allRows.length; r++) {
              const cell = allRows[r].querySelectorAll("th, td")[colIdx] as HTMLElement;
              const actualAlign =
                cell.getAttribute("align") ?? cell.style.textAlign ?? null;

              if (expectedAlign === null) {
                if (actualAlign && actualAlign !== "" && actualAlign !== "none") {
                  return {
                    ok: false,
                    message: `Table [${t}] row [${r}] col [${colIdx}] expected unaligned/null, got '${actualAlign}'`,
                  };
                }
              } else if (actualAlign !== expectedAlign) {
                return {
                  ok: false,
                  message: `Table [${t}] row [${r}] col [${colIdx}] alignment mismatch: expected '${expectedAlign}', got '${actualAlign}'`,
                };
              }
            }
          }
        }

        // Rendered cell strings (matching decoded rendered cell text, not raw source)
        if (expTable.cellSubstrings && expTable.cellSubstrings.length > 0) {
          const renderedCellTexts = Array.from(
            table.querySelectorAll("th, td"),
          ).map((c) => (c.textContent ?? "").trim());

          for (const substr of expTable.cellSubstrings) {
            const found = renderedCellTexts.some((text) => text.includes(substr));
            if (!found) {
              return {
                ok: false,
                message: `Table [${t}] missing expected rendered cell content: ${JSON.stringify(substr)}`,
              };
            }
          }
        }
      }
    }

    // 8. Footnote topology: consumer refs must resolve actual footer body/number and backlinks actual ref anchor
    if (exp.footnotes && exp.footnotes.length > 0) {
      const allRefLinks = Array.from(
        root.querySelectorAll<HTMLAnchorElement>("sup.footnote-ref a, a[data-footnote-ref]"),
      );

      for (const expFn of exp.footnotes) {
        // Find reference link matching label or number
        const refLink = allRefLinks.find((a) => {
          const label = a.getAttribute("data-label");
          if (label && label === expFn.label) return true;
          return (a.textContent ?? "").trim() === String(expFn.number);
        });

        if (!refLink) {
          return {
            ok: false,
            message: `Missing rendered footnote reference anchor for label='${expFn.label}' (number=${expFn.number})`,
          };
        }

        // Verify visible reference number
        const visibleRefNumber = (refLink.textContent ?? "").trim();
        if (visibleRefNumber !== String(expFn.number)) {
          return {
            ok: false,
            message: `Footnote reference '${expFn.label}' visible number mismatch: expected '${expFn.number}', got '${visibleRefNumber}'`,
          };
        }

        // Verify reference href targets actual footer element
        const targetHref = refLink.getAttribute("href");
        if (!targetHref || !targetHref.startsWith("#")) {
          return {
            ok: false,
            message: `Footnote reference '${expFn.label}' href '${targetHref}' is not a local anchor`,
          };
        }

        const targetId = targetHref.slice(1);
        const footerItem = dom.window.document.getElementById(targetId);
        if (!footerItem) {
          return {
            ok: false,
            message: `Footnote reference '${expFn.label}' target element '#${targetId}' not found in footer`,
          };
        }

        // Verify visible body text snippet in footer item
        if (expFn.textSnippet) {
          const footerItemText = footerItem.textContent ?? "";
          if (!footerItemText.includes(expFn.textSnippet)) {
            return {
              ok: false,
              message: `Footnote '${expFn.label}' footer body text missing snippet ${JSON.stringify(expFn.textSnippet)}`,
            };
          }
        }

        // Verify backlink in footer item resolves to originating reference anchor
        const backlink = footerItem.querySelector<HTMLAnchorElement>(
          "a.footnote-backref, a[data-footnote-backref]",
        );
        if (!backlink) {
          return {
            ok: false,
            message: `Footnote '${expFn.label}' footer item missing backlink anchor`,
          };
        }

        const backlinkHref = backlink.getAttribute("href");
        if (!backlinkHref || !backlinkHref.startsWith("#")) {
          return {
            ok: false,
            message: `Footnote '${expFn.label}' backlink href '${backlinkHref}' is not a local anchor`,
          };
        }

        const backlinkTargetId = backlinkHref.slice(1);
        const backlinkTarget = dom.window.document.getElementById(backlinkTargetId);
        if (!backlinkTarget) {
          return {
            ok: false,
            message: `Footnote '${expFn.label}' backlink target '#${backlinkTargetId}' not found in document`,
          };
        }

        const isRefAnchor =
          backlinkTarget === refLink ||
          backlinkTarget.contains(refLink) ||
          refLink.contains(backlinkTarget);

        if (!isRefAnchor) {
          return {
            ok: false,
            message: `Footnote '${expFn.label}' backlink target '#${backlinkTargetId}' does not resolve to reference anchor`,
          };
        }
      }
    }

    // 9. List looseness: verify earlier list items wrap content in paragraph (<p>) tags
    if (exp.listLooseness) {
      const listElement = root.querySelector("ul, ol");
      if (!listElement) {
        return {
          ok: false,
          message: "Missing list element for declared listLooseness expectation",
        };
      }

      const listItems = Array.from(listElement.querySelectorAll(":scope > li"));
      if (listItems.length === 0) {
        return {
          ok: false,
          message: "List element contains no list items (<li>)",
        };
      }

      for (let i = 0; i < listItems.length; i++) {
        const li = listItems[i];
        const paragraph = li.querySelector(":scope > p");
        if (!paragraph) {
          return {
            ok: false,
            message: `Loose list item [${i}] content is not wrapped in a paragraph (<p>) element`,
          };
        }
      }
    }

    return { ok: true };
  } finally {
    dom.window.close();
  }
}

export function collectBlocksRecursively(blocks: ReadonlyArray<Block>): Block[] {
  const result: Block[] = [];
  const seen = new Set<string>();

  function visitBlock(b: Block) {
    if (seen.has(b.id)) return;
    seen.add(b.id);
    result.push(b);

    const meta = b.payload.meta as Record<string, unknown> | undefined;
    const prepared = meta?.preparedNested as
      | { children?: Array<{ props?: { block?: Block }; type?: string; children?: unknown[] }> }
      | undefined;
    if (prepared?.children) {
      for (const child of prepared.children) {
        visitNode(child);
      }
    }
  }

  function visitNode(node: { props?: { block?: Block }; type?: string; children?: unknown[] }) {
    if (node.props?.block) {
      visitBlock(node.props.block);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child && typeof child === "object") {
          visitNode(child as { props?: { block?: Block }; type?: string; children?: unknown[] });
        }
      }
    }
  }

  for (const b of blocks) {
    visitBlock(b);
  }
  return result;
}

function extractInlineText(node: InlineNode): string {
  if (node.kind === "text") return node.text;
  if ("children" in node && Array.isArray(node.children)) {
    const children = node.children;
    return children.map(extractInlineText).join("");
  }
  if ("raw" in node && typeof node.raw === "string") {
    return node.raw;
  }
  return "";
}

function extractFootnoteItemText(item: FootnoteItem): string {
  if (!Array.isArray(item.inlines)) return "";
  return item.inlines.map(extractInlineText).join("");
}

export function verifyIndependentExpectations(
  blocks: ReadonlyArray<Block>,
  fixture: DenseFixture,
  store: RendererStore,
): { ok: boolean; message?: string } {
  const exp = fixture.expectations;
  if (!exp) return { ok: true };

  const allBlocks = collectBlocksRecursively(blocks);
  const codeBlocks = allBlocks.filter((b) => b.type === "code");
  const listBlock = allBlocks.find((b) => b.type === "list");

  if (exp.codeBlocks) {
    const authoredResult = verifyAuthoredCodeExpectations(fixture.source, exp.codeBlocks);
    if (!authoredResult.ok) return authoredResult;

    for (const expCb of exp.codeBlocks) {
      const match = codeBlocks.find((cb) => {
        const meta = cb.payload.meta as Record<string, unknown> | undefined;
        return getCodeBlockLang(meta) === expCb.lang;
      });
      if (!match) {
        return {
          ok: false,
          message: `Missing expected code block with lang='${expCb.lang}' (observed code langs: [${codeBlocks
            .map((codeBlock) => getCodeBlockLang(codeBlock.payload.meta as Record<string, unknown> | undefined))
            .filter(Boolean)
            .join(", ")}])`,
        };
      }

      const codeView = store.getCodeBlock(match.id);
      if (!codeView) {
        return { ok: false, message: `Missing prepared code owner state for block ${match.id}` };
      }
      if (codeView.source.lineCount !== expCb.codeLines.length) {
        return {
          ok: false,
          message: `Code block lang='${expCb.lang}' line count mismatch: actual=${codeView.source.lineCount} expected=${expCb.codeLines.length}`,
        };
      }
      const actualLines = store.getCodeLines(match.id, 0, codeView.source.lineCount);
      if (actualLines.length !== expCb.codeLines.length) {
        return {
          ok: false,
          message: `Bounded prepared code read returned ${actualLines.length} rows for lang='${expCb.lang}'; expected=${expCb.codeLines.length}`,
        };
      }

      for (let lineIndex = 0; lineIndex < expCb.codeLines.length; lineIndex += 1) {
        const expectedLine = expCb.codeLines[lineIndex];
        const actualLine = actualLines[lineIndex];
        if (actualLine?.text !== expectedLine) {
          return {
            ok: false,
            message: `Code block lang='${expCb.lang}' line ${lineIndex} mismatch: actual=${JSON.stringify(actualLine?.text)} expected=${JSON.stringify(expectedLine)}`,
          };
        }
      }
    }
  }


  if (exp.footnotes) {
    const fnFooter = allBlocks.find((b) => b.type === "footnotes");
    if (!fnFooter) {
      return { ok: false, message: "Missing expected footnotes footer block" };
    }
    const items = (fnFooter.payload.meta?.items as FootnoteItem[] | undefined) ?? [];
    for (const expFn of exp.footnotes) {
      const item = items.find((it) => it.label === expFn.label);
      if (!item) {
        return { ok: false, message: `Footnotes footer missing definition for '${expFn.label}'` };
      }
      if (item.number !== expFn.number) {
        return {
          ok: false,
          message: `Footnote '${expFn.label}' expected number ${expFn.number} but got ${item.number}`,
        };
      }
      if (typeof item.refCount === "number" && item.refCount < 1) {
        return {
          ok: false,
          message: `Footnote '${expFn.label}' has zero occurrence count`,
        };
      }
      if (expFn.textSnippet) {
        const itemText = extractFootnoteItemText(item);
        if (!itemText.includes(expFn.textSnippet)) {
          return {
            ok: false,
            message: `Footnote '${expFn.label}' body text ${JSON.stringify(itemText)} missing expected snippet: ${JSON.stringify(expFn.textSnippet)}`,
          };
        }
      }
    }
  }

  if (exp.listLooseness) {
    if (listBlock) {
      const isLoose = Boolean(listBlock.payload.meta?.loose);
      if (!isLoose) {
        return { ok: false, message: "Inherited red: list with blank-line separated item not marked loose" };
      }
    }
  }

  return { ok: true };
}
