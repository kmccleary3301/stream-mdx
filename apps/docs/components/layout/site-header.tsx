import { AppThemeSwitcher } from "@/components/theme";
import { Github, Search } from "lucide-react";
import { Link } from "next-view-transitions";

export function SiteHeader() {
  return (
    <div className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex w-full max-w-screen-xl items-center justify-between gap-3 px-4 py-3 md:gap-6 md:px-6 md:py-4">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          StreamMDX
        </Link>
        <nav className="hidden items-center text-sm text-muted-old md:flex md:gap-5">
          <Link className="transition hover:text-foreground" href="/demo">
            Demo
          </Link>
          <Link className="transition hover:text-foreground" href="/docs">
            Docs
          </Link>
          <Link className="transition hover:text-foreground" href="/articles">
            Articles
          </Link>
          <Link className="transition hover:text-foreground" href="/showcase">
            Showcase
          </Link>
          <Link className="transition hover:text-foreground" href="/benchmarks">
            Benchmarks
          </Link>
        </nav>
        <div className="flex items-center gap-2 md:gap-3">
          <div className="hidden items-center gap-2 rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs text-muted-old md:flex">
            <Search size={14} />
            <span className="text-xs">Search docs...</span>
            <kbd className="ml-2 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] uppercase">⌘K</kbd>
          </div>
          <Link className="hidden text-muted-old transition hover:text-foreground md:inline-flex" href="https://github.com/kmccleary3301/stream-mdx">
            <Github size={16} />
          </Link>
          <AppThemeSwitcher />
        </div>
      </div>
    </div>
  );
}
