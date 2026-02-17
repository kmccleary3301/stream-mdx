import { Link } from "next-view-transitions";

import { CopyButton } from "@/components/copy-button";
import { DOC_SECTIONS } from "@/lib/docs";

import { ArrowUpRight, BookOpenText, Code2, Rocket } from "lucide-react";

function docHref(slug: string) {
  if (!slug) return "/docs";
  return `/docs/${slug}`;
}

export default function DocsIndexPage() {
  const startHere = DOC_SECTIONS.find((section) => section.title.toLowerCase() === "start here")?.items ?? [];
  const apiSection = DOC_SECTIONS.find((section) => section.title.toLowerCase() === "api")?.items ?? [];

  const installCommand = "npm install @stream-mdx/react";

  const firstSteps = [
    {
      title: "Getting started",
      summary: "Learn the core concepts and set up your first stream.",
      href: "/docs/getting-started",
      cta: "Quickstart guide",
      icon: Rocket,
    },
    {
      title: "React integration",
      summary: "Wire StreamMDX into hooks, components, and router flows.",
      href: "/docs/react-integration",
      cta: "View integration",
      icon: Code2,
    },
    {
      title: "API reference",
      summary: "Complete documentation for props, types, and defaults.",
      href: "/docs/public-api",
      cta: "Explore API",
      icon: BookOpenText,
    },
  ];

  const topics = [
    {
      title: "Configuration",
      href: "/docs/configuration",
      items: ["Global settings and defaults", "Worker hosting and core flags"],
    },
    {
      title: "Plugins",
      href: "/docs/plugins-cookbook",
      items: ["Custom syntax and extensions", "Worker-side registry"],
    },
    {
      title: "Highlighting",
      href: "/docs/guides/rendering-and-styling",
      items: ["Shiki + Prism integration", "Streaming-safe renderers"],
    },
    {
      title: "Security",
      href: "/docs/security-model",
      items: ["Sanitization policies", "CSP defaults"],
    },
    {
      title: "Performance",
      href: "/docs/guides/performance-and-backpressure",
      items: ["Benchmarks + optimization", "Scheduling heuristics"],
    },
    {
      title: "Testing",
      href: "/docs/guides/testing-and-baselines",
      items: ["Snapshot and unit testing", "Regression capture"],
    },
    {
      title: "Architecture",
      href: "/docs/guides/architecture-and-internals",
      items: ["Internals and worker pipeline", "Patch coalescing"],
    },
    {
      title: "TUI",
      href: "/docs/tui-json-protocol",
      items: ["Terminal-based rendering", "JSON stream protocol"],
    },
  ];

  const whatsNew = [
    { version: "v2.4.0", text: "Added support for Mermaid diagrams in streaming mode." },
    { version: "v2.3.8", text: "Improved backpressure handling for high-frequency updates." },
  ];

  return (
    <div className="flex flex-col gap-12 text-theme-primary">
      <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 text-center">
        <div>
          <h1 className="text-3xl font-semibold leading-[1.1] tracking-tight md:text-[40px]">Docs</h1>
          <p className="mt-3 text-sm text-muted-foreground md:text-base">
            Start with Getting Started, then React integration, then the API. StreamMDX is designed to be a
            drop-in replacement for standard markdown renderers with a focus on high-performance streaming.
          </p>
        </div>
        <div className="inline-flex w-full max-w-md flex-wrap items-center justify-between gap-2 rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-sm shadow-sm">
          <code className="text-[13px]">{installCommand}</code>
          <CopyButton iconOnly text={installCommand} />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-old">
          {[...startHere, ...apiSection].map((item) => (
            <Link
              key={item.slug || item.title}
              href={docHref(item.slug)}
              className="rounded-full border border-border/60 bg-background/60 px-3 py-1 text-[11px] uppercase tracking-[0.12em] transition hover:border-border hover:text-foreground"
            >
              {item.title}
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-old">First steps</div>
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          {firstSteps.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.title}
                className="group rounded-lg border border-border/40 bg-background p-4 transition hover:border-border hover:bg-muted/20"
                href={item.href}
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border/40 bg-muted/20 text-foreground">
                    <Icon size={14} />
                  </span>
                  <div className="text-sm font-semibold text-foreground">{item.title}</div>
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{item.summary}</p>
                <div className="mt-4 flex items-center gap-2 text-[12px] font-semibold text-foreground/80">
                  {item.cta}
                  <ArrowUpRight size={14} className="transition group-hover:translate-x-0.5" />
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-old">Explore by topic</div>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {topics.map((topic) => (
            <Link
              key={topic.title}
              className="rounded-lg border border-border/40 bg-background p-4 transition hover:border-border hover:bg-muted/20"
              href={topic.href}
            >
              <div className="text-sm font-semibold text-foreground">{topic.title}</div>
              <ul className="mt-3 space-y-1 text-[12px] text-muted-foreground">
                {topic.items.map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-old" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-old">What&apos;s new</div>
        <div className="mt-3 rounded-lg border border-border/40 bg-background p-4">
          <div className="flex flex-col gap-3 text-[13px]">
            {whatsNew.map((item) => (
              <div key={item.version} className="flex flex-wrap items-center gap-3">
                <span className="rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em]">
                  {item.version}
                </span>
                <span className="text-muted-foreground">{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
