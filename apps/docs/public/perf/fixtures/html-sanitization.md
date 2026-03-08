# HTML Sanitization

Normal inline HTML should render:

<kbd>Ctrl</kbd> + <kbd>K</kbd>

Disallowed HTML should be removed or escaped:

<script>alert("xss")</script>

<img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" onerror="alert('xss')" />

<a href="https://example.com" onclick="alert('xss')">safe link</a>

<div data-unsafe="true">Styled div</div>
