export type ShowcaseItem = {
  slug: string;
  title: string;
  file: string;
  description?: string;
  tags: string[];
  docsHref?: string;
  demoHref?: string;
};

export const SHOWCASE_ITEMS: ShowcaseItem[] = [
  {
    slug: "stream-mdx-devx-catalog",
    title: "Stream-MDX DevX Catalog",
    file: "stream-mdx-devx-catalog.mdx",
    description: "Exhaustive MDX-based tutorial covering every Stream-MDX feature and pattern.",
    tags: ["docs", "mdx"],
    docsHref: "/docs/manual",
    demoHref: "/demo",
  },
  {
    slug: "html-overrides",
    title: "HTML Overrides (ShadCN)",
    file: "html-overrides.md",
    description: "Demonstrates HTML rendering mapped onto ShadCN components (tables, blockquotes, etc.).",
    tags: ["rendering", "components"],
    docsHref: "/docs/guides/mdx-and-html",
    demoHref: "/demo",
  },
  {
    slug: "custom-regex",
    title: "Custom Regex Plugins",
    file: "custom-regex.md",
    description: "Shows how regex plugins can add domain-specific rendering while streaming.",
    tags: ["plugin", "extensibility"],
    docsHref: "/docs/guides/format-anticipation",
    demoHref: "/demo",
  },
  {
    slug: "mdx-components",
    title: "Custom MDX Components",
    file: "mdx-components.md",
    description: "Notes on MDX compilation modes and runtime components.",
    tags: ["mdx", "rendering"],
    docsHref: "/docs/guides/mdx-and-html",
    demoHref: "/demo",
  },
  {
    slug: "mermaid-diagrams",
    title: "Mermaid diagrams",
    file: "mermaid-diagrams.md",
    description: "Opt-in diagram rendering with a code/preview toggle.",
    tags: ["plugin", "visualization"],
    docsHref: "/docs/guides/mermaid-diagrams",
    demoHref: "/demo",
  },
  {
    slug: "perf-harness",
    title: "Perf harness",
    file: "perf-harness.md",
    description: "Reproducible perf runs and guardrails for streaming metrics.",
    tags: ["performance", "testing"],
    docsHref: "/docs/guides/performance-and-backpressure",
    demoHref: "/demo",
  },
];
