import Link from "@/components/link";
import { Link as NavLink } from "next-view-transitions";

export function Footer() {
  return (
    <div className="route-panel mx-auto flex w-full max-w-5xl flex-col gap-5 px-5 py-6 text-sm text-muted-old md:flex-row md:items-end md:justify-between md:px-6">
      <div className="flex flex-col gap-3">
        <div>
          <div className="route-kicker">StreamMDX</div>
          <div className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Worker-first streaming Markdown and MDX for React, benchmarked locally and hardened with seeded regression gates.
          </div>
        </div>
        <NavLink className="transition hover:text-foreground" href="/docs">
          <span className="route-chip">Docs</span>
        </NavLink>
        <div className="flex flex-wrap items-center gap-2 md:justify-start">
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
      <div className="flex flex-col gap-2 text-xs text-muted-old md:items-end">
        <div>Built with Next.js</div>
        <div className="max-w-xs text-right leading-relaxed text-muted-foreground">
          Public docs, demo, benchmarks, showcase articles, and protocol references live in one surface.
        </div>
      </div>
    </div>
  );
}
