"use client";

import type { ReactNode, UIEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export type BottomStickMode = "STICKY_INSTANT" | "DETACHED" | "RETURNING_SMOOTH";

export type BottomStickDebugState = {
  mode: BottomStickMode;
  isOverflowing: boolean;
  distanceToBottom: number;
  scrollTop: number;
  maxScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  programmaticWrites: number;
};

export type BottomStickJumpButtonRenderState = {
  mode: BottomStickMode;
  canJump: boolean;
  isOverflowing: boolean;
  distanceToBottom: number;
  jumpToBottom: () => void;
};

export type BottomStickScrollAreaProps = {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  showJumpToBottom?: boolean;
  onDebugStateChange?: (state: BottomStickDebugState) => void;
  onModeChange?: (mode: BottomStickMode) => void;
  debugDomAttributes?: boolean;
  renderJumpToBottom?: (state: BottomStickJumpButtonRenderState) => ReactNode;
  jumpContainerClassName?: string;
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

function joinClasses(...parts: Array<string | undefined | null | false>) {
  return parts.filter(Boolean).join(" ");
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

function DefaultJumpButton({ canJump, jumpToBottom }: { canJump: boolean; jumpToBottom: () => void }) {
  return (
    <button
      type="button"
      onClick={jumpToBottom}
      aria-label="Scroll to bottom"
      style={{
        pointerEvents: canJump ? "auto" : "none",
        borderRadius: 9999,
        border: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
        width: 40,
        height: 40,
        display: "grid",
        placeItems: "center",
        boxShadow: "0 8px 20px rgba(0,0,0,0.16)",
        background: "color-mix(in srgb, var(--background, #fff) 92%, transparent)",
        color: "var(--foreground, #111)",
        cursor: canJump ? "pointer" : "default",
      }}
    >
      <span aria-hidden>↓</span>
    </button>
  );
}

export function BottomStickScrollArea({
  children,
  className,
  viewportClassName,
  contentClassName,
  showJumpToBottom = true,
  onDebugStateChange,
  onModeChange,
  debugDomAttributes = false,
  renderJumpToBottom,
  jumpContainerClassName,
}: BottomStickScrollAreaProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const modeRef = useRef<BottomStickMode>("STICKY_INSTANT");
  const [mode, setMode] = useState<BottomStickMode>("STICKY_INSTANT");
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [distanceToBottom, setDistanceToBottom] = useState(0);

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

  const setModeBoth = useCallback(
    (next: BottomStickMode) => {
      modeRef.current = next;
      setMode(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

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
    setDistanceToBottom((previous) =>
      Math.abs(previous - m.distanceToBottom) <= 0.1 ? previous : m.distanceToBottom,
    );
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
    setDistanceToBottom(initial.distanceToBottom);
    updateDebug();
  }, [setModeBoth, updateDebug, writeScrollTop]);

  useEffect(() => {
    return () => {
      cancelPendingStick();
      cancelReturn();
    };
  }, [cancelPendingStick, cancelReturn]);

  const canJump = isOverflowing && mode === "DETACHED";
  const jumpButton = renderJumpToBottom?.({
    mode,
    canJump,
    isOverflowing,
    distanceToBottom,
    jumpToBottom: startReturnToBottomSmooth,
  }) ?? <DefaultJumpButton canJump={canJump} jumpToBottom={startReturnToBottomSmooth} />;

  const jumpContainerBase =
    "pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center transition-all duration-150";
  const jumpContainerVisibility = canJump ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0";

  return (
    <div className={joinClasses("relative h-full w-full overflow-hidden", className)}>
      <div
        ref={viewportRef}
        className={joinClasses("h-full w-full overflow-auto", viewportClassName)}
        onScroll={onViewportScroll}
        data-testid="sticky-scroll-viewport"
      >
        <div ref={contentRef} className={joinClasses("flex min-h-full w-full flex-col", contentClassName)}>
          {children}
        </div>
      </div>

      {showJumpToBottom ? (
        <div className={joinClasses(jumpContainerBase, jumpContainerVisibility, jumpContainerClassName)}>
          <div className={canJump ? "pointer-events-auto" : "pointer-events-none"}>{jumpButton}</div>
        </div>
      ) : null}
    </div>
  );
}
