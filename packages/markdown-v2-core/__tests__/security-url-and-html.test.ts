import assert from "node:assert/strict";
import {
  defaultUrlTransform,
  isForbiddenAttribute,
  sanitizeHtmlInWorker,
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

console.log("Core security URL, forbidden attribute, and style tests passed.");
