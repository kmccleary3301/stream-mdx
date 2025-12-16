import type { DocumentContext, DocumentPlugin } from "../document";

/**
 * HTML block detection plugin (Option B):
 * - If a paragraph appears to be HTML, retag it to 'html'.
 * - Conservative detection to minimize false positives.
 */
export const HTMLBlockPlugin: DocumentPlugin = {
  name: "html-block",
  process(ctx: DocumentContext) {
    for (const block of ctx.blocks) {
      if (block.type !== "paragraph") continue;
      const raw = block.payload.raw.trim();
      if (looksLikeHTMLBlock(raw)) {
        block.type = "html";
        block.payload.meta = { ...(block.payload.meta || {}), needsSanitization: true };
        block.payload.inline = [];
      }
    }
    return undefined;
  },
};

function looksLikeHTMLBlock(raw: string): boolean {
  if (!raw.startsWith("<")) return false;
  // Common HTML block starts: tags or comments
  if (/^<!--[\s\S]*-->$/.test(raw)) return true;
  // Basic tag structure, avoid matching angle brackets inside code by requiring closing '>'
  if (/^<\/?[A-Za-z][A-Za-z0-9\-]*(?:\s+[^>]*)?>[\s\S]*<\/(?:[A-Za-z][A-Za-z0-9\-]*)>$/m.test(raw)) return true;
  // Self-closing
  if (/^<\/?[A-Za-z][A-Za-z0-9\-]*(?:\s+[^>]*)?\/>$/.test(raw)) return true;
  return false;
}
