# Independent QA

Final repaired-state verdict: **PASS.** All three material defects from the
initial QA and judge reviews are fixed, and the final Node/Bun checks below pass.

Initial verdict: **FAIL — two material defects require repair.** No product files
were changed. Dedicated reproductions are in `verification/qa.mjs`.

The initial independent suite executes 91 checks and reproduces five failed
expectations belonging to two defects on **Node v24.22.0 and Bun 1.3.14**. All
service processes created by QA are stopped; all runtime data and synthetic
fixtures are under the supplied `DATA_DIR`.

## P1: stale-lock recovery follows a directory alias and deletes unrelated data

`backend/storage.mjs` reads `.relay-owner/owner.json` and removes it without first
checking whether `.relay-owner` is a real directory rather than a symlink or
Windows junction. It then removes the alias and starts normally.

Reproduction, using only synthetic directories:

1. Create fresh `DATA_DIR/test-data` and a separate `DATA_DIR/unrelated-synthetic`.
2. In the unrelated directory write `owner.json` as
   `{"pid":2147483647,"nonce":"synthetic-unrelated-owner"}`.
3. Create `test-data/.relay-owner` as a junction/symlink to the unrelated directory.
4. Start the real app with `--data test-data --port 0`.

Actual: the service announces readiness and deletes
`unrelated-synthetic/owner.json`. Expected: refuse the unsafe lock path without
deleting any unrelated file. The public spec requires safe dead-owner recovery,
no deletion of unrelated files, and data confined to the supplied directory.
Both `LOCK_SYMLINK_ADMITTED` and `LOCK_SYMLINK_UNRELATED_DELETE` fail in the QA
suite. Check the lock directory and metadata types before reading or removing
their contents; retain unknown/aliased paths intact.

## P2: replay conflicts are checked after command validation

`backend/relay.mjs` calls `validateCommand(raw)` before looking up staging and
commit replay records. Consequently, changing a previously used key's request
body to an invalid field value yields 400 rather than the explicit 409 replay
conflict required by the spec.

Reproductions after one successful stage/commit:

- Stage a valid CSV with `Idempotency-Key: qa_stage`; reuse that key and subject
  with `{ "baseVersion": 0, "csv": "malformed" }`: actual 400, expected 409.
- Reuse the same staging key with the original CSV and `baseVersion: -1`:
  actual 400, expected 409.
- After committing with `Idempotency-Key: qa_commit`, reuse the same capability
  and key with `{ "leaseToken": "" }`: actual 400, expected 409.

Authentication and role checks must still precede replay lookup. For an already
used valid key, compare the canonical body before field-level validation; an
unseen key should retain normal validation errors. These are the QA regression
IDs `STAGE_REPLAY_CHANGED_INVALID_CSV`, `STAGE_REPLAY_CHANGED_INVALID_BASE` and
`COMMIT_REPLAY_CHANGED_INVALID_BODY`.

## Passed checks and evidence

The independent suite passes role/read matrices, same-subject staging namespace,
capability-bound commit replay, changed commit key denial, malformed JSON and body
shapes, invalid authentication before body parsing, rejected-operation event
stability, valid 500-row CSV staging, Unicode names and trimming, email
normalization, lease expiry/reclaim/fencing, SDK error types, restart and exact
commit replay, and revoked-capability replay denial.

QA reran the root integration suite on Node: **10 groups, 375 assertions passed**,
covering all CLI commands and SDK methods, concurrency, durable recovery,
corruption, secret hygiene and accepted streamed-write shutdown. Strict
TypeScript compilation of `verification/sdk-types.mts` passed using the provided
compiler. The existing browser-driver health evidence is appropriate because
the specification explicitly requires no graphical interface.

Commands:

```text
node verification/qa.mjs
RELAY_TEST_RUNTIME=<provided Bun executable> node verification/qa.mjs
node verification/integration.mjs
node TSC_PATH --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM verification/sdk-types.mts
```

Limits: execution is on Windows. Full machine power failure and other operating
systems are not simulated. The judge's initial review subsequently resolved the
approval replay interpretation: the matching `approvedBy` subject's retry must
succeed after leasing, committing and cancellation without changing current
state. This is a third material defect in the initial implementation.

Protected `BUILD_SPEC.md` SHA-256 remained
`A85C62DE50F23145BFC3EE6DB261DB08C565889FF8DF0A7808BAE1143B968351`.

The completed final-state recheck is recorded below; the initial findings above
are retained as defect history and reproduction evidence.

## Repair regression authoring

At the lead's request, the independent suite now also checks used staging and
commit keys with null, arrays, scalars and invalid fields, while asserting 400 for
the same malformed bodies under unused keys. It checks matching approval retries
while approved, leased, committed and cancelled, and after restart; every retry
must preserve the complete public import, directory and audit. The original lease
must still commit successfully after retry and restart. Other subjects and
terminal imports that were never approved still receive 409.

Filesystem regressions cover a directory alias at acquisition, a metadata-file
alias, a replaced directory alias at release using the original ownership
identity, and replaced metadata at release. Aliased targets and unknown entries
must remain intact. File-symlink tests explicitly report whether the platform
permits them. All these fixtures stay under the synthetic QA directory in
`DATA_DIR`.

Only syntax verification was run while repairs were in progress. The final-state
Node/Bun recheck started only after the lead confirmed repair completion.

## Final repaired-state recheck

All commands exited 0 on the completed implementation:

| Check | Node v24.22.0 | Bun 1.3.14 |
| --- | --- | --- |
| Independent `verification/qa.mjs` | 194 checks, zero findings | 194 checks, zero findings |
| Connected `verification/integration.mjs` | 10 groups, 375 assertions | 10 groups, 375 assertions |
| Strict SDK TypeScript compilation | Passed with provided compiler | Declarations shared with Bun |

Every filesystem alias capability flag was **true on both runtimes**:
`aliasSupported`, `metadataAliasSupported`, `releaseAliasSupported`, and
`releaseMetadataAliasSupported`. No alias test was skipped. Acquisition refuses
directory and metadata aliases without deleting targets or unknown entries.
Release preserves replaced lock-directory and metadata aliases, even when their
contents reproduce the original ownership identity. The app exits promptly after
refusing unsafe release; the Windows stdin shutdown regression does not recur.

Used-key request changes now return 409 for invalid CSV, invalid base versions,
empty commit tokens, null, arrays and scalars; unused keys retain 400 validation.
Current role/capability checks still deny unauthorized replays. Matching approval
retries return 200 after lease, commit and cancellation, including after restart,
with unchanged public state, epoch, directory and events. The original persisted
lease remains valid after an approval retry and restart. Other subjects and
terminal imports never approved still receive 409.

The final root integration reruns exercise the real CLI and SDK, authorization,
atomicity, simultaneous writes, fencing, durable revocation/replay, graceful and
abrupt restarts, fail-closed corruption, secret hygiene and draining accepted
streamed writes. Strict declaration checks verify exact unions, accurate SDK
arguments/returns and rejected invalid calls. Inspection of the repaired storage,
domain and shutdown code agrees with the executable evidence.

All QA-owned verification processes have exited. Runtime fixtures remain only
under `DATA_DIR`, and the protected build-spec hash is unchanged. No production
files were changed. The evaluator, external services and company documents were
not accessed. The earlier Windows/local and power-loss limits still apply.
