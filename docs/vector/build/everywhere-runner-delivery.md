# Everywhere runner delivery and bounded engine reads

Source validation: 2026-11-14, isolated `runner-delivery` worktree based on `815b7bdb2`. This is a source-only Tier B repair for the Everywhere C3, C5 and C6 findings. No feature flag, hosted adapter, credential or owner application was enabled.

## Behavior

- A confirmed push is settled as `changes`. Lost acknowledgements retry the same lease and payload, at most three attempts. No catch path replaces that result with a claim that nothing was published.
- Before a remote push, the private atomic job ledger records a fixed uncertainty receipt. After confirmation it records the exact result, including the checked summary and any PR link. Unacknowledged receipts survive restart without retaining an active execution slot. Recovery retries delivery only; it never restarts a model or pushes again. The same job cannot be offered again while its receipt is pending. The queue is capped at 32 receipts and malformed receipts fail closed.
- The generation deadline and stop signal still guard push admission. Once admitted, push uses an independent signal and the existing git executor's 60-second bound. If git reports an ambiguous transport error, the result explicitly says publication is unconfirmed and identifies the branch; it does not assert that the remote is unchanged.
- Local ledger-release failure is diagnosed with fixed text and cannot leave the in-memory active map stuck. Persistent reservation failures remain fail-closed until storage is repaired/recovery succeeds.
- Ordinary engine responses are read with a two-MiB byte ceiling before JSON parsing. Overflow cancels the unread body. SSE parsing bounds individual frames, processes large network chunks incrementally and supports patch events up to eight Mi characters. An oversized individual event still fails closed; an aggregate of many small frames no longer fails the former one-MiB buffer check.

## Validation

Windows; Bun 1.3.14. Frozen installation with scripts disabled completed successfully, with the lockfile unchanged. Each named test file ran separately from `packages/desktop`, using `bun test --timeout 30000`:

| File | Passed | Assertions | Result |
| --- | ---: | ---: | --- |
| `src/main/everywhere-runner.test.ts` | 33 | 210 | exit 0 |
| `src/main/everywhere-ledger.test.ts` | 6 | 29 | exit 0 |
| `src/main/everywhere-engine.test.ts` | 7 | 529 | exit 0 |

Total: 46 passed, 768 assertions, zero failures or skips. Regressions cover lost acknowledgements, exhausted delivery and restart, deadline expiry during push, expiry while journaling, ambiguous push, pre/post-push storage errors, active-slot cleanup, exact lease validation, private atomic-file recovery, streamed byte overflow/cancellation, many SSE frames in one chunk, a three-Mi-character patch event followed by idle, oversized authority frames and byte-split UTF-8/CRLF.

`bun run typecheck` in `packages/desktop` exited 1 on the pre-existing duplicate `alertTitle`/`sendPhoneAlert` imports in `packages/app/src/pages/layout/ask-notifications.ts` (base revision, lines 5 and 11). No diagnostics referenced the modified runner, ledger or engine files. The integration owner reports that separate commit `e8bc856db` repairs those imports and that App/Desktop typechecks passed there; integrated validation must verify the combined revision.

No paid runs, external services, owner UI, full local suite, or production job was used. Hosted delivery and packaged-desktop verification remain CI/owner launch checks.

## Failure limits

The journal is not a distributed transaction with git. A crash after remote acceptance but before confirmation is durably represented as publication uncertainty. If the disk fails after a confirmed push and all result delivery also fails, recovery may retain the older uncertainty receipt; it still never claims that no changes were published. A service that remains unavailable retains pending receipts for the next recovery attempt. Neither condition authorizes another run or another push.
