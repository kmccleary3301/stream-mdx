"use client";

import * as React from "react";

import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CopyButtonProps = {
  text: string;
  className?: string;
  iconOnly?: boolean;
};

export function CopyButton({ text, className, iconOnly = false }: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);

  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      return;
    } catch {
      // Fall through to the legacy execCommand path.
    }

    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
    } catch {
      // Swallow copy failures; caller UX can still select manually.
    }
  }, [text]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onCopy}
      className={cn("h-8 w-8 rounded-md", className)}
      aria-label={copied ? "Copied" : "Copy"}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {iconOnly ? null : <span className="sr-only">Copy</span>}
    </Button>
  );
}

