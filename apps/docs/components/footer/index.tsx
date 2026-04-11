import Link from "@/components/link";
import { Link as NavLink } from "next-view-transitions";

export function Footer() {
  return (
    <div className="route-panel mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-6 text-sm text-muted-old md:flex-row md:items-end md:justify-between md:px-6">
      <div className="flex flex-col gap-3">
        <div>
          <div className="route-kicker">StreamMDX</div>
          <div className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Worker-first streaming Markdown and MDX for React, benchmarked locally and hardened with seeded regression gates.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="route-chip">Worker parser</span>
          <span className="route-chip">Seeded replay</span>
          <span className="route-chip">Public benchmark lab</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-start">
          <NavLink className="transition hover:text-foreground" href="/docs">
            <span className="route-chip">Docs</span>
          </NavLink>
          <NavLink className="transition hover:text-foreground" href="/demo">
            Demo
          </NavLink>
          <NavLink className="transition hover:text-foreground" href="/benchmarks">
            Benchmarks
          </NavLink>
          <NavLink className="transition hover:text-foreground" href="/showcase">
            Showcase
          </NavLink>
          <Link href="https://github.com/kmccleary3301/stream-mdx" text="GitHub" underline />
        </div>
      </div>
      <div className="grid gap-3 text-xs text-muted-old md:max-w-sm md:justify-items-end">
        <div className="route-panel-soft grid gap-2 px-4 py-3 md:text-right">
          <div className="route-stat-label">Surface</div>
          <div className="leading-relaxed text-muted-foreground">
            Public docs, demo, benchmarks, showcase articles, and protocol references live in one surface.
          </div>
        </div>
        <div>Built with Next.js</div>
      </div>
    </div>
  );
}
