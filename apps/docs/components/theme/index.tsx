"use client";

import type React from "react";

import { cn } from "@/lib/utils";

import { Monitor, Moon, Sun } from "lucide-react";
import { ThemeProvider, useTheme } from "next-themes";
import { useEffect, useState } from "react";

const THEME_OPTIONS = [
  { value: "system", label: "System theme", Icon: Monitor },
  { value: "dark", label: "Dark theme", Icon: Moon },
  { value: "light", label: "Light theme", Icon: Sun },
] as const;

export function AppThemeSwitcher() {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  // The stored theme is unknown until mount; render the same-size control without an active state so the header never shifts.
  const activeTheme = mounted ? theme : undefined;

  return (
    <div
      role="group"
      aria-label="Color theme"
      className="flex w-fit items-center gap-0.5 rounded-full border border-border/70 bg-background/80 p-[3px]"
    >
      {THEME_OPTIONS.map(({ value, label, Icon }) => {
        const active = activeTheme === value;
        return (
          <button
            type="button"
            key={value}
            aria-label={label}
            aria-pressed={active}
            onClick={() => setTheme(value)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full transition-[color,background-color] duration-150",
              active ? "bg-gray-4 text-foreground" : "text-muted-old hover:text-foreground",
            )}
          >
            <Icon size={14} strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider enableSystem disableTransitionOnChange attribute="class" storageKey="theme" defaultTheme="system">
      {children}
    </ThemeProvider>
  );
}

