"use client";

import { BottomStickScrollArea } from "@/components/layout/bottom-stick-scroll-area";
import { Button } from "@/components/ui/button";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type StreamLine = {
  id: number;
  timestamp: string;
  text: string;
};

type ScrollDebugState = {
  mode: "STICKY_INSTANT" | "DETACHED" | "RETURNING_SMOOTH";
  isOverflowing: boolean;
  distanceToBottom: number;
  scrollTop: number;
  maxScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  programmaticWrites: number;
};

declare global {
  interface Window {
    __stickyScrollTest?: {
      setStreaming: (next: boolean) => void;
      pause: () => void;
      resume: () => void;
      clear: () => void;
      burst: (count?: number) => void;
      setIntervalMs: (next: number) => void;
      getState: () => {
        lines: number;
        isStreaming: boolean;
        intervalMs: number;
        debug: ScrollDebugState;
      };
    };
  }
}

const SAMPLE_LINES = [
  "delta[parser]: appended block snapshot",
  "delta[tokens]: highlighted 14 spans in code fence",
  "delta[coalescing]: merged 3 patches into 1 batch",
  "stream[worker]: awaiting next chunk",
  "stream[ui]: committed patch batch in 2.3ms",
  "stream[api]: consumed 128 chars from source queue",
  "metrics: p95 patch latency stable (4.1ms)",
  "delta[security]: sanitized inline html fragment",
  "finalize: stream complete, replay snapshot stored",
];

function nowLabel() {
  return new Date().toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function StickyScrollDemoClient() {
  const [isStreaming, setIsStreaming] = useState(true);
  const [intervalMs, setIntervalMs] = useState(160);
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [scrollDebug, setScrollDebug] = useState<ScrollDebugState>({
    mode: "STICKY_INSTANT",
    isOverflowing: false,
    distanceToBottom: 0,
    scrollTop: 0,
    maxScrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    programmaticWrites: 0,
  });
  const nextIdRef = useRef(0);
  const sampleIndexRef = useRef(0);
  const scrollDebugRef = useRef(scrollDebug);
  const linesCountRef = useRef(lines.length);
  const isStreamingRef = useRef(isStreaming);
  const intervalMsRef = useRef(intervalMs);

  const streamRateLabel = useMemo(() => `${Math.round(1000 / intervalMs)} lines/s`, [intervalMs]);

  const appendBurst = useCallback((count: number, labelPrefix?: string) => {
    setLines((previous) => {
      const burst = Array.from({ length: count }, (_, index) => {
        const id = nextIdRef.current++;
        const text = SAMPLE_LINES[(sampleIndexRef.current + index) % SAMPLE_LINES.length];
        return { id, timestamp: nowLabel(), text: labelPrefix ? `${labelPrefix}: ${text}` : text };
      });
      sampleIndexRef.current += count;
      const next = [...previous, ...burst];
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  }, []);

  useEffect(() => {
    scrollDebugRef.current = scrollDebug;
  }, [scrollDebug]);

  useEffect(() => {
    linesCountRef.current = lines.length;
  }, [lines.length]);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    intervalMsRef.current = intervalMs;
  }, [intervalMs]);

  useEffect(() => {
    if (!isStreaming) return;

    const timer = window.setInterval(() => {
      appendBurst(1);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [appendBurst, intervalMs, isStreaming]);

  useEffect(() => {
    window.__stickyScrollTest = {
      setStreaming: (next: boolean) => setIsStreaming(next),
      pause: () => setIsStreaming(false),
      resume: () => setIsStreaming(true),
      clear: () => setLines([]),
      burst: (count = 24) => appendBurst(Math.max(1, Math.floor(count)), "burst"),
      setIntervalMs: (next: number) => setIntervalMs(Math.max(20, Math.floor(next))),
      getState: () => ({
        lines: linesCountRef.current,
        isStreaming: isStreamingRef.current,
        intervalMs: intervalMsRef.current,
        debug: scrollDebugRef.current,
      }),
    };

    return () => {
      delete window.__stickyScrollTest;
    };
  }, [appendBurst]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Bottom-Sticky Scroll Area Test</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Scroll upward to detach from bottom. The centered down button fades in; click it to smoothly return and re-stick.
          </p>
        </div>
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <div>State: {isStreaming ? "streaming" : "paused"}</div>
          <div>Rate: {streamRateLabel}</div>
          <div>Lines: {lines.length}</div>
          <div className="mt-1 border-border/60 border-t pt-1">
            <div>Mode: {scrollDebug.mode}</div>
            <div>Overflow: {scrollDebug.isOverflowing ? "yes" : "no"}</div>
            <div>Dist to bottom: {Math.round(scrollDebug.distanceToBottom)}px</div>
            <div>
              Scroll: {Math.round(scrollDebug.scrollTop)} / {Math.round(scrollDebug.maxScrollTop)}px
            </div>
            <div>
              Height: {Math.round(scrollDebug.scrollHeight)} / {Math.round(scrollDebug.clientHeight)}px
            </div>
            <div>Programmatic writes: {scrollDebug.programmaticWrites}</div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setIsStreaming((value) => !value)} data-testid="sticky-stream-toggle">
          {isStreaming ? "Pause stream" : "Resume stream"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setLines([])} data-testid="sticky-stream-clear">
          Clear
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => appendBurst(24, "burst")}
          data-testid="sticky-stream-burst"
        >
          Add burst
        </Button>
        {[90, 160, 260].map((nextMs) => (
          <Button
            key={nextMs}
            size="sm"
            variant={intervalMs === nextMs ? "secondary" : "ghost"}
            onClick={() => setIntervalMs(nextMs)}
          >
            {nextMs}ms
          </Button>
        ))}
      </div>

      <div className="h-[68vh] min-h-[440px] overflow-hidden rounded-xl border border-border/60 bg-card">
        <BottomStickScrollArea
          contentClassName="p-4"
          onDebugStateChange={setScrollDebug}
          debugDomAttributes
          showJumpToBottom
          showScrollBar
        >
          <div className="space-y-2 font-mono text-xs md:text-sm">
            {lines.length === 0 ? (
              <div className="rounded-md border border-border/70 border-dashed p-3 text-muted-foreground">Waiting for stream...</div>
            ) : null}
            {lines.map((line) => (
              <div key={line.id} className="rounded-md border border-border/60 bg-background/70 px-3 py-2">
                <span className="mr-2 text-muted-foreground">[{line.timestamp}]</span>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        </BottomStickScrollArea>
      </div>
    </div>
  );
}
