import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "Element",
  "HTMLElement",
  "Node",
  "ResizeObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
  "performance",
] as const;

type DomGlobalSnapshot = Array<{
  name: (typeof DOM_GLOBALS)[number];
  descriptor: PropertyDescriptor | undefined;
}>;

function captureDomGlobals(): DomGlobalSnapshot {
  const target = globalThis as unknown as Record<string, unknown>;
  return DOM_GLOBALS.map((name) => ({ name, descriptor: Object.getOwnPropertyDescriptor(target, name) }));
}

function restoreDomGlobals(snapshot: DomGlobalSnapshot): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const { name, descriptor } of snapshot) {
    if (descriptor) {
      Object.defineProperty(target, name, descriptor);
    } else {
      delete target[name];
    }
  }
}

async function testReducedMotionAndUserInterruption(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const globalsBefore = captureDomGlobals();
  const globalTarget = globalThis as unknown as Record<string, unknown>;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  // Keep one frame from completing the animation while publishing its mode to the debug DOM.
  const deterministicFrameTime = 0;
  Object.defineProperty(globalTarget, "performance", {
    configurable: true,
    value: { now: () => deterministicFrameTime },
  });
  const requestFrame = (callback: FrameRequestCallback): number => {
    const id = ++nextFrameId;
    pendingFrames.set(id, callback);
    return id;
  };
  const cancelFrame = (id: number): void => {
    pendingFrames.delete(id);
  };

  class TestResizeObserver {
    private readonly observedTargets = new Set<Element>();

    constructor(_callback: ResizeObserverCallback) {}

    observe(target: Element): void {
      this.observedTargets.add(target);
    }

    unobserve(target: Element): void {
      this.observedTargets.delete(target);
    }

    disconnect(): void {
      this.observedTargets.clear();
    }
  }

  class TestMediaQueryListEvent extends window.Event implements MediaQueryListEvent {
    readonly matches: boolean;
    readonly media: string;

    constructor(media: string, matches: boolean) {
      super("change");
      this.media = media;
      this.matches = matches;
    }
  }

  class TestMediaQueryList extends window.EventTarget implements MediaQueryList {
    readonly media = "(prefers-reduced-motion: reduce)";
    matches: boolean;
    onchange: MediaQueryList["onchange"] = null;
    private readonly legacyListeners = new Set<NonNullable<MediaQueryList["onchange"]>>();

    constructor(matches: boolean) {
      super();
      this.matches = matches;
    }

    addListener(listener: MediaQueryList["onchange"]): void {
      if (listener) this.legacyListeners.add(listener);
    }

    removeListener(listener: MediaQueryList["onchange"]): void {
      if (listener) this.legacyListeners.delete(listener);
    }

    setMatches(matches: boolean): void {
      this.matches = matches;
      const event = new TestMediaQueryListEvent(this.media, this.matches);
      this.dispatchEvent(event);
      for (const listener of this.legacyListeners) {
        listener.call(this, event);
      }
      this.onchange?.call(this, event);
    }
  }

  const mediaQuery = new TestMediaQueryList(true);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (_query: string) => mediaQuery,
  });
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("data-testid") === "sticky-scroll-viewport" ? 100 : 0;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("data-testid") === "sticky-scroll-viewport" ? 1000 : 0;
    },
  });

  globalTarget.IS_REACT_ACT_ENVIRONMENT = true;
  globalTarget.window = window;
  globalTarget.document = window.document;
  Object.defineProperty(globalTarget, "navigator", {
    configurable: true,
    value: window.navigator,
  });
  globalTarget.Element = window.Element;
  globalTarget.HTMLElement = window.HTMLElement;
  globalTarget.Node = window.Node;
  globalTarget.ResizeObserver = TestResizeObserver;
  globalTarget.requestAnimationFrame = requestFrame;
  globalTarget.cancelAnimationFrame = cancelFrame;
  window.requestAnimationFrame = requestFrame;
  window.cancelAnimationFrame = cancelFrame;

  let menuItemActivations = 0;
  let root: Root | undefined;
  try {
    // ReactDOM selects its input-event polyfill at import time, so initialize it only after installing JSDOM globals.
    const { createRoot } = await import("react-dom/client");
    const { BottomStickScrollArea } = await import("../src/components/bottom-stick-scroll-area");
    const container = window.document.getElementById("root");
    assert.ok(container, "missing scroll-area test root");
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <BottomStickScrollArea
          debugDomAttributes
          renderJumpToBottom={({ jumpToBottom, mode }) => (
            <button type="button" data-testid="jump" data-mode={mode} onClick={jumpToBottom}>
              jump
            </button>
          )}
        >
          <input data-testid="editable" />
          <div contentEditable suppressContentEditableWarning data-testid="contenteditable" />
          <button data-testid="native-activation">activate</button>
          <div
            role="menuitem"
            tabIndex={0}
            data-testid="menuitem"
            onClick={() => {
              menuItemActivations += 1;
            }}
            onKeyUp={(event) => {
              if (event.key === " ") event.currentTarget.click();
            }}
          >
            activate on Space keyup
          </div>
        </BottomStickScrollArea>,
      );
    });

    const viewport = container.querySelector<HTMLDivElement>('[data-testid="sticky-scroll-viewport"]');
    assert.ok(viewport, "missing sticky scroll viewport");
    const jumpButton = (): HTMLButtonElement => {
      const button = container.querySelector<HTMLButtonElement>('[data-testid="jump"]');
      assert.ok(button, "missing custom jump button");
      return button;
    };
    const jumpContainer = (): HTMLElement => {
      const element = jumpButton().parentElement?.parentElement;
      assert.ok(element, "missing jump chrome container");
      return element;
    };
    const scrollUp = async (): Promise<void> => {
      await act(async () => {
        viewport.scrollTop = 500;
        viewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      });
      assert.equal(viewport.dataset.stickyMode, "DETACHED", "upward scroll should detach from the bottom");
    };
    const flushNextFrame = async (): Promise<void> => {
      const nextFrame = pendingFrames.entries().next().value;
      assert.ok(nextFrame, "missing scheduled animation frame");
      const [id, callback] = nextFrame;
      pendingFrames.delete(id);
      await act(async () => {
        callback(deterministicFrameTime);
      });
    };
    const startReturn = async (): Promise<void> => {
      await act(async () => {
        jumpButton().click();
      });
      assert.equal(pendingFrames.size, 1, "smooth return should schedule a frame");
      await flushNextFrame();
      assert.equal(viewport.dataset.stickyMode, "RETURNING_SMOOTH", "normal preference should begin a smooth return");
      assert.equal(pendingFrames.size, 1, "smooth return should keep its next frame scheduled");
    };

    assert.equal(viewport.scrollTop, 900, "initial mount should stick to the bottom");
    assert.equal(jumpContainer().style.transition, "none", "initial reduced preference should disable jump chrome motion");
    assert.equal(jumpContainer().style.transform, "none", "initial reduced preference should remove the spatial offset");
    await scrollUp();
    await act(async () => {
      jumpButton().click();
    });
    assert.equal(viewport.dataset.stickyMode, "STICKY_INSTANT", "reduced-motion jump should become sticky immediately");
    assert.equal(viewport.scrollTop, 900, "reduced-motion jump should write the bottom position immediately");
    assert.equal(pendingFrames.size, 0, "reduced-motion jump should not schedule a return frame");

    await act(async () => {
      mediaQuery.setMatches(false);
    });
    assert.equal(jumpContainer().style.transition, "opacity 150ms ease, transform 150ms ease");

    await scrollUp();
    await startReturn();
    const wheel = new window.WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    await act(async () => {
      viewport.dispatchEvent(wheel);
    });
    assert.equal(viewport.dataset.stickyMode, "DETACHED", "wheel intent should detach before a scroll delta");
    assert.equal(viewport.scrollTop, 500, "wheel intent should not need an actual scroll delta");
    assert.equal(wheel.defaultPrevented, false, "wheel intent must retain native scrolling");
    assert.equal(pendingFrames.size, 0, "wheel intent should cancel the return frame");

    await startReturn();
    const touchStart = new window.Event("touchstart", { bubbles: true, cancelable: true });
    await act(async () => {
      viewport.dispatchEvent(touchStart);
    });
    assert.equal(viewport.dataset.stickyMode, "DETACHED", "touch intent should detach before a scroll delta");
    assert.equal(touchStart.defaultPrevented, false, "touch intent must retain native scrolling");
    assert.equal(pendingFrames.size, 0, "touch intent should cancel the return frame");

    await startReturn();
    const scrollKey = new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    await act(async () => {
      viewport.dispatchEvent(scrollKey);
    });
    assert.equal(viewport.dataset.stickyMode, "DETACHED", "scroll-key intent should detach immediately");
    assert.equal(scrollKey.defaultPrevented, false, "scroll-key intent must retain native scrolling");
    assert.equal(pendingFrames.size, 0, "scroll-key intent should cancel the return frame");

    await startReturn();
    const editable = container.querySelector<HTMLInputElement>('[data-testid="editable"]');
    assert.ok(editable, "missing editable child");
    await act(async () => {
      editable.focus();
      editable.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    assert.equal(viewport.dataset.stickyMode, "RETURNING_SMOOTH", "editable keyboard input must not interrupt the return");
    assert.equal(pendingFrames.size, 1, "editable keyboard input must leave the return frame scheduled");

    const contentEditable = container.querySelector<HTMLDivElement>('[data-testid="contenteditable"]');
    assert.ok(contentEditable, "missing contenteditable child");
    await act(async () => {
      contentEditable.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
      );
    });
    assert.equal(viewport.dataset.stickyMode, "RETURNING_SMOOTH", "contenteditable keyboard input must not interrupt the return");
    assert.equal(pendingFrames.size, 1, "contenteditable keyboard input must leave the return frame scheduled");

    const nativeActivation = container.querySelector<HTMLButtonElement>('[data-testid="native-activation"]');
    assert.ok(nativeActivation, "missing native activation button");
    const spaceKey = new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    await act(async () => {
      nativeActivation.dispatchEvent(spaceKey);
    });
    assert.equal(viewport.dataset.stickyMode, "RETURNING_SMOOTH", "Space on a button must remain native activation, not scroll intent");
    assert.equal(spaceKey.defaultPrevented, false, "button activation must not be prevented");
    assert.equal(pendingFrames.size, 1, "native button activation must leave the return frame scheduled");

    const menuItem = container.querySelector<HTMLDivElement>('[data-testid="menuitem"]');
    assert.ok(menuItem, "missing custom menu item");
    const menuItemSpaceKeyDown = new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    const menuItemSpaceKeyUp = new window.KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true });
    await act(async () => {
      menuItem.dispatchEvent(menuItemSpaceKeyDown);
      menuItem.dispatchEvent(menuItemSpaceKeyUp);
    });
    assert.equal(menuItemActivations, 1, "Space keyup should activate the consumer menu item exactly once");
    assert.equal(viewport.dataset.stickyMode, "RETURNING_SMOOTH", "menu-item Space activation must not interrupt the return");
    assert.equal(menuItemSpaceKeyDown.defaultPrevented, false, "menu-item Space keydown must retain native behavior");
    assert.equal(menuItemSpaceKeyUp.defaultPrevented, false, "menu-item Space keyup must retain consumer activation");
    assert.equal(pendingFrames.size, 1, "menu-item Space activation must leave the return frame scheduled");

    await act(async () => {
      mediaQuery.setMatches(true);
    });
    assert.equal(viewport.dataset.stickyMode, "STICKY_INSTANT", "activating reduced motion should finish an ongoing return");
    assert.equal(viewport.scrollTop, 900, "activating reduced motion should finish at the bottom");
    assert.equal(pendingFrames.size, 0, "activating reduced motion should cancel the ongoing RAF");
    assert.equal(jumpContainer().style.transition, "none", "dynamic reduced preference should disable jump chrome motion");
    assert.equal(jumpContainer().style.transform, "none", "dynamic reduced preference should remove the spatial offset");

    await scrollUp();
    await act(async () => {
      jumpButton().click();
    });
    assert.equal(viewport.dataset.stickyMode, "STICKY_INSTANT", "jump after preference change should remain instant");
    assert.equal(viewport.scrollTop, 900, "jump after preference change should write the bottom position");
    assert.equal(pendingFrames.size, 0, "jump after preference change should not schedule a return frame");
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    restoreDomGlobals(globalsBefore);
    dom.window.close();
  }
}

await testReducedMotionAndUserInterruption();
console.log("bottom stick reduced-motion and interruption regression passed");
