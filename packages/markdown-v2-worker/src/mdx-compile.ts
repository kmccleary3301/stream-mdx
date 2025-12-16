import { compile as compileMdx } from "@mdx-js/mdx";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

function collectMdxDependencies(source: string): string[] {
  const dependencies = new Set<string>();
  const importRegex = /(?:import|export)\s+[^'"]*?\sfrom\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while (true) {
    match = importRegex.exec(source);
    if (match === null) {
      break;
    }
    dependencies.add(match[1]);
  }
  return Array.from(dependencies);
}

/**
 * Shared MDX compilation helper used by both the worker (mdxCompileMode="worker")
 * and the server-side MDX compile endpoint.
 *
 * The goal is to keep the remark/rehype pipeline identical so that server and
 * worker compilation strategies produce equivalent component code and HTML.
 */
export async function compileMdxContent(source: string): Promise<{ code: string; dependencies: string[] }> {
  const isDev = typeof process !== "undefined" && typeof process.env !== "undefined" && process.env?.NODE_ENV === "development";

  const compiled = await compileMdx(source, {
    outputFormat: "function-body",
    development: isDev,
    remarkPlugins: [remarkGfm, remarkMath],
    rehypePlugins: [
      rehypeSlug,
      [
        rehypeKatex,
        {
          throwOnError: false,
          errorColor: "#cc0000",
          strict: false,
        },
      ],
    ],
    jsxImportSource: "react",
  });

  return {
    code: String(compiled),
    dependencies: collectMdxDependencies(source),
  };
}
