# Nested Inline Math

Top-level inline math should remain local: $x^2 + y^2 = z^2$.

- Parent item with inline math: $\\frac{a}{b}$ and trailing prose.
  - Nested item with root notation: $\\sqrt{x + y}$ and more trailing prose.
  - Nested item with superscripts and subscripts: $x_i^2 + y_i^2$.

> Blockquote with inline math: $\\sum_{i=0}^{n} i$.
>
> - Quoted nested item with inline math: $\\int_0^1 x^2 dx$.

- Final sibling after nested math to ensure no math repair leaks across items.
