"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BottomStickScrollArea as StreamMdxBottomStickScrollArea,
  type BottomStickDebugState,
  type BottomStickMode,
} from "@stream-mdx/react";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

type BottomStickScrollAreaProps = {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  showScrollBar?: boolean;
  showJumpToBottom?: boolean;
  onDebugStateChange?: (state: BottomStickDebugState) => void;
  debugDomAttributes?: boolean;
};

export function BottomStickScrollArea({
  children,
  className,
  contentClassName,
  showScrollBar = true,
  showJumpToBottom = true,
  onDebugStateChange,
  debugDomAttributes = false,
}: BottomStickScrollAreaProps) {
  return (
    <StreamMdxBottomStickScrollArea
      className={cn("h-full w-full", className)}
      viewportClassName={cn(
        "h-full w-full rounded-[inherit] overflow-auto",
        !showScrollBar && "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
      contentClassName={cn("flex min-h-full w-full flex-col", contentClassName)}
      showJumpToBottom={showJumpToBottom}
      onDebugStateChange={onDebugStateChange}
      debugDomAttributes={debugDomAttributes}
      renderJumpToBottom={({ mode, canJump, jumpToBottom }) => (
        <JumpToBottomButton mode={mode} canJump={canJump} jumpToBottom={jumpToBottom} />
      )}
    >
      {children}
    </StreamMdxBottomStickScrollArea>
  );
}

function JumpToBottomButton({
  mode,
  canJump,
  jumpToBottom,
}: {
  mode: BottomStickMode;
  canJump: boolean;
  jumpToBottom: () => void;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={jumpToBottom}
      data-testid="sticky-scroll-jump"
      className={cn(
        "z-10 h-10 w-10 rounded-full p-0 shadow-base shadow-secondary transition-all duration-150",
        canJump ? "translate-y-0 opacity-100 pointer-events-auto" : "translate-y-1 opacity-0 pointer-events-none",
        mode === "RETURNING_SMOOTH" ? "ring-1 ring-border/60" : "",
      )}
      aria-label="Scroll to bottom"
    >
      <ChevronDown className="h-4 w-4 text-primary" />
    </Button>
  );
}
