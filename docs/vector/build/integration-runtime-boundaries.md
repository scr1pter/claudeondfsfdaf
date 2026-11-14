# Integrated source and remaining runtime boundaries

Read-only boundary review on 2026-11-14 against the `release-finish` working tree at `57f6bf0c1`. This note is source evidence, not production or packaged-desktop qualification. No owner accounts, providers, credentials or feature flags were activated.

The reviewed integration retains these protections:

- `api/_lib/codium-erase.ts` registers workspace, cloud-agent and Everywhere cleanup before Codium records and generic keys. Those dependencies still block identity/key destruction when cleanup fails. Workspace cleanup remains mandatory with the feature switched off; partial host settings fail and retry rather than silently skipping.
- `api/_lib/everywhere/linear/credentials.ts` preserves rotated encrypted tokens as a pending version-2 record before the viewer probe, then uses exact-record and account-authority guards before promoting them. Unverified credentials cannot use the normal fresh-access shortcut.
- `packages/engine/src/connect/hub.ts` gives the qualified review service the requester's original read rules and original absolute origins; `packages/core/src/connect/policy.ts` checks both old and new diff paths. The fresh-instance cleanup repair in `packages/engine/src/project/instance-store.ts` quarantines an unconfirmed directory and catches failures per owner during disposal.

These boundaries remain intentionally incomplete and must not be described as live features merely because source branches are integrated:

| Boundary | Exact source evidence | Remaining work |
| --- | --- | --- |
| Everywhere desktop execution | `packages/desktop/src/main/everywhere-runner.ts` exports `createEverywhereRunner`; no production source caller registers it. `docs/vector/build/vector-everywhere-main-requests.md` explicitly holds VE-07 pending the safe unattended-worktree capability. | Supply and qualify the reviewed safe-worktree/desktop composition contract before enabling the laptop route. The runner repairs do not activate it. |
| Connect reaches only VectorScope | `packages/engine/src/connect/adapters/index.ts` contains only `VectorScopeAdapter.factory`. Its comments identify Hands as CW-21 and GitHub as CW-22. | Implement and qualify each member's declared effects, lifecycle, cancellation, budget and privacy boundaries; merging their separate feature code does not register them. |
| Hosted private Git credentials | `packages/hosted-computer/src/hostd.ts` requests `/api/hosted/sessions/:id/git-token`; that API route is absent. | A reviewed credential authority contract is required before this capability is usable. Keep it held rather than returning a broad installation token. |

## Why the hosted Git endpoint cannot be improvised

The provider injects the session's `vht_` run bearer into requests to the run-API host (`api/_lib/hosted-provider.ts`). That bearer establishes account/session identity; it does not establish that the caller is the privileged Git broker instead of another process in the computer. The host's Unix-socket separation and secret-free agent environment do not give a new remote API that distinction automatically.

`api/_lib/hosted-sessions.ts` already verifies signed daemon heartbeats, but this authenticates that heartbeat contract. A credential endpoint needs its own operation/body binding and replay controls. `SessionRecord` also has no owner-pinned repository/installation/access grant against which to authorize an arbitrary `{ repository, access }` request from `hostd.ts`.

A safe implementation must bind a privileged-daemon request to the exact live session, account and requested operation; check an independently owner-authorized, revocable repository/access grant; mint only that repository's short-lived minimum-permission token; and recheck revocation, deletion, billing/stop and privacy gates before releasing it. Tests must cover direct agent requests, cross-account/session/repository changes, replay, grant revocation and stale/ended sessions. Returning a token based only on a valid run bearer and model-supplied repository would bypass those missing authority boundaries.

This review found no additional definite merge regression in the listed account-erasure, Linear, Connect-read or instance-disposal boundaries. It does not replace exact-source CI, native containment qualification, packaged execution or owner launch approvals.
