---
"@stream-mdx/react": major
---

Replace the legacy `components` component map with `components?: NodePresentations`. Each semantic key maps to an entry containing constrained `props` and optionally either `wrapper: React.ComponentType<NodeViewProps>` or a headless `view: React.ComponentType<HeadlessNodeViewProps<K>>` (never both); `slots.actions` is supported for code and table presentations. Migrate `components={{ table: TableView }}` to `components={{ table: { wrapper: TableView } }}`, or register a headless code view as `components={{ code: { view: CodeView } }}`. New public types include `NativeNodeKey`, `NodePresentationKey`, `NodePresentation`, `NodePresentations`, `NodeViewProps`, `HeadlessNodeViewProps`, `NodeHandle`, `NodeHandleMetadata`, `NodeChildRange`, `NodeViewMetadata`, `NodeViewActions`, `PresentationProps`, and `NativeActionSlot`.
