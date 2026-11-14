# A30: Codium legal drafts

A30 follows A29 (`f254efc5`) and drafts contract §7.2 for the legal read. It changes no live legal text on `codium`: H8 lets the terms and privacy pages change only in A60's release commit. No service, account, deployment or provider was called.

## Where the work is

- **`codium`**, commit `986a8096` ("A30 legal page guard"): `test/codium-legal.test.ts` and one CI trigger. The test pins each legal page by its effective date (sha256 of the source, LF line endings), checks that checkout's `CODIUM_TERMS_DATE` equals the terms page's date and that both pages carry the same date, and checks that every link to a `/legal/terms` or `/legal/privacy` anchor in the repository (outside `docs/vector/build/`) lands on an anchor that exists. `.github/workflows/vector-codium.yml` also runs on pushes to `codium-legal`, so the drafts get the Codium lane before A60 merges them.
- **`codium-legal`**, commit `94a5004e` ("A30 legal drafts"), one commit on top of `986a8096`, in the worktree `~/.cache/vector-codium-legal`. It was pushed on 2026-11-14 after a merge of `codium` (see "Pushed"). It changes `packages/web/src/pages/legal/terms.astro`, `privacy.astro`, `LegalPage.astro` (every anchor gets the scroll margin `#codium` had), `api/_lib/codium-consent.ts` (`CODIUM_TERMS_DATE`), `test/codium-legal.test.ts` (the draft checks and new pins) and `test/no-topups.test.ts` (the legal pages are no longer allowed wholesale; their lines are checked like any other).

## The drafts

**Terms §3, "Cost and Vector Codium plans"** (`id="codium"` kept). It keeps: Vector is free; connected services charge separately; free models are not guaranteed; taxes and the total shown before payment; the price-change notice (now: from the next renewal after notice); records kept as the law requires; the non-refund and billing-error remedy, with "credits" replaced by "usage". New anchors, each an `h3` (or a `div` for the two "where available" blocks):

- `#codium-plans`: monthly plans only; no top-ups and no overage charges; automatic renewal; cancel any time and keep the paid period; an upgrade starts a new month that day, charged in full, and this month's unused usage carries into that month only; downgrades at renewal; a failed payment pauses Codium and plan features and does not extend the month; the plan ends after Stripe's retries; a full refund or a dispute ends what that payment bought; refund and end after a fraud warning; access suspended while disputed or flagged; reduced starting limits on new Max and Ultra subscriptions (the ramp).
- `#codium-models`: models and limits differ by plan and are listed on /codium; a model may be temporarily unavailable or replaced with a comparable one; nothing included is reduced during a paid month.
- `#codium-usage`: a whole-number percentage that may lag; "Codium" instead of tokens or prices; no rollover; daily limits (UTC) on some plans; not a promise of tokens, requests or tasks; when used up, Codium stops until renewal (or the next UTC day) while own keys and free models keep working.
- `#codium-coming`: the contract's Velocity clause word for word, then the same for every item tagged "Coming".
- `#codium-github`: Codium model access only, "in your own repository, on your own Actions minutes"; GitHub's account, terms and billing; only that repository's software work; anyone with write, maintain or admin access to a connected repository can start runs on the plan; agent time measured from Codium requests; free with your own key as a repository secret.
- `#codium-hosted` (where available): time counts toward the month; Vector may stop a session; no mining, spam, scraping against a site's terms, CAPTCHA solving or bot-check bypass; profile wiped after each job; disk kept per plan, then 14 days after the plan ends with notice. Never mentions GitHub or Actions.
- `#codium-ops` (where available): verified domains only; the App writes only where `.vector/ops.json` opts in, and only to open pull requests; Vector never merges; "Vector's agent, not a person"; no uptime, availability or response-time promise.
- `#codium-consent`: immediate start; 14-day withdrawal where the law gives it, paying for what was used; the founding lock ("your price won't go up while you stay subscribed"), the new plan's current price on a change, +10% on Plus and Pro only, ending with the subscription.
- **§8** adds mining, spam, scraping against a site's terms, CAPTCHAs and bot checks, and GitHub agents doing work unrelated to their repository.

**Privacy.** §4 Codium: the gateway checks "your Codium plan and its limits, and the usage held"; the key-name sentence loses "for a monthly plan"; new `#codium-billing` (Stripe customer, subscription, invoice and charge ids, plan and period, consent with the terms date, the plan-state summary, risk flags, the encrypted key), `#codium-counters` (holds about eleven minutes, run usage three days, daily and period counters until 40 days after the period), `#codium-github` (binding until removed; run id, event, triggering login or id kept 90 days, start and stop; Actions logs are GitHub's and public on public repositories; artifacts), `#roadmap-votes`, the four "where available" blocks `#vault`, `#remote` (relay, devices, push subscriptions, titles only), `#hosted-computer` (disk, profile, recordings 30 days, nothing recorded during take-over, Vercel and Cloudflare, zero data retention covers model calls, not the disk) and `#production-checks` (URLs, results, deployment events, screenshots 30 or 90 days), and `#codium-deletion` (P5). §8 adds `#report-tracking` (180 days, never the text). §10 adds `#codium-usage-counts` (Codium token totals, cost and model ids not sent from the first releases that sell plans; activity counts still are). §12 gains the retention list `#retention`.

**"Where available" blocks** carry `data-where-available="<perk ids>"` with ids from `PERK_IDS`: terms `#codium-hosted` (`computer overnight`) and `#codium-ops` (`on-call release-guard ship-desk`); privacy `#vault` (`vault`), `#remote` (`remote alerts`), `#hosted-computer`, `#production-checks`, and the three matching `li` items in `#retention`. Each starts with "(where available)" in its first words. A60 keeps a block only when one of its perks is listed at launch; the test checks the ids, so A60 can compare them with `CODIUM_LISTED_PERKS`.

**Dates.** Both pages read "November 2, 2026" and `CODIUM_TERMS_DATE` is `2026-11-02` on `codium-legal`. That is a draft date, pinned only so H8 holds on the branch. A60 sets the release date on both pages and in `CODIUM_TERMS_DATE`, and pins the new hashes; the failing H8 test prints the sha256 to pin.

## Points for the legal read

1. **EU withdrawal** (`#codium-consent`): the draft charges "what you used before you withdrew" and refunds the rest, matching the checkout text. Confirm that usage, not time elapsed, is an acceptable measure of the proportionate amount, and that the UK and other regimes are covered by "where the law gives you a right to withdraw".
2. **Velocity clause** binds future pricing (contract §8.3 open item 5): Velocity could not later be sold to Max and Ultra subscribers as an add-on.
3. **GitHub "model access only"**, and that any writer on a connected repository spends the binder's plan (§8.3 open item 4; Codex amendment 8 limits starters to write, maintain or admin).
4. **Founding lock** wording, and whether "you pay the new plan's current price" on a change is the intended lock behaviour (A31 is not built).
5. **Ramp disclosure**: the terms say reduced starting limits exist and that /codium describes them, without numbers.
6. **Session artifacts**: the contract says to call them "private Actions artifacts" until Codex encrypts them per run (amendment 9). Artifacts of a public repository can be downloaded by people who can see its Actions, so the draft says that instead. Re-check against Codex's final workflow.
7. **Deletion** (`#codium-deletion`, `#retention`) describes P5, which A57 builds. Today `cancelModelPlanAccount` keeps the billing record marked closed. GitHub bindings and run records are Codex's; confirm they are erased on deletion, or narrow the sentence.
8. **Ballots**: the contract sets no retention beyond deletion with the account (A34). A fixed period may be wanted.
9. **Facts assumed from the contract for unbuilt services**: Upstash hosts the store; Cloudflare stores hosted recordings and production-check screenshots; Vercel runs the cloud computer; device records hold an identifier, public key, name and dates; disks kept 14 days after a plan ends, until a dispute closes, and 30 days after a lost one. Each needs its owning package's confirmation before its block is published.
10. **Not named on purpose**: Vector Labs (its pricing row is a pending owner decision; the "every item tagged Coming" sentence covers it), the `@vector` handle (it depends on the GitHub App slug; the drafts say "Vector's GitHub agent"), any model of the Oct 30 lineup, and any amount or token count.
11. **Left as it is**: terms §9 still lists token totals and recorded cost among usage counts (true for everything but Codium; privacy §10 says Codium is left out); the prompt-cache bullet still names the runtime catalog's models; both pages' existing contact paragraphs are unchanged.

## Tests

One file at a time, `bun test --timeout 30000`, from `test/` (on `codium-legal`, with the `codium` worktree's dependencies linked in for the run and removed afterwards):

| Branch         | File                                                                     | Result  |
| -------------- | ------------------------------------------------------------------------ | ------- |
| `codium`       | `test/codium-legal.test.ts`                                              | 7 pass  |
| `codium`       | `packages/cloud/src/workflow-compliance.test.ts` (from `packages/cloud`) | 22 pass |
| `codium-legal` | `test/codium-legal.test.ts`                                              | 26 pass |
| `codium-legal` | `test/no-topups.test.ts`                                                 | 3 pass  |
| `codium-legal` | `test/codium-plan-change.test.ts` (uses `CODIUM_TERMS_DATE`)             | 29 pass |

Before the new hashes were pinned, the H8 cases failed on both draft pages and printed their hashes, as intended. A mutation run on a copy of the terms (a credits sentence in §3, "GitHub" in the cloud computer block, "soon" in the Coming clause) failed the four matching cases and H8; the file was restored to its pinned hash.

Typechecks on `codium-legal`: root `tsconfig.json` (`api/**`, 118 files) passes; web `astro check` passes, 201 files, 0 errors, 0 warnings, 184 hints. On `codium` no package source changed.

CI-only: the Codium lane on `codium-legal` (it runs every `test/` file there once the branch is pushed).

## Pushed (2026-11-14 UTC)

`codium-legal` is on GitHub. Merge commit `1d31ed8e` brings `codium` at `1ce8f5f3` into `94a5004e` with no conflicts; of the files the drafts touch, only `test/no-topups.test.ts` had moved on `codium`, in other entries. The pre-push hook ran and passed (turbo typecheck, 26 of 26 packages); it was not skipped. CI at `1d31ed8e`, all success on attempt 1: Vector Codium [43549193866](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43549193866) (push), and by dispatch test [43549200909](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43549200909), typecheck [43549203617](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43549203617) and Verify [43549206154](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43549206154). The drafts are still not on `codium`; A60's release commit merges them.

## Not done

- The legal read itself (owner step 15) and A60's selection of the "where available" blocks.
