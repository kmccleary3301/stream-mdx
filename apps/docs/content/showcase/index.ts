export type ShowcaseItem = {
  slug: string;
  title: string;
  file: string;
  description?: string;
  tags: string[];
};

export const SHOWCASE_ITEMS: ShowcaseItem[] = [
  {
    slug: "stream-mdx-devx-catalog",
    title: "Stream-MDX DevX Catalog",
    file: "stream-mdx-devx-catalog.mdx",
    description: "Complete feature surface for production integration, tuning, and deployment workflows.",
    tags: ["rendering", "mdx", "components", "performance"],
  },
  {
    slug: "html-overrides",
    title: "HTML Overrides (ShadCN)",
    file: "html-overrides.md",
    description: "Demonstrates HTML rendering mapped onto ShadCN components (tables, blockquotes, etc.).",
    tags: ["rendering", "extensibility", "components"],
  },
  {
    slug: "custom-regex",
    title: "Custom Regex Plugins",
    file: "custom-regex.md",
    description: "Shows how regex plugins can add domain-specific rendering while streaming.",
    tags: ["extensibility", "plugin", "rendering"],
  },
  {
    slug: "mdx-components",
    title: "Custom MDX Components",
    file: "mdx-components.md",
    description: "Notes on MDX compilation modes and runtime components.",
    tags: ["mdx", "rendering", "components"],
  },
  {
    slug: "mermaid-diagrams",
    title: "Mermaid diagrams",
    file: "mermaid-diagrams.md",
    description: "Opt-in diagram rendering with a code/preview toggle.",
    tags: ["extensibility", "plugin", "components"],
  },
  {
    slug: "perf-harness",
    title: "Perf harness",
    file: "perf-harness.md",
    description: "Reproducible perf runs and guardrails for streaming metrics.",
    tags: ["performance", "testing", "safety"],
  },
  {
    slug: "terminal-protocol-flow",
    title: "Terminal protocol flow",
    file: "terminal-protocol-flow.md",
    description: "Worker, protocol, and snapshot-store patterns for TUIs, replay tools, and remote consumers.",
    tags: ["extensibility", "safety", "performance"],
  },
];
