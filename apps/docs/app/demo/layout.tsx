import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-screen-sm overflow-x-hidden px-6 py-24 md:overflow-x-visible">
      {children}
    </main>
  );
}
