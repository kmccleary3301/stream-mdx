# Format Anticipation

Format anticipation lets StreamMDX render inline formatting *before* closing delimiters arrive. The goal is a smoother, more "live" feel while still avoiding runaway parsing.

## What it does

- Allows partial emphasis/strong/strike to render as soon as the opening marker is seen.
- Lets inline and block math render early (within safe bounds).
- Can be toggled per feature, so you keep the strict behavior where you need it.

## Enable it

```tsx
<StreamingMarkdown
  text={content}
  features={{
    formatAnticipation: {
      inline: true,
      mathInline: true,
      mathBlock: true,
      html: true,
      mdx: true,
      regex: false,
    },
  }}
/>
```

## Inline and block math

The block math toggle is guarded by a newline threshold so unclosed blocks do not "capture" the rest of the article. Inline math is scoped to a single line.

```md
Inline: $E = mc^2$ and $f(x) = x^2$

Block:

$$
\mathbf{J}_f(\mathbf{x}) = \nabla f(\mathbf{x})
$$
```

## HTML and MDX

- HTML: only allowlisted tags are eligible for anticipation.
- MDX: anticipation applies to known component tags provided in `mdxComponents`.

This keeps the streaming state stable while letting rich components appear as early as possible.

## When to keep it off

- Content with ambiguous markers (e.g., heavy use of stray `*` or `$`).
- Strict Markdown pipelines where you want the renderer to wait for a full, valid token.

## Debugging tips

- Toggle one flag at a time to see the effect.
- Use the demo page to compare strict vs anticipated rendering.
