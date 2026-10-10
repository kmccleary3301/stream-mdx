#!/usr/bin/env tsx

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(ROOT, "apps", "docs");

const forbiddenClassNames = ["proof-card", "editorial-card", "surface-frame"];
const observedTokens = ["route-panel", "route-grid-card", "rounded-2xl", "rounded-xl", "shadow-sm", "shadow-["];
const extensions = new Set([".css", ".tsx"]);

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if ([".next", "node_modules", "out"].includes(entry.name)) return [];
      return walk(filePath);
    }
    return extensions.has(path.extname(entry.name)) ? [filePath] : [];
  });
}

function relative(filePath: string): string {
  return path.relative(ROOT, filePath);
}

function countOccurrences(source: string, token: string): number {
  return source.split(token).length - 1;
}

function fail(message: string): never {
  console.error(`[style-audit] ${message}`);
  process.exit(1);
}

const globalsPath = path.join(DOCS_DIR, "app", "globals.css");
const markdownPath = path.join(DOCS_DIR, "app", "markdown.css");
const prosePath = path.join(DOCS_DIR, "app", "prose.css");

for (const requiredPath of [globalsPath, markdownPath, prosePath]) {
  if (!existsSync(requiredPath)) fail(`missing required CSS file: ${relative(requiredPath)}`);
}

const globals = readFileSync(globalsPath, "utf8");
const markdown = readFileSync(markdownPath, "utf8");
const prose = readFileSync(prosePath, "utf8");
const outputRulePattern = /^[ \t]*(?!\/\*|\*|\/\/)[^{\n]*\.markdown-v2-output[^\n{]*\{/m;

function markdownVisualRuleFailures(source: string, filePath: string): string[] {
  const markdownClassPattern = /(^|[^A-Za-z0-9_-])\.markdown(?![A-Za-z0-9_-])/;
  return source
    .split("\n")
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => markdownClassPattern.test(line) && line.includes("{"))
    .filter(({ line }) => !line.startsWith("/*") && !line.startsWith("*") && !line.startsWith("//"))
    .filter(({ line }) => line !== ".markdown {")
    .map(({ lineNumber, line }) => `${relative(filePath)}:${lineNumber} contains legacy .markdown visual selector '${line}'`);
}

if (globals.includes('@import url("./markdown.css");')) {
  fail("globals.css imports markdown.css; docs-app rendered markdown styling must be owned by prose.css");
}

if (outputRulePattern.test(globals)) {
  fail("globals.css contains .markdown-v2-output rules; rendered output belongs in prose.css");
}

if (outputRulePattern.test(markdown)) {
  fail("markdown.css contains .markdown-v2-output rules; markdown.css is legacy .markdown compatibility only");
}

if (!outputRulePattern.test(prose)) {
  fail("prose.css does not contain .markdown-v2-output rules");
}

const files = walk(DOCS_DIR);
const failures: string[] = [];
const counts = new Map<string, number>(observedTokens.map((token) => [token, 0]));

failures.push(...markdownVisualRuleFailures(markdown, markdownPath));
failures.push(...markdownVisualRuleFailures(prose, prosePath));

for (const filePath of files) {
  const source = readFileSync(filePath, "utf8");
  if (source.includes("prose markdown")) {
    failures.push(`${relative(filePath)} uses stacked 'prose markdown' classes; docs-app markdown output should use prose/prose-stream only`);
  }
  for (const className of forbiddenClassNames) {
    if (source.includes(className)) failures.push(`${relative(filePath)} contains forbidden planner class '${className}'`);
  }
  for (const token of observedTokens) {
    counts.set(token, (counts.get(token) ?? 0) + countOccurrences(source, token));
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[style-audit] ${failure}`);
  process.exit(1);
}

console.log("[style-audit] CSS ownership checks passed");
console.log("[style-audit] observed route/control tokens:");
for (const [token, count] of counts) console.log(`  ${token}: ${count}`);
