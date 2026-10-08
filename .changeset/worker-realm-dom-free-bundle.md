---
"@stream-mdx/worker": patch
---

Build the public `@stream-mdx/worker/engine` entry for the worker realm: the MDX and KaTeX pipeline is bundled with the DOM-free `decode-named-character-reference` decoder and `hast-util-from-html-isomorphic` parser variants. Custom worker entries bundled with a browser-targeted bundler — including the documented `npx esbuild markdown-worker.ts --bundle --platform=browser --format=iife` command — now boot inside a Worker without `document` or `DOMParser` and emit `INITIALIZED`/`PATCH`/`FINALIZED`, including worker-mode MDX compilation. Previously browser resolution elected `decode-named-character-reference/index.dom.js`, which threw `ReferenceError: document is not defined` before any message was handled. No consumer alias, shim, or additional configuration is required. The hosted worker bundle resolves the same DOM-free variants instead of decoding entities through the worker DOM stub.
