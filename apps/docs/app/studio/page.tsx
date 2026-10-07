import type { Metadata } from "next";

import { StudioPageClient } from "@/components/chrome/studio-page-client";
import { getStudioSamples } from "@/lib/studio-samples";

export const metadata: Metadata = {
  title: "StreamMDX Studio",
  description: "Canonical StreamMDX control surface for streaming, scheduling, metrics, and renderer behavior.",
};

export default function StudioPage() {
  return <StudioPageClient samples={getStudioSamples()} />;
}
