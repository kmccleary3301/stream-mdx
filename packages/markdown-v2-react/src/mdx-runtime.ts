type MdxRuntimeModule = typeof import("./mdx-client");

let mdxRuntimePromise: Promise<MdxRuntimeModule> | null = null;

export function loadMdxRuntime(): Promise<MdxRuntimeModule> {
  if (!mdxRuntimePromise) {
    mdxRuntimePromise = import("./mdx-client");
  }
  return mdxRuntimePromise;
}

export function prefetchMdxRuntime(): void {
  void loadMdxRuntime();
}
