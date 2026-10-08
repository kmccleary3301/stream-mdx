import type { Block, HtmlTreeNode, InlineNode, NodeSnapshot, PreparedNestedSnapshot } from "@stream-mdx/core";
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
	        numberToLabel: new Map<number, string>(),
	        definitions: new Map<string, string>(), // raw content
	        definitionOrigins: new Map<string, number>(),
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
    assignNumbersFromReferencesInBlocks(ctx.blocks, state);

    // 3) Update inline nodes in blocks to include assigned numbers
    numberInlineReferences(ctx.blocks, state);

    // 4) Build synthetic footnotes block
    const items = buildFootnoteItems(state, ctx.blocks);
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
  numberToLabel: Map<number, string>;
  definitions: Map<string, string>; // raw definition content
  definitionOrigins: Map<string, number>;
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

function assignNumbersFromReferencesInBlocks(blocks: Block[], state: FootnoteState) {
  const reserveNumber = (label: string) => {
    if (state.labelToNumber.has(label)) return;
    const n = state.nextNumber++;
    state.labelToNumber.set(label, n);
    state.numberToLabel.set(n, label);
  };
  const scanInline = (nodes: InlineNode[]) => {
    for (const node of nodes) {
      if (node.kind === "footnote-ref") reserveNumber(node.label);
      if (hasInlineChildren(node)) scanInline(node.children);
    }
  };
  const refRe = /\[\^([A-Za-z0-9_-]+)\]/g;
  for (const block of blocks) {
    // Skip non-textual blocks
    if (block.type === "code" || block.type === "html" || block.type === "footnote-def") continue;
    const prepared = block.payload.meta?.preparedNested as PreparedNestedSnapshot | undefined;
    if (prepared) {
      visitPreparedInline(prepared.children, scanInline);
      continue;
    }
    const text = block.payload.raw;
    let m: RegExpExecArray | null = refRe.exec(text);
    while (m !== null) {
      const label = m[1];
      reserveNumber(label);
      m = refRe.exec(text);
    }
  }
}

function numberInlineReferences(blocks: Block[], state: FootnoteState) {
  const numberInlineNode = (node: InlineNode): InlineNode => {
    let result = node;
    if (hasInlineChildren(node)) {
      const children = mapChanged(node.children, numberInlineNode);
      if (children !== node.children) result = { ...node, children } as InlineNode;
    }
    if (result.kind !== "footnote-ref") return result;
    const number = state.labelToNumber.get(result.label);
    return result.number === number ? result : { ...result, number };
  };
  const applyNumbers = (inline: InlineNode[] | undefined): InlineNode[] | undefined =>
    inline ? mapChanged(inline, numberInlineNode) : inline;
  const numbered = new WeakMap<object, object>();
  const numberProps = (props: Record<string, unknown>): Record<string, unknown> => {
    const inline = Array.isArray(props.inline) ? applyNumbers(props.inline as InlineNode[]) : props.inline;
    const block = props.block ? numberBlock(props.block as Block) : props.block;
    if (inline === props.inline && block === props.block) return props;
    return { ...props, ...(inline !== props.inline ? { inline } : {}), ...(block !== props.block ? { block } : {}) };
  };
  const numberSnapshot = (snapshot: NodeSnapshot): NodeSnapshot => {
    const cached = numbered.get(snapshot) as NodeSnapshot | undefined;
    if (cached) return cached;
    const props = snapshot.props ? numberProps(snapshot.props) : snapshot.props;
    const meta = snapshot.meta ? numberMeta(snapshot.meta) : snapshot.meta;
    const children = snapshot.children ? mapChanged(snapshot.children, numberSnapshot) : snapshot.children;
    const result = props === snapshot.props && meta === snapshot.meta && children === snapshot.children
      ? snapshot : { ...snapshot, ...(props !== snapshot.props ? { props } : {}), ...(meta !== snapshot.meta ? { meta } : {}), ...(children !== snapshot.children ? { children } : {}) };
    numbered.set(snapshot, result);
    return result;
  };
  const numberHtmlNode = (node: HtmlTreeNode): HtmlTreeNode => {
    const cached = numbered.get(node) as HtmlTreeNode | undefined;
    if (cached) return cached;
    let result = node;
    if (node.kind === "text") {
      const inline = applyNumbers(node.inline);
      if (inline !== node.inline) result = { ...node, inline };
    } else if (node.kind === "element") {
      const children = mapChanged(node.children, numberHtmlNode);
      const inlineNode = node.inlineNode ? numberInlineNode(node.inlineNode) : node.inlineNode;
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
  const numberMeta = (meta: Record<string, unknown>): Record<string, unknown> => {
    const cached = numbered.get(meta) as Record<string, unknown> | undefined;
    if (cached) return cached;
    let result = meta;
    const set = (key: string, value: unknown) => {
      if (value === meta[key]) return;
      if (result === meta) result = { ...meta };
      result[key] = value;
    };
    if (Array.isArray(meta.mixedSegments)) {
      set("mixedSegments", mapChanged(meta.mixedSegments, (segment: unknown) => {
        if (!segment || typeof segment !== "object") return segment;
        const record = segment as Record<string, unknown>;
        if (!Array.isArray(record.inline)) return segment;
        const inline = applyNumbers(record.inline as InlineNode[]);
        return inline === record.inline ? segment : { ...record, inline };
      }));
    }
    for (const key of ["items", "header"]) {
      const cells = meta[key];
      if (Array.isArray(cells) && cells.every((cell) => Array.isArray(cell))) {
        set(key, mapChanged(cells as InlineNode[][], (cell) => applyNumbers(cell) ?? cell));
      }
    }
    if (Array.isArray(meta.rows) && meta.rows.every((row) => Array.isArray(row))) {
      set("rows", mapChanged(meta.rows as InlineNode[][][], (row) => mapChanged(row, (cell) => applyNumbers(cell) ?? cell)));
    }
    for (const key of ["htmlTree", "htmlParagraphTree"]) {
      const tree = meta[key];
      if (Array.isArray(tree)) set(key, mapChanged(tree as HtmlTreeNode[], numberHtmlNode));
    }
    const prepared = meta.preparedNested as PreparedNestedSnapshot | undefined;
    if (prepared) {
      const props = numberProps(prepared.props);
      const children = mapChanged(prepared.children, numberSnapshot);
      set("preparedNested", props === prepared.props && children === prepared.children ? prepared : { ...prepared, props, children });
    }
    numbered.set(meta, result);
    return result;
  };
  const numberBlock = (block: Block): Block => {
    const cached = numbered.get(block) as Block | undefined;
    if (cached) return cached;
    let inline = applyNumbers(block.payload.inline);
    const meta = block.payload.meta ? numberMeta(block.payload.meta) : block.payload.meta;
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
function mapChanged<T>(values: T[], map: (value: T) => T): T[] {
  let result: T[] | undefined;
  for (let index = 0; index < values.length; index++) {
    const value = map(values[index]);
    if (value === values[index]) continue;
    if (!result) result = values.slice();
    result[index] = value;
  }
  return result ?? values;
}

function hasInlineChildren(node: InlineNode): node is InlineNode & { children: InlineNode[] } {
  return Array.isArray((node as { children?: InlineNode[] }).children);
}

function buildFootnoteItems(state: FootnoteState, blocks: Block[]) {
  const items: Array<{ number: number; inlines: InlineNode[]; label: string }> = [];
  const numbers = Array.from(state.numberToLabel.keys()).sort((a, b) => a - b);
  for (const n of numbers) {
    const label = state.numberToLabel.get(n);
    if (!label) continue;
    const raw = state.definitions.get(label) || "";
    let inlines: InlineNode[];
    const inlineParser = state.inlineParser;
    if (inlineParser) {
      try {
        inlines = inlineParser.parse(raw);
      } catch {
        inlines = [{ kind: "text", text: raw }];
      }
    } else {
      inlines = [{ kind: "text", text: raw }];
    }
    items.push({ number: n, inlines, label });
  }
  return items;
}

export function registerFootnotesPlugin(registry: DocumentPluginRegistry) {
  registry.register(FootnotesPlugin);
}
