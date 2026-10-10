import type { DocumentContext, DocumentPlugin } from "../document";

// GFM-style tables detection and retagging
// Parses a contiguous paragraph block into a structured table block
// Header | Header2
// ------ | :-----:
// cell1  | cell2

type Align = "left" | "center" | "right" | null;

export const TablesPlugin: DocumentPlugin = {
  name: "tables",
  process(_ctx: DocumentContext) {
    return undefined;
  },
};

function parseGfmTable(
  lines: string[],
  options: { finalized?: boolean } = {},
): { header?: string[]; align: Align[]; rows: string[][] } | null {
  // must have a header, a delimiter row, then 1+ rows (rows optional technically)
  const header = splitRow(lines[0]);
  if (!header) return null;
  const align = parseAlignRow(lines[1]);
  if (!align || align.length !== header.length) return null;

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const row = splitRow(lines[i]);
    if (!row) break; // stop at first non-table line
    if (row.length < header.length) {
      if (!options.finalized && i === lines.length - 1) {
        break;
      }
      while (row.length < header.length) row.push("");
    } else if (row.length > header.length) {
      row.length = header.length;
    }
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
