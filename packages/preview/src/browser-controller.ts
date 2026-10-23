import { createPreviewController } from "./controller";
import { createEsbuildCompiler } from "./esbuild-compiler";
import { createBrowserTransport, freshFrameAssetURL } from "./iframe-transport";
import type { BrowserPreviewOptions } from "./iframe-transport";
import type { PreviewController } from "./types";

export function createBrowserPreviewController(
  container: HTMLElement,
  options: BrowserPreviewOptions,
): PreviewController {
  const wasmURL = freshFrameAssetURL(options.wasmURL, "esbuild-wasm");
  const transport = createBrowserTransport(container, options.reactRuntimeURL);
  return createPreviewController({
    compile: createEsbuildCompiler({ wasmURL }),
    transport,
    onState: options.onState,
  });
}
