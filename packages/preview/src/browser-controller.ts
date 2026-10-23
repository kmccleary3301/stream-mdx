import { createPreviewController } from "./controller";
import { createEsbuildCompiler } from "./esbuild-compiler";
import { createBrowserTransport, freshFrameAssetURL } from "./iframe-transport";
import type { BrowserPreviewOptions } from "./iframe-transport";
import { PREVIEW_LIMITS } from "./types";
import type { PreviewCompileContext, PreviewCompiler, PreviewController, PreviewState, TailwindStylesheetName } from "./types";
import { createPreviewVariantsController } from "./variant-controller";
import type { PreviewVariant, PreviewVariantsController } from "./variant-controller";

const encoder = new TextEncoder();

function createTailwindStylesheetLoader(
  baseURL: string | URL,
): (name: TailwindStylesheetName, context: PreviewCompileContext) => Promise<string> {
  const base = freshFrameAssetURL(baseURL, "Tailwind runtime assets");
  return async (name, context) => {
    const assetURL = freshFrameAssetURL(new URL(name, base), "Tailwind stylesheet");
    const response = await fetch(assetURL, { credentials: "omit", redirect: "error" });
    if (!context.isCurrent()) throw new Error("Preview compilation was superseded");
    if (!response.ok) throw new Error(`Local Tailwind stylesheet request failed with HTTP ${response.status}`);
    const stylesheet = await response.text();
    if (!context.isCurrent()) throw new Error("Preview compilation was superseded");
    if (encoder.encode(stylesheet).byteLength > PREVIEW_LIMITS.inputBytes) {
      throw new Error("Local Tailwind stylesheet exceeds the preview input bound");
    }
    return stylesheet;
  };
}

function createBrowserController(
  container: HTMLElement,
  options: BrowserPreviewOptions,
  variantCSS: string,
  onState?: (state: PreviewState) => void,
): PreviewController {
  const wasmURL = freshFrameAssetURL(options.wasmURL, "esbuild-wasm");
  const tailwindAssetsURL = freshFrameAssetURL(options.tailwindAssetsURL, "Tailwind runtime");
  const transport = createBrowserTransport(container, options.reactRuntimeURL);
  const baseCompiler = createEsbuildCompiler({
    wasmURL,
    loadTailwindStylesheet: createTailwindStylesheetLoader(tailwindAssetsURL),
  });
  const compile: PreviewCompiler =
    variantCSS.length === 0
      ? baseCompiler
      : async (input, context) => {
          const output = await baseCompiler(input, context);
          if (!context.isCurrent()) throw new Error("Preview compilation was superseded");
          return {
            javascript: output.javascript,
            css: [output.css ?? "", variantCSS].filter((source) => source.length > 0).join("\n"),
          };
        };
  return createPreviewController({ compile, transport, onState });
}

export function createBrowserPreviewController(
  container: HTMLElement,
  options: BrowserPreviewOptions,
): PreviewController {
  return createBrowserController(container, options, "", options.onState);
}

export type BrowserPreviewVariantsOptions = Omit<BrowserPreviewOptions, "onState"> &
  Readonly<{ onState?: (name: string, state: PreviewState) => void }>;

export function createBrowserPreviewVariantsController(
  container: HTMLElement,
  variants: readonly PreviewVariant[],
  options: BrowserPreviewVariantsOptions,
): PreviewVariantsController {
  const document = container.ownerDocument;
  const { onState: onVariantState, ...browserOptions } = options;
  return createPreviewVariantsController({
    variants,
    onState: onVariantState,
    createController(variant, onState) {
      const card = document.createElement("section");
      card.className = "stream-mdx-preview-variant";
      card.dataset.previewVariant = variant.name;
      const heading = document.createElement("h2");
      heading.textContent = variant.name;
      const previewSlot = document.createElement("div");
      previewSlot.className = "stream-mdx-preview-variant__frame";
      card.append(heading, previewSlot);
      container.append(card);
      try {
        const controller = createBrowserController(previewSlot, browserOptions, variant.css ?? "", onState);
        return {
          request: (input) => controller.request(input),
          getState: () => controller.getState(),
          dispose() {
            controller.dispose();
            card.remove();
          },
        };
      } catch (error) {
        card.remove();
        throw error;
      }
    },
  });
}
