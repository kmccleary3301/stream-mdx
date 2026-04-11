# Hosted worker deployment

This showcase is the production-side companion to the browser demo. It focuses on the part that tends to get hand-waved away in markdown renderer comparisons: how the parsing worker is actually hosted, served, and governed by CSP once you leave local development.

## What this page is for

Use this page when you need to answer one of these questions quickly:

- should I ship the worker as a hosted static asset or rely on blob URLs?
- what does StreamMDX expect in a static-export or Vercel-style deployment?
- which deployment details are part of the product contract versus just local convenience?

## Recommended production shape

For production web apps, the preferred deployment model is:

```text
app bundle
   |
   v
hosted worker asset (`/workers/markdown-worker.js`)
   |
   v
StreamMDX worker client / renderer
```

That shape keeps parsing off the main thread and gives you a clear CSP story.

## Why hosted workers are the default

- clearer CSP posture than ad hoc blob-worker fallbacks
- easier to reason about in production audits
- the same deployment shape used by this docs site
- easier cache invalidation and operational visibility than inlined worker generation

## Local and production commands

From the repo root:

```bash
npm run docs:worker:build
npm run docs:snapshots:build
npm run docs:build
```

Those commands:

1. build the hosted worker bundle
2. copy it into the docs app public worker path
3. rebuild snapshot artifacts that depend on the current worker/compiler state
4. produce the exported docs site

## Deployment checklist

Treat this as the default worker-hosting checklist:

- build and copy the hosted worker asset
- serve it from a stable public path
- keep CSP explicit about the worker source
- use the docs/release checks before shipping
- verify the exported/docs build still succeeds after worker changes

## When blob workers are still acceptable

Blob workers are acceptable as a local-development convenience or a controlled fallback. They are not the recommended primary production posture when you care about CSP clarity or operational predictability.

## Related docs

- [Security model](/docs/security-model)
- [Deployment and security guide](/docs/guides/deployment-and-security)
- [Perf harness](/docs/perf-harness)
- [Release checklist](/docs/release-checklist)
