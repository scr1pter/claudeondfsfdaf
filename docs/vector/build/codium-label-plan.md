# Vector Codium: show "Codium" instead of tokens and prices — change plan

**Owner decision (26 Oct 2026).** Wherever Vector would show a token count or a price or cost for work done on a Vector Codium model (provider id `vector-plan`, shown as "Vector Codium"), it shows the label **Codium** instead. Subscribers see their usage only as a percentage: in Settings → Usage, on the account page and in `vector codium`. Plans will become tiers (Plus, Pro, Max, Ultra) with different models per tier; usage stays percentage-only.

**How to read this.**
- Every path is relative to the repository root. Line numbers are for shipped main at `6eaf445a` (`~/.cache/vector-main`). The self-evolving branch (`~/.cache/vector-evolve`, 1.99.113) has changed some of these files: `spend-guard.ts`, `subagent-lifecycle.ts`, `task.ts`, `schema/src/task.ts`, `schema/src/v1/session.ts` and `cli/cmd/memory-doc.ts`. Find each anchor again on the branch you build on before you edit.
- I only read code. I built, tested and ran nothing.
- **Reviewed 27 Oct 2026** against `~/.cache/vector-main`, now at `2b6b5d4b`. That commit only touches `packages/web/src/components/Lander.astro` and `packages/web/test/landing-copy.test.ts`, so every line cited below still matches. Corrections from the review are made in place; section 13 lists them.
- "Own" means steps on the person's own keys or sign-ins, and on free and local models: everything that is not Codium.

---

## 0. Summary

Today Codium steps hide dollars but not tokens. The app, TUI, CLI and GitHub posts show Codium token counts in about 40 places. Around Codium they also print "Cost unknown", "unmeasured", "$0.00" or "Codium credits". Only two spend or usage surfaces in the app recognise Codium (`packages/app/src/features/economics/format-spend.ts:25,45` and `packages/app/src/utils/provider-brand.ts:113`); the other app checks of `ModelPlanStatus.PROVIDER_ID` (`ai-review.ts:443,697`, `layout-new.tsx:674,764`, `utils/task-intelligence.ts:172-175`, `prompt-input/submit.ts:810`) only keep Codium from being chosen automatically. Everywhere else Codium counts as an unpriced model, and session totals mix Codium tokens in with everything else.

The plan has four parts:
1. **One flag.** A step-level flag, `billing: "codium"`, is stamped by the engine where usage is recorded. It is carried in messages, step parts, events and the SDK. One shared helper reads it, falling back to the provider id.
2. **Split totals.** Session totals record Codium separately. Token totals leave Codium out. Two new counts, `codiumSteps` and `subagentCodiumSteps`, say that Codium work happened. The unpriced counts keep counting Codium, so older readers still say a total is incomplete.
3. **One wording.** Every surface uses the same text: "Codium" when all the work was Codium, "<own figure> + Codium" when it was mixed. A Codium step never shows "$0.00", "Cost unknown" or "unmeasured".
4. **What still sees tokens.** The vectordev.ai gateway keeps sending token usage, because compaction depends on it. The local engine keeps per-step tokens for compaction, the context meter, the spend guard and learned workflow insights. Every total, summary, printed output, GitHub post, check-in and editor (ACP) report leaves Codium tokens out.

---

## 1. Decisions this plan takes on the owner's behalf (please confirm)

| # | Question | Default taken here | Why |
|---|---|---|---|
| D-1 | Does a Codium session still show how full its context window is? | Yes, as a percentage only ("24% of context"). No token count and no context-limit row. | People need to see compaction coming. A percentage of the window is not a token count. The window size is public, so the percentage gives a rough prompt size; that is accepted. |
| D-2 | Do raw local data and transport count as "showing"? | No. The SQLite database, the local HTTP API's per-message records, the event stream, `vector export` backups and the TUI plugin API keep per-step Codium tokens, with `billing: "codium"` on them. Everything Vector **prints, posts or sends** leaves them out: text surfaces, CLI JSON flags, `vector export --sanitize`, GitHub, check-ins and ACP. | Compaction, the context meter and re-import need the values. They already sit in the person's own database. `docs/vector/MODEL-PLANS.md:98` already says tokens stay local. |
| D-3 | Do dollar caps (`--max-cost`, `budget.run`, research defaults, desktop limits) stop Codium runs? | No. Codium is billed by plan, like a ChatGPT plan, so only the step and loop limits apply. The "40 unpriced steps" stop no longer fires for Codium. The vectordev.ai credits are Codium's hard cap. Desktop limits are a second gate: `checkAllowance` (`packages/desktop/src/main/spend-limits.ts:283-330`) blocks and reserves headroom for every run whatever its model, so a Codium run is refused once own-key spend reaches the day or month cap, and holds dollars it will never spend. Default here: a run whose model is known to be Codium skips the dollar check and reserves $0 (see C8). | Today a Codium run under any dollar cap stops after 40 steps with a "$X cap" message (`packages/core/src/spend-guard.ts:27,196-197,233-246`). That stop is arbitrary and reads like a dollar figure. |
| D-4 | Should the plan percentage read "used" or "left"? | Keep "left" (`plan.left`) as shipped on the account page, in Settings → Account and in `vector codium`. Settings → Usage gains a meter and a "used" figure next to it: "36% used · 64% left". | The owner said the account page and `vector codium` "already show a share". This keeps test churn small. |
| D-5 | Do usage check-ins to vectordev.ai and the all-users usage dashboard include Codium? | No Codium tokens or dollars. Check-ins follow Settings → Usage, which leaves Codium tokens out. They still carry activity counts that include Codium work (`modelResponses`, `completedChats`, `days[].tasks`; `packages/schema/src/usage-report.ts:166,173,180`), as D-7 allows. The dashboard is owner-only (`packages/web/src/pages/usage.astro:6`, `api/usage/summary`), not public. | The privacy policy (`packages/web/src/pages/legal/privacy.astro:308-315`) says check-ins send "the totals shown" in Usage & streaks. The gateway already holds the real Codium usage. |
| D-6 | Should vectordev.ai serve Codium to desktops and CLIs that still show tokens? | No. New clients send `X-Vector-Client: <version>`. `/api/model-plans/models` answers `enabled: false` below `MODEL_PLANS_MIN_CLIENT`. Set that to the release with this change before turning sales on. | Codium has never been sold, so no customer loses access. |
| D-7 | Are message, reply, conversation and streak counts allowed for Codium? | Yes. They are activity counts, not tokens or prices. | They keep the Usage page and `vector stats` useful. |
| D-8 | Does the memory recall footer (`packages/session-ui/src/components/knowledge-citations.ts:228`, "· N tokens") change? | No. It is the size of the memory text Vector adds to a request. Vector computes it locally, and it is the same for any model. | It is not usage of the model. The same goes for the "~N tokens" repository-context estimate (`packages/app/src/pages/layout-new.tsx:6569-6573`). |

The tier change raises two more open decisions: which models a buyer with only purchased credits gets (default: the Plus models), and whether tiers stay under one provider id (yes, see section 10).

---

## 2. The rules (one wording everywhere)

**Detecting Codium.** One helper, in a new browser-safe module `packages/schema/src/billing.ts`:
```ts
export * as Billing from "./billing.js"
export const CODIUM_PROVIDER_ID = "vector-plan"   // replaces the literals listed in 7.1
export const LABEL = "Codium"
export const Kind = Schema.Literal("codium")       // extensible later
export const isCodium = (providerID?: string) => providerID === CODIUM_PROVIDER_ID
// The flag first; else the provider id (an in-flight message, or a record written before this change).
export const of = (x: { billing?: string; providerID?: string; model?: { providerID?: string } }) =>
  x.billing === "codium" || isCodium(x.providerID ?? x.model?.providerID) ? "codium" as const : undefined
```
`ModelPlanStatus.PROVIDER_ID` (`packages/core/src/model-plan-status.ts:19`) becomes an alias of `Billing.CODIUM_PROVIDER_ID`.

**What the counts mean.** These meanings apply in storage, the API and the SDK:
- `unpricedSteps` (and `unpricedResponses`): every step the dollar total leaves out, Codium included. This is unchanged, so older readers still say "not fully priced".
- `codiumSteps` (new): how many of those unpriced steps ran on Codium. Own unpriced steps are `unpricedSteps − codiumSteps`.
- `tokens`, `subagentTokens`, usage-summary token totals, `Task.usage.tokens`: own tokens only. Codium tokens are left out.
- `cost`: own dollars only. This is unchanged, since Codium cost was always 0.
- **The run guard's counters are different** (`RunBudget.Snapshot`, `session.spend`, `ScopeSnapshot`, `Task.BudgetScope`, `BudgetStopError`). The guard's `unpricedSteps` has only ever counted `unknown` steps, never plan, free or local ones (`packages/core/src/spend-guard.ts:168-174`). A Codium step joins the steps it does not count, and adds 1 to a new guard `codiumSteps`. So the guard needs no `unpricedSteps − codiumSteps` arithmetic (4.3), and a Codium-only run never reads as unmeasured to the desktop (`packages/desktop/src/main/run-usage.ts:76-85`).

**Wording.** One formatter, in a new browser-safe module `packages/core/src/codium-usage.ts`, with no Node imports, like `model-plan-status.ts`:
- `withCodium(ownText, codiumSteps)` returns `ownText` when there are no Codium steps. It returns `"Codium"` when there is no own text, and `` `${ownText} + Codium` `` otherwise.
- The own-text formatters stay where they are: app i18n, TUI `Locale`, CLI money. Each is given own unpriced steps (`unpricedSteps − codiumSteps`), never the raw count.

| Session made of | Cost reads | Tokens read |
|---|---|---|
| Codium only | `Codium` | `Codium` |
| Codium + priced | `$0.12 + Codium` | `48.2k + Codium` |
| Codium + priced + own unpriced | `$0.12 + unpriced + Codium` | `48.2k + Codium` |
| Codium + own unpriced only | `Cost unknown + Codium` | `48.2k + Codium` |
| Codium + free model | `free + Codium` | `48.2k + Codium` |
| Codium + ChatGPT plan | `ChatGPT plan + Codium` | `48.2k + Codium` |
| No Codium | unchanged | unchanged |

Never print "$0.00", "<$0.01", "Cost unknown", "unmeasured", "no listed price" or "unpriced" for Codium work. Never print `vector-plan` as a provider name; it reads "Vector Codium". The one exception is a model id the person has to type: `vector models` lists `vector-plan/<model>` (`packages/engine/src/cli/cmd/models.ts:105,112`), and the "never chooses it for you" hints name `vector-plan/<model>` (`packages/engine/src/provider/provider.ts:1434`, `packages/engine/src/acp/error.ts:83`, `packages/engine/src/cli/cmd/codium.ts:35`). Those stay.

**Tooltip and note copy.** These go in `packages/app/src/i18n/en.ts`, next to `:525-531`:
- `session.cost.codium`: `Codium`
- `session.cost.withCodium`: `{{cost}} + Codium`
- `session.tokens.withCodium`: `{{tokens}} + Codium`
- `session.cost.codiumNote`: `Work on Vector Codium models shows as Codium. Your plan's usage is in Settings → Usage, as a percentage.`
- `session.cost.unpricedNote` (`:530-531`) drops the Codium half: `Some steps ran on a model with no listed price, so they are not in this total.`
- `SPEND_TOOLTIP.codium` (`format-spend.ts:118-119`): `Billed to your Vector Codium plan. Vector shows its usage as a percentage in Settings → Usage, never as tokens or dollars.`

Other locales fall back to English (`packages/app/src/context/language.tsx:98-102`), so they need no edit to ship.

---

## 3. Behaviour spec by surface

Columns: (a) a session that ran only on Codium; (b) a mixed session, here with $0.12 and 48.2k tokens of its own work. Cells not given are unchanged.

### 3.1 App: session surfaces

| Surface (file:line) | (a) Codium only | (b) Mixed |
|---|---|---|
| Session cost pill: label `packages/app/src/components/session-cost-readout.tsx:182`, token suffix `:184-187`, mounted at `packages/app/src/pages/session/timeline/message-timeline.tsx:1641` | `Codium`, with no "· 45.0k". **Breakage to avoid:** the whole pill is behind `cost() > 0 \|\| tokens() > 0 \|\| desktop().length > 0` (`:100`), the label behind `cost() > 0 \|\| tokens() > 0` (`:182`), and `sessionReading` picks the codium kind only when `tokens > 0` (`format-spend.ts:72-74`). Once totals drop Codium tokens, a Codium-only session has cost 0 and tokens 0, so the pill vanishes, or reads "Desktop …". All three conditions must also accept `codiumSteps + subagentCodiumSteps > 0` | `$0.12 + Codium · 48.2k + Codium` |
| Pill tooltip `session-cost-readout.tsx:107-167`: Session cost, This run, Tokens, Of which, Desktop task spend, note, cap | Session cost `Codium`; Tokens `Codium`; each Of which row (`:90-96,121-146`) `Codium`; the note becomes `codiumNote`; This run and cap rows are hidden while the run has spent no dollars (`format-spend.ts:92-106`) | Session cost `$0.12 + Codium`; Tokens `48,213 + Codium`; each Of which row goes through `withCodium` per part; both notes when both apply; cap row `$0.12 of $2.00` (dollars only) |
| Context ring tooltip `packages/app/src/components/session-context-usage.tsx:139-141`, mounted at `message-timeline.tsx:1642` and `pages/session/session-side-panel.tsx:4981,5095` | Cost `Codium`; Usage `24%` (D-1); Tokens `Codium` | Cost `$0.12 + Codium`; Usage `%`; Tokens shows the last step's number, or `Codium` if the last step was Codium |
| Context tab ledger `packages/app/src/components/session/session-context-tab.tsx:99-158`, mounted at `session-side-panel.tsx:5187`, metrics `components/session/session-context-metrics.ts:54-63` | Context limit row hidden (D-1); Total tokens, Input, Output, Reasoning and Cache rows collapse into one row, `Tokens: Codium`; Usage `24%`; Total cost `Codium`; Of which rows `Codium` | Rows show own figures with `+ Codium`; Context limit and Usage follow the last step's model |
| Context tab header and breakdown `:251` (in context), `:283` (bar titles with token counts), `:169-185,288-297` (% labels) | Header `%` kept; bar titles drop token counts; % labels kept | Unchanged when the last step was own work |
| Context tab model economics `:330-353` (raw provider `:330`, median $ `:343-345`, "N/M priced" `:346-348`, next turn `:349-353`) | The Codium row reads `Vector Codium · <model> · Codium`, with no median, priced count or next-turn estimate | Same, for the Codium rows only |
| "Working" line `pages/session/composer/session-working-status.tsx:45-48`, fed by `session-composer-region-controller.ts:143-185` | `12s · Codium`, no token estimate. The in-flight message's `providerID` is known as soon as the message is created, so `Billing.of` works before any usage arrives | Follows the in-flight message's model |
| Delegated breakdown `packages/app/src/components/session-delegated-spend.ts:10-50`, `packages/app/src/utils/session-cost.ts:57-88` | Helper and subagent rows read `Codium` | `$0.40 + Codium · 12.3k + Codium` per row |

### 3.2 App: other surfaces

| Surface (file:line) | Codium behaviour |
|---|---|
| Home activity strip `packages/app/src/pages/home.tsx:1062-1078`, data from `:346` | Day tooltip `Oct 3: 12,345 tokens + Codium`, or `Oct 3: Codium` when the day was Codium only. Lifetime `1.2M tokens used + Codium`; Codium-only shows `Codium` / `on Vector Codium` instead of the number. |
| Settings → Usage `packages/app/src/components/settings-v2/usage.tsx` | See section 5. |
| Settings → Account `components/settings-v2/account.tsx:257-392`, `account-model.ts:28-55` | No change (D-4). |
| Model picker `packages/app/src/utils/provider-brand.ts:91-96`, used at `:199,233,257` | Label `Codium` (was "Codium credits"); title `Uses your Vector Codium plan`; spoken `uses your Vector Codium plan`. No price is shown anywhere in the app picker (`components/dialog-select-model.tsx`). |
| Tasks pane `features/background-tasks/background-tasks-pane.tsx:333-335` (total), `:534-539` (card), `:675,716` (Tokens column), `:805` (detail); logic `task-board-model.ts:152-174` | `Subagent spend · Codium`; the card reads `Codium` instead of "N tokens · Cost unknown"; the Tokens column and detail cost read `Codium`. Mixed: `$0.40 + Codium`. Detection: `TaskAgent.model.providerID` (`subagent-model.ts:68,498-499,608`) plus the new `Task.usage.codiumSteps`. **Leak the plan missed:** while a child runs, `childFacts` (`subagent-model.ts:479-525`) sums the tokens of every loaded step-finish part (`:509-512`), else of every assistant message (`:492`). Those per-step records keep Codium tokens (D-2), so it must skip parts and messages for which `Billing.of` says Codium and count them as Codium steps instead. |
| Parallel agents and agent dashboard `features/agents/agent-dashboard-model.ts:241-250`, shown at `pages/layout-new.tsx:3717,5018` and `agent-dashboard.tsx:227-229` | `Codium` or `$0.12 + Codium`, never "unmeasured" or "$0.00". It reads the new `billing` on the desktop record (7.8). |
| Settings → Spend limits `settings-v2/spend-limits-model.ts:65-91`, rendered at `spend-limits.tsx:96-104,184-193` | This is a dollar ledger for caps. A Codium-only run spends $0 and, after this change, 0 own tokens, so `recordRunCost` already appends nothing for it (`packages/desktop/src/main/spend-limits.ts:251-255`), provided the guard does not count Codium as unpriced (section 2), so it never shows as "unmeasured". A mixed run records its own dollars and tokens, and its line reads `$0.12 + Codium · Parallel agent · Oct 3, 2:14 PM` from `SpendEvent.billing`. Today and Month totals add `+ Codium` when the window holds such a run. |
| Budget stop card `packages/app/src/components/budget-stop-copy.ts:34-56` | A Codium-only run never meets a dollar stop (D-3). Step and loop stops show no spent line: today `spentLine` (`:52-56`) prints "$0.00 spent" for any stop with `spentUsd: 0`, so `BudgetStopError` (`packages/core/src/v1/session.ts:77-84`) gains `codiumSteps`, set at `packages/engine/src/session/processor.ts:399-407` and `packages/engine/src/session/prompt.ts:2100-2107`. Mixed: `$0.84 of $2.00 spent · Codium steps not counted`. |
| Research cap chip `features/research/research-model.ts:144-157`, at `components/prompt-input.tsx:671,2155,2507` | On a Codium model: `Codium · 80 steps` (the depth's step cap) instead of `Cap $1.00`. |
| Model recommendation chip `prompt-input.tsx:2040-2046`, evidence `features/economics/economics-recommender.ts:76-79` | Codium models leave the recommender: they are never suggested, and Codium outcomes are never quoted. Codium is never chosen automatically. |
| Memory distill `settings-v2/memory-documents-model.ts:555-562` (history), `:724-735` (estimate), rendered at `memory-document.tsx:885` | History `You asked <model> to find more: 3 suggestions kept (Codium)`. Estimate `Runs on <model> (Codium)`, with no token or cost line. |
| Research report "Spend:" line `packages/core/src/research/report.ts:294`, worded at `packages/engine/src/tool/research-report.ts:70-87` and `packages/core/src/tool/research-report.ts:86-106` (`$X at list prices` from the guard's `spentUsd`) | Codium-only: no line, as today (it prints only when `spentUsd > 0`). Mixed: `$0.12 at list prices + Codium`, from the guard's new `codiumSteps`. Saved reports are documents people share, so this matters. |
| Economics outcomes `features/economics/session-outcomes.ts:45-66`, `workspace-outcomes.ts`, stored per project by `economics-repository.ts:1-40` (local) | `measureUsage` sums per-message tokens, Codium included. Do not record outcomes for Codium sessions at all (the recommender never uses them), so the stored history and the Context tab's model economics hold no Codium token medians. |
| Vectorscope in the desktop | See 3.4. |

### 3.3 Subagents, titles and compaction on Codium (case c)

- **Subagents.** A child on Codium adds 1 to its own `codiumSteps` per step, and the projector adds 1 to every ancestor's `subagentCodiumSteps` (`packages/core/src/session/projector.ts:119-171`). The parent's pill reads `Codium` or `+ Codium`, and its "Of which → Subagents" row reads `Codium`.
- **Task notifications the model reads** (`packages/engine/src/tool/task.ts:309-326`), which also show in the transcript:
  - A Codium-only child gets no `tokens="N"` attribute. Instead of "Pricing is unknown for N provider steps…", it gets `Its steps ran on Vector Codium, which shows no token or cost figures.`
  - A mixed child gets `tokens` with its own count, plus `Some of its steps ran on Vector Codium.`
- **Titles** (ancillary usage, published from `packages/engine/src/session/title-usage.ts:21`) and **compaction** (`packages/core/src/session/compaction.ts:243-260`; engine compaction messages at `packages/engine/src/session/compaction.ts:404`):
  - They carry `billing: "codium"` when they run on a Codium model.
  - They count in `codiumSteps` and never add tokens to totals or to Settings → Usage.
  - V2 compaction messages name no model, so the flag is the only signal there.
- **Learned workflow insights** (self-evolving branch, `packages/engine/src/session/workflow.ts:240-260`) keep reading per-message tokens, unchanged; see 11.

### 3.4 Vectorscope reviews on Codium (case d)

| Surface (file:line) | Codium behaviour |
|---|---|
| Cost kind in the app: `packages/app/src/features/pull-requests/ai-review.ts:357-366` (`costKindOf`; today Codium's source "custom" (`packages/engine/src/provider/provider.ts:1755`) makes it "unknown") | `isCodium(provider.id)` is checked first and returns `"codium"`. |
| Spend text `ai-review.ts:570-574`, shown live at `features/pull-requests/pull-requests.tsx:1480,1487` | `Codium`, not "Cost unknown · Nk tokens". |
| Live spend tracker `ai-review.ts:187` (`ReviewSpend`) and `:535-567` (`trackReviewSpend`), fed by `pages/layout-new.tsx:6865-6876` | It sums tokens from every `message.updated` of a reviewer session. `add(sessionID, costKind)` receives `"codium"`, the tracker leaves those messages' tokens out, and `ReviewSpend` gains `codium: true`, which `reviewSpendText` turns into `Codium`. |
| Status line `ai-review.ts:1468-1476`, used at `:840,865` | `Reviewing… · Codium`, not "Nk tokens so far". |
| Pass lines `ai-review.ts:1719-1729` | `Review · <model> · Codium`. |
| Estimate `ai-review.ts:2064-2075` | `Runs on your Vector Codium plan.`, not "No price is listed for…". |
| Footer `ai-review.ts:2054-2058` and the posted summary `:2033-2051`, both through `packages/core/src/review/format.ts:118-131` (`costWording`) and `:865-877` | `Vector Codium · <model> · Codium`. The pull request total reads `this pull request: $0.40 + Codium over 3 reviews`, or `Codium over 3 reviews`. |
| Hidden review state in the PR comment `packages/core/src/review/state.ts:368-376` (adds tokens), `:522-537` (writes the compact keys), `:551-556` (reads) | A Codium review adds no tokens and no dollars. It adds 1 to a new `k` key (Codium reviews). **Not `c`:** `c` already holds `costUsd` (`:524` writes `c: state.costUsd`, `:555` reads `amount(raw.c)`), so a count there would be read as dollars by every reader. Keys in use today: `b c f h i m n p r s t u v x`. Older readers ignore `k`. |
| Failure text `format.ts:469-471` (`failedSpend`) | `Used before it stopped: Vector Codium · <model> · Codium.` |
| CLI footer `packages/engine/src/cli/cmd/review.render.ts:217-224,240-253` and per-pass lines `:228-238` | The footer reads `Vector Codium · <model> · Codium · 1m 52s`; per-pass `review: Codium`. |
| `vector review --json` `packages/engine/src/cli/cmd/review.ts:480,654`; failure `:451` | `cost: { kind: "codium", model }`, with no numbers. |
| Price estimate before a run `review.ts:352-362` | It already skips Codium. Add one line: `Runs on your Vector Codium plan.` |
| GitHub Actions log `packages/engine/src/cli/cmd/github.review.ts:687`; events from `packages/engine/src/review/run.ts:218-224` | `Spent: Codium` instead of `Spent $0.0000`. The cost event gains `kind`. |
| Engine cost kind `packages/engine/src/review/model.ts:128-145` | `costKindOf({ codium: true, … })` gives `"codium"`. Step and time limits are unchanged (`review/run.ts:178`). |

### 3.5 Model picker (case e)

- **App.** As in 3.2: the label reads `Codium`. Codium stays a provider of its own, `Vector Codium`, kept in catalog order (`provider-brand.ts:367`).
- **TUI.** `packages/tui/src/component/dialog-model.tsx:91-116,250-252` already groups Codium under "Vector Codium" and shows no prices. No change.
- **Tiers** (section 10). A model outside the account's tier reads `Codium · Pro`, with the title `Included in Pro and above`. Choosing it opens Change plan. No credits or prices appear.

### 3.6 CLI and TUI (case f)

| Surface (file:line) | (a) Codium only | (b) Mixed |
|---|---|---|
| TUI prompt status line `packages/tui/src/component/prompt/index.tsx:249-267`, rendered at `:1661-1665` | `24% of context · Codium` (D-1) | Last step Codium: `24% of context · $0.12 + Codium`. Last step own: `48,213 (24%) · $0.12 + Codium` |
| TUI subagent footer `packages/tui/src/routes/session/subagent-footer.tsx:33-50,83-88` | Same as the status line | Same |
| TUI sidebar `packages/tui/src/feature-plugins/sidebar/context.tsx:16-31,76-86` | `Codium` in place of `N tokens`; `24% of context used` (renamed from "N% used" so it is not mistaken for plan usage); spent `Codium`; delegated `Codium by subagents`; the run-cap line shows only with priced spend | `48,213 tokens + Codium`, `$0.12 + Codium spent`, `$0.40 + Codium by subagents` |
| TUI formatters `packages/tui/src/util/locale.ts:85-98` (`spend`, `sessionSpend`), `packages/tui/src/util/session.ts:56-92` (`delegatedSpendLines`) | Take `codiumSteps` and wrap their output with `withCodium` | — |
| TUI tasks and subagent dialogs `packages/tui/src/routes/session/task-presentation.ts:3-30,38-40`, from `dialog-tasks.tsx:61`, `dialog-subagent.tsx:50` | `running · 42s · Codium` | `running · 42s · 12,345 tokens + Codium · $0.0123 + Codium` |
| `vector run` footer `packages/engine/src/cli/cmd/run/session-data.ts:142-158` (`formatSpend`, `formatContext`), applied at `:826-833,850-861`, drawn at `cmd/run/footer.view.tsx:416-422,856-859` | `24% of context · Codium` | As the TUI status line |
| `vector run --format json` `packages/engine/src/cli/cmd/run.ts:1131-1141` (subagent step_finish), `:1184-1188` (step_finish) | A Codium `step_finish` carries `part.billing: "codium"`, `cost: 0` and `unpriced: true`, and **no `tokens`** (D-2). Documented in the CLI docs. | Own steps unchanged |
| `--max-cost` `run.ts:151-156,319,460-461`; stop text `run.ts:955-964`, `session-data.ts:166-168` | Never stops a Codium run (D-3); step and loop limits only. Help text: `Dollar cap for this run. Vector Codium steps are not counted; step limits still apply.` | Counts own priced and unknown steps only |
| `vector stats` `packages/engine/src/cli/cmd/stats.ts:56,166-345,377-413` | Total Cost `Codium`; token rows `Codium`; per-model block `Vector Codium · <model>` with `Messages N` and `Usage  Codium`, and no token or `$0.0000` rows. Footer line: `Vector Codium usage: see "vector codium".` Note that `stats` does not use the usage summary: it sums V1 message tokens itself (`:183-185,209-220,231-249`) and reads V2 rows straight from `SessionMessageTable` (`:186-204`), whose `row.data` carries `billing` or the assistant's model ref. Both paths need the Codium filter | `$12.40 + Codium`; token rows show own figures with one `+ Codium` note row. Helpers row (`:378-383`) goes through `withCodium` |
| `vector tasks` `packages/engine/src/cli/cmd/tasks.ts:135-168` | As the TUI dialogs | As the TUI dialogs |
| `vector memory doc` `packages/engine/src/cli/cmd/memory-doc.ts:388-393` (estimate), `:408-412` (after), `:429-434` (cost line); `--json` `:388,398` | `Runs on <model> (Codium).` / `Spent: Codium`; `--json` gives `{ billing: "codium" }` with no tokens or cost | — |
| `vector models --verbose` `packages/engine/src/cli/cmd/models.ts:114-116` | Codium models print `billing: "codium"` instead of zero `cost` rates, which read as free | — |
| `vector models` header line `models.ts:102-106` | `Vector Codium: 5 models on your Codium plan (vector-plan/…). Run "vector codium" for your usage.` (was "paid with Codium credits … for your balance") | — |
| `vector codium` `packages/engine/src/cli/cmd/codium.ts:29-35` with `ModelPlanStatus.describe` (`packages/core/src/model-plan-status.ts:211-223`) | No change; already a percentage | — |
| `vector export` `packages/engine/src/cli/cmd/export.ts:294-306` | A backup: it keeps values and marks `billing` (D-2). `--sanitize` drops Codium tokens only on the legacy path, `sanitize()` (`:167-224`: session totals, message tokens and step-finish tokens). Native sessions with `--sanitize` already go through the public preview (`:297-300`), which has no tokens | — |
| CLI usage check-in `packages/engine/src/cli/usage-report.ts:21-63` | Follows the usage summary, so no Codium (D-5) | — |

### 3.7 Exports and shares (case g)

- **Public share.** No change. `packages/schema/src/public-session.ts:19-50` has no tokens, cost or step parts, and `publicArchive` (`packages/core/src/share/archive.ts:77`) leaves them out. Do **not** add `billing` to anything in `PublicSession`: share transport decodes with `onExcessProperty: "error"` (`packages/core/src/share/transport.ts:135-150`), so older viewers would break.
- **Local archive.** `archive.ts:254-263` keeps per-step values and the new `billing` and `codiumSteps` fields (D-2). On import, `MessageImported` (`projector.ts:283-287`) rebuilds totals with the new routing.
- **`vector session --format json`** (`session.ts:139-148`) has no tokens or cost. No change.

### 3.8 GitHub PR evidence (case h)

- **Builders.** `packages/engine/src/cli/cmd/github.evidence.ts:106-129` (`measureCost`) and `:258-271` (`formatCost`), added to the body at `:207`. Posted at `cmd/github.handler.ts:649,682,699,723,729`, built at `:1437-1448`, with subagents counted from `:1466`.
- **Codium only:** `**Cost:** Codium · Vector Codium · <model> · 4 turns`.
- **Mixed:** `**Cost:** $0.12 + Codium · 48.2k in / 3.1k out on your keys · 4 turns`. `measureCost` sorts each message with `Billing.of(message.info)`. `MeasuredCost` gains `codiumTurns`, and its token fields become own-only.
- **Vectorscope sticky comment and Actions log:** see 3.4.
- **`vector github install`** (`github.handler.ts:228,1935-1942`) does not offer Codium. No change.

### 3.9 Editor sessions (ACP)

- **Per-response usage** (`packages/engine/src/acp/usage.ts:88-145`, `acp/service.ts:845-859`): Codium steps are skipped, and a response with only Codium steps carries no `usage`. This includes the error branch, which today always falls back to `buildUsage(info)` (`acp/service.ts:858-860`).
- **`usage_update`** (`acp/usage.ts:149-158,251-260`, `acp/service.ts:645-661`): not sent while the latest step is Codium. Cost is already left out when any step is unpriced, and that still holds because `unpricedSteps` counts Codium.

---

## 4. Where hiding happens

### 4.1 Single source of truth: the step flag

The engine stamps `billing: "codium"` where it records usage. Nothing downstream guesses from cost or `unpriced`, which custom models, DigitalOcean, LiteLLM proxies and Copilot share (`packages/engine/src/provider/provider.ts:1515`, `packages/core/src/v1/config/provider.ts:121`).

| Record | Where it is set | Schema |
|---|---|---|
| V1 assistant message, all creation sites, compaction included | `Session.updateMessage`, `packages/engine/src/session/session.ts:843-847`: stamp when `role === "assistant" && isCodium(providerID)`. One choke point instead of the six creation sites in `prompt.ts` (`:555,750,1277,2116,2424`) and `compaction.ts:404` | `packages/schema/src/v1/session.ts:481-502` (`Assistant`): `billing: optional(Billing.Kind)` |
| V1 step-finish part | `getUsage` (`session.ts:451-530`) returns `billing` from `input.model.providerID`; `processor.ts:668-686` copies it onto `stepFinish` | `v1/session.ts:259-275` (`StepFinishPart`) |
| V2 assistant and compaction messages | The projector's message updater: Step.Started creates the row (`packages/core/src/session/message-updater.ts:200-210`, with the model ref from `session-event.ts:150-160`), Step.Ended copies cost, `unpriced` and tokens onto it (`:213-221`) and must copy `billing` too, and Compaction.Ended builds the compaction row (`:391-402`) | `packages/schema/src/session-message.ts:180-216` |
| V2 Step.Ended | `packages/core/src/session/runner/llm.ts:411-424` | `session-event.ts:163-183` |
| V2 Compaction.Ended and Failed | `packages/core/src/session/compaction.ts:243-260` | the compaction events in `session-event.ts` |
| Ancillary usage (titles and other helpers) | `packages/engine/src/session/title-usage.ts:21`; it also has a model ref (`session-event.ts:216-222`) | `ancillaryUsage` fields |

**Defensive pricing.** `getUsage` must never price a Codium step from reported provider metadata. The OpenRouter `usage.cost` path at `session.ts:496-502` is read only under the `openrouter` key, and the gateway strips `cost` (`api/_lib/model-plan-chat.ts:314-339`). Still, add `if (isCodium) → cost 0, unpriced true` so a gateway change can never leak a dollar figure.

### 4.2 Totals: split at the source

The projector's `applyUsage` (`packages/core/src/session/projector.ts:119-171`) gets a per-step contribution:
- **Codium step:** `{ cost: 0, unpriced: 1, codium: 1, tokens: 0 }`.
- **Own step:** today's values.

The delta is `sign·contribution(value) − contribution(previous)`, so revert, removal and moves keep working (`:395,413,437-439,644`). `usage()` (`:39-49`) and `messageUsage()` (`:57-61`) read the flag. AncillaryUsage (`:529-546`) also checks `event.data.model.providerID`. The V2 Step.Ended handler (`:499-528`) and the compaction handlers (`:561-594`) route the same way.

**Breakage to avoid in the projector.** `SessionV1.Event.Updated` (`projector.ts:317-343`) strips every usage column from the patch before writing it, because "a patch carries the totals it read before publishing, so writing them back would erase every step that settled in between". When `codium_steps` and `subagent_codium_steps` are added to `sessionRow` (`:63-100`), they must be added to that strip list too. Otherwise every title change or metadata update writes back a stale Codium count, and `unpricedSteps − codiumSteps` can go wrong or negative. The same columns go into the insert mapping `sessionRow` and the engine's `toRow` (`packages/engine/src/session/session.ts:133-182`).

**Database.**
- New columns `codium_steps` and `subagent_codium_steps`, both integer, default 0, not null, in `packages/core/src/session/sql.ts:48-66`.
- A migration `packages/core/src/database/migration/<ts>_session_codium_steps.ts`, in the shape of `20261003055810_session_subagent_spend.ts`. Regenerate `migration.gen.ts` and `schema.gen.ts` with `bun run --cwd packages/core migration --name session_codium_steps` (a light single-process script), or write them by hand.
- **No backfill.** Codium was never on sale, so only the owner's test sessions hold Codium steps. Those keep their mixed totals, and the old-data fallback in 6.3 hides them. A one-off owner script can recompute them if wanted.

**Session info.** Add `codiumSteps` and `subagentCodiumSteps` (optional `NonNegativeInt`) to:
- V1 `packages/schema/src/v1/session.ts:593-601`;
- the engine's own session schema at `packages/engine/src/session/session.ts:259-266`;
- V2 `packages/schema/src/session.ts:39-47`.

Map them in `packages/core/src/session/info.ts:25-40`, `packages/engine/src/session/session.ts:100-112` and `packages/core/src/share/archive.ts:250-263`.

**Task usage.** `packages/schema/src/task.ts:17-29` (`Task.Usage`) gains `codiumSteps`. It is filled at `packages/engine/src/task/manager.ts:179-186`, with the subagent record at `packages/engine/src/tool/subagent-lifecycle.ts:148-175`.

**Spend snapshot and event.** `RunBudget.Snapshot` (`packages/schema/src/run-budget.ts:31-41`) and `session.spend` (`packages/schema/src/session-status-event.ts:52-66`) gain `codiumSteps`. Two hand-written mappings would drop it silently:
- the V2 `GET /api/session/:id/spend` handler copies the snapshot field by field (`packages/server/src/handlers/session.ts:331-347`);
- the desktop folds drains with `combineSpend` (`packages/desktop/src/main/run-usage.ts:92-100`), which sums `unpricedSteps` and must sum `codiumSteps` too.

The guard's own records also need it: `Run` (`packages/core/src/spend-guard.ts:73-90`, initialised at `:133`), the two `Spend` publishes (`:706-731`), `snapshot`, which returns the `Run` as it is (`:768-772`), `ScopeSnapshot` (`:331-340`) with its mapping in `scopes` (`:773-795`), and the persisted `Task.BudgetScope` (`packages/schema/src/task.ts:33-42`). These budget scopes already exist on main, not only on the self-evolving branch.

**Usage summary.** `packages/engine/src/session/session.ts:300-356` (schema), `:1188-1240` (`stepUsage`) and `:1242-1430` (`summarizeUsage`):
- Codium messages and ancillary entries leave every token total: lifetime, days, input, output, reasoning, cache, peak, longest-task, average per chat, `favoriteModels` and `effortLevels`.
- They still count in activity: completed chats, conversations, streaks, active days and `modelResponses`.
- They still count in `unpricedResponses`.
- New fields: `codiumResponses`, `UsageDay.codium` (count) and `UsageHelper.codiumSteps`.
- `favoriteModels` never lists a `vector-plan` model, because its token share would reveal relative Codium tokens.
- A Codium-only day must still produce a `UsageDay` (tokens 0, `codium` > 0, `tasks` counted). Settings → Usage shows its empty state when `days` is empty (`usage.tsx:419-425`), and the heatmap level comes from `day.tokens` (`:433`), so a Codium-only user would otherwise see "Use Vector for a model task…" and blank cells.
- `packages/schema/src/usage-report.ts:157-205` (`fromSummary`) forwards none of the Codium fields (D-5).

### 4.3 The spend guard (caps stay intact)

**Cost kind.** `CostKind` gains `"codium"` in two places: `packages/schema/src/run-budget.ts:25` and `packages/core/src/review/types.ts:21`, which `spend-guard.ts:19-24` holds equal at compile time. `costKindOf` (`spend-guard.ts:37-43`) takes `codium?: boolean`, checked first. Callers:
- `packages/engine/src/session/processor.ts:195-211`
- `packages/core/src/session/runner/model.ts:194-221`
- `packages/engine/src/review/model.ts:128-145`
- `packages/app/src/features/pull-requests/ai-review.ts:357-366`
- `packages/desktop/src/main/agent-task-model.ts:32-34,60-61`
- missed in the first pass: `packages/engine/src/tool/research-plan.ts:503-512` (the V1 research plan card; the core one at `packages/core/src/tool/research-plan.ts:108-133` is the V2 path) and `packages/engine/src/session/distill.ts:145-160`.

Closed lists of cost kinds outside the two `CostKind` types also need `"codium"`: `packages/core/src/brain/knowledge.ts:212` (a literal union), and the memory API schemas that use `RunBudget.CostKind` (`packages/engine/src/server/routes/instance/httpapi/groups/memory.ts:368,399`) follow automatically.

**`afterStep`** (`spend-guard.ts:168-176`): a Codium step adds $0, adds nothing to the guard's `unpricedSteps` (which counts only `unknown` steps, line 173), and adds 1 to a new `codiumSteps`. *(Corrected: the first draft added Codium to `unpricedSteps` and subtracted it again in `checkLimits`. That is not needed, and it made the desktop read every Codium-only run as unmeasured through `run-usage.ts:83`.)*

**`checkLimits`** (`:233-246`) needs no change. Its dollar checks already run only for `priced` and `unknown` steps (`:237`), so once `costKindOf` returns `"codium"`, Codium skips the dollar cap, the prediction and the 40-step unpriced stop, exactly as `plan` does (D-3). Step and loop limits are unchanged.

**Stop errors.** `BudgetStopError` (`packages/core/src/v1/session.ts:77-84`) gains optional `codiumSteps`, set from the snapshot at `processor.ts:399-407` and `prompt.ts:2100-2107`, so the stop card and `vector run` can leave out a "$0.00 spent" line.

**What stays as it is.** Compaction reads per-step tokens (`processor.ts:731`, `prompt.ts:2307`). The gateway's `MODEL_PLAN_CONTEXT` refusal still triggers compaction. Step and loop rules, the multi-agent delegated ledger and judges are unchanged. Learned workflow insights read per-message tokens. None of these read the session token totals, which now leave Codium out.

### 4.4 Should the server stop sending Codium tokens and costs?

- **vectordev.ai gateway: no.** Keep forwarding `usage` tokens (`api/_lib/model-plan-chat.ts:314-339`). Compaction and the context checks depend on them (`docs/vector/MODEL-PLANS.md:100`). Costs are already stripped, as are `cost_details`, `is_byok`, the serving provider and its fingerprint. Hardening for later: the engine could estimate context from bytes and rely on `MODEL_PLAN_CONTEXT` refusals. It would lose the provider-counted meter, so this plan does not do it.
- **Local engine API: yes for totals and summaries; no for per-step records, yet.**
  - Totals and summaries stop carrying Codium tokens (4.2): session totals, `Task.usage`, the usage summary, spend snapshots and the distill result. These exist only for display.
  - Per-message and per-step records keep their values plus the flag. That covers V1 `Assistant.tokens` and `StepFinishPart.tokens`, which are required fields, and V2 `Step.Ended`. Old decoders, the app's context meter (`session-context-metrics.ts:54-63`), economics `measureUsage` (`features/economics/token-usage.ts:84-115`, which already treats `unpriced` messages as having no cost) and the TUI plugin API all need them.
  - Optional follow-up, one release later, once every first-party client reads the flag: redact Codium per-message tokens in the HTTP and SSE serializer only. Replace them with a server-computed `context` share and leave the internal event bus untouched. Defer it: redacting `message.updated`, `message.part.updated`, `session.updated` and `Step.Ended` on one path and not another is easy to get partly wrong.
- **Printed and posted output: yes.** CLI JSON flags, GitHub, check-ins and ACP leave Codium token and cost values out (3.4, 3.6, 3.8, 3.9).

---

## 5. Settings → Usage: the percentage view

**Where.** `SettingsVectorCodium` (`packages/app/src/components/settings-vector-codium.tsx:9-140`) sits at the top of Settings → Usage (`packages/app/src/components/settings-v2/usage.tsx:159`). It stays the one place where a subscriber reads Codium usage on this page. The account page (`packages/web/src/components/marketing/account/ModelPlans.tsx:133-147`) and `vector codium` (`packages/core/src/model-plan-status.ts:211-223`) show the same figures.

**What it shows, per plan.** One active plan per account: Plus, Pro, Max or Ultra, from `packages/schema/src/codium-plan.ts:7-12`.

| Row | Copy | Source |
|---|---|---|
| Plan | `Plus` (or `Free`), with `Renews Nov 26, 2026` / `Ends Nov 26, 2026` | `plan.name`, `plan.renewsAt`, `plan.cancelAtPeriodEnd` |
| This month | The same meter Settings → Account already draws (`components/settings-v2/account.tsx:302-313`: `role="meter"`, `aria-valuenow` = **left** %, `data-tone` from the notice), then `36% used · 64% left`. *(Corrected: the first draft had this meter count "used", which would make two meters for the same figure run in opposite directions. Reuse `account-model.ts:28-55` and the `.settings-account-meter` style instead of a second implementation.)* | `plan.left`. Used = `100 − round(left·100)`, so the two always add to 100 |
| Purchased credits | `Available` / `Running low` / `Used up` / `None` | `ModelPlanStatus.formatPurchased` (`model-plan-status.ts:199-204`). A state, never a share, for the reasons at `api/_lib/model-plan-status.ts:82-90` |
| Notice | The existing low, empty and unavailable text (`model-plan-status.ts:226-245`) | `ModelPlanStatus.notice` |
| Footnote | `Rounded to the nearest whole percent, so a small request may not change it. Work on Codium models shows as Codium elsewhere in Vector; Vector never shows Codium tokens or dollars.` | static |
| Freshness | `Updated just now` / `Updated 4 min ago`, next to Refresh | client time of the last successful fetch |

- **Purchased credits only, no plan:** the This month row is hidden, and the Plan row reads `Free · purchased credits`.
- **Signed out, error, or Codium not on sale:** the existing states at `:62-69` and `:114-124` are unchanged.

**How it updates.** The desktop main process reads `/api/model-plans/status` with the account token (`settings-vector-codium.tsx:13-41`). The server computes the share live from the ledger, rounded to whole percent (`api/_lib/model-plan-status.ts:41-80,92-94`). The card refreshes:
- on open, as today;
- on sign-in and sign-out, as today (`:39`);
- on Refresh;
- when the window regains focus, at most once a minute;
- once, 15 seconds after any Codium turn ends while the page is open. The gateway debits the charge after the stream ends. The turn's end is detected from session idle on a session whose last step has `billing: "codium"`.

Use the notifier the app already has for this: `codiumChanged()` / `onCodiumChange()` (`packages/app/src/vector-account.ts:79-92`), which purchases fire today (`components/codium-purchase.tsx:50,56`) and Settings → Account and the sidebar account chip already listen to (`components/settings-v2/account.tsx:383`, `components/workspace-navigation.tsx:180`). Two gaps: `SettingsVectorCodium` does not subscribe to it yet (it listens only to sign-in changes, `settings-vector-codium.tsx:39`), so an in-app purchase leaves Settings → Usage stale; and the "Codium turn ended" trigger should call `codiumChanged()` once, so every Codium screen refreshes together.

No polling loop runs while the page is closed.

**The rest of the Usage page** (`usage.tsx`):
- **Subtitle (`:147-152`):** `Tokens and cost cover models you use with your own keys, plus free and local models. Work on Vector Codium models shows as Codium; your plan's usage is the percentage above.`
- **Lifetime tokens (`:177-180`):** `1.2M + Codium`. Codium only: `Codium`.
- **Recorded cost (`:197-207`):** goes through `withCodium`, given own unpriced steps (`unpricedResponses − codiumResponses`).
- **Average tokens per chat (`:212-215`):** own tokens divided by chats that had own tokens.
- **Streak and heatmap day titles (`:265,437,489`):** `12,345 tokens + Codium` or `Codium`. A Codium-only day is still active and gets a distinct cell style instead of an empty-looking cell: the level is computed from `day.tokens` at `:433`, so it needs `day.codium` there.
- **Favorite models (`:279-306`):** own models ranked by token share among own tokens. Below them, one row `Vector Codium · <most-used Codium model>` with `Codium` in place of the % and the token count. The raw `vector-plan` never shows (`:298`).
- **Vector helpers (`:356-391`):** `Codium` or `$0.12 + Codium`, never `$0.00` (`:382-384`). Tokens `Codium` or `N + Codium` (`:376-377`).
- **Token activity (`:395-489`):** input, output, reasoning, cache and peak are own-only, with one line `+ Codium work, shown as a percentage above`.

---

## 6. Version skew

| Pairing | What happens | What this plan does |
|---|---|---|
| Older desktop or CLI (≤1.99.112) + new vectordev.ai | They keep showing Codium tokens, as today. | D-6: the server answers `enabled: false` from `/api/model-plans/models` (`api/_lib/model-plan-models.ts:10-30`) to clients without `X-Vector-Client` ≥ `MODEL_PLANS_MIN_CLIENT`. New clients send the header on the catalog read, which is what the gate answers (`packages/core/src/model-plans.ts:95-100`, the `load` call to `CATALOG_URL`), on chat (the "Destination, headers and credential are fixed here" block, `:273-278`) and on status reads (`model-plan-status.ts:97`, `fetchStatus`). *(Corrected: the first draft put the header only on the chat block, which the models gate never sees.)* Gate chat as well, not optionally: clients keep the last catalog answer on disk and use it before vectordev.ai answers (`model-plans.ts:37-38,80-93`), so an old client with a cached `enabled: true` would keep chatting until its next successful read. Set the minimum before sales open. No customer is affected, because Codium has never been sold. |
| New desktop + vectordev.ai not yet redeployed | Status and models are unchanged. No tier fields, and the header is ignored. | Every listed model counts as available, with no tier badge. |
| New app or TUI + older engine (web app against a remote `vector serve`, or `vector attach`) | No `billing` and no `codiumSteps`. Old totals mix Codium tokens in. | `Billing.of` falls back to `providerID`. When `codiumSteps` is undefined and the session's model (`Session.model.providerID`) or any loaded message is Codium, the client hides the session's **token** totals entirely (`Codium`) and shows dollars as `$X + Codium`. Old dollar totals never included Codium. |
| Older app or TUI + new engine | Totals no longer hold Codium tokens and still count Codium in `unpricedSteps`, so they read "Cost unknown" or "$X + unpriced" with own tokens only. A new `"codium"` cost kind hits default branches: in the TUI, task usage reads "cost partly unknown". | Accepted. The leftover leak is per-message tokens in old context meters. The desktop always ships app and engine together, so this happens only on the web and with attach. |
| Desktop main + engine | Bundled together. `run-usage.ts:24` decodes `RunBudget.Snapshot` with the schema. | No skew. |
| Downgrading the database (1.99.113 → 1.99.112) | The old schema ignores the extra columns. New optional fields on durable events and messages are ignored on decode: the default `onExcessProperty` is "ignore", and only teams and share transport use "error". The old projector adds Codium tokens to totals again for new steps. | Accepted. Persisted subagent records already carry `costKind` on main: `budgetScopes` is stored in session metadata (`packages/engine/src/task/manager.ts:202,465`, `packages/engine/src/tool/task.ts:1132`) and read back with `Schema.Array(Task.BudgetScope)` (`packages/engine/src/tool/subagent-lifecycle.ts:59-60`). An older engine fails that decode on a `"codium"` scope and drops all the record's scopes, which is safe but loses them. On the self-evolving branch, decode an unknown kind as `"unknown"`, as WP1 already does for interruption causes. |
| Archives | An old version importing a new archive ignores `billing` and recomputes totals with Codium tokens in. | Accepted. |
| GitHub review state | New writers add `k` and leave Codium tokens out. Old readers ignore `k`. | Old Action versions running Codium would still add tokens; none does today. |
| SDK consumers | New optional fields. The `CostKind` union gains `"codium"`. | Say so in the release note. |

---

## 7. File-by-file changes, in work packages

Build these on the self-evolving branch (`~/.cache/vector-evolve`, ships 1.99.113), so the multi-agent surfaces use the helpers from the start (section 11). Land C12's web and API changes on main only after 1.99.113 is published. Each package is one commit with its tests. Run full suites only on GitHub (a temporary branch, deleted afterwards). The repository is public, so ask the owner before pushing that branch. Locally, run at most single test files, and not while Vector is in use.

### C1. Contract (no change in behaviour)
1. New `packages/schema/src/billing.ts` (section 2), exported from the schema package's index.
2. `packages/schema/src/run-budget.ts:25` and `packages/core/src/review/types.ts:21`: `CostKind` gains `"codium"`. Add a codium case to `packages/core/src/review/plan.ts:57` (`combineCostKinds`). Also the literal union at `packages/core/src/brain/knowledge.ts:212`.
3. Optional `billing` on:
   - `packages/schema/src/v1/session.ts:259-275` and `:481-502`;
   - `packages/schema/src/session-message.ts:180-216`;
   - `packages/schema/src/session-event.ts:163-183` (Step.Ended), the compaction events, and `:216-222` (ancillary).
4. Optional counts:
   - `codiumSteps` and `subagentCodiumSteps`: `v1/session.ts:593-601`, `packages/schema/src/session.ts:39-47`, `packages/engine/src/session/session.ts:259-266`.
   - `codiumSteps`: `run-budget.ts:31-41`, `session-status-event.ts:52-66`, `packages/schema/src/task.ts:17-29` (`Task.Usage`) and `:33-42` (`Task.BudgetScope`), and `BudgetStopError` (`packages/core/src/v1/session.ts:77-84`).
   - `codiumResponses`, `UsageDay.codium` and `UsageHelper.codiumSteps`: `packages/engine/src/session/session.ts:300-356`.
5. Replace the provider-id literals with `Billing`:
   - `packages/core/src/model-plan-status.ts:19`
   - `packages/core/src/plugin/provider/vector-plan.ts:10`
   - `packages/schema/src/provider-policy.ts:220`
   - `packages/app/src/features/economics/format-spend.ts:25`
   - `packages/app/src/utils/provider-brand.ts:113,367`
   - `packages/app/src/components/settings-providers.tsx:33`
   - `packages/app/src/components/settings-v2/providers.tsx:35`
   - `packages/app/src/components/dialog-select-model.tsx:147`
   - `packages/app/src/components/dialog-select-provider.tsx:45`

   Leave `features/research/research-model.ts:197` alone: its `vector-plan:` prefix is unrelated.
6. Regenerate `packages/sdk/openapi.json` and `packages/sdk/js` (`packages/sdk/js/script/build.ts`, which runs the engine's `generate`). Also regenerate the second generated client, `packages/client/src/generated` and `src/generated-effect` (`bun run --cwd packages/client generate`): it is built from `packages/protocol` and the schema package, and CI fails on any drift (`.github/workflows/test.yml:82-85` runs `check:generated`). Never hand-edit any of them.
- **Tests.** New `packages/schema/test/billing.test.ts`: `of` with the flag, with the provider id, and with neither. Decode checks that old payloads without the new fields still decode, and that new ones round-trip. The compile-time CostKind equality must still hold.

### C2. Engine stamping
- `packages/engine/src/session/session.ts:843-847` (stamp messages) and `:451-530` (`getUsage` returns `billing`; Codium is never priced from metadata).
- `packages/engine/src/session/processor.ts:668-686`: copy `billing` onto the step part and the message.
- `packages/core/src/session/runner/llm.ts:411-424` and `runner/model.ts:194-221`: the V2 step flag and cost kind.
- `packages/core/src/session/message-updater.ts:200-221,391-402`: carry `billing` onto V2 assistant and compaction rows.
- `packages/core/src/session/compaction.ts:243-260`.
- `packages/engine/src/session/title-usage.ts:21`.
- `packages/engine/src/session/processor.ts:195-211`: `costKindOf({ codium })`.
- **Tests.**
  - `packages/engine/test/session/processor-effect.test.ts`: a Codium step-finish and its message carry `billing`; cost 0, `unpriced` true.
  - `packages/engine/test/session/title-usage.test.ts`: it already uses `vector-plan` at `:275`. Assert the flag. Its `:289` pins today's totals (`tokens_input: 200, tokens_output: 6` on the session row) and must change to tokens 0 with `codium_steps: 1` once C3 lands.
  - `packages/core/test/session-runner.test.ts`: Step.Ended has the flag.

### C3. Accounting
- `packages/core/src/session/projector.ts:27-61,63-100,119-171,283-287,317-343,499-596`. `:317-343` is the strip list in 4.2; missing it is the one change here that corrupts data.
- `packages/core/src/session/sql.ts:48-66`, the migration, and the regenerated `schema.gen.ts` and `migration.gen.ts`.
- Info mappings: `packages/core/src/session/info.ts:25-40`, `packages/engine/src/session/session.ts:100-112` (`fromRow`) and `:133-182` (`toRow`), `packages/core/src/share/archive.ts:250-263`.
- `packages/engine/src/task/manager.ts:179-186` and `packages/engine/src/tool/subagent-lifecycle.ts:148-175`: `codiumSteps` on task and subagent usage.
- `packages/engine/src/tool/task.ts:309-326`: notification wording (3.3).
- **Tests.**
  - `packages/core/test/session-projector.test.ts`:
    - a Codium step adds 1 to `codium_steps` and `unpriced_steps` and 0 tokens;
    - revert takes it back;
    - a moved part keeps its routing;
    - the rollup reaches ancestors (`subagent_codium_steps`);
    - ancillary and compaction Codium usage is routed the same way;
    - a `SessionV1.Event.Updated` published after a Codium step leaves `codium_steps` as it was.
  - `packages/core/test/database-migration.test.ts`: the migration applies to an existing database.
  - `packages/engine/test/tool/task*.test.ts`: notification text.

### C4. Spend guard and caps
- `packages/core/src/spend-guard.ts:37-43` (`costKindOf`), `:73-90,133` (`Run.codiumSteps`), `:168-176` (`afterStep`), `:331-340,706-731,773-795` (scope snapshots and spend events). `checkLimits` (`:233-246`) is unchanged (4.3).
- `packages/server/src/handlers/session.ts:331-347`: copy `codiumSteps` into the V2 spend response.
- `packages/engine/src/session/processor.ts:399-407` and `packages/engine/src/session/prompt.ts:2100-2107`: `codiumSteps` on `BudgetStopError`.
- `packages/core/src/research/plan.ts:25-27` (wording only) and `packages/core/src/research/estimate.ts:117-132`.
- `packages/core/src/tool/research-plan.ts:108-133` and `packages/engine/src/tool/research-plan.ts:503-512`: `kind === "codium"` gives `Uses your Vector Codium plan; Vector shows no cost estimate for Codium.`
- `packages/engine/src/tool/research-report.ts:70-87` and `packages/core/src/tool/research-report.ts:86-106`: the report's spend wording adds `+ Codium` from the guard's `codiumSteps`.
- `packages/desktop/src/main/run-usage.ts:14-23,76-85,92-100`: `EngineSessionResponse` gains `codiumSteps`; `measuredCost` needs no Codium case once the guard leaves Codium out of `unpricedSteps` (a Codium-only run gives the own delta, 0); `combineSpend` sums `codiumSteps`.
- **Tests.** `packages/core/test/spend-guard.test.ts`:
  - a Codium run under a $1 cap runs past 40 steps;
  - the step limit still stops it;
  - a mixed run stops on its priced spend;
  - `codiumSteps` appears in the snapshot and in the scope snapshots, and `unpricedSteps` stays 0 for a Codium-only run.

  Also `packages/desktop/src/main/run-usage.test.ts` and `packages/engine/test/tool/research-plan.test.ts`.

### C5. Usage summary and check-ins
- `packages/engine/src/session/session.ts:1188-1430` (4.2).
- `packages/schema/src/usage-report.ts:157-205`: no Codium fields.
- Senders follow automatically: `packages/desktop/src/main/usage-checkin.ts:58-64,238-250` and `packages/engine/src/cli/usage-report.ts:20-63`.
- **Tests.**
  - `packages/engine/test/session/usage.test.ts`: Codium tokens are left out, `codiumResponses` is counted, streaks still count Codium days, and `favoriteModels` has no `vector-plan`.
  - `test/usage-api.test.ts:398-420`: a check-in never carries `vector-plan`.
  - `packages/desktop/src/main/usage-checkin.test.ts`.
  - **HttpApi exerciser** (`packages/engine/test/server/httpapi-exercise/index.ts:67-110`): add a scenario for `experimental.session.usage`.
    - Seed a Codium assistant message and step-finish part through the session service. Codium's destination is fixed, so it cannot point at the test LLM server.
    - Assert `lifetimeTokens` leaves the Codium tokens out, `codiumResponses === 1` and no `vector-plan` in `favoriteModels`.
    - Add a session-get scenario asserting `codiumSteps`, and extend `v2.session.spend` (`:1614-1623`) for a guarded Codium run.
    - Run it through `test:httpapi` (`packages/engine/package.json:11`) in CI.

### C6. App session surfaces
- New `packages/core/src/codium-usage.ts` (`withCodium`, own-step helpers).
- `packages/app/src/features/economics/format-spend.ts:34-123`:
  - `sessionReading` takes `codiumSteps` and reads Codium from totals, no longer from `lastAssistantModel` (`:109-113`); the last model now only picks the "free" or "ChatGPT plan" wording.
  - `spendPill`.
  - `SPEND_TOOLTIP`.
- `packages/app/src/utils/session-cost.ts:5-88`: `formatSessionCost` gets own unpriced steps and the Codium wrap; `sessionSpend`, `sessionTokens` and `delegatedSpend` carry `codiumSteps`.
- `packages/app/src/components/session-delegated-spend.ts:10-50`.
- `session-cost-readout.tsx`, including the visibility guards at `:100` and `:182` (3.1), `session-context-usage.tsx` and `session/session-context-tab.tsx`, with `session-context-metrics.ts`.
- `pages/session/composer/session-working-status.tsx` and `session-composer-region-controller.ts:143-185`.
- The `en.ts` keys from section 2.
- **Tests.**
  - Update `features/economics/format-spend.test.ts:60-64,118-127,162-166`, `utils/session-cost.test.ts:14-20` and `components/session/session-context-metrics.test.ts`.
  - New e2e `packages/app/e2e/regression/codium-usage-labels.spec.ts`, built on `mockVectorServer` as in `session-cost-readout-style.spec.ts`, with one Codium-only session and one mixed session. It asserts:
    - the pill text;
    - the tooltip rows;
    - the Context tab rows;
    - that **no digits** appear next to the Codium labels.

### C7. App other surfaces
- `pages/home.tsx:1062-1078`.
- `components/settings-v2/usage.tsx` (section 5); `utils/usage-summary.ts` (`normalizeUsageSummary` passes the new fields through).
- `components/settings-vector-codium.tsx` (the Account meter reused, used/left, freshness, refresh triggers, and an `onCodiumChange` subscription).
- `utils/provider-brand.ts:91-96` (and the search words `"codium", "credits"` at `:199`).
- `features/background-tasks/task-board-model.ts:152-174`, `background-tasks-pane.tsx` (lines in 3.2) and `subagent-model.ts`, including `childFacts` (`:479-525`).
- `features/pull-requests/ai-review.ts:187,535-574` (live tracker and spend text) and `pages/layout-new.tsx:6875`.
- `features/economics/session-outcomes.ts` and `workspace-outcomes.ts`: record no outcomes for Codium sessions.
- `features/agents/agent-dashboard-model.ts:241-250`.
- `settings-v2/spend-limits-model.ts:65-91` and `spend-limits.tsx`.
- `components/budget-stop-copy.ts:34-56`.
- `features/research/research-model.ts:144-157`.
- `features/economics/economics-recommender.ts` (exclude Codium) and `prompt-input.tsx:2040-2046`.
- `settings-v2/memory-documents-model.ts:555-562,724-735`.
- **Tests.**
  - Update `components/dialog-select-model.test.ts:112-122` ("Codium credits" → "Codium").
  - Update `features/background-tasks/task-board-model.test.ts:103-104`, `subagent-model.test.ts`, `features/agents/agent-dashboard-model.test.ts`, `settings-v2/spend-limits-model.test.ts`, `components/budget-stop-copy.test.ts`, `features/research/research-model.test.ts`, `features/economics/economics-recommender.test.ts` and `settings-v2/memory-documents-model.test.ts`.
  - E2E: extend `e2e/regression/account-settings.spec.ts:106-115` with the Settings → Usage meter and used/left text.

### C8. Desktop main
- `packages/desktop/src/main/spend-limits.ts`:
  - `SpendEvent` gains `billing?: "codium"` (`:35-45`), set only on a mixed run's event (a Codium-only run appends no event, 3.2);
  - Codium runs store own tokens only;
  - `windowTotal` (`:485-503`) reports whether the window holds a mixed Codium run, for the `+ Codium` suffix;
  - `SpendAllowanceInput` (`:81-90`) gains `billing?: "codium"`, and `evaluate` (`:283-330`) neither blocks such a run on a dollar window nor reserves `budgetUsd` for it (D-3). Callers pass it when the run's model is known: `parallel-workspaces.ts:2212` and `scheduled-agents.ts:574`. With the model unknown, keep today's check.
- `packages/desktop/src/main/parallel-workspaces.ts:2594-2615`: set `billing` from the session's `codiumSteps`. **Breakage to avoid:** once a Codium-only run measures as $0 instead of undefined, `:2613` would write `actualCost: "$0.00"` and the card would show it; leave `actualCost` unset when the run's own cost is 0 and it has Codium steps. `:442-443` passes `billing` to the card.
- `packages/desktop/src/main/scheduled-agents.ts:525-542`.
- `packages/desktop/src/main/agent-task-model.ts:32-34,60-61`.
- IPC passes `billing` through (`ipc.ts:534-549`, preload `:114-118`).
- **Tests.** `spend-limits.test.ts`, `agent-task-model.test.ts`, and the `parallel-workspaces` card test if one exists.

### C9. TUI and CLI text
- TUI:
  - `packages/tui/src/util/locale.ts:85-98` and `packages/tui/src/util/session.ts:56-92`;
  - `component/prompt/index.tsx:249-267`;
  - `routes/session/subagent-footer.tsx:33-50`;
  - `feature-plugins/sidebar/context.tsx:16-31,76-86`;
  - `routes/session/task-presentation.ts:3-40`;
  - `context/data.tsx:224-235`: the V2 `step.ended` reducer copies cost, `unpriced` and tokens onto the message and must copy `billing`.
- Engine CLI:
  - `cli/cmd/run/session-data.ts:142-158,826-861`;
  - `cli/cmd/run.ts:151-156` (help text);
  - `cli/cmd/stats.ts`, both the V1 message sums and the V2 row read (`:183-249`);
  - `cli/cmd/tasks.ts:135-168`;
  - `cli/cmd/memory-doc.ts:388-434`;
  - `cli/cmd/models.ts:102-106,114-116`.
- **Tests.** Update `packages/tui/test/task-presentation.test.ts`, `packages/tui/test/util/locale-spend.test.ts`, `packages/engine/test/cli/run/session-data.test.ts`, `packages/engine/test/cli/stats.test.ts` and `packages/engine/test/cli/tasks.test.ts`.

### C10. Machine output and ACP
- `packages/engine/src/cli/cmd/run.ts:1131-1141,1184-1188`: redact Codium `step_finish` tokens.
- `cli/cmd/review.ts:451,480,654`.
- `cli/cmd/memory-doc.ts` `--json`.
- `packages/engine/src/session/distill.ts:144-165,232-256` and `server/routes/instance/httpapi/groups/memory.ts:357-401`: the Codium distill result carries `costKind: "codium"` and no tokens. Store it the same way at `packages/core/src/brain/knowledge.ts:204-212`.
- `packages/engine/src/acp/usage.ts:88-158,251-260` and `acp/service.ts:645-661,845-866` (the error branch too).
- `cli/cmd/export.ts:167-224`: the legacy `--sanitize` path drops Codium tokens.
- **Tests.** `packages/engine/test/acp/usage.test.ts` (Codium steps skipped; no `usage_update` on a Codium latest step), `packages/engine/test/cli/review.test.ts` (JSON cost has no numbers), and a `run --format json` case.

### C11. Vectorscope and GitHub
- `packages/core/src/review/format.ts:118-131,469-471,865-877`.
- `packages/core/src/review/state.ts:368-376,522-537,551-556` (the new `k` key; `c` is taken).
- `packages/engine/src/review/model.ts:128-145` and `review/run.ts:218-224` (cost event `kind`).
- `packages/engine/src/cli/cmd/review.render.ts:217-253`.
- `cli/cmd/github.review.ts:687`.
- `cli/cmd/github.evidence.ts:106-129,207,258-271`.
- `packages/app/src/features/pull-requests/ai-review.ts` (lines in 3.4).
- **Tests.**
  - `packages/core/test/review/format.test.ts`: the Codium footer, the PR total with Codium, and no digits after "Codium".
  - `packages/engine/test/cli/review.render.test.ts`.
  - `packages/engine/test/cli/github.evidence.test.ts`: Codium only, and mixed.
  - `packages/engine/test/cli/github.review.test.ts` (the log line).
  - `packages/app/src/features/pull-requests/ai-review.test.ts:895-912`: a Codium review's status line has no "tokens so far".
  - A state test that a Codium review adds no tokens, sets `k`, and leaves `c` (dollars) as it was.

### C12. vectordev.ai, website, legal, docs (main, after the release)
- **API.**
  - `api/_lib/model-plan-models.ts:10-30` and `api/_lib/model-plan-chat.ts` (required, not optional; see the cached catalog in 6): the client-version gate (D-6), env `MODEL_PLANS_MIN_CLIENT`.
  - `api/_lib/model-plan-status.ts`: unchanged.
  - Optional: point the error copy at `model-plan-chat.ts:297` to the percentage in Settings → Usage.
- **Website, legal and docs copy:** section 9.
- **Tests.** `packages/web/test/model-plans-api.test.ts`: header present, missing and too old. Keep `:1030-1036,1310-1312`, which pin that tokens are forwarded. Copy tests are listed in section 9.

### C13. Self-evolving branch only (section 11)
- The workflow insight display and the multi-agent wording.

**Order.** C1 → C2 → C3 → C4 → C5 → C6, then C7, C8, C9, C10 and C11 in any order, then C13, then a release, then C12, then set `MODEL_PLANS_MIN_CLIENT`, then sales can open.

---

## 8. Tests at a glance

- **Existing tests that pin today's wording:**
  - `packages/app/src/features/economics/format-spend.test.ts:60-64,118-127,162-166`
  - `packages/app/src/utils/session-cost.test.ts:14-20`
  - `packages/app/src/components/dialog-select-model.test.ts:112-122`
  - `packages/app/src/features/background-tasks/task-board-model.test.ts:103-104`
  - `packages/app/src/features/pull-requests/ai-review.test.ts:895-912`
  - `packages/tui/test/task-presentation.test.ts`
  - `packages/tui/test/util/locale-spend.test.ts`
  - `packages/engine/test/cli/run/session-data.test.ts`
  - `packages/engine/test/cli/review.render.test.ts`
  - `packages/core/test/review/format.test.ts`
- **Existing tests that pin today's Codium totals** (missed in the first pass):
  - `packages/engine/test/session/title-usage.test.ts:270-292`: asserts the session row holds the Codium title's `tokens_input: 200, tokens_output: 6` (`:289`). It becomes tokens 0 with `codium_steps: 1`.
  - `packages/engine/test/session/prompt.test.ts:976-1012` (a Codium subagent's steps): still valid for `unpricedSteps`; extend it with `codiumSteps`, `subagentCodiumSteps` and zero tokens on the parent and the child.
  - `packages/engine/test/session/prompt.test.ts:940-973` and `packages/engine/test/provider/model-plans.test.ts:168,361`: they check per-step and ancillary records, which keep their tokens (D-2). Add the `billing` flag; leave the token assertions.
- **Tests that pin the percentage, kept as they are (D-4):**
  - `packages/app/src/components/settings-v2/account-model.test.ts:41-52`
  - `packages/app/e2e/regression/account-settings.spec.ts:106-115`
  - `packages/web/test/model-plans-api.test.ts:1317-1319`
  - `packages/web/src/components/marketing/account/ModelPlans.test.ts:48-53,134,160` (`:134` already forbids "tokens")
  - `packages/web/test/docs-settings.test.ts:28-29`
- **New tests:** C1–C11 above. Plus one guard test, `packages/app/src/features/economics/codium-no-figures.test.ts`, that renders every app formatter with a Codium-only and a mixed fixture and fails if a digit follows "Codium" or a `$0.00` appears beside it.
- **Public share regression:** extend `packages/core/test/public-session-share.test.ts` to assert that no `billing`, tokens or cost reach the public archive.
- **Naming check:** `test/codium-plan-names.test.ts:14` rejects "Codium 10|50|100|200". "Codium · Pro" passes.

---

## 9. Docs and legal copy

| File:line | Today | Change to |
|---|---|---|
| `docs/vector/MODEL-PLANS.md:17` | Models "each labelled 'Codium credits'" | "each labelled 'Codium'" |
| `MODEL-PLANS.md:21` | "Vector records each Codium step's tokens, and its dollar cost totals leave Codium steps out and say so" | "Vector keeps each Codium step's tokens for compaction but never shows them: wherever it would show tokens or a cost for Codium work it shows 'Codium', and totals that mix in your own keys read '+ Codium'. Codium usage shows only as a percentage in Settings → Usage, Settings → Account, `vector codium` and the account page." |
| `MODEL-PLANS.md:98` | "counts as unpriced: … leave it out and note that some steps are not in the total" | Describe `billing: "codium"`, the `codiumSteps` counts, totals without Codium tokens, the exemption from dollar caps (D-3), and that local raw data keeps tokens (D-2). Keep the sentence on tokens narrowing the credit amount. |
| `MODEL-PLANS.md:102` | "a share and states, never amounts" | Add the Settings → Usage meter and its refresh rules (section 5). |
| `MODEL-PLANS.md:3` | "the same curated model catalog at every price" | Tier package (section 10). Leave it alone in this change. |
| `MODEL-PLANS.md:23` ("Seeing the balance") | Settings → Account and Settings → Usage show the share left; "No Vector screen shows an amount of credits" | *(Corrected: this paragraph is not tier copy.)* Update it in this change: add the Settings → Usage meter and its used/left text, and that Vector shows Codium work as "Codium", never as tokens or dollars. |
| `MODEL-PLANS.md:9` | "the app and the CLI show the share of this month's credits remaining" | Add "and label Codium work 'Codium'". |
| `packages/web/src/pages/docs/tokenomics.astro:11-14,29-32` | "every chat is priced at list price"; Usage shows lifetime tokens and cost | Add the Codium exception and its "Codium" label. |
| `packages/web/src/data/docs-content.ts:6-7,49-50` | "Unpriced is not free … Codium steps count as unpriced" | "Codium shows as Codium, not unpriced; dollar caps do not count it; step limits do." |
| `packages/web/src/pages/docs/terminal-agent.astro:63-67` | `--max-cost`: Codium steps "count as unpriced" | "are not counted; step limits still apply"; document the `step_finish` `billing` field |
| `packages/web/src/pages/docs/desktop-app.astro:72,80` | Account share; "Share usage counts" sends tokens and models | Add "Codium usage is not included" (D-5) |
| `packages/web/src/pages/docs/vectorscope.astro:34,254-255` | "Every review ends with the model, the tokens, what it cost" | "… or 'Codium' for a review on a Vector Codium model" |
| `packages/web/src/components/marketing/codium/CodiumPricing.tsx:594-599` | "Where can I see my balance?" | "As a percentage of this month's usage, in Vector's Settings → Usage and Settings → Account, `vector codium`, and your account page. Vector never shows Codium token counts or dollar amounts." |
| `CodiumPricing.tsx:543-544` | "spends credits for the tokens it actually uses…" | "uses more of your plan for larger models and longer work" (no token wording) |
| `packages/web/src/pages/legal/terms.astro:48-49` | Usage shown "as Codium credits or usage estimates" | "as a percentage of your plan's monthly usage, and purchased credits as available, running low or used up" |
| `terms.astro:57-59` | "not a promise of a fixed number of tokens… estimated tokens or typical tasks" | Keep "not a promise of a fixed number of tokens". Drop "estimated tokens" if the purchase screen no longer shows them. |
| `terms.astro:62-64` | "Your displayed balance may lag… Review usage… in your account" | "The percentage shown is rounded to whole percent and may lag recent requests; it is the measure of usage Vector and your account page show." |
| `terms.astro:67-72` | Non-refund and billing-error remedy | Unchanged. **Owner and legal review**: percentage-only display means people cannot check metering themselves. |
| `packages/web/src/pages/legal/privacy.astro:308-315` | Check-ins send "the totals shown in … Usage & streaks", tokens and cost | Add: "Vector Codium usage is not included; vectordev.ai measures it at the gateway to bill your plan." |
| `packages/web/src/data/vector-releases.ts` | — | Add a release note for 1.99.113. Leave the historic notes (`:712,718`; `docs-content.ts:321`) as history. |
| `api/help/chat.ts:41-52` | No Codium entry | Optional: a short Codium entry for the Help assistant (percentages, "Codium" label). |

Copy tests to update in the same commit:
- `packages/web/src/components/marketing/codium/CodiumPricing.test.ts`: the FAQ text, and `:296` stays (no "%" on plan cards).
- Any docs test that reads the changed pages.

---

## 10. Interaction with the tier change (models per tier)

- **One provider id for every tier.** `vector-plan` stays the provider for Plus, Pro, Max and Ultra. Detection (`Billing.isCodium`) and the label never depend on the tier. A provider id per tier would break detection in every surface above.
- **Catalog.**
  - `/api/model-plans/models` (`api/_lib/model-plan-models.ts:19-27`) keeps returning the whole catalog, with no billing read, so polls stay cheap. Each model gains `minTier`.
  - The account's tier comes from `/api/model-plans/status`, which already reads billing (`plan.id`, mapped through `packages/schema/src/codium-plan.ts:7-12`).
  - The client marks models above the tier `Codium · Pro`.
  - The gateway enforces the tier on chat with a new 402 code, `MODEL_PLAN_TIER`, and a **Change plan** action, never retried.
- **Purchased credits only:** owner decision (default: Plus models).
- **Usage stays a percentage of the current plan.** Upgrades and downgrades in a month are worked out on the server; the client shows `plan.left` only. Settings → Usage shows the plan name, so tiers need no change to this plan's display paths. `ModelPlanStatus.describe` already prints the plan name.
- **Heavy use** (the owner's worry, including Vectorscope):
  - Percentages and the gateway's credit refusals are the hard cap.
  - Dollar caps never applied to Codium (D-3).
  - Step and time limits still bound reviews (`packages/engine/src/review/run.ts:178`) and research (`packages/core/src/research/plan.ts:25-27`).
- **Helper calls on a Codium conversation will break with tiers.** Titles and memory helpers on a Codium session use `getSmallModel`, which for Codium sorts the catalog by `cost.input + cost.output` (`packages/engine/src/provider/provider.ts:2873-2877`). Every Codium model has the same zero `UNPRICED` cost (`provider.ts:1515,1772`), so the sort does nothing and the helper always runs on the first catalog model, not "the lowest ceiling" its comment promises. With tiers, that first model can sit above the account's tier, and every title request then fails with the new `MODEL_PLAN_TIER` 402. The tier package must pick the helper model from the account's tier: the conversation's own model, or the catalog's cheapest model the tier includes, sent as an explicit order from `/api/model-plans/models`.
- **Copy that conflicts with tiers.** It belongs to the tier package, not to this one. Changing it there avoids merge conflicts.
  - `MODEL-PLANS.md:3`
  - `ModelPlans.tsx:116,225,277`
  - `CodiumPricing.tsx:22,290-293,567,738-751`
  - `CodiumPricing.test.ts:124-151`
  - Also the gateway's `/config` route, which lists the same models publicly (`api/_lib/model-plan-models.ts:14-17` says so), once models differ by tier.
- **Plus models** (owner, 26 Oct): DeepSeek V4.1 Flash, GPT-6.1 Terra, Claude Haiku 5.5 and GPT-6 Luna. Each one reads "Codium" like any other Codium model. (30 Oct: Terra is out; see `codium-tiers-v3-changes.md` §8.)

## 11. Interaction with the multi-agent build (helpers on Codium)

- **Inheritance.**
  - Subagents inherit a Codium parent's model. There is no cheaper-model swap for an unpriced parent (`packages/engine/src/tool/task.ts:917-925`).
  - Swarms on a Codium primary route only to other Codium models (`packages/desktop/src/main/swarm-plan.ts:255-260`).
  - With tiers, a child's `model` parameter may name only Codium models in the account's tier.
  - A non-Codium parent never moves a child onto Codium unless the person named that model. Codium is never chosen automatically.
- **Delegated ledger** (multi-agent spec 4.8 and 5.B.6).
  - Its dollar ceiling counts `priced` and `unknown` steps, so Codium children count only against the running, per-request and step limits.
  - `ScopeSnapshot` gets `codiumSteps` from the guard (4.3). The scopes and their persisted form, `Task.BudgetScope`, already exist on main (`spend-guard.ts:331-340`, `schema/src/task.ts:33-42`), so C4 covers them there; the branch only has to keep them.
  - The 80% note and the ceiling stop never fire on Codium-only spend.
  - Running out of Codium credits mid-run fails the child with the gateway's 402. Its completion note says Codium usage is used up and offers **Buy credits** (the existing Codium action).
- **Wording in that spec.**
  - B.8's busy note "Each one spends on the user's provider keys" becomes "Each one spends on the user's provider keys or Vector Codium plan".
  - The Tasks header `limitsLine` (5.I.3) reads `Codium` for Codium-only spend.
  - The task notification follows 3.3.
- **Workflow progress.** The self-evolving `Task` schema gains `tokens: { used, max }`. On a Codium run, workflow progress reads `Codium` instead of "N of M tokens". A token cap still stops the run internally, and its stop message gives no numbers.
- **Learned workflow insights.**
  - Recording (`packages/engine/src/session/workflow.ts:204-260`) keeps Codium tokens internally; effort decisions within one model need them.
  - Settings → Memory → Workflow shows `Codium` in the arm cost cell (`packages/app/src/components/settings-v2/memory-workflow-model.ts:127-154`) and in `explain` (`packages/core/src/brain/workflow.ts:225-233`).
  - `costKinds` gains a `codium` key.
  - Insights never advise switching onto Codium or, by dollar comparison, off it, since its cost is unknown.
- **Judges.** Judges launched by `SessionPrompt.launchJudge` on a Codium parent are shown as helpers reading `Codium`.
- **Build order.** Land C1–C4 before multi-agent Phase 2 (caps and delegation), so `SubagentRecord` and `ScopeSnapshot` carry `codiumSteps` and the `"codium"` kind from the start. Phase 8's surfaces then use `withCodium` directly.

## 12. Risks and open points

1. **Hiding the numbers is display hiding, not secrecy.** Per-step tokens stay in the local database, local backups, the event stream and plugin API, and the gateway's stream (D-2). `MODEL-PLANS.md:98` already says so.
2. **The context percentage plus the public window size give a rough prompt size** (D-1). If the owner wants none, hide the ring and the Usage row on Codium. Compaction still works.
3. **Ending the 40-step stop (D-3) removes a brake** some users may have relied on. Step limits and the gateway's credits replace it.
4. **The old-engine fallback (6.3) is conservative.** It hides all token totals for sessions it cannot split.
5. **Owner test sessions recorded before the change** keep mixed totals until the fallback hides them. There is no backfill.
6. **Legal.** With a percentage-only display, people cannot check the metering, and a small request may not move the figure (`terms.astro:67-72`). This needs review before sales open.
7. **Grep for "vector-plan" after C1.** The matches should be `Billing`, the plugin, tests, and two kinds of unrelated or intended text: the research plan card's `vector-plan:` answer prefix (`packages/core/src/research/plan.ts:94-95,114`, `packages/schema/src/research.ts:47`, `packages/app/src/features/research/research-model.ts:197,327`, `features/research/plan-card.tsx:36`) and the hints that tell people to type `vector-plan/<model>` (section 2).

## 13. Review log (27 Oct 2026)

A read-only pass over `~/.cache/vector-main` (greps for tokens, cost, spend, price, usd, `$`, formatUsd/formatTokens, economics, usage, `vector-plan`, CostKind). Changes made above:

**Would have broken something**
1. Review state key: `c` already stores `costUsd` (`packages/core/src/review/state.ts:524,555`). The Codium review count moves to `k` (3.4, 6, C11).
2. Projector: `SessionV1.Event.Updated` strips usage columns before writing (`packages/core/src/session/projector.ts:317-343`). The new Codium columns must join that list, or every session update writes back a stale count (4.2, C3).
3. Cost pill: it is hidden unless cost or tokens are above 0 (`session-cost-readout.tsx:100,182`, `format-spend.ts:73`). With Codium tokens out of totals, a Codium-only session lost its pill (3.1, C6).
4. Run guard: adding Codium to the guard's `unpricedSteps` made the desktop record every Codium-only run as unmeasured (`run-usage.ts:83`). The guard never counted plan, free or local steps there; Codium now joins them, and `checkLimits` needs no change (2, 4.3, C4).
5. Desktop limits: `checkAllowance` blocks and reserves dollars for Codium runs (`spend-limits.ts:283-330`), and a $0 measurement would print `$0.00` on the agent card (`parallel-workspaces.ts:2613`) (D-3, C8).
6. Generated client: `packages/client` is a second generated client that CI checks for drift (`.github/workflows/test.yml:82-85`) (C1.6).
7. Hand-written copies that drop new fields: the V2 spend handler (`packages/server/src/handlers/session.ts:331-347`) and desktop `combineSpend` (`run-usage.ts:92-100`) (4.2, C4).
8. D-6 gate: the client-version header has to go on the catalog read (`packages/core/src/model-plans.ts:95-100`), not only on chat. Chat must be gated too, because the catalog is cached on disk (6, C12).
9. Tiers: helper calls on Codium always pick the first catalog model, since every Codium cost is 0 (`provider.ts:2873-2877`). Out-of-tier titles would fail (10).

**Surfaces the first pass missed**
- Subagent card live tokens summed from step parts (`subagent-model.ts:479-525`).
- Live Vectorscope tracker (`ai-review.ts:187,535-567`, `layout-new.tsx:6875`, `pull-requests.tsx:1480,1487`).
- `BudgetStopError` "$0.00 spent" line (`core/src/v1/session.ts:77-84`, `budget-stop-copy.ts:52-56`).
- V1 research plan card cost kind (`engine/src/tool/research-plan.ts:503-512`) and the research report "Spend:" line (`core/src/research/report.ts:294`).
- Distill cost kind (`engine/src/session/distill.ts:145-160`) and the `knowledge.ts:212` literal union.
- Economics outcomes storing Codium tokens (`session-outcomes.ts`, `economics-repository.ts`).
- V2 message updater (`message-updater.ts:200-221,391-402`) and TUI V2 reducer (`tui/src/context/data.tsx:224-235`).
- `vector stats` V2 row path (`stats.ts:186-204`).
- The `vector models` header (`models.ts:102-106`).
- The ACP error branch (`acp/service.ts:858-860`).
- Usage page empty state and heatmap levels (`usage.tsx:419-425,433`).
- Tests that pin today's Codium totals (`title-usage.test.ts:289`, `prompt.test.ts:976-1012`).

**Corrected facts**
- Settings → Usage reuses the Account meter, which counts "left" (`account.tsx:302-313`); the first draft counted "used".
- Refreshes use the existing `codiumChanged()` notifier (`vector-account.ts:79-92`).
- `MODEL-PLANS.md:23` is the balance paragraph and changes now; it is not tier copy.
- The usage dashboard is owner-only, and check-ins still send Codium activity counts (D-5).
- Typed model ids `vector-plan/<model>` stay (section 2, risk 7).
- Budget scopes already persist on main (6, 11).

**Checked and found clean** (no change needed): the public share and archive, team sync payloads (no usage), the gateway's forwarded usage (cost fields stripped, `api/_lib/model-plan-chat.ts:318-338`), `/api/model-plans/models` and `/status` (no amounts), desktop and app notifications (no figures), the TUI transcript export (model and duration only), app telemetry, bug reports and the Help assistant (no usage), and engine logs (no per-step figures besides compaction's pruned count).
