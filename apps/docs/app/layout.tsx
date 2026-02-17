import type { Metadata } from "next";
import { Inter } from "next/font/google";

import "./globals.css";

import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/layout/site-header";

import clsx from "clsx";

export const metadata: Metadata = {
  title: "StreamMDX Docs",
  description: "Documentation and demo for StreamMDX.",
};

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={clsx(inter.className)} suppressHydrationWarning>
      <body>
        <Providers>
          <SiteHeader />
          <main className="mx-auto w-full max-w-screen-xl overflow-x-hidden px-6 py-24 md:overflow-x-visible">
            <article className="article w-full">{children}</article>
          </main>
        </Providers>
      </body>
    </html>
  );
}
