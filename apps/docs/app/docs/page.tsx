import { Link } from "next-view-transitions";

import { CopyButton } from "@/components/copy-button";
import { docHref, getDocsRoleTracks, getDocsShellSections, getPrimaryDocSections } from "@/lib/docs-nav";

import { ArrowUpRight, BookOpenText, Code2, Rocket } from "lucide-react";

export default function DocsIndexPage() {
  const primarySections = getPrimaryDocSections();
  const startHere = primarySections.find((section) => section.title.toLowerCase() === "start here")?.items ?? [];
  const apiSection = primarySections.find((section) => section.title.toLowerCase() === "api")?.items ?? [];
  const roleTracks = getDocsRoleTracks();
  const navSections = getDocsShellSections({ includeDocsHomeLink: true });

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
    {
      title: "TUI / protocol",
      summary: "Terminal and non-React entry point, including the minimal repo example path.",
      href: "/docs/tui-json-protocol",
      cta: "Open TUI guide",
      icon: Code2,
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

  const docsUsageNotes = [
    {
      title: "Read by task",
      text: "Use the role tracks below if you are integrating React, extending worker/plugin behavior, consuming the protocol from a TUI, or validating correctness.",
    },
    {
      title: "Guides as deep dives",
      text: "The Guides section covers styling, MDX and HTML, testing, architecture, benchmarks, deployment, and Mermaid-specific behavior.",
    },
    {
      title: "Runnable examples",
      text: "The repo includes a minimal TUI example under examples/tui-minimal so terminal consumers do not have to reverse-engineer the worker and snapshot-store loop from prose alone.",
    },
  ];

  return (
    <div className="flex flex-col gap-12 text-theme-primary">
      <section className="route-panel-hero mx-auto flex w-full max-w-5xl flex-col items-center gap-4 px-6 py-10 text-center md:px-10 md:py-12">
        <div className="route-kicker">Documentation</div>
        <div className="max-w-3xl">
          <h1 className="text-3xl font-semibold leading-[1.1] tracking-tight md:text-[40px]">Docs</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">
            Start with Getting Started, then React integration, then the API. StreamMDX is designed to be a
            drop-in replacement for standard markdown renderers with a focus on high-performance streaming.
          </p>
        </div>
        <div className="route-panel inline-flex w-full max-w-md flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm shadow-sm">
          <code className="text-[13px]">{installCommand}</code>
          <CopyButton iconOnly text={installCommand} />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-old">
          {[...startHere, ...apiSection].map((item) => (
            <Link
              key={item.slug || item.title}
              href={docHref(item.slug)}
              className="route-chip"
            >
              {item.title}
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl">
        <div className="route-section-heading">
          <div>
            <div className="route-kicker">First steps</div>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Start here if you want the shortest path from installation to a working stream in React or a first look at the non-React entry
              points.
            </p>
          </div>
        </div>
        <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {firstSteps.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.title}
                className="route-grid-card group p-4 transition hover:-translate-y-0.5"
                href={item.href}
              >
                <div className="flex items-center gap-2">
                  <span className="route-icon-box text-sky-700 dark:text-sky-300">
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
        <div className="route-section-heading">
          <div>
            <div className="route-kicker">Read by role</div>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              These tracks are the real docs IA. React consumers, worker/plugin extenders, TUI consumers, and correctness reviewers should each
              have a visible path instead of one flat index.
            </p>
          </div>
        </div>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {roleTracks.map((track) => (
            <div key={track.title} className="route-grid-card p-4">
              <div className="text-sm font-semibold text-foreground">{track.title}</div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{track.summary}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-semibold text-foreground/80">Start with</span>
                <Link
                  href={track.start.href}
                  className="route-chip !px-2.5 !py-1"
                >
                  {track.start.title}
                </Link>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[12px] text-muted-foreground">
                {track.followUps.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded-full border border-border/50 bg-background/60 px-2.5 py-1 transition hover:border-border hover:text-foreground"
                  >
                    {item.title}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl">
        <div className="route-section-heading">
          <div>
            <div className="route-kicker">Explore by topic</div>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Topic browsing stays secondary to the role tracks, but it still needs enough structure to work as a quick reference map.
            </p>
          </div>
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {topics.map((topic) => (
            <Link
              key={topic.title}
              className="route-grid-card p-4 transition hover:-translate-y-0.5"
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
        <div className="route-section-heading">
          <div>
            <div className="route-kicker">Use the docs site effectively</div>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              If you are scanning rather than reading linearly, use this section as the map from role tracks into the deeper guides and
              reference material.
            </p>
          </div>
        </div>
        <div className="mt-3 grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="route-panel p-4">
            <div className="text-sm font-semibold text-foreground">Navigation model</div>
            <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-muted-foreground">
              {docsUsageNotes.map((item) => (
                <li key={item.title} className="flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-old" />
                  <span>
                    <span className="font-medium text-foreground/80">{item.title}:</span> {item.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="route-panel p-4">
            <div className="text-sm font-semibold text-foreground">Browse all sections</div>
            <div className="mt-3 grid gap-3 xl:grid-cols-3">
              {navSections.map((section) => (
                <div key={section.title} className="route-panel-soft p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-old">
                    {section.title}
                  </div>
                  <ul className="mt-2 space-y-1.5 text-[12px] text-muted-foreground">
                    {section.items.slice(0, section.title === "Guides" ? 5 : section.items.length).map((item) => (
                      <li key={item.href}>
                        <Link href={item.href} className="transition hover:text-foreground">
                          {item.title}
                        </Link>
                      </li>
                    ))}
                    {section.title === "Guides" ? (
                      <li>
                        <Link
                          href="/docs/guides"
                          className="font-medium text-foreground/80 transition hover:text-foreground"
                        >
                          View all guides
                        </Link>
                      </li>
                    ) : null}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
