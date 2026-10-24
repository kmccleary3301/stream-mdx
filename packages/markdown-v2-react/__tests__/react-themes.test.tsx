import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

import { StreamingMarkdown } from "../src/streaming-markdown";

async function setupDom(): Promise<Window & typeof globalThis> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const target = globalThis as unknown as Record<string, unknown>;
  target.window = window;
  target.document = window.document;
  target.HTMLElement = window.HTMLElement;
  target.Node = window.Node;
  target.DOMParser = window.DOMParser;
  target.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  target.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  return window as unknown as Window & typeof globalThis;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForMutation(container: HTMLElement, predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  if (predicate()) return Promise.resolve();
  const { promise, resolve, reject } = deferred<void>();
  const defaultView = container.ownerDocument.defaultView;
  const ObserverClass = defaultView?.MutationObserver ?? MutationObserver;
  let timer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    clearInterval(timer);
    clearTimeout(timeoutTimer);
    observer.disconnect();
  };

  const check = () => {
    if (predicate()) {
      cleanup();
      resolve();
    }
  };

  const observer = new ObserverClass(() => {
    check();
  });
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  timer = setInterval(() => {
    check();
  }, 20);
  timeoutTimer = setTimeout(() => {
    cleanup();
    reject(new Error("waitForMutation timed out"));
  }, timeoutMs);
  return promise;
}

function assertThemeCssContract(): void {
  const cssPath = fileURLToPath(new URL("../../theme-tailwind/theme.css", import.meta.url));
  const stylesheet = postcss.parse(readFileSync(cssPath, "utf8"), { from: cssPath });
  let variableRuleCount = 0;
  const shikiRules: postcss.Rule[] = [];

  stylesheet.walkRules((rule) => {
    if (rule.nodes?.some((node) => node.type === "decl" && node.prop.startsWith("--"))) {
      variableRuleCount++;
      assert.ok(
        rule.selectors.every((selector) => selector.includes("[data-stream-mdx]")),
        `custom property selector must be scoped to StreamMDX: ${rule.selector}`,
      );
    }
    if (rule.selector.includes(".markdown-v2-output")) {
      assert.ok(
        rule.selectors.every((selector) => selector.includes("[data-stream-mdx]")),
        `native output selector must be scoped to StreamMDX: ${rule.selector}`,
      );
    }
    if (rule.selector.includes(".shiki")) {
      assert.ok(
        rule.selectors.every((selector) => selector.includes("[data-stream-mdx]")),
        `Shiki selector must be scoped to StreamMDX: ${rule.selector}`,
      );
      shikiRules.push(rule);
    }
  });

  assert.ok(variableRuleCount > 0, "theme CSS must expose scoped custom properties");
  const lightDeclarations = shikiRules
    .flatMap((rule) => rule.nodes ?? [])
    .filter((node): node is postcss.Declaration => node.type === "decl");
  for (const [property, value] of [
    ["color", "var(--shiki-light)"],
    ["background-color", "var(--shiki-light-bg)"],
    ["font-style", "var(--shiki-light-font-style)"],
    ["font-weight", "var(--shiki-light-font-weight)"],
    ["text-decoration", "var(--shiki-light-text-decoration)"],
  ]) {
    assert.ok(
      lightDeclarations.some((declaration) => declaration.prop === property && declaration.value === value),
      `light Shiki styles must include ${property}: ${value}`,
    );

  }
  const assertDarkShikiDeclarations = (rules: postcss.Rule[], context: string) => {
    const declarations = rules
      .flatMap((rule) => rule.nodes ?? [])
      .filter((node): node is postcss.Declaration => node.type === "decl");
    for (const [property, value] of [
      ["color", "var(--shiki-dark)"],
      ["background-color", "var(--shiki-dark-bg)"],
      ["font-style", "var(--shiki-dark-font-style)"],
      ["font-weight", "var(--shiki-dark-font-weight)"],
      ["text-decoration", "var(--shiki-dark-text-decoration)"],
    ]) {
      assert.ok(
        declarations.some((declaration) => declaration.prop === property && declaration.value === value),
        `${context} Shiki styles must include ${property}: ${value}`,
      );
    }
  };

  const explicitDarkRules = shikiRules.filter((rule) =>
    rule.selector.includes("[data-stream-mdx][data-color-scheme=\"dark\"]"),
  );
  assertDarkShikiDeclarations(explicitDarkRules, "explicit dark");

  const legacyDarkRules = shikiRules.filter((rule) =>
    rule.selector.includes(".dark [data-stream-mdx]:not([data-color-scheme])"),
  );
  assertDarkShikiDeclarations(legacyDarkRules, "legacy .dark");

  const systemDarkRules: postcss.Rule[] = [];
  stylesheet.walkAtRules("media", (media) => {
    if (!media.params.includes("prefers-color-scheme: dark")) return;
    media.walkRules((rule) => {
      if (rule.selector.includes("[data-stream-mdx][data-color-scheme=\"system\"]")) {
        systemDarkRules.push(rule);
      }
    });
  });
  assertDarkShikiDeclarations(systemDarkRules, "system dark");
}

function assertNativeRoot(container: HTMLElement, colorScheme?: "light" | "dark" | "system"): void {
  const nativeRoot = container.querySelector<HTMLElement>("[data-stream-mdx]");
  assert.ok(nativeRoot, "native output root must carry data-stream-mdx");
  assert.ok(nativeRoot.classList.contains("not-prose"), "native output root must opt out of enclosing prose styles");
  assert.equal(nativeRoot.getAttribute("data-color-scheme"), colorScheme ?? null);
}



async function runReactThemesTest(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "missing render root");

  const root = createRoot(container);
  const code = "```javascript\nconst x = 1;\n```\n";

  try {
    // 1. Initial render with custom themes
    root.render(
      <StreamingMarkdown
        engine="main"
        text={code}
        themes={{ light: "min-light", dark: "nord" }}
      />,
    );

    await waitForMutation(container, () => {
      return container.innerHTML.includes("nord") || container.innerHTML.includes("min-light");
    });

    const htmlWithCustom = container.innerHTML;
    assert.ok(htmlWithCustom.includes("nord") && htmlWithCustom.includes("min-light"), "DOM must reflect custom nord and min-light themes");
    assert.ok(!htmlWithCustom.includes("github-dark"), "DOM must not contain default github-dark when custom themes are set");

    assertNativeRoot(container);

    for (const colorScheme of ["light", "dark", "system"] as const) {
      root.render(<StreamingMarkdown engine="main" text={code} colorScheme={colorScheme} />);
      await waitForMutation(container, () => {
        return container
          .querySelector("[data-stream-mdx]")
          ?.getAttribute("data-color-scheme") === colorScheme;
      });
      assertNativeRoot(container, colorScheme);
    }

    root.render(<StreamingMarkdown engine="main" text={code} />);
    await waitForMutation(container, () => {
      return container.querySelector("[data-stream-mdx]")?.getAttribute("data-color-scheme") === null;
    });
    assertNativeRoot(container);
    assertThemeCssContract();



    // 2. Change themes prop to default themes -> restarts / re-inits
    root.render(
      <StreamingMarkdown
        engine="main"
        text={code}
        themes={{ light: "github-light", dark: "github-dark" }}
      />,
    );

    await waitForMutation(container, () => {
      return container.innerHTML.includes("github-dark") && container.innerHTML.includes("github-light");
    });

    const htmlWithDefault = container.innerHTML;
    assert.ok(htmlWithDefault.includes("github-dark") && htmlWithDefault.includes("github-light"), "re-init must switch to github themes");
    assert.ok(!htmlWithDefault.includes("nord"), "re-init must remove nord theme classes");
  } finally {
    root.unmount();
  }
}

await runReactThemesTest();
console.log("react themes tests passed");
