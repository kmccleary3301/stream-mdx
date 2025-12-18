"use client";

import { cn } from "@/lib/utils";

import { ChevronRightIcon } from "@radix-ui/react-icons";
import { Link } from "next-view-transitions";
import { usePathname } from "next/navigation";
import React from "react";

export function Breadcrumb() {
  const pathname = usePathname();

  const paths = pathname
    .split("/")
    .filter((path) => path !== "")
    .map((path) => path.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()));

  if (paths.length === 0) return null;

  return (
    <div className={cn("mt-0 mb-4 flex w-full items-center gap-1 align-middle font-normal text-small")}>
      <Link className="text-muted-old" href="/">
        Home
      </Link>
      <ChevronRightIcon className="text-muted-old" />
      {paths.map((path, index) => {
        const href = `/${paths
          .slice(0, index + 1)
          .join("/")
          .toLowerCase()}`;

        const isLast = index === paths.length - 1;

        return (
          <React.Fragment key={`${path}-${index}`}>
            {isLast ? (
              <span className="text-muted-old">{path}</span>
            ) : (
              <Link className="text-muted-old" href={href}>
                {path}
              </Link>
            )}
            {index < paths.length - 1 && <ChevronRightIcon className="text-muted-old" />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

