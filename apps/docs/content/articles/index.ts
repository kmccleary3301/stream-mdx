export type ArticleItem = {
  slug: string;
  title: string;
  file: string;
  description?: string;
};

export const ARTICLE_ITEMS: ArticleItem[] = [
  {
    slug: "streaming-fundamentals",
    title: "Streaming Fundamentals",
    file: "streaming-fundamentals.md",
    description: "Mental model, streaming loop, and how StreamMDX keeps output stable while data arrives.",
  },
  {
    slug: "rendering-and-styling",
    title: "Rendering and Styling",
    file: "rendering-and-styling.md",
    description: "Component overrides, HTML mappings, and styling patterns that preserve incremental rendering.",
  },
  {
    slug: "mdx-and-html",
    title: "MDX and HTML in StreamMDX",
    file: "mdx-and-html.md",
    description: "MDX compile strategies, HTML safety, and when to use each feature.",
  },
  {
    slug: "plugins-and-extensions",
    title: "Plugins and Extensions",
    file: "plugins-and-extensions.md",
    description: "Worker-side features, custom syntax hooks, and opt-in add-ons.",
  },
  {
    slug: "performance-and-backpressure",
    title: "Performance and Backpressure",
    file: "performance-and-backpressure.md",
    description: "Scheduling, queue control, metrics, and how to tune for latency or throughput.",
  },
  {
    slug: "format-anticipation",
    title: "Format Anticipation",
    file: "format-anticipation.md",
    description: "Render formatting early while streaming, with safe per-feature toggles.",
  },
  {
    slug: "testing-and-baselines",
    title: "Testing and Baselines",
    file: "testing-and-baselines.md",
    description: "Local-only HTML/style snapshot baselines and perf capture workflow.",
  },
  {
    slug: "deployment-and-security",
    title: "Deployment and Security",
    file: "deployment-and-security.md",
    description: "Worker hosting, CSP guidance, sanitization, and production-ready defaults.",
  },
  {
    slug: "mermaid-diagrams",
    title: "Mermaid Diagrams",
    file: "mermaid-diagrams.md",
    description: "Diagram rendering with the optional Mermaid addon and UX patterns for toggling views.",
  },
];
