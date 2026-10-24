---
"@stream-mdx/react": minor
---

Add a bounded viewport for large native code blocks with an opt-in full-content reader mode. `codeVirtualization` configures native code viewport presentation, including optional tail following; updates preserve the existing viewport and reader anchor. Eligible virtualized code blocks mount full source before printing and restore the previous viewport, anchor, and native selection afterward.

Native whole-code copy and download use cold authored source, preserving CR/LF and trailing blank lines instead of normalized display text. The test DOM exercises copy with an active selection and a Clipboard API stub; it does not prove physical browser or OS clipboard behavior. Direct Blob download browser proof remains pending. Copied-status feedback cleanup prevents delayed updates after unmount.
