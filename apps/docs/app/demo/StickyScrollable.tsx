"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { subscribeToResize } from "./shared-resize-observer";

export type StickyScrollableProps = {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  innerClassName?: string;
  innerStyle?: React.CSSProperties;
  scrollToBottomButton?: boolean;
  smoothScroll?: boolean;
  /**
   * When provided, triggers an extra "scroll to bottom" attempt while locked.
   * Useful for external state machines that append in tight loops.
   */
  scrollKey?: string | number;
};

const UNLOCK_SCROLL_DELTA_PX = 3;
const LOCK_NEAR_BOTTOM_PX = 5;

export function StickyScrollable({
  children,
  className,
  style,
  innerClassName,
  innerStyle,
  scrollToBottomButton = true,
  smoothScroll = true,
  scrollKey,
}: StickyScrollableProps) {
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [locked, setLocked] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const oldScrollTopRef = useRef(0);
  const oldScrollHeightRef = useRef(0);
  const lockedRef = useRef(true);

  const setLockedState = useCallback((next: boolean) => {
    lockedRef.current = next;
    setLocked(next);
  }, []);

  const scrollToBottom = useCallback(
    ({ smooth }: { smooth?: boolean } = {}) => {
      const el = scrollRef.current;
      if (!el) return;
      const behavior: ScrollBehavior = (smooth ?? smoothScroll) ? "smooth" : "auto";
      el.scrollTo({ top: el.scrollHeight, behavior });
    },
    [smoothScroll],
  );

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    return subscribeToResize(el, () => {
      if (!lockedRef.current) return;
      scrollToBottom({ smooth: false });
    });
  }, [scrollToBottom]);

  useEffect(() => {
    if (!lockedRef.current) return;
    scrollToBottom({ smooth: false });
  }, [scrollKey, scrollToBottom]);

  const rootStyle = useMemo<React.CSSProperties>(
    () => ({
      position: "relative",
      height: "100%",
      minHeight: 0,
      overflow: "hidden",
      ...style,
    }),
    [style],
  );

  return (
    <div className={className} style={rootStyle}>
      <div
        ref={scrollRef}
        style={{ height: "100%", minHeight: 0, overflow: "auto" }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const isNowOverflowing = el.scrollHeight > el.clientHeight;
          if (isOverflowing !== isNowOverflowing) {
            setIsOverflowing(isNowOverflowing);
          }

          const userScrolledUp =
            lockedRef.current &&
            el.scrollTop < oldScrollTopRef.current - UNLOCK_SCROLL_DELTA_PX &&
            el.scrollHeight === oldScrollHeightRef.current &&
            isNowOverflowing;

          if (userScrolledUp) {
            setLockedState(false);
          } else if (
            !lockedRef.current &&
            Math.abs(el.scrollHeight - (el.scrollTop + el.clientHeight)) < LOCK_NEAR_BOTTOM_PX
          ) {
            setLockedState(true);
            scrollToBottom({});
          }

          oldScrollTopRef.current = el.scrollTop;
          oldScrollHeightRef.current = el.scrollHeight;
        }}
      >
        <div ref={contentRef} className={innerClassName} style={innerStyle}>
          {children}
        </div>
      </div>

      {scrollToBottomButton && !locked && isOverflowing ? (
        <div style={{ position: "absolute", right: 12, bottom: 12 }}>
          <button
            type="button"
            onClick={() => {
              setLockedState(true);
              scrollToBottom({});
            }}
            style={{
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--white-a12)",
              color: "var(--foreground)",
              padding: "8px 12px",
              cursor: "pointer",
              fontSize: 12,
              boxShadow: "0 8px 24px rgba(0,0,0,.12)",
            }}
          >
            Jump to bottom
          </button>
        </div>
      ) : null}
    </div>
  );
}
