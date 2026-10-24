import "/preview/deps/esbuild-wasm/lib/browser.js";

const esbuild = globalThis.esbuild;

export const build = esbuild.build;
export const initialize = esbuild.initialize;
