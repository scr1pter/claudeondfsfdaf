# Whole-team implementation review

Final repaired-state verdict: **PASS — no remaining material issue found.**

Initial verdict: **FAIL — repair three material issues, then repeat QA and review.**

All implementation roles and QA had completed before this review. I reviewed the
actual HTTP/domain/storage implementation, startup/shutdown, CLI, SDK and its
declarations, storage documentation, root integration tests, independent QA tests
and recorded evidence. I did not change product files or inspect the evaluator.
All my runtime fixtures were synthetic and under `DATA_DIR`; all my servers stopped.

## P1: lock recovery traverses an alias and deletes an unrelated file

Confirmed QA's reproduction in `verification/qa.mjs` on Node. At
`backend/storage.mjs`, `acquireLock()` reads and unlinks
`.relay-owner/owner.json` before establishing that the ownership directory and
metadata are genuine local entries. A junction/symlink from `.relay-owner` to a
separate synthetic directory causes its `owner.json` to be deleted, and startup
then announces readiness. This violates safe dead-owner recovery and preservation
of unrelated files.

Repair acquisition and release paths: refuse linked/non-directory ownership
paths and linked/non-regular metadata, preserve unexpected entries, and verify
that cleanup still refers to the owned local metadata before removing it. Do not
delete an aliased target as a way to recover. Retain the QA alias regression.

## P2: existing idempotency keys lose conflict precedence to body validation

Confirmed QA's three field-level reproductions, and independently confirmed that
reusing successful stage/commit keys with JSON `null` also returns 400.
`backend/relay.mjs:147` validates the command before consulting stage/commit
replay records at lines 168 and 232. The spec explicitly requires 409 when a used
key has another body; a changed body containing invalid values is still another
body.

After current authentication, workspace and role checks, locate an existing
record under a syntactically valid key and compare canonical JSON before
field-level/shape validation. Return 409 for every changed parsed JSON body.
Unseen keys must retain normal 400 input validation; malformed JSON/UTF-8 and
transport size/media errors remain transport errors. Preserve exact replay
results, namespaces, authorization rechecks and no-event behavior.

## P2: same approver's retry fails after a later import transition

Independent live reproduction:

1. Stage with owner, approve with subject `reviewer`.
2. Claim with a worker.
3. Repeat `approve` with `reviewer` and `{}`: actual 409.
4. Commit with the worker; repeat `approve` again: actual 409.

`backend/relay.mjs:191` limits approval replay to state `approved`. The spec says
"The same approver's repeat approval succeeds without a second event; another
subject's repeat is a conflict." It supplies no later-state exclusion. A retry
after an independent worker proceeds is a realistic connected workflow. The
"only for a staged import" condition governs a new approval; its explicit retry
exception should acknowledge an already completed approval without changing the
current state. This also respects the prohibition on reactivating terminal imports.

Permit an authenticated, currently authorized matching `approvedBy` subject to
repeat an existing approval after leasing, committing or later cancellation,
without changing state, epoch, directory, lease or audit. An import never approved
must still conflict when not staged, and a different subject must still conflict.
Add regressions before/after lease, commit and cancellation, and across restart.

## Positive evidence and remaining limits

- Independent QA rerun: 91 checks, with the same five failed expectations grouped
  under QA's two reported issues. No additional failure was masked by this run.
- Strict TypeScript compilation of `verification/sdk-types.mts` passed using the
  provided compiler; declaration unions, arguments and response shapes match the
  required SDK and avoid `any`.
- Inspection confirms current-capability checks at the serialized mutation
  boundary, precise capability/epoch lease fencing, atomic final-email checks,
  saved commit outcomes, one-event transactions, fsync before publication, and
  monotonic hash-chain recovery that fails closed.
- The root evidence records 10 groups/375 assertions on Node 24.22.0 and Bun
  1.3.14, all required CLI commands and SDK methods, corruption/restart/concurrency
  coverage, and browser-driver verification of the local health endpoint. There
  is no graphical interface required by the spec.
- Executable testing is Windows-local. Full machine power loss and other OS
  behavior are not established by these checks. The journal is intentionally
  append-only without compaction; unsupported platforms refuse stale recovery.

## Final repaired-state review

The same QA specialist completed the required final recheck before this review.
I inspected the repaired `backend/storage.mjs`, `backend/relay.mjs` and `app.mjs`
against the original findings, the extended independent regressions and the
updated QA/integration evidence. All three findings are closed:

- Ownership acquisition and release validate genuine directory/metadata types,
  entry identity and ownership identity. Linked, hard-linked, unexpectedly
  populated or replaced records are refused and preserved. Safe-release errors
  still close the kernel guard; the root shutdown `finally` also closes stdin,
  so the process exits promptly rather than retaining the Windows pipe.
- Current authentication and operation-role checks still run inside the atomic
  mutation boundary. Used valid staging/commit keys compare canonical parsed JSON
  before field validation; changed malformed shapes yield 409, while unused keys
  retain 400 validation and exact replays retain their original results without
  audit/version changes. Capability and subject namespaces remain intact.
- Matching currently authorized approval subjects can retry after lease, commit,
  cancellation and restart. The retry returns the current unchanged import with
  no transaction/event, preserving the original lease and epoch. Different
  approvers and terminal imports that were never approved still conflict.

I independently reran `verification/qa.mjs` on **Node 24.22.0 and Bun 1.3.14**:
both exited 0 with **194 checks, zero findings**, and all four alias-support flags
true. No filesystem regression was skipped. Strict TypeScript compilation of
`verification/sdk-types.mts` passed again. The protected `BUILD_SPEC.md` SHA-256
remains `A85C62DE50F23145BFC3EE6DB261DB08C565889FF8DF0A7808BAE1143B968351`.
The same QA specialist also records final integration runs of **10 groups and
375 assertions per runtime**, exercising the real CLI and typed SDK along with
concurrency, durability, fencing, corruption and accepted-write shutdown.

No product or evaluator files were changed by this review. All independently
started processes exited and fixtures remain under `DATA_DIR`. The previously
recorded Windows/local, power-loss and unsupported-platform limits remain. The
lead's required personal final API, CLI and typed-SDK verification is the next
step; no further product repair is requested by this review.
