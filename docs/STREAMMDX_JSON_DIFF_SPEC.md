# StreamMDX JSON/TUI Protocol + Diff Highlighting Spec

## 1) Purpose
Define a production-ready JSON/object stream protocol for StreamMDX and add
Shiki-powered diff highlighting with incremental performance. This spec
targets terminal UIs (Ink+Effect and OpenTUI) while preserving the existing
HTML/web pipeline.

## 2) Goals
- Provide a stable, versioned JSON protocol for streaming blocks, patches, and
  finalization signals.
- Emit token-level syntax highlighting data suitable for terminal rendering
  (no HTML parsing required).
- Add diff highlighting (unified diff and line-diff styles) with incremental
  tokenization and JSON output.
- Preserve web behavior (HTML rendering) without breaking existing APIs.
- Add validation, determinism checks, and regression tests for protocol output.

## 3) Non-Goals
- Replacing the current HTML renderer or removing HTML output.
- Executing MDX in terminals (MDX blocks remain opaque in JSON output).
- Introducing a new rendering framework for TUIs beyond reference utilities.

## 4) Current State (Summary)
- Worker emits `WorkerOut` messages with `PATCH` and `Patch[]`.
- Patch protocol supports `appendLines` with `highlight` HTML line fragments.
- Node snapshots are generic (`type: string`, `props: Record<string, unknown>`).
- Incremental Shiki exists in `stream-mdx/packages/markdown-v2-worker/src/worker.ts`.
- React store normalizes code-line props (`text`, `html`) and drops other props.

## 5) Requirements
### Functional
- JSON protocol must be versioned and fully documented.
- Token output must include per-token colors and styles.
- Diff blocks must provide per-line semantics (`add`, `remove`, `context`, etc).
- Protocol must support append-only streaming and finalization.

### Non-Functional
- Deterministic output for identical inputs.
- Bounded performance under streaming loads.
- Backwards compatibility with existing web pipeline.

## 6) Protocol v1
### 6.1 Event Envelope
All events must include:
- `protocol`: `"streammdx"`
- `schemaVersion`: `"1.0"`
- `streamId`: string (uuid)
- `event`: `"init" | "snapshot" | "patch" | "metrics" | "error" | "done"`
- `tx`: number (monotonic for `patch` events; optional otherwise)

Example:
```json
{
  "protocol": "streammdx",
  "schemaVersion": "1.0",
  "streamId": "a9f2c0c1-7c9c-4b2b-8c29-f2df20c30f6a",
  "event": "patch",
  "tx": 42,
  "patches": []
}
```

### 6.2 Init Event
Include capability negotiation and theme metadata.
```json
{
  "event": "init",
  "capabilities": {
    "tokens": "v1",
    "diff": "v1",
    "mdx": "compile-ref",
    "htmlBlocks": "sanitized",
    "math": "tex"
  },
  "theme": { "mode": "dual", "dark": "github-dark", "light": "github-light" }
}
```

### 6.3 Done Event
Explicit end-of-stream semantics:
```json
{ "event": "done", "finalTx": 128, "status": "ok" }
```

### 6.4 Compatibility Rules
- New fields are additive only in minor versions.
- Consumers must ignore unknown fields and unknown node types.
- Breaking changes require a major schema version bump.

## 7) Node Taxonomy and Props
### 7.1 Root
- `id`: `"__root__"`
- `type`: `"root"`
- `children`: block ids

### 7.2 Core Block Types (Minimum)
- `paragraph`, `heading`, `blockquote`
- `list`, `list-item`
- `code` (code block), `code-line`
- `table`, `table-row`, `table-cell`
- `footnotes`, `footnote-def`
- `html` (html block)
- `mdx` (mdx block)
- `thematic-break`

### 7.3 List Props
List node props:
```ts
type ListProps = {
  ordered: boolean;
  start?: number;
  delimiter?: "." | ")" | ":" | string;
  tight?: boolean;
};
```

List item props:
```ts
type ListItemProps = {
  depth: number;
  checked?: boolean | null;
  marker?: string;
  number?: number;
};
```

### 7.4 Inline Segment Props
Inline segments are used for paragraph, blockquote, and list item text:
```ts
type InlineSegmentProps = {
  text: string;
  inline?: InlineNode[];
  inlineStatus?: "raw" | "anticipated" | "complete";
};
```

### 7.5 Code Block Props
```ts
type CodeBlockProps = {
  lang?: string;
  fence?: "```" | "~~~";
  title?: string;
  showLineNumbers?: boolean;
  highlighting: {
    mode: "final" | "incremental" | "live";
    theme: { mode: "dual"; dark: string; light: string } | { mode: "single"; theme: string };
    tokens: "none" | "v1";
  };
  diff?: {
    kind: "line-diff" | "unified-diff";
    baseLang?: string;
  };
};
```

### 7.6 Code Line Props
```ts
type CodeLineProps = {
  index: number;
  text: string;
  html?: string;
  tokens?: TokenLineV1;
  diffKind?: "add" | "remove" | "context" | "hunk" | "meta";
  oldNo?: number | null;
  newNo?: number | null;
};
```

### 7.7 MDX and HTML Blocks
MDX blocks are opaque in JSON output.
```ts
type MdxBlockProps = {
  raw: string;
  status: "detected" | "compiled" | "error";
  compiledRef?: { id: string } | null;
  error?: string;
};
```

HTML blocks should be treated as text in TUI.
```ts
type HtmlBlockProps = {
  raw: string;
  sanitized?: string;
  policy?: "strip" | "sanitize" | "raw";
};
```

### 7.8 Extension Nodes
Custom nodes must be namespaced:
```ts
type CustomNodeSnapshot = {
  type: `x:${string}`;
  props?: Record<string, unknown>;
  meta?: { fallbackText?: string; pluginId?: string };
};
```

## 8) Token Schema v1
### 8.1 Inline Style Encoding (v1)
```ts
type TokenStyle = {
  fg?: string; // "#RRGGBB"
  bg?: string; // "#RRGGBB"
  fs?: number; // bitmask (bold/italic/underline/etc)
};

type TokenSpan = {
  t: string;
  v?: { dark?: TokenStyle; light?: TokenStyle };
  s?: TokenStyle; // single-theme fallback
};

type TokenLineV1 = {
  spans: TokenSpan[];
};
```

### 8.2 Optional Style Table Encoding (v2 candidate)
Consider a per-block style table for payload size reduction; v1 ships inline
styles for simplicity.

## 9) Diff Model
### 9.1 Diff Line Semantics
`diffKind` values:
- `add`: "+" lines
- `remove`: "-" lines
- `context`: " " lines
- `hunk`: "@@" lines
- `meta`: "diff --git", "index", "+++ / ---" lines

### 9.2 Diff Line Numbers
For unified diffs, track per-line numbers:
- `oldNo` for removed/context lines
- `newNo` for added/context lines

### 9.3 Tokenization Strategy (Unified Diff)
- Maintain two Shiki grammar states: old and new.
- Tokenize context lines against both states; emit tokens from the "new"
  state but advance both.
- Tokenize removed lines against old state only.
- Tokenize added lines against new state only.

### 9.4 Line-Diff Mode
If the code fence is `diff` without a base language, treat as text and apply
diff markers only. Optional base language can be inferred from file headers.

## 10) Patch Extensions
Extend `appendLines` patches to carry tokens and diff metadata:
```ts
type AppendLinesPatchV1 = {
  op: "appendLines";
  at: NodePath;
  startIndex: number;
  lines: string[];
  highlight?: (string | null)[];
  tokens?: (TokenLineV1 | null)[];
  diffKind?: (string | null)[];
  oldNo?: (number | null)[];
  newNo?: (number | null)[];
};
```

## 11) Transport
### 11.1 Default Transport
- NDJSON for CLI/TUI pipelines.
- SSE for HTTP streaming (optional).

### 11.2 Snapshot Events
Allow an optional snapshot event for recovery and debugging. Patches remain the
canonical incremental transport.

## 12) API Surface
### 12.1 Worker Init Options
Add output mode:
```ts
type WorkerInitOutputMode = "html" | "tokens" | "both";
```

### 12.2 Public Exports
Proposed:
- `@stream-mdx/protocol` for schemas and event types.
- Optional `@stream-mdx/tui` for a reference store and ANSI helpers.

## 13) Implementation Notes
### 13.1 Worker
- Preserve HTML highlighting for web.
- Add token emission per completed line for incremental mode.
- For finalized blocks, emit full token arrays in one batch.
- Diff detection via code fence info (e.g., `diff`, `diff-ts`, `ts diff`).

### 13.2 React Store
- Option A (default): leave tokens out of the React store (web only).
- Option B: preserve `tokens` in code-line props for future web tooling.

### 13.3 TUI Snapshot Store
Provide a small store to apply patches and retrieve a node tree for rendering.

## 14) Tests and Validation
### 14.1 Schema Validation
- JSON schema tests for protocol events and patch shapes.

### 14.2 Deterministic Replay
- Replay patch streams and compare normalized outputs.

### 14.3 Token Invariants
- Token spans must reconstruct the original line text.
- Tokens must not overlap or omit characters.

### 14.4 Diff Tests
- Unified diff parsing tests (hunks, headers, no newline).
- Diff tokenization correctness for add/remove/context lines.

### 14.5 Performance
- Limit Shiki time per update (target p95 < 8ms per batch).
- Ensure patch sizes remain bounded during streaming.

## 15) Migration and Compatibility
- Protocol v1 is additive; existing web output remains unchanged.
- Tokens are gated by output mode or feature flag.
- Update docs and release notes to explain schema and compatibility.

## 16) Milestones (Phased)
1) Protocol v1 scaffolding + docs.
2) Token output for code blocks (non-diff).
3) Reference TUI store + NDJSON helpers.
4) Diff semantics + incremental tokenization.
5) Validation + benchmarks + release readiness.

## 17) Open Questions
- Should `tokens` be emitted in web mode by default?
- Single-theme vs dual-theme token outputs for TUI.
- How aggressively to infer base language in diffs.

## 18) Default Decisions (Unless Overridden)
- Use inline token styles in v1.
- Output mode default: `"html"` for web, `"both"` for dev, `"tokens"` for TUI.
- Diff model: unified diff with per-line semantics; line-diff fallback.
