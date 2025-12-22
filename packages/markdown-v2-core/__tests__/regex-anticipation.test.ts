import assert from "node:assert";

import { InlineParser } from "../src/inline-parser";
import type { RegexInlinePlugin } from "../src/types";

const parser = new InlineParser({ enableMath: false });

const underlinePlugin: RegexInlinePlugin = {
  id: "underline",
  priority: 50,
  re: /\+\+([^+\n]+?)\+\+/g,
  toNode: (match) => ({ kind: "text", text: match[1] }),
  anticipation: {
    start: /\+\+/g,
    end: /\+\+/g,
    full: /\+\+[^+\n]+?\+\+/g,
    append: "++",
    maxScanChars: 120,
  },
};

parser.registerPlugin(underlinePlugin);

const append = parser.getRegexAnticipationAppend("Example ++under");
assert.strictEqual(append, "++");

const none = parser.getRegexAnticipationAppend("Example ++done++");
assert.strictEqual(none, null);

const citeAppend = parser.getRegexAnticipationAppend("Ref {cite:5");
assert.strictEqual(citeAppend, "}");

const citeNone = parser.getRegexAnticipationAppend("Ref {cite:5}");
assert.strictEqual(citeNone, null);

console.log("regex anticipation tests passed");
