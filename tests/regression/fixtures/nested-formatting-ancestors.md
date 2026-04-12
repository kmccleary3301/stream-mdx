# Nested Formatting Ancestors

Top-level *italic* and **bold** should behave the same as nested streaming text.

- Parent item with *italic emphasis that may stream before the closer arrives*
  - Child item with **strong formatting that may split mid-token**
  - Child item with `inline code that may stream before the closing tick`

> Blockquote line with *italic text that should stay local to the quote*
>
> - Quoted list item with **nested strong text**
> - Quoted list item with *nested italic text*

- Final item to ensure no earlier unfinished delimiter swallows later siblings.
