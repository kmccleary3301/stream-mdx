import type { ReactNode } from "react";

import { TableOfContents } from "@/components/on-this-page";
import { TocProvider } from "@/components/on-this-page/toc-context";
import { DocsSidebar, type DocsNavSection } from "@/components/docs/docs-sidebar";
import type { TocHeading } from "@/lib/toc";
import { cn } from "@/lib/utils";

export function DocsShell({
  children,
  sections,
  showToc = true,
  showMobileNav = true,
  panelClassName,
  navClassName,
  tocClassName,
  navPanelClassName,
  tocPanelClassName,
  initialTocHeadings,
}: {
  children: ReactNode;
  sections: DocsNavSection[];
  showToc?: boolean;
  showMobileNav?: boolean;
  panelClassName?: string;
  navClassName?: string;
  tocClassName?: string;
  navPanelClassName?: string;
  tocPanelClassName?: string;
  initialTocHeadings?: TocHeading[];
}) {
  return (
    <TocProvider initialHeadings={initialTocHeadings}>
      <div
        className={cn(
          "grid gap-6 lg:items-start",
          showToc ? "lg:grid-cols-[236px_minmax(0,1fr)_220px]" : "lg:grid-cols-[236px_minmax(0,1fr)]",
        )}
      >
        <aside
          className={cn(
            "hidden lg:block lg:sticky lg:top-24 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto lg:pr-2 lg:no-scrollbar",
            navClassName,
          )}
        >
          <div
            className={cn(
              "rounded-xl border border-border/60 bg-muted/20 p-4",
              panelClassName,
              navPanelClassName,
            )}
          >
            <DocsSidebar sections={sections} />
          </div>
        </aside>
        <div className="min-w-0">
          {showMobileNav ? (
            <details className="mb-6 rounded-xl border border-border/60 bg-muted/20 p-4 lg:hidden">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.2em] text-muted-old">
                Browse docs
              </summary>
              <div className="mt-4 border-t border-border/60 pt-4">
                <DocsSidebar sections={sections} />
              </div>
            </details>
          ) : null}
          {children}
        </div>
        {showToc ? (
          <aside
            className={cn(
              "hidden lg:block lg:sticky lg:top-24 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto lg:pl-2 lg:no-scrollbar",
              tocClassName,
            )}
          >
            <div
              className={cn(
                "rounded-xl border border-border/60 bg-muted/20 p-4",
                panelClassName,
                tocPanelClassName,
              )}
            >
              <TableOfContents title="On this page" />
            </div>
          </aside>
        ) : null}
      </div>
    </TocProvider>
  );
}
