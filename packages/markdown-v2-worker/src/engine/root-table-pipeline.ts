import type { SyntaxNode, Tree } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import {
  freezeTableBlockSnapshot,
  generateBlockId,
  type AppendSourceDocument,
  type InlineParser,
  type NodeSnapshot,
  type Patch,
  type SourceSnapshot,
  type TableBlockSnapshot,
} from "@stream-mdx/core";
import {
  nativeTableColumnCount,
  type NativeTableExtensionContext,
} from "./native-table-row-classifier";
import { createNativeTableHeaderRecord } from "./native-table-projection";
import {
  RootTableSourceOwner,
  type RootTableSemanticChange,
  type RootTableSourceChange,
  type RootTableSourceOwnerCounters,
} from "./root-table-owner";

export interface RootTablePatchChange {
  readonly table: RootTableSourceChange["table"];
  readonly expectedRevision: number;
  readonly fromRow: number;
  readonly rows: RootTableSourceChange["rows"];
  readonly sourceAppend: string;
  /** Parser-only continuation for the mutable root tail; omitted from semantic patches. */
  readonly rootResumeFrom?: number;
}

function delimiterLineBoundary(source: SourceSnapshot, lineEnd: number, finalizing: boolean): number | undefined {
  let cursor = lineEnd;
  while (cursor < source.length) {
    const next = source.read(cursor, cursor + 1);
    if (next !== " " && next !== "\t") break;
    cursor += 1;
  }
  if (cursor >= source.length) return finalizing ? cursor : undefined;
  const ending = source.read(cursor, cursor + 1);
  if (ending === "\n") return cursor + 1;
  if (ending !== "\r") return undefined;
  if (cursor + 1 < source.length) {
    return source.read(cursor + 1, cursor + 2) === "\n" ? cursor + 2 : cursor + 1;
  }
  return finalizing ? cursor + 1 : undefined;
}

function tableParts(table: SyntaxNode): { header: SyntaxNode; delimiter: SyntaxNode } | undefined {
  let header: SyntaxNode | undefined;
  let delimiter: SyntaxNode | undefined;
  const cursor = table.cursor();
  if (!cursor.firstChild()) return undefined;
  do {
    if (cursor.type.name === "TableHeader") header = cursor.node;
    else if (cursor.type.name === "TableDelimiter") delimiter = cursor.node;
  } while (cursor.nextSibling());
  return header && delimiter ? { header, delimiter } : undefined;
}

/** Build owners only after native TableHeader/TableDelimiter admission and a stable delimiter terminator. */
export function createRootTableOwners(
  tree: Tree,
  source: AppendSourceDocument,
  generation: number,
  parser: MarkdownParser,
  inlineParser: InlineParser,
  extensionContext: NativeTableExtensionContext,
  sourceOffset = 0,
  finalizing = false,
  counters?: RootTableSourceOwnerCounters,
): readonly RootTableSourceOwner[] {
  const reader = source.snapshot();
  const owners: RootTableSourceOwner[] = [];
  const cursor = tree.cursor();
  if (!cursor.firstChild()) return owners;
  do {
    if (cursor.type.name !== "Table") continue;
    const table = cursor.node;
    const parts = tableParts(table);
    if (!parts) continue;
    const tableFrom = table.from + sourceOffset;
    const delimiterEnd = parts.delimiter.to + sourceOffset;
    const bodyFrom = delimiterLineBoundary(reader, delimiterEnd, finalizing);
    if (bodyFrom === undefined) continue;

    const columnCount = Math.max(1, nativeTableColumnCount(parts.header));
    const id = generateBlockId(`${tableFrom}:table`, "table");
    const initialCellAttempts = new Map<string, ReadonlySet<string>>();
    const header = createNativeTableHeaderRecord(
      parts.header,
      parts.delimiter,
      id,
      reader,
      sourceOffset,
      inlineParser,
      (cellId, labels, sourceUnits) => {
        initialCellAttempts.set(cellId, new Set(labels));
        if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
          counters?.recordInlineSourceUnits(sourceUnits, "engine");
        }
      },
    );
    const owner = new RootTableSourceOwner({
      id,
      generation,
      source,
      parser,
      inlineParser,
      opening: {
        from: tableFrom,
        bodyFrom,
        sourceRangeEnd: delimiterEnd,
        header,
        columnCount,
        extensionContext,
      },
      initialCellAttempts,
      ...(typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ ? { counters } : {}),
    });
    if (bodyFrom < source.length) owner.accept(bodyFrom, source.length);
    if (finalizing) owner.finalize();
    owners.push(owner);
  } while (cursor.nextSibling());
  return owners;
}

declare const __STREAM_MDX_COUNTERS__: boolean | undefined;
function publishedTableSnapshot(table: TableBlockSnapshot): TableBlockSnapshot {
  return table.state === "closed"
    ? freezeTableBlockSnapshot({ ...table, state: "finalized" })
    : table;
}

function publishedTableSource(
  table: RootTableSourceChange["table"],
): RootTableSourceChange["table"] {
  return table.state === "closed" ? Object.freeze({ ...table, state: "finalized" }) : table;
}


export function rootTableNodeSnapshot(owner: RootTableSourceOwner): NodeSnapshot {
  const table = publishedTableSnapshot(owner.createSnapshot());
  const block = owner.materializeBlock(false, table);
  return {
    id: owner.id,
    type: "table",
    props: { block },
    range: { ...table.sourceRange },
    children: [],
    table,
  };
}

export function rootTableAppendChange(
  source: SourceSnapshot,
  previous: RootTableSourceChange["table"],
  change: RootTableSourceChange,
): RootTablePatchChange {
  const sourceEnd = change.table.sourceRange.to;
  const sourceAppend = change.sourceAppend;
  if (change.table.sourceRange.from !== previous.sourceRange.from
    || sourceEnd < change.table.sourceRange.from) {
    throw new Error("Root table source range changed its authored start or became invalid");
  }
  if (sourceEnd >= previous.sourceRange.to) {
    if (sourceAppend !== source.read(previous.sourceRange.to, sourceEnd)
      || previous.sourceRange.to + sourceAppend.length !== sourceEnd) {
      throw new Error("Root table sourceAppend does not match its owned source frontier");
    }
  } else if (sourceAppend !== "") {
    throw new Error("Root table sourceAppend cannot include bytes for a retracted provisional tail");
  }
  const rootResumeFrom = change.rootResumeFrom;
  if (rootResumeFrom !== undefined
    && (change.table.state === "open"
      || !Number.isSafeInteger(rootResumeFrom)
      || rootResumeFrom < sourceEnd
      || rootResumeFrom > change.table.processedTo)) {
    throw new Error("Root table native remainder must resume after its owned prefix and within accepted source");
  }
  const patchChange = {
    table: change.table,
    expectedRevision: change.expectedRevision,
    fromRow: change.fromRow,
    rows: change.rows,
    sourceAppend,
  };
  return rootResumeFrom === undefined
    ? patchChange
    : { ...patchChange, rootResumeFrom };
}

export function rootTableAppendPatch(
  owner: RootTableSourceOwner,
  change: RootTablePatchChange,
): Extract<Patch, { op: "appendTableRows" }> {
  // Serialize semantic table state only; the resume coordinate controls native parsing, not the patch.
  return {
    op: "appendTableRows",
    at: { blockId: owner.id },
    table: publishedTableSource(change.table),
    expectedRevision: change.expectedRevision,
    fromRow: change.fromRow,
    rows: change.rows,
    sourceAppend: change.sourceAppend,
    meta: { kind: "semantic" },
  };
}

export function rootTableSemanticPatch(
  owner: RootTableSourceOwner,
  change: RootTableSemanticChange | null,
): Extract<Patch, { op: "updateTableRows" }> | null {
  if (!change) return null;
  return {
    op: "updateTableRows",
    at: { blockId: owner.id },
    tableOwnerId: change.tableOwnerId,
    generation: change.generation,
    expectedRevision: change.expectedRevision,
    revision: change.revision,
    updates: change.updates,
    ...(change.header ? { header: change.header } : {}),
    meta: { kind: "semantic" },
  };
}
