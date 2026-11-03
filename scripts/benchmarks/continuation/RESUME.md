# Retained heavy Codex tree

`codex_resume.py` is a closed continuation of the nine-call stopped Codex arm.
It lives outside the frozen matched instrument. Its default operation constructs
a reviewable plan using file reads, native SQLite `mode=ro`, and Git identity
checks. It does not read a controller capability or receipt ledger, launch a
native CLI, install dependencies, or start an application/browser.

Required planning arguments are `--original-plan`, `--old-run`, `--witness-root`,
`--expected-witness-revision`, `--expected-witness-manifest-sha`, `--out`, and
`--label`. The witness root is an explicitly selected clean repository root;
its matched-instrument manifest must have the supplied canonical SHA256. An
optional `--qualification` names the independently reviewed free proof below.
`--write-plan` writes the sanitized plan outside every source/evidence root.
The closed correction manifest is `31357229ddb010df9eb764aa3b8dee5a001eff7122b2b1ed2a08c84beaa736dd`.
Its proven code revision is `4cfa1db6c68c458d33afa954b2981e6259be43e5`.
An explicitly reviewed clean descendant revision is accepted only with those
exact same matched-instrument bytes; documentation-only descendant
`b86c3fbf4824d46b2203de5a09de61359cdc285b` satisfies that gate.

Before paid admission, `--archive-only --archive-out NEW_PRIVATE_DIRECTORY`
creates and roundtrip-verifies the actual retained home/app/support archive.
It requires the qualified native proof but reads no controller capability or
receipt ledger, invokes no model, and does not mutate the original state.
Use its printed manifest path as `--verified-archive FILE` when building the
final plan. Planning reauthenticates both archive bytes and original state.
`--run` reuses that exact checked archive without another copy.

Execution additionally requires `--run --reviewed-plan FILE
--expected-resume-sha SHA --qualification FILE --controller-config FILE
--receipt-jsonl FILE --verified-archive FILE`. Exact plan equality and digest validation precede the
sole capability-file read. A single guarded admission permits 291 new calls.
Ambiguous admission is never retried. The old nine charges remain separate
from the new batch receipt join, and the result reports their combined totals.
No Vector rerun or automatic next pair is possible.

Before native append, the helper copies and verifies all files in the retained
runtime home, app, and support directory, including dependencies and SQLite
sidecars. It then retains their exact paths. Original attempt logs/source,
private transcript copies, summary, closure, and witness audit remain immutable.
The root and two occupied native lifetime slots are authenticated and adopted;
only the four unused roles can be created through the fixed ancestry graph.
The native command resumes the original root, while native collaboration
followups target the existing children. No native ID, ancestry, rollout path,
provider identity, or saved role instruction is rewritten.

Owned Bun-cache directory junctions are recorded with their owned relative
targets; their canonical target files are copied independently. The archive
contains no live links back to the mutable runtime. Other junctions or symlinks
are refused.

The explicit deadline choice is 7,162.344 remaining seconds, excluding the
disclosed instrument pause, with the old 37,656 process milliseconds retained.
The new witness and coordinator use this remaining wall allowance conservatively.
The one formal repair remains available; its admission threshold subtracts the
old $0.1423925 from the original $13.84808545. Old native failures and all review
flags remain visible even if later work completes. This helper establishes no
quality or efficiency claim and returns review-required status while historical
review is outstanding.

## Free qualification contract

`qualification()` accepts a sanitized JSON artifact with exactly these fields:

- `kind`: `heavy-codex-partial-resume-qualification-v1`.
- `binarySha256` and `witnessInstrumentSha256`: exact native binary and corrected
  matched-instrument manifest identities.
- `witnessCodeRevision`: the proven correction code revision above. A plan
  separately pins the reviewed invocation revision, including a documentation
  descendant with identical matched bytes.
- `realProviderCalls`, `fundedMeterCalls`, `BunRuns`, `ChromeRuns`: all zero.
- `beforeRoles`: lead, backend coordinator, frontend worker; their
  `beforeLatestOutcomes` must be exactly `{lead: failed,
  backend_coordinator: interrupted, frontend_worker: failed}`. `afterRoles` contains the exact
  seven-role team, and `maximumNativeDepth` is two.
- All of `qualificationPassed`, `oldWitnessClosed`, `newWitnessEndpoint`,
  `newAliasObserved`, `rootIdentityPreserved`, `existingChildIdentitiesPreserved`,
  `noReplacementChildren`, `codeModePreserved`, `allSolHighAutoLow`, `aliasOnly`,
  `receiptJoinComplete`, `archiveBeforeAdoptionVerified`,
  `initialFailureRetainedSeparately`, and `historicalReviewRequired` are true.
- `phases` has the ordered `initial_failed_fixture` and `new_binding_resume`
  records. Each contains exactly `phase`, `forwardedCalls`, `knownReceiptCount`,
  `measuredUsd`, `latestOutcome`, and `reviewRequired`. Each forwarded call has a
  known receipt. The first failed outcome remains separately review-required;
  the resumed phase must complete.
- `cumulativeCalls` equals both phases' calls and is at most 300.
  `formalRepairCount` is integer zero or one.
- `evidenceFiles` maps retained relative evidence files to byte SHA256 values.
  Paths must remain inside the qualification directory without links.

The artifact is review evidence, not a substitute for reviewing the actual free
native run. Its entire file SHA is pinned in the continuation plan. Private raw
transcripts and native identifiers stay outside Git and printed output.

`qualify_resume.py --run-free` creates that evidence using a new private `--out`,
`--original-plan`, `--witness-root`, `--expected-witness-revision`, and
`--expected-witness-manifest-sha`. Use the Python executable frozen in the
original plan. It invokes the unchanged `native_command` with the actual role
configuration and code-mode definitions. Its deterministic fake upstream emits
only fixed collaboration calls and final/error responses. The first scope
retains the three actual stopped latest turns and known fake receipts; the second closes
the first endpoint, verifies the archive, adopts the native root/children under
a fresh alias/endpoint, and creates the four unused roles. No app, Bun, Chrome,
browser driver, real provider, or funded controller is started.

Native shutdown can project the child that received `response.failed` as
`interrupted`. Qualification records that state literally; it never converts it
to `failed`. The failed fixture scope remains separately review-required. This
fixture allowance does not relax paid adoption: the actual retained original
three-thread database must still contain exactly its three known failed turns.

Pure controls run from this directory:

```powershell
python -m unittest test_codex_resume test_codex_arm -q
```
