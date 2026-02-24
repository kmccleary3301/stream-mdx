"use client";

import { cn } from "@/lib/utils";
import {
  BottomStickScrollArea as StreamMdxBottomStickScrollArea,
  type BottomStickDebugState,
  type BottomStickMode,
} from "@stream-mdx/react";
import { ChevronDown } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

/**
 * LOCKED visual/behavior contract for docs/demo usage.
 * Keep this id and style stable unless sticky-scroll checks are intentionally updated.
 */
export const STICKY_SCROLL_LOCK_ID = "docs-bottom-stick-v1";

const LOCKED_JUMP_BUTTON_STYLE: CSSProperties = Object.freeze({
  backgroundColor: "#ffffff",
  color: "#000000",
  borderColor: "rgba(0, 0, 0, 0.2)",
  boxShadow: "0 10px 18px rgba(0, 0, 0, 0.32)",
});

type BottomStickScrollAreaProps = {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  showScrollBar?: boolean;
  showJumpToBottom?: boolean;
  onDebugStateChange?: (state: BottomStickDebugState) => void;
  debugDomAttributes?: boolean;
};

export function BottomStickScrollArea({
  children,
  className,
  contentClassName,
  showScrollBar = true,
  showJumpToBottom = true,
  onDebugStateChange,
  debugDomAttributes = false,
}: BottomStickScrollAreaProps) {
  const [debugState, setDebugState] = useState<BottomStickDebugState>({
    mode: "STICKY_INSTANT",
    isOverflowing: false,
    distanceToBottom: 0,
    scrollTop: 0,
    maxScrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    programmaticWrites: 0,
  });

  const customThumbStyle = useMemo(() => {
    if (!showScrollBar || !debugState.isOverflowing || debugState.clientHeight <= 0) {
      return null;
    }
    const trackInset = 1;
    const trackHeight = Math.max(0, debugState.clientHeight - trackInset * 2);
    if (trackHeight <= 0) return null;

    const ratio = debugState.clientHeight / Math.max(debugState.scrollHeight, 1);
    const minThumbPx = 24;
    const thumbHeight = Math.max(minThumbPx, Math.min(trackHeight, Math.round(trackHeight * ratio)));
    const topRange = Math.max(0, trackHeight - thumbHeight);
    const progress =
      debugState.maxScrollTop > 0 ? Math.max(0, Math.min(1, debugState.scrollTop / debugState.maxScrollTop)) : 0;
    const top = trackInset + topRange * progress;

    return { top, height: thumbHeight };
  }, [debugState, showScrollBar]);

  const handleDebugStateChange = useCallback(
    (state: BottomStickDebugState) => {
      setDebugState((previous) => {
        if (
          previous.mode === state.mode &&
          previous.isOverflowing === state.isOverflowing &&
          Math.abs(previous.distanceToBottom - state.distanceToBottom) < 0.1 &&
          Math.abs(previous.scrollTop - state.scrollTop) < 0.1 &&
          Math.abs(previous.maxScrollTop - state.maxScrollTop) < 0.1 &&
          Math.abs(previous.scrollHeight - state.scrollHeight) < 0.1 &&
          Math.abs(previous.clientHeight - state.clientHeight) < 0.1 &&
          previous.programmaticWrites === state.programmaticWrites
        ) {
          return previous;
        }
        return state;
      });
      onDebugStateChange?.(state);
    },
    [onDebugStateChange],
  );

  return (
    <div className="relative h-full w-full" data-sticky-scroll-lock={STICKY_SCROLL_LOCK_ID}>
      <StreamMdxBottomStickScrollArea
        className={cn("h-full w-full", className)}
        viewportClassName={cn(
          "h-full w-full rounded-[inherit] overflow-auto pr-2.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        contentClassName={cn("flex min-h-full w-full flex-col", contentClassName)}
        showJumpToBottom={showJumpToBottom}
        onDebugStateChange={handleDebugStateChange}
        debugDomAttributes={debugDomAttributes}
        renderJumpToBottom={({ mode, canJump, jumpToBottom }) => (
          <JumpToBottomButton mode={mode} canJump={canJump} jumpToBottom={jumpToBottom} />
        )}
      >
        {children}
      </StreamMdxBottomStickScrollArea>

      {showScrollBar ? (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute right-0 top-0 h-full w-2.5 border-l border-l-transparent p-[1px] transition-opacity",
            customThumbStyle ? "opacity-100" : "opacity-0",
          )}
        >
          {customThumbStyle ? (
            <div
              className="absolute left-[1px] right-[1px] rounded-full bg-border"
              style={{ top: customThumbStyle.top, height: customThumbStyle.height }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function JumpToBottomButton({
  mode,
  canJump,
  jumpToBottom,
}: {
  mode: BottomStickMode;
  canJump: boolean;
  jumpToBottom: () => void;
}) {
  return (
    <button
      type="button"
      onClick={jumpToBottom}
      data-testid="sticky-scroll-jump"
      data-sticky-scroll-lock={STICKY_SCROLL_LOCK_ID}
      className={cn(
        "z-10 inline-flex h-11 w-11 items-center justify-center rounded-full border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        canJump ? "translate-y-0 opacity-100 pointer-events-auto" : "translate-y-1 opacity-0 pointer-events-none",
        mode === "RETURNING_SMOOTH" ? "ring-1 ring-border/60" : "",
      )}
      style={LOCKED_JUMP_BUTTON_STYLE}
      aria-label="Scroll to bottom"
    >
      <ChevronDown className="h-4 w-4" />
    </button>
  );
}
