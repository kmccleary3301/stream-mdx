import type { Metadata } from "next";
import { TableVirtualizationClient } from "@/components/screens/showcase/table-virtualization-client";

export const metadata: Metadata = {
  title: "Table Row Virtualization Showcase",
  description:
    "A large table with measured multiline rows, sticky headers, configurable overscan, and controls to reach the last row.",
};

export default function TableVirtualizationPage() {
  return <TableVirtualizationClient />;
}
