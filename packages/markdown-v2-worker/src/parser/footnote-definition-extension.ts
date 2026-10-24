import type { MarkdownConfig } from "@lezer/markdown";

/** Footnote definition start recognized by the footnotes plugin. */
export const FOOTNOTE_DEFINITION_START = /^\[\^[A-Za-z0-9_-]+\]:/;

/**
 * GFM lets a footnote definition interrupt a paragraph (micromark-extension-gfm-footnote), unlike the link
 * reference definition Lezer parses it as. This only ends the preceding leaf; the definition line then starts
 * its own block, which the engine classifies as a footnote definition.
 */
export const FootnoteDefinitionInterruptExtension: MarkdownConfig = {
  parseBlock: [{
    name: "FootnoteDefinitionInterrupt",
    endLeaf: (_context, line) => line.indent - line.baseIndent < 4
      && FOOTNOTE_DEFINITION_START.test(line.text.slice(line.pos)),
  }],
};
