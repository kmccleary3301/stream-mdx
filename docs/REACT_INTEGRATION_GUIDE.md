# React Integration Guide — StreamMDX

**Complete guide for React developers building streaming markdown experiences in web applications.**

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Core Concepts](#core-concepts)
4. [Basic Usage Patterns](#basic-usage-patterns)
5. [Streaming from LLM/API](#streaming-from-llm-api)
6. [Custom Components](#custom-components)
7. [Custom Plugins](#custom-plugins)
8. [MDX Integration](#mdx-integration)
9. [Performance Optimization](#performance-optimization)
10. [Common Patterns](#common-patterns)
11. [Complete Examples](#complete-examples)
12. [Troubleshooting](#troubleshooting)
13. [Edge / No-worker Threads](#edge-no-worker-threads)

---

## Overview

StreamMDX is a **high-performance, streaming-first React component** designed for real-time markdown rendering. Perfect for:

- ✅ **LLM chat interfaces** (Claude, ChatGPT-style streaming responses)
- ✅ **Live documentation** (streaming tutorials, guides)
- ✅ **Code editors** (markdown preview with syntax highlighting)
- ✅ **AI writing assistants** (real-time markdown composition)
- ✅ **Technical blogs** (streaming article rendering)

### Key Features

- 🚀 **Sub-16ms performance** — Smooth 60Hz streaming updates
- ⚡ **Incremental rendering** — Only updates the "tail" block, finalized blocks never re-render
- 🎨 **Syntax highlighting** — Shiki-powered code blocks with 200+ languages
- 🔌 **Plugin system** — Extensible inline and block processing
- 🛡️ **Security-first** — Restricted Markdown avoids `unsafe-eval`; explicit trusted MDX requires it and is never a sandbox
- 📦 **Tree-shakable** — Import only what you need

---

## Quick Start

### Installation

```bash
npm install stream-mdx
```

### Worker bundle placement

In production you should host the worker bundle from static assets (stricter CSP, no `blob:`).

After installing, copy the worker into your app:

```bash
mkdir -p public/workers
cp node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js public/workers/markdown-worker.js
```

### Minimal Example

```tsx
import { StreamingMarkdown } from "stream-mdx";

export function MyComponent() {
  return (
    <StreamingMarkdown
      text="# Hello\n\nThis is **streaming** markdown!"
      worker="/workers/markdown-worker.js"
    />
  );
}
```

**That's it!** You now have a streaming markdown renderer.

### With Streaming

```tsx
import { StreamingMarkdown } from "stream-mdx";

async function* streamChunks(text: string) {
  for (const word of text.split(" ")) {
    yield `${word} `;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export function StreamingComponent({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      stream={streamChunks(text)}
      worker="/workers/markdown-worker.js"
      prewarmLangs={["typescript", "bash"]}
    />
  );
}
```

### Static / SSR Rendering (server-safe entrypoint)

For SSG/SSR, compile markdown once on the server and render blocks with the **server-safe** renderer entrypoint:

```tsx
import { MarkdownBlocksRenderer, ComponentRegistry } from "@stream-mdx/react/server";
import { compileMarkdownSnapshot } from "@stream-mdx/worker/node";

export async function ArticlePage() {
  const { blocks } = await compileMarkdownSnapshot({
    text: "# Hello\\n\\n```ts\\nconsole.log('hi')\\n```",
    init: {
      docPlugins: { tables: true, html: true, math: true, footnotes: true },
    },
  });

  const registry = new ComponentRegistry();
  return <MarkdownBlocksRenderer blocks={blocks} componentRegistry={registry} />;
}
```

Code-row HTML produced by the highlighter is sanitized on this path without a DOM: the server renderer reuses the DOM-free rehype pipeline (`packages/markdown-v2-core/src/worker-html-sanitizer.ts`) with the same `pre`/`code`/`span`/`div`/`br` + `class`/`data-*`/`style` allowlist the browser path applies through DOMPurify. Prerender therefore needs no `window`/jsdom shim, script/event/`javascript:`/`url(...)` style content is dropped on both paths, and theme CSS variables (`--shiki-*`) survive.

### Edge / No-worker Threads

If your runtime cannot spawn `worker_threads`, use the direct compile surface and render
the returned blocks with the server-safe renderer:

```tsx
import { MarkdownBlocksRenderer, ComponentRegistry } from "@stream-mdx/react/server";
import { compileMarkdownSnapshotDirect } from "stream-mdx/worker/direct";

export async function EdgeLikeArticlePage() {
  const { blocks } = await compileMarkdownSnapshotDirect({
    text: "# Hello\\n\\nEdge-safe deterministic compile.",
    init: {
      docPlugins: { tables: true, html: true, math: true, footnotes: true },
      prewarmLangs: ["typescript"],
    },
    cache: {
      dir: ".stream-mdx-cache",
    },
  });

  return <MarkdownBlocksRenderer blocks={blocks} componentRegistry={new ComponentRegistry()} />;
}
```

Cache note:
- In Node-like environments, direct compile reads/writes the same snapshot cache contract as `compileMarkdownSnapshot`.
- In edge isolates without filesystem APIs, compile still works and skips cache IO.

---

## Core Concepts

### Architecture

```
[LLM Stream] → [Web Worker] → [React Component] → [DOM]
     │              │                │              │
  append()      parse()         <StreamingMarkdown>  render
```

### Key Props

| Prop | Type | Description |
|------|------|-------------|
| `text` | `string` | Static markdown content. Changing it restarts the session. |
| `stream` | `AsyncIterable<string>` | Streaming markdown chunks. Use for live updates. |
| `worker` | `Worker \| URL \| string \| () => Worker` | Worker instance/URL/factory. Recommended: `"/workers/markdown-worker.js"`. |
| `features` | `object` | Feature flags: `{ math?, mdx?, tables?, html?, callouts?, footnotes?, formatAnticipation?, codeHighlighting? }` |
| `contentPolicy` | `"markdown" \| "restricted" \| "trusted-mdx"` | Defaults to `"restricted"`. Full MDX evaluation requires `"trusted-mdx"` and an explicit engine. |
| `contentComponents` | `ContentComponentsMap` | Host registrations for recognized restricted source components, separate from native Markdown presentation overrides. |
| `engines.mdx` | `TrustedMdxEngine` | Explicit evaluator supplied when `contentPolicy="trusted-mdx"`. |
| `components` | `NodePresentations` | Configure native block, inline (`inline:<kind>`), extension, and HTML (`html:<tag>`) presentations with wrappers, headless views, or native props. |
| `engines.math` | `MathEngine` | Replace the default KaTeX TeX renderer without changing math parsing. |
| `prewarmLangs` | `string[]` | Shiki languages to load upfront. |
| `scheduling` | `object` | Patch scheduler/backpressure knobs. |
| `managedWorker` | `boolean` | Requires a caller-initialized supplied Worker or caller-accessible factory. Drive document commands yourself or through the ref handle. URL/default sources and `engine="main-thread"` are rejected through `onError`, with no inline fallback. Factory workers terminate on detach; supplied instances remain caller-owned. |
| `onMetrics` | `function` | Performance metrics callback after each flush. |
| `onError` | `function` | Render-time error callback. |

### Streaming Behavior

- **Single dirty tail**: Only the last block updates during streaming
- **Finalized blocks**: Once finalized, blocks never re-render (stable keys)
- **Incremental parsing**: Worker parses only new content, not the entire document
- **Patch-based updates**: Efficient updates via patch operations

---

## Basic Usage Patterns

### Pattern 1: Static Content

```tsx
import { StreamingMarkdown } from "stream-mdx";

const article = `
# My Article

This is a **static** article that renders immediately.

\`\`\`typescript
const hello = "world";
\`\`\`
`;

export function Article() {
  return <StreamingMarkdown text={article} />;
}
```

### Pattern 2: Controlled Updates

```tsx
import { useState } from "react";
import { StreamingMarkdown } from "stream-mdx";

export function Editor() {
  const [markdown, setMarkdown] = useState("");

  return (
    <div>
      <textarea
        value={markdown}
        onChange={(e) => setMarkdown(e.target.value)}
        placeholder="Type markdown here..."
      />
      <StreamingMarkdown text={markdown} />
    </div>
  );
}
```

### Pattern 3: Streaming from State

```tsx
import { useState, useEffect } from "react";
import { StreamingMarkdown } from "stream-mdx";

export function StreamingView() {
  const [content, setContent] = useState("");

  useEffect(() => {
    // Simulate streaming
    const words = "This is a streaming response that appears word by word.";
    let index = 0;
    
    const interval = setInterval(() => {
      if (index < words.length) {
        setContent(prev => prev + words[index]);
        index++;
      } else {
        clearInterval(interval);
      }
    }, 50);

    return () => clearInterval(interval);
  }, []);

  return <StreamingMarkdown text={content} />;
}
```

---

## Streaming from LLM/API

### Pattern 1: Fetch Stream

```tsx
import { useEffect, useState } from "react";
import { StreamingMarkdown } from "stream-mdx";

async function* streamFromAPI(prompt: string) {
  const response = await fetch("/api/llm/stream", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value, { stream: true });
    yield chunk;
  }
}

export function LLMResponse({ prompt }: { prompt: string }) {
  const [stream, setStream] = useState<AsyncIterable<string> | null>(null);

  useEffect(() => {
    const s = streamFromAPI(prompt);
    setStream(s);
  }, [prompt]);

  if (!stream) return <div>Loading...</div>;

  return (
    <StreamingMarkdown
      stream={stream}
      prewarmLangs={["typescript", "bash", "python"]}
    />
  );
}
```

### Pattern 2: WebSocket Stream

```tsx
import { useEffect, useState, useRef } from "react";
import { StreamingMarkdown } from "stream-mdx";

export function WebSocketStream({ url }: { url: string }) {
  const [content, setContent] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      setContent(prev => prev + event.data);
    };

    return () => {
      ws.close();
    };
  }, [url]);

  return (
    <StreamingMarkdown
      text={content}
      prewarmLangs={["typescript", "bash"]}
    />
  );
}
```

### Pattern 3: SSE (Server-Sent Events)

```tsx
import { useEffect, useState } from "react";
import { StreamingMarkdown } from "stream-mdx";

export function SSEStream({ url }: { url: string }) {
  const [content, setContent] = useState("");

  useEffect(() => {
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      setContent(prev => prev + event.data);
    };

    return () => {
      eventSource.close();
    };
  }, [url]);

  return (
    <StreamingMarkdown
      text={content}
      prewarmLangs={["typescript", "bash"]}
    />
  );
}
```

### Pattern 4: Chat Interface (Multiple Messages)

```tsx
import { useState } from "react";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "stream-mdx";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
}

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentStreaming, setCurrentStreaming] = useState<string>("");
  const handleRef = useRef<StreamingMarkdownHandle>(null);

  async function sendMessage(text: string) {
    // Add user message
    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: "user",
      content: text,
    }]);

    // Start streaming assistant response
    setCurrentStreaming("");
    const response = await fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: text }),
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let assistantContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      assistantContent += chunk;
      setCurrentStreaming(assistantContent);
    }

    // Finalize message
    setMessages(prev => [...prev, {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: assistantContent,
    }]);
    setCurrentStreaming("");
  }

  return (
    <div className="chat-container">
      {messages.map(msg => (
        <div key={msg.id} className={`message ${msg.role}`}>
          <StreamingMarkdown text={msg.content} />
        </div>
      ))}
      
      {currentStreaming && (
        <div className="message assistant streaming">
          <StreamingMarkdown text={currentStreaming} />
        </div>
      )}
    </div>
  );
}
```

---

## Custom Components

### Override Block Components

```tsx
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";

const customPresentations = {
  heading: {
    props: { className: "scroll-m-20 text-3xl font-bold mb-4" },
  },
  code: {
    wrapper: ({ children, metadata, actions }: NodeViewProps) => (
      <section className="code-block-wrapper">
        <div className="code-header">
          <span className="language">{metadata.language ?? "text"}</span>
          <button type="button" onClick={() => void actions.copy()}>
            Copy
          </button>
        </div>
        {children}
      </section>
    ),
  },
  paragraph: {
    props: { className: "mb-4 leading-relaxed" },
  },
};

export function CustomStyledMarkdown({ text }: { text: string }) {
  return <StreamingMarkdown text={text} components={customPresentations} />;
}
```

### Mermaid Diagrams (Optional)

StreamMDX treats fenced ` ```mermaid ` code blocks as normal code blocks by default.

To render Mermaid diagrams (with a Diagram/Code toggle), install the add-on and register the `mermaid` block component:

```bash
npm install @stream-mdx/mermaid
```

```tsx
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";
import { MermaidBlock } from "@stream-mdx/mermaid";

function MermaidPresentation({ block, children, metadata, actions }: NodeViewProps) {
  if (metadata.language?.toLowerCase() !== "mermaid") return children;
  const code = block?.payload.meta?.code;
  return (
    <MermaidBlock
      code={typeof code === "string" ? code : ""}
      renderCode={children}
      language={metadata.language ?? "mermaid"}
      blockId={metadata.id}
      controls={{ copy: true }}
      copy={actions.copy}
    />
  );
}

export function MermaidDemo({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      components={{ code: { wrapper: MermaidPresentation } }}
    />
  );
}
```

`MermaidPresentation` forwards the prepared native code view as `renderCode`; other languages return `children` unchanged, preserving their streaming, highlighting, and virtualization.

### Code Fence Presentations

`components.code.wrapper` receives the native code view and `metadata.language`. Return `children` unchanged for languages that do not need a custom presentation; the native renderer keeps its streaming updates, highlighting, and virtualization.

#### Deferring heavy blocks

Use `deferHeavyBlocks` to defer heavy code blocks until they enter the viewport or idle time:

```tsx
<StreamingMarkdown
  text={content}
  deferHeavyBlocks={{ rootMargin: "200px" }}
  components={{ code: { wrapper: MermaidPresentation } }}
/>
```

### Structured Diff Rendering

With `features.emitDiffBlocks: true`, the native code view renders diff rows with line numbers and hunk metadata. Use `components.code.wrapper` to add a surrounding presentation, or `components.code.view` with `useCodeDiff` for a headless custom view.

### Math Rendering (KaTeX default and custom engines)

KaTeX is built-in as the first-party default for inline (`$...$`) and display (`$$...$$`) math.

To integrate **MathJax** instead:
```tsx
import React, { useEffect, useRef } from "react";
import { StreamingMarkdown } from "stream-mdx";
import type { MathEngine } from "stream-mdx";

function MathJaxFormula({ tex, display = false }: { tex: string; display?: boolean }) {
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const win = window as unknown as { MathJax?: { typesetPromise?: (elements: Element[]) => Promise<void> } };
    if (containerRef.current && win.MathJax?.typesetPromise) {
      containerRef.current.innerHTML = display ? `\\[${tex}\\]` : `\\(${tex}\\)`;
      win.MathJax.typesetPromise([containerRef.current]).catch((err: unknown) => {
        console.error("MathJax render error:", err);
      });
    }
  }, [tex, display]);

  return (
    <span
      ref={containerRef}
      className={display ? "mathjax-display block my-2 overflow-x-auto" : "mathjax-inline inline-block"}
    >
      {display ? `$$${tex}$$` : `$${tex}$`}
    </span>
  );
}

const mathJaxEngine: MathEngine = {
  id: "mathjax",
  render: (tex, { displayMode }) => <MathJaxFormula tex={tex} display={displayMode} />,
};

export function MathJaxArticle({ content }: { content: string }) {
  return (
    <StreamingMarkdown
      text={content}
      features={{ math: true }}
      engines={{ math: mathJaxEngine }}
    />
  );
}
```
`components["inline:math"]` remains a separate presentation layer for wrapping or replacing the view; its children are already the engine output.

### Customize Inline Presentations

```tsx
import { StreamingMarkdown } from "stream-mdx";

const inlinePresentations = {
  "inline:strong": {
    props: { className: "font-bold text-primary" },
  },
  "inline:em": {
    props: { className: "italic text-muted-foreground" },
  },
  "inline:code": {
    props: { className: "rounded bg-muted px-1.5 py-0.5 text-sm font-mono" },
  },
  "inline:link": {
    props: { className: "text-blue-600 hover:underline" },
  },
};

export function CustomInlineMarkdown({ text }: { text: string }) {
  return <StreamingMarkdown text={text} components={inlinePresentations} />;
}
```

### Table Presentation Example

Decorate the native table and its rows and cells through semantic presentation keys. The renderer keeps ownership of the table elements and their streaming updates.

```tsx
import { StreamingMarkdown, type NodeViewProps } from "stream-mdx";

const tablePresentations = {
  table: {
    wrapper: ({ children }: NodeViewProps) => (
      <div className="my-4 overflow-x-auto rounded-md border">{children}</div>
    ),
  },
  "table-row": {
    props: { className: "border-b last:border-0" },
  },
  "table-cell": {
    props: { className: "px-3 py-2 text-left" },
  },
};

export function StyledMarkdown({ text }: { text: string }) {
  return <StreamingMarkdown text={text} components={tablePresentations} />;
}
```

---

## Custom Plugins

StreamMDX supports two customization layers:

1. **Rendering (React):** use native block keys such as `code` and `table`, inline keys such as `inline:strong`, HTML keys such as `html:kbd`, and extension keys such as `extension:citation` in `components`.
2. **Syntax (worker):** use serializable `syntax` rules for supported inline patterns. Custom tokenizers and document plugins require a custom worker bundle.

`<StreamingMarkdown />` does not accept an arbitrary plugin-array prop. Built-in capabilities are toggled with `features`.

When a serializable `syntax` rule or worker plugin emits a citation extension node, render it with an extension presentation:

```tsx
import { StreamingMarkdown, type InlineNodeViewProps } from "stream-mdx";

const citationPresentations = {
  "extension:citation": {
    view: ({ node }: InlineNodeViewProps) => <sup>[{node.attrs?.id ?? ""}]</sup>,
  },
};

<StreamingMarkdown text={text} components={citationPresentations} />;
```

For end-to-end worker plugin wiring and registration order, see `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`.

---

## MDX Integration

### Restricted component content

The default `contentPolicy` is `"restricted"`. Register approved source components with `defineContentComponent`; raw component constructors are not registrations. Use a type-predicate validator for narrower source JSON props. Broad JSON-props registrations may omit the validator. Native projected `children` are passed separately as host React nodes, and are not part of the source-prop validation. This registry is active only under `"restricted"` policy, separate from `components`, which decorates native Markdown presentations.

```tsx
import { defineContentComponent, StreamingMarkdown, type ContentComponentProps, type ContentComponentsMap } from "stream-mdx";
import type { ComponentProps } from "react";
import { Callout } from "./Callout";

type CalloutSourceProps = Pick<ComponentProps<typeof Callout>, "type">;
const validateCalloutProps = (
  props: ContentComponentProps,
): props is ContentComponentProps & CalloutSourceProps =>
  props.type === "info" || props.type === "warning";

const contentComponents = {
  Callout: defineContentComponent({ component: Callout, validateProps: validateCalloutProps }),
} satisfies ContentComponentsMap;

<StreamingMarkdown
  text={content}
  features={{ mdx: true }}
  contentComponents={contentComponents}
/>;

```

When `renderWhen` is `"closed"`, only an open native component is suppressed. A finalized incomplete body that passes validation still renders with its diagnostic; an incomplete opening header remains literal and does not invoke the host component. In a React Server Component, import the pure registration factory from `@stream-mdx/react/server`, not the client root.

### Full MDX for trusted content

Full MDX evaluation is an explicit opt-in. Create a `TrustedMdxEngine` and pass it with `contentPolicy="trusted-mdx"`. Only use this path for trusted, reviewed source. It evaluates authored code in the host realm; it is not a sandbox.

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { Callout } from "./Callout";
import { createTrustedMdxEngine } from "@stream-mdx/react/trusted-mdx";

const hostWidgets = { Callout };
const mdxEngine = createTrustedMdxEngine({
  components: hostWidgets,
  imports: { "host:widgets": hostWidgets },
});

export function TrustedMdxMarkdown({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      worker="/workers/markdown-worker.js"
      features={{ mdx: true }}
      contentPolicy="trusted-mdx"
      engines={{ mdx: mdxEngine }}
    />
  );
}
```

The import map grants only the host bindings named by authored imports such as `import { Callout } from "host:widgets"`; unresolved imports fail instead of being fetched. The trusted evaluator runs `AsyncFunction` in the host realm and requires `unsafe-eval` in `script-src`. Do not enable it for untrusted content.

Native worker `FINALIZED` confirms semantic completion for that source revision only. Trusted whole-document preparation, evaluation, projection, and React commit readiness are asynchronous and separate. The trusted document tracks requested, projected, and actually rendered revisions; stale results are rejected after newer requests or lease/engine invalidation, with an ownership check immediately before authored code runs. Render failure may restore the last committed UI, but cannot undo side effects already performed by trusted code.

Trusted render regions retain exact authored UTF-16 MDAST spans and node-kind placement. The host compiler and worker share one private source-span collector. Worker recognition uses only `unified`, `remark-parse`, `remark-mdx`, and the existing `remark-gfm`/`remark-math` configuration, calling `.parse` only; it does not import, compile, or evaluate `@mdx-js/mdx`. A compiler-proven flow JSX root is projected outside native paragraphs; inline JSX and expressions remain in their native paragraph positions. For each complete flow root, the worker constructs one ordered `trustedMdxNativeChildren` ownership tree, reusing actual prepared owners and preparing only missing children through shared native inline or block machinery. The canonical tree wins, including when empty; a selected legacy HTML tree is an ownership source only when canonical children are absent. An unnamed fragment, including an unseparated Markdown body, uses MDAST spans rather than HTML-tag scanning or a new grammar. Owned children render through their existing native owners. Only genuinely compiler-owned JSX/expression children use the original compiler expression as lazy fallback. Misaligned ownership raises an error rather than hiding content. Headings, paragraphs, code, math, quotes, lists, tables, and inline MDX retain their owners and source scopes. Placement comes from MDAST, never returned host DOM. Only a `VFileMessage` from a known MDX syntax source becomes a `not-complete` span-recognition result. The worker keeps authored source native and continues to native `FINALIZED`; the host compiler owns its normal syntax diagnostic. Unexpected errors propagate.

Prepare canonical children before the single ordered document-plugin pass so footnote numbering and later definitions reach reused native children. Completed trees remain reusable when native extraction returns their source as HTML or a paragraph before MDX classification. Owned children use native view markup and controls, not the retired per-block MDX containers or compiler element classes.

A nested MDX block and its generated inline owner can refer to the same exact authored JSX region. They are aliases for one render, not separate executions. Other duplicate or crossing owner claims still fail closed.

`TrustedMdxFlowChildSpan.kind` distinguishes native `"inline"` phrasing from `"markdown"` blocks. Inline children reuse native emphasis, code, links, HTML and trusted inline slots without an unauthored paragraph wrapper; their physical whitespace is not passed through a block parse. Document-wide definitions can split compiler phrasing differently from a local native parse. An actual prepared paragraph may own the exact union of contiguous inline spans: its shared inline body renders once, and typed continuations cover the remaining slots. Partial coverage, gaps, duplicate owners and non-inline crossings still fail. Exact JSX frames own descendant regions, which are not mounted again as additional roots. Cache pure artifacts by exact source and `compilerIdentity`; inline-child metadata uses `native-flow-children-v5`, separate from native `streammdx.snapshot.v1`.

For a React Server Component handoff, `projectTrustedMdxServerDocument` keeps evaluator closures, host component maps, and the authored layout on the server. It sends the client renderer `ReactNode` content plus serializable native-owner identities and their compiler-authored child spans through `TrustedMdxServerRegionProvider`. The private client slot uses indexed native owners for represented children and carries already-rendered compiler fallback nodes only for unowned children; no fallback closures cross the handoff. Flow-owned worker blocks are not also emitted as top-level siblings. The native block renderer remains the owner of nested Markdown preparation and wrappers.

`contentComponents` is only the restricted native component path; it is not used by `"markdown"` or `"trusted-mdx"` policies. `contentPolicy="trusted-mdx"` requires `engines.mdx`; there is no compile-mode prop or source-triggered worker evaluator. See the [Security Model](./SECURITY_MODEL.md) before enabling it.

### Feature Flags: Math, HTML, MDX, Format Anticipation

The `features` prop on `<StreamingMarkdown />` controls built‑in domains:

```tsx
<StreamingMarkdown
  text={text}
  features={{
    math: true,
    mdx: true,
    html: true,
    tables: true,
    callouts: true,
    footnotes: true,
    formatAnticipation: false,
    codeHighlighting: "incremental",
  }}
/>
```

- Set `math: false` to disable math detection/rendering and treat math as plain text.
- Set `mdx: false` to skip MDX syntax recognition and admission.
- Set `html: false` to avoid inline/block HTML plugins beyond the core sanitization path.
- Set `formatAnticipation: true` to withhold formatting markers while streaming (initial support: `*`, `**`, `` ` ``, `~~`).
- Set `codeHighlighting: "final" | "incremental" | "live"` to control Shiki behavior:
  - `"final"` (default): highlight only after a code block finalizes.
  - `"incremental"`: highlight completed lines as they arrive.
  - `"live"`: re-highlight on every update (slowest, highest fidelity).

Under the hood these flags drive worker doc plugins and React bindings for those domains without you having to touch internal APIs.

### Math Delimiters (Markdown vs MDX)

By default:

- Streaming math treats `$…$` as inline math and `$$…$$` as display/block math.
- The MDX pipeline uses `remark-math`, which understands both `$`/`$$` and `\\(…\\)` / `\\[…\\]` syntaxes.

If you need a different policy (for example, only `\\(…\\)` and `\\[…\\]` as used in ChatGPT’s renderer):

- For **MDX**, you would adjust the `remark-math` options (e.g., `singleDollarTextMath: false`) in a fork or custom integration.
- For **streaming Markdown**, you would customize the worker bundle to use different patterns/tokenizers.

These are plugin‑level customizations rather than runtime props, but the pipeline is modular enough to support them when needed.

---

## Performance Optimization

### 1. Prewarm Languages

```tsx
<StreamingMarkdown
  text={content}
  prewarmLangs={[
    "typescript",
    "tsx",
    "javascript",
    "bash",
    "markdown",
    "json",
    "yaml",
  ]}
/>
```

### 2. Monitor Performance

```tsx
import { StreamingMarkdown } from "stream-mdx";
import type { RendererMetrics } from "stream-mdx";

function onMetrics(metrics: RendererMetrics) {
  // Log performance data
  console.log("Queue depth:", metrics.queueDepthBefore);
  console.log("Flush duration:", metrics.durationMs);
  
  // Alert if performance degrades
  if (metrics.durationMs > 16) {
    console.warn("Frame budget exceeded!");
  }
  
  // Send to analytics
  if (window.analytics) {
    window.analytics.track("markdown_flush", {
      duration: metrics.durationMs,
      queueDepth: metrics.queueDepthBefore,
    });
  }
}

<StreamingMarkdown
  text={content}
  onMetrics={onMetrics}
/>
```

### 3. Adjust Scheduling

```tsx
<StreamingMarkdown
  text={content}
  scheduling={{
    batch: "microtask", // Lowest latency; falls back when unavailable
    frameBudgetMs: 10, // Smaller = more responsive, slower completion
    lowPriorityFrameBudgetMs: 6,
    maxBatchesPerFlush: 12,
    maxLowPriorityBatchesPerFlush: 2,
    urgentQueueThreshold: 4,
    adaptiveSwitch: false, // Disable auto-switching to smooth scheduling
    historyLimit: 200, // Keep patch history manageable
  }}
/>
```

### 4. Use Imperative Handle for Control

```tsx
import { useRef } from "react";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "stream-mdx";

export function ControlledStreaming({ stream }: { stream: AsyncIterable<string> }) {
  const handleRef = useRef<StreamingMarkdownHandle>(null);

  function pause() {
    handleRef.current?.pause();
  }

  function resume() {
    handleRef.current?.resume();
  }

  async function waitForCompletion() {
    await handleRef.current?.waitForIdle();
    console.log("Streaming complete!");
  }

  return (
    <div>
      <div className="controls">
        <button onClick={pause}>Pause</button>
        <button onClick={resume}>Resume</button>
        <button onClick={waitForCompletion}>Wait for Completion</button>
      </div>
      <StreamingMarkdown
        ref={handleRef}
        stream={stream}
      />
    </div>
  );
}
```

---

## Common Patterns

### Pattern 0: Streaming polish (caret + link safety + deferred blocks)

```tsx
import { StreamingMarkdown } from "stream-mdx";

export function StreamingMessage({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      caret="block"
      linkSafety={{ enabled: true }}
      deferHeavyBlocks={{ rootMargin: "200px 0px" }}
    />
  );
}
```

### Pattern 1: Chat Interface with Message History

```tsx
import { useState } from "react";
import { StreamingMarkdown } from "stream-mdx";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentAssistant, setCurrentAssistant] = useState<string>("");

  async function handleSend(userMessage: string) {
    // Add user message
    setMessages(prev => [...prev, {
      id: `user-${Date.now()}`,
      role: "user",
      content: userMessage,
      timestamp: new Date(),
    }]);

    // Stream assistant response
    setCurrentAssistant("");
    const response = await fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: userMessage }),
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let content = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      content += decoder.decode(value, { stream: true });
      setCurrentAssistant(content);
    }

    // Finalize
    setMessages(prev => [...prev, {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content,
      timestamp: new Date(),
    }]);
    setCurrentAssistant("");
  }

  return (
    <div className="chat-container">
      {messages.map(msg => (
        <div key={msg.id} className={`message ${msg.role}`}>
          <StreamingMarkdown text={msg.content} />
        </div>
      ))}
      {currentAssistant && (
        <div className="message assistant streaming">
          <StreamingMarkdown text={currentAssistant} />
        </div>
      )}
    </div>
  );
}
```

### Pattern 2: Code Block with Copy Button

```tsx
import { StreamingMarkdown } from "stream-mdx";
import type { BlockComponents } from "stream-mdx";

const components: Partial<BlockComponents> = {
  code: ({ html, meta }) => {
    const code = meta?.rawCode as string || "";
    const lang = meta?.lang as string || "text";

    return (
      <div className="relative group">
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => {
              navigator.clipboard.writeText(code);
              // Show toast notification
            }}
            className="px-2 py-1 text-xs bg-gray-800 text-white rounded"
          >
            Copy
          </button>
        </div>
        <div
          className="code-block"
          dangerouslySetInnerHTML={{ __html: html || "" }}
        />
      </div>
    );
  },
};

<StreamingMarkdown text={content} components={components} />
```

### Pattern 3: Loading States

```tsx
import { StreamingMarkdown, type StreamingMarkdownHandle } from "stream-mdx";
import { useRef, useState, useEffect } from "react";

export function StreamingWithLoading({ stream }: { stream: AsyncIterable<string> }) {
  const handleRef = useRef<StreamingMarkdownHandle>(null);
  const [isStreaming, setIsStreaming] = useState(true);

  useEffect(() => {
    // Monitor streaming state
    const checkInterval = setInterval(async () => {
      const state = handleRef.current?.getState();
      if (state && state.queueDepth === 0 && state.pendingBatches === 0) {
        setIsStreaming(false);
        clearInterval(checkInterval);
      }
    }, 100);

    return () => clearInterval(checkInterval);
  }, []);

  return (
    <div>
      {isStreaming && (
        <div className="loading-indicator">
          <span>Streaming...</span>
        </div>
      )}
      <StreamingMarkdown
        ref={handleRef}
        stream={stream}
      />
    </div>
  );
}
```

### Pattern 4: Error Handling

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { useState } from "react";

export function StreamingWithErrorHandling({ stream }: { stream: AsyncIterable<string> }) {
  const [error, setError] = useState<Error | null>(null);

  return (
    <div>
      {error && (
        <div className="error-banner">
          Error: {error.message}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      <StreamingMarkdown
        stream={stream}
        onError={(err) => {
          setError(err);
          console.error("Markdown render error:", err);
        }}
      />
    </div>
  );
}
```

---

## Complete Examples

### Example 1: Full-Featured Chat Interface

```tsx
import { useState } from "react";
import { StreamingMarkdown } from "stream-mdx";

export function FullChatInterface() {
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");

  const markdownProps = {
    worker: "/workers/markdown-worker.js",
    features: { math: true, tables: true, html: true },
    contentPolicy: "restricted" as const,
    prewarmLangs: ["typescript", "bash", "python"],
  };

  async function handleSubmit() {
    if (!input.trim()) return;

    const userMessage = input;
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMessage }]);

    // Stream response
    const response = await fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: userMessage }),
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let content = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      content += decoder.decode(value, { stream: true });
      setStreaming(content);
    }

    setMessages(prev => [...prev, { role: "assistant", content }]);
    setStreaming("");
  }

  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <StreamingMarkdown
              text={msg.content}
              {...markdownProps}
            />
          </div>
        ))}
        {streaming && (
          <div className="message assistant streaming">
            <StreamingMarkdown
              text={streaming}
              {...markdownProps}
            />
          </div>
        )}
      </div>
      <div className="input-area">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="Type your message..."
        />
        <button onClick={handleSubmit}>Send</button>
      </div>
    </div>
  );
}
```

### Example 2: Documentation Viewer with TOC

```tsx
import { useState, useEffect } from "react";
import { StreamingMarkdown } from "stream-mdx";

export function DocumentationViewer({ url }: { url: string }) {
  const [content, setContent] = useState("");
  const [headings, setHeadings] = useState<Array<{ id: string; text: string; level: number }>>([]);

  useEffect(() => {
    fetch(url)
      .then(res => res.text())
      .then(setContent);
  }, [url]);

  // Extract headings for TOC (simplified)
  useEffect(() => {
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    const matches = Array.from(content.matchAll(headingRegex));
    setHeadings(
      matches.map((match, i) => ({
        id: `heading-${i}`,
        text: match[2],
        level: match[1].length,
      }))
    );
  }, [content]);

  return (
    <div className="docs-container">
      <aside className="toc">
        <h2>Table of Contents</h2>
        <ul>
          {headings.map(heading => (
            <li key={heading.id} style={{ paddingLeft: `${(heading.level - 1) * 1}rem` }}>
              <a href={`#${heading.id}`}>{heading.text}</a>
            </li>
          ))}
        </ul>
      </aside>
      <main className="content">
        <StreamingMarkdown
          text={content}
          prewarmLangs={["typescript", "bash", "markdown"]}
        />
      </main>
    </div>
  );
}
```

---

## Troubleshooting

### Worker Not Loading

**Problem**: Worker fails to initialize or CSP errors.

**Solutions**:
- Use a hosted worker URL instead of Blob (recommended):
  ```tsx
  <StreamingMarkdown
    worker="/workers/markdown-worker.js"
  />
  ```
- Check CSP headers allow worker execution
- Verify worker file is served correctly

### Performance Issues

**Problem**: Slow rendering or janky updates.

**Solutions**:
- Reduce `frameBudgetMs` or add batch caps in `scheduling`
- Prewarm common languages
- Monitor metrics and adjust frame budget
- Use virtualization for long documents

### Custom Plugins Not Working

**Problem**: Custom syntax not being recognized.

**Solutions**:
- Built-in domains are toggled with `features`.
- Use serializable `syntax` rules for supported inline patterns; custom tokenizers and document plugins require a custom worker bundle.
- Render emitted extension nodes with `components["extension:<name>"]`.

### MDX Content Not Rendering as Expected

**Problem**: Component tags stay restricted instead of evaluating as full MDX.

**Solutions**:
- The default `contentPolicy` is `"restricted"` and does not evaluate authored expressions.
- Register fixed host components with `defineContentComponent` and `contentComponents` under the restricted policy.
- For trusted, reviewed full MDX, create a `TrustedMdxEngine` and pass it through `engines.mdx` with `contentPolicy="trusted-mdx"`.
- Full MDX runs authored code in the host realm; do not enable it for untrusted input.

### Colors Not Showing in Code Blocks

**Problem**: Code blocks render without syntax highlighting.

**Solutions**:
- Ensure language is in `prewarmLangs`
- Check Shiki theme is loaded
- Verify `highlightedHtml` is present in block payload
- Check browser console for highlighting errors

---

## Next Steps

1. **Read the Public API docs**: `docs/PUBLIC_API.md`
2. **Worker + CSP notes**: `docs/STREAMING_MARKDOWN_V2_STATUS.md`
3. **MDX + customization**: `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`
4. **Release checklist**: `docs/STREAMING_MARKDOWN_RELEASE_CHECKLIST.md`
5. **Review examples**: `examples/streaming-markdown-starter`

---

## Summary

You now have everything you need to:

- Render streaming markdown (basic and advanced patterns)
- Stream from LLMs/APIs (fetch, WebSocket, SSE examples)
- Customize components (block and inline overrides)
- Extend syntax via custom worker bundles (advanced)
- Integrate restricted components or opt into full MDX with an explicit trusted engine
- Optimize performance (metrics, scheduling, prewarming)

StreamMDX is designed for production React applications; start with the defaults, then tighten CSP and tuning knobs as you scale.
