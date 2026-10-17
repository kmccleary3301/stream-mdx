# MDX and HTML in StreamMDX

## Safe default

`StreamingMarkdown` keeps Markdown native and uses the restricted content policy by default. It does not compile or evaluate arbitrary MDX modules. Leave full-MDX support out of views that render user- or agent-generated text.

For approved source components, use `defineContentComponent` adapters under the restricted policy. A type-predicate validator checks narrower source JSON props; the worker receives only serializable names and render conditions, while the component and validator remain on the host. Native projected `children` are supplied separately as host React nodes.

```tsx
import { defineContentComponent, StreamingMarkdown, type ContentComponentProps, type ContentComponentsMap } from "@stream-mdx/react";
import type { ComponentProps } from "react";
import { Callout } from "./Callout";

type CalloutSourceProps = Pick<ComponentProps<typeof Callout>, "type">;
const validateCalloutProps = (
  props: ContentComponentProps,
): props is ContentComponentProps & CalloutSourceProps =>
  props.type === "info" || props.type === "warning";

const contentComponents = {
  Callout: defineContentComponent({ component: Callout, validateProps: validateCalloutProps }),
} satisfies ContentComponentsMap;

<StreamingMarkdown
  text={content}
  contentPolicy="restricted"
  features={{ mdx: true }}
  contentComponents={contentComponents}
/>
```

`renderWhen: "closed"` suppresses only an open native component. A finalized incomplete body that passes validation still renders with its diagnostic; an incomplete opening header remains literal and does not invoke the host callback. When constructing this registration in a React Server Component, import `defineContentComponent` from `@stream-mdx/react/server`.

## Trusted authored MDX

Full MDX is an explicit trust boundary. Use it only for content whose authors are trusted to execute code in your application. The engine is exported from `@stream-mdx/react/trusted-mdx`; the ordinary React root entry does not load the compiler or evaluator.

The host must create the engine and provide both the render components and the allowed import bindings. Imports are not fetched from a server or resolved from the network. Reuse the engine for the lifetime of its host component set instead of creating one during every render:

```tsx
import { StreamingMarkdown } from "@stream-mdx/react";
import { createTrustedMdxEngine } from "@stream-mdx/react/trusted-mdx";
import { Callout } from "./Callout";

const trustedWidgets = { Callout };
const trustedMdxEngine = createTrustedMdxEngine({
  components: trustedWidgets,
  imports: { "host:widgets": trustedWidgets },
});
const trustedMdxEngines = { mdx: trustedMdxEngine };

export function TrustedArticle({ source }: { source: string }) {
  return (
    <StreamingMarkdown
      text={source}
      contentPolicy="trusted-mdx"
      engines={trustedMdxEngines}
    />
  );
}
```

Use an explicit import map containing only the host bindings required by authored imports such as `import { Callout } from "host:widgets"`; unresolved imports are not fetched. Trusted evaluation runs in the host realm, requires `unsafe-eval` in the application's `script-src`, and is not a sandbox. Keep untrusted/user-generated content on the restricted path. Pass the trusted engine to `StreamingMarkdown` once; do not separately render a second full MDX module beside the native Markdown tree.

Native worker `FINALIZED` confirms only native semantic completion. Trusted whole-document preparation and evaluation run separately; the trusted document distinguishes requested, projected, and actually rendered revisions. A stale result is rejected after a newer revision or lease/engine invalidation and is checked immediately before authored code runs. Render failure may restore the last committed UI, but it cannot roll back side effects already caused by trusted code.

## HTML blocks

Raw HTML is a separate feature from MDX. When enabled, HTML is sanitized and rendered with the configured allowlist:

```tsx
<StreamingMarkdown text={content} features={{ html: true }} />
```

## Fenced HTML

`artifact` and `html-artifact` fences are code by default. They do not mount a preview or execute scripts. If an application later adds a visualization renderer, it must be an explicit host-owned code-renderer capability, not an automatic fence behavior.

## Choosing a policy

- **Markdown / restricted (default)**: user input, agent output, and ordinary docs.
- **Trusted MDX**: authored modules from a controlled trust boundary, with an explicit engine and import allowlist.
- **HTML**: separately sanitized raw HTML when the application needs it.
