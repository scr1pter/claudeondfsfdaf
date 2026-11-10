# Local verification

All verification uses synthetic capabilities, CSV and rosters. Test processes use
fresh subdirectories of the supplied `DATA_DIR`, outside authored source. No
dependencies were downloaded and no evaluator, company documents, accounts or
external services were used. The service is local only and has not been deployed.

The root integration harness is `verification/integration.mjs`. It starts the real
service, calls its HTTP endpoints and SDK, spawns the real CLI, and stops every
process it owns, including on failure. Node 24.22.0 and Bun 1.3.14 each passed
**10 groups and 375 assertions**:

- Workspace creation and exact keyed replay, authentication, tenant and role
  isolation, initial empty state, and exclusive writer refusal.
- CSV quoting, BOM/CRLF, row and byte bounds, unsafe fields, duplicate IDs, bad
  JSON media type, invalid UTF-8, request-size limit and bounded event queries.
- Canonical staging replay and independent subjects, approval separation and
  repeats, terminal states, simultaneous claims, and commit replay.
- Atomic email swaps, duplicate final emails, nonexistent deletes and stale bases.
- Expiry, epoch fencing, precise capability binding, durable revocation and
  cancellation, rejected-operation audit behavior and contiguous event pagination.
- Every required CLI command and SDK method, sanitized CLI errors, SDK errors and
  the typed SDK example operating against shared durable state.
- Simultaneous staging replay and competing commits with one version winner.
- Graceful restart, abrupt process death, dead-owner recovery and replay recovery.
- Shutdown during an accepted streamed request, followed by durable recovery.
- On-disk secret checks and fail-closed recovery for partial, changed, reordered
  and sequence-gapped journals.

Strict TypeScript checks pass using the provided `TYPESCRIPT_COMPILER`:

```text
node TSC_PATH --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM verification/sdk-types.mts
```

This checks exact role/state unions, every SDK method and return shape, and
expected type errors for malformed argument types and missing required arguments.
The same typed module also runs against the local service during integration.

The service was launched on the supplied `PORT` (4125), and the permitted browser
driver client navigated to `http://127.0.0.1:4125/health`, receiving status 200 and
`{"ok":true}`. It then stopped through its stdin shutdown command with exit 0.
There is no graphical interface to inspect under this build specification.

An initial Windows piped-stdin shutdown defect was found and corrected: after
HTTP requests drain and storage releases ownership, stdin is destroyed/unreferenced.
The streamed-write shutdown regression now passes.

Platform limits: executable verification runs on Windows with the installed Node
and Bun runtimes. Full machine power loss and other operating systems are not
simulated. The journal intentionally keeps full transaction snapshots and does
not compact. Other than the documented safe-recovery paths on Windows and Linux,
stale-lock recovery fails closed on unsupported platforms.

The same QA specialist completed a final repaired-state recheck: **194 independent
checks with zero findings on each runtime**, plus the 375-assertion integration
suite on each runtime and strict TypeScript checks. All four alias regression
flags were true; no alias tests were skipped. Details are in [QA.md](QA.md).

QA and the whole-team judge initially identified three material defects. All
were corrected: linked/replaced ownership paths are preserved and refused;
changed parsed JSON under a used key conflicts before field validation; and
the original approver's retries succeed after later transitions without changing
the import, lease, version or events. Safe-release failures also close stdin so
Windows piped processes exit instead of hanging. The same QA specialist reran
the final implementation after these repairs. Whole-team review is in
[REVIEW.md](REVIEW.md).

The same whole-team judge completed final review with **PASS**, independently
rerunning the 194-check suite on both runtimes and strict SDK compilation.

After that final review, the root agent personally reran the completed application:

| Final root check | Result |
| --- | --- |
| Node integration (live API, every CLI command and SDK method) | 10 groups, 375 assertions passed |
| Bun integration (live API, every CLI command and SDK method) | 10 groups, 375 assertions passed |
| Node adversarial QA regression suite | 194 checks, zero findings; all alias checks ran |
| Bun adversarial QA regression suite | 194 checks, zero findings; all alias checks ran |
| Strict SDK declaration and typed example checks | Passed |
| All service, CLI and SDK JavaScript syntax checks | Passed |
| Final browser-driver health check on supplied PORT 4125 | HTTP 200, `{"ok":true}` |
| Final stdin shutdown and listener check | Exit 0; no listener remained on PORT |

All final commands exited 0. All verification servers have stopped. Runtime data
remains under `DATA_DIR`; the independent evaluator was never read or changed.
The protected `BUILD_SPEC.md` remained unchanged, SHA-256
`A85C62DE50F23145BFC3EE6DB261DB08C565889FF8DF0A7808BAE1143B968351`.
