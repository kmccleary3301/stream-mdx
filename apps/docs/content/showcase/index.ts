export type ShowcaseItem = {
  slug: string;
  title: string;
  file: string;
  description?: string;
};

export const SHOWCASE_ITEMS: ShowcaseItem[] = [
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
];

