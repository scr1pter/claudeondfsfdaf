# Account erasure integration

Source base: `build-complete` at `00b87034faa1e3c1604ab7160f5e5c33f3745805`.

The canonical `ERASE_PARTS` list now includes GitHub cloud-agent bindings, run records and opaque Brain uploads, plus
Everywhere's existing installation, link, job and private-content eraser. Both account deletion and its retry cron use
that list. The parts run with the deletion's fetcher and remain configured when their feature switches are off. They
check the request deadline between store commands.

The original ordering remains: tombstone, account-token revocation, closing entitlement, billing cancellation, service
erasure, Codium records and keys, erase marker, usage counts, identity deletion. A failed cloud-agent or Everywhere
part also blocks the Codium-record and key parts, retains the identity, and is retried through the existing tombstone
backoff. The existing delayed-writer barriers remain: account revocation for cloud-agent storage and the permanent
local account-closed marker for Everywhere. No billing or identity service is called by either service eraser.
The follow-up check pass re-asserts the account revocation before it erases again, and stops at stage `revoke` when that
write fails, because the cloud-agent eraser requires the live mark and a pass kept waiting on the workspace host can
outlast the mark's 100-day expiry.

Tests cover default registration and dependencies, each service failing and recovering through the actual deletion
request/cron, feature-off erasure, and deadline refusal before another store call. The populated Everywhere erasure
test resolves its part through the canonical registry. The disposable-Redis cloud-run suite also exercises that
registry part against bound runs and an unrelated account, including revocation refusal and an idempotent retry.

The older account-deletion fixtures have no GitHub bindings or Brain uploads. They now answer only those explicit
empty-index cases and persist the fake revocation mark; the populated Lua cases remain tests against disposable Redis.
The accounting fixture recognizes the exact retained security markers rather than treating them as leaked content.

## Validation

Executed serially on Windows with Bun `1.3.14`; install used `--frozen-lockfile --ignore-scripts` and left the lockfile
unchanged. All commands ran from the named subdirectory.

| Directory | Command | Result |
| --- | --- | --- |
| `test` | `bun test ./account-delete.test.ts` | 31 passed, 1 explicit Valkey-only skip, 310 assertions, exit 0 |
| `test` | `bun test ./account-delete-api.test.ts` | 8 passed, 52 assertions, exit 0 |
| `packages/web` | `bun test ./test/everywhere-erase.test.ts` | 10 passed, 147 assertions, exit 0 |
| `packages/web` | `bun test ./test/cloud-agents-runs.test.ts` | 0 passed, 1 explicit disposable-Redis configuration skip, exit 0 |
| `packages/engine` | `bun run typecheck --project ../../tsconfig.json` | API types passed, exit 0 |

The first account-deletion run had one stale order expectation that omitted the two newly independent parts after
an unrelated part failed. The expected order was corrected; the final run above passed. No production behavior or
failure assertion was relaxed. The populated GitHub-run registry regression has not executed locally because no
disposable Redis URL is configured; its skip is not an acceptance receipt. Existing seeded Everywhere erasure and
the new actual deletion-request/cron recovery regressions did execute. No full suite, native package or browser run
is claimed here.

No deployment, account deletion against a real service, paid provider request, or production configuration change is
part of this source change.

## Combined cloud-workspace validation, 2026-11-14

After integration with cloud workspaces on `release-finish` (parent `2e992c59fdc1bce9c23f871dcdd35b939a9790ce`), the
existing workspace deadline test stalled at its timer-only fake fetch. The retained initial run had no terminal
totals and was stopped by its owner. An isolated attempt that restored the real system clock still stalled and was
terminated by an independent 40-second process watchdog; that attempt is not a passed test.

The fixture now makes a genuine HTTP request to an ephemeral `127.0.0.1` server that holds the response open. The
production abort signal reaches the real fetch implementation, with the original 1,000 ms deletion deadline. The
fixture checks that one request actually reached the server, that the workspace part failed, and that no identity
deletion or email occurred. A `finally` closes every connection and the server. Production timeouts and deletion
policy are unchanged. The observed result establishes the corrected fixture, not a general diagnosis of Bun internals.

Both commands ran serially from `test`, with streamed logs and independent process bounds:

| Command | Result |
| --- | --- |
| `bun test ./account-delete.test.ts -t "cloud workspaces: a host that never answers" --timeout 30000` | 1 passed, 1 existing Valkey-only skip, 6 assertions, exit 0; native request aborted in about 1.04 seconds |
| `bun test ./account-delete.test.ts --timeout 30000` | 34 passed, 1 existing Valkey-only skip, 369 assertions, exit 0, 1.59 seconds |

Logs: `account-deadline-clock-fix.log` (stalled isolated attempt), `account-deadline-http-fixture.log` and
`account-deletion-http-fixture-full.log` under the coordinator's `release-audit-20261114` evidence directory. The
disposable-Valkey case remains explicitly unexecuted locally. No new API code or public contract changed in this
fixture repair.

## Real-supervisor deletion contract

`test/account-delete.test.ts`, describe "cloud workspaces against the real supervisor", runs the website's staged
deletion through the real `handleAccountDelete` and `handleAccountDeletions` handlers against the workspace host's own
`createWorkspaceService` and `WorkspaceStore` (packages/cloud-workspaces) on SQLite in a temporary directory, in place
of the fixture's fake host. On the host side only the container runtime is a stand-in (no Docker); the website side
keeps deletionWorld's service fakes and injected revoke, forget and sign-in, and the model origin is never called. It
proves that the gateway's signed `/accounts/close` fences the account on the host (a signed list then answers 403
`ACCOUNT_CLOSED`); that the identity goes while one workspace's volume refuses erasure; that the follow-up pass reads
the host's own `remaining` and stays pending at stage `check` with `workspaces, codium, keys` until the host's reaper
erases that volume, then finishes, after which a signed close answers `{ "closed": true, "remaining": 0 }`; and that a
host restart between the deletion and the follow-up pass keeps the fence (403 before any new close) and the leftover
workspace, which the restarted reaper finds through the persisted `closed_account` row and erases. The first case also
removes the account's revocation mark before the final pass: the pass's injected revoke (the fixture's `markRevoked`)
writes it again and the deletion still finishes (DP-2's check-pass re-assert, with the fixture's revoke; not the real
revocation write). The real revocation store write is not exercised here, nor are the real runtime's container and
volume removal under runsc and the quota driver, or a deployed host behind ingress (cloud-workspaces.md, "Operator
setup"). Local run, Bun 1.3.14, from `test`: 41 pass, 1 Valkey-only skip, 0 fail.

**21 Nov 2026 (`codium-api-fixes`).** That first case no longer injects a revoke: the request and both follow-up
passes run the production `revokeAccountTokens` against the fixture store, which now answers Upstash's path-style
`/set/<key>/<value>?ex=` and `/get/<key>` (packages/web/test/fixture/codium-fakes.ts; no production change). The case
asserts the mark is `1` with a lifetime above 99 days after the request and after each pass, that
`accountTokensRevoked` reads it back (and reads `false` once the test removes it), that the relay stand-in received one
`kill`, and that the default writer sets the removed mark again before the final pass finishes (DP-2). Mutation: the
writer's `ex` set to 60 seconds fails the case. The other cases keep `markRevoked`, since they test ordering and
failures. Still operator validation, not run here: the real runtime's container and volume removal under runsc and the
quota driver, and a deployed host behind ingress. Local run: 44 pass, 1 Valkey-only skip, 0 fail (three new A46 cases
in the same file).
