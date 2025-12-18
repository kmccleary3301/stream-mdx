export type ResizeCallback = (entry: ResizeObserverEntry) => void;

type CallbackSet = Set<ResizeCallback>;

let observer: ResizeObserver | null = null;
const callbacksByTarget = new Map<Element, CallbackSet>();

function ensureObserver(): ResizeObserver | null {
  if (observer) return observer;
  if (typeof window === "undefined") return null;
  if (typeof ResizeObserver === "undefined") return null;

  observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const callbacks = callbacksByTarget.get(entry.target);
      if (!callbacks || callbacks.size === 0) continue;
      for (const callback of callbacks) {
        try {
          callback(entry);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn("[docs] resize observer callback failed", error);
        }
      }
    }
  });

  return observer;
}

export function subscribeToResize(target: Element, callback: ResizeCallback): () => void {
  const ro = ensureObserver();
  if (!ro) {
    return () => {};
  }

  let callbacks = callbacksByTarget.get(target);
  if (!callbacks) {
    callbacks = new Set();
    callbacksByTarget.set(target, callbacks);
    ro.observe(target);
  }

  callbacks.add(callback);

  return () => {
    const set = callbacksByTarget.get(target);
    if (!set) return;
    set.delete(callback);
    if (set.size === 0) {
      callbacksByTarget.delete(target);
      try {
        ro.unobserve(target);
      } catch {
        // ignore
      }
    }
  };
}

