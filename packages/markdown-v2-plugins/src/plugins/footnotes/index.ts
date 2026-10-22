import type { Block, FootnoteItem, HtmlTreeNode, InlineNode, NodeSnapshot, PreparedNestedSnapshot } from "@stream-mdx/core";
import { generateBlockId } from "@stream-mdx/core";
import type { DocumentPlugin, DocumentPluginRegistry } from "../document";

/**
 * Footnotes document plugin
 * - Detects footnote definitions of the form:  [^label]: text... (with indented continuations)
 * - Detects inline refs of the form: [^label]
 * - Assigns numbers by first reference order (stable across updates)
 * - Retags definition paragraphs as 'footnote-def' (hidden)
 * - Appends a final 'footnotes' block with an ordered list of items
 */
export const FootnotesPlugin: DocumentPlugin = {
  name: "footnotes",

	  onBegin(ctx) {
	    if (!ctx.state.footnotes) {
	      const initialState: FootnoteState = {
	        labelToNumber: new Map<string, number>(),
	        definitions: new Map<string, string>(), // raw content
	        definitionOrigins: new Map<string, number>(),
	        referenceCounts: new Map<string, number>(),
	        definitionInlines: new Map<string, InlineNode[]>(),
	        inlineParser: ctx.state.inlineParser,
	      };
	      ctx.state.footnotes = initialState;
	    } else {
      const existing = ctx.state.footnotes as FootnoteState;
      if (!existing.inlineParser && ctx.state.inlineParser) {
        existing.inlineParser = ctx.state.inlineParser;
      }
    }
  },

  process(ctx) {
    const state = ctx.state.footnotes as FootnoteState;

    // 1) Collect definitions from blocks and retag definition blocks
    collectDefinitionsFromBlocks(ctx.blocks, state);

    // 2) Assign numbers based on first reference order (scan content)
    const scopes = assignNumbersFromReferencesInBlocks(ctx.blocks, state);

    // 3) Update inline nodes in blocks to include assigned numbers
    const numbers = numberInlineReferences(ctx.blocks, state, scopes);

    // 4) Build synthetic footnotes block
    const items = buildFootnoteItems(state, numbers);
    const rawSignature = JSON.stringify(items.map((it) => ({ n: it.number, l: it.label })));
    const id = generateBlockId(`FOOTNOTES:${rawSignature}`, "footnotes");

    const footnotesBlock: Block = {
      id,
      type: "footnotes",
      isFinalized: true, // can be treated as finalized except when tail updates
      payload: {
        raw: "", // not used by renderer
        meta: { items },
      },
    };

    return { syntheticBlocks: items.length > 0 ? [footnotesBlock] : [] };
  },
};

type InlineParserAdapter = { parse: (input: string) => InlineNode[] };

type FootnoteState = {
  labelToNumber: Map<string, number>;
  definitions: Map<string, string>; // raw definition content
  definitionOrigins: Map<string, number>;
  referenceCounts: Map<string, number>;
  definitionInlines: Map<string, InlineNode[]>;
  inlineParser?: InlineParserAdapter;
};

function collectDefinitionsFromBlocks(blocks: Block[], state: FootnoteState) {
  const defStartRe = /^\[\^([A-Za-z0-9_-]+)\]:[ \t]*(.*)$/;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "paragraph") continue;
    // Definitions start the paragraph; reject the common case before splitting the whole raw into lines.
    if (!block.payload.raw.startsWith("[^")) continue;
    const lines = block.payload.raw.split("\n");
    if (!defStartRe.test(lines[0])) continue;

    // Every `[^label]:` line starts a definition (GFM allows consecutive definitions without blank lines);
    // other lines continue the current one, indented or lazily.
    const blockFrom = block.payload.range?.from ?? 0;
    const definitions: Array<{ label: string; origin: number; parts: string[] }> = [];
    let lineOffset = 0;
    for (const line of lines) {
      const m = line.match(defStartRe);
      if (m) {
        definitions.push({ label: m[1], origin: blockFrom + lineOffset, parts: [m[2] || ""] });
      } else {
        const current = definitions[definitions.length - 1];
        current.parts.push(line.trim() === "" ? "" : line.replace(/^\s{4}|^\t/, ""));
      }
      lineOffset += line.length + 1;
    }
    const last = definitions[definitions.length - 1];

    // Cross-paragraph continuation: subsequent paragraphs fully indented (or blank)
    let j = i + 1;
    while (j < blocks.length) {
      const b = blocks[j];
      if (b.type !== "paragraph") break;
      const blines = b.payload.raw.split("\n");
      // Check all non-empty lines are indented
      const allIndented = blines.filter((l) => l.trim() !== "").every((l) => /^(?:\s{4}|\t).*/.test(l));
      if (!allIndented && blines.some((l) => l.trim() !== "")) break;
      // Append stripped content (preserve blank lines)
      for (const l of blines) {
        if (l.trim() === "") last.parts.push("");
        else last.parts.push(l.replace(/^\s{4}|^\t/, ""));
      }
      // Retag the absorbed paragraph
      b.type = "footnote-def";
      b.payload.inline = [];
      const bFrom = b.payload.range?.from ?? 0;
      b.id = generateBlockId(`${bFrom}:${b.type}`, b.type);
      j++;
    }
    // Move outer index to last consumed paragraph - 1 (for loop increments)
    i = j - 1;

    for (const definition of definitions) {
      const content = definition.parts.join("\n").trim();
      const previousOrigin = state.definitionOrigins.get(definition.label);
      // Streaming-safe: allow the first definition to grow as text is appended, while still ignoring later duplicates.
      if (previousOrigin === undefined) {
        state.definitionOrigins.set(definition.label, definition.origin);
        state.definitions.set(definition.label, content);
      } else if (previousOrigin === definition.origin) {
        state.definitions.set(definition.label, content);
      }
    }
    // Retag the starting block
    block.type = "footnote-def";
    block.payload.inline = [];
    block.id = generateBlockId(`${blockFrom}:${block.type}`, block.type);
  }
}

interface FootnoteReferenceScope {
  references: Map<string, number[]>;
  items?: FootnoteReferenceScope[];
  header?: FootnoteReferenceScope[];
  rows?: FootnoteReferenceScope[][];
  segments?: FootnoteReferenceScope[];
  html?: FootnoteReferenceScope[];
}

function getActiveHtmlTreeKey(
  meta: Record<string, unknown> | undefined,
): "trustedMdxNativeChildren" | "htmlTree" | "htmlParagraphTree" | undefined {
  if (Array.isArray(meta?.trustedMdxNativeChildren)) return "trustedMdxNativeChildren";
  if (meta?.htmlOwnership === true && Array.isArray(meta.htmlTree)) return "htmlTree";
  if (Array.isArray(meta?.htmlParagraphTree)) return "htmlParagraphTree";
  if (Array.isArray(meta?.htmlTree)) return "htmlTree";
}

function snapshotHtmlTree(snapshot: NodeSnapshot): HtmlTreeNode[] | undefined {
  const props = snapshot.props;
  const propsKey = getActiveHtmlTreeKey(props);
  if (propsKey) return props?.[propsKey] as HtmlTreeNode[];
  const meta = (props?.block as Block | undefined)?.payload.meta;
  const key = getActiveHtmlTreeKey(meta);
  return key ? meta?.[key] as HtmlTreeNode[] : undefined;
}

function assignNumbersFromReferencesInBlocks(blocks: Block[], state: FootnoteState) {
  const scopes = new Map<string, FootnoteReferenceScope>();
  state.labelToNumber.clear();
  state.referenceCounts.clear();
  state.definitionInlines.clear();
  const pendingDefinitions: string[] = [];
  const scopeFor = (id: string) => {
    let scope = scopes.get(id);
    if (!scope) {
      scope = { references: new Map() };
      scopes.set(id, scope);
    }
    return scope;
  };
  const scanInline = (nodes: InlineNode[], parents: FootnoteReferenceScope[]) => {
    for (const node of nodes) {
      if (node.kind === "footnote-ref") {
        if (!state.labelToNumber.has(node.label)) {
          state.labelToNumber.set(node.label, state.labelToNumber.size + 1);
        }
        const occurrence = (state.referenceCounts.get(node.label) ?? 0) + 1;
        state.referenceCounts.set(node.label, occurrence);
        if (occurrence === 1 && state.definitions.has(node.label) && !state.definitionInlines.has(node.label)) pendingDefinitions.push(node.label);
        for (const scope of parents) {
          const occurrences = scope.references.get(node.label);
          if (occurrences) occurrences.push(occurrence);
          else scope.references.set(node.label, [occurrence]);
        }
      }
      if (hasInlineChildren(node)) scanInline(node.children, parents);
    }
  };
  const visitHtml = (tree: HtmlTreeNode[], parents: FootnoteReferenceScope[]): FootnoteReferenceScope[] => tree.map((node) => {
    const scope: FootnoteReferenceScope = { references: new Map() };
    const owners = [...parents, scope];
    if (node.kind === "text") {
      if (node.inline) scanInline(node.inline, owners);
    } else if (node.kind === "element") {
      // The HAST children own the rendered children; inlineNode.children is a shadow.
      if (node.inlineNode?.kind === "footnote-ref") scanInline([node.inlineNode], owners);
      scope.html = visitHtml(node.children, owners);
    } else if (node.kind === "component") {
      scope.html = visitHtml(node.children, owners);
    } else {
      visitBlock(node.block, owners);
    }
    return scope;
  });
  const visitSnapshot = (snapshot: NodeSnapshot, parents: FootnoteReferenceScope[]): void => {
    if (snapshot.type === "code" || snapshot.type === "footnote-def") return;
    const scope = scopeFor(snapshot.id);
    const owners = parents.includes(scope) ? parents : [...parents, scope];
    const block = snapshot.props?.block as Block | undefined;
    const tree = snapshotHtmlTree(snapshot);
    if (Array.isArray(tree)) {
      scope.html = visitHtml(tree, owners);
      return;
    }
    if (snapshot.type === "html") return;
    const children = snapshot.children ?? [];
    const segmented = children.some((child) => child.type.startsWith("list-item-") || child.type.startsWith("paragraph-"));
    if (snapshot.type !== "list" && snapshot.type !== "blockquote" && !segmented) {
      const inline = snapshot.props?.inline ?? block?.payload.inline;
      if (Array.isArray(inline)) scanInline(inline as InlineNode[], owners);
    }
    for (const child of children) visitSnapshot(child, owners);
    if (snapshot.type === "list") scope.items = children.map((child) => scopeFor(child.id));
    if (segmented) scope.segments = children.map((child) => scopeFor(child.id));
    if (snapshot.type === "table") {
      scope.header = children.find((child) => child.type === "table-header")?.children?.map((cell) => scopeFor(cell.id));
      scope.rows = children.find((child) => child.type === "table-body")?.children?.map((row) => (row.children ?? []).map((cell) => scopeFor(cell.id)));
    }
  };
  const visitBlock = (block: Block, parents: FootnoteReferenceScope[]): void => {
    if (block.type === "code" || block.type === "footnote-def" || block.type === "footnotes") return;
    const scope = scopeFor(block.id);
    const owners = parents.includes(scope) ? parents : [...parents, scope];
    const meta = block.payload.meta;
    const treeKey = getActiveHtmlTreeKey(meta);
    const tree = treeKey ? (meta?.[treeKey] as HtmlTreeNode[] | undefined) : undefined;
    if (Array.isArray(tree)) {
      scope.html = visitHtml(tree, owners);
      return;
    }
    const prepared = meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (prepared) {
      for (const child of prepared.children) visitSnapshot(child, owners);
      if (block.type === "list") scope.items = prepared.children.map((child) => scopeFor(child.id));
    } else if (block.type === "table") {
      const header = Array.isArray(meta?.header) ? meta.header as InlineNode[][] : [];
      const rows = Array.isArray(meta?.rows) ? meta.rows as InlineNode[][][] : [];
      scope.header = header.map((cell, index) => {
        const cellScope = scopeFor(`${block.id}::th:${index}`);
        scanInline(cell, [...owners, cellScope]);
        return cellScope;
      });
      scope.rows = rows.map((row, rowIndex) => row.map((cell, index) => {
        const cellScope = scopeFor(`${block.id}::td:${rowIndex}:${index}`);
        scanInline(cell, [...owners, cellScope]);
        return cellScope;
      }));
    } else if (Array.isArray(meta?.mixedSegments)) {
      scope.segments = meta.mixedSegments.map((segment: { inline?: InlineNode[] }, index) => {
        const segmentScope = scopeFor(`${block.id}::segment:${index}`);
        if (segment.inline) scanInline(segment.inline, [...owners, segmentScope]);
        return segmentScope;
      });
    } else if (block.type !== "html" && block.payload.inline) {
      scanInline(block.payload.inline, owners);
    }
  };
  for (const block of blocks) {
    if (mayReferenceFootnotes(block)) visitBlock(block, []);
  }
  const queuedDefinitions = new Set(pendingDefinitions);
  const discoverDefinitions = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "footnote-ref" && state.definitions.has(node.label) && !queuedDefinitions.has(node.label)) {
        queuedDefinitions.add(node.label);
        pendingDefinitions.push(node.label);
      }
      if (hasInlineChildren(node)) discoverDefinitions(node.children);
    }
  };
  for (let index = 0; index < pendingDefinitions.length; index++) {
    const label = pendingDefinitions[index];
    const raw = state.definitions.get(label) ?? "";
    let inline: InlineNode[];
    try {
      inline = state.inlineParser?.parse(raw) ?? [{ kind: "text", text: raw }];
    } catch {
      inline = [{ kind: "text", text: raw }];
    }
    state.definitionInlines.set(label, inline);
    discoverDefinitions(inline);
  }
  // Count bodies in the current canonical footer order, not definition discovery order.
  for (const label of state.labelToNumber.keys()) {
    const inline = state.definitionInlines.get(label);
    if (inline) scanInline(inline, [scopeFor(`footnote-definition:${label}`)]);
  }
  return scopes;
}

function numberInlineReferences(blocks: Block[], state: FootnoteState, scopes: Map<string, FootnoteReferenceScope>): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const label of state.labelToNumber.keys()) {
    if (state.definitions.has(label) && (state.referenceCounts.get(label) ?? 0) > 0) numbers.set(label, numbers.size + 1);
  }
  const definitionsPublished = blocks.length === 0 || blocks[blocks.length - 1].isFinalized;
  const numberInlineNode = (node: InlineNode, scope: FootnoteReferenceScope, positions: Map<string, number>): InlineNode => {
    let result = node;
    if (hasInlineChildren(node)) {
      const children = mapChanged(node.children, (child) => numberInlineNode(child, scope, positions));
      if (children !== node.children) result = { ...node, children } as InlineNode;
    }
    if (result.kind !== "footnote-ref") return result;
    const position = positions.get(result.label) ?? 0;
    positions.set(result.label, position + 1);
    const occurrence = scope.references.get(result.label)?.[position];
    const number = numbers.get(result.label) ?? state.labelToNumber.get(result.label);
    const defined = definitionsPublished && state.definitions.has(result.label) && occurrence !== undefined;
    if (result.number === number && result.occurrence === occurrence && result.defined === defined) return result;
    const updated = { ...result, defined };
    if (number === undefined) delete updated.number;
    else updated.number = number;
    if (occurrence === undefined) delete updated.occurrence;
    else updated.occurrence = occurrence;
    return updated;
  };
  const applyNumbers = (inline: InlineNode[] | undefined, scope: FootnoteReferenceScope | undefined): InlineNode[] | undefined => {
    if (!inline || !scope?.references.size) return inline;
    const positions = new Map<string, number>();
    return mapChanged(inline, (node) => numberInlineNode(node, scope, positions));
  };
  const numbered = new WeakMap<object, object>();
  const numberProps = (props: Record<string, unknown>, scope: FootnoteReferenceScope | undefined): Record<string, unknown> => {
    const fields = numberMeta(props, scope);
    const inline = Array.isArray(props.inline) ? applyNumbers(props.inline as InlineNode[], scope) : props.inline;
    const block = props.block ? numberBlock(props.block as Block) : props.block;
    if (fields === props && inline === props.inline && block === props.block) return props;
    return { ...fields, ...(inline !== props.inline ? { inline } : {}), ...(block !== props.block ? { block } : {}) };
  };
  const numberSnapshot = (snapshot: NodeSnapshot, parentScope?: FootnoteReferenceScope): NodeSnapshot => {
    const cached = numbered.get(snapshot) as NodeSnapshot | undefined;
    if (cached) return cached;
    const scope = scopes.get(snapshot.id) ?? parentScope;
    const props = snapshot.props ? numberProps(snapshot.props, scope) : snapshot.props;
    const meta = snapshot.meta ? numberMeta(snapshot.meta, scope) : snapshot.meta;
    const children = snapshot.children ? mapChanged(snapshot.children, (child, index) => numberSnapshot(child, scope?.segments?.[index] ?? scope)) : snapshot.children;
    const result = props === snapshot.props && meta === snapshot.meta && children === snapshot.children
      ? snapshot : { ...snapshot, ...(props !== snapshot.props ? { props } : {}), ...(meta !== snapshot.meta ? { meta } : {}), ...(children !== snapshot.children ? { children } : {}) };
    numbered.set(snapshot, result);
    return result;
  };
  const numberHtmlNode = (node: HtmlTreeNode, scope: FootnoteReferenceScope | undefined): HtmlTreeNode => {
    const cached = numbered.get(node) as HtmlTreeNode | undefined;
    if (cached) return cached;
    let result = node;
    if (node.kind === "text") {
      const inline = applyNumbers(node.inline, scope);
      if (inline !== node.inline) result = { ...node, inline };
    } else if (node.kind === "element") {
      const children = mapChanged(node.children, (child, index) => numberHtmlNode(child, scope?.html?.[index]));
      const inlineNode = node.inlineNode && scope?.references.size ? numberInlineNode(node.inlineNode, scope, new Map()) : node.inlineNode;
      if (children !== node.children || inlineNode !== node.inlineNode) {
        result = { ...node, children, ...(inlineNode !== node.inlineNode ? { inlineNode } : {}) };
      }
    } else if (node.kind === "component") {
      const children = mapChanged(node.children, (child, index) => numberHtmlNode(child, scope?.html?.[index]));
      if (children !== node.children) result = { ...node, children };
    } else {
      const block = numberBlock(node.block);
      if (block !== node.block) result = { ...node, block };
    }
    numbered.set(node, result);
    return result;
  };
  const numberMeta = (meta: Record<string, unknown>, scope: FootnoteReferenceScope | undefined): Record<string, unknown> => {
    const cached = numbered.get(meta) as Record<string, unknown> | undefined;
    if (cached) return cached;
    let result = meta;
    const set = (key: string, value: unknown) => {
      if (value === meta[key]) return;
      if (result === meta) result = { ...meta };
      result[key] = value;
    };
    if (Array.isArray(meta.mixedSegments)) {
      set("mixedSegments", mapChanged(meta.mixedSegments, (segment: unknown, index) => {
        if (!segment || typeof segment !== "object") return segment;
        const record = segment as Record<string, unknown>;
        if (!Array.isArray(record.inline)) return segment;
        const inline = applyNumbers(record.inline as InlineNode[], scope?.segments?.[index] ?? scope);
        return inline === record.inline ? segment : { ...record, inline };
      }));
    }
    for (const key of ["items", "header"]) {
      const cells = meta[key];
      if (Array.isArray(cells) && cells.every((cell) => Array.isArray(cell))) {
        const cellsScopes = key === "items" ? scope?.items : scope?.header;
        set(key, mapChanged(cells as InlineNode[][], (cell, index) => applyNumbers(cell, cellsScopes?.[index] ?? scope) ?? cell));
      }
    }
    if (Array.isArray(meta.rows) && meta.rows.every((row) => Array.isArray(row))) {
      set("rows", mapChanged(meta.rows as InlineNode[][][], (row, rowIndex) => mapChanged(row, (cell, index) => applyNumbers(cell, scope?.rows?.[rowIndex]?.[index] ?? scope) ?? cell)));
    }
    const treeKey = getActiveHtmlTreeKey(meta);
    if (treeKey) {
      const tree = meta[treeKey];
      if (Array.isArray(tree)) set(treeKey, mapChanged(tree as HtmlTreeNode[], (node, index) => numberHtmlNode(node, scope?.html?.[index])));
    }
    const prepared = meta.preparedNested as PreparedNestedSnapshot | undefined;
    if (prepared) {
      const props = numberProps(prepared.props, scope);
      const children = mapChanged(prepared.children, (child) => numberSnapshot(child, scope));
      set("preparedNested", props === prepared.props && children === prepared.children ? prepared : { ...prepared, props, children });
    }
    numbered.set(meta, result);
    return result;
  };
  const numberBlock = (block: Block): Block => {
    const cached = numbered.get(block) as Block | undefined;
    if (cached) return cached;
    const scope = scopes.get(block.id);
    let inline = applyNumbers(block.payload.inline, scope);
    const meta = block.payload.meta ? numberMeta(block.payload.meta, scope) : block.payload.meta;
    const prepared = meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (block.type === "blockquote" && prepared && (meta !== block.payload.meta || !inline)) {
      const collected: InlineNode[] = [];
      visitPreparedInline(prepared.children, (nodes) => collected.push(...nodes));
      inline = collected;
    }
    const result = inline === block.payload.inline && meta === block.payload.meta
      ? block : { ...block, payload: { ...block.payload, ...(inline !== block.payload.inline ? { inline } : {}), ...(meta !== block.payload.meta ? { meta } : {}) } };
    numbered.set(block, result);
    return result;
  };
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (mayReferenceFootnotes(block) || mayContainBlockquote(block)) blocks[index] = numberBlock(block);
  }
  for (const [label, inline] of state.definitionInlines) {
    state.definitionInlines.set(label, applyNumbers(inline, scopes.get(`footnote-definition:${label}`)) ?? inline);
  }
  return numbers;
}

/** Visit the inline nodes consumed by prepared child views, once and in source order. */
function visitPreparedInline(children: NodeSnapshot[], visit: (nodes: InlineNode[]) => void): void {
  const visitBlock = (block: Block): void => {
    if (block.type === "code" || block.type === "footnote-def" || block.type === "footnotes") return;
    const meta = block.payload.meta;
    const treeKey = getActiveHtmlTreeKey(meta);
    const tree = treeKey ? (meta?.[treeKey] as HtmlTreeNode[] | undefined) : undefined;
    if (Array.isArray(tree)) {
      visitHtml(tree);
      return;
    }
    const prepared = meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (prepared) visitPreparedInline(prepared.children, visit);
    else if (block.type === "table") {
      for (const cell of (meta?.header as InlineNode[][] | undefined) ?? []) visit(cell);
      for (const row of (meta?.rows as InlineNode[][][] | undefined) ?? []) for (const cell of row) visit(cell);
    } else if (Array.isArray(meta?.mixedSegments)) {
      for (const segment of meta.mixedSegments as { inline?: InlineNode[] }[]) if (segment.inline) visit(segment.inline);
    } else if (block.type !== "html" && block.payload.inline) visit(block.payload.inline);
  };
  const visitHtml = (tree: HtmlTreeNode[]): void => {
    for (const node of tree) {
      if (node.kind === "block") visitBlock(node.block);
      else if (node.kind === "text") {
        if (node.inline) visit(node.inline);
      } else if (node.kind === "component") {
        visitHtml(node.children);
      } else if (node.kind === "element" && !["code", "pre", "textarea"].includes(node.tagName.toLowerCase())) {
        if (node.inlineNode?.kind === "footnote-ref") visit([node.inlineNode]);
        visitHtml(node.children);
      }
    }
  };
  for (const snapshot of children) {
    if (snapshot.type === "code" || snapshot.type === "footnote-def") continue;
    const nestedChildren = snapshot.children ?? [];
    const segmented = nestedChildren.some((child) => child.type.startsWith("list-item-") || child.type.startsWith("paragraph-"));
    const block = snapshot.props?.block as Block | undefined;
    const tree = snapshotHtmlTree(snapshot);
    if (Array.isArray(tree)) {
      visitHtml(tree);
      continue;
    }
    if (snapshot.type === "html") {
      if (block) visitBlock(block);
      continue;
    }
    if (snapshot.type !== "list" && snapshot.type !== "blockquote" && !segmented) {
      const inline = snapshot.props?.inline ?? block?.payload.inline;
      if (Array.isArray(inline)) visit(inline as InlineNode[]);
    }
    visitPreparedInline(nestedChildren, visit);
  }
}

/**
 * Footnote-ref inline nodes are only parsed from literal `[^label]` text, and every nested view of a block
 * (prepared children, table cells, segments, HTML ownership trees) is parsed from its own raw. Container
 * marker stripping cannot join `[` and `^`; only HTML entity decoding (`&#91;^1]`) can, which needs `&`.
 * A block whose raw contains neither cannot change numbering state or be renumbered, so whole-document
 * passes skip it.
 */
function mayReferenceFootnotes(block: Block): boolean {
  const raw = block.payload.raw;
  return raw.includes("[^") || raw.includes("&");
}

/**
 * `numberBlock` also rebuilds the missing `inline` of every prepared blockquote it reaches, references or not,
 * including blockquotes nested in lists or HTML ownership trees. Any blockquote's source starts with `>`, and a
 * container's raw includes its nested blocks' source, so a block without `>` holds no blockquote.
 */
function mayContainBlockquote(block: Block): boolean {
  return block.payload.raw.includes(">");
}

/** Copy only a changed array, leaving unrelated prepared code/HTML artifacts shared. */
function mapChanged<T>(values: T[], map: (value: T, index: number) => T): T[] {
  let result: T[] | undefined;
  for (let index = 0; index < values.length; index++) {
    const value = map(values[index], index);
    if (value === values[index]) continue;
    if (!result) result = values.slice();
    result[index] = value;
  }
  return result ?? values;
}

function hasInlineChildren(node: InlineNode): node is InlineNode & { children: InlineNode[] } {
  return Array.isArray((node as { children?: InlineNode[] }).children);
}

function buildFootnoteItems(state: FootnoteState, numbers: Map<string, number>): FootnoteItem[] {
  const items: FootnoteItem[] = [];
  for (const [label, number] of numbers) {
    const refCount = state.referenceCounts.get(label) ?? 0;
    const inlines = state.definitionInlines.get(label) ?? [];
    items.push({ number, inlines, label, refCount });
  }
  return items;
}

export function registerFootnotesPlugin(registry: DocumentPluginRegistry) {
  registry.register(FootnotesPlugin);
}
