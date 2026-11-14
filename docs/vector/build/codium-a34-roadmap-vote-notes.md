# A34: Roadmap vote

A34 follows A33 (`7236442b`) and implements the contract's WP A34 on top of A05 (the entitlement snapshot). No schema,
protocol or generated client changed, so no generator ran. No service, account, deployment or provider was called.

## What changed

- **`api/_lib/roadmap.ts` (new).** The vote's store and rules.
  - Quarters are UTC calendar quarters, written `yyyy-qn`.
  - Keys, under the Codium prefix: `roadmap:<q>:ballot` (the owner's ballot: candidates, opens, closes, and a tie's
    winner), `roadmap:<q>:ballots` (a hash: voter → `{choice, plan, at}`), `roadmap:<q>:nominations` (a hash: voter →
    `{title, detail?, plan, at}`) and `roadmap:quarters` (the quarters holding any of these). A voter is a SHA-256 of the
    account id under a fixed label, so no key or field names the account.
  - `castBallot`: only this quarter's open ballot, only one of its candidates. HSET replaces the account's one ballot
    until the close.
  - `nominateFeature`: HSETNX, so one nomination per account a quarter. Title 3–80 characters and detail up to 280.
    Whitespace runs collapse, a blank detail is no detail, and control or invisible formatting characters (bidi
    overrides included) are refused, so the owner's terminal shows what was written.
  - `ballotResults`/`tallyBallots`: after the close only, totals only, and only once 20 ballots are counted. A ballot
    counts when it was cast before the close, for a candidate on the ballot, with a plan whose `ENTITLEMENTS[plan].vote`
    is true at the time it was cast. The winner carries "Planned for the next release cycle." with no date. A tie names no
    winner until the owner records one.
  - `roadmapView`: what one account sees. This quarter's ballot while it is upcoming or open, with the account's choice.
    The results of the latest closed vote (this quarter's once it closed, else last quarter's), with the account's own
    choice. Whether it may vote, and its nomination.
  - `eraseAccountBallots(account)`: the account's ballots and nominations, in every listed quarter and this one. Ready
    for A57.
  - Owner functions for the script: `openBallot` (2–10 candidates; opens and closes inside the quarter; closes in the
    future; copy may not name a year, month, quarter or "soon"; replaced only with `replace` while nobody has voted),
    `closeBallot`, `ownerTally`, `decideBallot` (ties only, after the close, with at least 20 counted) and
    `ownerNominations`.
- **`api/roadmap/index.ts` (new).** `GET|POST /api/roadmap`. It takes only a valid, unrevoked `vct_` account token, so no
  run token (S3). Limits per account: 120 an hour, of which 30 may be writes. GET answers the view for any signed-in
  account. POST `{action: "vote", quarter, choice}` needs `requireEntitlement(account, "vote")`. POST
  `{action: "nominate", quarter, title, detail?}` needs `requireEntitlement(account, "nominate")`. Both come from the
  snapshot alone, never the client (S1). A fresh snapshot means no Stripe call (M4), and §4.4's vote row holds: active
  and renewing vote; paused, ended and frozen do not. A refusal is the contract's own error. In the view it becomes a
  reason: `plan`, `payment`, `hold` or `unavailable`.
- **`api/_lib/codium-perks.ts`.** `vote` gets a readiness check (the store is configured), so the owner can list it.
- **`script/roadmap-ballot.ts` (new, owner).** `open <quarter> --candidates <file.json> --closes <date> [--opens <date>]
[--replace]`, `close <quarter> [--at <date>]`, `results <quarter>`, `decide <quarter> <id>` and `nominations <quarter>`,
  each with `--mode live|test`. Dates are ISO 8601, and a bare date is midnight UTC. It uses `KV_REST_API_*` and never
  prints them, or who voted or nominated.
- **Desktop.** `createVectorAccount().roadmap(request)` reads, votes or nominates with the account token in the main
  process (IPC `vector-account-roadmap`, preload `vectorAccount.roadmap`). It sends only the shapes Settings uses: a read,
  a vote with a well-formed quarter and candidate id, or a nomination of bounded text. It answers vectordev.ai's JSON,
  or its error code and message, never the token.
- **App.**
  - `settings-registry.ts`: a `roadmap` tab, "Roadmap vote", in the Personal group right after Account.
  - `dialog-settings-v2.tsx`: the tab shows only when the signed-in account's Codium status has `entitlements.vote`
    (which needs `vote` listed). Settings reads the status when it opens, after a sign-in change and on
    `codiumChanged()`.
  - `roadmap.tsx`, `roadmap-model.ts`, `settings-roadmap.css`: the page. It shows the quarter's ballot as a radio list
    with Vote / Change vote, and the opening or closing date of the vote. It shows the latest results as totals with
    bars, the winner's "Planned for the next release cycle.", a tie, or "Fewer than 20 ballots…", plus "You voted for…"
    and the free-workspace sentence. Ultra gets a nomination form, or what it nominated. Refusals are worded per reason.
    The page decides nothing itself.
- **Docs.** `docs/vector/MODEL-PLANS.md` gains a "Roadmap vote" section.

## Edits to `api/_lib/model-plan-*.ts`

None.

## Tests

Run one file at a time with `--timeout 30000`, root tests from `test/` and package tests from their package:

| File                                                                                           | Result                       |
| ---------------------------------------------------------------------------------------------- | ---------------------------- |
| `test/roadmap-api.test.ts` (new; the contract's `roadmap-api.test.ts`)                         | 16 pass, 1 skip (Valkey, CI) |
| `packages/app/src/components/settings-v2/roadmap-model.test.ts` (new)                          | 7 pass                       |
| `packages/app/src/components/settings-v2/settings-registry.test.ts` (16 pages, one new case)   | 14 pass                      |
| `packages/desktop/src/main/vector-account.test.ts` (one new case)                              | 30 pass                      |
| `packages/web/test/codium-public.test.ts` (vote readiness in the listing case)                 | 11 pass                      |
| `test/api-module-loading.test.ts`, `codium-mode.test.ts`, `no-topups.test.ts`, `no-project-wording.test.ts` | pass  |

`test/roadmap-api.test.ts` covers:
- voting, changing a vote and one ballot per account;
- Ultra's one nomination (HSETNX) and nomination text rules;
- votes outside an open ballot;
- S1: Plus, Pro, no plan, paused, frozen and ended accounts are refused, even when a patched client claims a bigger plan, and Max may not nominate;
- a renewing plan voting with no Stripe call (M4);
- S3 and revoked tokens;
- the write limit;
- results: hidden below 20 counted, forged, late and off-ballot ballots never counted, a downgrade after voting still counted, no voter in the answer, this quarter replacing last quarter, and ties with the owner's decision;
- erasing an account's ballots and nominations from every quarter (for A57);
- the owner's ballot rules, close, results and nominations output, and the command line;
- the vote's readiness.

**CI only:** the last case of `test/roadmap-api.test.ts` sends the store commands (`SET NX/XX`, `HSET`, `HSETNX`,
`HVALS`, `HLEN`, `HDEL`, `SADD`, `SMEMBERS`) to a real Valkey when `VECTOR_TEST_REDIS_URL` is set. It is skipped here
because this Mac has no Valkey. Settings → Roadmap vote has not been looked at in a browser, because no dev server runs
on this Mac. Its model is unit-tested and the component typechecks.

Typecheck: root `tsconfig.json` (api) clean; `packages/app` `tsgo -b` and `tsgo --noEmit -p tsconfig.json` clean;
`packages/desktop` `tsgo -b` and `tsgo --noEmit` clean. `script/` and root tests are outside every typecheck config, as
before.

## Contract readings

Recorded in `codium-deviations.md` under "A34 roadmap vote (2 Nov 2026)".

## Not done

- A57 wires `eraseAccountBallots` into account deletion (the contract's done criterion, "ballots deleted with the account
  (A57)"). Until then, ballots and nominations stay until erased.
- For A60's legal read: the privacy draft (`#roadmap-votes`) says ballots are stored "with your account identifier and
  the plan you had when you voted". The store keys them by a SHA-256 of the account id and keeps the plan. The draft
  sets no retention beyond deletion with the account, and none is applied here.
- No line in `vector codium`, the website account page or `/docs/codium` mentions the vote. They are not in A34's file
  list.
- Vector Labs is not built; the tab is "Roadmap vote", not v3's "Settings → Labs".
