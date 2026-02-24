"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import type { StreamingMarkdownProps } from "@stream-mdx/react";
import { StreamingMarkdown } from "@stream-mdx/react";

import { BottomStickScrollArea } from "@/components/layout/bottom-stick-scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const TICK_MS = 40;

const SPEED_PRESETS = {
  slow: { label: "Slow", cps: 200 },
  standard: { label: "Standard", cps: 800 },
  fast: { label: "Fast", cps: 2200 },
} as const;

type SpeedPreset = keyof typeof SPEED_PRESETS;

type StreamRenderWidgetProps = {
  title?: string;
  markdown: string;
  width?: number | string;
  height?: number | string;
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
  defaultSpeed?: SpeedPreset;
  className?: string;
  features?: NonNullable<StreamingMarkdownProps["features"]>;
  mdxCompileMode?: StreamingMarkdownProps["mdxCompileMode"];
  showControls?: boolean;
};

const DEFAULT_FEATURES: NonNullable<StreamingMarkdownProps["features"]> = {
  html: true,
  tables: true,
  math: true,
  mdx: true,
  footnotes: true,
  callouts: true,
  liveCodeHighlighting: false,
};

export function StreamRenderWidget({
  title = "Live renderer",
  markdown,
  width = "100%",
  height = 420,
  minWidth = 320,
  minHeight = 280,
  resizable = false,
  defaultSpeed = "standard",
  className,
  features = DEFAULT_FEATURES,
  mdxCompileMode = "worker",
  showControls = true,
}: StreamRenderWidgetProps) {
  const [position, setPosition] = useState(0);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState<SpeedPreset>(defaultSpeed);
  const total = markdown.length;
  const rate = SPEED_PRESETS[speed].cps;

  useEffect(() => {
    if (!running) return;
    const chunkSize = Math.max(1, Math.round((rate * TICK_MS) / 1000));
    const timer = window.setInterval(() => {
      setPosition((previous) => Math.min(total, previous + chunkSize));
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [running, rate, total]);

  useEffect(() => {
    if (position >= total) setRunning(false);
  }, [position, total]);

  const displayText = useMemo(() => markdown.slice(0, position), [markdown, position]);

  const containerStyle: CSSProperties = {
    width: typeof width === "number" ? `${width}px` : width,
    height: typeof height === "number" ? `${height}px` : height,
    minWidth: `${minWidth}px`,
    minHeight: `${minHeight}px`,
  };

  return (
    <section className={cn("rounded-xl border border-border/60 bg-card/60 p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="text-xs text-muted-foreground">
            {position.toLocaleString()} / {total.toLocaleString()} chars
          </div>
        </div>

        {showControls ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant={running ? "outline" : "default"} onClick={() => setRunning((prev) => !prev)}>
              {running ? "Pause" : "Resume"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPosition(0);
                setRunning(true);
              }}
            >
              Restart
            </Button>
            {Object.entries(SPEED_PRESETS).map(([id, preset]) => (
              <Button
                key={id}
                size="sm"
                variant={speed === id ? "secondary" : "ghost"}
                onClick={() => setSpeed(id as SpeedPreset)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          "mt-3 overflow-hidden rounded-lg border border-border/60 bg-background",
          resizable && "resize",
        )}
        style={containerStyle}
      >
        <BottomStickScrollArea className="h-full w-full" contentClassName="p-4" showJumpToBottom showScrollBar>
          <div className="prose markdown max-w-none text-theme-primary">
            <StreamingMarkdown
              text={displayText}
              className="markdown-v2-output"
              worker="/workers/markdown-worker.js"
              mdxCompileMode={mdxCompileMode}
              features={features}
            />
          </div>
        </BottomStickScrollArea>
      </div>
    </section>
  );
}
