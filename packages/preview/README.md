# StreamMDX preview runtime

`@stream-mdx/preview` is an optional, private workspace package for local project previews. It does not participate in the core package build or any public deployment. The host supplies a plain input:

```ts
type PreviewInput = {
  generation: string;
  revision: string;
  files: ReadonlyMap<string, string>;
  entry: string;
};
```

The package bundles `esbuild-wasm` and Tailwind CSS 4.1.18. It compiles the project locally, then runs the result in a sandboxed, credential-free iframe. It never sends project source to a hosted compiler.

## Installation and build

The package is private pending release approval. In this monorepo, use the existing workspace installation and build it explicitly:

```sh
npm install
npm -w @stream-mdx/preview run build
npm -w @stream-mdx/preview run test
npm -w @stream-mdx/preview run demo
```

The demo binds only to `127.0.0.1:3421`. Its local server provides the package bundle, React runtime modules, esbuild Wasm, and Tailwind stylesheets.

The demo server and source are workspace-only and are intentionally excluded from the package tarball.

## Browser API

```ts
import { createBrowserPreviewController } from "@stream-mdx/preview";

const controller = createBrowserPreviewController(previewElement, {
  wasmURL: new URL("/preview/esbuild.wasm", location.href),
  reactRuntimeURL: new URL("/preview/vendor/react-core.mjs", location.href),
});

void controller.request({
  generation: "project-session-1",
  revision: "revision-1",
  files: new Map([
    ["main.tsx", 'import "./styles.css"; export default function App() { return <main className="p-4">Preview</main>; }'],
    ["styles.css", '@import "tailwindcss";'],
  ]),
  entry: "main.tsx",
});
```

The host can subscribe to `onState` or call `getState()`. `requested`, `compiled`, `candidateReady`, and `visible` are separate identities. A compile/runtime failure keeps the last-valid output visible with its own older identity; it is never relabeled as the failed revision. `dispose()` stops publication and tears down the frame, channel, and listeners.

## Revision and style behavior

A revision is a styles-only update when it has the same generation and entry as the last visible input and every changed, added, or removed path ends in `.css`. After compilation, the active frame stylesheet is replaced without executing project JavaScript or replacing the React root. Application state is preserved; `visible` advances only after acknowledgement and `styleResult` reports `{ kind: "styles-updated", identity }`.

Any non-CSS file change, entry change, or generation change publishes a fresh frame and resets application state. Compilation and publication are guarded against stale generations/revisions. Under the four-publications-per-second bound, pending work coalesces to the newest revision.

For simultaneous comparisons, `createBrowserPreviewVariantsController(container, variants, options)` accepts one to four named variants. Every variant has its own iframe, frame state, revision lifecycle, and optional preview-owned `css` overlay. Each overlay is appended only to that variant's compiled CSS. `request(input)` updates all variants; use `getState(name)` or `getStates()` for independent state. `dispose()` removes all frames and variant containers.

```ts
import { createBrowserPreviewVariantsController } from "@stream-mdx/preview";

const comparison = createBrowserPreviewVariantsController(previewElement, [
  { name: "Cool", css: ":root{--preview-accent:#1d4ed8}" },
  { name: "Warm", css: ":root{--preview-accent:#b45309}" },
], {
  wasmURL: new URL("/preview/esbuild.wasm", location.href),
  reactRuntimeURL: new URL("/preview/vendor/react-core.mjs", location.href),
});
void comparison.request(input);
```

## Local Tailwind and CSS isolation

Project CSS may use `@import "tailwindcss";`. Tailwind runs locally against static class strings found in project source; no CDN, remote stylesheet, plugin, config module, or network resolver is used. Keep utility names as complete static strings (or use Tailwind's static `@source inline(...)` safelist); dynamically assembled class names are not discoverable. Tailwind CSS is bundled with JavaScript only as a compiler dependency, while generated project CSS is sent separately to the opaque frame.

The frame is created with `sandbox="allow-scripts"` and an opaque origin. Host/frame bootstrap authenticates `event.source` and a per-generation capability, then transfers a dedicated `MessageChannel`; it does not trust the `"null"` origin string. A deny-by-default CSP in the frame permits only its nonce and package-local React modules for scripts, inline/data styles, and data images; `connect-src`, workers, objects, frames, forms, and base URLs are denied. Project styles remain in the iframe and cannot style the host. The preview exposes no host operations or host credentials.

Bounds are enforced before compilation/publication and again by the frame protocol:

| Limit | Bound |
| --- | ---: |
| Project files | 128 |
| Project input | 2 MiB |
| Compiled JavaScript + CSS | 16 MiB |
| Frame message | 64 KiB |
| Publications | 4 per second |
| Simultaneous variants | 4 |

The runtime is intended for local development only. It does not impose a hard CPU timeout on untrusted project code; keep it bound to loopback and do not treat it as a public multi-tenant execution service.
