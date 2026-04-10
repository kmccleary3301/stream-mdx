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
      <body className="min-h-screen">
        <Providers>
          <SiteHeader />
          <main className="mx-auto w-full max-w-screen-xl overflow-x-hidden px-5 pb-24 pt-20 md:px-6 md:overflow-x-visible md:pt-24">
            <article className="article relative w-full">{children}</article>
          </main>
        </Providers>
      </body>
    </html>
  );
}
