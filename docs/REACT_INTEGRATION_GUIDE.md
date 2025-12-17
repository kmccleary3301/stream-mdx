# React Integration Guide — StreamMDX

**Complete guide for React developers building streaming markdown experiences in web applications.**

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Core Concepts](#core-concepts)
4. [Basic Usage Patterns](#basic-usage-patterns)
5. [Streaming from LLM/API](#streaming-from-llmapi)
6. [Custom Components](#custom-components)
7. [Custom Plugins](#custom-plugins)
8. [MDX Integration](#mdx-integration)
9. [Performance Optimization](#performance-optimization)
10. [Common Patterns](#common-patterns)
11. [Complete Examples](#complete-examples)
12. [Troubleshooting](#troubleshooting)

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
- 🛡️ **Security-first** — CSP-compliant, no `unsafe-eval`, Trusted Types support
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
| `features` | `object` | Feature flags: `{ math?, mdx?, tables?, html?, callouts?, footnotes? }` |
| `mdxCompileMode` | `"server" \| "worker"` | Enables MDX compilation/hydration and selects strategy. |
| `mdxComponents` | `object` | Component map passed to hydrated MDX blocks. |
| `components` | `object` | Override block components (headings, code, tables, etc.). |
| `inlineComponents` | `object` | Override inline components (bold, links, code, etc.). |
| `tableElements` | `object` | Override table tags (Shadcn table wrappers, etc.). |
| `htmlElements` | `object` | Override HTML tag renders (when HTML is enabled). |
| `prewarmLangs` | `string[]` | Shiki languages to load upfront. |
| `scheduling` | `object` | Patch scheduler/backpressure knobs. |
| `managedWorker` | `boolean` | When `true`, you drive `append/finalize` via the ref handle. |
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
import { StreamingMarkdown } from "stream-mdx";
import type { BlockComponents } from "stream-mdx";

const customComponents: Partial<BlockComponents> = {
  heading: ({ level, children, ...props }) => {
    const Tag = `h${level}` as keyof JSX.IntrinsicElements;
    return (
      <Tag 
        {...props}
        className="scroll-m-20 text-3xl font-bold mb-4"
        id={`heading-${level}`}
      >
        {children}
      </Tag>
    );
  },

  code: ({ html, meta, ...props }) => {
    const lang = meta?.lang as string | undefined;
    return (
      <div className="code-block-wrapper">
        <div className="code-header">
          <span className="language">{lang || "text"}</span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(meta?.rawCode as string || "");
            }}
          >
            Copy
          </button>
        </div>
        <div
          className="code-content"
          dangerouslySetInnerHTML={{ __html: html || "" }}
        />
      </div>
    );
  },

  paragraph: ({ children, ...props }) => (
    <p {...props} className="mb-4 leading-relaxed">
      {children}
    </p>
  ),
};

export function CustomStyledMarkdown({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      components={customComponents}
    />
  );
}
```

### Override Inline Components

```tsx
import { StreamingMarkdown } from "stream-mdx";
import type { InlineComponents } from "stream-mdx";

const customInlineComponents: Partial<InlineComponents> = {
  strong: ({ children }) => (
    <strong className="font-bold text-primary">{children}</strong>
  ),

  em: ({ children }) => (
    <em className="italic text-muted-foreground">{children}</em>
  ),

  code: ({ children }) => (
    <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono">
      {children}
    </code>
  ),

  link: ({ href, children }) => (
    <a
      href={href}
      className="text-blue-600 hover:underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
};

export function CustomInlineMarkdown({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      inlineComponents={customInlineComponents}
    />
  );
}
```

### ShadCN Integration Example

```tsx
import { StreamingMarkdown } from "stream-mdx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const shadcnComponents = {
  table: ({ children, ...props }) => (
    <div className="my-4 rounded-md border">
      <Table {...props}>{children}</Table>
    </div>
  ),
  thead: TableHeader,
  tbody: TableBody,
  tr: TableRow,
  th: TableHead,
  td: TableCell,

  blockquote: ({ children, ...props }) => (
    <Card className="my-4 border-l-4 border-l-primary">
      <CardContent className="pt-6">
        {children}
      </CardContent>
    </Card>
  ),
};

export function ShadCNMarkdown({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      components={shadcnComponents}
    />
  );
}
```

---

## Custom Plugins

StreamMDX supports two layers of customization:

1. **Rendering customization (React)**: use `components`, `inlineComponents`, `tableElements`, and `htmlElements`.
2. **Syntax customization (Worker)**: adding new tokenizers/streaming matchers requires a custom worker bundle.

`<StreamingMarkdown />` does **not** accept an arbitrary plugin array prop. Built-in capabilities are toggled via `features`.

If you need custom syntax (citations, mentions, domain-specific tags), the recommended path is:

- Build a custom worker bundle that registers your plugins using `@stream-mdx/plugins/*`.
- Host that worker (static asset) and pass its URL via the `worker` prop.
- Render custom inline tokens via `inlineComponents` (once your worker emits them).

Example inline renderer (React side):

```tsx
const inlineComponents = {
  citation: ({ id }: { id: string }) => <sup>[{id}]</sup>,
};

<StreamingMarkdown text={text} inlineComponents={inlineComponents} />;
```

For end-to-end worker plugin wiring and registration order, see `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`.

---

## MDX Integration

### Basic MDX Setup

```tsx
import { StreamingMarkdown } from "stream-mdx";

const mdxComponents = {
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 {...props} className="text-4xl font-bold mb-4" />
  ),
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props} className="text-3xl font-semibold mb-3" />
  ),
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props} className="mb-3 leading-relaxed" />
  ),
  YouTube: ({ id }: { id: string }) => (
    <iframe
      width="560"
      height="315"
      src={`https://www.youtube.com/embed/${id}`}
      frameBorder="0"
      allowFullScreen
    />
  ),
  Callout: ({ type, children }: { type: "info" | "warn"; children: React.ReactNode }) => (
    <div className={`border-l-4 p-4 my-4 ${
      type === "warn" ? "border-yellow-500 bg-yellow-50" : "border-blue-500 bg-blue-50"
    }`}>
      {children}
    </div>
  ),
};

export function MDXMarkdown({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      worker="/workers/markdown-worker.js"
      features={{ mdx: true, math: true, tables: true, html: true }}
      mdxCompileMode="worker"
      mdxComponents={mdxComponents}
    />
  );
}
```

### Server vs Worker MDX — Parity and Strategy

StreamMDX supports two MDX compilation strategies:

- `mdxCompileMode="server"` – MDX blocks are compiled via the `/api/mdx-compile-v2` endpoint.
- `mdxCompileMode="worker"` – MDX is compiled inside the worker bundle itself.

Both strategies can share the **same MDX compilation pipeline** when you use the exported helper:

- `remark-gfm` and `remark-math` for markdown + math parsing.
- `rehype-slug` and `rehype-katex` for headings and math HTML.
- `@mdx-js/mdx` with `outputFormat: "function-body"` and the React JSX runtime.

The worker compilation path uses the same pipeline; for server compilation, use `compileMdxContent` from `stream-mdx/worker/mdx-compile` (or `@stream-mdx/worker/mdx-compile`) to keep parity.

For strict CSP or centralized caching, prefer **server** mode. For lower latency or offline scenarios, prefer **worker** mode. In either case, you can assume **matching HTML/DOM output and hydration behavior** for the same MDX source and `components` map.

### MDX with Server Compilation

```tsx
import { StreamingMarkdown } from "stream-mdx";

export function ServerMDX({ text }: { text: string }) {
  return (
    <StreamingMarkdown
      text={text}
      features={{ mdx: true }}
      mdxCompileMode="server" // Uses /api/mdx-compile-v2 endpoint
    />
  );
}
```

**API Route (`app/api/mdx-compile-v2/route.ts`):**

```ts
import { NextRequest, NextResponse } from "next/server";
import { compileMdxContent } from "stream-mdx/worker/mdx-compile";

export async function POST(request: NextRequest) {
  const { content, blockId } = await request.json();
  
  try {
    const compiled = await compileMdxContent(content);

    return NextResponse.json({
      // `blockId` comes from the client and is used for caching.
      id: blockId,
      code: compiled.code,
      dependencies: compiled.dependencies,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "MDX compilation failed" },
      { status: 500 }
    );
  }
}
```

### Feature Flags: Math, HTML, MDX

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
  }}
/>
```

- Set `math: false` to disable math detection/rendering and treat math as plain text.
- Set `mdx: false` to skip MDX detection/compilation and render MDX markup as regular markdown/text.
- Set `html: false` to avoid inline/block HTML plugins beyond the core sanitization path.

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
    batch: "rAF", // Use requestAnimationFrame
    frameBudgetMs: 8, // Smaller = more responsive, slower completion
    lowPriorityFrameBudgetMs: 4,
    maxBatchesPerFlush: 5,
    maxLowPriorityBatchesPerFlush: 1,
    urgentQueueThreshold: 3,
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
    features: { math: true, mdx: true, tables: true, html: true },
    mdxCompileMode: "worker" as const,
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
- StreamMDX only exposes built-in domains via `features` on `<StreamingMarkdown />`.
- For custom syntax you need a custom worker bundle that registers your plugins; then pass that worker URL via `worker`.
- Use `inlineComponents` / `components` to render any custom nodes emitted by your worker.

### MDX Not Compiling

**Problem**: MDX blocks show as raw code.

**Solutions**:
- Set `features={{ mdx: true }}`
- Set `mdxCompileMode="worker"` (no server) or `mdxCompileMode="server"` (requires `/api/mdx-compile-v2`)
- Check MDX compilation endpoint is working
- Verify you passed `mdxComponents` for your custom MDX components

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
- Integrate MDX (server and worker compilation)
- Optimize performance (metrics, scheduling, prewarming)

StreamMDX is designed for production React applications; start with the defaults, then tighten CSP and tuning knobs as you scale.
