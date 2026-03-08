"use client";

import { Link } from "next-view-transitions";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export type DocsNavItem = {
  title: string;
  href: string;
};

export type DocsNavSection = {
  title: string;
  items: DocsNavItem[];
};

export function DocsSidebar({ sections }: { sections: DocsNavSection[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex w-full flex-col gap-5">
      {sections.map((section) => (
        <div key={section.title} className="flex flex-col gap-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-old">
            {section.title}
          </div>
          <div className="flex flex-col gap-1 text-sm">
            {section.items.map((item) => {
              const isActive = pathname === item.href || pathname === `${item.href}/`;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "rounded-md border-l-2 border-transparent px-2 py-1 text-[13px] transition",
                    isActive
                      ? "border-foreground/70 bg-muted/30 text-foreground"
                      : "text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                  )}
                >
                  {item.title}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
