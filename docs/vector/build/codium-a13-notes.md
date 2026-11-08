# A13 Vercel spend webhook

A13 is implemented on `codium-next`; focused checks and independent static review passed. The required full pre-push checks, canonical source push and complete CI remain pending. No Vercel account API, webhook setting, budget, deployment or live payment service was called or changed.

## Signed callback contract

`POST /api/owner/spend-vercel` disables the body parser and reads at most 16 KiB of original bytes. It rejects a parsed substitute body. `x-vercel-signature` must be one 40-digit hex HMAC-SHA1; comparison uses `timingSafeEqual`. The route verifies against configured team secrets before decoding JSON, then binds the signed `teamId` to that exact secret/team pair. Unknown teams, missing secrets, cross-team signatures and ambiguous duplicate main/hosted team IDs cannot mutate state or send notifications.

The documented Spend Management callback is flat: `teamId`, `budgetAmount`, `currentSpend`, `thresholdPercent`. Numeric fields must be safe nonnegative integers. Zero amounts are valid; the signed whole-percent `thresholdPercent`, rather than a ratio inferred from rounded spend/amount values, decides the action. This is not the general Vercel `budget.reached` event envelope. There is no trusted timestamp or billing-cycle identity with which to infer that a callback is old or to reopen service automatically.

The main team only sends owner notifications. Hosted callbacks at 50% notify, at 75% atomically set at least `hosted=no-new`, and at 100% atomically set `hosted=stop`. Higher values retain the 100% action. Lower callbacks never weaken a stronger existing state, including an owner stop. Only an explicit owner switch change can de-escalate; a subsequently delivered old callback may escalate it again because its age cannot be authenticated.

## Atomic guard and notification ordering

`escalateHostedSwitch` compares the actual stored state (`on < no-new < stop`) and writes its new generation and audit entry in one Valkey script. It accepts legacy bare switch values and refuses corrupt records without replacing them. A no-op preserves the previous generation and does not append an audit. The helper invalidates the local cache rather than caching its returned state: an older response arriving after a stronger concurrent write cannot restore a weaker cached guard.

The guard write precedes the fallible notification. Missing mail configuration, a failed send or an unavailable store returns a retryable failure without claiming delivery or marking the callback done. Retrying preserves the guard and uses the existing owner sender's daily threshold/team deduplication. Responses and switch audits contain no budget amounts, email addresses or secrets. The route has no Vercel account/deployment fetch and does not pause production deployments.

## Source evidence

The contract cites Vercel Spend Management and webhooks documentation, last updated September 18, 2026. Direct access to `vercel.com` is excluded by this environment's HTTP allowlist; that restriction was not bypassed. Independent source review found matching cached copies of the canonical docs:

- [Spend Management, pinned cache fetched October 26](https://github.com/joeblackwaslike/agent-skills/blob/5ee9024524879d0fa619846a5a1e092964561dcf/skills/working-with-vercel/references/docs__spend-management.md), lines 179–192: flat payload and integer fields, including `thresholdPercent`.
- [Webhook API, same pinned cache](https://github.com/joeblackwaslike/agent-skills/blob/5ee9024524879d0fa619846a5a1e092964561dcf/skills/working-with-vercel/references/docs__webhooks__webhooks-api.md), lines 1227–1278 and 1508–1512: original body bytes, `x-vercel-signature`, HMAC-SHA1 hex and constant-time comparison.
- [Official Vercel example, independently pinned](https://github.com/vercel/example-marketplace-integration/blob/75c0bc050071709f7de037166ddd7056143bd883/app/webhook/route.ts): corroborates the raw-body signature algorithm/header. Its marketplace event envelope is not used as evidence for the Spend callback shape.

A13 implements part of M9 and S4. Owner configuration and a protected real-provider acceptance check remain launch tasks; local implementation does not enable hosted work or sales.

## Validation

The focused file covers raw whitespace/Unicode signatures, malformed/duplicate headers, exact team binding, missing configuration, malformed payloads, all threshold boundaries, zero amounts and threshold/ratio disagreement, duplicate/reordered callbacks, owner stop/reopening, legacy cycle callbacks, notification/store failures, corrupt state and privacy. Four real-Valkey cases cover parallel 75/100 callbacks, a concurrent owner stop, corrupt-record refusal, and delayed older responses versus the local cache. All files ran individually through `vector-serial` from `packages/web` with a thirty-second per-test timeout, local fake providers and an ephemeral localhost Valkey. The server was stopped after the tests.

- `test/codium-vercel-spend.test.ts`: **56 passing**, including all four real-Valkey cases.
- `test/codium-switches.test.ts`: **19 passing**, including its two real-Valkey mutation/audit cases.
- `test/codium-owner.test.ts`: **34 passing**, including its real-Valkey atomic intent case.
- API typecheck from `packages/engine`: `bun typecheck --project ../../tsconfig.json` passed.

Total: **109 passing tests across three files**, including **seven explicit Valkey cases**. No local failures remain. Independent review checked the raw-byte signature/team boundary, documented payload, main-team notification-only path, monotonic audited Lua, notification failure ordering, corruption handling, and the delayed-response cache regression, and found no confirmed blocker or material acceptance gap. The canonical full hook also checks the web package's shared fixture typing before push.

The next tree also contains only the two parent-reviewed app fixture repairs cherry-picked as `4e26f55d` and `6d8f6383`; their main-branch ancestry was not merged. Canonical A12 remains at `eb1a3f3b`; its full [Codium CI run 40794049792](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40794049792) passed tests, browser specs and all eight typechecks.
