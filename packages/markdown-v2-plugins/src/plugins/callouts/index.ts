import { generateBlockId, normalizeBlockquoteText } from "@stream-mdx/core";
import type { CalloutKind } from "@stream-mdx/core";
import type { DocumentPlugin } from "../document";

// Simple callouts plugin retagging paragraphs starting with [!TYPE]
// Supported types: NOTE, TIP, IMPORTANT, WARNING, CAUTION

const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;
const GITHUB_ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i;

export const CalloutsPlugin: DocumentPlugin = {
  name: "callouts",
  onBegin(ctx) {
    // no-op
  },
  process(ctx) {
    if (ctx.state.callouts === "github-alerts") {
      const inlineParser = ctx.state.inlineParser;
      for (const block of ctx.blocks) {
        if (block.type !== "blockquote") continue;
        const range = block.payload.range;
        const sourceRaw = range ? ctx.source.read(range.from, range.to) : block.payload.raw;
        const quote = normalizeBlockquoteText(sourceRaw);
        const match = GITHUB_ALERT_MARKER.exec(quote);
        if (!match?.[1]) continue;

        const body = quote.slice(match[0].length);
        const calloutKind = match[1].toLowerCase() as CalloutKind;
        block.type = "callout";
        block.payload.raw = body;
        block.payload.inline = inlineParser ? inlineParser.parse(body) : [{ kind: "text", text: body }];
        block.payload.meta = {
          ...(block.payload.meta || {}),
          kind: match[1].toUpperCase(),
          calloutKind,
        };
        const from = block.payload.range?.from ?? 0;
        block.id = generateBlockId(`${from}:${block.type}`, block.type);
      }
      return undefined;
    }

    const inlineParser = ctx.state.inlineParser;
    for (const block of ctx.blocks) {
      if (block.type !== "paragraph") continue;
      const raw = block.payload.raw;
      const m = raw.match(CALLOUT_RE);
      if (!m) continue;
      const kind = m[1];
      const body = raw.replace(CALLOUT_RE, "");
      block.type = "callout";
      block.payload.meta = { ...(block.payload.meta || {}), kind };
      // Reparse inline without the marker
      try {
        block.payload.inline = inlineParser ? inlineParser.parse(body) : [{ kind: "text", text: body }];
        // Update raw to body for consistency in rendering and hashing stability downstream
        block.payload.raw = body;
      } catch {
        block.payload.inline = [{ kind: "text", text: body }];
      }
      const from = block.payload.range?.from ?? 0;
      block.id = generateBlockId(`${from}:${block.type}`, block.type);
    }
    return undefined;
  },
};
