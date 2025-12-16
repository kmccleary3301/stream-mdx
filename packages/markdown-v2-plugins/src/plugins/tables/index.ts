import type { InlineNode } from "@stream-mdx/core";
import { generateBlockId } from "@stream-mdx/core";
import type { DocumentContext, DocumentPlugin } from "../document";

// GFM-style tables detection and retagging
// Parses a contiguous paragraph block into a structured table block
// Header | Header2
// ------ | :-----:
// cell1  | cell2

type Align = "left" | "center" | "right" | null;

export const TablesPlugin: DocumentPlugin = {
  name: "tables",
  process(ctx: DocumentContext) {
    const inlineParser = ctx.state.inlineParser;
    const fallbackParse = (text: string): InlineNode[] => [{ kind: "text", text }];
    const parseInline = inlineParser ? (text: string) => inlineParser.parse(text) : fallbackParse;
    for (const block of ctx.blocks) {
      if (block.type !== "paragraph") continue;
      const raw = block.payload.raw;
      const lines = raw.split("\n");
      if (lines.length < 2) continue;

      const table = parseGfmTable(lines);
      if (!table) continue;

      // Retag to table and populate meta
      const headerInlines = table.header?.map((cell) => parseInline(cell));
      const rowsInlines = table.rows.map((row) => row.map((cell) => parseInline(cell)));

      block.type = "table";
      block.payload.inline = [];
      block.payload.meta = {
        header: headerInlines, // InlineNode[][] (cells)
        rows: rowsInlines, // InlineNode[][][] (rows->cells)
        align: table.align,
      };
      // Make raw the exact slice of the table (trim extra lines)
      block.payload.raw = lines.slice(0, 1 + 1 + table.rows.length).join("\n");
      const from = block.payload.range?.from ?? 0;
      block.id = generateBlockId(`${from}:${block.type}`, block.type);
    }
    return undefined;
  },
};

function parseGfmTable(lines: string[]): { header?: string[]; align: Align[]; rows: string[][] } | null {
  // must have a header, a delimiter row, then 1+ rows (rows optional technically)
  const header = splitRow(lines[0]);
  if (!header) return null;
  const align = parseAlignRow(lines[1]);
  if (!align || align.length < header.length) return null;

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const row = splitRow(lines[i]);
    if (!row) break; // stop at first non-table line
    // Normalize length to header length
    while (row.length < header.length) row.push("");
    rows.push(row);
  }

  return { header, align: align.slice(0, header.length), rows };
}

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Must contain a pipe to be a table row
  if (!trimmed.includes("|")) return null;

  // Allow leading/trailing pipe but ignore when splitting
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

  return cells.length > 0 ? cells : null;
}

function parseAlignRow(line: string): Align[] | null {
  const cells = splitRow(line);
  if (!cells || cells.length === 0) return null;
  const aligns: Align[] = [];
  for (const cell of cells) {
    const m = cell.match(/^:?-{3,}:?$/);
    if (!m) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    aligns.push(left && right ? "center" : right ? "right" : left ? "left" : null);
  }
  return aligns;
}
