export type RegressionFixture = {
  id: string;
  title: string;
  file: string;
  tags?: string[];
  requiredSelectors?: string[];
  expectTableByPct?: number;
};

export const REGRESSION_FIXTURES: RegressionFixture[] = [
  {
    id: "kitchen-sink",
    title: "Kitchen Sink",
    file: "kitchen-sink.md",
    tags: ["article"],
    requiredSelectors: ["table", "pre", ".footnotes", ".katex", "blockquote"],
  },
  {
    id: "edge-boundaries",
    title: "Edge Boundaries",
    file: "edge-boundaries.md",
    tags: ["synthetic", "split-markers"],
    requiredSelectors: ["table", ".katex"],
  },
  {
    id: "table-boundary",
    title: "Table Boundary",
    file: "table-boundary.md",
    tags: ["table"],
    requiredSelectors: ["table"],
  },
  {
    id: "inline-html",
    title: "Inline HTML",
    file: "inline-html.md",
    tags: ["html"],
    requiredSelectors: ["kbd", "sub", "sup"],
  },
  {
    id: "footnotes",
    title: "Footnotes",
    file: "footnotes.md",
    tags: ["footnotes"],
    requiredSelectors: [".footnotes"],
  },
  {
    id: "math-boundary",
    title: "Math Boundary",
    file: "math-boundary.md",
    tags: ["math"],
    requiredSelectors: [".katex"],
  },
  {
    id: "lists-nested",
    title: "Lists Nested",
    file: "lists-nested.md",
    tags: ["lists"],
    requiredSelectors: ["ol", "ul"],
  },
  {
    id: "mdx-preview-block",
    title: "MDX Preview Block",
    file: "mdx-preview-block.mdx",
    tags: ["mdx"],
    requiredSelectors: [".markdown-mdx", "figure", "pre"],
  },
  {
    id: "line-breaks",
    title: "Line Breaks",
    file: "line-breaks.md",
    tags: ["inline"],
    requiredSelectors: ["br"],
  },
  {
    id: "math-spacing",
    title: "Math Spacing",
    file: "math-spacing.md",
    tags: ["math"],
    requiredSelectors: [".katex"],
  },
  {
    id: "table-large",
    title: "Large Table",
    file: "table-large.md",
    tags: ["table", "stress"],
    requiredSelectors: ["table"],
  },
  {
    id: "list-long",
    title: "Long Lists",
    file: "list-long.md",
    tags: ["lists"],
    requiredSelectors: ["ol", "ul"],
  },
  {
    id: "edge-regressions",
    title: "Edge Regression Coverage",
    file: "edge-regressions.md",
    tags: ["inline", "math", "lists"],
    requiredSelectors: ["code", ".katex", "ol"],
  },
  {
    id: "table-incremental",
    title: "Table Incremental Coverage",
    file: "table-incremental.md",
    tags: ["table"],
    requiredSelectors: ["table"],
    expectTableByPct: 0.25,
  },
  {
    id: "naive-bayes",
    title: "Naive Bayes Article",
    file: "naive-bayes.md",
    tags: ["article", "large", "mdx", "stress"],
    requiredSelectors: ["table", "pre", ".katex", "blockquote"],
  },
  {
    id: "mdx-components",
    title: "MDX Components",
    file: "mdx-components.mdx",
    tags: ["mdx"],
    requiredSelectors: [".markdown-mdx", "figure", "pre", "iframe", "img"],
  },
  {
    id: "mdx-transitions",
    title: "MDX Pending/Compiled Transitions",
    file: "mdx-transitions.mdx",
    tags: ["mdx"],
    requiredSelectors: [".markdown-mdx", "figure", "pre"],
  },
  {
    id: "html-sanitization",
    title: "HTML Sanitization",
    file: "html-sanitization.md",
    tags: ["html", "sanitization"],
    requiredSelectors: ["kbd", "a"],
  },
  {
    id: "code-huge",
    title: "Huge Code Block",
    file: "code-huge.md",
    tags: ["code", "stress"],
    requiredSelectors: ["pre", "code"],
  },
  {
    id: "anticipation-inline",
    title: "Anticipation Inline Smoke",
    file: "anticipation-inline.md",
    tags: ["anticipation", "math", "inline"],
    requiredSelectors: ["code.inline-code", ".katex"],
  },
  {
    id: "delimiter-boundary",
    title: "Delimiter Boundary Splitter",
    file: "delimiter-boundary.md",
    tags: ["synthetic", "split-markers", "inline", "math", "code"],
    requiredSelectors: ["pre", "code"],
  },
  {
    id: "code-highlight-incremental",
    title: "Incremental Code Highlighting",
    file: "code-highlight-incremental.md",
    tags: ["code", "highlight"],
    requiredSelectors: ["pre", "code"],
  },
];

export function findRegressionFixture(id: string): RegressionFixture | undefined {
  return REGRESSION_FIXTURES.find((fixture) => fixture.id === id);
}
