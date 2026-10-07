"use client";

import { AppThemeSwitcher } from "@/components/theme";
import { CommandPalette } from "@/components/chrome/command-palette";
import { PRIMARY_NAV } from "@/lib/site-map-client";
import { cn } from "@/lib/utils";
import { Github, Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { Link } from "next-view-transitions";

function normalizePath(pathname: string | null) {
  if (!pathname) return "/";
  return pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

function isActivePath(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader() {
  const pathname = normalizePath(usePathname());

  return (
    <div className="sticky top-0 z-50 w-full border-b border-border/70 bg-background/72 backdrop-blur-xl supports-[backdrop-filter]:bg-background/58">
      <div className="mx-auto flex w-full max-w-screen-xl items-center justify-between gap-3 px-4 py-3 md:gap-6 md:px-6 md:py-4">
        <Link href="/" className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
          <span className="route-icon-box h-8 w-8 rounded-xl text-[11px] font-bold">SM</span>
          <span className="flex flex-col leading-none">
            <span>StreamMDX</span>
            <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-old">Streaming renderer</span>
          </span>
        </Link>
        <nav className="hidden items-center text-sm text-muted-old md:flex md:gap-1" aria-label="Primary navigation">
          {PRIMARY_NAV.map((item) => {
            const active = isActivePath(pathname, item.href);
            return (
              <Link
                key={item.href}
                className={cn(
                  "rounded-full px-3 py-2 transition hover:bg-muted/30 hover:text-foreground",
                  active && "bg-muted/30 text-foreground",
                )}
                href={item.href}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2 md:gap-3">
          <CommandPalette />
          <Link
            className="hidden rounded-full border border-border/70 bg-background/80 p-2 text-muted-old transition hover:text-foreground md:inline-flex"
            href="https://github.com/kmccleary3301/stream-mdx"
            target="_blank"
            rel="noreferrer"
            aria-label="StreamMDX on GitHub"
          >
            <Github size={16} />
          </Link>
          <AppThemeSwitcher />
          <details className="relative md:hidden">
            <summary className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-full border border-border/70 bg-background/80 text-muted-old transition hover:text-foreground [&::-webkit-details-marker]:hidden">
              <Menu size={16} />
              <span className="sr-only">Open navigation</span>
            </summary>
            <div className="absolute right-0 mt-2 grid w-64 gap-1 rounded-2xl border border-border/80 bg-background p-2 shadow-[0_24px_80px_-52px_rgba(0,0,0,0.7)]">
              {PRIMARY_NAV.map((item) => {
                const active = isActivePath(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "rounded-xl px-3 py-2 text-sm transition hover:bg-muted/30 hover:text-foreground",
                      active ? "bg-muted/30 text-foreground" : "text-muted-old",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="block font-medium">{item.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-old">{item.summary}</span>
                  </Link>
                );
              })}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
