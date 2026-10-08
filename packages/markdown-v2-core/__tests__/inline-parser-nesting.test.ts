import assert from "node:assert";
import { InlineParser } from "../src/inline-parser";

async function main() {
  const parser = new InlineParser({ maxCacheEntries: 0 });

  // 1. Nested emphasis and strong emphasis
  {
    const nodes = parser.parse("**bold *ital* bold**", { cache: false });
    assert.deepStrictEqual(nodes, [
      {
        kind: "strong",
        children: [
          { kind: "text", text: "bold " },
          { kind: "em", children: [{ kind: "text", text: "ital" }] },
          { kind: "text", text: " bold" },
        ],
      },
    ]);
  }

  {
    const nodes = parser.parse("*a **b** c*", { cache: false });
    assert.deepStrictEqual(nodes, [
      {
        kind: "em",
        children: [
          { kind: "text", text: "a " },
          { kind: "strong", children: [{ kind: "text", text: "b" }] },
          { kind: "text", text: " c" },
        ],
      },
    ]);
  }

  {
    const nodes = parser.parse("***x***", { cache: false });
    // CommonMark parses ***x*** as em wrapping strong or vice versa
    assert.strictEqual(nodes.length, 1);
    const outer = nodes[0];
    assert.ok(outer && "children" in outer);
    assert.ok(outer.kind === "em" || outer.kind === "strong");
    const inner = outer.children[0];
    assert.ok(inner && "children" in inner);
    assert.ok(inner.kind === "em" || inner.kind === "strong");
    assert.deepStrictEqual(inner.children, [{ kind: "text", text: "x" }]);
  }

  {
    const nodes = parser.parse("a*b*c", { cache: false });
    assert.deepStrictEqual(nodes, [
      { kind: "text", text: "a" },
      { kind: "em", children: [{ kind: "text", text: "b" }] },
      { kind: "text", text: "c" },
    ]);
  }

  {
    const nodes = parser.parse("foo__bar__", { cache: false });
    assert.deepStrictEqual(nodes, [{ kind: "text", text: "foo__bar__" }]);
  }

  // 2. Links with code, nested formatting, angle-bracket destinations, titles
  {
    const nodes = parser.parse("[link with `code`](https://x.y)", { cache: false });
    assert.deepStrictEqual(nodes, [
      {
        kind: "link",
        href: "https://x.y",
        children: [
          { kind: "text", text: "link with " },
          { kind: "code", text: "code" },
        ],
      },
    ]);
  }

  {
    const nodes = parser.parse("[**bold link**](https://x.y)", { cache: false });
    assert.deepStrictEqual(nodes, [
      {
        kind: "link",
        href: "https://x.y",
        children: [
          {
            kind: "strong",
            children: [{ kind: "text", text: "bold link" }],
          },
        ],
      },
    ]);
  }

  {
    const nodes = parser.parse("[a](<b c>)", { cache: false });
    assert.deepStrictEqual(nodes, [
      {
        kind: "link",
        href: "b%20c",
        children: [{ kind: "text", text: "a" }],
      },
    ]);
  }

  {
    const nodes = parser.parse('[link](https://x.y "my title")', { cache: false });
    assert.deepStrictEqual(nodes, [
      {
        kind: "link",
        href: "https://x.y",
        title: "my title",
        children: [{ kind: "text", text: "link" }],
      },
    ]);
  }

  // 3. Link references (defined vs undefined)
  {
    const refParser = new InlineParser({
      maxCacheEntries: 0,
      references: new Map([
        ["bar", { href: "https://bar.com", title: "Bar Title" }],
        ["shortcut", { href: "https://shortcut.com" }],
      ]),
    });

    const definedRef = refParser.parse("[foo][bar]", { cache: false });
    assert.deepStrictEqual(definedRef, [
      {
        kind: "link",
        href: "https://bar.com",
        title: "Bar Title",
        children: [{ kind: "text", text: "foo" }],
      },
    ]);

    const shortcutRef = refParser.parse("[shortcut]", { cache: false });
    assert.deepStrictEqual(shortcutRef, [
      {
        kind: "link",
        href: "https://shortcut.com",
        children: [{ kind: "text", text: "shortcut" }],
      },
    ]);

    const undefinedRef = refParser.parse("[foo][missing]", { cache: false });
    assert.deepStrictEqual(undefinedRef, [{ kind: "text", text: "[foo][missing]" }]);

    const undefinedShortcut = refParser.parse("[missing]", { cache: false });
    assert.deepStrictEqual(undefinedShortcut, [{ kind: "text", text: "[missing]" }]);
  }

  // 4. Math protection from emphasis and escape mangling
  {
    const nodes = parser.parse("$a*b*c$", { cache: false });
    assert.deepStrictEqual(nodes, [{ kind: "math-inline", tex: "a*b*c" }]);
  }

  {
    const nodes = parser.parse("$$\n \\text{sum} = a * b \\\\\n$$", { cache: false });
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0].kind, "math-display");
    assert.ok(nodes[0].tex.includes("\\text{sum} = a * b \\\\"));
  }

  {
    const nodes = parser.parse("Before $\\alpha + \\beta$ after", { cache: false });
    assert.deepStrictEqual(nodes, [
      { kind: "text", text: "Before " },
      { kind: "math-inline", tex: "\\alpha + \\beta" },
      { kind: "text", text: " after" },
    ]);
  }

  // 5. Entities and backslash escapes
  {
    const nodes = parser.parse("&copy; &#35;", { cache: false });
    assert.deepStrictEqual(nodes, [{ kind: "text", text: "© #" }]);
  }

  {
    const nodes = parser.parse("\\*not em\\*", { cache: false });
    assert.deepStrictEqual(nodes, [{ kind: "text", text: "*not em*" }]);
  }

  {
    const nodes = parser.parse("`` ` a ` b ` ``", { cache: false });
    assert.deepStrictEqual(nodes, [{ kind: "code", text: "` a ` b `" }]);
  }

  // 6. Autolinks and GFM URLs
  {
    const nodes = parser.parse("<https://x.y>", { cache: false });
    assert.deepStrictEqual(nodes, [
      {
        kind: "link",
        href: "https://x.y",
        children: [{ kind: "text", text: "https://x.y" }],
      },
    ]);
  }

  {
    const nodes = parser.parse("www.example.com", { cache: false });
    assert.deepStrictEqual(nodes, [
      {
        kind: "link",
        href: "http://www.example.com",
        children: [{ kind: "text", text: "www.example.com" }],
      },
    ]);
  }

  // 7. Strikethrough
  {
    const nodes = parser.parse("~~s~~", { cache: false });
    assert.deepStrictEqual(nodes, [
      {
        kind: "strike",
        children: [{ kind: "text", text: "s" }],
      },
    ]);
  }

  // 8. Footnote references
  {
    const nodes = parser.parse("Text with a footnote.[^note-1]", { cache: false });
    assert.deepStrictEqual(nodes, [
      { kind: "text", text: "Text with a footnote." },
      { kind: "footnote-ref", label: "note-1" },
    ]);
  }

  console.log("Inline parser nesting and regression tests passed");
}

await main();
