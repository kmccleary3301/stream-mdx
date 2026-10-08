import { isNativeHtmlBlock } from "@stream-mdx/core";
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
      if (typeof nativeType === "string" ? HTML_BLOCK_NAMES[nativeType] : isNativeHtmlBlock(raw)) {
        block.type = "html";
        block.payload.meta = { ...(block.payload.meta || {}), needsSanitization: true };
        block.payload.inline = [];
      }
    }
    return undefined;
  },
};

