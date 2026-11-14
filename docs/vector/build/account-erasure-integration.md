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
