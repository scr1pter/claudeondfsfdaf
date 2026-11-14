# Independent judge review — Relay Directory

**Initial verdict: FAIL. Final-state acceptance is pending repairs and same-QA recheck.**

Reviewed the complete `BUILD_SPEC.md`, all product modules, `package.json`, README/storage documentation, every test/consumer and verification script, and the initial `QA_REPORT.md`. No product/test/evaluator edits, external services, installation, deployment, browser, or unrelated files were used. Only this review is authored by the judge; executions use synthetic fixtures under external `DATA_DIR`.

## Blocking finding additional to initial QA

### J1 — HIGH: repaired shutdown hangs after an aborted HTTP body on Bun

- Contract: BUILD_SPEC.md:9,37 requires graceful shutdown, ownership release and exit 0; aborted requests must not corrupt subsequent operation.
- Reviewed root: `app.mjs:36–40,63–77`, SHA-256 `d01271680d84ce99f31946b2f569f899eaa166a7ac8391656971989bc279267c`. Shutdown now awaits each accepted handler **and** response `finish`/`close` before `server.close()`. This fixes the original completed-body reproduction, but graceful exit after client abort fails on this state. The response-event dependency is a concrete lifecycle concern to diagnose; the judge has not instrumented which internal await remains pending.
- Independent reproduction (unchanged QA test):

  ```powershell
  $env:RELAY_TEST_RUNTIME=(Get-Command bun).Source
  & $env:NODE_EXE --test --test-name-pattern='QA aborted-body regression' tests/qa.test.mjs
  ```

- `tests/qa.test.mjs:645–659` sends an authenticated incomplete POST, destroys its client after 30 ms, verifies unchanged events and healthy `/health`, then its fixture cleanup writes `shutdown\n`. Both the judge's full Bun-child run and isolated run fail at the 15-second shutdown bound with `Owned service did not stop`. The harness terminates only its own hung child. The same full Node run passes. Thus this is not a claim that the abort crashes the server or changes data: the demonstrated failure is subsequent graceful shutdown.
- Required correction belongs to the root/API owner: settle aborted/disconnected accepted lifecycles without abandoning an executing durable transaction, while retaining the successful accepted-body drain, admission gate, response delivery and exclusive ownership ordering. Do not simply skip the abort regression or force a successful shutdown before accepted writes finish.
- Recheck: this isolated regression on Node and Bun; original real-HTTP drain; two-concurrent-body drain/admission/second-writer test; then complete connected suites with no skips, cleanup failures or leaked children.

## Existing QA findings and repair assessment

- **F1 (original partial-body drain): repaired reproduction passes independently on both runtimes.** The root no longer invokes Bun `server.close()` before the admitted body and response finish. Original unchanged QA drain returns HTTP 201, exits 0, and verifies staged import/event after restart. The new parent regression also passes with two accepted bodies, new-write 503, second writer refused during drain, both 201 responses, exact restarted imports/events. These passes do not close J1 or approve all shutdown paths.
- **F2 (Windows tip-rename EPERM): open pending final repair evidence.** The initial QA evidence is credible: a real rename failure after journal fsync leaves journal sequence 2/tip 1 and deliberately poisons storage rather than acknowledging unpublished state. This is a reliability failure, not demonstrated acknowledged data loss. The in-progress repair bounds Windows-only EPERM/EBUSY/EACCES retries, retains one synced candidate, rechecks regular-file/directory identity and prior tip, never unlinks the acknowledged tip, and still poisons on exhaustion. These are appropriate constraints; initial successful suites cannot establish final repair correctness while this file is changing. Require both runtime stress and focused transient/exhaustion/path-change fault checks, plus unchanged corruption/ownership/atomicity regressions and updated same-QA evidence.

## Independent rubric

| Area / spec | Review result |
| --- | --- |
| Deliverables, no-install Node/Bun, startup/readiness/loopback/health (§7) | Present; connected startup/health and syntax checks pass. Runtime data is external. |
| HTTP bounds/UTF-8/errors/current authorization (§9) | Strong implementation and passing boundary/role/tenant/abort-survival checks. Graceful shutdown **FAIL J1**. |
| Workspaces/capabilities/revocation (§13–15) | Passing role matrix, durable revocation and workspace replay. Bootstrap cannot access business routes; authorization is repeated inside writes. IDs and secret token hashes are separate. |
| CSV/staging/import projections/replays (§19–25) | Passing exact byte/row limits, quotes/BOM/CRLF, validation, canonical body comparison, subject-scoped replay, digest, ordering and public-field checks. No staging directory changes. |
| Approval/terminal states/leases (§29–31) | Passing subject separation, current-role cancellation, terminal nonreactivation, competing claims and precise capability fencing. Same-approver repeat after terminal transition is observational only; spec promises repeat success and forbids reactivation, so this is not an additional violation. |
| Commit atomicity/idempotency (§33) | Serialization revalidates current capability, precise lease, epoch, expiry and version within the callback; draft rollback protects failed batches. Passing swaps, uniqueness, missing-delete rollback, revisions, competing stale-base commits, exact post-expiry/restart replay and revoked/wrong-capability denial. |
| Durability/exclusive ownership/journal (§37) | Architecture is coherent: clone-on-write FIFO, journal fsync then checked acknowledged tip before publication, immutable exclusive hard-link lock generations, conservative PID takeover, strict chained recovery. Corruption and reclamation tests pass. **F2 final verification pending**; no claim of exhaustive power-loss correctness. |
| Audit/secrecy (§39) | Transaction-local events and replay suppression; contiguous/restarted cursors and secret scans pass. Public imports exclude stored rows/hashes/lease internals. Errors/logs do not reflect submitted secrets. |
| CLI usability (§43) | All required commands call the shared live service; single designated JSON stream, safe generic errors, help, file/UTF-8 limits and hyphen-prefixed opaque values tested. No independent CLI state. |
| SDK declarations/runtime (§45) | Exact required methods/shapes, five-role/six-state unions and no `any`; declarations match implementation by inspection. Runtime consumer and RelayError behavior pass. Semantic TypeScript checking remains unperformed, not implied by runtime execution. |
| Verification completeness (§47) | Initial QA is extensive and candid, not merely happy-path. Its historical FAIL and hashes must remain distinguished from repaired-state results. Full Bun recheck currently fails J1; final approval is withheld. |

## Checks independently executed

Environment: Node **24.22.0**, Bun **1.3.14**, Windows. All owned services are exercised through loopback only; the real-client QA group selects supplied `PORT` 4125 unless occupied (then leaves the existing listener untouched).

| Check | Measured outcome |
| --- | --- |
| Node harness: `tests/client.test.mjs tests/startup.test.mjs tests/integration.test.mjs tests/qa.test.mjs tests/shutdown.test.mjs` | **34/34 PASS**, no skipped/cancelled tests. |
| Node harness with `RELAY_TEST_RUNTIME` = Bun: integration + QA + shutdown | **22/23 PASS, 1 FAIL**: aborted-body fixture cannot shut down (J1). Original F1 and extended shutdown test pass. |
| Bun-child isolated `--test-name-pattern='QA aborted-body regression' tests/qa.test.mjs` | **0/1, FAIL**, same cleanup shutdown timeout. |
| Node `scripts/check.mjs`; Bun `scripts/check.mjs` | Both **PASS**, 18 executable/consumer files; these do not semantically typecheck declarations. |

All judge-opened test terminals were closed after exit. Test cleanup awaited termination of owned children, including its own hung Bun children. Final loopback probe found `PORT` 4125 unreachable; no judge verification listener remains there.

## Limitations: explicit judgments, not waivers

- **No `tsc`: acceptable disclosed verification limitation, not proof of semantic type correctness.** `Get-Command tsc` finds no installed command; downloading one is outside this task. The declaration surface is small and matches the actual JSON contract by independent inspection; executing/transpiling `.mts` is not a semantic typecheck. Use an already available compiler later if one exists.
- **Windows directory fsync: acceptable disclosed platform limit for this contract's tested process-death/restart model, not an unconditional power-loss guarantee.** Mandatory file fsync and atomic namespace publication remain implemented. Actual machine power-loss/NTFS directory-entry persistence is unverified; do not advertise it as established or swallow arbitrary file-sync failures.
- **Durable HMAC owner-derivation key: acceptable under the literal no-plaintext-capability requirement, with material trust warning.** The key is not itself an accepted bearer capability; actual tokens are hash-only in capability records and regenerated for exact workspace replay. However journal readers can reconstruct owner capabilities. `STORAGE.md:110–121` clearly discloses this; DATA_DIR/backups must be treated as credentials. This is not encryption-at-rest or protection from a hostile local user. There is no finding that stored token hashes alone protect owner secrets.
- Snapshot journals and immutable lock history grow without compaction; documented operational limitation, no specified retention/throughput target violated. Hostile administrators able to rewrite all hashes/metadata are outside the checksum integrity guarantee. No exhaustive filesystem-failure/power-loss/performance claim is made.

## Reviewed state and necessary final gate

This is an **initial formal review of a moving repair state**, not final repaired-state approval. Root/API/storage/declaration hashes below identify the reviewed code; initial QA fingerprints differ for root/storage. Storage changed during execution and must be frozen/rechecked before final judgment.

```text
app.mjs                 d01271680d84ce99f31946b2f569f899eaa166a7ac8391656971989bc279267c
backend/data.mjs        9ee9f77186ad0d865e0a262a27700fba0a45ada410822efcde1401607b99dc8f  (first read / initial suite start)
backend/data.mjs        4061e0f4b96f7b4011d6c7307f6e94711a1f070d6c9202c639da6a953967c200  (later read)
backend/api.mjs         0da891e29a22ed8e9a294b2a090caae374dc2dd0f75ffc8dca593ff9e1a0202b
backend/service.mjs     7d99732c39acbb1f0ecc47f06b59afbfe2c4e9449bb5de9f08cce283e0a49b34
backend/validation.mjs  71f9555abef95c44a46bf10d9995bf935bb5dcac3622e122cb02bc7d2b3e66b6
cli.mjs                 cc3da69363f9a279de92fa8e38e080b118a3fcf42af14543f4a4f523c5006668
sdk.mjs                 680449dfe12acb7d8df2ad146fd22b407c4deb07930fe20d0d6ac5281abd045a
sdk.d.mts               b229f9092f105eaa88253b6831e8a8ac1caa471b2a469d9c750a1a522ef14eaa
QA_REPORT.md            42a7328ae537e74cfaadc043933f8d56a414f2669a4f77415ad8072936e83e03
tests/qa.test.mjs       8a92ddc10df642a8a90e5308458da6b9ce8a8c1c778f21fd260a717ce53b90e4
tests/shutdown.test.mjs c1a9a9ab443ea65a59567283f8525c7315a61c45e1995e5e965b10a02d0764f7
```

Necessary next conditions: root repairs J1; storage completes F2 and its deterministic/real-I/O checks; the same QA identity reruns both runtime arms and updates its report with final hashes; parent completes its reserved personal verification; this same judge reviews the resulting frozen state and evidence. No requirement has been waived and no product change is authorized by this review.
