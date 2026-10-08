# StreamMDX Plugin & Extension ABI

StreamMDX provides multiple extension surfaces designed for streaming performance, parser correctness, and ease of integration.

---

## 1) Declarative Syntax Rules (`syntax`)

Declarative syntax rules allow extending inline markdown syntax directly from the UI layer (`<StreamingMarkdown syntax={[...]} />`) without compiling or bundling a custom worker.

### 1.1 Specification (`SyntaxRuleSpec`)

```ts
export interface SyntaxRuleSpec {
  /** Unique name for the syntax node */
  name: string;
  /** Regex pattern (compiled sticky at cursor) */
  pattern: {
    source: string;
    flags?: string;
  };
  /** Fast character check before executing regex */
  trigger?: string;
  /** Lezer inline parser precedence, e.g. 'Emphasis' */
  before?: string;
  /** Attribute mapping from capture group index or literal values */
  attrs?: Record<string, number | string>;
  /** Capture group index to parse recursively as inline children */
  content?: number;
  /** Streaming anticipation markers */
  anticipation?: {
    open: string;
    close: string;
  };
}
```

### 1.2 Behavior & Error Recovery Contract

- **INIT Validation**: During worker `INIT`, syntax rules are validated. If a rule specifies an invalid regular expression:
  - An `ERROR` message is posted with phase `"INIT"` and `{ rule: rule.name }`.
  - The worker **skips the invalid rule** and proceeds with initialization of all remaining valid rules.
  - This ensures a single broken user regex does not crash the worker or brick rendering.
- **Node Output**: Emits an `InlineNode` of kind `"plugin"`:
  ```ts
  {
    kind: "plugin",
    name: rule.name,
    attrs: { ... },
    children: [ ... ],
    raw: "#ABC-1"
  }
  ```
- **React Rendering**: Rendered via `<StreamingMarkdown inlineComponents={{ [rule.name]: Component }} />`. If unmapped, falls back to rendering the raw text.
- **Anticipation**: During streaming, an unclosed `open` delimiter at the buffer tail triggers anticipation, rendering the node with partial content until finalized.

---

## 2) HTML Control (`html`)

StreamMDX provides fine-grained control over HTML tags and attributes via the `html` configuration:

```ts
<StreamingMarkdown
  html={{
    allowedTags: {
      kbd: ["data-x", "hotkey"],
      callout: ["type", "collapsible"],
    },
    literalTagContent: ["kbd", "code", "pre"],
  }}
  htmlElements={{
    kbd: CustomKbd,
    callout: CalloutView,
  }}
/>
```

- **`allowedTags`**: Maps allowed custom or standard HTML tag names to an allowlist of permitted attribute names. Unlisted attributes are stripped during worker sanitization.
- **`literalTagContent`**: Array of tag names whose text contents must **not** be parsed as markdown (treated as literal raw text). For tags not in this list, inner markdown formatting (e.g. `<span>**bold**</span>`) is parsed and rendered.
- **`htmlElements`**: Map of custom React components for rendering allowed HTML tags.

---

## 3) Worker In-Process Extensions

When hosting or bundling your own markdown worker, you can inject native Lezer and document extensions directly into the `MarkdownEngine`:

```ts
import { serveMarkdownWorker, createInlineEngineWorker } from "@stream-mdx/worker/engine";

serveMarkdownWorker({
  extensions: {
    markdown: [ /* Lezer MarkdownConfig extensions */ ],
    inline: [ /* Lezer InlineExtension objects */ ],
    documentPlugins: [ /* DocumentPlugin instances */ ],
    syntax: [ /* Server-side default SyntaxRuleSpec rules */ ],
  },
});
```

For main-thread execution or embedded environments without a separate worker process, `createInlineEngineWorker({ extensions })` accepts the exact same options.

---

## 4) Document Plugins (`DocumentPlugin`)

Document plugins run post-parse within the `MarkdownEngine` instance:

```ts
export interface DocumentPlugin {
  name: string;
  onBegin?(ctx: DocumentContext): void;
  process(ctx: DocumentContext): undefined | DocumentContribution;
  onEnd?(ctx: DocumentContext): undefined | DocumentContribution;
}
```

Registered document plugins can inspect and mutate AST blocks or append synthetic blocks (e.g. footnotes, TOC metadata).
