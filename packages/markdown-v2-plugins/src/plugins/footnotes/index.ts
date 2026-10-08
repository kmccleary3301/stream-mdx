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
	        nextNumber: 1,
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
  nextNumber: number;
  inlineParser?: InlineParserAdapter;
};

function collectDefinitionsFromBlocks(blocks: Block[], state: FootnoteState) {
  const defStartRe = /^\[\^([A-Za-z0-9_-]+)\]:[ \t]*(.*)$/;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "paragraph") continue;
    const lines = block.payload.raw.split("\n");
    if (lines.length === 0) continue;

    const first = lines[0];
    const m = first.match(defStartRe);
    if (!m) continue;

    const label = m[1];
    const firstText = m[2] || "";
    const parts: string[] = [firstText];

    // In-block continuation lines
    for (let k = 1; k < lines.length; k++) {
      const line = lines[k];
      if (line.trim() === "") {
        parts.push("");
      } else if (/^(?:\s{4}|\t).*/.test(line)) {
        parts.push(line.replace(/^\s{4}|^\t/, ""));
      } else {
        break;
      }
    }

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
        if (l.trim() === "") parts.push("");
        else parts.push(l.replace(/^\s{4}|^\t/, ""));
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

    const content = parts.join("\n").trim();
    const origin = block.payload.range?.from ?? 0;
    const previousOrigin = state.definitionOrigins.get(label);
    // Streaming-safe: allow the first definition to grow as text is appended, while still ignoring later duplicates.
    if (previousOrigin === undefined) {
      state.definitionOrigins.set(label, origin);
      state.definitions.set(label, content);
    } else if (previousOrigin === origin) {
      state.definitions.set(label, content);
    }

    // Retag the starting block
    block.type = "footnote-def";
    block.payload.inline = [];
    const blockFrom = block.payload.range?.from ?? 0;
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

function assignNumbersFromReferencesInBlocks(blocks: Block[], state: FootnoteState) {
  const scopes = new Map<string, FootnoteReferenceScope>();
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
          const number = state.nextNumber++;
          state.labelToNumber.set(node.label, number);
        }
        const occurrence = (state.referenceCounts.get(node.label) ?? 0) + 1;
        state.referenceCounts.set(node.label, occurrence);
        if (occurrence === 1 && state.definitions.has(node.label)) pendingDefinitions.push(node.label);
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
    const tree = block?.payload.meta?.htmlParagraphTree ?? block?.payload.meta?.htmlTree;
    if (Array.isArray(tree)) {
      scope.html = visitHtml(tree as HtmlTreeNode[], owners);
      return;
    }
    if (snapshot.type === "html") return;
    const children = snapshot.children ?? [];
    const segmented = children.some((child) => child.type === "list-item-text" || child.type === "paragraph-text");
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
    const tree = meta?.htmlParagraphTree ?? meta?.htmlTree;
    if (Array.isArray(tree)) {
      scope.html = visitHtml(tree as HtmlTreeNode[], owners);
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
  for (const block of blocks) visitBlock(block, []);
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
    scanInline(inline, [scopeFor(`footnote-definition:${label}`)]);
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
    for (const key of ["htmlTree", "htmlParagraphTree"]) {
      const tree = meta[key];
      if (Array.isArray(tree)) set(key, mapChanged(tree as HtmlTreeNode[], (node, index) => numberHtmlNode(node, scope?.html?.[index])));
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
  for (let index = 0; index < blocks.length; index++) blocks[index] = numberBlock(blocks[index]);
  for (const [label, inline] of state.definitionInlines) {
    state.definitionInlines.set(label, applyNumbers(inline, scopes.get(`footnote-definition:${label}`)) ?? inline);
  }
  return numbers;
}

/** Visit the inline nodes consumed by prepared child views, once and in source order. */
function visitPreparedInline(children: NodeSnapshot[], visit: (nodes: InlineNode[]) => void): void {
  for (const snapshot of children) {
    if (snapshot.type === "code" || snapshot.type === "html") continue;
    const nestedChildren = snapshot.children ?? [];
    const segmented = nestedChildren.some((child) => child.type === "list-item-text" || child.type === "paragraph-text");
    const block = snapshot.props?.block as Block | undefined;
    if (snapshot.type !== "list" && snapshot.type !== "blockquote" && !segmented) {
      const inline = snapshot.props?.inline ?? block?.payload.inline;
      if (Array.isArray(inline)) visit(inline as InlineNode[]);
    }
    visitPreparedInline(nestedChildren, visit);
  }
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
