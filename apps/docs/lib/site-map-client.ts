export type SiteLink = {
  href: string;
  label: string;
  summary: string;
  kind: "surface" | "docs" | "guide" | "showcase" | "article" | "internal";
};

export const PRIMARY_NAV: SiteLink[] = [
  {
    href: "/studio",
    label: "Studio",
    summary: "Canonical live control surface with scheduler, patch, and output controls.",
    kind: "surface",
  },
  {
    href: "/docs",
    label: "Docs",
    summary: "Reference-first documentation, guides, and implementation contracts.",
    kind: "docs",
  },
  {
    href: "/protocol",
    label: "Protocol",
    summary: "First-class JSON/TUI protocol and terminal integration surface.",
    kind: "docs",
  },
  {
    href: "/internals",
    label: "Internals",
    summary: "Architecture, worker boundary, parser, patch queue, and render-commit pipeline.",
    kind: "guide",
  },
  {
    href: "/benchmarks",
    label: "Benchmarks",
    summary: "Methodology, performance comparisons, and reproducibility surfaces.",
    kind: "surface",
  },
  {
    href: "/showcase",
    label: "Showcase",
    summary: "Capability proofs, integration patterns, and renderer feature examples.",
    kind: "showcase",
  },
];

export const SEARCH_ENTRIES: SiteLink[] = [
  {
    href: "/",
    label: "Home",
    summary: "Overview of StreamMDX as a streaming markdown and MDX renderer.",
    kind: "surface",
  },
  ...PRIMARY_NAV,
  {
    href: "/demo",
    label: "Demo",
    summary: "Compatibility route for the StreamMDX Studio live renderer surface.",
    kind: "surface",
  },
  {
    href: "/articles",
    label: "Articles",
    summary: "Compatibility layer that redirects guide-style articles into docs guides.",
    kind: "article",
  },
  {
    href: "/guides",
    label: "Guides",
    summary: "Compatibility route for the docs guide collection.",
    kind: "guide",
  },
  {
    href: "/docs/tui-json-protocol",
    label: "JSON/TUI protocol reference",
    summary: "Source reference behind the first-class Protocol route.",
    kind: "docs",
  },
  {
    href: "/docs/guides/architecture-and-internals",
    label: "Architecture and internals guide",
    summary: "Source guide behind the first-class Internals route.",
    kind: "guide",
  },
  {
    href: "/docs/getting-started",
    label: "Getting started",
    summary: "Install StreamMDX and render a first stream safely.",
    kind: "docs",
  },
  {
    href: "/docs/react-integration",
    label: "React integration",
    summary: "Integrate StreamMDX in React while preserving streaming correctness.",
    kind: "docs",
  },
  {
    href: "/docs/public-api",
    label: "Public API",
    summary: "Reference for stable package entry points, props, and types.",
    kind: "docs",
  },
  {
    href: "/docs/guides/performance-and-backpressure",
    label: "Performance and backpressure",
    summary: "Scheduler, queueing, cadence, and performance tuning guide.",
    kind: "guide",
  },
  {
    href: "/docs/guides/rendering-and-styling",
    label: "Rendering and styling",
    summary: "Rendered markdown, MDX, code, table, and prose styling guidance.",
    kind: "guide",
  },
  {
    href: "/showcase/assistant-stream",
    label: "Streaming Assistant & Sandboxed Artifacts",
    summary: "Executable chat thread showcasing dual-engine streaming, math, Mermaid, and sandboxed ArtifactFrame visualizations.",
    kind: "showcase",
  },
  {
    href: "/showcase/stream-mdx-devx-catalog",
    label: "DevX catalog showcase",
    summary: "Feature-rich showcase of StreamMDX rendering capabilities.",
    kind: "showcase",
  },
  {
    href: "/showcase/terminal-protocol-flow",
    label: "Terminal protocol flow",
    summary: "TUI protocol flow and terminal integration proof surface.",
    kind: "showcase",
  },
  {
    href: "/perf/harness",
    label: "Performance harness",
    summary: "Internal performance and fixture harness.",
    kind: "internal",
  },
  {
    href: "/regression/html",
    label: "HTML regression harness",
    summary: "Internal HTML rendering regression surface.",
    kind: "internal",
  },
];
