# StreamMDX Plugin ABI (Worker + Parser)

This document describes the **plugin ABI** for StreamMDX’s V2 pipeline. It focuses on **worker‑side parsing** and **document‑phase aggregation**, plus the inline plugin system in `@stream-mdx/core`.

If you simply need tables, math, HTML, MDX, or callouts, use the `features` prop on `<StreamingMarkdown />` instead of custom plugins:

```tsx
<StreamingMarkdown features={{ tables: true, html: true, math: true, mdx: true, footnotes: true }} />
```

Use the plugin ABI when you are building a **custom worker bundle** or integrating StreamMDX into another system that needs custom syntax.

---

## 1) Plugin Layers

### 1.1 Markdown Plugins (Lezer + streaming)
These plugins participate in the worker’s Lezer‑based parser and incremental streaming matcher. They live in `@stream-mdx/plugins`.

**Key interface:** `MarkdownPlugin` (`packages/markdown-v2-plugins/src/plugins/base.ts`)

```ts
export interface MarkdownPlugin {
  name: string;
  priority: number;
  patterns: PluginPatterns;
  tokenizer: ExternalTokenizer;
  contextTracker?: ContextTracker<unknown>;
  renderer?: unknown;
  streamingHandler: IncrementalMatchHandler;
  config?: PluginConfig;
}
```

- **patterns**: regexes used by streaming matchers and conflict resolution.
- **tokenizer**: Lezer external tokenizer used during parsing.
- **streamingHandler**: incremental matcher used during streaming (`checkPartialMatch`, `completeMatch`).
- **priority**: used to resolve conflicts between overlapping plugins.

### 1.2 Document Plugins (post‑parse aggregation)
Document plugins run after blocks are built and can mutate blocks or append synthetic blocks (e.g., footnotes).

**Key interfaces:** `DocumentPlugin`, `DocumentContext`, `DocumentContribution` (`packages/markdown-v2-plugins/src/plugins/document.ts`)

```ts
export interface DocumentPlugin {
  name: string;
  onBegin?(ctx: DocumentContext): void;
  process(ctx: DocumentContext): undefined | DocumentContribution;
  onEnd?(ctx: DocumentContext): undefined | DocumentContribution;
}
```

### 1.3 Inline Plugins (core inline parser)
Inline plugins live in `@stream-mdx/core` and plug into `InlineParser`:

- `InlinePlugin` (AST visitor)
- `RegexInlinePlugin`
- `ASTInlinePlugin`

These run over inline nodes for paragraphs/list items. See `packages/markdown-v2-core/src/types.ts` and `inline-parser.ts`.

---

## 2) Registration APIs

### 2.1 Markdown Plugins
Use the global registry exported from `@stream-mdx/plugins`:

```ts
import { globalPluginRegistry } from "@stream-mdx/plugins";
import type { MarkdownPlugin } from "@stream-mdx/plugins";

const myPlugin: MarkdownPlugin = {
  name: "my-plugin",
  priority: 50,
  patterns: {
    start: /@@/,
    end: /@@/,
    full: /@@[\s\S]+?@@/,
    multiline: true,
    minLength: 4,
  },
  tokenizer: myTokenizer,
  streamingHandler: myStreamingHandler,
};

globalPluginRegistry.register(myPlugin);
```

### 2.2 Document Plugins

```ts
import { globalDocumentPluginRegistry } from "@stream-mdx/plugins";

globalDocumentPluginRegistry.register({
  name: "my-doc-plugin",
  process(ctx) {
    // mutate ctx.blocks or append synthetic blocks
    return { syntheticBlocks: [] };
  },
});
```

---

## 3) Conflict Resolution

`PluginRegistry` supports multiple conflict strategies:

- `PRIORITY` (default)
- `LONGEST_MATCH`
- `CONFIDENCE`
- `FIRST_REGISTERED`

Set via:

```ts
import { ConflictResolution, globalPluginRegistry } from "@stream-mdx/plugins";

globalPluginRegistry.setConflictResolution(ConflictResolution.PRIORITY);
```

---

## 4) Streaming Handler Contract

`IncrementalMatchHandler` must be deterministic and inexpensive:

- `checkPartialMatch(content)` should be **fast** (ideally regex + minimal parsing)
- `completeMatch(content)` should return:
  - `success` boolean
  - `metadata` with `start`, `end`, `plugin`, `type`, and `data`

If you cannot complete a match quickly, return `success: false` rather than blocking the worker.

---

## 5) Protected Ranges

The worker maintains **protected ranges** (math, code, HTML, autolinks). Plugins should **avoid** mutating or claiming ranges that overlap protected spans unless explicitly intended.

Guidelines:

- If your plugin introduces new inline syntax that should not be interpreted as MDX/HTML, add protected ranges to `meta.protectedRanges` (worker path).
- Avoid defining patterns that overlap `$...$`, `` `...` ``, fenced code, or HTML blocks unless you also supply a conflict strategy.

---

## 6) Performance & Safety Guidance

- **Regex patterns**: avoid catastrophic backtracking; prefer anchored or bounded regex.
- **Streaming handler**: keep partial checks O(n) or better for the examined chunk.
- **Tokenizer**: avoid heavy allocations per token.
- **Avoid global state** unless you explicitly reset it in `reset()` or `onBegin()`.

---

## 7) Testing & Validation

Recommended checks for custom plugins:

- Unit tests for match boundaries and conflict resolution.
- Streaming tests with chunked input (ensure incremental matches finalize correctly).
- Replay harness: record patches and verify deterministic output.

Helpful tooling:

- `scripts/capture-content-mixing.ts`
- `scripts/run-markdown-v2-capture.ts`
- `scripts/replay-markdown-patches.ts`

---

## 8) Related Docs

- `docs/STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`
- `docs/REACT_INTEGRATION_GUIDE.md`
- `docs/PUBLIC_API.md`
