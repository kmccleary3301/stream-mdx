export type ShowcaseItem = {
  slug: string;
  title: string;
  file: string;
  description?: string;
};

export const SHOWCASE_ITEMS: ShowcaseItem[] = [
  {
    slug: "stream-mdx-devx-catalog",
    title: "Stream-MDX DevX Catalog",
    file: "stream-mdx-devx-catalog.mdx",
    description: "Exhaustive MDX-based tutorial covering every Stream-MDX feature and pattern.",
  },
  {
    slug: "html-overrides",
    title: "HTML Overrides (ShadCN)",
    file: "html-overrides.md",
    description: "Demonstrates HTML rendering mapped onto ShadCN components (tables, blockquotes, etc.).",
  },
  {
    slug: "custom-regex",
    title: "Custom Regex Plugins",
    file: "custom-regex.md",
    description: "Shows how regex plugins can add domain-specific rendering while streaming.",
  },
  {
    slug: "mdx-components",
    title: "Custom MDX Components",
    file: "mdx-components.md",
    description: "Notes on MDX compilation modes and runtime components.",
  },
  {
    slug: "mermaid-diagrams",
    title: "Mermaid diagrams",
    file: "mermaid-diagrams.md",
    description: "Opt-in diagram rendering with a code/preview toggle.",
  },
  {
    slug: "perf-harness",
    title: "Perf harness",
    file: "perf-harness.md",
    description: "Reproducible perf runs and guardrails for streaming metrics.",
  },
];
