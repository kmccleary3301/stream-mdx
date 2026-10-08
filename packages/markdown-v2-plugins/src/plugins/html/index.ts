import { parser } from "@lezer/markdown";
import type { DocumentContext, DocumentPlugin } from "../document";

const HTML_BLOCK_NAMES: Record<string, true> = { HTMLBlock: true, CommentBlock: true, ProcessingInstructionBlock: true };

/** Retag only paragraphs that Lezer classifies as complete HTML blocks. */
export const HTMLBlockPlugin: DocumentPlugin = {
  name: "html-block",
  process(ctx: DocumentContext) {
    for (const block of ctx.blocks) {
      if (block.type !== "paragraph") continue;
      const nativeType = block.payload.meta?.lezerNodeType;
      const raw = block.payload.raw;
      const node = typeof nativeType === "string" ? null : parser.parse(raw).topNode.firstChild;
      if (typeof nativeType === "string" ? HTML_BLOCK_NAMES[nativeType] : node && HTML_BLOCK_NAMES[node.name] && node.to === raw.trimEnd().length) {
        block.type = "html";
        block.payload.meta = { ...(block.payload.meta || {}), needsSanitization: true };
        block.payload.inline = [];
      }
    }
    return undefined;
  },
};

