import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Worker-realm build support shared by `tsup.worker-engine.config.ts` (the
 * public `@stream-mdx/worker/engine` entry) and `tsup.hosted-worker.config.ts`
 * (the self-contained hosted asset).
 *
 * Consumers bundle the public worker entry with browser-targeted tooling
 * (`npx esbuild markdown-worker.ts --bundle --platform=browser`, see
 * docs/PLUGIN_ABI.md). Browser resolution elects DOM implementations for
 * dependencies that also ship a DOM-free variant:
 *
 * - `decode-named-character-reference/index.dom.js` calls
 *   `document.createElement` at module scope.
 * - `hast-util-from-html-isomorphic/lib/browser.js` calls `new DOMParser()` at
 *   module scope.
 *
 * Both crash a Worker that has no DOM before any message is handled.
 * Worker-realm builds bundle the MDX compile pipeline and alias these
 * specifiers to the DOM-free variants that Node, SSR, and tests already
 * resolve.
 */

export const universalNamedCharacterReference = join(__dirname, "src/entities/named-character-reference.ts");

// `pkgRequire.resolve` resolves from this package like Node/SSR do, which
// elects the dependency's `worker`/`default` (DOM-free) file, not its
// `browser` file.
const pkgRequire = createRequire(join(__dirname, "package.json"));
export const universalFromHtmlIsomorphic = pkgRequire.resolve("hast-util-from-html-isomorphic");

/**
 * The complete MDX compile pipeline imported by `src/mdx-compile.ts`. Bundling
 * all of it keeps DOM-conditioned resolution out of the consumer's graph and
 * avoids require() interop wrappers for these ESM-only packages in the CJS
 * build (a wrapped namespace reaches unified as an empty preset).
 */
export const workerMdxBundlePackages: RegExp[] = [
  /^@mdx-js\/mdx$/,
  /^remark-gfm$/,
  /^remark-math$/,
  /^remark-mdx$/,
  /^remark-parse$/,
  /^rehype-slug$/,
  /^rehype-katex$/,
  /^unified$/,
  /^vfile-message$/,
];

export const workerRealmAliases: Record<string, string> = {
  "decode-named-character-reference": universalNamedCharacterReference,
  "hast-util-from-html-isomorphic": universalFromHtmlIsomorphic,
};

export function applyWorkerRealmAliases(options: { alias?: Record<string, string> }): void {
  options.alias = { ...(options.alias ?? {}), ...workerRealmAliases };
}

const bareDomSpecifier = /(?:from|require\(|import\()\s*["'](?:decode-named-character-reference|hast-util-from-html-isomorphic)["']/;

/**
 * Fails the build when a worker-realm artifact still hands consumers a bare
 * DOM-conditioned specifier. Browser-targeted resolution would elect the DOM
 * implementation, which crashes worker boot before any message is handled.
 */
export async function assertWorkerRealmBoundary(files: string[]): Promise<void> {
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    if (bareDomSpecifier.test(contents)) {
      throw new Error(
        `[stream-mdx] ${file} still resolves a DOM-conditioned module for consumers; ` +
          "the worker realm must bundle the DOM-free variant instead (see tsup.worker-realm.ts).",
      );
    }
  }
}
