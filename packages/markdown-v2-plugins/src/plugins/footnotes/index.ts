import type { Block, InlineNode } from "@stream-mdx/core";
import { generateBlockId } from "@stream-mdx/core";
import { type DocumentPlugin, globalDocumentPluginRegistry } from "../document";

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
  const refRe = /\[\^([A-Za-z0-9_-]+)\]/g;
  for (const block of blocks) {
    // Skip non-textual blocks
    if (block.type === "code" || block.type === "html" || block.type === "footnote-def") continue;
    const text = block.payload.raw;
    let m: RegExpExecArray | null = refRe.exec(text);
    while (m !== null) {
      const label = m[1];
      if (!state.labelToNumber.has(label)) {
        const n = state.nextNumber++;
        state.labelToNumber.set(label, n);
        state.numberToLabel.set(n, label);
      }
      m = refRe.exec(text);
    }
  }
}

function numberInlineReferences(blocks: Block[], state: FootnoteState) {
  const applyNumbers = (inline: InlineNode[] | undefined): InlineNode[] | undefined => {
    if (!inline || inline.length === 0) return inline;
    return mapInline(inline, (node) => {
      if (node.kind === "footnote-ref") {
        const n = state.labelToNumber.get(node.label);
        return { ...node, number: n } as InlineNode;
      }
      return node;
    });
  };

  for (const block of blocks) {
    block.payload.inline = applyNumbers(block.payload.inline);

    const meta = block.payload.meta as Record<string, unknown> | undefined;
    if (!meta) continue;

    // Mixed content segments (paragraph/blockquote HTML+MDX splits).
    const mixedSegments = meta.mixedSegments;
    if (Array.isArray(mixedSegments)) {
      meta.mixedSegments = mixedSegments.map((segment) => {
        if (!segment || typeof segment !== "object") return segment;
        const seg = segment as Record<string, unknown>;
        const inline = seg.inline;
        if (!Array.isArray(inline)) return segment;
        const updated = applyNumbers(inline as InlineNode[]);
        return updated ? { ...seg, inline: updated } : segment;
      });
    }

    // List items (InlineNode[][]).
    const items = meta.items;
    if (Array.isArray(items) && items.every((item) => Array.isArray(item))) {
      meta.items = (items as InlineNode[][]).map((item) => applyNumbers(item) ?? item);
    }

    // GFM tables (header: InlineNode[][], rows: InlineNode[][][]).
    const header = meta.header;
    if (Array.isArray(header) && header.every((cell) => Array.isArray(cell))) {
      meta.header = (header as InlineNode[][]).map((cell) => applyNumbers(cell) ?? cell);
    }

    const rows = meta.rows;
    if (Array.isArray(rows) && rows.every((row) => Array.isArray(row))) {
      meta.rows = (rows as InlineNode[][][]).map((row) => row.map((cell) => applyNumbers(cell) ?? cell));
    }
  }
}

function mapInline(nodes: InlineNode[], f: (n: InlineNode) => InlineNode): InlineNode[] {
  return nodes.map((node) => {
    let mapped = node;
    if (hasInlineChildren(node)) {
      const children = mapInline(node.children, f);
      mapped = { ...node, children } as InlineNode;
    }
    return f(mapped);
  });
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

// Helper to register globally
export function registerFootnotesPlugin() {
  globalDocumentPluginRegistry.register(FootnotesPlugin);
}
