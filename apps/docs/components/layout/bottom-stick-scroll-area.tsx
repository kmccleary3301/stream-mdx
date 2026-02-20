"use client";

import { Button } from "@/components/ui/button";
import { ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { ChevronDown } from "lucide-react";
import type { ReactNode, UIEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type Mode = "STICKY_INSTANT" | "DETACHED" | "RETURNING_SMOOTH";

type BottomStickDebugState = {
  mode: Mode;
  isOverflowing: boolean;
  distanceToBottom: number;
  scrollTop: number;
  maxScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  programmaticWrites: number;
};

type BottomStickScrollAreaProps = {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  showScrollBar?: boolean;
  showJumpToBottom?: boolean;
  onDebugStateChange?: (state: BottomStickDebugState) => void;
  debugDomAttributes?: boolean;
};

const EPS_BOTTOM_PX = 2;
const EPS_OVERFLOW_PX = 1;
const DETACH_SCROLL_DELTA_PX = 4;
const RETURN_MIN_MS = 180;
const RETURN_MAX_MS = 520;
const RETURN_PX_PER_MS = 2.2;
const RETURN_SETTLE_FRAMES = 2;

function clamp01(value: number) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function easeOutCubic(value: number) {
  return 1 - (1 - value) ** 3;
}

function measure(viewport: HTMLDivElement) {
  const scrollTop = viewport.scrollTop;
  const scrollHeight = viewport.scrollHeight;
  const clientHeight = viewport.clientHeight;
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const distanceToBottom = Math.max(0, maxScrollTop - scrollTop);
  const isOverflowing = scrollHeight > clientHeight + EPS_OVERFLOW_PX;

  return { scrollTop, scrollHeight, clientHeight, maxScrollTop, distanceToBottom, isOverflowing };
}

export function BottomStickScrollArea({
  children,
  className,
  contentClassName,
  showScrollBar = true,
  showJumpToBottom = true,
  onDebugStateChange,
  debugDomAttributes = false,
}: BottomStickScrollAreaProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const modeRef = useRef<Mode>("STICKY_INSTANT");
  const [mode, setMode] = useState<Mode>("STICKY_INSTANT");
  const [isOverflowing, setIsOverflowing] = useState(false);

  const prevScrollTopRef = useRef(0);
  const lastProgrammaticWriteRef = useRef<{ at: number; top: number } | null>(null);
  const programmaticWriteCountRef = useRef(0);

  const pendingStickRafRef = useRef<number | null>(null);
  const stickRequestedRef = useRef(false);

  const returnRafRef = useRef<number | null>(null);
  const returnAnimRef = useRef<{
    startTime: number;
    startTop: number;
    durationMs: number;
    settleFrames: number;
  } | null>(null);

  const setModeBoth = useCallback((next: Mode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const updateDebug = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const m = measure(viewport);
    if (debugDomAttributes) {
      viewport.dataset.stickyMode = modeRef.current;
      viewport.dataset.distanceToBottom = String(m.distanceToBottom);
      viewport.dataset.isOverflowing = m.isOverflowing ? "1" : "0";
      viewport.dataset.programmaticWrites = String(programmaticWriteCountRef.current);
    }
    onDebugStateChange?.({
      mode: modeRef.current,
      isOverflowing: m.isOverflowing,
      distanceToBottom: m.distanceToBottom,
      scrollTop: m.scrollTop,
      maxScrollTop: m.maxScrollTop,
      scrollHeight: m.scrollHeight,
      clientHeight: m.clientHeight,
      programmaticWrites: programmaticWriteCountRef.current,
    });
  }, [debugDomAttributes, onDebugStateChange]);

  const writeScrollTop = useCallback((nextTop: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = nextTop;
    programmaticWriteCountRef.current += 1;
    lastProgrammaticWriteRef.current = { at: performance.now(), top: nextTop };
  }, []);

  const cancelPendingStick = useCallback(() => {
    if (pendingStickRafRef.current !== null) {
      cancelAnimationFrame(pendingStickRafRef.current);
      pendingStickRafRef.current = null;
    }
    stickRequestedRef.current = false;
  }, []);

  const cancelReturn = useCallback(() => {
    if (returnRafRef.current !== null) {
      cancelAnimationFrame(returnRafRef.current);
      returnRafRef.current = null;
    }
    returnAnimRef.current = null;
  }, []);

  const stickToBottomInstant = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    stickRequestedRef.current = true;
    if (pendingStickRafRef.current !== null) return;

    pendingStickRafRef.current = requestAnimationFrame(() => {
      pendingStickRafRef.current = null;
      if (!stickRequestedRef.current) return;
      stickRequestedRef.current = false;

      if (modeRef.current !== "STICKY_INSTANT") return;
      const m = measure(viewport);
      writeScrollTop(m.maxScrollTop);
      updateDebug();
    });
  }, [updateDebug, writeScrollTop]);

  const startReturnToBottomSmooth = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    cancelPendingStick();
    cancelReturn();

    const initial = measure(viewport);
    if (initial.distanceToBottom <= EPS_BOTTOM_PX) {
      setModeBoth("STICKY_INSTANT");
      stickToBottomInstant();
      updateDebug();
      return;
    }

    const durationMs = Math.max(
      RETURN_MIN_MS,
      Math.min(RETURN_MAX_MS, initial.distanceToBottom / RETURN_PX_PER_MS),
    );

    returnAnimRef.current = {
      startTime: performance.now(),
      startTop: initial.scrollTop,
      durationMs,
      settleFrames: 0,
    };
    setModeBoth("RETURNING_SMOOTH");

    const tick = (now: number) => {
      const viewportCurrent = viewportRef.current;
      const anim = returnAnimRef.current;
      if (!viewportCurrent || !anim || modeRef.current !== "RETURNING_SMOOTH") {
        cancelReturn();
        return;
      }

      const before = measure(viewportCurrent);
      const progress = clamp01((now - anim.startTime) / anim.durationMs);
      const eased = easeOutCubic(progress);
      const targetBottom = before.maxScrollTop;
      let nextTop = anim.startTop + (targetBottom - anim.startTop) * eased;

      // Keep the return direction monotonic under fractional jitter.
      if (nextTop < before.scrollTop) {
        nextTop = before.scrollTop;
      }

      writeScrollTop(nextTop);

      const after = measure(viewportCurrent);
      if (after.distanceToBottom <= EPS_BOTTOM_PX) {
        anim.settleFrames += 1;
      } else {
        anim.settleFrames = 0;
      }

      const doneByTime = progress >= 1;
      const doneBySettle = anim.settleFrames >= RETURN_SETTLE_FRAMES && progress >= 0.6;
      if (doneByTime && doneBySettle) {
        cancelReturn();
        setModeBoth("STICKY_INSTANT");
        stickToBottomInstant();
        updateDebug();
        return;
      }

      updateDebug();
      returnRafRef.current = requestAnimationFrame(tick);
    };

    returnRafRef.current = requestAnimationFrame(tick);
  }, [cancelPendingStick, cancelReturn, setModeBoth, stickToBottomInstant, updateDebug, writeScrollTop]);

  const onViewportScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const viewport = event.currentTarget;
      const m = measure(viewport);

      setIsOverflowing((previous) => (previous === m.isOverflowing ? previous : m.isOverflowing));

      const previousTop = prevScrollTopRef.current;
      const delta = m.scrollTop - previousTop;

      const lastWrite = lastProgrammaticWriteRef.current;
      const wroteRecently = lastWrite !== null && performance.now() - lastWrite.at < 60;
      const isLikelyOwnWrite = wroteRecently && lastWrite !== null && Math.abs(m.scrollTop - lastWrite.top) <= 2;

      if (modeRef.current === "RETURNING_SMOOTH") {
        if (!isLikelyOwnWrite && delta < -DETACH_SCROLL_DELTA_PX) {
          cancelReturn();
          setModeBoth("DETACHED");
        }
      } else if (modeRef.current === "STICKY_INSTANT") {
        if (!isLikelyOwnWrite && delta < -DETACH_SCROLL_DELTA_PX && m.isOverflowing) {
          cancelPendingStick();
          setModeBoth("DETACHED");
        }
      } else if (modeRef.current === "DETACHED") {
        if (m.distanceToBottom <= EPS_BOTTOM_PX) {
          setModeBoth("STICKY_INSTANT");
          stickToBottomInstant();
        }
      }

      prevScrollTopRef.current = m.scrollTop;
      updateDebug();
    },
    [cancelPendingStick, cancelReturn, setModeBoth, stickToBottomInstant, updateDebug],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const observer = new ResizeObserver(() => {
      const m = measure(viewport);
      setIsOverflowing((previous) => (previous === m.isOverflowing ? previous : m.isOverflowing));

      if (modeRef.current === "STICKY_INSTANT") {
        stickToBottomInstant();
      }

      updateDebug();
    });

    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [stickToBottomInstant, updateDebug]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    setModeBoth("STICKY_INSTANT");
    const initial = measure(viewport);
    writeScrollTop(initial.maxScrollTop);
    prevScrollTopRef.current = viewport.scrollTop;
    setIsOverflowing(initial.isOverflowing);
    updateDebug();
  }, [setModeBoth, updateDebug, writeScrollTop]);

  useEffect(() => {
    return () => {
      cancelPendingStick();
      cancelReturn();
    };
  }, [cancelPendingStick, cancelReturn]);

  const showJumpButton = showJumpToBottom && isOverflowing && mode === "DETACHED";

  return (
    <ScrollAreaPrimitive.Root className={cn("relative h-full w-full overflow-hidden", className)}>
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className="h-full w-full rounded-[inherit]"
        onScroll={onViewportScroll}
        data-testid="sticky-scroll-viewport"
      >
        <div ref={contentRef} className={cn("flex min-h-full w-full flex-col", contentClassName)}>
          {children}
        </div>
      </ScrollAreaPrimitive.Viewport>

      {showJumpToBottom ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
          <Button
            type="button"
            variant="secondary"
            onClick={startReturnToBottomSmooth}
            data-testid="sticky-scroll-jump"
            className={cn(
              "pointer-events-auto z-10 h-10 w-10 rounded-full p-0 shadow-base shadow-secondary transition-all duration-150",
              showJumpButton ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0",
            )}
            aria-label="Scroll to bottom"
          >
            <ChevronDown className="h-4 w-4 text-primary" />
          </Button>
        </div>
      ) : null}

      <ScrollBar className={cn(showScrollBar ? "opacity-100" : "opacity-0")} orientation="vertical" />
    </ScrollAreaPrimitive.Root>
  );
}
