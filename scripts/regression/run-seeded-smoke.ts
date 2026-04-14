import { spawn } from "node:child_process";

type SeededCase = {
  fixture: string;
  scenario: string;
  seedCount: number;
};

const CASES: SeededCase[] = [
  { fixture: "code-huge", scenario: "S1_slow_small", seedCount: 2 },
  { fixture: "code-highlight-incremental", scenario: "S2_typical", seedCount: 2 },
  { fixture: "mdx-transitions", scenario: "S2_typical", seedCount: 2 },
  { fixture: "edge-regressions", scenario: "S2_typical", seedCount: 2 },
  { fixture: "imaginary-empty-list", scenario: "S2_typical", seedCount: 2 },
  { fixture: "lists-nested", scenario: "S2_typical", seedCount: 2 },
  { fixture: "nested-formatting-ancestors", scenario: "S2_typical", seedCount: 2 },
  { fixture: "inline-html-allowlist", scenario: "S2_typical", seedCount: 2 },
  { fixture: "block-html-no-swallow", scenario: "S2_typical", seedCount: 2 },
  { fixture: "math-inline-supported", scenario: "S2_typical", seedCount: 2 },
  { fixture: "math-display-supported", scenario: "S2_typical", seedCount: 2 },
  { fixture: "math-left-right-null-right-supported", scenario: "S2_typical", seedCount: 2 },
  { fixture: "math-display-checkpoint-supported", scenario: "S2_typical", seedCount: 2 },
  { fixture: "mdx-tag-allowlist-inline", scenario: "S2_typical", seedCount: 2 },
  { fixture: "table-boundary", scenario: "S2_typical", seedCount: 2 },
  { fixture: "mdx-math-code-mixed", scenario: "S2_typical", seedCount: 3 },
  { fixture: "mdx-multi-status", scenario: "S2_typical", seedCount: 3 },
];

async function runCase(testCase: SeededCase): Promise<void> {
  const args = [
    "scripts/regression/run-html-snapshots.ts",
    "--filter",
    testCase.fixture,
    "--scenario",
    testCase.scenario,
    "--seed-count",
    String(testCase.seedCount),
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("tsx", args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`seeded smoke interrupted for ${testCase.fixture}/${testCase.scenario} by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`seeded smoke failed for ${testCase.fixture}/${testCase.scenario} with exit code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  for (const testCase of CASES) {
    console.log(`\n[seeded-smoke] ${testCase.fixture}/${testCase.scenario} seeds=${testCase.seedCount}`);
    await runCase(testCase);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
