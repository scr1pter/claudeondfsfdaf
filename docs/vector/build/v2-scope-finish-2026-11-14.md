# v2 Scope integration repairs — 14 November 2026

Base: `v2-scope` at `76b5619f1b63038c7c2fe7bbb9edb653baacbe6f`.
Read-only CI diagnosis used run `43568981988`, specifically Linux unit job
`132369001912`, Windows unit job `132369002069`, and Linux engine shard job
`132369001889`. These jobs failed; this note does not replace their results.

## Cause and changes

- The Linux unit job recorded 164 failures and Windows recorded 165. Of the Linux
  failures, 139 runner, 20 research, three Local mode and one recorded-runner
  failure share the new mandatory review-memory history boundary. Their direct
  SQL session fixtures omitted the durable audience registration that real
  Session creation performs. The four fixture seed helpers now invoke the actual
  `SessionAudience.register`; production unknown-history and fenced-history
  refusals are unchanged.
- Four engine structured-output request tests supplied an invented Session ID.
  They now create an actual Session, explicitly expose that service in their
  test layer, and do not discard stream failures. The fake now supplies valid
  Responses and Gemini stream replies as well as Anthropic replies, allowing
  every provider's existing request assertions to execute after a real request.
- The pipeline source pin was stale. Review-memory inference enforcement changes
  the pipeline boundary, so revision 2 invalidates older certificates and pins
  this branch's normalized source digest `79e8f53d9a7784fe`. The approved model
  evidence list remains unchanged and empty. The final aggregate must recompute
  its source pin after integrating its additional pipeline changes.
- Windows additionally failed immediate synchronous temporary-directory removal
  with `EBUSY`. That fixture now uses the existing GC/retry-aware directory
  disposer; no test assertion or production cleanup policy was removed.

## Observed focused validation

Bun 1.3.14 on Windows, with Node 24.22.0 on PATH. Dependency installation used
`bun install --frozen-lockfile --ignore-scripts` (3,753 packages, exit 0). Each
named file ran alone from its package directory using
`bun --no-env-file test --timeout 30000 <file>`, with isolated test configuration
and the existing loopback-only engine network guard. No paid provider ran.

| Package / file | Pass | Fail | Assertions |
| --- | ---: | ---: | ---: |
| Core `test/session-runner.test.ts` | 140 | 0 | 604 |
| Core `test/session-runner-recorded.test.ts` | 1 | 0 | 5 |
| Core `test/local-mode/v2-model-calls.test.ts` | 4 | 0 | 20 |
| Core `test/session/research-v2.test.ts` | 21 | 0 | 142 |
| Core `test/review/model-evidence.test.ts` | 30 | 0 | 393 |
| Core `test/review/memory-fence.test.ts` | 18 | 0 | 187 |
| Core `test/background-job-store.test.ts` | 17 | 0 | 84 |
| Engine `test/session/structured-output-thinking.test.ts` | 8 | 0 | 36 |

These are 239 passing focused cases, not a full-suite or hosted-CI result.

## Pending combined checks

The engine shard also timed out a journey performing three sequential real
reviews inside one 30-second outer test. Its outer bound is now 60 seconds;
each individual review still has the original independent 15-second settlement
bound, and all discovery/idempotency/privacy assertions remain. That changed
HTTP case has **not run locally**. Core and Engine typechecks, formatting checks,
generated-client parity, and full hosted CI are also **not run** at this repair
checkpoint; the coordinating agent owns those checks on the combined source.

No branch was merged into `main`, feature activated, model approved, service
deployed, owner desktop operated, or release published by this package.
