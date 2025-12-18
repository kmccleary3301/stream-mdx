import type { Metadata } from "next";
import { Inter } from "next/font/google";

import "./globals.css";

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
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
