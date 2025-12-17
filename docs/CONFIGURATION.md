# Configuration

This page summarizes the configuration surface exposed by `<StreamingMarkdown />`.

## Feature flags

`features` toggles built-in domains in the worker + renderer:

```tsx
<StreamingMarkdown
  text={text}
  features={{ tables: true, html: true, mdx: true, math: true, footnotes: true, callouts: false }}
/>;
```

## Worker

Recommended: host the worker and pass a URL string:

```tsx
<StreamingMarkdown worker="/workers/markdown-worker.js" />
```

If you omit `worker`, StreamMDX uses the default worker strategy and falls back to `/workers/markdown-worker.js`.

## MDX

To render MDX blocks:

- set `features={{ mdx: true }}`
- set `mdxCompileMode="worker"` (no server), or `"server"` (requires `/api/mdx-compile-v2`)
- provide `mdxComponents` if you use custom MDX components

## Rendering overrides

- `components`: override block renders (heading/code/table/etc).
- `inlineComponents`: override inline renders (strong/em/link/code/etc).
- `tableElements`: override table tags (Shadcn table wrappers).
- `htmlElements`: override HTML tag renders (when HTML is enabled).

## Scheduling and metrics

- `scheduling`: patch scheduler/backpressure knobs (frame budget, batch caps, history size).
- `onMetrics`: flush metrics callback (queue depth, timings, adaptive throttling state).

For exact types and defaults, see `docs/PUBLIC_API.md`.

