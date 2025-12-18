import type { ReactNode } from "react";

import { Breadcrumb } from "@/components/layout/breadcrumb";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <Breadcrumb />
      {children}
    </>
  );
}
