import type { SyntaxNode, Tree } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import {
  createNativeTableHeaderRecordFromMapping,
  freezeTableBlockSnapshot,
  generateBlockId,
  nativeTableParts,
  type AppendSourceDocument,
  type InlineParser,
  type NativeSourceMapping,
  type NativeSourceRange,
  type NodePath,
  type NodeSnapshot,
  type Patch,
  type SourceSnapshot,
  type TableBlockSnapshot,
} from "@stream-mdx/core";
import {
  nativeTableColumnCount,
  nativeTableRowsFromNode,
  type NativeTableExtensionContext,
} from "./native-table-row-classifier";
import { createNativeTableHeaderRecord } from "./native-table-projection";
import {
  RootTableSourceOwner,
  type RootTableSemanticChange,
  type RootTableSourceChange,
  type RootTableSourceOwnerCounters,
  type RootTableSourceOwnerState,
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

export interface NativeNestedTableOwnerOptions {
  readonly id: string;
  readonly containerId: string;
  readonly node: SyntaxNode;
  readonly source: AppendSourceDocument;
  readonly generation: number;
  readonly parser: MarkdownParser;
  readonly inlineParser: InlineParser;
  readonly mapping: NativeSourceMapping;
  readonly extensionContext: NativeTableExtensionContext;
  readonly state?: RootTableSourceOwnerState;
  readonly finalizing?: boolean;
  readonly actualInterruptFrom?: number;
  readonly counters?: RootTableSourceOwnerCounters;
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

function mappedNativeRange(mapping: NativeSourceMapping, from: number, to: number): NativeSourceRange {
  return mapping.mapRange?.(from, to) ?? { from: mapping.mapOffset(from), to: mapping.mapOffset(to) };
}


/** Admit a table already present in the owning parser's native container tree. */
export function createNativeNestedTableOwner(
  options: NativeNestedTableOwnerOptions,
): RootTableSourceOwner | undefined {
  if (options.node.type.name !== "Table") return undefined;
  const parts = nativeTableParts(options.node);
  if (!parts) return undefined;
  const source = options.source.snapshot();
  const tableRange = mappedNativeRange(options.mapping, options.node.from, options.node.to);
  const delimiterRange = mappedNativeRange(options.mapping, parts.delimiter.from, parts.delimiter.to);
  const finalizing = options.finalizing === true;
  const bodyFrom = delimiterLineBoundary(source, delimiterRange.to, finalizing);
  if (bodyFrom === undefined) return undefined;
  const state = options.state ?? (
    finalizing ? "finalized" : options.node.nextSibling || options.actualInterruptFrom !== undefined ? "closed" : "open"
  );
  const acceptedTo = delimiterLineBoundary(source, tableRange.to, true) ?? tableRange.to;
  if (acceptedTo < bodyFrom || acceptedTo > source.length) {
    throw new RangeError("Native nested table input must map inside the canonical source document");
  }
  const id = options.id;
  const initialCellAttempts = new Map<string, ReadonlySet<string>>();
  const header = createNativeTableHeaderRecordFromMapping(
    parts.header,
    parts.delimiter,
    id,
    options.mapping,
    options.inlineParser,
    (cellId, labels, sourceUnits) => {
      initialCellAttempts.set(cellId, new Set(labels));
      if (typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__) {
        options.counters?.recordInlineSourceUnits(sourceUnits, "engine");
      }
    },
  );
  const columnCount = Math.max(1, nativeTableColumnCount(parts.header));
  const owner = new RootTableSourceOwner({
    id,
    containerId: options.containerId,
    generation: options.generation,
    source: options.source,
    parser: options.parser,
    inlineParser: options.inlineParser,
    opening: {
      from: tableRange.from,
      bodyFrom,
      sourceRangeEnd: delimiterRange.to,
      header,
      columnCount,
      extensionContext: options.extensionContext,
    },
    initialCellAttempts,
    ...(typeof __STREAM_MDX_COUNTERS__ !== "undefined" && __STREAM_MDX_COUNTERS__ && options.counters
      ? { counters: options.counters }
      : {}),
  });
  const rows = nativeTableRowsFromNode(
    options.node,
    options.mapping.input,
    (from, to) => mappedNativeRange(options.mapping, from, to),
    state !== "open",
  );
  owner.admitNativeRows(bodyFrom, acceptedTo, rows, state, options.actualInterruptFrom);
  return owner;
}

function rootTableOwnerTarget(owner: RootTableSourceOwner): NodePath {
  return owner.containerId
    ? { blockId: owner.containerId, nodeId: owner.id }
    : { blockId: owner.id };
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
    const parts = nativeTableParts(table);
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
    at: rootTableOwnerTarget(owner),
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
    at: rootTableOwnerTarget(owner),
    tableOwnerId: change.tableOwnerId,
    generation: change.generation,
    expectedRevision: change.expectedRevision,
    revision: change.revision,
    updates: change.updates,
    ...(change.header ? { header: change.header } : {}),
    meta: { kind: "semantic" },
  };
}
