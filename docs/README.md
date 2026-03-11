# StreamMDX Docs

This directory is the canonical repository-side documentation surface for StreamMDX. The live site consumes this material, but the Markdown files here are the source of truth for API details, integration patterns, reliability notes, and maintainer workflows.

**Primary links**: [Docs site](https://stream-mdx.vercel.app/docs) · [Demo](https://stream-mdx.vercel.app/demo) · [Showcase](https://stream-mdx.vercel.app/showcase) · [Benchmarks](https://stream-mdx.vercel.app/benchmarks)

## Read This In Order

| If you are... | Read first | Then |
| --- | --- | --- |
| New to the repo | [`GETTING_STARTED.md`](./GETTING_STARTED.md) | [`PUBLIC_API.md`](./PUBLIC_API.md), [`REACT_INTEGRATION_GUIDE.md`](./REACT_INTEGRATION_GUIDE.md) |
| Integrating into a React app | [`PUBLIC_API.md`](./PUBLIC_API.md) | [`REACT_INTEGRATION_GUIDE.md`](./REACT_INTEGRATION_GUIDE.md), [`SECURITY_MODEL.md`](./SECURITY_MODEL.md) |
| Working on plugins / worker behavior | [`STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](./STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md) | [`PLUGIN_ABI.md`](./PLUGIN_ABI.md), [`STREAMING_MARKDOWN_V2_STATUS.md`](./STREAMING_MARKDOWN_V2_STATUS.md) |
| Validating correctness / regressions | [`REGRESSION_TESTING.md`](./REGRESSION_TESTING.md) | [`STREAMING_CORRECTNESS_CONTRACT.md`](./STREAMING_CORRECTNESS_CONTRACT.md), [`STREAMING_CORRECTNESS_EXECUTION_PLAN.md`](./STREAMING_CORRECTNESS_EXECUTION_PLAN.md) |
| Working on perf claims or harnesses | [`PERF_HARNESS.md`](./PERF_HARNESS.md) | [`PERFORMANCE_GUIDE.md`](./PERFORMANCE_GUIDE.md), [`PERF_QUALITY_CHANGELOG.md`](./PERF_QUALITY_CHANGELOG.md) |
| Consuming the patch stream in Node / TUI | [`TUI_GUIDE.md`](./TUI_GUIDE.md) | [`CLI_USAGE.md`](./CLI_USAGE.md), [`STREAMMDX_JSON_DIFF_SPEC.md`](./STREAMMDX_JSON_DIFF_SPEC.md) |

## Documentation Index

### Core entry points

| Topic | File | Site route |
| --- | --- | --- |
| Docs overview | [`README.md`](./README.md) | <https://stream-mdx.vercel.app/docs> |
| Getting started | [`GETTING_STARTED.md`](./GETTING_STARTED.md) | <https://stream-mdx.vercel.app/docs/getting-started> |
| Configuration | [`CONFIGURATION.md`](./CONFIGURATION.md) | <https://stream-mdx.vercel.app/docs/configuration> |
| Public API | [`PUBLIC_API.md`](./PUBLIC_API.md) | <https://stream-mdx.vercel.app/docs/public-api> |
| React integration | [`REACT_INTEGRATION_GUIDE.md`](./REACT_INTEGRATION_GUIDE.md) | <https://stream-mdx.vercel.app/docs/react-integration> |
| Security model | [`SECURITY_MODEL.md`](./SECURITY_MODEL.md) | <https://stream-mdx.vercel.app/docs/security-model> |
| TUI guide | [`TUI_GUIDE.md`](./TUI_GUIDE.md) | <https://stream-mdx.vercel.app/docs/tui-guide> |
| Comprehensive manual | [`COMPREHENSIVE_PROJECT_DOCUMENTATION.md`](./COMPREHENSIVE_PROJECT_DOCUMENTATION.md) | <https://stream-mdx.vercel.app/docs/manual> |

### Reliability and quality

| Topic | File | Why it matters |
| --- | --- | --- |
| Regression testing | [`REGRESSION_TESTING.md`](./REGRESSION_TESTING.md) | HTML/style snapshot workflows and update policy |
| Determinism | [`DETERMINISM.md`](./DETERMINISM.md) | Determinism scope, parity checks, and replay expectations |
| Correctness contract | [`STREAMING_CORRECTNESS_CONTRACT.md`](./STREAMING_CORRECTNESS_CONTRACT.md) | Non-negotiable streaming guarantees and invariants |
| Execution plan | [`STREAMING_CORRECTNESS_EXECUTION_PLAN.md`](./STREAMING_CORRECTNESS_EXECUTION_PLAN.md) | Current correctness hardening backlog |
| Static artifact contract | [`STATIC_SNAPSHOT_ARTIFACT_CONTRACT.md`](./STATIC_SNAPSHOT_ARTIFACT_CONTRACT.md) | Snapshot artifact structure and expectations |
| Regression fix matrix | [`REGRESSION_FIX_MATRIX_2026-03-04.md`](./REGRESSION_FIX_MATRIX_2026-03-04.md) | Historical issue/fix ledger |
| Demo reliability plan | [`STREAMING_DEMO_RELIABILITY_REMEDIATION_PLAN.md`](./STREAMING_DEMO_RELIABILITY_REMEDIATION_PLAN.md) | Demo-specific remediation notes |

### Performance and comparisons

| Topic | File | Site / related surface |
| --- | --- | --- |
| Perf harness | [`PERF_HARNESS.md`](./PERF_HARNESS.md) | <https://stream-mdx.vercel.app/perf/harness> |
| Performance guide | [`PERFORMANCE_GUIDE.md`](./PERFORMANCE_GUIDE.md) | Benchmarks and tuning context |
| Perf quality changelog | [`PERF_QUALITY_CHANGELOG.md`](./PERF_QUALITY_CHANGELOG.md) | Historical perf/correctness changes |
| Streamdown comparison | [`STREAMDOWN_COMPARISON.md`](./STREAMDOWN_COMPARISON.md) | <https://stream-mdx.vercel.app/docs/streamdown-comparison> |

### Extension and protocol surfaces

| Topic | File | Notes |
| --- | --- | --- |
| Plugin cookbook | [`STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md`](./STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md) | Built-in plugin usage and customization patterns |
| Plugin ABI | [`PLUGIN_ABI.md`](./PLUGIN_ABI.md) | Lower-level plugin contracts |
| TUI guide | [`TUI_GUIDE.md`](./TUI_GUIDE.md) | Recommended first stop for terminal and non-React consumers |
| TUI / CLI usage | [`CLI_USAGE.md`](./CLI_USAGE.md) | Lower-level Node and terminal runtime usage |
| JSON diff spec | [`STREAMMDX_JSON_DIFF_SPEC.md`](./STREAMMDX_JSON_DIFF_SPEC.md) | Patch/event protocol for non-React consumers |
| Styling parity | [`STYLING_PARITY.md`](./STYLING_PARITY.md) | CSS parity and layout consistency notes |

## Site Content Backed By This Repo

| Surface | Source |
| --- | --- |
| Guides index | [`apps/docs/content/guides`](../apps/docs/content/guides) |
| Showcase index | [`apps/docs/content/showcase`](../apps/docs/content/showcase) |
| Docs app routes | [`apps/docs/app`](../apps/docs/app) |
| Example starter | [`examples/streaming-markdown-starter`](../examples/streaming-markdown-starter) |

## Local Docs Workflows

| Goal | Command |
| --- | --- |
| Build packages | `npm run build:packages` |
| Build hosted worker for docs | `npm run docs:worker:build` |
| Build docs snapshots | `npm run docs:snapshots:build` |
| Start docs locally | `npm run docs:dev` |
| Production docs build | `npm run docs:build` |
| Check docs links | `npm run docs:check-links` |
| Run docs screenshots smoke | `npm run docs:screenshots:smoke` |
| Run docs quality audit | `npm run docs:quality:audit` |

A reliable maintainer loop is:

```bash
npm install
npm run build:packages
npm run docs:worker:build
npm run docs:snapshots:build
npm run docs:dev
```

## Notes

- The public docs site currently lives at <https://stream-mdx.vercel.app>.
- A GitHub Pages mirror also exists at <https://kmccleary3301.github.io/stream-mdx/>.
- For the npm-facing package front page, see [`packages/stream-mdx/README.md`](../packages/stream-mdx/README.md).
