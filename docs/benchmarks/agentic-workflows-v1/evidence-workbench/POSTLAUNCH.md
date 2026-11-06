# POSTLAUNCH instrument correction

The original `aw3` Codex attempt used task SHA
`0090ff679a4989b34b59ea51c5910794c322dc7805fffadc203e0da083523920` from commit
`6d0e60da5d69cea4da6b7289e8d577577dafa6ec`. Its CLI exited normally; the original
gate reported 25 passed and 1 failed check, with unchanged source. The failed
`browser.import` assertion said the validation error was not visible. The original
31 receipts and $0.7953841 charge remain recorded; no paid repair was performed.

A free, unchanged-source reproduction returned the same result. A fresh owned
Chrome context, behind the strict loopback proxy, then submitted the same invalid
batch. The API returned HTTP 400 `invalid_batch` with message
`Source must be a nonblank string.` The UI preserved the input and displayed this
visible status:

> Batch import failed: Source must be a nonblank string.

The frozen matcher accepted only `invalid|error|required|missing`. It rejected
that useful validation message because “failed” and ordinary constraint phrasing
were absent from its vocabulary. The public task does not prescribe those words.
This is an instrument false negative; it does not establish a product defect.

Only the external evaluator was changed. It now accepts ordinary failure and
constraint phrasing, requires a visible message newly reported for the invalid
submission, and rejects stale success, preexisting errors, hidden messages,
negated errors, and empty text. Positive and negative Node controls cover those
cases. All 27 Python and 9 Node controls pass. The same unchanged app then passed
all 26 checks in the corrected free gate, with no instrument errors and no source
mutation. No model call, app edit, controller change, cloud connection, user browser,
or shared dependency write was used in this investigation.

The evaluator also now captures desktop `browser-final.png` (1200×850) and mobile
`browser-mobile.png` (390×844) at that same final app state, without extra app
assertions or focus changes, then restores the viewport. Reports include only
safe relative image names. A final free gate after this artifact addition again
passed the same 26 checks with unchanged source and no instrument errors. Both
images were verified; the preceding corrected free report is retained separately.

The correction followed inspection of a paid artifact. It is an explicit
**POSTLAUNCH** instrument revision, not a silent rewrite or preregistered pass for
the original case. Original paid/free reports, charges, source manifests, direct
status capture, and screenshots are retained privately. `FREEZE_HISTORY.json`
preserves both earlier task freezes and their source manifests;
`postlaunch-validation.json` supplies artifact hashes and the source identity.

One additional diagnostic command used a placeholder app path and was rejected
before Bun/build with 26 unexecuted checks. Its instrument-failure report is also
retained, separately from the valid reproduction and experiment evidence.

The current revision requires a separately coordinated study admission and new
task hash before another paid case. The passing free rerun validates this concrete
correction on one actual app; it does not prove that every correct implementation
passes every evaluator check.
