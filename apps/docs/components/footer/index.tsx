import Link from "@/components/link";
import { Link as NavLink } from "next-view-transitions";

export function Footer() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-4 border-t border-border/60 pt-6 text-sm text-muted-old md:flex-row md:items-center md:justify-between">
      <div className="flex flex-wrap items-center justify-center gap-4 md:justify-start">
        <NavLink className="transition hover:text-foreground" href="/docs">
          Docs
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
      <div className="text-xs text-muted-old">Built with Next.js</div>
    </div>
  );
}
