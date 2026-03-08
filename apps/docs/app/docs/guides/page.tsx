import { Link } from "next-view-transitions";

import { DocsShell } from "@/components/docs/docs-shell";
import { GUIDE_ITEMS } from "@/lib/guides";
import {
  BookOpen,
  Braces,
  Gauge,
  GitBranch,
  Lock,
  Network,
  Paintbrush,
  Plug,
  ShieldCheck,
  Sparkles,
  Waves,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const dynamic = "force-static";

export default function GuidesIndexPage() {
  const iconBySlug: Record<string, LucideIcon> = {
    "streaming-fundamentals": Waves,
    "rendering-and-styling": Paintbrush,
    "mdx-and-html": Braces,
    "plugins-and-extensions": Plug,
    "performance-and-backpressure": Gauge,
    "format-anticipation": Sparkles,
    "testing-and-baselines": ShieldCheck,
    "comparisons-and-benchmarks": Network,
    "architecture-and-internals": GitBranch,
    "deployment-and-security": Lock,
    "mermaid-diagrams": Sparkles,
  };

  const navSections = [
    {
      title: "Docs",
      items: [
        { title: "Docs home", href: "/docs" },
        { title: "Getting started", href: "/docs/getting-started" },
        { title: "Configuration", href: "/docs/configuration" },
        { title: "React integration", href: "/docs/react-integration" },
        { title: "Public API", href: "/docs/public-api" },
      ],
    },
    {
      title: "Guides",
      items: GUIDE_ITEMS.map((guide) => ({
        title: guide.title,
        href: `/docs/guides/${guide.slug}`,
      })),
    },
  ];

  return (
    <DocsShell sections={navSections} showToc={false}>
      <div className="flex flex-col gap-6 text-theme-primary">
        <div className="max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight md:text-[40px]">Guides</h1>
          <p className="mt-2 text-sm text-muted-foreground md:text-base">
            Deep dives and implementation notes for StreamMDX.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {GUIDE_ITEMS.map((item) => {
            const Icon = iconBySlug[item.slug] ?? BookOpen;
            return (
              <Link
                key={item.slug}
                className="group rounded-lg border border-border/40 bg-background p-4 transition hover:border-border hover:bg-muted/20"
                href={`/docs/guides/${item.slug}`}
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border/40 bg-muted/20 text-foreground">
                    <Icon size={14} />
                  </span>
                  <div className="text-sm font-semibold text-foreground">{item.title}</div>
                </div>
                {item.description ? (
                  <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{item.description}</p>
                ) : null}
              </Link>
            );
          })}
        </div>
      </div>
    </DocsShell>
  );
}
