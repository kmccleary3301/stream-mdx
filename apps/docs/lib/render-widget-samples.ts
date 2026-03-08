type SampleMap = Record<string, string>;

export type RenderWidgetSample = {
  title: string;
  markdown: string;
};

const DOC_SAMPLES: SampleMap = {
  "getting-started": `# Getting started stream

Install once, then keep the worker hosted from your static assets.

\`\`\`bash
npm install stream-mdx
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
\`\`\`

Then render incrementally:

\`\`\`tsx
import { StreamingMarkdown } from "stream-mdx";

<StreamingMarkdown text={text} worker="/workers/markdown-worker.js" />
\`\`\`
`,
  configuration: `# Configuration

Tune features without changing your render surface:

- \`features.html\`: parse sanitized HTML blocks
- \`features.tables\`: enable table parsing
- \`features.math\`: KaTeX/Math support
- \`features.mdx\`: MDX compile paths

\`\`\`tsx
<StreamingMarkdown
  worker="/workers/markdown-worker.js"
  features={{ html: true, tables: true, math: true, mdx: true }}
  text={text}
/>
\`\`\`
`,
  "public-api": `# Public API

StreamMDX exports scoped packages plus an unscoped wrapper.

| Package | Use when |
| --- | --- |
| \`stream-mdx\` | single dependency for apps |
| \`@stream-mdx/react\` | React renderer only |
| \`@stream-mdx/worker\` | hosted worker + node helpers |

\`\`\`ts
import { StreamingMarkdown } from "stream-mdx";
import { createWorkerClient } from "@stream-mdx/worker";
\`\`\`
`,
  "react-integration": `# React integration

Worker-first rendering keeps heavy parse/token work off the main thread.

\`\`\`tsx
"use client";

import { StreamingMarkdown } from "@stream-mdx/react";

export function DocsPreview({ text }: { text: string }) {
  return <StreamingMarkdown text={text} worker="/workers/markdown-worker.js" />;
}
\`\`\`
`,
  "security-model": `# Security model

Sanitization is on by default for untrusted HTML content.

> Keep sanitization enabled unless your input is fully trusted.

\`\`\`html
<blockquote>Rendered safely after sanitization.</blockquote>
\`\`\`

Safe defaults + CSP-friendly worker hosting keep production surfaces predictable.
`,
  "plugins-cookbook": `# Plugins cookbook

Plugins extend parser behavior without forking the renderer:

- footnotes
- callouts
- tables
- custom regex plugins

\`\`\`ts
import { createPluginRegistry, registerFootnotesPlugin } from "@stream-mdx/plugins";

const registry = createPluginRegistry();
registerFootnotesPlugin(registry);
\`\`\`
`,
  "release-checklist": `# Release checklist

Before publishing:

1. build packages
2. run tests + regressions
3. run docs quality audit
4. verify hosted worker copy path

\`\`\`bash
npm run build:packages
npm run test
npm run docs:build
\`\`\`
`,
  "perf-harness": `# Perf harness

Measure parse/render behavior under controlled stream rates.

\`\`\`text
p95 patch latency: 4.2ms
queue depth: stable
coalescing ratio: 2.7:1
\`\`\`

Use the harness to catch regressions before release.
`,
  "perf-quality-changelog": `# Perf quality changelog

Track user-visible perf quality over time:

- first flush latency
- patch cadence stability
- long-task spikes
- code highlight jitter

\`\`\`diff
- p95 patch latency: 6.1ms
+ p95 patch latency: 4.3ms
\`\`\`
`,
  status: `# Status / architecture

Core loop:

1. parse in worker
2. emit stable blocks + patches
3. coalesce patch bursts
4. commit to renderer store

\`\`\`mermaid
graph TD
  Input --> Worker
  Worker --> PatchQueue
  PatchQueue --> Renderer
\`\`\`
`,
  "streamdown-comparison": `# Streamdown comparison

When comparing alternatives, hold fixtures and rates constant.

| Renderer | Throughput | Stability |
| --- | --- | --- |
| StreamMDX | high | deterministic |
| Baseline | medium | variable |

\`\`\`text
focus on perceptual stability, not only raw throughput.
\`\`\`
`,
  manual: `# Comprehensive manual

This stream previews a compact subset of the full manual:

- runtime contexts
- plugin boundaries
- deterministic replay model
- deployment constraints

\`\`\`ts
type RuntimeContext = "browser-worker" | "node-worker-thread" | "node-direct";
\`\`\`
`,
  "tui-json-protocol": `# TUI / JSON stream protocol

Patch envelopes are deterministic and replayable:

\`\`\`json
{
  "protocol": "streammdx",
  "event": "patch",
  "tx": 42,
  "patches": [{ "op": "appendLines", "at": ["__root__", 3] }]
}
\`\`\`

Token spans preserve syntax metadata for terminal renderers.
`,
};

const GUIDE_SAMPLES: SampleMap = {
  "streaming-fundamentals": `# Streaming fundamentals

StreamMDX appends stable blocks while content is still arriving.

- no full-document remounts
- predictable patch order
- safe detach/re-attach in scrolling surfaces
`,
  "rendering-and-styling": `# Rendering and styling

Override renderers without changing parser behavior.

\`\`\`tsx
const components = {
  blockquote: ({ children }) => <blockquote className="rounded-md border p-3">{children}</blockquote>,
};
\`\`\`
`,
  "mdx-and-html": `# MDX + HTML

MDX can be compiled in worker mode for interactive docs surfaces.

\`\`\`md
<table>
  <tr><td>HTML mapped safely</td></tr>
</table>
\`\`\`
`,
  "plugins-and-extensions": `# Plugins and extensions

Keep custom syntax isolated to plugin registration:

\`\`\`ts
registry.register({ id: "domain-tags", match: /\\bTODO\\((.*?)\\)/g });
\`\`\`
`,
  "performance-and-backpressure": `# Performance + backpressure

Tune for low latency or high throughput with scheduler presets.

\`\`\`text
latency mode: first flush priority
throughput mode: larger patch batches
\`\`\`
`,
  "format-anticipation": `# Format anticipation

Predict formatting early for better in-flight readability.

\`\`\`md
**bold starts before close marker arrives**
\`\`\`
`,
  "testing-and-baselines": `# Testing and baselines

Run deterministic snapshots for HTML + style output.

\`\`\`bash
npm run docs:quality:audit
npm run docs:sticky-scroll:check
\`\`\`
`,
  "comparisons-and-benchmarks": `# Comparisons and benchmarks

Use the same fixture + cadence when comparing renderers.

| Scenario | StreamMDX | baseline |
| --- | --- | --- |
| chunky network | stable | jitter |
`,
  "architecture-and-internals": `# Architecture and internals

\`\`\`mermaid
graph LR
  Source --> Parser
  Parser --> PatchBus
  PatchBus --> Store
  Store --> View
\`\`\`
`,
  "deployment-and-security": `# Deployment and security

Host the worker from static assets and keep CSP explicit.

\`\`\`http
Content-Security-Policy: worker-src 'self';
\`\`\`
`,
  "mermaid-diagrams": `# Mermaid diagrams

\`\`\`mermaid
graph TD
  User --> StreamMDX
  StreamMDX --> Worker
  Worker --> Renderer
\`\`\`
`,
};

const SHOWCASE_SAMPLES: SampleMap = {
  "stream-mdx-devx-catalog": `# DevX catalog

One page showing end-to-end patterns:

- worker setup
- renderer overrides
- mdx/html mapping
- perf hooks
`,
  "html-overrides": `# HTML overrides

Map HTML tags into your design system wrappers.

\`\`\`tsx
const htmlElements = {
  blockquote: ({ children, ...props }) => <blockquote className="border-l-2 pl-3" {...props}>{children}</blockquote>,
};
\`\`\`
`,
  "custom-regex": `# Custom regex plugins

\`\`\`ts
registry.register({
  id: "issue-link",
  match: /#(\\d{3,6})/g,
});
\`\`\`
`,
  "mdx-components": `# MDX components

MDX blocks can compile while stream text is still flowing.

\`\`\`md
Use mdx compile mode where interactive content is required.
\`\`\`
`,
  "mermaid-diagrams": `# Mermaid showcase

\`\`\`mermaid
graph TD
  A[Input] --> B[Worker]
  B --> C[Patch stream]
  C --> D[Renderer]
\`\`\`
`,
  "perf-harness": `# Perf harness showcase

\`\`\`text
stream rate: 500 chars/s
p95 patch latency: 4.0ms
coalescing: 0.0%
\`\`\`
`,
};

function fallbackSample(title: string, slug: string): string {
  return `# ${title}

Live widget stream for \`${slug}\`.

- fixed-size rendering surface
- bottom-stick scroll behavior
- incremental markdown updates
`;
}

export function getDocWidgetSample(slug: string, title: string): RenderWidgetSample {
  const markdown = DOC_SAMPLES[slug] ?? fallbackSample(title, slug);
  return { title, markdown };
}

export function getGuideWidgetSample(slug: string, title: string): RenderWidgetSample {
  const markdown = GUIDE_SAMPLES[slug] ?? fallbackSample(title, slug);
  return { title, markdown };
}

export function getShowcaseWidgetSample(slug: string, title: string): RenderWidgetSample {
  const markdown = SHOWCASE_SAMPLES[slug] ?? fallbackSample(title, slug);
  return { title, markdown };
}
