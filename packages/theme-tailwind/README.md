# @stream-mdx/theme-tailwind

Optional Tailwind-friendly theme for StreamMDX output. This package ships a single CSS file with:

- `.markdown-v2-output` streaming-specific layout tweaks
- `.markdown` base Markdown typography helpers
- `.prose` adjustments (compatible with `@tailwindcss/typography`)

## Install

```bash
npm install @stream-mdx/theme-tailwind
```

## Usage

Import the CSS after your Tailwind directives so the layers merge cleanly:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@import "@stream-mdx/theme-tailwind/theme.css";
```

Then apply the recommended structure:

```tsx
import { StreamingMarkdown } from "stream-mdx";

export function Article({ content }: { content: string }) {
  return (
    <div className="prose markdown">
      <StreamingMarkdown className="markdown-v2-output" text={content} />
    </div>
  );
}
```

## Notes

- If you want the `prose` base styles, install `@tailwindcss/typography` and enable it in `tailwind.config.ts`.
- The theme references CSS variables like `--foreground` and `--border`; define them in your design system or replace them with your own values.
- You can always override elements via StreamMDX `components`, `inlineComponents`, and `tableElements`.

## Docs

- Styling guide: https://github.com/kmccleary3301/stream-mdx/blob/main/docs/STYLING_PARITY.md
- React integration: https://github.com/kmccleary3301/stream-mdx/blob/main/docs/REACT_INTEGRATION_GUIDE.md
