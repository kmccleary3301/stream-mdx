# Restricted and Trusted MDX Components

## Approved source components

Use `contentComponents` for source tags that an application intentionally supports under `"restricted"` policy. Each entry is created with `defineContentComponent`; a type-predicate validator checks narrower source JSON props. This registry is inactive under `"markdown"` and `"trusted-mdx"`.

```tsx
import { defineContentComponent, type ContentComponentsMap } from "@stream-mdx/react";

const contentComponents = {
  Note: defineContentComponent({ component: Note, validateProps: isNoteProps }),
  Step: defineContentComponent({ component: Step, validateProps: isStepProps }),
  ApiBadge: defineContentComponent({ component: ApiBadge, validateProps: isApiBadgeProps }),
} satisfies ContentComponentsMap;

<StreamingMarkdown
  text={source}
  contentPolicy="restricted"
  features={{ mdx: true }}
  contentComponents={contentComponents}
/>;
```

Only serializable names and rendering conditions cross the worker boundary; the component and validator stay on the host. Native projected children are passed separately as React nodes. `renderWhen: "closed"` suppresses only open components; a finalized incomplete body may still render with its diagnostic, while an incomplete opening header stays literal without invoking the host callback. An RSC should import `defineContentComponent` from `@stream-mdx/react/server`.

## Full authored MDX

Full MDX modules are a separate trust boundary. For controlled authored content, create a `TrustedMdxEngine` with `createTrustedMdxEngine` from `@stream-mdx/react/trusted-mdx`, pass it through `engines.mdx`, and provide an explicit host import map. Imported specifiers resolve only to those supplied bindings; nothing is fetched. The host `script-src` must permit `unsafe-eval`. This executes code in the host realm and is not a sandbox. Keep the engine instance stable for its host component set. See [MDX and HTML in StreamMDX](/docs/guides/mdx-and-html) for the complete example and migration notes.

Native `FINALIZED` does not mean trusted MDX is ready to render. The trusted document tracks requested, projected, and actually rendered revisions; stale work is rejected after newer revisions or lease/engine invalidation, with a generation check immediately before evaluation. A render failure may restore the last committed UI, but cannot undo executed code or other side effects.

## Example source

```mdx
<Note>Only components registered by this host are available in restricted mode.</Note>

<Step n={1}>Register the component as a `contentComponents` object entry.</Step>
<ApiBadge stage="stable" />
```
