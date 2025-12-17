# StreamMDX vs Streamdown

This page is a practical comparison to help you choose the right tool and understand the tradeoffs.

## High-level positioning

- **Streamdown**: a drop-in replacement for `react-markdown` optimized for streaming/incomplete markdown via memoization + unterminated-block recovery (`remend`).
- **StreamMDX**: a worker-first incremental patch pipeline designed for high-frequency updates and large documents, with backpressure guardrails.

## Architecture

### Streamdown

- Main-thread parsing/rendering (React component)
- Focus on resilient markdown formatting while content is incomplete/unterminated
- Single-package distribution (`streamdown`)

### StreamMDX

- Worker-first parsing (off main thread)
- Incremental diff → patch batches → patch scheduler applies to a stable render tree
- Separate hosted worker bundle (`/workers/markdown-worker.js`) recommended for production CSP
- Modular packages + convenience wrapper (`stream-mdx`)

## Developer experience

- **Streamdown** is “install and render” for users already using `react-markdown`.
- **StreamMDX** requires hosting a worker bundle (or allowing `blob:`), but provides stronger responsiveness and long-document guardrails.

## Security

- **Streamdown** emphasizes hardened rehype pipelines (e.g., `rehype-harden`) and runs in the main thread.
- **StreamMDX** sanitizes HTML by default and can isolate parsing/enrichment in a worker; CSP posture is clearer when you host the worker bundle.

## Tradeoffs

| Category | Streamdown | StreamMDX |
| --- | --- | --- |
| Integration | Drop-in for `react-markdown` | Dedicated API (`<StreamingMarkdown />`) |
| Runtime model | Main thread | Worker + incremental patches |
| CSP | No worker hosting step | Worker hosting recommended |
| Custom syntax | `remend`-style recovery + rehype/remark plugins | Custom worker bundles for custom tokenizers/matchers |
| Packaging | Single package | Modular packages + wrapper |

## When to choose which

- Choose **Streamdown** if you want drop-in `react-markdown` compatibility and a minimal setup.
- Choose **StreamMDX** if you need worker isolation, high-frequency streaming stability, or long-document responsiveness guardrails.

