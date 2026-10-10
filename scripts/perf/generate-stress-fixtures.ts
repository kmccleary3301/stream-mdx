/**
 * Deterministic generator for very long, full-feature streaming stress fixtures.
 *
 * Output is plain CommonMark/GFM + `$`/`$$` math + footnotes + inline/block HTML,
 * i.e. the feature set both StreamMDX and Streamdown render under the parity profile.
 * Re-running with the same seed and size produces byte-identical files.
 *
 *   npx tsx scripts/perf/generate-stress-fixtures.ts
 */
import fs from "node:fs";
import path from "node:path";

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "stream render parser token block inline worker latency throughput buffer cursor delta patch commit frame budget " +
  "schedule queue snapshot replay grammar theme highlight table column row cell header footer anchor reference " +
  "footnote equation matrix vector gradient tensor kernel cache index segment boundary offset window stride batch " +
  "client server request response protocol message channel signal event listener observer reducer selector store " +
  "component element attribute property context provider consumer adapter plugin registry policy contract invariant"
).split(" ");

const NAMES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "theta", "lambda", "sigma", "omega"];

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function words(rng: Rng, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(pick(rng, WORDS));
  return out.join(" ");
}

function sentence(rng: Rng, ctx: Ctx): string {
  const base = words(rng, int(rng, 6, 16));
  const decorate = rng();
  let body = base;
  if (decorate < 0.12) body = `${words(rng, 3)} **${words(rng, 2)}** ${words(rng, 4)}`;
  else if (decorate < 0.22) body = `${words(rng, 4)} *${words(rng, 2)}* and ${words(rng, 3)}`;
  else if (decorate < 0.3) body = `${words(rng, 3)} \`${pick(rng, NAMES)}.${pick(rng, WORDS)}()\` ${words(rng, 4)}`;
  else if (decorate < 0.37) body = `${words(rng, 3)} [${words(rng, 2)}](https://example.com/${pick(rng, WORDS)}/${int(rng, 1, 999)}) ${words(rng, 3)}`;
  else if (decorate < 0.43) body = `${words(rng, 3)} $${pick(rng, ["x_i^2", "\\alpha + \\beta", "\\sum_{k=1}^{n} k", "\\frac{a}{b}", "O(n \\log n)", "e^{i\\pi} + 1 = 0"])}$ ${words(rng, 3)}`;
  else if (decorate < 0.47) body = `${words(rng, 3)} ~~${words(rng, 2)}~~ ${words(rng, 3)}`;
  else if (decorate < 0.5) body = `press <kbd>Ctrl</kbd>+<kbd>${pick(rng, ["C", "V", "K", "P"])}</kbd> to ${words(rng, 4)}`;
  else if (decorate < 0.53) body = `${words(rng, 4)} H<sub>2</sub>O and x<sup>${int(rng, 2, 9)}</sup> ${words(rng, 2)}`;
  else if (decorate < 0.56) body = `${words(rng, 3)} ***${words(rng, 2)}*** ${words(rng, 3)}`;
  else if (decorate < 0.59) body = `${words(rng, 4)} <https://docs.example.org/${pick(rng, WORDS)}> ${words(rng, 2)}`;
  else if (decorate < 0.62 && ctx.withFootnotes) {
    ctx.footnotes += 1;
    body = `${words(rng, 5)}[^n${ctx.footnotes}] ${words(rng, 3)}`;
  }
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}

function paragraph(rng: Rng, ctx: Ctx): string {
  const parts: string[] = [];
  const count = int(rng, 3, 7);
  for (let i = 0; i < count; i += 1) parts.push(sentence(rng, ctx));
  return parts.join(" ");
}

type Ctx = { footnotes: number; section: number; withFootnotes: boolean };

const CODE: Record<string, (rng: Rng, n: number) => string> = {
  ts: (rng, n) => {
    const lines = [`import { ${pick(rng, NAMES)}Store } from "./${pick(rng, WORDS)}";`, "", `export interface ${cap(pick(rng, WORDS))}Options {`];
    for (let i = 0; i < n; i += 1) lines.push(`  ${pick(rng, WORDS)}${i}: ${pick(rng, ["number", "string", "boolean", "readonly string[]", "Map<string, number>"])};`);
    lines.push("}", "", `export async function ${pick(rng, WORDS)}${cap(pick(rng, WORDS))}(input: string, limit = ${int(rng, 8, 512)}): Promise<number> {`);
    lines.push("  let total = 0;", "  for (const [index, char] of [...input].entries()) {", `    if (index > limit) break;`, `    total += char.charCodeAt(0) * ${int(rng, 2, 31)};`, "  }", `  return total % ${int(rng, 97, 9973)};`, "}");
    return lines.join("\n");
  },
  python: (rng, n) => {
    const cls = cap(pick(rng, WORDS));
    const lines = ["from dataclasses import dataclass", "", "@dataclass", `class ${cls}:`];
    for (let i = 0; i < n; i += 1) lines.push(`    ${pick(rng, WORDS)}_${i}: ${pick(rng, ["int", "float", "str", "list[str]"])} = ${pick(rng, ["0", "0.5", '""', "None"])}`);
    lines.push("", `    def ${pick(rng, WORDS)}(self, values: list[float]) -> float:`, "        total = sum(v * v for v in values)", `        return total / max(len(values), ${int(rng, 1, 9)})`);
    return lines.join("\n");
  },
  rust: (rng, n) => {
    const lines = ["#[derive(Debug, Clone)]", `pub struct ${cap(pick(rng, WORDS))} {`];
    for (let i = 0; i < n; i += 1) lines.push(`    pub ${pick(rng, WORDS)}_${i}: ${pick(rng, ["u32", "f64", "String", "Vec<u8>", "Option<usize>"])},`);
    lines.push("}", "", "fn checksum(bytes: &[u8]) -> u64 {", "    bytes.iter().fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(*b as u64))", "}");
    return lines.join("\n");
  },
  go: (rng, n) => {
    const lines = ["package main", "", 'import "fmt"', "", "func main() {", `\titems := make([]int, 0, ${n})`];
    for (let i = 0; i < n; i += 1) lines.push(`\titems = append(items, ${int(rng, 1, 9999)}) // ${pick(rng, WORDS)}`);
    lines.push('\tfmt.Println("count", len(items))', "}");
    return lines.join("\n");
  },
  sql: (rng, n) => {
    const lines = [`SELECT ${pick(rng, WORDS)}_id, COUNT(*) AS total`, `FROM ${pick(rng, WORDS)}s`, "WHERE created_at > NOW() - INTERVAL '7 days'"];
    for (let i = 0; i < n; i += 1) lines.push(`  AND ${pick(rng, WORDS)}_${i} ${pick(rng, ["=", ">", "<", "<>"])} ${int(rng, 0, 500)}`);
    lines.push(`GROUP BY 1`, `ORDER BY total DESC`, `LIMIT ${int(rng, 10, 100)};`);
    return lines.join("\n");
  },
  json: (rng, n) => {
    const lines = ["{", `  "id": "${pick(rng, NAMES)}-${int(rng, 100, 999)}",`, '  "items": ['];
    for (let i = 0; i < n; i += 1) lines.push(`    { "name": "${pick(rng, WORDS)}", "value": ${int(rng, 0, 1000)}, "ok": ${rng() < 0.5} }${i < n - 1 ? "," : ""}`);
    lines.push("  ]", "}");
    return lines.join("\n");
  },
  bash: (rng, n) => {
    const lines = ["#!/usr/bin/env bash", "set -euo pipefail", ""];
    for (let i = 0; i < n; i += 1) lines.push(`${pick(rng, ["echo", "export", "mkdir -p", "npm run"])} ${pick(rng, WORDS)}-${int(rng, 1, 99)} ${rng() < 0.3 ? "| grep -v debug" : ""}`.trimEnd());
    return lines.join("\n");
  },
  yaml: (rng, n) => {
    const lines = [`name: ${pick(rng, WORDS)}-pipeline`, "jobs:"];
    for (let i = 0; i < n; i += 1) lines.push(`  ${pick(rng, WORDS)}-${i}:`, `    runs-on: ubuntu-latest`, `    timeout-minutes: ${int(rng, 5, 60)}`);
    return lines.join("\n");
  },
  css: (rng, n) => {
    const lines: string[] = [];
    for (let i = 0; i < n; i += 1) lines.push(`.${pick(rng, WORDS)}-${i} {`, `  margin: ${int(rng, 0, 32)}px ${int(rng, 0, 32)}px;`, `  color: #${int(rng, 0x100000, 0xffffff).toString(16)};`, "}");
    return lines.join("\n");
  },
  diff: (rng, n) => {
    const lines = [`--- a/src/${pick(rng, WORDS)}.ts`, `+++ b/src/${pick(rng, WORDS)}.ts`, `@@ -1,${n} +1,${n} @@`];
    for (let i = 0; i < n; i += 1) lines.push(`${pick(rng, [" ", "-", "+"])} const ${pick(rng, WORDS)}${i} = ${int(rng, 0, 99)};`);
    return lines.join("\n");
  },
};

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function codeBlock(rng: Rng): string {
  const lang = pick(rng, Object.keys(CODE));
  return `\`\`\`${lang}\n${CODE[lang]!(rng, int(rng, 6, 28))}\n\`\`\``;
}

function list(rng: Rng, ctx: Ctx): string {
  const kind = rng();
  const lines: string[] = [];
  if (kind < 0.4) {
    for (let i = 0; i < int(rng, 3, 7); i += 1) {
      lines.push(`- ${sentence(rng, ctx)}`);
      if (rng() < 0.4) for (let j = 0; j < int(rng, 1, 3); j += 1) {
        lines.push(`  - ${sentence(rng, ctx)}`);
        if (rng() < 0.3) lines.push(`    - ${words(rng, 6)} \`${pick(rng, NAMES)}\``);
      }
    }
  } else if (kind < 0.75) {
    const start = rng() < 0.3 ? int(rng, 2, 9) : 1;
    for (let i = 0; i < int(rng, 3, 8); i += 1) {
      lines.push(`${start + i}. ${sentence(rng, ctx)}`);
      if (rng() < 0.25) lines.push(`   1. ${words(rng, 7)}`, `   2. ${words(rng, 5)}`);
    }
  } else {
    for (let i = 0; i < int(rng, 3, 6); i += 1) lines.push(`- [${rng() < 0.5 ? "x" : " "}] ${words(rng, int(rng, 3, 9))}`);
  }
  return lines.join("\n");
}

function table(rng: Rng): string {
  const cols = int(rng, 3, 6);
  const rows = int(rng, 6, 30);
  const align = Array.from({ length: cols }, () => pick(rng, ["---", ":---", ":---:", "---:"]));
  const header = Array.from({ length: cols }, (_, i) => cap(pick(rng, WORDS)) + (i === 0 ? "" : ` ${i}`));
  const lines = [`| ${header.join(" | ")} |`, `| ${align.join(" | ")} |`];
  for (let r = 0; r < rows; r += 1) {
    const cells = Array.from({ length: cols }, (_, c) => {
      if (c === 0) return `\`${pick(rng, NAMES)}-${r}\``;
      const v = rng();
      if (v < 0.5) return String(int(rng, 0, 99999));
      if (v < 0.7) return `**${pick(rng, WORDS)}**`;
      if (v < 0.8) return `[${pick(rng, WORDS)}](https://example.com/t/${r}/${c})`;
      if (v < 0.88) return `$${int(rng, 1, 9)}^{${int(rng, 2, 5)}}$`;
      return words(rng, 2);
    });
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function displayMath(rng: Rng): string {
  return pick(rng, [
    "$$\n\\mathbf{J}_f = \\begin{bmatrix} \\frac{\\partial f_1}{\\partial x_1} & \\cdots & \\frac{\\partial f_1}{\\partial x_n} \\\\ \\vdots & \\ddots & \\vdots \\\\ \\frac{\\partial f_m}{\\partial x_1} & \\cdots & \\frac{\\partial f_m}{\\partial x_n} \\end{bmatrix}\n$$",
    "$$\n\\begin{aligned} \\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0} \\\\ \\nabla \\times \\mathbf{B} &= \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t} \\end{aligned}\n$$",
    `$$\nP(y \\mid x_1, \\ldots, x_n) = \\frac{P(y) \\prod_{i=1}^{${int(rng, 2, 9)}} P(x_i \\mid y)}{P(x_1, \\ldots, x_n)}\n$$`,
    `$$\n\\int_0^{${int(rng, 1, 9)}} e^{-x^2} \\, dx \\approx \\sum_{k=0}^{\\infty} \\frac{(-1)^k}{k! (2k+1)}\n$$`,
  ]);
}

function blockquote(rng: Rng, ctx: Ctx): string {
  const lines = [`> **${cap(pick(rng, WORDS))}:** ${paragraph(rng, ctx)}`, ">"];
  if (rng() < 0.5) lines.push(`> - ${words(rng, 6)}`, `> - ${words(rng, 5)} \`${pick(rng, NAMES)}\``, ">");
  lines.push(`> ${sentence(rng, ctx)}`);
  if (rng() < 0.3) lines.push(">", `> > ${sentence(rng, ctx)}`);
  return lines.join("\n");
}

function htmlBlock(rng: Rng): string {
  return `<details>\n<summary>${cap(words(rng, 3))}</summary>\n\n${cap(words(rng, 14))}.\n\n</details>`;
}

function section(rng: Rng, ctx: Ctx): string {
  ctx.section += 1;
  const blocks: string[] = [`## ${ctx.section}. ${cap(words(rng, int(rng, 2, 5)))}`, paragraph(rng, ctx)];
  const plan = int(rng, 4, 8);
  for (let i = 0; i < plan; i += 1) {
    const v = rng();
    if (v < 0.22) blocks.push(codeBlock(rng));
    else if (v < 0.38) blocks.push(list(rng, ctx));
    else if (v < 0.48) blocks.push(table(rng));
    else if (v < 0.56) blocks.push(displayMath(rng));
    else if (v < 0.64) blocks.push(blockquote(rng, ctx));
    else if (v < 0.68) blocks.push(htmlBlock(rng));
    else if (v < 0.76) blocks.push(`### ${cap(words(rng, int(rng, 2, 4)))}`, paragraph(rng, ctx));
    else if (v < 0.79) blocks.push(`#### ${cap(words(rng, 3))}`, paragraph(rng, ctx));
    else if (v < 0.81) blocks.push("---");
    else blocks.push(paragraph(rng, ctx));
  }
  return blocks.join("\n\n");
}

function generate(seed: number, targetChars: number, title: string, withFootnotes: boolean): string {
  const rng = mulberry32(seed);
  const ctx: Ctx = { footnotes: 0, section: 0, withFootnotes };
  const parts = [`# ${title}`, paragraph(rng, ctx)];
  let length = parts.join("\n\n").length;
  while (length < targetChars) {
    const next = section(rng, ctx);
    parts.push(next);
    length += next.length + 2;
  }
  const notes: string[] = [];
  for (let i = 1; i <= ctx.footnotes; i += 1) notes.push(`[^n${i}]: ${cap(words(rng, int(rng, 5, 12)))}.`);
  if (notes.length > 0) parts.push(notes.join("\n"));
  return `${parts.join("\n\n")}\n`;
}

const FIXTURES = [
  // Strict-parity fixtures: StreamMDX intentionally separates its footnotes section with `<hr>`,
  // so footnote-bearing documents are never canonically identical to Streamdown output.
  { id: "stress-mega", seed: 7, chars: 250_000, footnotes: false, title: "Streaming Stress: Full Feature Mega Document" },
  { id: "stress-xl", seed: 11, chars: 1_000_000, footnotes: false, title: "Streaming Stress: One Megabyte Firehose" },
  { id: "stress-mega-footnotes", seed: 7, chars: 250_000, footnotes: true, title: "Streaming Stress: Mega Document With Footnotes" },
];

const OUT = path.resolve(process.cwd(), "tests/regression/fixtures");
for (const fixture of FIXTURES) {
  const text = generate(fixture.seed, fixture.chars, fixture.title, fixture.footnotes);
  fs.writeFileSync(path.join(OUT, `${fixture.id}.md`), text);
  console.log(`${fixture.id}.md ${text.length} chars`);
}
