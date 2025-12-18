import type React from "react";

import { cn } from "@/lib/utils";

import styles from "./styles.module.css";

const Preview = ({ children, codeblock }: React.HTMLAttributes<HTMLDivElement> & { codeblock?: string }) => (
  <figure data-with-codeblock={codeblock} className={cn(styles.preview, "not-prose")}>
    {children}
  </figure>
);

export default Preview;

