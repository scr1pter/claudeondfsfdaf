# Linear refresh durability

Review finding: Everywhere correctness/security C4 in `v2-notes/connect-everywhere-review-findings.md`.
Source base: `release-finish` at `c8cffe0e7`, including `40e708614`'s unchanged credential implementation.

Previously, a successful OAuth refresh was saved only after a separate viewer request succeeded. Linear can consume
the old refresh token during that exchange. A viewer outage, rate limit or exhausted activity deadline then discarded
the only usable replacement, leaving the installation's stored refresh token invalid.

The replacement is now sealed and saved under the exact current installation/account guards before the viewer probe.
It is marked pending, so the ordinary fresh-access shortcut cannot return it. A retry uses this durable pair to retry
the viewer; it does not consume another refresh token while the new access token is still fresh. Only a valid matching
app viewer and organization clear the pending state. Temporary failures or malformed replies leave it pending; a
definite identity mismatch quarantines it and requires reconnecting. Both persistence steps are fenced against
reconnect, installation erasure and account deletion. Authorization revision stays unchanged during a valid refresh.

Pending and rejected pairs use opaque credential version 2. Older deployed readers, which accept only version 1,
therefore refuse them rather than returning an unverified fresh token during a rolling deployment. Verified pairs
remain version 1. This changes no public endpoint, Protocol/HttpApi schema, SDK, feature switch or model budget.
Credentials remain encrypted in the installation record and never enter a computer job or log.

The change protects against failure of the follow-up viewer operation after the replacement was durably written. It
does not make the provider's token exchange and the local store one transaction: a store failure before that first
write may still require reconnecting. A changed or deleted authority is never restored to preserve a token.

Regressions cover persistence before a 503, a 429 or a malformed viewer reply; verification on retry without another
refresh; the activity deadline elapsing immediately after rotation; definite mismatch refusal; and reconnect,
installation erasure and account deletion while the new viewer is in flight. The existing concurrent-refresh and
pre-probe authority-race checks remain intact. All native requests in these tests use an explicit loopback fixture;
no live OAuth service or owner credential is used.

## Validation

Executed serially on Windows with Bun `1.3.14`, after `bun install --frozen-lockfile --ignore-scripts` (lockfile
unchanged). No full suite or live provider was used.

| Directory | Command | Result |
| --- | --- | --- |
| `packages/web` | `bun test --timeout 30000 ./test/everywhere-linear-oauth.test.ts` | 15 passed, 112 assertions, exit 0 |
| `packages/web` | `bun test --timeout 30000 ./test/everywhere-linear-webhook.test.ts` | 15 passed, 146 assertions, 4 explicit disposable-Redis skips, exit 0 |
| `packages/engine` | `bun run typecheck --project ../../tsconfig.json` | API types passed, exit 0 |

The initial new 503 regression expected `LINEAR_UNAVAILABLE`; the existing client correctly reports
`LINEAR_DELIVERY_UNCERTAIN` for a 503. Only that expectation changed; the final run above passed with native error
semantics intact. The Redis-only webhook cases have not executed locally, and their skips are not acceptance receipts.
