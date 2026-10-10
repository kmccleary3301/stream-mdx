import fs from "node:fs";
import path from "node:path";

export type StudioSample = {
  id: string;
  label: string;
  summary: string;
  filePath: string;
  emphasis: string[];
};

export type StudioSampleWithText = StudioSample & { text: string };

const SAMPLE_DEFS: StudioSample[] = [
  {
    id: "naive-bayes",
    label: "Naive Bayes article",
    summary: "Long-form prose and math fixture used by the original live demo surface.",
    filePath: path.join("app", "demo", "naive-bayes-classifier.mdx"),
    emphasis: ["prose", "math", "long stream"],
  },
  {
    id: "kitchen-sink",
    label: "Kitchen sink",
    summary: "Mixed markdown fixture covering headings, lists, code, tables, and block transitions.",
    filePath: path.join("public", "perf", "fixtures", "kitchen-sink.md"),
    emphasis: ["mixed blocks", "lists", "tables"],
  },
  {
    id: "table-large",
    label: "Large table",
    summary: "Table stress case for overflow, column integrity, and row formation while streaming.",
    filePath: path.join("public", "perf", "fixtures", "table-large.md"),
    emphasis: ["tables", "overflow", "cell integrity"],
  },
  {
    id: "footnotes",
    label: "Footnotes and links",
    summary: "Reference-heavy prose fixture for footnotes, backlinks, and inline link behavior.",
    filePath: path.join("public", "perf", "fixtures", "footnotes.md"),
    emphasis: ["footnotes", "links", "backlinks"],
  },
  {
    id: "code-highlight",
    label: "Code highlight boundary",
    summary: "Incremental code highlighting fixture for line stability and language chrome behavior.",
    filePath: path.join("public", "perf", "fixtures", "code-highlight-incremental.md"),
    emphasis: ["code", "highlighting", "ordering"],
  },
];

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  return raw.slice(end + 4).trimStart();
}

function readSampleText(sample: StudioSample): string {
  const absolutePath = path.join(process.cwd(), sample.filePath);
  try {
    return stripFrontmatter(fs.readFileSync(absolutePath, "utf8"));
  } catch {
    return [`# Missing sample`, "", `Could not read ${sample.filePath}.`].join("\n");
  }
}

export function getStudioSamples(): StudioSampleWithText[] {
  return SAMPLE_DEFS.map((sample) => ({
    ...sample,
    text: readSampleText(sample),
  }));
}
