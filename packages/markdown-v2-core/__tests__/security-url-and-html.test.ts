import assert from "node:assert/strict";
import {
  createProtocolPolicyUrlTransform,
  defaultUrlTransform,
  InlineParser,
  isForbiddenAttribute,
  sanitizeHtmlInWorker,
  sanitizeHtmlTreeInWorker,
  sanitizeStyle,
} from "../src";

// 1. defaultUrlTransform tests
// Dangerous schemes rejected
assert.equal(defaultUrlTransform("javascript:alert(1)", "href"), null);
assert.equal(defaultUrlTransform("JAVASCRIPT:alert(1)", "href"), null);
assert.equal(defaultUrlTransform("  javascript:alert(1)", "href"), null);
assert.equal(defaultUrlTransform("java\x00script:alert(1)", "href"), null);
assert.equal(defaultUrlTransform("java\tscript:alert(1)", "href"), null);
assert.equal(defaultUrlTransform("java\r\nscript:alert(1)", "href"), null);
assert.equal(defaultUrlTransform("jav&#x09;ascript:alert(1)", "href"), null);
assert.equal(defaultUrlTransform("vbscript:msgbox(1)", "href"), null);
assert.equal(defaultUrlTransform("VBSCRIPT:msgbox(1)", "href"), null);
assert.equal(defaultUrlTransform("file:///etc/passwd", "href"), null);
assert.equal(defaultUrlTransform("file:///etc/passwd", "src"), null);

// Data URLs
assert.equal(defaultUrlTransform("data:text/html,<script>alert(1)</script>", "href"), null);
assert.equal(defaultUrlTransform("data:text/html,<script>alert(1)</script>", "src"), null);
assert.equal(defaultUrlTransform("data:image/svg+xml,<svg></svg>", "src"), null);
assert.equal(defaultUrlTransform("data:image/png;base64,iVBORw==", "href"), null);
assert.equal(
  defaultUrlTransform("data:image/png;base64,iVBORw==", "src"),
  "data:image/png;base64,iVBORw==",
);
assert.equal(
  defaultUrlTransform("data:image/jpeg;base64,/9j/4AAQ==", "src"),
  "data:image/jpeg;base64,/9j/4AAQ==",
);
assert.equal(
  defaultUrlTransform("data:image/gif;base64,R0lGOD==", "src"),
  "data:image/gif;base64,R0lGOD==",
);
assert.equal(
  defaultUrlTransform("data:image/webp;base64,UklGR==", "src"),
  "data:image/webp;base64,UklGR==",
);
assert.equal(
  defaultUrlTransform("data:image/avif;base64,AAAA==", "src"),
  "data:image/avif;base64,AAAA==",
);

// Safe schemes and paths pass
assert.equal(defaultUrlTransform("https://example.com/path?q=1#frag"), "https://example.com/path?q=1#frag");
assert.equal(defaultUrlTransform("http://example.com"), "http://example.com");
assert.equal(defaultUrlTransform("mailto:test@example.com"), "mailto:test@example.com");
assert.equal(defaultUrlTransform("tel:+1234567890"), "tel:+1234567890");
assert.equal(defaultUrlTransform("/relative/path"), "/relative/path");
assert.equal(defaultUrlTransform("./relative"), "./relative");
assert.equal(defaultUrlTransform("../parent"), "../parent");
assert.equal(defaultUrlTransform("#heading"), "#heading");
assert.equal(defaultUrlTransform("made-up-scheme:payload"), "made-up-scheme:payload");
assert.equal(defaultUrlTransform("custom+scheme://test"), "custom+scheme://test");

// 2. Forbidden attributes: on*, srcdoc, script
assert.ok(isForbiddenAttribute("onclick"));
assert.ok(isForbiddenAttribute("ONCLICK"));
assert.ok(isForbiddenAttribute("onload"));
assert.ok(isForbiddenAttribute("onerror"));
assert.ok(isForbiddenAttribute("srcdoc"));
assert.ok(isForbiddenAttribute("SRCDOC"));
assert.ok(isForbiddenAttribute("script"));
assert.ok(!isForbiddenAttribute("href"));
assert.ok(!isForbiddenAttribute("src"));
assert.ok(!isForbiddenAttribute("class"));

const sanitizedHtml = sanitizeHtmlInWorker(
  '<iframe src="https://example.com" srcdoc="<script>alert(1)</script>"></iframe><button onclick="bad()">Click</button><script>alert(1)</script>',
  {
    allowedTags: {
      iframe: ["src", "srcdoc"],
      button: ["onclick"],
      script: ["src"],
    },
  },
);

assert.ok(!sanitizedHtml.includes("srcdoc"), "srcdoc must be stripped");
assert.ok(!sanitizedHtml.includes("onclick"), "onclick must be stripped");
assert.ok(!sanitizedHtml.includes("<script"), "script tag must never survive");
assert.ok(sanitizedHtml.includes('src="https://example.com"'), "safe src on iframe survives");

// 3. Style policy: position/url() dropped, color survives
const rawStyle = "position: absolute; color: red; background: url('https://evil.test'); font-weight: bold";
const cleanedStyle = sanitizeStyle(rawStyle);
assert.ok(cleanedStyle.includes("color: red"), "color survives");
assert.ok(cleanedStyle.includes("font-weight: bold"), "font-weight survives");
assert.ok(!cleanedStyle.includes("position"), "position dropped");
assert.ok(!cleanedStyle.includes("url("), "url() dropped");

const htmlWithStyle = sanitizeHtmlInWorker('<span style="position: fixed; color: blue;">Hello</span>');
assert.ok(htmlWithStyle.includes('style="color: blue"'), "sanitized HTML style keeps color and drops position");
assert.ok(!htmlWithStyle.includes("position"), "sanitized HTML style drops position");

const protocolPolicy = createProtocolPolicyUrlTransform({
  href: ["file", "t3-citation", "t3-context", "t3-thread", "https"],
  src: ["file", "t3-context"],
});
assert.equal(protocolPolicy("file:///tmp/image.png", "href", { source: "markdown" }), "file:///tmp/image.png");
assert.equal(protocolPolicy("t3-citation://v1/item", "href", { source: "markdown" }), "t3-citation://v1/item");
assert.equal(protocolPolicy("t3-context://v1/image", "src", { source: "markdown" }), "t3-context://v1/image");
assert.equal(protocolPolicy("", "href", { source: "markdown" }), null);
assert.equal(protocolPolicy("mailto:user@example.com", "href", { source: "markdown" }), null);
assert.equal(protocolPolicy("javascript:alert(1)", "href", { source: "markdown" }), null);
assert.equal(protocolPolicy("data:image/svg+xml,<svg/>", "src", { source: "html" }), null);

const policyHtml = sanitizeHtmlInWorker(
  '<div title="strip" data-safe="yes"><img src="file:///tmp/image.png" title="image metadata" width="30" height="40" onerror="bad()" srcdoc="bad"><a href="t3-thread://v1/1">thread</a><a href="javascript:bad()">unsafe</a><script>script text</script><style>style text</style></div>',
  {
    sanitization: {
      tagNames: ["div", "img", "a", "script", "style"],
      attributes: {
        "*": ["title", "data-safe"],
        img: ["src", "title", "width", "height"],
        a: ["href"],
      },
      protocols: {
        href: ["file", "t3-citation", "t3-context", "t3-thread", "https"],
        src: ["file", "t3-context"],
      },
      stripAttributes: ["title"],
    },
  },
);
assert.ok(policyHtml.includes('data-safe="yes"'));
assert.ok(policyHtml.includes('src="file:///tmp/image.png"'));
assert.ok(policyHtml.includes('data-markdown-title="image metadata"'));
assert.ok(policyHtml.includes('width="30"') && policyHtml.includes('height="40"'));
assert.ok(policyHtml.includes('href="t3-thread://v1/1"'));
assert.ok(!/(?:\s|<)title="/.test(policyHtml));
assert.ok(!policyHtml.includes("onerror") && !policyHtml.includes("srcdoc"));
assert.ok(!policyHtml.includes("javascript:") && !policyHtml.includes("script text") && !policyHtml.includes("style text"));

const literalOptions = { mode: "literal" as const };
const literalInline = new InlineParser({ html: literalOptions }).parse(
  "Before <span>**inside**</span> and **outside**",
);
assert.ok(literalInline.some((node) => node.kind === "text" && node.text.includes("<span>**inside**</span>")));
assert.ok(literalInline.some((node) => node.kind === "strong" && node.children.some((child) => child.kind === "text" && child.text === "outside")));
assert.deepEqual(sanitizeHtmlTreeInWorker("<div>authored <b>markup</b></div>", literalOptions), [
  { kind: "text", text: "<div>authored <b>markup</b></div>" },
]);
assert.equal(sanitizeHtmlInWorker("<div>authored</div>", literalOptions), "&lt;div&gt;authored&lt;/div&gt;");

const bareAnchorInline = new InlineParser({ html: { unmatchedAnchors: "literal-bare" } }).parse(
  "Before <A> after **bold**",
);
assert.ok(bareAnchorInline.some((node) => node.kind === "text" && node.text.includes("<A>")));
assert.ok(bareAnchorInline.some((node) => node.kind === "strong"));
assert.deepEqual(
  sanitizeHtmlTreeInWorker("<a>unmatched", { unmatchedAnchors: "literal-bare" }),
  [{ kind: "text", text: "<a>unmatched" }],
);
assert.ok(sanitizeHtmlTreeInWorker("<a>paired</a>", { unmatchedAnchors: "literal-bare" })
  .some((node) => node.kind === "element" && node.tagName === "a"));

console.log("Core security URL, forbidden attribute, and style tests passed.");
