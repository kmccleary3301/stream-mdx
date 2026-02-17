# Performance and Backpressure

## The goal: steady rendering at scale

StreamMDX prioritizes steady frame times during long streams. Instead of re-rendering everything, it coalesces patches and applies them with an adaptive scheduler.

Key concepts:

- **Patch coalescing**: adjacent changes are merged into a single render batch.
- **Adaptive budget**: the renderer adjusts how much work to do per frame.
- **Backpressure**: the worker can be slowed when the UI is overloaded.

## Scheduling knobs

The scheduling config lets you tune performance without touching the parser:

```tsx
<StreamingMarkdown
  text={content}
  scheduling={{
    frameBudgetMs: 6,
    lowPriorityFrameBudgetMs: 4,
    maxBatchesPerFlush: 6,
    maxLowPriorityBatchesPerFlush: 2,
  }}
/>
```

These values are optional. The defaults are tuned for real-time streaming in browsers.

## Metrics

`onMetrics` lets you capture timing data:

```tsx
<StreamingMarkdown
  text={content}
  onMetrics={(metrics) => {
    console.log("patch apply", metrics.patchApplyMs);
    console.log("queue depth", metrics.queueDepth);
  }}
/>
```

Use these metrics to verify improvements instead of relying on subjective feel.

## Practical tuning tips

- Keep the update interval low for smooth streams.
- Avoid extra work in custom components during hot paths.
- Prefer wrapping (ScrollArea, callouts) over replacing rendering logic.

## Known expensive operations

- Very large HTML blocks
- Heavy MDX components that trigger layout thrash
- Unbounded DOM for extremely long sessions

In those cases, use `features` flags to turn off unused blocks, or chunk your content.

