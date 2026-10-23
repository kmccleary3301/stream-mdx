# StreamMDX preview runtime

`@stream-mdx/preview` is an optional, local project preview runtime. It compiles project files with the package's pinned `esbuild-wasm` dependency and runs output in an opaque, credential-free iframe. The input seam is `{ generation, revision, files, entry }`, where `files` is a `ReadonlyMap<string, string>`.

## Revision behavior

The controller keeps the last successfully visible revision separate from requested and compiled revisions. A compile, runtime, or stylesheet-update failure leaves that visible revision in place and labeled with its actual identity.

A revision is a **styles-only update** when it has the same generation and entry as the last visible input and every changed, added, or removed path ends in `.css`. After compilation, the active frame's stylesheet is replaced without executing project JavaScript or replacing the React root. Application state is preserved; `visible` advances to the new identity and `styleResult` reports `{ kind: "styles-updated", identity }`.

Any non-CSS file change, entry change, or generation change publishes a fresh frame and resets application state. This is deterministic content comparison, not HMR. A failed update does not replace the last-valid frame.

## Local commands

From the workspace root:

```sh
npm -w @stream-mdx/preview run build
npm -w @stream-mdx/preview run test
npm -w @stream-mdx/preview run demo
```

The demo listens only on `127.0.0.1:3421`. Its **Update styles** button changes CSS while preserving the preview counter; **Update code** changes TSX and remounts the preview, resetting the counter.
