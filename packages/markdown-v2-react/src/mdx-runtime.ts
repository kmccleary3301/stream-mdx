import * as mdxRuntime from "./mdx-client";
type MdxRuntimeModule = typeof mdxRuntime;

// Keep registration and hydration on the renderer's single MDX module instance.
const mdxRuntimePromise: Promise<MdxRuntimeModule> = Promise.resolve(mdxRuntime);

export function loadMdxRuntime(): Promise<MdxRuntimeModule> {
  return mdxRuntimePromise;
}

