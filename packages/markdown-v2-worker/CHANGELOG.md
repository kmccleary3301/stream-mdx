# @stream-mdx/worker

## Unreleased

- Keep a balanced JSX/MDX component that spans blank lines as one owning root: html blocks that leave a container open now defer MDX detection until region grouping runs, so `<Component>` … `</Component>` compiles as a single worker-mode MDX module (entities decoded, math rendered) instead of an opening-only error block plus a duplicate paragraph and leaked end tag. A still-unclosed component stays a pending html root until it closes or the document finalizes; `mdx: false` and ordinary lowercase raw HTML keep their existing behavior.
- Extend component ownership to container contexts and case-sensitive component names: a quoted or listed component groups its native html leaves before enrichment, compiles from container-stripped markdown (including fenced code blocks), and `FINALIZE` reports the native MDX compiler's closing-tag error for a component that never closes inside a blockquote or list. `<Input>`/`<Link>` compile as components while `mdx: false` still emits CommonMark's separate blocks, and a textarea inside a blockquote stops at the quote boundary.
- Build the public worker entry for the worker realm: bundle the MDX compile pipeline with DOM-free `decode-named-character-reference` and `hast-util-from-html-isomorphic` variants. Custom worker entries bundled with a browser-targeted bundler boot in a Worker without `document` or `DOMParser` and emit `INITIALIZED`/`PATCH`/`FINALIZED` for native and serializable sources, including worker-mode MDX compilation. No consumer alias or DOM shim is required; the hosted worker bundle uses the same aliases instead of decoding entities through the worker DOM stub. MDX development-mode selection reads `process.env.NODE_ENV` at runtime instead of a build-time browser substitution.
- Remove obsolete ambient `document` and `DOMParser` stubs. Public worker/direct/React imports no longer install incomplete browser globals in Node SSR; actual worker MDX compilation uses the existing DOM-free dependency variants.
- Bundle the same complete native MDX pipeline for the public direct/compiler entries. ESM and CJS direct compilation decode entities and compile component, math, and nested code content without DOM globals or ESM-plugin namespace wrappers reaching unified as empty presets.
- Resolve browser-safe MDX dependency variants for public runtime/direct/compiler bundles, while building native `node` exports separately. Vite clients no longer receive vfile's Node `path`/`process`/`url` imports; all ESM/CJS/DTS output names stay unchanged, and the shared output directory is cleaned once before either build begins.

## 0.1.0

### Minor Changes

- 294e557: Release StreamMDX 0.1.0 across all published packages.

### Patch Changes

- Updated dependencies [294e557]
  - @stream-mdx/core@0.1.0
  - @stream-mdx/plugins@0.1.0

## 0.0.3

### Patch Changes

- 47d1374: Add opt-in streaming format anticipation and an optional Mermaid diagram addon for ` ```mermaid ` code blocks.
- 7c79f09: Port the docs demo page to match the ql-homepage streaming UI, and fix several streaming parser/rendering edge cases (hard line breaks and display-math handling) while keeping the hosted worker bundle self-contained for static hosting.
- Updated dependencies [47d1374]
- Updated dependencies [7c79f09]
  - @stream-mdx/core@0.0.3
  - @stream-mdx/plugins@0.0.3

## 0.0.2

### Patch Changes

- 9e94660: Docs and release-quality improvements: ship package READMEs/CHANGELOGs, add pack+install smoke tests, expose MDX parity helper entrypoints, and add a deployable docs site workflow.
- Updated dependencies [9e94660]
  - @stream-mdx/core@0.0.2
  - @stream-mdx/plugins@0.0.2

## 0.0.1

### Patch Changes

- Release maintenance: CI/build fixes, missing runtime deps (e.g. `rehype-katex`), and improved docs/README wiring for the `stream-mdx` package page.
- Updated dependencies
  - @stream-mdx/core@0.0.1
  - @stream-mdx/plugins@0.0.1
