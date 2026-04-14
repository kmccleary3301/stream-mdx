# Math V2A Left/Right Null-Right

Inline candidate:

$$
\left( x + y<!--split-->
\right)
$$

Target V2A behavior:
- classify as `left-right-local`
- remain tail-local
- candidate may close with `\right.` only when policy allows it
- no environment or alignment inference

Trailing prose must remain visible after the supported left-right case.

Final paragraph after the left-right supported case.
