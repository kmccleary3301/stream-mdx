# Restricted native component streaming

<Card label="open-stage" count={17} enabled>

**Native bold child: p9-open-native-strong**

P9_T2_OPEN_CARD_STAGE This authored body is intentionally staged across many deterministic producer chunks so the registered host can be observed as open before its real closing tag arrives.

The still-open component continues through this authored line and the following one, preserving streamed native Markdown children without finalizing the enclosing tag.

This is the final open-stage body line before the actual Card closer.
</Card>

<ClosedCard label="closed-stage" count={23} enabled>

**Closed-only native child: p9-closed-native-strong**

P9_T2_CLOSED_CARD_STAGE This authored body keeps the closed-only registration open long enough to observe that its host is withheld until the real closing tag.

A second body line remains inside the same open component before its closer arrives.

This is the final closed-stage body line before the actual ClosedCard closer.
</ClosedCard>

<UnknownWidget label="unknown-authored-source" />

<Card 12345>

{globalThis.__streammdxP9T2Effects.push("brace-expression")}

<Card label={globalThis.__streammdxP9T2Effects.push("attribute-expression")} count={7} enabled />

{Function("return globalThis.__streammdxP9T2Effects.push('function-constructor')")()}

{eval("globalThis.__streammdxP9T2Effects.push('eval-call')")}

```artifact
<script>globalThis.__streammdxP9T2Effects.push("artifact-script")</script>
<Card label={globalThis.__streammdxP9T2Effects.push("artifact-component")} count={1} enabled />
{Function("return globalThis.__streammdxP9T2Effects.push('artifact-constructor')")()}
```

```html-artifact
<script>globalThis.__streammdxP9T2Effects.push("html-artifact-script")</script>
<iframe srcdoc="<script>globalThis.__streammdxP9T2Effects.push('html-artifact-frame')</script>"></iframe>
<Card label={globalThis.__streammdxP9T2Effects.push("html-artifact-component")} count={1} enabled />
{eval("globalThis.__streammdxP9T2Effects.push('html-artifact-eval')")}
```

<Card label="eof-incomplete" count={99} enabled>

**Native bold child: p9-incomplete-native-strong**

P9_T2_EOF_INCOMPLETE This final valid Card intentionally has no closing tag and must retain its incomplete status and diagnostic at source EOF.
