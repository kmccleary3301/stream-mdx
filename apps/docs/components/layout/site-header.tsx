import { AppThemeSwitcher } from "@/components/theme";

import { Link } from "next-view-transitions";

export function SiteHeader() {
  return (
    <div className="fixed top-0 z-50 w-full border-border border-b bg-background/70 backdrop-blur">
      <div className="mx-auto flex max-w-screen-sm items-center justify-between px-6 py-3">
        <Link href="/" className="font-medium tracking-tight">
          StreamMDX
        </Link>
        <nav className="flex items-center gap-4 text-small text-muted-old">
          <Link className="hover:opacity-50 transition" href="/demo">
            Demo
          </Link>
          <Link className="hover:opacity-50 transition" href="/docs">
            Docs
          </Link>
          <Link className="hover:opacity-50 transition" href="/showcase">
            Showcase
          </Link>
        </nav>
        <AppThemeSwitcher />
      </div>
    </div>
  );
}
