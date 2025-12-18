"use client";

import { Link } from "next-view-transitions";
import { usePathname } from "next/navigation";

export type NavItem = {
  slug: string;
  title: string;
};

function joinPath(basePath: string, slug: string) {
  const normalizedBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (!slug) return normalizedBase || "/";
  return `${normalizedBase}/${slug}`;
}

export function CollectionNavigation({ items, basePath }: { items: NavItem[]; basePath: string }) {
  const pathname = usePathname();
  const currentSlug = pathname.split("/").filter(Boolean).pop() ?? "";
  const currentIndex = items.findIndex((item) => item.slug === currentSlug);

  if (currentIndex < 0) return null;

  const previous = currentIndex > 0 ? items[currentIndex - 1] : null;
  const next = currentIndex < items.length - 1 ? items[currentIndex + 1] : null;

  if (!previous && !next) return null;

  return (
    <div className="mt-16 flex w-full justify-between border-border border-t pt-8">
      {previous && (
        <Link href={joinPath(basePath, previous.slug)} className="flex w-full flex-col gap-1 text-left">
          <span className="text-muted-old">Previous</span>
          <span>{previous.title}</span>
        </Link>
      )}
      {next && (
        <Link href={joinPath(basePath, next.slug)} className="flex w-full flex-col gap-1 text-right">
          <span className="text-muted-old">Next</span>
          <span>{next.title}</span>
        </Link>
      )}
    </div>
  );
}

