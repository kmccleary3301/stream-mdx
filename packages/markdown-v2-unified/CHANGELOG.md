# @stream-mdx/unified

## 0.5.0

### Minor Changes

- Align the unified adapter with the StreamMDX `0.5.0` release and require core and React `>=0.5.0`.
- Support finalized-block routing, container replacement, synchronous SSR, asynchronous native fallback, error callbacks, and bounded renderer caches.
- Restore heading levels and link references before plugin transforms and apply URL sanitization after user rehype plugins.
- Bundle the unified pipeline dependencies so both the ESM and CJS entries can execute plugins in packed installs.

## 0.4.0

### Minor Changes

- Initial release of `@stream-mdx/unified`: remark and rehype unified plugin adapter for StreamMDX.
