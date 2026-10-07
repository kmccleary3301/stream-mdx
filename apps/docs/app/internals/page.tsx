import type { Metadata } from "next";

import GuidePage from "../docs/guides/[slug]/page";

export const metadata: Metadata = {
  title: "StreamMDX Internals",
  description: "First-class StreamMDX internals surface backed by the architecture and internals guide source of truth.",
};

export default function InternalsPage() {
  return GuidePage({ params: Promise.resolve({ slug: "architecture-and-internals" }) });
}
