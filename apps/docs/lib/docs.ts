import fs from "node:fs/promises";
import path from "node:path";

import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";

export type DocItem = {
  title: string;
  slug: string;
  file: string;
};

export type DocSection = {
  title: string;
  items: DocItem[];
};

export const DOC_SECTIONS: DocSection[] = [
  {
    title: "Start here",
    items: [
      { title: "Docs overview", slug: "", file: "README.md" },
      { title: "Getting started", slug: "getting-started", file: "GETTING_STARTED.md" },
      { title: "Configuration", slug: "configuration", file: "CONFIGURATION.md" },
    ],
  },
  {
    title: "API",
    items: [
      { title: "Public API", slug: "public-api", file: "PUBLIC_API.md" },
      { title: "React integration", slug: "react-integration", file: "REACT_INTEGRATION_GUIDE.md" },
    ],
  },
  {
    title: "Guides",
    items: [
      { title: "Security model", slug: "security-model", file: "SECURITY_MODEL.md" },
      { title: "Plugins cookbook", slug: "plugins-cookbook", file: "STREAMING_MARKDOWN_PLUGINS_COOKBOOK.md" },
      { title: "Release checklist", slug: "release-checklist", file: "STREAMING_MARKDOWN_RELEASE_CHECKLIST.md" },
      { title: "Perf harness", slug: "perf-harness", file: "PERF_HARNESS.md" },
      { title: "Perf quality changelog", slug: "perf-quality-changelog", file: "PERF_QUALITY_CHANGELOG.md" },
      { title: "Status / architecture", slug: "status", file: "STREAMING_MARKDOWN_V2_STATUS.md" },
      { title: "Streamdown comparison", slug: "streamdown-comparison", file: "STREAMDOWN_COMPARISON.md" },
      { title: "Comprehensive manual", slug: "manual", file: "COMPREHENSIVE_PROJECT_DOCUMENTATION_SITE.md" },
    ],
  },
  {
    title: "TUI",
    items: [
      { title: "JSON/TUI protocol", slug: "tui-json-protocol", file: "STREAMMDX_JSON_DIFF_SPEC.md" },
    ],
  },
];

const CUSTOM_DOC_ROUTES = new Set(["tui-json-protocol"]);

export function getAllDocSlugs(): string[] {
  return DOC_SECTIONS
    .flatMap((section) => section.items.map((item) => item.slug))
    .filter((slug) => slug.length > 0 && !CUSTOM_DOC_ROUTES.has(slug));
}

export function findDocBySlug(slug: string): DocItem | undefined {
  for (const section of DOC_SECTIONS) {
    for (const item of section.items) {
      if (item.slug === slug) return item;
    }
  }
  return undefined;
}

function docsRoot(): string {
  const repoRoot = path.resolve(process.cwd(), "../..");
  return path.resolve(repoRoot, "docs");
}

export async function readDocFile(file: string): Promise<string> {
  return await fs.readFile(path.resolve(docsRoot(), file), "utf8");
}

export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  const result = await remark()
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(markdown);

  return String(result);
}
