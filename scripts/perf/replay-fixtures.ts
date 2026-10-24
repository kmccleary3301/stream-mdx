/**
 * Test-owned replay fixtures and deterministic chunking generators.
 * Covers the 6 dense fixture groups required by validation-plan.md §2 and baseline-protocol.md.
 */

export interface FixtureExpectations {
  headings?: Array<{ level: number; text: string }>;
  codeBlocks?: Array<{
    lang?: string;
    codeLines: string[];
    openingFenceIndent?: number;
    closingFenceIndent?: number;
  }>;
  tables?: Array<{
    columnCount: number;
    rowCount?: number;
    alignments: Array<"left" | "center" | "right" | null>;
    cellSubstrings: string[];
  }>;
  listLooseness?: boolean;
  footnotes?: Array<{ label: string; number: number; textSnippet: string }>;
  links?: Array<{ href: string; title?: string }>;
  htmlSnippets?: string[];
}

export interface DenseFixture {
  id: string;
  name: string;
  source: string;
  description: string;
  stage: string;
  expectations?: FixtureExpectations;
}

export const DENSE_FIXTURES: DenseFixture[] = [
  {
    id: "nested-prose-list-quote-code",
    name: "Nested Prose, List, Quote, Code with Unicode & CRLF",
    stage: "engine:nested",
    description: "Exercises content loss, container topology drift, surrogate pair splits, CRLF splits, provisional tail safety",
    source:
      "# Section with 🚀 emoji and CRLF\r\n" +
      "\r\n" +
      "> Outer quote with surrogate 🎉 and text:\r\n" +
      "> - Item 1 with 𠮷 character\r\n" +
      "> - Item 2 with nested code:\r\n" +
      ">   ```typescript\r\n" +
      ">   const answer: number = 42;\r\n" +
      ">   ```\r\n" +
      "\r\n" +
      "Provisional trailing paragraph here.",
    expectations: {
      headings: [{ level: 1, text: "Section with 🚀 emoji and CRLF" }],
      codeBlocks: [{ lang: "typescript", codeLines: ["const answer: number = 42;"] }],
    },
  },
  {
    id: "table-escaping-alignment",
    name: "Table with Escapes, Alignment, and Growing Body",
    stage: "engine:table",
    description: "Exercises cell shape, row identity, escaped pipes, column alignment, and prefix reprocessing",
    source:
      "| Left Col | Center Col | Right Col |\r\n" +
      "| :--- | :---: | ---: |\r\n" +
      "| alpha | cell with \\| pipe | `code_here` |\r\n" +
      "| beta | **bold text** | $1,234.56 |\r\n" +
      "| gamma | cell three | [link](https://example.com) |\r\n",
    expectations: {
      tables: [
        {
          columnCount: 3,
          rowCount: 3,
          alignments: ["left", "center", "right"],
          cellSubstrings: ["alpha", "cell with | pipe", "code_here", "bold text", "$1,234.56"],
        },
      ],
    },
  },
  {
    id: "references-footnotes",
    name: "Early References Plus Late Definitions",
    stage: "engine:references",
    description: "Exercises link and footnote resolution, numbering, anchor identity, and immutable old snapshots",
    source:
      "First paragraph with [link one][ref1] and footnote[^fn1].\n\n" +
      "Second paragraph with [link two][ref2] and footnote[^fn2].\n\n" +
      "[ref1]: https://example.com/one \"Title One\"\n" +
      "[ref2]: https://example.com/two \"Title Two\"\n" +
      "[^fn1]: First footnote body with details.\n" +
      "[^fn2]: Second footnote body with **bold** formatting.\n",
    expectations: {
      links: [
        { href: "https://example.com/one", title: "Title One" },
        { href: "https://example.com/two", title: "Title Two" },
      ],
      footnotes: [
        { label: "fn1", number: 1, textSnippet: "First footnote body with details." },
        { label: "fn2", number: 2, textSnippet: "Second footnote body with bold formatting." },
      ],
    },
  },
  {
    id: "list-looseness",
    name: "Tight List Turned Loose by Later Blank Line",
    stage: "engine:list-looseness",
    description: "Exercises list-level looseness flag, unchanged earlier items, and paragraph wrapping transition",
    source:
      "- Item 1\n" +
      "- Item 2\n" +
      "\n" +
      "- Item 3 separated by blank line turning list loose\n" +
      "- Item 4\n",
    expectations: {
      listLooseness: true,
    },
  },
  {
    id: "fence-indent-multiline",
    name: "Opening/Closing Fence Indent with Multiline Grammar",
    stage: "engine:code",
    description: "Exercises CommonMark dedent from a two-space opening fence against an unindented closing fence, independent Shiki tokenization, and multiline grammar",
    source:
      "Paragraph before fence.\n\n" +
      "  ```typescript\n" +
      "  interface User {\n" +
      "    id: string;\n" +
      "    name: string;\n" +
      "    active: boolean;\n" +
      "  }\n" +
      "  const u: User = {\n" +
      "    id: \"u1\",\n" +
      "    name: \"Alice\",\n" +
      "    active: true,\n" +
      "  };\n" +
      "```\n\n" +
      "Paragraph after fence.\n",
    expectations: {
      codeBlocks: [
        {
          openingFenceIndent: 2,
          closingFenceIndent: 0,
          lang: "typescript",
          codeLines: [
            "interface User {",
            "  id: string;",
            "  name: string;",
            "  active: boolean;",
            "}",
            "const u: User = {",
            "  id: \"u1\",",
            "  name: \"Alice\",",
            "  active: true,",
            "};",
          ],
        },
      ],
    },
  },
  {
    id: "safe-html-tag-syntax",
    name: "Mixed Safe HTML and Tag Syntax",
    stage: "engine:html-tags",
    description: "Exercises sanitization/URL policy, source preservation, entity references, and tag boundary splits",
    source:
      "<div class=\"callout-box\">\n" +
      "  <span>Safe HTML text with &amp; entity and &lt;brackets&gt;</span>\n" +
      "  <br />\n" +
      "  <kbd>Ctrl</kbd> + <kbd>C</kbd>\n" +
      "  <a href=\"javascript:alert('xss')\" onclick=\"alert('xss')\">Unsafe link</a>\n" +
      "  <script>alert('xss')</script>\n" +
      "</div>\n\n" +
      "<Widget id=\"widget-1\" active={true}>\n" +
      "  Inner content inside component tag.\n" +
      "</Widget>\n",
    expectations: {
      htmlSnippets: ["Safe HTML text with & entity and <brackets>", "Ctrl", "C"],
    },
  },
];

/**
 * Finds all forced split point indices in a UTF-16 source string.
 * Cuts inside surrogate pairs, between CR and LF, inside delimiters (```, ~~~, ||, >>, --, **, ##),
 * and inside HTML/component tag syntax.
 */
export function findForcedSplitPoints(source: string): Set<number> {
  const points = new Set<number>();
  for (let i = 0; i < source.length - 1; i++) {
    const code = source.charCodeAt(i);
    const nextCode = source.charCodeAt(i + 1);

    // 1. Surrogate pair split (high surrogate followed by low surrogate)
    if (code >= 0xd800 && code <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff) {
      points.add(i + 1);
    }

    // 2. CRLF split
    if (source[i] === "\r" && source[i + 1] === "\n") {
      points.add(i + 1);
    }

    // 3. Delimiter splits: ```, ~~~, ---, ===, ***, ###, >>, ||
    if (source[i] === "`" && source[i + 1] === "`") {
      points.add(i + 1);
    }
    if (source[i] === "~" && source[i + 1] === "~") {
      points.add(i + 1);
    }
    if (source[i] === "-" && source[i + 1] === "-") {
      points.add(i + 1);
    }
    if (source[i] === "*" && source[i + 1] === "*") {
      points.add(i + 1);
    }
    if (source[i] === "#" && source[i + 1] === "#") {
      points.add(i + 1);
    }
    if (source[i] === ">" && source[i + 1] === ">") {
      points.add(i + 1);
    }
    if (source[i] === "|" && (source[i + 1] === "-" || source[i + 1] === " " || source[i + 1] === ":")) {
      points.add(i + 1);
    }

    // 4. HTML/component tag splits: inside `<tag...>` or `</tag>`
    if (source[i] === "<" && /[a-zA-Z/]/.test(source[i + 1])) {
      points.add(i + 1);
    }
    if (source[i] === "/" && source[i + 1] === ">") {
      points.add(i + 1);
    }
  }

  // Tag closing `>` split before closing bracket
  for (let i = 1; i < source.length; i++) {
    if (source[i] === ">" && source[i - 1] !== "\\") {
      points.add(i);
    }
  }

  return points;
}

/**
 * Deterministic Mulberry32 PRNG.
 */
function createMulberry32(seed: number) {
  let s = seed | 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function splitLinesPreservingEndings(source: string): string[] {
  if (source.length === 0) return [""];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\r" && source[i + 1] === "\n") {
      lines.push(source.slice(start, i + 2));
      start = i + 2;
      i++;
    } else if (source[i] === "\n") {
      lines.push(source.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < source.length) {
    lines.push(source.slice(start));
  }
  return lines;
}

export function splitOneUnitChunks(source: string): string[] {
  const chunks: string[] = new Array(source.length);
  for (let i = 0; i < source.length; i++) {
    chunks[i] = source[i];
  }
  return chunks;
}

export function createSeededRandomChunks(source: string, seed: number): string[] {
  if (source.length === 0) return [""];
  const forcedPoints = findForcedSplitPoints(source);
  const random = createMulberry32(seed);
  const chunks: string[] = [];
  let pos = 0;

  while (pos < source.length) {
    let nextForced: number | null = null;
    for (let i = pos + 1; i <= source.length; i++) {
      if (forcedPoints.has(i)) {
        nextForced = i;
        break;
      }
    }

    const maxStep = nextForced !== null ? Math.min(32, nextForced - pos) : Math.min(32, source.length - pos);
    const step = 1 + Math.floor(random() * maxStep);
    const cut = nextForced !== null && nextForced - pos <= step ? nextForced : pos + step;
    chunks.push(source.slice(pos, cut));
    pos = cut;
  }
  return chunks;
}

export interface ChunkingPlan {
  mode: "whole" | "line" | "1-unit" | "random";
  seed: number;
  chunks: string[];
}

export function generateChunkingPlans(source: string, seed = 42): ChunkingPlan[] {
  return [
    { mode: "whole", seed: 0, chunks: [source] },
    { mode: "line", seed: 0, chunks: splitLinesPreservingEndings(source) },
    { mode: "1-unit", seed: 0, chunks: splitOneUnitChunks(source) },
    { mode: "random", seed, chunks: createSeededRandomChunks(source, seed) },
  ];
}

function undefinedPropertyPaths(value: unknown): string[] {
  const paths: string[] = [];
  const ancestors = new Set<object>();
  const visit = (entry: unknown, path: string): void => {
    if (entry === null || typeof entry !== "object" || ancestors.has(entry)) return;
    ancestors.add(entry);
    for (const [key, child] of Object.entries(entry)) {
      const childPath = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (child === undefined) paths.push(childPath);
      else visit(child, childPath);
    }
    ancestors.delete(entry);
  };
  visit(value, "");
  return paths;
}

export function recordDivergence(
  divergences: DivergenceReport[],
  fixture: DenseFixture,
  plan: ChunkingPlan,
  stage: string,
  tx: number,
  frontier: number,
  message: string,
  comparison?: DivergenceReport["comparison"],
): void {
  divergences.push({
    fixtureId: fixture.id,
    planMode: plan.mode,
    seed: plan.seed,
    stage,
    commitIndex: tx,
    frontier,
    sourcePrefix: fixture.source.slice(0, frontier),
    message,
    ...(comparison ? {
      comparison,
      comparisonUndefinedProperties: {
        current: undefinedPropertyPaths(comparison.current),
        cold: undefinedPropertyPaths(comparison.cold),
      },
    } : {}),
  });
}

export interface DivergenceReport {
  fixtureId: string;
  planMode: string;
  seed: number;
  stage: string;
  commitIndex: number;
  frontier: number;
  sourcePrefix: string;
  message: string;
  comparison?: { current: unknown; cold: unknown };
  comparisonUndefinedProperties?: { current: string[]; cold: string[] };
}
