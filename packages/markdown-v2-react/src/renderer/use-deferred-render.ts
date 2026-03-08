import type { RefObject } from "react";
import { useEffect, useState } from "react";
import type { DeferredRenderConfig } from "./deferred-render-context";

type DeferredRenderOptions = DeferredRenderConfig & {
  enabled?: boolean;
};

export function useDeferredRender(ref: RefObject<Element>, options?: DeferredRenderOptions): boolean {
  const enabled = options?.enabled ?? true;
  const [shouldRender, setShouldRender] = useState(!enabled);

  useEffect(() => {
    if (!enabled) {
      setShouldRender(true);
      return;
    }

    const target = ref.current;
    if (!target) {
      return;
    }

    let cancelled = false;
    let idleId: number | null = null;
    let timerId: number | null = null;

    const scheduleRender = () => {
      if (cancelled) return;
      setShouldRender(true);
    };

    const runWithIdle = () => {
      if (typeof (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number }).requestIdleCallback === "function") {
        idleId = (globalThis as any).requestIdleCallback(scheduleRender, { timeout: options?.idleTimeoutMs ?? 200 });
      } else {
        timerId = window.setTimeout(scheduleRender, options?.idleTimeoutMs ?? 200);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting || entry.intersectionRatio > 0) {
            observer.disconnect();
            const debounceMs = options?.debounceMs ?? 80;
            timerId = window.setTimeout(runWithIdle, debounceMs);
            return;
          }
        }
      },
      { rootMargin: options?.rootMargin ?? "200px 0px" },
    );

    observer.observe(target);

    return () => {
      cancelled = true;
      observer.disconnect();
      if (idleId !== null && typeof (globalThis as any).cancelIdleCallback === "function") {
        (globalThis as any).cancelIdleCallback(idleId);
      }
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [enabled, options?.debounceMs, options?.idleTimeoutMs, options?.rootMargin, ref]);

  return shouldRender;
}
