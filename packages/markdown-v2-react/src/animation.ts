import type React from "react";
import type { AnimatedAnimationName, AnimatedOptions, AnimatedProp } from "./types";

export const DEFAULT_ANIMATED_OPTIONS: Required<AnimatedOptions> = {
  animation: "fadeIn",
  duration: 150,
  easing: "ease-out",
  sep: "word",
  stagger: 20,
  maxBacklogMs: 320,
};

export function resolveAnimatedOptions(prop: AnimatedProp | undefined): Required<AnimatedOptions> | null {
  if (!prop) return null;
  if (prop === true) return DEFAULT_ANIMATED_OPTIONS;
  return {
    animation: prop.animation ?? DEFAULT_ANIMATED_OPTIONS.animation,
    duration: typeof prop.duration === "number" ? prop.duration : DEFAULT_ANIMATED_OPTIONS.duration,
    easing: prop.easing ?? DEFAULT_ANIMATED_OPTIONS.easing,
    sep: prop.sep ?? DEFAULT_ANIMATED_OPTIONS.sep,
    stagger: typeof prop.stagger === "number" ? prop.stagger : DEFAULT_ANIMATED_OPTIONS.stagger,
    maxBacklogMs: typeof prop.maxBacklogMs === "number" ? prop.maxBacklogMs : DEFAULT_ANIMATED_OPTIONS.maxBacklogMs,
  };
}

export const STREAM_MDX_ANIMATION_CSS = `
@keyframes stream-mdx-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes stream-mdx-blur-in {
  from {
    opacity: 0;
    filter: blur(4px);
  }
  to {
    opacity: 1;
    filter: blur(0px);
  }
}

@keyframes blurIn {
  from {
    opacity: 0;
    filter: blur(4px);
  }
  to {
    opacity: 1;
    filter: blur(0px);
  }
}

@keyframes stream-mdx-slide-up {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.stream-mdx-anim {
  display: inline;
  animation-name: var(--sm-anim-name, stream-mdx-fade-in);
  animation-duration: var(--sm-anim-duration, 150ms);
  animation-timing-function: var(--sm-anim-easing, ease-out);
  animation-delay: var(--sm-anim-delay, 0ms);
  animation-fill-mode: both;
}

@media (prefers-reduced-motion: reduce) {
  .stream-mdx-anim {
    animation: none !important;
  }
}
`.trim();

const WHITESPACE_REGEX = /\s/;

export function splitWordSegments(text: string): string[] {
  const result: string[] = [];
  let current = "";
  let inWhitespace = false;
  for (const char of text) {
    const isSpace = WHITESPACE_REGEX.test(char);
    if (isSpace !== inWhitespace && current) {
      if (isSpace) {
        current += char;
        inWhitespace = true;
        continue;
      }
      result.push(current);
      current = "";
    }
    current += char;
    inWhitespace = isSpace;
  }
  if (current) {
    result.push(current);
  }
  return result;
}

export function splitTextSegments(text: string, sep: "word" | "char"): string[] {
  if (sep === "char") {
    return Array.from(text);
  }
  return splitWordSegments(text);
}

export class AnimationTimeline {
  private now: () => number;
  private maxBacklogMs: number;
  private stagger: number;
  private committedEndTime = 0;
  private cursorEndTime = 0;
  private passActive = false;
  private nodeStates = new Map<string, { count: number; delays: number[] }>();

  constructor(options?: { now?: () => number; maxBacklogMs?: number; stagger?: number }) {
    this.now = options?.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.maxBacklogMs = options?.maxBacklogMs ?? 320;
    this.stagger = options?.stagger ?? 20;
  }

  updateOptions(options: { maxBacklogMs?: number; stagger?: number }): void {
    if (typeof options.maxBacklogMs === "number") this.maxBacklogMs = options.maxBacklogMs;
    if (typeof options.stagger === "number") this.stagger = options.stagger;
  }

  beginPass(currentTime: number = this.now()): void {
    if (!this.passActive) {
      this.passActive = true;
      this.cursorEndTime = Math.min(
        Math.max(this.committedEndTime, currentTime),
        currentTime + this.maxBacklogMs,
      );
      if (typeof queueMicrotask === "function") {
        queueMicrotask(() => this.commitPass());
      } else {
        setTimeout(() => this.commitPass(), 0);
      }
    }
  }

  commitPass(): void {
    this.committedEndTime = this.cursorEndTime;
    this.passActive = false;
  }

  schedule(count: number, stagger: number = this.stagger, currentTime: number = this.now()): number[] {
    this.beginPass(currentTime);
    if (count <= 0) return [];
    const d = Math.max(0, stagger);
    const minStep = d === 0 ? 0 : Math.min(d, 4);
    const start = Math.max(this.cursorEndTime, currentTime);
    const maxDeadline = currentTime + this.maxBacklogMs;
    const projectedEnd = start + Math.max(0, count - 1) * d;
    let step = d;
    if (projectedEnd > maxDeadline && count > 1) {
      if (start < maxDeadline) {
        step = Math.max(minStep, (maxDeadline - start) / (count - 1));
      } else {
        step = minStep;
      }
    }
    const baseDelay = Math.max(0, Math.round(start - currentTime));
    this.cursorEndTime = start + count * step;
    const delays: number[] = [];
    for (let i = 0; i < count; i++) {
      delays.push(Math.round(baseDelay + i * step));
    }
    return delays;
  }

  getNodeState(key: string): { count: number; delays: number[] } {
    let state = this.nodeStates.get(key);
    if (!state) {
      state = { count: 0, delays: [] };
      this.nodeStates.set(key, state);
    }
    return state;
  }

  reset(): void {
    this.committedEndTime = 0;
    this.cursorEndTime = 0;
    this.passActive = false;
    this.nodeStates.clear();
  }
}

export interface RenderInlineAnimationContext {
  isFinalized?: boolean;
  animated?: Required<AnimatedOptions> | null;
  timeline?: AnimationTimeline | null;
  nodeKeyPrefix?: string;
}

export function resolveAnimationName(animation: AnimatedAnimationName): string {
  if (animation === "fadeIn") return "stream-mdx-fade-in";
  if (animation === "blurIn") return "stream-mdx-blur-in";
  if (animation === "slideUp") return "stream-mdx-slide-up";
  return animation;
}
