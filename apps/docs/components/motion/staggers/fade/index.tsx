"use client";

import type React from "react";

import { motion, type Variants, useReducedMotion } from "framer-motion";

const DISABLE_ANIMATIONS = process.env.NEXT_PUBLIC_DISABLE_ANIMATIONS === "true";

const container: Variants = {
  hidden: {},
  show: {
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.2,
    },
  },
};

const item: Variants = {
  hidden: {
    opacity: 0,
    y: 16,
  },
  show: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.28,
      ease: [0.22, 1, 0.36, 1],
    },
  },
};

export function Container({ children, className }: React.HTMLProps<HTMLDivElement>) {
  const reducedMotion = useReducedMotion();
  if (DISABLE_ANIMATIONS || reducedMotion) {
    return <div className={className}>{children}</div>;
  }
  return (
    <motion.div
      variants={container}
      initial={false}
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function Item({ children }: { children: React.ReactNode }) {
  const reducedMotion = useReducedMotion();
  if (DISABLE_ANIMATIONS || reducedMotion) {
    return <div>{children}</div>;
  }
  return (
    <motion.div
      variants={item}
      initial={false}
      animate="show"
    >
      {children}
    </motion.div>
  );
}
