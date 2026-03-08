#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

type PageEntry = {
  route: string;
  filePath: string;
  dom: JSDOM;
};

type LinkIssue = {
  sourceRoute: string;
  href: string;
  reason: string;
  resolvedPath?: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "apps", "docs", "out");
const ORIGIN = "https://streammdx.local";
const CHECK_ANCHORS = process.env.DOCS_CHECK_ANCHORS === "1";

function normalizeRoute(input: string): string {
  if (!input) return "/";
  let route = input;
  if (!route.startsWith("/")) route = `/${route}`;
  route = route.replace(/\/+/g, "/");
  if (route.length > 1 && route.endsWith("/")) route = route.slice(0, -1);
  return route;
}

function routeFromHtmlRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === "index.html") return "/";
  if (normalized.endsWith("/index.html")) {
    return normalizeRoute(normalized.slice(0, -"/index.html".length));
  }
  if (normalized.endsWith(".html")) {
    return normalizeRoute(normalized.slice(0, -".html".length));
  }
  return normalizeRoute(normalized);
}

async function collectHtmlFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectHtmlFiles(absolute)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(absolute);
    }
  }
  return files;
}

function isSkippableHref(href: string): boolean {
  if (!href) return true;
  const lower = href.toLowerCase();
  return (
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("//")
  );
}

function resolveInternalHref(sourceRoute: string, href: string): { pathname: string; hash: string } | null {
  if (isSkippableHref(href)) return null;

  const sourceWithSlash = sourceRoute === "/" ? "/" : `${sourceRoute}/`;
  const baseUrl = new URL(sourceWithSlash, ORIGIN);
  const resolved = new URL(href, baseUrl);

  if (resolved.origin !== ORIGIN) return null;
  return {
    pathname: normalizeRoute(resolved.pathname),
    hash: resolved.hash,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function targetExistsInOut(pathname: string): Promise<boolean> {
  const relative = pathname === "/" ? "" : pathname.slice(1);
  const decodedRelative = relative
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");

  const candidates = [
    path.join(OUT_DIR, decodedRelative),
    path.join(OUT_DIR, `${decodedRelative}.html`),
    path.join(OUT_DIR, decodedRelative, "index.html"),
    path.join(OUT_DIR, "index.html"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const outExists = await fileExists(OUT_DIR);
  if (!outExists) {
    throw new Error(`apps/docs/out not found. Run npm run docs:build first. (${OUT_DIR})`);
  }

  const htmlFiles = await collectHtmlFiles(OUT_DIR);
  const pagesByRoute = new Map<string, PageEntry>();

  for (const filePath of htmlFiles) {
    const relative = path.relative(OUT_DIR, filePath);
    const route = routeFromHtmlRelativePath(relative);
    const html = await fs.readFile(filePath, "utf8");
    const dom = new JSDOM(html);
    pagesByRoute.set(route, { route, filePath, dom });
  }

  const issues: LinkIssue[] = [];
  const anchorWarnings: LinkIssue[] = [];
  let checkedInternalLinks = 0;
  let checkedAnchors = 0;

  for (const page of pagesByRoute.values()) {
    const anchors = Array.from(page.dom.window.document.querySelectorAll<HTMLAnchorElement>("a[href]"));
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href")?.trim() ?? "";
      const resolved = resolveInternalHref(page.route, href);
      if (!resolved) continue;

      checkedInternalLinks += 1;
      const targetPage = pagesByRoute.get(resolved.pathname);
      const targetExists = targetPage ? true : await targetExistsInOut(resolved.pathname);
      if (!targetExists) {
        issues.push({
          sourceRoute: page.route,
          href,
          reason: "target route/file missing",
          resolvedPath: resolved.pathname,
        });
        continue;
      }

      if (CHECK_ANCHORS && resolved.hash.length > 1 && targetPage) {
        checkedAnchors += 1;
        const rawId = resolved.hash.slice(1);
        const decodedId = (() => {
          try {
            return decodeURIComponent(rawId);
          } catch {
            return rawId;
          }
        })();

        const hasAnchor = Boolean(targetPage.dom.window.document.getElementById(decodedId));
        if (!hasAnchor) {
          anchorWarnings.push({
            sourceRoute: page.route,
            href,
            reason: "anchor id missing in target page",
            resolvedPath: `${resolved.pathname}#${decodedId}`,
          });
        }
      }
    }
  }

  if (issues.length > 0) {
    console.error(`[docs:check-links] FAILED routeIssues=${issues.length}`);
    for (const issue of issues.slice(0, 100)) {
      console.error(`- source=${issue.sourceRoute} href=${issue.href} reason=${issue.reason}${issue.resolvedPath ? ` resolved=${issue.resolvedPath}` : ""}`);
    }
    if (issues.length > 100) {
      console.error(`... ${issues.length - 100} more issue(s)`);
    }
    process.exitCode = 1;
    return;
  }

  if (anchorWarnings.length > 0) {
    const log = CHECK_ANCHORS ? console.error : console.warn;
    const status = CHECK_ANCHORS ? "FAILED" : "WARN";
    const suffix = CHECK_ANCHORS ? "" : " (set DOCS_CHECK_ANCHORS=1 to fail on these)";

    log(`[docs:check-links] ${status} anchorIssues=${anchorWarnings.length}${suffix}`);
    for (const issue of anchorWarnings.slice(0, 40)) {
      log(`- source=${issue.sourceRoute} href=${issue.href} reason=${issue.reason}${issue.resolvedPath ? ` resolved=${issue.resolvedPath}` : ""}`);
    }
    if (anchorWarnings.length > 40) {
      log(`... ${anchorWarnings.length - 40} more anchor issue(s)`);
    }

    if (CHECK_ANCHORS) {
      process.exitCode = 1;
      return;
    }
  }

  console.log(
    [
      "[docs:check-links] OK",
      `pages=${pagesByRoute.size}`,
      `internalLinks=${checkedInternalLinks}`,
      `anchorsChecked=${checkedAnchors}`,
    ].join(" "),
  );
}

main().catch((error) => {
  console.error("[docs:check-links] failed", error);
  process.exit(1);
});
