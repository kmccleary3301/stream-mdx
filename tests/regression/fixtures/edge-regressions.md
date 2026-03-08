# Regression Edge Cases

## Long inline code span

The inline code span below should render as <code>inline</code> content:
`this is a really really really really really really really really really really really really really really really really really really really really really long inline code span`

## Block math should render

Inline lead-in with whitespace around the delimiters:
$$ E = mc^2 $$

Inline with trailing text:
Its entries are given by: $$ \mathbf{J}_f(\mathbf{x}) = \begin{bmatrix} \frac{\partial f_1}{\partial x_1} & \frac{\partial f_1}{\partial x_2} \end{bmatrix} $$ where $f_i$ is the ith component.

## List gap handling

1. First item
2. Second item

3. Third item

## Inline code inside list items

1. `this is a really really really really really really really really really really really really really really really really really really really really really long inline code span`
2. Normal list item
