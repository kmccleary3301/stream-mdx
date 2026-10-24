import { PREVIEW_LIMITS } from "./types";
import type { PreviewController, PreviewInput, PreviewState } from "./types";

export type PreviewVariant = Readonly<{
  name: string;
  css?: string;
}>;

export type PreviewVariantsControllerOptions = Readonly<{
  variants: readonly PreviewVariant[];
  createController: (variant: PreviewVariant, onState: (state: PreviewState) => void) => PreviewController;
  onState?: (name: string, state: PreviewState) => void;
}>;

export interface PreviewVariantsController {
  request(input: PreviewInput): Promise<void>;
  getState(name: string): PreviewState | null;
  getStates(): ReadonlyMap<string, PreviewState>;
  dispose(): void;
}

export function createPreviewVariantsController(
  options: PreviewVariantsControllerOptions,
): PreviewVariantsController {
  if (options.variants.length < 1 || options.variants.length > PREVIEW_LIMITS.variants) {
    throw new Error(`Preview variants must contain between 1 and ${PREVIEW_LIMITS.variants} variants`);
  }

  const names = new Set<string>();
  const variants = options.variants.map((variant) => {
    const name = variant.name.trim();
    if (name.length === 0 || names.has(name)) {
      throw new Error("Preview variant names must be non-empty and unique");
    }
    if (variant.css !== undefined && typeof variant.css !== "string") {
      throw new Error(`Preview variant CSS for ${name} must be a string`);
    }
    names.add(name);
    return Object.freeze({ name, ...(variant.css === undefined ? {} : { css: variant.css }) });
  });

  const controllers = new Map<string, PreviewController>();
  const states = new Map<string, PreviewState>();
  let disposed = false;

  try {
    for (const variant of variants) {
      const controller = options.createController(variant, (state) => {
        if (disposed) return;
        states.set(variant.name, state);
        options.onState?.(variant.name, state);
      });
      controllers.set(variant.name, controller);
    }
  } catch (error) {
    disposed = true;
    for (const controller of controllers.values()) controller.dispose();
    throw error;
  }

  return {
    async request(input) {
      if (disposed) throw new Error("Preview variants controller has been disposed");
      await Promise.all([...controllers.values()].map((controller) => controller.request(input)));
    },
    getState(name) {
      return states.get(name) ?? null;
    },
    getStates() {
      return new Map(states);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of controllers.values()) controller.dispose();
    },
  };
}
