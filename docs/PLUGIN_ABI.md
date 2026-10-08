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
- **Anticipation**: During streaming, an unclosed `open` delimiter at the buffer tail triggers anticipation, rendering the node with partial content until finalized. A partial closing delimiter contributes only its missing suffix, including when `open` and `close` are identical multi-character markers.

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
- **`literalTagContent`**: Case-insensitive tag names whose contents stay literal, including all descendants. Inline HTML normally retains parsed markdown children. Native CommonMark HTML blocks stay raw unless this option is explicitly supplied. Supplying `[]` opts block text into markdown; supplying `["span"]` opts other block text into markdown but keeps `<span>**bold**</span>` literal. The native raw tags `code`, `pre`, and `textarea` always remain literal, even with `[]`. Changing `allowedTags` or `htmlElements` alone does not opt block text into markdown.
- **`htmlElements`**: Map of custom React components for rendering allowed HTML tags.
- Opted-in HTML text uses the owning engine's inline parser and the current consumer's inline component mapping. Declarative syntax, native inline extensions, and the math feature setting apply without creating a second parser or reparsing text during rendering. Prepared HTML children also render through custom mappings on the server.

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
