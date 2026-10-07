import type { Metadata } from "next";

import { StudioPageClient } from "@/components/chrome/studio-page-client";
import { getStudioSamples } from "@/lib/studio-samples";

export const metadata: Metadata = {
  title: "Streaming Markdown Demo",
  description: "Legacy demo route preserved as a compatibility entry for the StreamMDX Studio control surface.",
};

export default function DemoPage() {
  return <StudioPageClient samples={getStudioSamples()} />;
}
