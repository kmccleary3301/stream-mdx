// Security layer with sanitization and Trusted Types
// Handles HTML sanitization for safe rendering

import createDOMPurify, { type Config as DOMPurifyConfig, type DOMPurify } from "dompurify";
import { decodeHTML5Strict } from "entities";

import { CODE_ROW_ALLOWED_ATTRS, CODE_ROW_ALLOWED_TAGS, isSafeCodeRowStyle, sanitizeCodeHtmlInWorker } from "./worker-html-sanitizer";

type DOMPurifyInstance = {
  sanitize: (html: string, config: DOMPurifyConfig) => unknown;
  addHook?: (name: string, hook: (node: unknown) => unknown) => void;
};

type TrustedTypePolicyLike = {
  createHTML: (input: string) => string;
};

type TrustedTypePolicyFactoryLike = {
  createPolicy: (
    name: string,
    rules: {
      createHTML: (input: string) => string;
      createScript?: (input: string) => string;
      createScriptURL?: (input: string) => string;
    },
  ) => TrustedTypePolicyLike;
};

let domPurifyInstance: DOMPurifyInstance | null = null;
let domPurifyBoundWindow: Window | null = null;

function resolveDOMPurify(): DOMPurifyInstance {
  if (typeof window === "undefined") {
    const maybeInstance = createDOMPurify as unknown as DOMPurifyInstance;
    if (maybeInstance && typeof maybeInstance.sanitize === "function") {
      return maybeInstance;
    }
    if (domPurifyInstance && typeof domPurifyInstance.sanitize === "function") {
      return domPurifyInstance;
    }
    throw new Error("[markdown-v2] DOMPurify requires a DOM `window` to sanitize HTML. Provide a DOM (e.g. via jsdom) before calling sanitize helpers.");
  }
  // Rebind whenever the current window changed: an instance captured against a
  // replaced/closed window silently sanitizes to "" instead of failing loudly.
  if (domPurifyInstance && domPurifyBoundWindow === window && typeof domPurifyInstance.sanitize === "function") {
    return domPurifyInstance;
  }
  if (typeof createDOMPurify === "function") {
    const rebind = createDOMPurify as unknown as (win: Window) => DOMPurifyInstance;
    const created = rebind(window);
    if (created && typeof created.sanitize === "function") {
      domPurifyInstance = created;
      domPurifyBoundWindow = window;
      return created;
    }
  }
  const maybeInstance = createDOMPurify as unknown as DOMPurifyInstance;
  if (maybeInstance && typeof maybeInstance.sanitize === "function") {
    return maybeInstance;
  }
  throw new Error("[markdown-v2] DOMPurify could not bind to the available DOM `window` to sanitize HTML.");
}

/**
 * Trusted Types policy for safe HTML rendering
 */
let trustedTypesPolicy: TrustedTypePolicyLike | undefined;

/**
 * Initialize Trusted Types policy
 */
export function initializeTrustedTypesPolicy(): void {
  if (typeof window === "undefined" || trustedTypesPolicy) {
    return;
  }
  const trustedWindow = window as typeof window & { trustedTypes?: TrustedTypePolicyFactoryLike };
  const factory = trustedWindow.trustedTypes;
  if (!factory || trustedTypesPolicy) {
    return;
  }
  trustedTypesPolicy = factory.createPolicy("markdown-renderer-v2", {
    createHTML: (input: string) => {
      const out = resolveDOMPurify().sanitize(input, {
        ALLOWED_TAGS: [
          // Block elements
          "div",
          "p",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "blockquote",
          "pre",
          "code",
          "sub",
          "sup",
          "kbd",
          "ul",
          "ol",
          "li",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
          "hr",
          "br",

          // Inline elements
          "span",
          "strong",
          "em",
          "a",
          "img",

          // Code highlighting
          'span[class^="token"]',

          // Math rendering (KaTeX)
          'span[class^="katex"]',
          'span[class^="mord"]',
          'span[class^="mopen"]',
          'span[class^="mclose"]',
          'span[class^="mop"]',
          'span[class^="mbin"]',
          'span[class^="mrel"]',
          'span[class^="mpunct"]',
          'span[class^="minner"]',
          'span[class^="mspace"]',
          'span[class^="sizing"]',
          'span[class^="reset-size"]',
          "div[class^='katex-block-wrapper']",

          // Custom components
          "div[data-component]",
          "span[data-component]",
        ],
        ALLOWED_ATTR: [
          "class",
          "id",
          "data-*",
          "href",
          "src",
          "alt",
          "title",
          "type",
          "value",
          "checked",
          "disabled",
          "style", // Limited style for math rendering
        ],
        ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
        RETURN_DOM: false,
        RETURN_DOM_FRAGMENT: false,
        RETURN_TRUSTED_TYPE: false,
      });
      return typeof out === "string" ? out : String(out);
    },
    createScript: (input: string) => input,
    createScriptURL: (input: string) => input,
  });
}

/**
 * Create trusted HTML using DOMPurify and Trusted Types
 */
export function createTrustedHTML(html: string): string {
  // Initialize policy if not already done
  initializeTrustedTypesPolicy();

  if (trustedTypesPolicy) {
    return trustedTypesPolicy.createHTML(html);
  }

  // Fallback to DOMPurify without Trusted Types
  return sanitizeHTML(html);
}

/**
 * Sanitize HTML content for safe rendering
 */
export function sanitizeHTML(html: string): string {
  const out = resolveDOMPurify().sanitize(html, getSanitizationConfig());
  return typeof out === "string" ? out : String(out);
}

/**
 * Get DOMPurify configuration
 */
function getSanitizationConfig(): DOMPurifyConfig {
  return {
    ALLOWED_TAGS: [
      // Standard HTML elements
      "div",
      "span",
      "p",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "u",
      "s",
      "del",
      "ins",
      "blockquote",
      "pre",
      "code",
      "sub",
      "sup",
      "kbd",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "th",
      "td",
      "a",
      "img",

      // Code highlighting (Shiki/Prism classes)
      "span",
      "div",

      // Math rendering (KaTeX)
      "annotation",
      "semantics",
      "mtext",
      "mn",
      "mo",
      "mi",
      "mspace",
      "mrow",
      "mfrac",
      "msup",
      "msub",
      "msubsup",
      "munder",
      "mover",
      "munderover",
      "msqrt",
      "mroot",
      "mtable",
      "mtr",
      "mtd",

      // Custom extension points
      "section",
      "article",
      "aside",
      "nav",
      "header",
      "footer",
      "main",
    ],

    ALLOWED_ATTR: [
      "class",
      "id",
      "data-*",
      "href",
      "src",
      "alt",
      "title",
      "width",
      "height",
      "type",
      "value",
      "placeholder",
      "disabled",
      "readonly",
      "role",
      "aria-*",
      "style", // Limited for math/highlighting
      "target",
      "rel",
    ],

    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,

    // Remove scripts and potentially dangerous content
    FORBID_TAGS: ["script", "object", "embed", "form", "input", "button"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],

    // Keep data attributes for component identification
    KEEP_CONTENT: true,

    // Return configuration
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    RETURN_TRUSTED_TYPE: false,

    // Additional security
    SANITIZE_DOM: true,
    WHOLE_DOCUMENT: false,

    // Hook for custom processing
    SANITIZE_NAMED_PROPS: true,

    // Custom hooks
    CUSTOM_ELEMENT_HANDLING: {
      tagNameCheck: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
      attributeNameCheck: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
      allowCustomizedBuiltInElements: false,
    },
  };
}

/**
 * Sanitization policy for different content types
 */
export interface SanitizationPolicy {
  allowMath: boolean;
  allowSyntaxHighlighting: boolean;
  allowCustomComponents: boolean;
  allowInlineStyles: boolean;
  allowExternalLinks: boolean;
  customTags?: string[];
  customAttributes?: string[];
}

/**
 * Create custom sanitization config based on policy
 */
export function createSanitizationConfig(policy: SanitizationPolicy): DOMPurifyConfig {
  const baseConfig = getSanitizationConfig();

  // Extend allowed tags based on policy
  const allowedTags = [...(baseConfig.ALLOWED_TAGS || [])];
  const allowedAttr = [...(baseConfig.ALLOWED_ATTR || [])];

  if (!policy.allowMath) {
    // Remove math-related tags
    const mathTags = ["annotation", "semantics", "mtext", "mn", "mo", "mi", "mspace"];
    allowedTags.splice(0, allowedTags.length, ...allowedTags.filter((tag) => !mathTags.includes(tag)));
  }

  if (!policy.allowSyntaxHighlighting) {
    const classIndex = allowedAttr.indexOf("class");
    if (classIndex > -1) {
      allowedAttr.splice(classIndex, 1);
    }
  }

  if (!policy.allowInlineStyles) {
    // Remove style attribute
    const styleIndex = allowedAttr.indexOf("style");
    if (styleIndex > -1) {
      allowedAttr.splice(styleIndex, 1);
    }
  }

  if (!policy.allowExternalLinks) {
    // Restrict URI pattern to relative links only
    baseConfig.ALLOWED_URI_REGEXP = /^(?:[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
  }

  // Add custom tags and attributes
  if (policy.customTags) {
    allowedTags.push(...policy.customTags);
  }

  if (policy.customAttributes) {
    allowedAttr.push(...policy.customAttributes);
  }

  return {
    ...baseConfig,
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttr,
  };
}

/**
 * Sanitize code block HTML from syntax highlighters.
 *
 * Node/SSR consumers have no DOM `window`, so they reuse the shared DOM-free
 * code-row pipeline instead of DOMPurify. Both paths apply the same allowlist
 * (`CODE_ROW_ALLOWED_TAGS`/`CODE_ROW_ALLOWED_ATTRS`) and the same CSS filter.
 */
export function sanitizeCodeHTML(html: string): string {
  if (typeof window === "undefined") {
    return sanitizeCodeHtmlInWorker(html);
  }
  const out = resolveCodeRowPurifier().sanitize(html);
  return typeof out === "string" ? out : String(out);
}

let codeRowPurifier: DOMPurify | null = null;
let codeRowPurifierWindow: Window | null = null;

/**
 * Code rows are sanitized once per highlighted line, so they get a dedicated
 * DOMPurify instance with a persistent config (`setConfig` skips per-call
 * config parsing) and the shared style policy applied as an attribute hook
 * (no second parse of the sanitized output). Rebinds when `window` changes,
 * like `resolveDOMPurify`.
 */
function resolveCodeRowPurifier(): DOMPurify {
  if (codeRowPurifier && codeRowPurifierWindow === window) {
    return codeRowPurifier;
  }
  if (typeof createDOMPurify !== "function") {
    throw new Error("[markdown-v2] DOMPurify could not bind to the available DOM `window` to sanitize code HTML.");
  }
  const purifier = createDOMPurify(window);
  purifier.setConfig({
    ALLOWED_TAGS: [...CODE_ROW_ALLOWED_TAGS],
    ALLOWED_ATTR: [...CODE_ROW_ALLOWED_ATTRS],
    // Mirror the declared allowlist exactly: DOMPurify would otherwise keep
    // `aria-*` by default and widen the code-row contract.
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: true,
    KEEP_CONTENT: true,
    RETURN_DOM: false,
  });
  // DOMPurify keeps style values verbatim; drop styles failing the shared
  // code-row policy so the browser path drops exactly what the DOM-free path drops.
  purifier.addHook("uponSanitizeAttribute", (_node, event) => {
    if (event.attrName === "style" && !isSafeCodeRowStyle(event.attrValue)) {
      event.keepAttr = false;
    }
  });
  codeRowPurifier = purifier;
  codeRowPurifierWindow = window;
  return purifier;
}

/**
 * Sanitize math HTML from KaTeX
 */
export function sanitizeMathHTML(html: string): string {
  const out = resolveDOMPurify().sanitize(html, {
    ALLOWED_TAGS: [
      "span",
      "div",
      "br",
      // KaTeX specific tags
      "annotation",
      "semantics",
      "mtext",
      "mn",
      "mo",
      "mi",
      "mspace",
      "mrow",
      "mfrac",
      "msup",
      "msub",
      "msubsup",
      "munder",
      "mover",
      "munderover",
      "msqrt",
      "mroot",
      "mtable",
      "mtr",
      "mtd",
    ],
    ALLOWED_ATTR: ["class", "style", "data-*"],
    KEEP_CONTENT: true,
    RETURN_DOM: false,
  });
  return typeof out === "string" ? out : String(out);
}

export type UrlTransformContext = {
  source: "markdown" | "html";
};

export type UrlTransform = (
  url: string,
  attribute: "href" | "src",
  context: UrlTransformContext,
) => string | null | undefined;

const DATA_IMAGE_PATTERN = /^data:image\/(?:png|gif|jpeg|webp|avif)(?:;[^,]*)?,/i;

/**
 * Validate and transform URLs for rendering and navigation.
 * Strips ASCII control/whitespace for scheme detection, case-insensitive.
 * Rejects javascript:, vbscript:, file:, and data: (except data:image/(png|gif|jpeg|webp|avif) for src).
 * Relative URLs, fragments, and arbitrary other schemes pass.
 */
export function defaultUrlTransform(
  url: string,
  attribute: "href" | "src" = "href",
  _context?: UrlTransformContext,
): string | null {
  if (typeof url !== "string") return null;
  const decoded = url.includes("&") ? decodeHTML5Strict(url) : url;
  const normalized = decoded.replace(/[\x00-\x20\x7f]/g, "").toLowerCase();

  if (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("file:")
  ) {
    return null;
  }

  if (normalized.startsWith("data:")) {
    if (attribute === "src" && DATA_IMAGE_PATTERN.test(normalized)) {
      return url;
    }
    return null;
  }

  return url;
}

/**
 * Content Security Policy utilities
 */
export const CSP_HEADERS = {
  // Strict CSP for markdown rendering
  strict: [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Required for KaTeX
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "require-trusted-types-for 'script'",
    "trusted-types markdown-renderer-v2",
  ].join("; "),

  // Relaxed CSP for development
  development: [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' ws:",
    "font-src 'self' data:",
  ].join("; "),
};

/**
 * Initialize security features
 */
export function initializeSecurity(): void {
  // Initialize Trusted Types
  initializeTrustedTypesPolicy();

  // Set up DOMPurify hooks if needed
  try {
    const purifier = resolveDOMPurify();
    if (typeof purifier.addHook !== "function") {
      return;
    }

    purifier.addHook("beforeSanitizeElements", (node: unknown) => node);
    purifier.addHook("afterSanitizeElements", (node: unknown) => node);
  } catch {
    // ignore missing DOM environment
  }
}
