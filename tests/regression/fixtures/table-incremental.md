# Table Incremental

| Column A | Column B | Column C |
| --- | --- | --- |
| Alpha | Beta | Gamma |
| Delta | Epsilon | Zeta |
| Eta | Theta | Iota |
| Kappa | Lambda | Mu |
| Nu | Xi | Omicron |
| Pi | Rho | Sigma |

This paragraph exists to keep the table early in the document so we can assert that
the table appears during streaming, not only after the entire document completes.
We want to see the table element materialize before the final checkpoint.

Additional filler text continues here to extend the document length. The goal is to
ensure the table is fully described before roughly one quarter of the stream has
been appended so that the regression harness can verify incremental visibility.
