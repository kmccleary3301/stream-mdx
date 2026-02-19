# Custom Regex Plugins

Regex plugins let you add domain-specific inline syntax without changing the block parser. This is useful for app-specific tokens that need to render during streaming.

## Why this matters

- You can ship product-specific syntax without forking core parsing logic.
- Inline transforms stay deterministic because plugin output is pure and synchronous.
- Format anticipation lets partial tokens remain stable during streaming updates.

## What this showcases

- `@mentions` converted into structured link nodes.
- Citation tokens like `@cite{paper-2024}` recognized incrementally.
- Streaming-safe tail handling with anticipation boundaries.

## Example plugin

```ts
import type { RegexInlinePlugin } from "@stream-mdx/core";

export const mentionPlugin: RegexInlinePlugin = {
  id: "mention",
  priority: 30,
  re: /@([a-zA-Z0-9_]{2,32})/g,
  toNode(match) {
    return {
      kind: "link",
      href: `/users/${match[1]}`,
      children: [{ kind: "text", text: `@${match[1]}` }],
    };
  },
  fastCheck(text) {
    return text.includes("@");
  },
  anticipation: {
    start: /@([a-zA-Z0-9_]{2,32})$/,
    end: /\s/,
    append: " ",
  },
};
```

## Bundle multiple patterns

```ts
import { createRegexPluginBundle } from "@stream-mdx/plugins/regex";

const regexPlugins = createRegexPluginBundle([mentionPlugin, citationPlugin, issueRefPlugin]);
```

## Worker wiring

```ts
import { createWorkerClient } from "@stream-mdx/worker";
import { createRegexPluginBundle } from "@stream-mdx/plugins/regex";

const worker = createWorkerClient("/workers/markdown-worker.js");
worker.init({
  docPlugins: { html: true, tables: true, footnotes: true },
  customInlinePlugins: createRegexPluginBundle([mentionPlugin]),
});
```

## Expected runtime behavior

- `Hey @alice can you review @bob's patch?` renders mention links while the text is still streaming.
- `@cite{smith-2024}` can be mapped to footnote links or a citation chip renderer.
- If a token is incomplete at the tail, anticipation can withhold partial markup until stable.

## Guardrails

- Keep regex patterns linear-time and bounded.
- Add `fastCheck` whenever possible.
- Add determinism tests for custom plugins if they are part of your production bundle.
- Keep plugin priority explicit when patterns overlap.

## Next steps

- Guide: [Format anticipation](/docs/guides/format-anticipation)
- Worker docs: [Plugins cookbook](/docs/plugins-cookbook)
- API details: [Public API](/docs/public-api)
