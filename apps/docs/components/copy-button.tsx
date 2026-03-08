"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

import { Check, Copy } from "lucide-react";

type CopyButtonProps = {
  text: string;
  label?: string;
  iconOnly?: boolean;
  className?: string;
};

export function CopyButton({ text, label = "Copy", iconOnly = false, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        const node = document.createTextNode(text);
        document.body.appendChild(node);
        range.selectNodeContents(node);
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.execCommand("copy");
        selection?.removeAllRanges();
        document.body.removeChild(node);
      }
      setCopied(true);
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button
      size={iconOnly ? "icon" : "sm"}
      variant="ghost"
      onClick={handleCopy}
      aria-label={`Copy ${text}`}
      className={cn(iconOnly ? "h-8 w-8" : "", className)}
    >
      {iconOnly ? (copied ? <Check size={14} /> : <Copy size={14} />) : copied ? "Copied" : label}
      {iconOnly ? <span className="sr-only">{copied ? "Copied" : label}</span> : null}
    </Button>
  );
}
