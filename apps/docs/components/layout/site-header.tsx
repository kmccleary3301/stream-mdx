import { AppThemeSwitcher } from "@/components/theme";
import { Github, Search } from "lucide-react";
import { Link } from "next-view-transitions";

export function SiteHeader() {
  return (
    <div className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/78 shadow-[0_20px_60px_-48px_rgba(15,23,42,0.55)] backdrop-blur-2xl supports-[backdrop-filter]:bg-background/62">
      <div className="mx-auto flex w-full max-w-screen-xl items-center justify-between gap-3 px-4 py-3 md:gap-6 md:px-6 md:py-4">
        <Link href="/" className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
          <span className="route-icon-box h-8 w-8 rounded-xl bg-white/70 text-[11px] font-bold shadow-[0_16px_30px_-24px_rgba(15,23,42,0.45)]">SM</span>
          <span className="flex flex-col leading-none">
            <span>StreamMDX</span>
            <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-old">Streaming renderer</span>
          </span>
        </Link>
        <nav className="hidden items-center rounded-full border border-border/60 bg-white/55 p-1 text-sm text-muted-old shadow-[0_18px_36px_-30px_rgba(15,23,42,0.4)] md:flex md:gap-1">
          <Link className="rounded-full px-3 py-2 transition hover:bg-white/80 hover:text-foreground" href="/demo">
            Demo
          </Link>
          <Link className="rounded-full px-3 py-2 transition hover:bg-white/80 hover:text-foreground" href="/docs">
            Docs
          </Link>
          <Link className="rounded-full px-3 py-2 transition hover:bg-white/80 hover:text-foreground" href="/articles">
            Articles
          </Link>
          <Link className="rounded-full px-3 py-2 transition hover:bg-white/80 hover:text-foreground" href="/showcase">
            Showcase
          </Link>
          <Link className="rounded-full px-3 py-2 transition hover:bg-white/80 hover:text-foreground" href="/benchmarks">
            Benchmarks
          </Link>
        </nav>
        <div className="flex items-center gap-2 md:gap-3">
          <div className="hidden items-center gap-2 rounded-full border border-border/70 bg-white/65 px-3 py-1.5 text-xs text-muted-old shadow-[0_16px_34px_-28px_rgba(15,23,42,0.45)] backdrop-blur md:flex">
            <Search size={14} />
            <span className="text-xs">Search docs...</span>
            <kbd className="ml-2 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] uppercase">⌘K</kbd>
          </div>
          <Link className="hidden rounded-full border border-border/70 bg-white/65 p-2 text-muted-old transition hover:text-foreground md:inline-flex" href="https://github.com/kmccleary3301/stream-mdx">
            <Github size={16} />
          </Link>
          <AppThemeSwitcher />
        </div>
      </div>
    </div>
  );
}
