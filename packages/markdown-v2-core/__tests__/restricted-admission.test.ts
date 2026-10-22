import assert from "node:assert";
import { describe, it } from "node:test";
import { isRestrictedComponentName, parseRestrictedTag } from "../src/admission";

describe("Strict Restricted Prop Lexer & Admission", () => {
  it("parses valid self-closing and opening component tags with boolean and string props", () => {
    const selfClosing = parseRestrictedTag('<Input placeholder="Search items..." disabled />');
    assert.strictEqual(selfClosing.ok, true);
    if (selfClosing.ok && selfClosing.kind === "self-closing") {
      assert.strictEqual(selfClosing.tagName, "Input");
      assert.strictEqual(selfClosing.props.placeholder, "Search items...");
      assert.strictEqual(selfClosing.props.disabled, true);
      assert.strictEqual(Object.isFrozen(selfClosing.props), true);
    }

    const openTag = parseRestrictedTag('<Card title="Overview" variant=\'primary\'>');
    assert.strictEqual(openTag.ok, true);
    if (openTag.ok && openTag.kind === "open") {
      assert.strictEqual(openTag.tagName, "Card");
      assert.strictEqual(openTag.props.title, "Overview");
      assert.strictEqual(openTag.props.variant, "primary");
      assert.strictEqual(Object.isFrozen(openTag.props), true);
    }
  });

  it("parses strict JSON props and recursively freezes their values", () => {
    const tag = parseRestrictedTag('<Metric count={42} ratio={3.14} active={true} items={[1, 2, 3]} meta={{"tier": "prod", "nested": {"source": "json"}}} />');
    assert.strictEqual(tag.ok, true);
    if (tag.ok && tag.kind === "self-closing") {
      assert.strictEqual(tag.props.count, 42);
      assert.strictEqual(tag.props.ratio, 3.14);
      assert.strictEqual(tag.props.active, true);
      assert.deepStrictEqual(tag.props.items, [1, 2, 3]);
      assert.strictEqual(Object.isFrozen(tag.props.items), true);
      assert.deepStrictEqual(tag.props.meta, { tier: "prod", nested: { source: "json" } });
      const meta = tag.props.meta;
      assert.ok(meta && typeof meta === "object" && "nested" in meta);
      assert.strictEqual(Object.isFrozen(meta), true);
      assert.strictEqual(Object.isFrozen(meta.nested), true);
    }
  });

  it("strictly rejects top-level unsafe attribute keys before assignment without prototype mutation", () => {
    const protoAttr = parseRestrictedTag('<Card __proto__="polluted" />');
    assert.strictEqual(protoAttr.ok, false);

    const ctorAttr = parseRestrictedTag('<Card constructor="polluted" />');
    assert.strictEqual(ctorAttr.ok, false);

    const protoProp = parseRestrictedTag('<Card prototype="polluted" />');
    assert.strictEqual(protoProp.ok, false);

    // Verify global Object.prototype was not polluted
    assert.strictEqual(Object.prototype.hasOwnProperty("polluted"), false);
  });

  it("strictly rejects reserved props: ref, key, on*, and dangerouslySetInnerHTML", () => {
    const refTag = parseRestrictedTag('<Card ref="myRef" />');
    assert.strictEqual(refTag.ok, false);

    const keyTag = parseRestrictedTag('<Card key="k1" />');
    assert.strictEqual(keyTag.ok, false);

    const onClickTag = parseRestrictedTag('<Button onClick={() => {}} />');
    assert.strictEqual(onClickTag.ok, false);

    const dangerouslyTag = parseRestrictedTag('<Card dangerouslySetInnerHTML={{ __html: "bad" }} />');
    assert.strictEqual(dangerouslyTag.ok, false);
  });

  it("recursively rejects unsafe JSON keys inside objects and arrays", () => {
    const unsafeJson = parseRestrictedTag('<Card data={{"nested": {"__proto__": "bad"}}} />');
    assert.strictEqual(unsafeJson.ok, false);

    const unsafeArray = parseRestrictedTag('<Card list={[{"constructor": "bad"}]} />');
    assert.strictEqual(unsafeArray.ok, false);
  });

  it("strictly rejects spreads and import/export statements", () => {
    const spreadTag = parseRestrictedTag("<Card {...props} />");
    assert.strictEqual(spreadTag.ok, false);

    const importTag = parseRestrictedTag('<Card meta={import "bad"} />');
    assert.strictEqual(importTag.ok, false);
  });

  it("preserves literal quoted strings and strict-JSON escape semantics", () => {
    const pathTag = parseRestrictedTag('<FileViewer path="C:\\tools\\app" />');
    assert.strictEqual(pathTag.ok, true);
    if (pathTag.ok && pathTag.kind === "self-closing") {
      assert.strictEqual(pathTag.props.path, "C:\\tools\\app");
    }

    const jsonPathTag = parseRestrictedTag('<FileViewer path={"C:\\\\tools\\\\app"} />');
    assert.strictEqual(jsonPathTag.ok, true);
    if (jsonPathTag.ok && jsonPathTag.kind === "self-closing") {
      assert.strictEqual(jsonPathTag.props.path, "C:\\tools\\app");
    }

    const entityTag = parseRestrictedTag('<Label text="&quot;Hello&quot; &amp; &lt;World&gt; &copy; &#0; &#1114112;" />');
    assert.strictEqual(entityTag.ok, true);
    if (entityTag.ok && entityTag.kind === "self-closing") {
      assert.strictEqual(entityTag.props.text, '"Hello" & <World> © \uFFFD \uFFFD');
    }
  });

  it("distinguishes incomplete tag headers from invalid ones", () => {
    const unclosedHeader = parseRestrictedTag('<Card title="Incomplete');
    assert.strictEqual(unclosedHeader.ok, false);
    if (!unclosedHeader.ok) {
      assert.strictEqual(unclosedHeader.incomplete, true);
    }

    const invalidHeader = parseRestrictedTag("<Card 12345>");
    assert.strictEqual(invalidHeader.ok, false);
    if (!invalidHeader.ok) {
      assert.strictEqual(invalidHeader.incomplete, false);
    }
  });

  it("validates case-sensitive component names vs HTML lowercase tags", () => {
    assert.strictEqual(isRestrictedComponentName("Input"), true);
    assert.strictEqual(isRestrictedComponentName("Link"), true);
    assert.strictEqual(isRestrictedComponentName("input"), false);
    assert.strictEqual(isRestrictedComponentName("link"), false);
    assert.strictEqual(isRestrictedComponentName("div"), false);

    const lowercaseClose = parseRestrictedTag("</card>");
    assert.strictEqual(lowercaseClose.ok, false);

    const uppercaseClose = parseRestrictedTag("</Card>");
    assert.strictEqual(uppercaseClose.ok, true);
    if (uppercaseClose.ok) {
      assert.strictEqual(uppercaseClose.kind, "close");
      assert.strictEqual(uppercaseClose.tagName, "Card");
    }
  });
});
