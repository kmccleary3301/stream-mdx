---
"stream-mdx": minor
"@stream-mdx/core": minor
"@stream-mdx/plugins": minor
"@stream-mdx/worker": minor
"@stream-mdx/react": patch
"@stream-mdx/mermaid": patch
"@stream-mdx/unified": minor
---

Add isolated MarkdownEngine instances, the public worker/engine entry, custom bundled worker serving, and a main-thread Worker adapter. React supports explicit worker, main-thread, and auto execution modes with a dynamically imported creation-time fallback. Updating onError no longer restarts streamed content.

Add serializable inline syntax rules with capture attributes, recursively parsed content, lookahead, streaming anticipation, and invalid-INIT recovery. Native worker entries accept Lezer markdown/inline extensions and instance document plugins. HTML supports per-tag attribute lists, mapped components, and opt-in markdown children while retaining literal raw-block defaults and respecting disabled math.

Prepare nested block snapshots in the engine so native list/blockquote children retain parsing configuration, plugins, HTML, code, and math metadata. Add code fence renderer registration, React-node code fallbacks, math renderer overrides, structured diff views, and sandboxed HTML artifacts with CSP and host link routing. Mermaid accepts the code fence renderer contract and confines invalid-diagram output to its block.

Add the optional unified adapter for finalized-block remark/rehype transforms, explicit block routing, container replacement, synchronous SSR, asynchronous native fallback, error callbacks, and bounded per-renderer caches. Document public exports and replace obsolete plugin factory examples.

React's minor version change for table virtualization is recorded separately in measured-table-rows; this changeset records the other React changes without a second minor entry.
