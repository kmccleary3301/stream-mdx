import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "StreamMDX Docs",
  description: "Documentation and demo for StreamMDX.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

