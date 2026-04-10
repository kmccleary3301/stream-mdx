import { DOC_SECTIONS, type DocItem } from "@/lib/docs";
import { GUIDE_ITEMS } from "@/lib/guides";
import type { DocsNavSection } from "@/components/docs/docs-sidebar";

export type DocRoleTrack = {
  title: string;
  summary: string;
  start: { title: string; href: string };
  followUps: Array<{ title: string; href: string }>;
};

export function docHref(slug: string): string {
  if (!slug) return "/docs";
  return `/docs/${slug}`;
}

export function guideHref(slug: string): string {
  return `/docs/guides/${slug}`;
}

export function getPrimaryDocSections(): typeof DOC_SECTIONS {
  return DOC_SECTIONS;
}

export function getPrimaryDocItems(): DocItem[] {
  return DOC_SECTIONS.flatMap((section) => section.items);
}

export function getDocCollectionItems(): Array<{ slug: string; title: string }> {
  return getPrimaryDocItems()
    .filter((item) => item.slug.length > 0)
    .map((item) => ({ slug: item.slug, title: item.title }));
}

export function getGuideCollectionItems(): Array<{ slug: string; title: string }> {
  return GUIDE_ITEMS.map((guide) => ({ slug: guide.slug, title: guide.title }));
}

export function getDocsShellSections(options?: {
  includeGuides?: boolean;
  includeDocsHomeLink?: boolean;
}): DocsNavSection[] {
  const includeGuides = options?.includeGuides ?? true;
  const includeDocsHomeLink = options?.includeDocsHomeLink ?? false;

  const sections: DocsNavSection[] = DOC_SECTIONS.map((section) => ({
    title: section.title,
    items: section.items
      .filter((item) => includeDocsHomeLink || item.slug.length > 0)
      .map((item) => ({
        title: item.title,
        href: docHref(item.slug),
      })),
  })).filter((section) => section.items.length > 0);

  if (includeGuides) {
    sections.push({
      title: "Guides",
      items: [
        { title: "Guides overview", href: "/docs/guides" },
        ...GUIDE_ITEMS.map((guide) => ({
          title: guide.title,
          href: guideHref(guide.slug),
        })),
      ],
    });
  }

  return sections;
}

export function getDocsRoleTracks(): DocRoleTrack[] {
  return [
    {
      title: "React app consumer",
      summary: "Install the React package, mount the renderer, and learn the public API and integration constraints.",
      start: { title: "Getting started", href: docHref("getting-started") },
      followUps: [
        { title: "Public API", href: docHref("public-api") },
        { title: "React integration", href: docHref("react-integration") },
        { title: "Configuration", href: docHref("configuration") },
      ],
    },
    {
      title: "Plugin / worker extender",
      summary: "Work from the plugin cookbook into the worker internals and correctness contract before changing parser behavior.",
      start: { title: "Plugins cookbook", href: docHref("plugins-cookbook") },
      followUps: [
        { title: "Status / architecture", href: docHref("status") },
        { title: "Correctness contract", href: "/docs/guides/testing-and-baselines" },
        { title: "Security model", href: docHref("security-model") },
      ],
    },
    {
      title: "TUI / Node consumer",
      summary: "Start from the dedicated terminal guide, then drop into lower-level runtime and protocol details only where needed.",
      start: { title: "TUI guide", href: docHref("tui-guide") },
      followUps: [
        { title: "CLI / Node usage", href: "/docs/guides/architecture-and-internals" },
        { title: "JSON / TUI protocol", href: "/docs/tui-json-protocol" },
        { title: "Public API", href: docHref("public-api") },
      ],
    },
    {
      title: "Maintainer / correctness reviewer",
      summary: "Use the testing and baseline guide first, then the repo-side correctness contract and execution plan when you need the stronger guarantees.",
      start: { title: "Testing and baselines", href: "/docs/guides/testing-and-baselines" },
      followUps: [
        { title: "Architecture and internals", href: "/docs/guides/architecture-and-internals" },
        { title: "Performance and backpressure", href: "/docs/guides/performance-and-backpressure" },
        { title: "Comprehensive manual", href: docHref("manual") },
      ],
    },
  ];
}
