"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { StreamingMarkdown } from "@stream-mdx/react";

const SAMPLE = `# Streaming preview

StreamMDX keeps output stable while text arrives.

- Worker-first parsing
- Incremental patches
- Backpressure guardrails

\`\`\`ts
type Patch = {
  op: "appendLines" | "setProps";
  blockId: string;
};
\`\`\`

Inline code stays readable while streaming.`;

const SPEEDS = {
  slow: { label: "Slow", cps: 180 },
  typical: { label: "Typical", cps: 700 },
  fast: { label: "Fast", cps: 2200 },
} as const;

type SpeedPreset = keyof typeof SPEEDS;
type HighlightMode = "standard" | "live";
type HighlightPreset = { id: HighlightMode; label: string; live: boolean };

const HIGHLIGHT_PRESETS: HighlightPreset[] = [
  { id: "standard", label: "Standard", live: false },
  { id: "live", label: "Live", live: true },
];

const TICK_MS = 40;

export function MiniStreamingDemo() {
  const [position, setPosition] = useState(0);
  const [isRunning, setIsRunning] = useState(true);
  const [speed, setSpeed] = useState<SpeedPreset>("typical");
  const [highlightMode, setHighlightMode] = useState<HighlightMode>("standard");
  const [liveHighlighting, setLiveHighlighting] = useState(false);

  const total = SAMPLE.length;
  const rate = SPEEDS[speed].cps;

  useEffect(() => {
    if (!isRunning) return;
    const chunkSize = Math.max(1, Math.round((rate * TICK_MS) / 1000));
    const interval = window.setInterval(() => {
      setPosition((prev) => Math.min(total, prev + chunkSize));
    }, TICK_MS);
    return () => window.clearInterval(interval);
  }, [isRunning, rate, total]);

  useEffect(() => {
    if (position >= total) {
      setIsRunning(false);
    }
  }, [position, total]);

  const displayText = useMemo(() => SAMPLE.slice(0, position), [position]);

  const handleRestart = () => {
    setPosition(0);
    setIsRunning(true);
  };

  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-semibold">Live preview</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setIsRunning((prev) => !prev)}>
            {isRunning ? "Pause" : "Play"}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleRestart}>
            Restart
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Speed</span>
        {Object.entries(SPEEDS).map(([key, preset]) => (
          <Button
            key={key}
            size="sm"
            variant={speed === key ? "default" : "ghost"}
            onClick={() => setSpeed(key as SpeedPreset)}
          >
            {preset.label}
          </Button>
        ))}
        <span className="ml-2 font-semibold text-foreground">Highlight</span>
        {HIGHLIGHT_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            size="sm"
            variant={highlightMode === preset.id ? "default" : "ghost"}
            onClick={() => {
              setHighlightMode(preset.id);
              setLiveHighlighting(preset.live);
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="mt-3 text-xs text-muted-foreground">
        {position.toLocaleString()} / {total.toLocaleString()} chars · {isRunning ? "Streaming" : "Paused"}
      </div>

      <div className="prose mt-4 max-w-none text-sm">
        <StreamingMarkdown
          worker="/workers/markdown-worker.js"
          text={displayText}
          className="markdown-v2-output"
          features={{
            liveCodeHighlighting: liveHighlighting,
          }}
        />
      </div>
    </div>
  );
}
