# Migrating from 0.5.x

This major release changes StreamMDX's React presentations, trusted MDX setup, and worker protocol. Upgrade every StreamMDX package together and rebuild or recopy the hosted worker from the same release.

## Key replacements

- Replace `blockRenderer` and the old renderer override props with `components: NodePresentations`. Use `{ wrapper }` for prepared native children and `{ view }` for a headless node handle.
- Replace `engine="main-thread"` with `engine="main"`.
- Use `engines.code`, `engines.math`, `engines.mermaid`, and `engines.mdx` for engine capabilities. Code presentation overrides remain under `components.code`.
- Keep ordinary and restricted MDX native. Full evaluation requires an explicit `TrustedMdxEngine`, a host import map, `contentPolicy="trusted-mdx"`, trusted source, and CSP permission for `unsafe-eval`.
- Update protocol consumers to wire schema 2.0. `appendLines` is retired; code and paragraph changes use typed owner operations such as `appendCode`, `appendParagraph`, and `updateParagraphSpans`.
- Set `colorScheme` on native output when using the Tailwind theme and a fixed or system color scheme.

For before-and-after examples, including syntax descriptors, unified error callbacks, and headless views, see the [complete migration guide](https://github.com/kmccleary3301/stream-mdx/blob/main/docs/MIGRATION.md). The [Public API](/docs/public-api) describes the current contracts.
