import type { ReactNode } from "react";

export const metadata = {
  title: "Streaming Markdown Starter",
  description: "Minimal integration for the Streaming Markdown V2 renderer",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
