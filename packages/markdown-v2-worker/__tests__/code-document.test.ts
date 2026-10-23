import assert from "node:assert";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type { CodeTokenLine } from "@stream-mdx/core";
import { createCodeDocument } from "@stream-mdx/worker/engine";
import { createHighlighter, type ThemedTokenWithVariants } from "shiki";
import fc from "fast-check";

type NormalizedStyle = { fg?: string; bg?: string; fs?: number };
type NormalizedSpan = {
  text: string;
  dark?: NormalizedStyle;
  light?: NormalizedStyle;
};

function normalizePublicStyle(style: { fg?: string; bg?: string; fs?: number } | undefined): NormalizedStyle | undefined {
  if (!style) return undefined;
  const normalized: NormalizedStyle = {};
  if (typeof style.fg === "string") normalized.fg = style.fg;
  if (typeof style.bg === "string") normalized.bg = style.bg;
  if (typeof style.fs === "number" && style.fs > 0) normalized.fs = style.fs;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeShikiStyle(style: { color?: string; bgColor?: string; fontStyle?: number } | undefined): NormalizedStyle | undefined {
  if (!style) return undefined;
  const normalized: NormalizedStyle = {};
  if (typeof style.color === "string") normalized.fg = style.color;
  if (typeof style.bgColor === "string") normalized.bg = style.bgColor;
  if (typeof style.fontStyle === "number" && style.fontStyle > 0) normalized.fs = style.fontStyle;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}


function mergeAdjacentSpans(spans: NormalizedSpan[]): NormalizedSpan[] {
  const merged: NormalizedSpan[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    const sameDark = previous?.dark?.fg === span.dark?.fg
      && previous?.dark?.bg === span.dark?.bg
      && previous?.dark?.fs === span.dark?.fs;
    const sameLight = previous?.light?.fg === span.light?.fg
      && previous?.light?.bg === span.light?.bg
      && previous?.light?.fs === span.light?.fs;
    if (previous && sameDark && sameLight) {
      previous.text += span.text;
    } else {
      merged.push(span);
    }
  }
  return merged;
}

function normalizePublicLine(line: CodeTokenLine): NormalizedSpan[] {
  return mergeAdjacentSpans(line.spans.map((span) => {
    const normalized: NormalizedSpan = { text: span.t };
    const dark = normalizePublicStyle(span.v?.dark ?? span.s);
    const light = normalizePublicStyle(span.v?.light ?? span.s);
    if (dark) normalized.dark = dark;
    if (light) normalized.light = light;
    return normalized;
  }));
}

function normalizeShikiLine(line: readonly ThemedTokenWithVariants[]): NormalizedSpan[] {
  return mergeAdjacentSpans(line.map((token) => {
    const normalized: NormalizedSpan = { text: token.content };
    const dark = normalizeShikiStyle(token.variants.dark);
    const light = normalizeShikiStyle(token.variants.light);
    if (dark) normalized.dark = dark;
    if (light) normalized.light = light;
    return normalized;
  }));
}


async function runStandaloneCodeDocumentTest(): Promise<void> {
  const source = "/* 🚀 start\r\nstill comment */ const answer = \"x\";";
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", initialContent: source, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();

    const readSource = document.handle.readSource();
    assert.strictEqual(readSource, source, "cold code handles must preserve authored source and CRLF exactly");

    const result = await document.highlight({ mode: "isolated", range: { from: 0, to: 2 } });
    assert.strictEqual(result.exactness, "isolated", "standalone source must declare its isolated grammar context");
    assert.ok(result.tokens, "available isolated highlighting must include public token lines");

    const oracleTokens = oracle.codeToTokensWithThemes(source, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    const normalizedTokens = result.tokens.map(normalizePublicLine);
    assert.deepStrictEqual(
      normalizedTokens,
      oracleTokens.map(normalizeShikiLine),
      "isolated dual-theme token text and semantic styles must match cold Shiki over the complete raw source",
    );


    const keyword = normalizedTokens[1]?.find((span) => span.text.includes("const"));
    assert.ok(keyword?.dark?.fg, "the TypeScript keyword must retain its dark-theme foreground from Shiki");
    assert.ok(keyword?.light?.fg, "the TypeScript keyword must retain its light-theme foreground from Shiki");
    assert.notStrictEqual(keyword.dark.fg, keyword.light.fg, "the two independent theme variants must remain distinguishable");

  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}

async function runFinalizedCodeDocumentIsSealedTest(): Promise<void> {
  const source = "const greeting = \"hello 🚀\";\r\nconst answer = 42;";
  const appendedSource = "\r\nconst appended = true;";
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", initialContent: source, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();

    document.finalize();
    document.finalize();
    assert.strictEqual(document.handle.readSource(), source, "finalization must preserve authored CRLF source without adding a terminal newline");

    assert.throws(() => document.append(appendedSource));
    assert.strictEqual(document.handle.readSource(), source, "a finalized document must reject append without accepting any source");

    const result = await document.highlight({ mode: "range", range: { from: 0, to: 2 } });
    assert.strictEqual(result.exactness, "exact", "a finalized complete document must retain exact highlighting");
    assert.ok(result.tokens, "available finalized highlighting must include public token lines");

    const oracleTokens = oracle.codeToTokensWithThemes(source, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    assert.deepStrictEqual(
      result.tokens.map(normalizePublicLine),
      oracleTokens.map(normalizeShikiLine),
      "finalized dual-theme tokens must match cold Shiki over the complete independently authored source",
    );
  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}


async function runKnownDocumentRangeTest(): Promise<void> {
  const source = "/* 🚀 start\r\nstill comment\r\n*/ const answer = \"x\";";
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", initialContent: source, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();

    assert.strictEqual(document.handle.readSource(), source, "known code documents must retain authored CRLF and astral source");

    const result = await document.highlight({ mode: "range", range: { from: 1, to: 3 } });
    assert.strictEqual(result.exactness, "exact", "a range in known source must retain context from preceding lines");
    assert.ok(result.tokens, "available exact range highlighting must include public token lines");

    const oracleTokens = oracle.codeToTokensWithThemes(source, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    assert.deepStrictEqual(
      result.tokens.map(normalizePublicLine),
      oracleTokens.slice(1, 3).map(normalizeShikiLine),
      "exact range dual-theme tokens must match the same lines from cold Shiki over the complete source",
    );
  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}

async function runIsolatedNonzeroRangeInsideCommentTest(): Promise<void> {
  const source = "/* 🚀 start\r\nconst shadow = 1;\r\n*/ const answer = \"x\";";
  const isolatedFragment = "const shadow = 1;";
  const range = { from: 1, to: 2 };
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", initialContent: source, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();

    assert.strictEqual(document.handle.readSource(), source, "the source-backed document must retain authored CRLF and astral characters");

    const isolated = await document.highlight({ mode: "isolated", range });
    assert.strictEqual(isolated.exactness, "isolated", "an isolated nonzero range must declare its fragment-only grammar context");
    assert.ok(isolated.tokens, "available isolated range highlighting must include public token lines");

    const exact = await document.highlight({ mode: "range", range });
    assert.strictEqual(exact.exactness, "exact", "the same source-backed range must retain its preceding comment state");
    assert.ok(exact.tokens, "available exact range highlighting must include public token lines");

    const isolatedOracle = oracle.codeToTokensWithThemes(isolatedFragment, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    }).map(normalizeShikiLine);
    const exactOracle = oracle.codeToTokensWithThemes(source, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    }).slice(1, 2).map(normalizeShikiLine);
    assert.notDeepStrictEqual(isolatedOracle, exactOracle, "the fixture must distinguish isolated code from inherited comment context");
    assert.deepStrictEqual(
      isolated.tokens.map(normalizePublicLine),
      isolatedOracle,
      "isolated nonzero-range tokens must match cold Shiki over only the selected fragment",
    );
    assert.deepStrictEqual(
      exact.tokens.map(normalizePublicLine),
      exactOracle,
      "exact nonzero-range tokens must match cold Shiki over the complete source and retain prefix grammar",
    );
  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}

async function runAppendInvalidatesProvisionalGrammarTest(): Promise<void> {
  const initialSource = "const message = `🚀 open";
  const appendedSource = " tail`;\r\nconst answer = 42;";
  const completeSource = initialSource + appendedSource;
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", initialContent: initialSource, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();

    const provisional = await document.highlight({ mode: "isolated", range: { from: 0, to: 1 } });
    assert.ok(provisional.tokens, "the open template line must produce provisional tokens");

    document.append(appendedSource);
    assert.strictEqual(document.handle.readSource(), completeSource, "append must preserve the exact authored source");

    const result = await document.highlight({ mode: "range", range: { from: 1, to: 2 } });
    assert.strictEqual(result.exactness, "exact", "appended source ranges must use the updated known source");
    assert.ok(result.tokens, "available appended range highlighting must include public token lines");

    const oracleTokens = oracle.codeToTokensWithThemes(completeSource, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    assert.deepStrictEqual(
      result.tokens.map(normalizePublicLine),
      oracleTokens.slice(1, 2).map(normalizeShikiLine),
      "the line after the completed template must match cold full-source dual-theme Shiki",
    );
  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}

async function runCapturedContextContinuationTest(): Promise<void> {
  const initialSource = "const message = `open\n";
  const appendedSource = "continued`;\r\nconst answer = 42;";
  const completeSource = initialSource + appendedSource;
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", initialContent: initialSource, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();

    const prefix = await document.highlight({ mode: "range", range: { from: 0, to: 1 } });
    assert.strictEqual(prefix.exactness, "exact", "the completed prefix must establish exact grammar context");
    assert.ok(prefix.tokens, "the completed prefix must produce public token lines");
    const context = document.captureContext();

    document.append(appendedSource);
    assert.strictEqual(document.handle.readSource(), completeSource, "continuation must preserve the exact appended source");

    const result = await document.highlight({
      mode: "continuation",
      context,
      range: { from: 1, to: 3 },
    });
    assert.strictEqual(result.exactness, "exact", "captured context must make appended continuation ranges exact");
    assert.ok(result.tokens, "available continuation highlighting must include public token lines");

    const oracleTokens = oracle.codeToTokensWithThemes(completeSource, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    assert.deepStrictEqual(
      result.tokens.map(normalizePublicLine),
      oracleTokens.slice(1, 3).map(normalizeShikiLine),
      "continuation dual-theme tokens must match cold Shiki over the complete updated source",
    );
  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}

async function runCallerThemeMutationDoesNotChangeCapturedConfigurationTest(): Promise<void> {
  const initialSource = "const first = true;\n";
  const appendedSource = "const second = false;\n";
  const completeSource = initialSource + appendedSource;
  const themes: { dark: "github-dark" | "github-dark-dimmed"; light: "github-light" } = {
    dark: "github-dark",
    light: "github-light",
  };
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", initialContent: initialSource, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: ["github-dark", "github-light"],
    });
    disposeOracle = () => oracle.dispose();

    const prefix = await document.highlight({ mode: "range", range: { from: 0, to: 1 } });
    assert.strictEqual(prefix.exactness, "exact", "the completed prefix must establish exact grammar context");
    assert.ok(prefix.tokens, "the completed prefix must produce public token lines");
    const context = document.captureContext();

    themes.dark = "github-dark-dimmed";
    document.append(appendedSource);
    assert.strictEqual(document.handle.readSource(), completeSource, "continuation must preserve the exact appended source");

    const result = await document.highlight({
      mode: "continuation",
      context,
      range: { from: 1, to: 2 },
    });
    assert.strictEqual(result.exactness, "exact", "captured context must make the appended continuation range exact");
    assert.ok(result.tokens, "available continuation highlighting must include public token lines");

    const oracleTokens = oracle.codeToTokensWithThemes(completeSource, {
      lang: "typescript",
      themes: { dark: "github-dark", light: "github-light" },
    });
    assert.deepStrictEqual(
      result.tokens.map(normalizePublicLine),
      oracleTokens.slice(1, 2).map(normalizeShikiLine),
      "continuation dual-theme tokens must retain the original theme pair after caller mutation",
    );
  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}

async function runForeignContextReportsStaleGenerationTest(): Promise<void> {
  const prefixSource = "const header = 1;\nconst message = `open\n";
  const completedSource = `${prefixSource}continued\`;\r\nconst answer = 42;`;
  let disposeFirstDocument: (() => void) | undefined;
  let disposeSecondDocument: (() => void) | undefined;

  try {
    const firstDocument = createCodeDocument({ language: "typescript", initialContent: prefixSource });
    disposeFirstDocument = () => firstDocument.dispose();
    const secondDocument = createCodeDocument({ language: "typescript", initialContent: completedSource });
    disposeSecondDocument = () => secondDocument.dispose();

    const prefix = await firstDocument.highlight({ mode: "range", range: { from: 0, to: 2 } });
    assert.strictEqual(prefix.exactness, "exact", "the context owner must have a completed multiline prefix");
    const context = firstDocument.captureContext();

    const result = await secondDocument.highlight({
      mode: "continuation",
      context,
      range: { from: 2, to: 4 },
    });
    assert.strictEqual(result.exactness, "unavailable", "foreign context must not claim exact or isolated highlighting");
    assert.strictEqual(result.tokens, null, "foreign context must not return approximate tokens");
    assert.strictEqual(result.reason, "stale_generation", "a context from another document must report stale generation");
  } finally {
    try {
      disposeFirstDocument?.();
    } finally {
      disposeSecondDocument?.();
    }
  }
}

async function runDiffRangeWithoutBaseContextIsUnavailableTest(): Promise<void> {
  const diffSource = [
    "@@ -100,2 +100,2 @@",
    "-old",
    "+new",
    " shared",
    "",
  ].join("\n");
  let disposeDocument: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", diff: true, initialContent: diffSource });
    disposeDocument = () => document.dispose();

    const result = await document.highlight({ mode: "range", range: { from: 0, to: 4 } });
    assert.strictEqual(result.exactness, "unavailable", "a diff hunk without old/new prefix grammar must not claim exact or isolated tokens");
    assert.strictEqual(result.tokens, null, "unknown diff-side prefix state must not return approximate tokens");
    assert.strictEqual(result.reason, "missing_context", "an unbased unified diff range must report missing context");
  } finally {
    disposeDocument?.();
  }
}

async function runUnifiedDiffUsesIndependentGrammarTracksTest(): Promise<void> {
  const diffSource = [
    "@@ -1,4 +1,4 @@",
    "-/* old open",
    "+const fresh = `",
    " shared content",
    "-*/ const oldValue = 1;",
    "+`; const newValue = 2;",
    " const sharedEnd = 3;",
    "",
  ].join("\n");
  const oldSource = "/* old open\nshared content\n*/ const oldValue = 1;\nconst sharedEnd = 3;";
  const newSource = "const fresh = `\nshared content\n`; const newValue = 2;\nconst sharedEnd = 3;";
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", diff: true, initialContent: diffSource, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();

    const result = await document.highlight({ mode: "range", range: { from: 0, to: 7 } });
    assert.strictEqual(result.exactness, "exact", "a hunk beginning at line one has known old/new initial grammar state");
    assert.ok(result.tokens, "available unified-diff highlighting must include public token lines");

    const oldOracleTokens = oracle.codeToTokensWithThemes(oldSource, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    const newOracleTokens = oracle.codeToTokensWithThemes(newSource, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    const expectedLines = [
      normalizeShikiLine(oldOracleTokens[0] ?? []),
      normalizeShikiLine(newOracleTokens[0] ?? []),
      normalizeShikiLine(newOracleTokens[1] ?? []),
      normalizeShikiLine(oldOracleTokens[2] ?? []),
      normalizeShikiLine(newOracleTokens[2] ?? []),
      normalizeShikiLine(newOracleTokens[3] ?? []),
    ];
    const actualLines = result.tokens.slice(1, 7).map(normalizePublicLine);

    assert.deepStrictEqual(
      actualLines,
      expectedLines,
      "removed rows must use old-source tokens, additions and shared rows new-source tokens, and markers must stay outside content spans",
    );
    assert.notDeepStrictEqual(
      expectedLines[2],
      normalizeShikiLine(oldOracleTokens[1] ?? []),
      "the shared template-content fixture must distinguish new-side tokens from old-side comment tokens",
    );
  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}

async function runNonzeroDiffRangeReplaysBothTracksTest(): Promise<void> {
  const diffSource = [
    "@@ -1,4 +1,4 @@",
    "-/* old open",
    "+const fresh = `",
    " shared content",
    "-*/ const oldValue = 1;",
    "+`; const newValue = 2;",
    " const sharedEnd = 3;",
    "",
  ].join("\n");
  const oldSource = "/* old open\nshared content\n*/ const oldValue = 1;\nconst sharedEnd = 3;";
  const newSource = "const fresh = `\nshared content\n`; const newValue = 2;\nconst sharedEnd = 3;";
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", diff: true, initialContent: diffSource, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();

    const result = await document.highlight({ mode: "range", range: { from: 3, to: 6 } });
    assert.strictEqual(result.exactness, "exact", "a nonzero range in a hunk beginning at line one must replay exact grammar");
    assert.ok(result.tokens, "available diff range highlighting must include public token lines");

    const oldOracleTokens = oracle.codeToTokensWithThemes(oldSource, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    const newOracleTokens = oracle.codeToTokensWithThemes(newSource, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    assert.deepStrictEqual(
      result.tokens.map(normalizePublicLine),
      [
        normalizeShikiLine(newOracleTokens[1] ?? []),
        normalizeShikiLine(oldOracleTokens[2] ?? []),
        normalizeShikiLine(newOracleTokens[2] ?? []),
      ],
      "nonzero diff ranges must replay old and new grammar prefixes independently and return marker-free content tokens",
    );
  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}

async function runDiffRangeExposesBothContextTokenTracksTest(): Promise<void> {
  const diffSource = [
    "@@ -1,3 +1,3 @@",
    "-/* old open",
    "+const newStart = 0;",
    " const shared = 1;",
    "-*/",
    "+const newEnd = 2;",
    "",
  ].join("\n");
  const oldSource = "/* old open\nconst shared = 1;\n*/\n";
  const newSource = "const newStart = 0;\nconst shared = 1;\nconst newEnd = 2;\n";
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", diff: true, initialContent: diffSource, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();

    const result = await document.highlight({ mode: "range", range: { from: 3, to: 4 } });
    assert.strictEqual(result.exactness, "exact", "a source-backed shared diff row must have exact old/new grammar states");
    assert.ok(result.tokens, "available diff highlighting must include unified token lines");

    const oldOracleTokens = oracle.codeToTokensWithThemes(oldSource, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    const newOracleTokens = oracle.codeToTokensWithThemes(newSource, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    const expectedOld = normalizeShikiLine(oldOracleTokens[1] ?? []);
    const expectedNew = normalizeShikiLine(newOracleTokens[1] ?? []);
    assert.notDeepStrictEqual(
      expectedOld,
      expectedNew,
      "the shared-row fixture must produce different old/new lexical colors from the independent oracle",
    );
    assert.deepStrictEqual(
      result.tokens.map(normalizePublicLine),
      [expectedNew],
      "unified context-row tokens must retain the new-source result",
    );

    const diffTokens = result.diffTokens;
    assert.ok(diffTokens, "available diff highlighting must expose both public token tracks");
    const contextTokens = diffTokens[0];
    assert.ok(contextTokens, "the requested shared row must have a paired diff token line");
    const oldTokens = contextTokens.old;
    const newTokens = contextTokens.new;
    assert.ok(oldTokens, "the shared diff token line must include old-source tokens");
    assert.ok(newTokens, "the shared diff token line must include new-source tokens");
    assert.deepStrictEqual(
      normalizePublicLine(oldTokens),
      expectedOld,
      "the shared row's old-side tokens must match independent old-source highlighting under both themes",
    );
    assert.deepStrictEqual(
      normalizePublicLine(newTokens),
      expectedNew,
      "the shared row's new-side tokens must match independent new-source highlighting under both themes",
    );
  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}

async function runLaterUnifiedDiffHunkWithoutContextIsUnavailableTest(): Promise<void> {
  const diffSource = "@@ -1 +1 @@\n-old();\n+new();\n@@ -100 +100 @@\n-before();\n+after();";
  let disposeDocument: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", diff: true, initialContent: diffSource });
    disposeDocument = () => document.dispose();

    const result = await document.highlight({ mode: "range", range: { from: 4, to: 6 } });
    assert.strictEqual(result.exactness, "unavailable", "a later skipped diff hunk must not claim exact or isolated highlighting");
    assert.strictEqual(result.reason, "missing_context", "a later skipped diff hunk must report missing context");
    assert.strictEqual(result.tokens, null, "a later skipped diff hunk must not return approximate tokens");
    assert.strictEqual(document.handle.readSource(), diffSource, "diff highlighting must preserve the authored source");
  } finally {
    disposeDocument?.();
  }
}

async function runDiffFileContextAvailabilityResetsTest(): Promise<void> {
  const diffSource = [
    "diff --git a/old.ts b/old.ts",
    "--- a/old.ts",
    "+++ b/old.ts",
    "@@ -100 +100 @@",
    "-old();",
    "+new();",
    "diff --git a/fresh.ts b/fresh.ts",
    "--- a/fresh.ts",
    "+++ b/fresh.ts",
    "@@ -1 +1 @@",
    "-before();",
    "+after();",
  ].join("\n");
  let disposeDocument: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", diff: true, initialContent: diffSource });
    disposeDocument = () => document.dispose();

    const unavailable = await document.highlight({ mode: "range", range: { from: 4, to: 6 } });
    assert.strictEqual(unavailable.exactness, "unavailable", "a file hunk beginning at line 100 must not claim exact highlighting");
    assert.strictEqual(unavailable.reason, "missing_context", "an unbased file hunk must report missing context");

    const freshFile = await document.highlight({ mode: "range", range: { from: 10, to: 12 } });
    assert.strictEqual(freshFile.exactness, "exact", "a new file's line-one hunk must regain exact contextual availability");
    assert.ok(freshFile.tokens, "available new-file highlighting must include public token lines");
    assert.deepStrictEqual(
      freshFile.tokens.map((line) => line.spans.map((span) => span.t).join("")),
      ["before();", "after();"],
      "new-file tokens must be exact body content without diff markers",
    );
  } finally {
    disposeDocument?.();
  }
}

async function runMultiFileDiffUsesIndependentPerFileShikiTest(): Promise<void> {
  const diffSource = [
    "diff --git a/open.ts b/open.ts",
    "--- a/open.ts",
    "+++ b/open.ts",
    "@@ -1 +1 @@",
    "-/* old comment",
    "+/* new comment",
    "diff --git a/fresh.ts b/fresh.ts",
    "--- a/fresh.ts",
    "+++ b/fresh.ts",
    "@@ -1 +1 @@",
    "-const oldValue = 1;",
    "+const freshValue = 1;",
    "diff --git a/script.py b/script.py",
    "--- a/script.py",
    "+++ b/script.py",
    "@@ -1,2 +1,2 @@",
    "-def old():",
    "+def fresh():",
    "     return 1",
  ].join("\n");
  const fileSources = {
    oldOpen: "/* old comment",
    newOpen: "/* new comment",
    oldFresh: "const oldValue = 1;",
    newFresh: "const freshValue = 1;",
    oldPython: "def old():\n    return 1",
    newPython: "def fresh():\n    return 1",
  };
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", diff: true, initialContent: diffSource, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript", "python"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();

    document.finalize();
    const result = await document.highlight({ mode: "range", range: { from: 0, to: 18 } });
    assert.strictEqual(result.exactness, "exact");
    assert.ok(result.diffTokens, "multi-file results must expose both source-side token tracks");
    const independent = (source: string, lang: "typescript" | "python") =>
      oracle.codeToTokensWithThemes(source, {
        lang,
        themes: { dark: themes.dark, light: themes.light },
      }).map(normalizeShikiLine);
    const oldOpen = independent(fileSources.oldOpen, "typescript");
    const newOpen = independent(fileSources.newOpen, "typescript");
    const oldFresh = independent(fileSources.oldFresh, "typescript");
    const newFresh = independent(fileSources.newFresh, "typescript");
    const oldPython = independent(fileSources.oldPython, "python");
    const newPython = independent(fileSources.newPython, "python");
    const tracks = result.diffTokens;
    assert.deepStrictEqual(normalizePublicLine(tracks[4]!.old!), oldOpen[0]);
    assert.deepStrictEqual(normalizePublicLine(tracks[5]!.new!), newOpen[0]);
    assert.deepStrictEqual(
      normalizePublicLine(tracks[10]!.old!),
      oldFresh[0],
      "the next TypeScript file must not inherit the prior file's open multiline comment",
    );
    assert.deepStrictEqual(
      normalizePublicLine(tracks[11]!.new!),
      newFresh[0],
      "the added row in a new TypeScript file must start from initial grammar state",
    );
    assert.deepStrictEqual(
      normalizePublicLine(tracks[16]!.old!),
      oldPython[0],
      "the Python file's old track must use its own language and fresh grammar state",
    );
    assert.deepStrictEqual(
      normalizePublicLine(tracks[17]!.new!),
      newPython[0],
      "the Python file's new track must use its own language and fresh grammar state",
    );
    const contextResult = await document.highlight({ mode: "range", range: { from: 18, to: 19 } });
    assert.strictEqual(contextResult.exactness, "exact", "a checkpoint inside a detected file must remain reusable for later ranges");
    assert.ok(contextResult.diffTokens);
    assert.deepStrictEqual(normalizePublicLine(contextResult.diffTokens[0]!.old!), oldPython[1]);
    assert.deepStrictEqual(normalizePublicLine(contextResult.diffTokens[0]!.new!), newPython[1]);
    assert.notDeepStrictEqual(
      oldPython[0],
      independent(fileSources.oldPython, "typescript")[0],
      "the Python fixture must distinguish per-file language detection from the document fallback",
    );
  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}

async function runHeaderLikeDiffContentUsesHunkCountsTest(): Promise<void> {
  const diffSource = "@@ -1 +1 @@\n--- before();\n+++ after();\n";
  let disposeDocument: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", diff: true, initialContent: diffSource });
    disposeDocument = () => document.dispose();

    const result = await document.highlight({ mode: "range", range: { from: 0, to: 3 } });
    assert.strictEqual(result.exactness, "exact", "hunk counts must disambiguate header-like lines as authored diff content");
    assert.ok(result.tokens, "available diff highlighting must include public token lines");
    assert.strictEqual(
      result.tokens[1]?.spans.map((span) => span.t).join(""),
      "-- before();",
      "the removed line must retain its two authored leading hyphens without its diff marker",
    );
    assert.strictEqual(
      result.tokens[2]?.spans.map((span) => span.t).join(""),
      "++ after();",
      "the added line must retain its two authored leading pluses without its diff marker",
    );
  } finally {
    disposeDocument?.();
  }
}

async function runDeclaredHunkCountsReportDiffStatusTest(): Promise<void> {
  let disposeOpen: (() => void) | undefined;
  let disposeTruncated: (() => void) | undefined;

  try {
    // The hunk declares three old and three new rows; the first two arrive before the third.
    const open = createCodeDocument({
      language: "typescript",
      diff: true,
      initialContent: "@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n",
    });
    disposeOpen = () => open.dispose();
    assert.strictEqual(open.handle.readMetadata().diffStatus, "incomplete", "an open hunk still owed rows is incomplete");

    open.append(" const c = 4;\n");
    assert.strictEqual(open.handle.readMetadata().diffStatus, "complete", "satisfied declared counts complete the diff");
    open.finalize();
    assert.strictEqual(open.handle.readMetadata().diffStatus, "complete", "finalizing a balanced diff keeps it complete");

    const truncated = createCodeDocument({
      language: "typescript",
      diff: true,
      initialContent: "@@ -1,5 +1,5 @@\n-const answer = 41;\n+const answer = 42;",
    });
    disposeTruncated = () => truncated.dispose();
    truncated.finalize();
    assert.strictEqual(
      truncated.handle.readMetadata().diffStatus,
      "malformed",
      "a sealed diff whose hunk is missing declared rows is malformed",
    );
    const known = await truncated.highlight({ mode: "range", range: { from: 0, to: 3 } });
    assert.strictEqual(known.exactness, "exact", "rows already authored from line 0 keep exact tokens; malformation is reported separately");

    const plain = createCodeDocument({ language: "typescript", initialContent: "const plain = true;\n" });
    try {
      assert.strictEqual(Object.hasOwn(plain.handle.readMetadata(), "diffStatus"), false, "ordinary code carries no diff status");
    } finally {
      plain.dispose();
    }

    // Each side's owed rows count on its own, a section heading may follow a hunk header, and the
    // unterminated tail line counts once it is authored.
    const statusCases: ReadonlyArray<readonly [content: string, status: string, reason: string]> = [
      ["@@ -1 +1,2 @@\n-a\n+b\n", "incomplete", "a hunk owing only new rows is incomplete"],
      ["@@ -1,2 +1 @@\n-a\n+b\n", "incomplete", "a hunk owing only old rows is incomplete"],
      ["@@ -1 +1,2 @@\n-a\n+b\n@@ -9 +9 @@ function f() {\n-z\n+y\n", "malformed", "a headed hunk abandoning owed new rows is malformed"],
      ["@@ -1,2 +1 @@\n-a\n+b\ndiff --git a/x.ts b/x.ts\n", "malformed", "a file boundary abandoning owed old rows is malformed"],
      ["@@ -1 +1 @@\n-a\n+b", "complete", "an authored unterminated last row satisfies the hunk"],
      ["@@ -1,2 +1,2 @@\n-a\n+b\n@@ -9 +9 @@", "malformed", "an unterminated header abandoning owed rows is malformed"],
    ];
    for (const [initialContent, status, reason] of statusCases) {
      const document = createCodeDocument({ language: "typescript", diff: true, initialContent });
      try {
        assert.strictEqual(document.handle.readMetadata().diffStatus, status, reason);
      } finally {
        document.dispose();
      }
    }

    // The first hunk owes a row when the second header arrives; later balance cannot repair it.
    const cutShort = createCodeDocument({
      language: "typescript",
      diff: true,
      initialContent: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n@@ -9 +9 @@\n-const z = 1;\n+const z = 2;\n",
    });
    try {
      assert.strictEqual(
        cutShort.handle.readMetadata().diffStatus,
        "malformed",
        "a hunk header that arrives while the previous hunk still owes rows is malformed",
      );
    } finally {
      cutShort.dispose();
    }
  } finally {
    disposeOpen?.();
    disposeTruncated?.();
  }
}

async function runDeletedFileHeaderLikeBodyRangePropertyTest(): Promise<void> {
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeOracle: (() => void) | undefined;

  try {
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constant(" * harmless comment body"), { maxLength: 18 }),
        async (redundantCommentRows) => {
          const oldSourceLines = [
            "/*",
            "-- authored header-like comment row",
            ...redundantCommentRows,
            "*/",
          ];
          const oldSource = oldSourceLines.join("\n");
          const diffSource = [
            "--- a/old.ts",
            "+++ /dev/null",
            `@@ -1,${oldSourceLines.length} +0,0 @@`,
            ...oldSourceLines.map((line) => `-${line}`),
          ].join("\n");
          let disposeDocument: (() => void) | undefined;

          try {
            const document = createCodeDocument({
              language: "typescript",
              diff: true,
              initialContent: diffSource,
              themes,
            });
            disposeDocument = () => document.dispose();

            const result = await document.highlight({
              mode: "range",
              range: { from: 3, to: 3 + oldSourceLines.length },
            });
            assert.strictEqual(result.exactness, "exact", "a deleted-file body range must retain exact old-side grammar");
            assert.ok(result.tokens, "available deleted-file highlighting must include unified body tokens");
            assert.ok(result.diffTokens, "available deleted-file highlighting must expose paired body tokens");

            const expectedLines = oracle.codeToTokensWithThemes(oldSource, {
              lang: "typescript",
              themes: { dark: themes.dark, light: themes.light },
            }).map(normalizeShikiLine);
            assert.deepStrictEqual(
              result.tokens.map(normalizePublicLine),
              expectedLines,
              "unified removed rows must match independent full-source Shiki without diff markers under both themes",
            );
            assert.deepStrictEqual(
              result.diffTokens.map((tracks, index) => {
                assert.ok(tracks, `deleted source row ${index} must retain a paired token entry`);
                assert.ok(tracks.old, `deleted source row ${index} must expose old-side tokens`);
                assert.strictEqual(tracks.new, null, `deleted source row ${index} must not invent new-side tokens`);
                return normalizePublicLine(tracks.old);
              }),
              expectedLines,
              "paired old-side rows must match independent full-source Shiki under both themes",
            );
          } finally {
            disposeDocument?.();
          }
        },
      ),
      { seed: 20261025, numRuns: 32 },
    );
  } finally {
    disposeOracle?.();
  }
}

async function runFinalizedNewFileWithoutTerminalNewlineTest(): Promise<void> {
  const diffSource = '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+const added = "value";\n\\ No newline at end of file';
  const newSource = 'const added = "value";';
  const themes = { dark: "github-dark", light: "github-light" } as const;
  let disposeDocument: (() => void) | undefined;
  let disposeOracle: (() => void) | undefined;

  try {
    const document = createCodeDocument({ language: "typescript", diff: true, initialContent: diffSource, themes });
    disposeDocument = () => document.dispose();
    const oracle = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      langs: ["typescript"],
      themes: [themes.dark, themes.light],
    });
    disposeOracle = () => oracle.dispose();

    document.finalize();
    assert.strictEqual(diffSource.endsWith("\n"), false, "the new-file EOF fixture must not add a terminal LF");
    assert.strictEqual(document.handle.readSource(), diffSource, "finalization must preserve the authored diff bytes exactly");

    const result = await document.highlight({ mode: "range", range: { from: 0, to: 5 } });
    assert.strictEqual(result.exactness, "exact", "a finalized zero-old-count new-file hunk must highlight its complete range exactly");
    assert.ok(result.tokens, "available finalized diff highlighting must include public token lines");
    assert.strictEqual(result.tokens.length, 5, "the requested range must include every header, hunk, addition, and EOF marker line");
    assert.ok(result.diffTokens, "available diff highlighting must expose both public token tracks");

    const oracleTokens = oracle.codeToTokensWithThemes(newSource, {
      lang: "typescript",
      themes: { dark: themes.dark, light: themes.light },
    });
    const expectedNew = normalizeShikiLine(oracleTokens[0] ?? []);
    const addedTracks = result.diffTokens[3];
    assert.ok(addedTracks, "the new-file addition must have a paired diff-token line");
    assert.strictEqual(addedTracks.old, null, "a new-file addition must not invent old-source tokens");
    assert.ok(addedTracks.new, "a new-file addition must expose new-source tokens");
    assert.deepStrictEqual(
      normalizePublicLine(addedTracks.new),
      expectedNew,
      "the new track must match independent dual-theme Shiki over the complete no-newline file source",
    );
    assert.deepStrictEqual(
      normalizePublicLine(result.tokens[3]!),
      expectedNew,
      "the unified public addition must use the new-source token track without diff markers",
    );

    for (const index of [0, 1, 2, 4]) {
      const tracks = result.diffTokens[index];
      assert.ok(tracks, `metadata line ${index} must retain its paired diff-token entry`);
      assert.strictEqual(tracks.old, null, `metadata line ${index} must not acquire old-source tokens`);
      assert.strictEqual(tracks.new, null, `metadata line ${index} must not acquire new-source tokens`);
      assert.ok(
        result.tokens[index]!.spans.every((span) => span.s === undefined && span.v === undefined),
        `metadata line ${index} must not receive synthetic language highlighting`,
      );
    }
  } finally {
    try {
      disposeDocument?.();
    } finally {
      disposeOracle?.();
    }
  }
}

await runDiffFileContextAvailabilityResetsTest();

await runMultiFileDiffUsesIndependentPerFileShikiTest();

await runHeaderLikeDiffContentUsesHunkCountsTest();
await runDeletedFileHeaderLikeBodyRangePropertyTest();
await runFinalizedNewFileWithoutTerminalNewlineTest();
await runDeclaredHunkCountsReportDiffStatusTest();

await runStandaloneCodeDocumentTest();
await runFinalizedCodeDocumentIsSealedTest();
await runKnownDocumentRangeTest();
await runIsolatedNonzeroRangeInsideCommentTest();
await runAppendInvalidatesProvisionalGrammarTest();
await runCapturedContextContinuationTest();
await runCallerThemeMutationDoesNotChangeCapturedConfigurationTest();
await runForeignContextReportsStaleGenerationTest();
await runDiffRangeWithoutBaseContextIsUnavailableTest();
await runUnifiedDiffUsesIndependentGrammarTracksTest();
await runNonzeroDiffRangeReplaysBothTracksTest();
await runDiffRangeExposesBothContextTokenTracksTest();
await runLaterUnifiedDiffHunkWithoutContextIsUnavailableTest();
console.log("code document tests passed");
