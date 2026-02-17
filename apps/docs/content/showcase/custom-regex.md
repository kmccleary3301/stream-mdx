# Custom Regex Plugins

Regex plugins let you add domain-specific inline syntax without changing the block parser. This is useful for app-specific tokens that need to render during streaming.

## What this showcases

- `@mentions` converted into structured inline nodes.
- Citation tokens like `@cite{paper-2024}` recognized incrementally.
- Streaming-safe behavior with format anticipation.

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

## Expected behavior

- `Hey @alice can you review @bob's patch?` renders mention links while the text is still streaming.
- `@cite{smith-2024}` can be mapped to footnote links or a citation chip renderer.
- If a token is incomplete at the tail, anticipation can withhold partial markup until stable.

## Guardrails

- Keep regex patterns linear-time and bounded.
- Add `fastCheck` whenever possible.
- Add determinism tests for custom plugins if they are part of your production bundle.
