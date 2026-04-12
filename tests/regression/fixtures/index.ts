export type RegressionFixture = {
  id: string;
  title: string;
  file: string;
  tags?: string[];
  requiredSelectors?: string[];
  requiredTextFragments?: string[];
  expectTableByPct?: number;
  expectedListItemCount?: number;
  forbidEmptyNestedLists?: boolean;
  expectedTableColumnCount?: number;
  forbidIncompleteTableRows?: boolean;
  forbidIncompleteTableRowsDuringStreaming?: boolean;
  expectedMdxBlockCount?: number;
  expectedCodeBlockCount?: number;
  enforceCodeTextPrefix?: boolean;
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
    id: "mixed-content-golden",
    title: "Mixed Content Golden",
    file: "mixed-content-golden.md",
    tags: ["mixed", "golden", "article"],
    requiredSelectors: ["table", "pre", ".footnotes", ".katex", "blockquote", "kbd", "sub", "sup"],
  },
  {
    id: "edge-boundaries",
    title: "Edge Boundaries",
    file: "edge-boundaries.md",
    tags: ["synthetic", "split-markers", "inline", "math", "table", "code"],
    requiredSelectors: ["table", ".katex"],
  },
  {
    id: "table-boundary",
    title: "Table Boundary",
    file: "table-boundary.md",
    tags: ["table"],
    requiredSelectors: ["table"],
    requiredTextFragments: ["Bridgewater", "Renaissance", "Man Group"],
    expectedTableColumnCount: 3,
    forbidIncompleteTableRows: true,
    forbidIncompleteTableRowsDuringStreaming: true,
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
    id: "math-mdx-sentinel",
    title: "Math/MDX Sentinel",
    file: "math-mdx-sentinel.md",
    tags: ["math", "regression"],
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
    id: "imaginary-empty-list",
    title: "Imaginary Empty Nested List",
    file: "imaginary-empty-list.md",
    tags: ["lists", "regression", "split-markers"],
    requiredSelectors: ["ol"],
    expectedListItemCount: 4,
    forbidEmptyNestedLists: true,
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
    expectedListItemCount: 17,
  },
  {
    id: "list-code-nested",
    title: "Nested List Code Blocks",
    file: "list-code-nested.md",
    tags: ["lists", "code"],
    requiredSelectors: ["ol", "ul", "pre", "code"],
    requiredTextFragments: ["const value = 1;", "echo \"nested\"", "export const answer = 42;"],
    expectedCodeBlockCount: 3,
  },
  {
    id: "edge-regressions",
    title: "Edge Regression Coverage",
    file: "edge-regressions.md",
    tags: ["inline", "math", "lists", "stress"],
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
    requiredTextFragments: ["Alpha", "Model", "Blockquote inside MDX"],
    expectedMdxBlockCount: 3,
  },
  {
    id: "mdx-math-code-mixed",
    title: "MDX Math Code Mixed",
    file: "mdx-math-code-mixed.mdx",
    tags: ["mdx", "math", "code", "stress"],
    requiredSelectors: [".markdown-mdx", ".katex", "pre", "table"],
    requiredTextFragments: ["ordered item", "Model", "answer = 42", "Stability note"],
    expectedMdxBlockCount: 2,
    expectedCodeBlockCount: 2,
  },
  {
    id: "mdx-multi-status",
    title: "MDX Multi Status",
    file: "mdx-multi-status.mdx",
    tags: ["mdx", "math", "code", "error", "stress"],
    requiredSelectors: [".markdown-mdx", ".katex", "pre", "table"],
    requiredTextFragments: ["Stable preview payload", "Stable", "Compiled", "MDX failed"],
    expectedMdxBlockCount: 3,
    expectedCodeBlockCount: 2,
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
    tags: ["code", "stress", "golden"],
    requiredSelectors: ["pre", "code"],
    expectedCodeBlockCount: 1,
    enforceCodeTextPrefix: true,
  },
  {
    id: "anticipation-inline",
    title: "Anticipation Inline Smoke",
    file: "anticipation-inline.md",
    tags: ["anticipation", "math", "inline"],
    requiredSelectors: ["code.inline-code", ".katex"],
  },
  {
    id: "nested-formatting-ancestors",
    title: "Nested Formatting Ancestors",
    file: "nested-formatting-ancestors.md",
    tags: ["anticipation", "inline", "lists", "blockquote"],
    requiredSelectors: ["ul", "blockquote", "em", "strong", "code.inline-code"],
  },
  {
    id: "nested-math-inline",
    title: "Nested Inline Math",
    file: "nested-math-inline.md",
    tags: ["anticipation", "math", "lists", "blockquote"],
    requiredSelectors: ["ul", "blockquote", ".katex"],
  },
  {
    id: "nested-blockquote-list-crossover",
    title: "Nested Blockquote List Crossover",
    file: "nested-blockquote-list-crossover.md",
    tags: ["anticipation", "lists", "blockquote", "code", "math"],
    requiredSelectors: ["ul", "blockquote"],
  },
  {
    id: "inline-html-allowlist",
    title: "Inline HTML Allowlist",
    file: "inline-html-allowlist.md",
    tags: ["anticipation", "html", "inline"],
    requiredSelectors: ["kbd", "sup", "sub", "span", "a", "code"],
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
    expectedCodeBlockCount: 1,
    enforceCodeTextPrefix: true,
  },
];

export function findRegressionFixture(id: string): RegressionFixture | undefined {
  return REGRESSION_FIXTURES.find((fixture) => fixture.id === id);
}
