# StreamMDX plugin and extension ABI

## 1) Declarative syntax extensions

Pass `syntax` to `<StreamingMarkdown />` as a `SyntaxExtensionDescriptor`, exported by `@stream-mdx/core` and `@stream-mdx/react`. It is a serializable descriptor with required `contractVersion: 1` and optional `inline` and `containers` arrays. Inline rules use `SyntaxRuleSpec`; it is not a `RegExp` or callback. There is no separate `SerializedSyntaxRuleSpec` export.

```ts
import type { SyntaxRuleSpec } from "@stream-mdx/core";

const ticketRule: SyntaxRuleSpec = {
  name: "ticket",
  pattern: { source: "#([A-Z]+-\\d+)(?=\\s|$)" },
  trigger: "#",
  attrs: { id: 1, category: "issue" },
};
```

| Field | Type | Contract |
| --- | --- | --- |
| `name` | `string` | Plugin name and React component-map key. Use distinct names. |
| `pattern` | `{ source: string; flags?: string }` | JavaScript regex source and flags. The parser removes `g`/`y` and matches sticky at the current inline cursor. Empty matches are ignored. |
| `trigger` | `string` | Optional exact prefix check before regex execution. |
| `maxCandidateUnits` | `number` | Optional positive integer limiting the UTF-16 code units passed to this rule's regex. Oversized candidates remain literal and emit a diagnostic; omitted means no limit. |
| `before` | `string` | Lezer inline parser precedence. Defaults to `"Link"`. |
| `attrs` | `Record<string, number \| string>` | Numbers select capture groups; strings are literal values. Output values are strings, with absent captures becoming `""`. |
| `content` | `number` | Capture group to parse recursively as inline markdown children. |
| `anticipation` | `{ open: string; close: string }` | Temporary closing delimiter for an unfinished streaming tail. |

Lookahead can inspect following inline text without consuming it. Both parser recognition and node conversion use the surrounding inline source, so the ticket rule above can check whitespace after the match. `content` uses capture indices where supported, including nonzero cursor offsets and repeated capture text. Use a capture inside the consumed match for children, not a lookahead-only capture.

### Container extensions (`ContainerExtensionSpec`)

Each `containers` entry registers a colon-fence name to a host component:

| Field | Type | Contract |
| --- | --- | --- |
| `name` | `string` | Unique source name after the colon fence, such as `thought` in `:::thought`. |
| `component` | `string` | Key of a registration in `<StreamingMarkdown contentComponents={...} />`. |

A complete opener has at least three colons followed by a registered name. It is admitted at a block start, including immediately after another registered opener, or after a blank line that separates paragraphs. An optional trailing JSON object supplies source props to the registered component. Code and escaped source retain precedence.

A bare closer is a line containing only colons (with up to three leading spaces and optional trailing horizontal whitespace). It closes only the innermost open container when its colon count exactly matches that opener's fence length. A longer or shorter closer is unmatched and remains literal source.

On `FINALIZE`, an unclosed container remains rendered with status `incomplete` and diagnostic `Unclosed container :::<name>`; its parsed children are retained.

During `INIT`, invalid regex syntax or an invalid syntax descriptor (including a container that references an unregistered component) fails initialization with a protocol `ERROR` in phase `INIT`; the engine does not publish `INITIALIZED` or accept subsequent `APPEND` input. This applies to syntax supplied through `INIT` and instance extensions; validate bundled native syntax before shipping.

The emitted `InlineNode` has `kind: "plugin"`, `name`, `attrs: Record<string, string>`, optional `children: InlineNode[]`, and `raw: string`. React passes the named component `{ name, attrs, children, raw }`, with parsed children already rendered as React nodes. A generic `inlineComponents.plugin` can handle unmapped names. Without either mapping, the renderer returns raw matched text.

```tsx
import type { ReactNode } from "react";
import {
  defineContentComponent,
  StreamingMarkdown,
  type ContentComponentHostProps,
  type ContentComponentProps,
} from "@stream-mdx/react";
import type { SyntaxExtensionDescriptor } from "@stream-mdx/core";

function ThoughtBox({ children }: ContentComponentProps & ContentComponentHostProps) {
  return <aside>{children}</aside>;
}

const contentComponents = {
  ThoughtBox: defineContentComponent({ component: ThoughtBox }),
};

const syntax: SyntaxExtensionDescriptor = {
  contractVersion: 1,
  inline: [
    {
      name: "ticket",
      pattern: { source: "#([A-Z]+-\\d+)(?=\\s|$)" },
      trigger: "#",
      attrs: { id: 1 },
    },
    {
      name: "highlight",
      pattern: { source: "==([\\s\\S]+?)==" },
      trigger: "==",
      content: 1,
      anticipation: { open: "==", close: "==" },
    },
  ],
  containers: [{ name: "thought", component: "ThoughtBox" }],
};

export function SyntaxExample() {
  return (
    <StreamingMarkdown
      text={'See #ABC-12 and ==**important** text==.\n\n:::thought\nContainer body.\n:::'}
      syntax={syntax}
      contentComponents={contentComponents}
      features={{ mdx: true }}
      inlineComponents={{
        ticket: ({ attrs }: { attrs: Record<string, string> }) => (
          <span data-ticket={attrs.id}>{attrs.id}</span>
        ),
        highlight: ({ children }: { children?: ReactNode }) => <mark>{children}</mark>,
      }}
    />
  );
}
```

Anticipation appends only the missing suffix of `close` to a provisional parse. Equal open/close markers use odd/even occurrence counting. It does not modify stored source or finalized output. Declaring `anticipation` activates rule-tail handling without requiring `features.formatAnticipation.regex`; the latter also controls legacy regex plugin anticipation. Choose nonempty markers.

## 2) HTML control

```tsx
import type { ReactNode } from "react";
import { StreamingMarkdown } from "@stream-mdx/react";

export function HtmlExample() {
  return (
    <StreamingMarkdown
      text={'<callout type="note">**Important** and $notMath$</callout>'}
      features={{ html: true, math: false }}
      html={{
        allowedTags: { callout: ["type"], kbd: ["data-x"] },
        literalTagContent: ["kbd"],
      }}
      htmlElements={{
        callout: ({ type, children }: { type?: string; children?: ReactNode }) => (
          <aside data-type={type}>{children}</aside>
        ),
      }}
    />
  );
}
```

`HtmlOptions` has only `allowedTags?: Record<string, string[]>` and `literalTagContent?: string[]`. `allowedTags` adds allowed tags and replaces those tags' attribute lists. Global schema attributes still apply, and URL protocol checks still apply to `href`/`src`. `script` and `style` remain excluded even if requested. Custom allowlists are trusted application policy. Do not allow event-handler attributes or pass untrusted configuration.

Raw HTML block contents are literal by default. An explicitly supplied `literalTagContent`, including `[]`, opts into engine-owned inline markdown parsing for eligible text children. `code`, `pre`, and `textarea`, plus configured tags, remain literal. Inline HTML uses the engine's inline parsing context. Both paths respect `features.math: false` and registered inline extensions.

`htmlElements` maps sanitized HTML tags to React components. Components receive sanitized attributes and typed, recursively rendered children, not raw strings to parse again. Enable `features.html` as well. Mapping a component does not allow a forbidden tag or attribute.

## 3) Custom bundled worker entry

Native Lezer configuration and plugin functions must live in the worker bundle. They cannot be sent through `INIT`. The entry below disables Setext headings, recognizes a native `:ok:` inline badge, and annotates heading metadata with a document plugin.

```ts
// markdown-worker.ts: bundle this entry for the browser, do not run it in the UI.
import type { InlineExtension } from "@stream-mdx/core";
import type { DocumentPlugin } from "@stream-mdx/plugins/document";
import { serveMarkdownWorker } from "@stream-mdx/worker/engine";

const statusBadge: InlineExtension = {
  name: "statusBadge",
  lezer: {
    defineNodes: ["StatusBadge"],
    parseInline: [{
      name: "StatusBadge",
      before: "Link",
      parse(cx, _next, pos) {
        if (!cx.text.startsWith(":ok:", pos - cx.offset)) return -1;
        return cx.addElement(cx.elt("StatusBadge", pos, pos + 4));
      },
    }],
  },
  toInline(element, text) {
    return {
      kind: "plugin",
      name: "statusBadge",
      attrs: { status: "ok" },
      raw: text.slice(element.from, element.to),
    };
  },
};

const headingMetadata: DocumentPlugin = {
  name: "heading-metadata",
  process(ctx) {
    for (const block of ctx.blocks) {
      if (block.type === "heading") {
        block.payload.meta = { ...block.payload.meta, documentPlugin: "heading-metadata" };
      }
    }
    return undefined;
  },
};

serveMarkdownWorker({
  extensions: {
    markdown: [{ remove: ["SetextHeading"] }],
    inline: [statusBadge],
    documentPlugins: [headingMetadata],
  },
});
```

For example, bundle it with esbuild installed in your application:

```bash
npx esbuild markdown-worker.ts --bundle --platform=browser --format=iife --outfile=public/workers/custom-markdown-worker.js
```

The published engine entry is built for the worker realm: its MDX parser resolves the DOM-free `decode-named-character-reference` and `hast-util-from-html-isomorphic` variants, so this command needs no bundler alias, no `document` or `DOMParser` global, and no other consumer configuration. The produced worker boots in a plain Worker scope and answers `INIT`, `APPEND`, and `FINALIZE`.

Then select the emitted asset and map its inline node:

```tsx
import { StreamingMarkdown } from "@stream-mdx/react";

export function NativePluginExample() {
  return (
    <StreamingMarkdown
      engine="worker"
      worker="/workers/custom-markdown-worker.js"
      text="# Build status\n\n:ok:"
      inlineComponents={{
        statusBadge: ({ attrs }: { attrs: Record<string, string> }) => (
          <span role="status">{attrs.status}</span>
        ),
      }}
    />
  );
}
```

`serveMarkdownWorker(options?: ServeMarkdownWorkerOptions): MarkdownEngine` installs the scope's `onmessage` and sends engine messages through `postMessage`. Its options are `{ extensions?: EngineExtensions; scope?: unknown }`; omit `scope` in an ordinary browser worker. Each call creates an isolated engine.

`createInlineEngineWorker(options?: InlineEngineWorkerOptions): Worker` accepts `{ extensions?: EngineExtensions }`, delivers structured-cloned messages in microtasks, and disposes the engine on `terminate()`. To use native extensions on the main thread, create this adapter yourself and supply a stable factory, `worker={() => adapter}`, with `engine="auto"` in a Worker-capable browser. Keep that factory's identity stable across renders. The adapter is not a native `Worker` instance, so passing it directly as `worker={adapter}` does not select it. The `engine="main-thread"` prop creates a default adapter and ignores `worker`. React treats a supplied factory as externally owned, so the caller must terminate its adapter during cleanup.

`EngineExtensions` has `markdown?: MarkdownConfig[]`, `inline?: InlineExtension[]`, `documentPlugins?: DocumentPlugin[]`, and `syntax?: SyntaxExtensionDescriptor`. The descriptor's inline rules use `SyntaxRuleSpec`; its container entries reference registered content components. `InlineExtension` pairs a Lezer `MarkdownConfig` with `toInline(element, text, convertChildren)`, which returns `InlineNode | InlineNode[] | null | undefined`. Its declared node names select the converter. Supply fresh stateful plugin objects for independent engine instances.

## 4) Isolated engine and document plugins

`new MarkdownEngine({ post, extensions? })` is the non-transport API. `post` receives `WorkerOut` messages; `handle(message: WorkerIn): Promise<void>` queues `INIT`, `APPEND`, `FINALIZE`, and other protocol messages. Send `INIT` again to reset document state and caches while retaining instance extensions. There is no `emit` or `reset` constructor option. `dispose()` releases state and suppresses further messages.

```ts
import type { DocumentContext, DocumentContribution } from "@stream-mdx/plugins/document";

interface DocumentPlugin {
  name: string;
  onBegin?(ctx: DocumentContext): void;
  process(ctx: DocumentContext): undefined | DocumentContribution;
  onEnd?(ctx: DocumentContext): undefined | DocumentContribution;
}
```

Document plugins run synchronously after parsing. `DocumentContext` supplies full `content`, mutable `blocks`, persistent per-engine `state`, and optional `protectedRanges`. `DocumentContribution` contains `syntheticBlocks?: Block[]`. The registry replaces duplicate names, runs `onBegin`, `process`, and `onEnd` each aggregation pass, and collects contributions from both `process` and `onEnd`. A failing document plugin logs a warning and does not stop the remaining plugins. `INIT` clears per-document state and restores built-in and instance document plugins.
