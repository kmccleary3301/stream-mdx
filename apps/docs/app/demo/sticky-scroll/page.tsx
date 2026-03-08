import type { Metadata } from "next";

import { StickyScrollDemoClient } from "./sticky-scroll-demo-client";

export const metadata: Metadata = {
  title: "Sticky Scroll Test",
  description: "Bottom-stick scroll area behavior test with detaching and smooth return to bottom.",
};

export default function StickyScrollTestPage() {
  return <StickyScrollDemoClient />;
}

