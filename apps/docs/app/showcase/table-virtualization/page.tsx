import type { Metadata } from "next";
import { TableVirtualizationClient } from "@/components/screens/showcase/table-virtualization-client";

export const metadata: Metadata = {
  title: "Table Row Virtualization Showcase",
  description:
    "Executable showcase demonstrating high-performance table row virtualization, sticky headers, variable height row measurement, multiline cells, and last-row reachability.",
};

export default function TableVirtualizationPage() {
  return <TableVirtualizationClient />;
}
