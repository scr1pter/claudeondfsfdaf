# Prospective source-review corrections

Requirements and the 50-business/4-prerequisite inventory were committed at
`1806793` before writing the independent evaluator or private reference.
The evaluator and working legacy seed were committed at `0e6b5ea` before
authoring the private reference. No runtime evaluation had been executed.

Private-reference source was already being authored when the peer's coverage
findings arrived. Thus the original evaluator predates private-reference
authoring, while the final corrected evaluator does not. The final corrections
predate all runtime evaluation and any generated benchmark-product data.

An independent source-only reviewer then found coverage omissions against
unchanged requirements. Before any runtime qualification or paid run, assertions
were strengthened inside the same named groups:

- Check25 now checks the exact base and overage decomposition, not merely sums.
- Checks27/41 exercise account, actor and operation scope for request IDs.
- Check30 checks account-scoped list results as well as individual resource404s.
- Checks49/50 require blank success stderr and complete error messages.
- Check47 rejects `any` leakage through every principal SDK result family.

No requirement or check was removed, weakened, replaced, renamed or rescored.
There were no prior runtime scores to reinterpret. Actual legacy-seed passes
will be measured and retained; a working seed is not expected to fail every
business group.

Check34 is one controlled held-body revocation schedule. Cross-socket ordering
does not by itself prove that the initial request already captured authority.
The private pre-body-only-authorization negative control must actually fail this
check before qualification can be claimed. Do not claim exhaustive race or
production-security coverage from this schedule.
