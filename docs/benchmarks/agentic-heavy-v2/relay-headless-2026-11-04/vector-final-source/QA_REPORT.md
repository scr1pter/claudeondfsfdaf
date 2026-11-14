# Independent QA — Relay Directory

Date: 2026-11-04. **FINAL QA VERDICT: PASS on the verified frozen state below.**

## Final F3-repair recheck — PASS

The same QA identity independently reviewed the complete final `app.mjs` and reran the unchanged strong QA regressions. **F1, F2, J1 and F3 are closed for their recorded reproductions; no material QA finding remains open.** Initial and intermediate FAIL evidence, limitations and hashes are preserved below rather than overwritten by the final passes.

Only `app.mjs` changed in the product since the preceding recheck. Its final SHA-256 is **`378b0fa646e823d348e225d7eb18e240b2c25cb8d0cfad1fc5c6f994873df876`**. All other 11 module/document/test hashes in the preceding frozen fingerprint table were verified unchanged both before and after execution. In particular, `tests/qa.test.mjs` remains `cc0878a76f3e7e769ddc3195fb9fbce942b6a87a8f424f9ff4457f1c6b3f8492`: the F3 test was not weakened, skipped or changed to accept a killed process. Only this report was edited in this final QA round; implementation was not edited by QA.

### Final shutdown safety assessment

`app.mjs:91–102` now performs the unusable-response cleanup in `operation.finally`, **after** the accepted handler promise settles. The unchanged API/service implementation awaits durable transactions before settling its handler. The new cleanup therefore cannot itself infer transaction completion from a transport event or release ownership while the gated write is executing. It destroys/settles a response only when that completed handler did not leave `writableEnded` true. Normal ended responses still wait for finish/close completion. Shutdown still awaits accepted `entry.done` promises before listener close, service/store close and lock release (`app.mjs:29–44`). No temporary diagnostic import, file-writing hook, lifecycle flag or timer remains in the reviewed product root.

The unchanged original F3 test passed both its **connected** and **disconnected** branches on Node and Bun, in focused runs and again in the full suites. It proves that the process remains alive and refuses another writer while journaled publication is paused, new writes receive 503, release advances the real anchored tip, the connected response is delivered, shutdown exits **0**, and restarted imports/events/exact replay are correct. The old timeout/forced-cleanup branch did not execute. Original incomplete-body drain, incomplete-body abort and concurrent-body drain/admission/ownership regressions also passed. Deliberate abrupt termination in separate crash-recovery tests remains intentional and is not counted as successful graceful cleanup.

### Final independently executed checks

Windows; Node **24.22.0** via `NODE_EXE`; Bun **1.3.14**. Every meaningful case ran; **0 skipped/cancelled cases** in the final test runs.

| Exact command | Final result |
| --- | --- |
| `& $env:NODE_EXE --test tests/client.test.mjs tests/startup.test.mjs tests/integration.test.mjs tests/qa.test.mjs tests/shutdown.test.mjs` | **PASS 36/36** |
| `$env:RELAY_TEST_RUNTIME=(Get-Command bun).Source; & $env:NODE_EXE --test tests/integration.test.mjs tests/qa.test.mjs tests/shutdown.test.mjs` | **PASS 25/25**, actual Bun service/CLI/typed-consumer children |
| `bun test tests/client.test.mjs tests/startup.test.mjs` | **PASS 11/11** |
| Focused shutdown command below, normally then with Bun child selection | **PASS 4/4 per runtime**, including both F3 branches |
| `& $env:NODE_EXE scripts/check.mjs` | **PASS 18 files** |
| `bun scripts/check.mjs` | **PASS 18 files**, syntax/transpile only |
| `$env:PORT='0'; & $env:NODE_EXE backend/verify.mjs` | **PASS 1051 checks**, `liveChildren:0` |
| `$env:PORT='0'; bun backend/verify.mjs` | **PASS 1051 checks**, `liveChildren:0` |
| `$env:PORT='0'; & $env:NODE_EXE backend/tip-retry.verify.mjs` | **PASS 19 groups**, `liveServers:0`, `liveChildren:0` |
| `$env:PORT='0'; bun backend/tip-retry.verify.mjs` | **PASS 19 groups**, `liveServers:0`, `liveChildren:0` |

```powershell
& $env:NODE_EXE --test --test-name-pattern='QA aborted-body regression|QA real HTTP graceful drain|journal-started|shutdown gates' tests/qa.test.mjs tests/shutdown.test.mjs
```

The full suites again cover connected API/CLI/typed SDK, authentication/tenant/role boundaries, malformed inputs and exact limits, idempotency/current authorization, lease fencing/revocation/concurrency, atomic commits/revisions/stale versions, event stability/secrecy, graceful/abrupt restart, corruption, lock reclamation and unsafe runtime paths. No coverage is inferred from Bun's incomplete nested-test runner: the connected Bun groups run under Node's complete harness with explicit Bun child selection.

### Final real fresh-store and retry evidence

The unchanged 17 deterministic/regression retry groups plus live HTTP stress and secret scan were rerun under **each** runtime, not merely carried forward. The final app-process stress likewise made no request/fixture retries and required first creation 201, exact replay 200, one event, two journal records, matching tip, graceful exit 0 and an actual restart read-back for every store.

| Final stress arm | Fresh creates | Restarts | Tip rename attempts | Real transient errors recovered |
| --- | ---: | ---: | ---: | --- |
| Actual app-process QA stress, Node | **60/60** | **60/60** | 84 | **24 EPERM** |
| Actual app-process QA stress, Bun | **60/60** | **60/60** | 60 | None observed in this arm's final run |
| Backend real HTTP/service stress, Node | **60/60** | **60/60** | 70 | **10 EPERM** |
| Backend real HTTP/service stress, Bun | **60/60** | **60/60** | 71 | **11 EPERM** |

Thus the final checks exercised real EPERM recovery in both runtimes, alongside deterministic transient/exhaustion/fatal/path-change/poison/publication-order checks. Earlier real app-process Bun EPERM recovery and all original F2 failure evidence remain recorded below. There was no suppressed valid-write failure or retry of an entire failed fixture.

### Final limitations, cleanup and remaining work

- **No semantic TypeScript check:** `Get-Command tsc` still finds no compiler. Actual typed `.mts` consumer execution under both runtimes, declaration review and syntax/transpile checks passed; none substitutes for semantic checking.
- The recorded power-loss/Windows directory-fsync, hostile-local-user/owner-derivation-key, journal-growth and exhaustive-fault/performance limitations remain; no durability or shutdown requirement is waived.
- All verification children/listeners were stopped and awaited. The final QA real-client group used supplied `PORT` **4125**; the final probe found it **unreachable**. Hash verification after all checks matched all **12** reviewed files. No owned server terminal remains, no unrelated process was stopped, and no hung-child cleanup was needed to make the shutdown regressions pass.
- Runtime fixtures remained synthetic and solely under external `DATA_DIR`. No product/protected/evaluator/reference file edit, external service, company document, browser, dependency installation or deployment was used.
- **Remaining gates belong to the parent:** same-judge final follow-up, then the parent's reserved personal API/CLI/typed-SDK/restart verification. QA did not run `scripts/verify-owned.mjs` and does not claim these later gates have occurred.

Final root hash replaces only the root entry in the unchanged preceding frozen fingerprint table:

```text
app.mjs 378b0fa646e823d348e225d7eb18e240b2c25cb8d0cfad1fc5c6f994873df876
```

---

## Preserved preceding frozen-repair recheck — verdict FAIL (F3)

The same QA identity resumed after the declared repair freeze and read `REVIEW.md`, the unchanged complete spec, revised `app.mjs`, `backend/data.mjs`, `STORAGE.md`, and complete new retry/shutdown verification sources. Other product-module hashes remain identical to the initial review. No product/evaluator/protected file was edited. The initial failure history is retained below, including its original fingerprints and historical line references.

### Repair disposition

- **F1 original incomplete-body drain: repaired reproduction PASS on Node and Bun.** Original QA drain still returns 201, exits 0 and retains its import/event after restart. The parent's concurrent-body test additionally verifies new admission 503, two accepted 201 responses, second-writer exclusion during drain and exact durable imports/events. All three focused original abort/drain/concurrent-body regressions passed **3/3 per runtime**, with no skips.
- **F2 transient Windows tip rename: repair verification PASS.** `backend/data.mjs:10–13,365–420` retries only Windows EPERM/EBUSY/EACCES, at most seven attempts with 1,575 ms deliberate backoff. It preserves one fsynced candidate, rechecks prior metadata/directory/candidate identity before each attempt, never unlinks the acknowledged tip and still poisons after fatal/exhausted/uncertain publication. Independent deterministic and real-I/O results are below; no valid request was retried by the harness to mask a failure.
- **J1 original incomplete-request abort: repaired reproduction PASS on Node and Bun**, including subsequent graceful fixture shutdown. This closes that specific reproduction, not all disconnected response paths: the new post-journal case below still fails on Bun.

### F3 — HIGH / FAIL: completed-body client disconnect after journal start still blocks Bun shutdown

Requirement: BUILD_SPEC.md:9,37 — drain accepted writes, close/release ownership and exit 0, including disconnected accepted operations. Relevant root lifecycle is `app.mjs:29–41,63–92`, particularly awaiting both `operation` and the response/transport `finished` promise. The exact unresolved await has not been instrumented; this report does not assert a proven internal event cause.

New independent regression: `tests/qa.test.mjs:744–831`. It runs both a connected-response control and a client-disconnected case against a **real app child**. A test-only in-memory filesystem wrapper pauses tip rename **after the real journal append/fsync**. It does not alter product files, inject an I/O error, add a production fault switch, replace the HTTP handler or skip any case. A complete valid authenticated staging request is already journaled before the client disconnects. The test then:

1. Writes `shutdown\n`; checks new mutations return 503 and a second writer cannot become ready while publication is paused.
2. Releases the pause and observes the real tip rename return successfully.
3. Waits for exit 0 and verifies exact publication/restart/replay state.

**Node:** both connected and disconnected cases pass. **Bun:** connected control passes, but the disconnected case stays alive beyond 15 seconds. Confirmed in the initial focused new-test run and again in the complete final-state run. At timeout, actual files show `anchoredDelta=1`, `journalDelta=1`, `imports=1`. Thus the accepted mutation has been published, not merely left at an unresolved pre-rename gate. The harness terminates only its own hung process; a new service then reopens the directory and verifies exactly the staged import and one new event. The new test remains a failure rather than accepting forced termination as graceful success.

Reproduce:

```powershell
$env:RELAY_TEST_RUNTIME = (Get-Command bun).Source
& $env:NODE_EXE --test --test-name-pattern='journal-started' tests/qa.test.mjs
```

Required cross-boundary work: root/API owner must settle the completed-request/disconnected-response lifecycle **without abandoning an accepted durable handler**. Preserve the admission gate, response delivery for connected clients, tip publication and exclusive ownership ordering. Product freeze must be reopened for this repair, followed by same-QA and same-judge recheck. QA did not change implementation.

### Current exact checks and counts

Environment remains Windows, Node **24.22.0**, Bun **1.3.14**, synthetic external `DATA_DIR`. Two additional QA groups (post-journal disconnect/control and 60 fresh app-process stress) increase the requested baseline counts from 34/23 to **36/25**; no meaningful case was removed or skipped.

| Executed command | Current measured result |
| --- | --- |
| `& $env:NODE_EXE scripts/check.mjs` | PASS, **18** executable/consumer files |
| `bun scripts/check.mjs` | PASS, **18** files; syntax/transpile only |
| `& $env:NODE_EXE --test tests/client.test.mjs tests/startup.test.mjs tests/integration.test.mjs tests/qa.test.mjs tests/shutdown.test.mjs` | **36/36 PASS**, 0 skipped/cancelled |
| `$env:RELAY_TEST_RUNTIME=(Get-Command bun).Source; & $env:NODE_EXE --test tests/integration.test.mjs tests/qa.test.mjs tests/shutdown.test.mjs` | **24/25 PASS, 1 FAIL F3**, 0 skipped/cancelled; every original integration/QA/shutdown group passes |
| `bun test tests/client.test.mjs tests/startup.test.mjs` | **11/11 PASS** |
| Node harness focused original abort/drain/admission regressions across QA + shutdown files, once normally and once with Bun child selection (exact command below) | **3/3 PASS per runtime**, no skips |
| `$env:PORT='0'; & $env:NODE_EXE backend/verify.mjs` | PASS, **1051 checks**, `liveChildren:0` |
| `$env:PORT='0'; bun backend/verify.mjs` | PASS, **1051 checks**, `liveChildren:0` |
| `$env:PORT='0'; & $env:NODE_EXE backend/tip-retry.verify.mjs` | PASS, **19 groups**: 17 deterministic/regression groups, real 60-store HTTP stress/reopen and secret scan; `liveServers:0`, `liveChildren:0` |
| `$env:PORT='0'; bun backend/tip-retry.verify.mjs` | PASS, same **19 groups**, `liveServers:0`, `liveChildren:0` |

Focused command, executed normally and then again after setting `RELAY_TEST_RUNTIME` to the Bun executable:

```powershell
& $env:NODE_EXE --test --test-name-pattern='QA aborted-body regression|QA real HTTP graceful drain|shutdown gates' tests/qa.test.mjs tests/shutdown.test.mjs
```

The full connected runs re-exercised the initial requirement coverage matrix below, including roles/tenants, exact byte/CSV/row limits, canonical/revoked replays, precise capability fencing, atomic swaps/collisions/deletes, concurrency/stale base, audit stability, crash/restart, journal/tip corruption, symlink safety, lock reclamation, real CLI and typed SDK. The parent shutdown test is credible real HTTP/child-process coverage, not merely service-adapter invocation. No Bun nested-test coverage is inferred from `bun test`; Node's harness runs the actual Bun service/CLI/SDK-consumer children.

### Independent F2 deterministic and real stress evidence

Reviewed and personally executed the complete `backend/tip-retry.verify.mjs`. Its in-memory instrumentation asserts one fsynced candidate path/inode/content, exact backoff values and actual awaited delays, no premature snapshot/result publication, current tip checks and failure poisoning. Cases include mixed transient recovery; persistent EPERM/EBUSY/EACCES exhaustion; fatal EIO/ENOENT without retry; stale tip, tip/directory/candidate junction and replaced candidate inode; rename succeeded but reported error; post-rename directory-sync ordering/fatal sync; queued/new-operation poisoning; unacknowledged-tail reopen and unchanged corruption checks. Its failures are not swallowed; unsupported cases are not skipped on this Windows run.

Additionally authored and ran `tests/qa.test.mjs:833–870`: **60 fresh actual `app.mjs` processes plus 60 actual restart processes per runtime**. This is independent of the coordinator's in-process service stress. Each first POST must return 201 on its first attempt, exact creation replay returns 200 with the same owner, only one creation event/two total journal records exist, tip sequence/hash match, graceful exit is 0, and reopened authorization/state/events agree. Instrumentation observes real rename calls only; it injects no error and retries neither requests nor fixtures. Latest complete-run measurements:

| Check | Fresh creates | Restarts | Rename attempts | Real errors recovered |
| --- | ---: | ---: | ---: | --- |
| Independent actual app-process stress, Node | **60/60** | **60/60** | 66 | **6 EPERM** |
| Independent actual app-process stress, Bun | **60/60** | **60/60** | 62 | **2 EPERM** |
| Re-executed backend real HTTP/service stress, Node | **60/60** | **60/60** | 66 | **6 EPERM** |
| Re-executed backend real HTTP/service stress, Bun | **60/60** | **60/60** | 60 | None observed in that run; deterministic transient paths did execute |

All these requests succeeded without a fixture-level retry. This is affirmative evidence that real intermittent EPERM was encountered and safely recovered in both actual process arms, not a clean run that happened to avoid the original failure. It does not erase the initial F2 failures or promise recovery from persistent/fatal filesystem errors.

### Current limitations, cleanup and remaining gate

- `Get-Command tsc` still finds no compiler. Both actual typed `.mts` consumers and declaration review pass; **no semantic TypeScript typecheck** is claimed.
- Existing power-loss, Windows directory fsync, hostile-local-user/derivation-key, journal growth and exhaustive-fault/performance limitations remain. Updated storage documentation puts directory-fsync limits at `STORAGE.md:110–112` and credential-material warning at lines 129–134. Nothing here waives file fsync or the shutdown requirement.
- All owned test processes were awaited/stopped, including the deliberately forced cleanup of the F3 hung child, and the recovery child subsequently stopped. Test global cleanup asserts no owned children remain. Final loopback probe found port **4125 unreachable**. No unrelated process was stopped; no server terminal was left open. Runtime fixtures remain only under `DATA_DIR`.
- No parent-reserved `scripts/verify-owned.mjs`, browser, evaluator/reference, external service, company document, dependency download or deployment was used. Parent personal verification and same-judge final approval remain pending **after F3 repair and same-QA recheck**.

Current frozen implementation/test SHA-256 fingerprints:

```text
app.mjs                       ee7c806ed6dd34f09e31aed62fe1259f9c9b1e69dfb24e2fb9cb16ec5fa62f92
backend/data.mjs              e61ca7c303a676e7b091326d693a7100ad2182d707c476730505bf286d42471a
backend/api.mjs               0da891e29a22ed8e9a294b2a090caae374dc2dd0f75ffc8dca593ff9e1a0202b
backend/service.mjs           7d99732c39acbb1f0ecc47f06b59afbfe2c4e9449bb5de9f08cce283e0a49b34
backend/validation.mjs        71f9555abef95c44a46bf10d9995bf935bb5dcac3622e122cb02bc7d2b3e66b6
cli.mjs                       cc3da69363f9a279de92fa8e38e080b118a3fcf42af14543f4a4f523c5006668
sdk.mjs                       680449dfe12acb7d8df2ad146fd22b407c4deb07930fe20d0d6ac5281abd045a
sdk.d.mts                     b229f9092f105eaa88253b6831e8a8ac1caa471b2a469d9c750a1a522ef14eaa
STORAGE.md                    aa7dd5c989354bbfa955943e382a90d80fc16c962fc27a9879dac0f86fefc521
backend/tip-retry.verify.mjs  d3c668581af3f05fb15aff1e82c1efc903c755bbf3c2cd04d30d38d07be951e9
tests/qa.test.mjs             cc0878a76f3e7e769ddc3195fb9fbce942b6a87a8f424f9ff4457f1c6b3f8492
tests/shutdown.test.mjs       c1a9a9ab443ea65a59567283f8525c7315a61c45e1995e5e965b10a02d0764f7
```

---

## Preserved initial QA report — initial verdict FAIL

## Scope and method

Implementation team completion was confirmed before this review. I read all 47 lines of `BUILD_SPEC.md`, all authored product modules, declarations, storage documentation, README, and existing verification sources. No evaluator/reference, external service, company document, dependency download, deployment, or browser was used. Only synthetic local fixtures were generated, under the external `DATA_DIR`.

Only `tests/qa.test.mjs` and this report were authored. Product/protected files were not changed. The new suite contains 11 independent black-box groups; the Node harness runs the selected runtime's actual service, CLI and typed `.mts` SDK consumer. It does not rely on Bun's incomplete nested `node:test` execution. Normal client/server traffic used loopback only. The client group successfully bound the supplied `PORT` (4125); other groups used port 0. All owned servers/children were stopped, including forced cleanup after the demonstrated Bun shutdown failure. No unrelated process was stopped.

## Findings

### F1 — HIGH / FAIL: Bun cannot gracefully drain an incomplete accepted HTTP mutation

Requirement: BUILD_SPEC.md:9,36–37: on `shutdown\n`, drain accepted writes, close the listener, release ownership and exit 0.

Relevant implementation: `app.mjs:27–35`, especially awaiting `server.close()` at line 31 before closing the service; `backend/service.mjs:39–45`. The direct service-adapter drain check passes, but it does not establish correctness of the real Bun HTTP listener during shutdown.

Reproduce in PowerShell:

```powershell
$env:RELAY_TEST_RUNTIME = (Get-Command bun).Source
& $env:NODE_EXE --test --test-name-pattern='real HTTP graceful drain' tests/qa.test.mjs
```

`tests/qa.test.mjs:661–692` opens an actual authenticated POST with a correct Content-Length, sends its first 10 body characters, waits 60 ms, writes `shutdown\n` to the owning process, then finishes the valid body after another 60 ms. The final minimized case uses `agent:false` and has no preceding aborted request, excluding pooled keep-alive and the abort regression as necessary causes.

**Observed repeatedly on Bun 1.3.14:** the service remains alive past the 15-second cleanup bound; the response fails with `ECONNRESET` when the harness finally terminates its own hung child. The final assertion is “Graceful shutdown must exit after draining the accepted mutation (15-second bound).” An earlier keep-alive variant returned HTTP 201 but still failed to exit. **Node 24.22.0:** the same minimized case returns 201, exits 0, and the staged import/event survive reopening. This is not an expected-failure/skip; the test remains failing for Bun.

Required cross-boundary work: parent/API coordinator must correct real-listener shutdown under Bun, preserving accepted mutations, response completion, exclusive ownership and exit 0. Recheck both runtimes afterward. No product fix was attempted by QA.

### F2 — MEDIUM / OPEN: intermittent Windows tip publication failure rejects valid mutations

Relevant code: `backend/data.mjs:346–377`, particularly `rename(candidate, filename)` at line 371; transaction poisoning at lines 609–618. Requirements implicated: reliable connected writes and durable/atomic transaction publication (BUILD_SPEC.md:7,36–37). A genuine filesystem failure can legitimately have an uncertain outcome; the finding is the observed intermittent reliability failure in this supported environment, not evidence of acknowledged data loss.

Normal unmodified-service runs intermittently returned **HTTP 500** for the first valid bootstrap `POST /v1/workspaces` on a fresh synthetic directory. This occurred with both runtime arms. It failed Node's earlier combined run (32/33) and Bun's final combined run (20/22). There was no competing writer for those directories. Retrying an entire fresh-directory run can pass; this issue is not deterministic.

A separate finite Node diagnostic ran 60 fresh stores/first creations, with in-memory instrumentation of filesystem calls before importing the unchanged app. **1/60 failed.** The failure captured `rename: EPERM`; the affected fixture `DATA_DIR/qa-io-probe-LVYCsa` had two journal records but an acknowledged tip of sequence 1. All 60 diagnostic children stopped (`liveChildren: 0`). Directory-handle `sync: EPERM` was also observed, but that is the documented/handled Windows directory-fsync limitation, not the unexpected operation. No fault was injected and no product file was edited.

Earlier affected fixtures `qa-auth-R63LqW` and `qa-drain-mgXZxR` likewise retained two journal records with tip 1. Their failure bodies were safe JSON, without capability disclosure. Source inspection shows subsequent store operations are deliberately poisoned until restart, and the documented unacknowledged-tail recovery preserves the appended transaction. No successful-response rollback was observed.

Reproduction: repeat the fresh-fixture creation groups in `tests/qa.test.mjs` against Node/Bun on this filesystem; even workspace creation in fixture setup can fail before the targeted test begins. The final Bun failure was setup of the anchored-corruption group (`tests/qa.test.mjs:568`, creation at line 148), not acceptance of a corrupt journal. A focused rerun of that group passed.

Required cross-boundary work: storage coordinator should investigate safe bounded handling of transient tip-rename EPERM, without weakening atomic replacement, poisoning on unrecoverable errors, symlink checks or durability. QA has not classified arbitrary real I/O failure as a successful mutation or waived the failure history.

## Commands and measured results

`NODE_EXE` was Node v24.22.0; `bun` was v1.3.14. Commands below ran with the provided external `DATA_DIR`. PowerShell environment assignments select child runtime only for the shown invocation.

| Command | Measured result |
| --- | --- |
| `& $env:NODE_EXE scripts/check.mjs` | PASS, 16 authored executable/consumer files checked after QA addition |
| `bun scripts/check.mjs` | PASS, 16 files transpiled without execution |
| `& $env:NODE_EXE --test tests/client.test.mjs tests/startup.test.mjs tests/integration.test.mjs tests/qa.test.mjs` | Final run PASS **33/33**, 0 skipped; earlier run **32/33** due F2, retained above |
| `$env:RELAY_TEST_RUNTIME=(Get-Command bun).Source; & $env:NODE_EXE --test tests/integration.test.mjs tests/qa.test.mjs` | Final run FAIL **20/22**, 0 skipped: F1 and F2; existing integration **11/11** |
| `bun test tests/client.test.mjs tests/startup.test.mjs` | PASS **11/11**; no nested integration coverage claimed from Bun's test runner |
| `$env:PORT='0'; & $env:NODE_EXE backend/verify.mjs` | PASS **1051 checks**, `liveChildren:0` |
| `$env:PORT='0'; bun backend/verify.mjs` | PASS **1051 checks**, `liveChildren:0` |
| Bun-child focused `--test-name-pattern='real HTTP graceful drain'` | FAIL, confirmed independently of the full suite |
| Bun-child focused `--test-name-pattern='anchored corruption'` | PASS **1/1** on final follow-up after F2 interrupted setup |

Initial raw-duplicate-header harness requests omitted Host because Node does not add it for header arrays. That QA harness defect was corrected before the final measurements; its parser failures are not product findings. No product failure was retried inside a test or converted into a pass/skip.

## Requirement coverage

| BUILD_SPEC requirement | Independent evidence and outcome |
| --- | --- |
| Startup, JSON readiness, loopback, health, invalid startup, current runtimes | PASS on Node/Bun; rejection before readiness for second writer/corruption. Graceful real HTTP drain FAIL on Bun (F1). |
| Workspace creation/replay, current auth, all five roles and tenant separation | PASS: role/read/write matrix; bootstrap excluded from business; cross-tenant 403, own absent import 404, missing/unknown/malformed/duplicate auth 401; issuance/revocation owner-only; bad IDs/names/subjects/roles rejected. F2 intermittently interrupts otherwise valid creation. |
| Mutation validation and process survival | PASS: exactly 262,144-byte valid JSON accepted; 262,145 rejected 413; invalid UTF-8/JSON, arrays/null, malformed media types, duplicate media/key headers, bounded/duplicate query parameters and malformed encoded paths; aborted body followed by healthy request. |
| CSV parsing, bytes, rows and atomic staging | PASS: exact 65,536 UTF-8 bytes with 500 rows staged **and committed**; 65,537 rejected; 1 row accepted/501 rejected; BOM, CRLF/LF, quoted commas/doubled quotes, 80-codepoint astral name, 120-character email and 32-character ID; bad quote/column/operation/control/duplicate-ID/interior-empty/delete-field cases rejected atomically. |
| Idempotency and authorization on replay | PASS: canonical property-order replay, exact CSV digest, changed body including extra field conflict, subject namespace (two capabilities sharing a subject), distinct-subject independence, staging replay after revocation denied, retained keys across restart. Commit exact replay after expiry/restart; changed key/body or different precise worker capability denied; revoked capability denied. |
| Approval/rejection/cancellation/terminal states | PASS: creator/approver subject separation even across capabilities, repeated same-subject approval event-free, other approver conflict, reason validation, owner/original-editor cancellation only, approved/leased cancellation fencing, no rejected/cancelled/committed reactivation. See interpretation note below. |
| Lease concurrency and fencing | PASS: 8 simultaneous claims yield exactly one winner; exact epoch increments; nonexpired same-subject claim denied; expiry, old-token fencing, wrong subject, same-subject different capability, revocation and fresh same-subject replacement denied; persisted active lease/epoch across abrupt restart. |
| Commit atomicity, members, revisions and versions | PASS: 6 concurrent exact commits yield one event/version; competing stale-base commits yield one winner; whole-workspace email uniqueness including lowercase collisions; valid atomic swap/delete-and-reuse; missing-delete and late collision roll back the whole batch; member sort/revisions and state survive abrupt restart. |
| Audit | PASS: pagination including empty-page nextCursor, contiguous stable cursors, exact public event fields/types, one event per successful state change, none for rejected operations/repeated approvals/revocations/replays, persistence across graceful/abrupt restart; no captured capability/lease secret in events/errors/logs/scanned runtime files. |
| Exclusive ownership and hostile/corrupt runtime paths | PASS: live second writer refused; 6 simultaneous dead-owner reclaimers yield exactly one ready process; unrelated sentinel/candidate files retained; reserved file/directory conflicts, file symlinks and lock-directory junction rejected without touching targets. |
| Journal and acknowledged-tip integrity | PASS: complete-record suffix loss with metadata retained, partial trailing record, valid-JSON changed transaction, checksum mismatch, reorder, gap, missing LF, empty/invalid UTF-8 journal and missing initialized journal/tip fail closed without rewriting journal. Older valid tip + complete later tail advances tip and retains data/events without journal rewrite. F2 remains open. |
| Real CLI and typed SDK | PASS: every required command and SDK method exercised against live Node/Bun services; BOM-preserving staging, role failure and malformed secret-flag failure, single success JSON/error stream, shared durable state, correct RelayError numeric status/string code, typed `.mts` consumer via each runtime, restart read-back. Declarations reviewed: exact unions/shapes and no `any`. |

Interpretation note: `backend/api.mjs:169–176` allows the original approver's repeated approval even after cancellation/commit, returning the still-terminal import with no event. The spec both restricts initial approval to staged imports and promises the same approver's repeat succeeds. Tests explicitly require no terminal reactivation; this behavior is reported rather than treated as a demonstrated violation. Extra fields are not globally forbidden by the spec; `{}`-only operations reject them, and staging replay comparison detects changed extras. Arbitrary nonempty-body extras on other operations are not asserted to be a contract violation.

## Limitations and remaining work

- No `tsc` command is available (`Get-Command tsc` failed). Declaration review, syntax/transpile checks, and actual typed-consumer execution passed; **TypeScript semantic checking was not performed**.
- Abrupt owned-process termination and a synthesized valid journal/tip crash window were checked. Actual machine power loss, every possible filesystem failure/crash instruction boundary, hostile local administrator activity and sustained performance/storage exhaustion were not exhaustively tested. Windows directory-entry power-loss durability is already limited in `STORAGE.md:97–99`; file fsync was not waived.
- F2 is intermittent; final Node success does not erase its earlier failure or the diagnostic EPERM. Bun's final corruption fixture setup was interrupted by F2, then explicitly rechecked successfully.
- Parent-reserved `scripts/verify-owned.mjs` was not run by QA. Its workflows were independently exercised here, including a service on `PORT`; the parent still owes its final personal verification after fixes/judge.
- Final loopback check found no listener reachable on verification port 4125. Test cleanup awaited owned child exits; no verification terminal was left open.
- Required next step: parent routes F1 to the API/root owner and F2 to storage owner, then resumes this same QA identity for final-state recheck. QA made no implementation fixes and gives no acceptance waiver.

Reviewed product SHA-256 fingerprints (for follow-up state comparison):

```text
app.mjs                 09874b20df23f39dfd6c125de78b8112572f280f79e11b0a128a2401da903cd7
backend/data.mjs        81df0fcd7e767677c906210c331b234286cb8461ac5919ac97732dd4041fb228
backend/api.mjs         0da891e29a22ed8e9a294b2a090caae374dc2dd0f75ffc8dca593ff9e1a0202b
backend/service.mjs     7d99732c39acbb1f0ecc47f06b59afbfe2c4e9449bb5de9f08cce283e0a49b34
backend/validation.mjs  71f9555abef95c44a46bf10d9995bf935bb5dcac3622e122cb02bc7d2b3e66b6
cli.mjs                 cc3da69363f9a279de92fa8e38e080b118a3fcf42af14543f4a4f523c5006668
sdk.mjs                 680449dfe12acb7d8df2ad146fd22b407c4deb07930fe20d0d6ac5281abd045a
sdk.d.mts               b229f9092f105eaa88253b6831e8a8ac1caa471b2a469d9c750a1a522ef14eaa
```
