# Merging self-evolving into main: the plan

Updated 8 November 2026. First written on 5 November 2026 for your approval. Nothing has been merged into main and nothing has been pushed to main.

- `f062bcce` ("fix(merge): CI after main merge") is the last code commit on `self-evolving`, and every check ran on it. When this plan was updated, the commits after it changed only documents.
- `main` is at `4299d743` ("docs(validation): record complete main-branch consolidation").
- `f062bcce` is 159 commits ahead of main and 0 behind. Main's newer work is already merged into it (next section).
- When this plan was first written, `self-evolving` was at `98c6423a` and main at `1d853606`. Where a section describes that time, it says so.

## Main moved on 5 November 2026

After this plan was first written, main took 243 more commits (`4299d743`):

- the tokenomics agent's consolidation: spend accounting, run budgets, guard spend, prompt cache boundaries, usage uncertainty, title limits, task-wait cancellation, stats and benchmark evidence;
- research pull request #16: local OCR, scoped claims, document exports, and the combined research and revocation migrations.

Merging main into `self-evolving` then had 33 conflicting files. Main was merged into `self-evolving` in the commit "Merge main into self-evolving", and every conflict was resolved. Main's tokenomics and research code is kept as main has it, and the multi-agent and Codium behaviour is added around it. Where this plan says the merge is clean or has no conflicts, it describes main before 5 November. Pull request #20 was opened on 6 November at 01:42 UTC. The merge (`b7ba4fa9`), its review fix (`c879dffd`) and a CI fix (`f062bcce`) were then added to it. Main is still not changed.

The brain migrations run in date order: facets, revocation (main), learned skills and workflow (`self-evolving`), research claims (main). None was renumbered, and none had shipped in a release, so every existing brain.db upgrades.

Judgement calls, in plain words:

- **Subagent spend ceiling message.** When helpers stop at the shared spend ceiling because of steps it cannot price, the message now says "unpriced or incomplete steps". Main now also counts steps with incomplete usage there.
- **Standard request note.** It keeps main's "not routine tool calls". It drops the older "do the work yourself" and "Subagents are not offered", because Standard requests may now hand work to helpers. The task-size test expects the new wording.
- **Failed compaction.** As on main, a compaction call that was attempted always records its cost fields, even when it failed. On Codium that is cost 0, marked Codium.
- **Codium title and memory requests.** Main now charges title and memory requests to the run. A Codium one counts as a Codium step, not as an unpriced one, so it can no longer trip main's unpriced-step stop. This was added in main's title-usage code and in the prompt's helper cost check. Every other model is charged exactly as on main.
- **The skill drafter is charged like main's model learner.** Main charges each helper request to the run that launched it. The learned-skill drafter (`self-evolving`) now follows the same rule. Its request counts in that run's spend, unpriced and Codium figures, it is priced by the same helper cost check, and it sends nothing when the run has stopped since its snapshot, so the run keeps the plain draft. Before this, the drafter's cost reached the session's totals but not the run's.
- **Codium usage.** A Codium step reports no provider-measured bill (`billed: false`). Before, the field was missing. Nothing behaves differently.
- **Stats.** `vector stats` uses main's labels and main's counting of title and memory receipts. Codium requests are counted as Codium, never as unpriced/incomplete requests, tokens or dollars. That includes history from desktop 1.99.112, which recorded Codium steps and Codium titles as ordinary unpriced steps. For data without Codium every number matches main, including compaction summaries, which name no model. In a session that shows Codium, a compaction summary without a Codium flag is counted as neither own nor Codium.
- **Stopped launch notes.** Main's rule is unchanged: a note from a stopped launch does not restart work. It now sits in the one place `self-evolving` delivers helper notes from (TaskNotify), because the code main changed no longer exists in the task tool.
- **Context display.** The sidebar keeps "N% of context used", the Codium wording. Main's test now checks that text. The app's ledger shows main's "cumulative chat usage" note when the engine has recorded this chat's own totals. Otherwise it says the bar is the latest turn's mix. Main's app test now gives its sample session the "own totals recorded" flags that the merged engine sets. It checks the same numbers.
- **Helper forks.** A step's forks now settle inside main's cancel-proof step recording, so a cancel cannot settle them as aborted.
- **Tests adjusted to the other side's rules, none weakened.** Main's brain migration test also expects the research claims migration, which main's own CI misses today (run 42130320793). A Codium compaction test now counts the earlier no-usage turn as one unpriced step, under main's rule that missing usage is not zero. Main's nested-activity CLI test shortens the helper note window to fit its 1-second idle limit. That test still fails without main's fix.

## Recommendation

Merge `self-evolving` into main now, through pull request #20, and leave Codium's pages as they are. The pull request is open and mergeable, with main `4299d743` as its base. Main is already part of `self-evolving`, so the merge adds no change of its own: the merged files are exactly the branch tip's. On `f062bcce` that is 1,071 changed files, with 217,518 lines added and 15,209 removed. The pull request page also counts the later edits to this plan, so its count of lines added differs a little. The result is `self-evolving` with main's tokenomics, research and restored model catalog inside it. Nothing goes on sale: Stripe is not connected, Codium sales are off, and no model route has been accepted, so every plan button on the pricing page says "Coming soon". The website still changes the moment main moves. It gets a new four-plan pricing page, a new account card, new docs pages marked "Coming in desktop 1.99.113", and new sign-in checks that today's desktop and CLI use. Desktop and CLI users get nothing new until you publish 1.99.113.

Every check has now run on `f062bcce`. Four jobs failed on the first attempt and passed when re-run unchanged: a Windows unit job, two Windows engine shards and the 30-minute packet capture. Their causes are being found (see "CI evidence"). Until then, a later run can fail the same way.

What is left for you before you press merge: check that the newest run of the pull request's checks is green (every later push re-runs them), look at the preview, decide whether to allow the timeline benchmark, which has never run, and check Vercel's cron limit and `CRON_SECRET` (Owner checks 1–4). The pull request's checklist also lists the two owner questions. Both keep the safe default until you answer. Then merge with "Create a merge commit".

After this merge, merge VectorScope, then Codium once track A finishes, then @vector and Hands. Each of those branches then fixes some conflicts on its own side: VectorScope 10 files, Codium 7, @vector 2, and Hands the most, about 68.

## Conflicts

### This merge

Against main as it was when this plan was first written (`1d853606`), there were none. Main then moved on 5 November, and the 33 files that conflicted were resolved by the merge of main into `self-evolving` (see "Main moved on 5 November 2026" above). The earlier in-memory merge had finished with no conflicts, and Git merged one file on its own, `packages/web/test/model-plan-catalog.test.ts`.

At that time, main and `self-evolving` both changed 37 of the same files. Here is how each side is kept:

- **Main's side is kept for 4 files.** These are main's Codium catalog restoration: `packages/web/public/models/api.json` (the model list vectordev.ai serves), `docs/vector/owner-actions/model-catalog.md`, `docs/vector/build/catalog-112.provenance.json`, and the catalog test, which main un-skipped. `self-evolving` never touched these files after the shared starting point, so git takes main's copy.
- **`self-evolving`'s side is kept for 12 files.** `self-evolving` already holds main's version of each one and builds on it. The files are `.github/workflows/test.yml` (twelve Windows shards and the website test step), `prompt-input/submit.ts` and its test, `core/src/task-size.ts` and its test, `engine/src/provider/error.ts`, `engine/src/provider/provider.ts`, `engine/test/session/prompt.test.ts`, `script/agent-eval/footprint.ts`, `test/investor-page.test.ts`, `docs/vector/build/tokenomics-follow-up.md` and `docs/vector/owner-actions/first-request-cache-check.md`.
- **The other 21 files are already identical on both sides.**

On `f062bcce`, the pull request changes 1,071 files in main: 217,518 lines added and 15,209 removed. Main is already part of `self-evolving`, so the merged result is the branch tip's files. Apart from documents changed since, such as this plan, they are exactly `f062bcce`'s, the commit every check ran on.

### The other branches, after this merge lands

These are the files each branch would have to fix when it later merges main. I worked them out on 8 November with in-memory merges and changed no branch. Main is already part of `self-evolving`, so "after self-evolving lands" means merging with `self-evolving` as it is today.

| Branch | Conflicts with main today | Conflicts after self-evolving lands | Files after self-evolving lands |
| --- | --- | --- | --- |
| `codium` (track A, built to A50; A51 onward not started) | 16 | 7 | `settings-v2/general.tsx`, `settings-v2/memory-model.ts`, `settings-v2/settings-memory.css`, `settings-v2/settings-registry.ts`, `context/settings.tsx`, the engine's memory handler `httpapi/handlers/memory.ts`, `engine/src/tool/task.ts` |
| `vectorscope` (Phases 0–1, and the first window of its upgrade, VS-21a to VS-49a) | 0 | 10 | `pull-requests/ai-review.ts` and its test, `core/src/review/types.ts`, `core/test/brain/migration-knowledge.test.ts`, `cli/cmd/review.render.ts`, `engine/src/review/run.ts`, the CLI help snapshot, `egress-inventory.test.ts`, `upstream-free.test.ts`, `local-run.test.ts` |
| `vector-at-mention` (@vector; built to V17, last code commit 1 November, progress notes 8 November) | 0 | 2 | `engine/src/index.ts`, `engine/src/cli/vector-account.ts` |
| `hands` (Codex; last commit 6 November) | 25 | 68 | Mostly the engine's session, prompt, permission and shell code and its server handlers, the app's composer, prompt input and background tasks pane, `bun.lock`, the generated SDK and `openapi.json`, `test.yml`, `local-run.test.ts` and the release copy |

Codium's 16 conflicts with main today are `test.yml` and 15 files that main changed after `1d853606`: compaction, spend, stats, memory and title code with three of their tests, and the context, prompt and helper displays in the app and the terminal.

Codium's 7 conflicts and VectorScope's 10 exist no matter which branch goes first. Someone has to join those files once.

## What goes live the moment main moves

A push to main deploys the website and the API to vectordev.ai through Vercel. Vercel has already built a preview of `f062bcce`, the last code commit, without errors (deployment `27EEvRhGjE5DktpQJXa6J2TKTk6m`, ready on 6 November at 03:58 UTC). The link is on the pull request's Vercel status. Vercel builds a new preview for each later commit.

### Website and docs

- **Docs.** The subagents, parallel agents, permissions, Brain, checkpoints, desktop app, terminal agent, local, models, SDK, skills and tokenomics pages change. There is a new Workflows page under Agents. Every new paragraph starts with "Coming in desktop 1.99.113:". Once you mark 1.99.113 published, that becomes "From desktop 1.99.113:".
- **Public schemas.** `vectordev.ai/config.json` and `tui.json` gain new settings and lose none. `workflow.json` is new. Editors that read these schemas only learn new keys.
- **Not changed.** The download page and the published version stay at 1.99.112, and the changelog gets no entry. The investors page stays as it is. `vectordev.ai/models` keeps main's restored catalog.

### Codium A00–A28 (merged into self-evolving on 2 November)

- **Pricing page (`/codium`).** Today's page lists models and "plans and top-ups". The new page shows four monthly plans: Plus $10, Pro $50, Max $100 and Ultra $200. It has no top-ups. Every buy button says "Coming soon", because sales are off. Where today's page lists models, the new page says "Model access is not available yet", because no model route has been accepted yet (`ROUTE_ACCEPTANCES` is empty). Vector Velocity shows as "Coming" on Max and Ultra, with the 550B+ wording you approved, no date, and "not part of today's purchase". Perks such as cloud-agent hours show only once each service is ready and switched on. Today none is.
- **Account page (`/account`).** A new plan card shows plan state, usage meters, the renewal date, and upgrade, downgrade, Keep my plan and payment recovery controls. The controls work only for subscribers, and there are none yet. Purchased credit and top-up rows are gone.
- **CLI token page.** It now carries the CLI sign-in purpose (Codium A19).
- **Owner page (`/owner/codium`).** This is a new owner dashboard. Search engines are told not to index it, and it needs your owner sign-in.
- **Legal drafts.** None. The A30 legal drafts and legal page guard are only on `codium` and are not in this merge.

### API

- **Sign-in.** Every signed-in request now also checks whether that particular token was revoked (Codium A16). That covers free model chat, public shares, teams and the account pages. The desktop and CLI sign-in exchange changed too (A19). This affects 1.99.111 and 1.99.112 users at once. Tests cover the old clients, but no real old client has been tried against it.
- **Codium endpoints.** The status, config, change, estimate, funding, webhook and top-up endpoints are rewritten. There are new owner endpoints and a signed Vercel spend callback.
- **Four new scheduled jobs.** `outbox` runs every minute, `replay` every 10 minutes, the risk sweep every hour and the full sweep every day. With no Stripe key, each one answers "enabled: false" and touches nothing.

### What depends on your open decisions, or advertises things not yet sold

- **The Vector Labs row.** It is not on the pricing page, and tests keep it off. You once asked for Labs to be listed as "Coming". This merge advertises less than that, so it is safe to decide later.
- **The investors claim "67–75% less modelled spend than Claude Code".** It is already live on main today. This merge neither adds it nor removes it. That decision stays open.
- **Stripe is still off.** The pricing page shows four plans with prices that nobody can buy yet. That is honest ("Coming soon"), but it is a public price list before launch.
- **Velocity "Coming".** It is advertised on Max and Ultra under the approved wording.
- **1.99.113 features in the docs.** The docs describe them as "Coming" before that release exists. If 1.99.113 slips or changes, the docs promise too much until someone edits them.
- **The privacy policy.** The Brain and models docs describe the optional skill drafter, which, set to Always, sends one run's commands, file names and a short redacted error excerpt to the model provider. The privacy policy does not yet describe this. The release notes list a legal review for it.

## Desktop and CLI

Merging does not ship the desktop or the CLI. A desktop release starts only from a release tag or when you start it by hand. The CLI parts come with the next CLI release.

### What 1.99.113 users would get from the multi-agent build

- On ordinary and Thorough requests, the agent hands independent parts and broad searches to helpers. They work in the background, and the agent keeps working.
- Limits. At most 8 helpers run at once, one request starts at most 32, and they share a $25 spend ceiling. Guests get 4, 8 and $5. You can change these in Settings → Agents → Limits.
- Stop still stops only the main turn. "Stop including helpers" also stops the helpers, keeps their work, and closes their terminals. "Move to background" frees a turn that a helper is holding.
- After an update, restart or crash, nothing starts again by itself. The conversation lists the interrupted helpers, and "Resume all" continues them.
- A helper that is waiting on your permission says so.
- Forks share the conversation's prompt cache. A brief can pick a cheaper model or lower effort, and can ask for checked JSON.
- File safety. Every edit takes a per-file lock, and a file must be read before it is changed. Helpers cannot overwrite each other's files. A helper can work in its own git worktree, which you review, merge or discard.
- Workflows run many agents in stages from a plan you approve.
- Long commands can run in the background and report when they finish.
- A message you send while Vector works steers the turn. Queue is in Settings → General.
- The same release also carries the earlier self-evolving work: learned skills, workflow insights and the prompt guard.

### What is behind flags or capability checks

- The app asks the engine what it supports, using 10 flags, and hides any feature the engine lacks. So a new desktop talking to an older engine, such as a WSL server on an older CLI, does not show these features.
- Background helpers are on by default. The `VECTOR_DISABLE_BACKGROUND_SUBAGENTS` setting turns them off.
- Workflows are on unless the task or workflow tool is turned off. By default every workflow asks before it runs.
- Language servers and MCP servers are off in worktrees.
- These parts have no flag at all:
  - the read-before-edit rule and the per-file lock;
  - `apply_patch` no longer overwrites existing files;
  - every conversation writes the provider's prompt cache again once after the upgrade;
  - about 3,000 extra tool tokens on each work request, which providers without a prompt cache bill every time.

### Production benchmark evidence for the session and timeline changes

It is missing. `packages/app/AGENTS.md` asks for a production benchmark before and after any change to session or timeline code. This build changed 17 such files, adding about 1,070 lines: the session page, the composer and its docks, and the timeline's message and workflow parts. The build contract left the run to you, "only when he allows it". No run of the manual "production app benchmark" job exists for `self-evolving`; every CI run skipped it. The `vector-title-2026-10` benchmark belongs to main's early-title fix, not to this build. The savings from cache sharing in forks were shown only against a fake provider. The release notes also say the footprint numbers in `docs/benchmarks` are out of date.

## Order with the other builds

**Recommended: merge `self-evolving` first, with Codium's public pages left as they are.**

1. **`self-evolving` now**, through pull request #20, once the checks on its newest commit pass and you approve.
2. **`vectorscope` next.** Phases 0 and 1 are done, apart from VS-05, which waits for @vector. Since 6 November it has also built the first window of its upgrade: 26 slices from VS-21a to VS-49a. They are mostly new modules and eval tools. The review runner gains only hooks that stay off unless an eval sets them. VS-08 to VS-12, and wiring the upgrade into real reviews, wait for this merge. It has 10 conflicts to fix on its own branch. It also carries the `bun.lock` desktop version fix.
3. **`codium` when track A finishes.** A00–A50 are built; A51 onward has not started. It brings the legal drafts, founding members, roadmap vote, Remote, Vault and Playbooks, and each of those needs your own go-ahead. It also brings the Ops tools (A46–A50: On Call, Release Guard and Ship Desk). Codium's own plan lists them on the site only once the GitHub App is registered and the ops Worker is deployed. It has 7 conflicts after this merge, against 16 with main today. It deserves its own merge plan.
4. **`vector-at-mention` (@vector)** when its build finishes. V16 and V17 are done; V18 onward has not started. It has 2 conflicts after this merge (none with main today), and VectorScope's VS-05 waits for it.
5. **`hands`** when Codex finishes. It has 68 conflicts after this merge, against 25 today. Codex should merge main into `hands` soon after this lands, so that it fixes the conflicts once rather than twice.

Why this order:

- `self-evolving` is finished and reviewed, and every check has passed on it, four only on a re-run. Every week it waits makes the merge bigger.
- VectorScope cannot start VS-08 to VS-12, or wire its upgrade into reviews, until this is on main.
- Codium's 7 conflicts are the same whichever goes first.
- **Holding Codium's pages back** would mean new code on a reviewed branch whose checks have passed. A00–A28 is woven through the API, core, engine and desktop (A16 and A19 above all). Pulling out only the pages would need its own review and CI. It would also protect very little, because nothing is for sale.
- **Waiting for Codium to finish** delays multi-agent and VectorScope by days. It also makes the eventual merge carry more public pages and legal text, which means more for you to decide at once.

If you don't want the new pricing page live yet, there is another way. Keep main's current `/codium` page in a small commit on `self-evolving` before merging. That needs one more review and CI run, and the current page also sells nothing.

## CI evidence for `f062bcce`, the last code commit

These are the pull request's runs for `f062bcce`. GitHub runs them on the pull request merged with main, which has the same files as `f062bcce`.

- **test, [run 42159471110](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471110).** The first attempt failed 3 of the 21 jobs that ran (3 more are manual jobs and were skipped):
  - unit (windows), [job 127701423000](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471110/job/127701423000): one test, "util.effect-flock > enforces mutual exclusion under process contention". It failed after 14,085 ms; its own limit is 60 seconds.
  - engine (windows, shard 12/12), [job 127701423208](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471110/job/127701423208): one test, "the Local API > a new identity pin for a server on the list, or none, needs confirm; Add server says what changed".
  - engine (windows, shard 1/12), [job 127701423223](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471110/job/127701423223): four tests ran out of time. They are two task-sizing tests, "isolated task merge and discard > an agent merges and discards only its direct children, after approving the diff", and the session prompt test "finalizes assistant when cancelled before processor creation completes". Bun also reported one error between tests, from a git command that failed; its cause is part of the diagnosis.

  The second attempt re-ran those 3 jobs unchanged, and all passed: [127713924142](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471110/job/127713924142), [127713925314](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471110/job/127713925314) and [127713925306](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471110/job/127713925306). The other 18 jobs passed on the first attempt: the desktop engine bundle under Node, unit tests on Linux, end-to-end tests on Linux and Windows, engine Linux shards 1–4 and engine Windows shards 2–11.
- **Verify, [run 42159471068](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471068).** The first attempt's 30-minute packet capture, [job 127701422434](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471068/job/127701422434), failed. It found 4 DNS packets (UDP port 53) to the capture's own sink resolver, `198.18.0.53`. The packets were sent in the capture's first seconds (03:57:52 and 03:57:53 UTC). In the job's log, the line "sudo: unable to resolve host" and the failure report right after it are both at 04:28 UTC, 30 minutes after the packets. The second attempt's capture, [job 127713927586](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471068/job/127713927586), passed. The website build and the air gap check passed on the first attempt.
- **Each of these four first-attempt failures is being diagnosed.** This plan will say what caused each one once that is known.
- **typecheck, [run 42159471067](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471067).** All 4 jobs passed (app, cloud, desktop, engine).
- **Free models and public sharing.** Both API checks passed: [run 42159471115](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471115) and [run 42159471061](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471061).
- **37 check runs on the pull request.** 31 passed and 6 were skipped. Three are manual jobs in the test run: the offline request footprint, the published release engine evidence and the production app benchmark. Two are the production checks' schemas and legacy desktop access jobs ([run 42159685392](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159685392)), which run only after a production deployment. The sixth is CodeRabbit. The Vercel status also passed. The pull request's description counts that status with the 31, as "32 passed".
- **The production app benchmark has never run.** It was skipped here too ([job 127713925663](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42159471110/job/127713925663)).
- **No macOS runner.** CI has no macOS runner at all. On a Mac, the multi-agent build has been checked only by running single test files on the Mac the build was made on.
- **The previous head, `c879dffd`, was red.** Its test [run 42154724940](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42154724940) failed 6 of the 21 jobs that ran: engine Linux shards 1/4 and 2/4, and engine Windows shards 2/12, 3/12, 5/12 and 9/12. The failing tests were the egress inventory, the tool-parameter and CLI help snapshots, a workflow-learn spend test and three source-independence tests. `f062bcce` fixed each of them.
- **Main itself is red today.** Main's test [run 42130320793](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42130320793) on `4299d743` failed 8 of its 17 jobs, in 7 distinct tests. Two of the 17 are manual jobs, which were skipped. Each line names the commit on `self-evolving` that changes the test:
  - "Brain knowledge migration > a brain from the first migration upgrades in place and keeps what it held": unit Linux ([job 127604984888](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42130320793/job/127604984888)) and unit Windows ([job 127604984522](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42130320793/job/127604984522)). Changed in the merge, `b7ba4fa9`.
  - "tool parameters > JSON Schema (wire shape) > terminal": engine Linux 1/4 ([job 127604985254](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42130320793/job/127604985254)) and Windows 5/6 ([job 127604985083](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42130320793/job/127604985083)). Changed in `f062bcce`.
  - "Vector Local's connection inventory > every file that writes an address is a call site in the source registry or says why it needs none": engine Linux 3/4 ([job 127604984932](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42130320793/job/127604984932)) and Windows 3/6 ([job 127604985008](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42130320793/job/127604985008)). Changed in `f062bcce`.
  - "vector CLI help-text snapshots > every documented command emits stable help text": engine Linux 2/4 ([job 127604984923](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42130320793/job/127604984923)) and Windows 4/6 ([job 127604985158](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42130320793/job/127604985158)). Changed in `f062bcce`.
  - three "Vector's own git and the V2 runner under Vector Local" tests in `local-run.test.ts`: engine Linux 2/4 only ([job 127604984923](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42130320793/job/127604984923)). Changed in `c95a27a7`, which is not on main.

  Main has 6 Windows engine shards; `self-evolving` has 12. Main's typecheck and Verify are green on `4299d743`, and the production checks passed after its deployment on 5 November.

## Owner checks

### Before merging

The pull request's own checklist reads:

- [x] Resolve the 33 conflicts with main on `self-evolving`, keeping main's tokenomics and research behaviour.
- [x] Let the pull-request checks run: typecheck, Verify (desktop capture) and the PR-only API checks.
- [ ] Review the Vercel preview.
- [ ] Decide on the manual production app benchmark for the session and timeline changes (17 files). It has not been run.
- [ ] Owner decisions, both currently on the safe default:
  - Should subagents get the terminal tool?
  - Should settings be imported in shared folders that are not git repositories? This is refused for now.

In more detail:

1. **Done.** Pull request #20 is open from `self-evolving` into main, and every check has run on `f062bcce`: test, typecheck, Verify, and the free models and sharing checks. Four jobs passed only on their second attempt (see "CI evidence"). Each later push re-runs them; merge only when the newest run is green. Don't merge it yet.
2. Open the pull request's Vercel preview. Look at `/codium`, at `/account` (signed in), and at the docs pages `/docs/subagents`, `/docs/workflows`, `/docs/permissions` and `/docs/brain`. Decide whether you are happy for the four-plan page with "Coming soon" buttons to go public now.
3. Decide on the timeline benchmark. If you allow it, run test.yml's "production app benchmark (manual)" job on main (before) and on `self-evolving` (after), then compare. It runs on GitHub, not on your Mac.
4. In Vercel, check two things. First, that your plan allows a job that runs every minute; main already has one that runs every 10 minutes. Second, that `CRON_SECRET` is set.

### Right after merging

5. Watch the production deployment, and check that the "Vector production checks" run goes green.
6. On vectordev.ai, check four things. `/codium` loads and its buttons say "Coming soon". You can sign in on `/account`. `/models` still serves the restored catalog. `/docs/workflows` exists.
7. On an installed 1.99.112 desktop, sign in, chat with a free model and open a public share. From the terminal, run `vector login`. The sign-in checks changed under these clients.
8. In Vercel's logs, check that the four new scheduled jobs answer "enabled: false".

### Before you publish 1.99.113

9. Install the release candidate on a real Mac and a real Windows PC, from the beta channel. CI has no Mac runner, and the end-to-end specs drive the web build, not the desktop.
10. Go through both "Try it" lists in `docs/vector/owner-actions/release-199113.md`: the learned skills list and the multi-agent list. The multi-agent one includes the restart, Stop including helpers, worktree merge conflict, background `sleep 30; echo done` and workflow resume steps.
11. Sign off the privacy policy text for learned skills and the skill drafter.
12. Answer the two open questions below, or accept the behaviour that was kept.
13. Read "Decide what the build leaves open" in the release notes. Then confirm the choices that were made on your behalf: the task tool on ordinary work, steer by default, hard caps, no automatic resume after a restart, and declarative workflows.
14. Measure a real fork's cache reads on Anthropic before you rely on the cache savings.
15. The release preparation commit sets 1.99.113 and refreshes `bun.lock`. After publishing, mark 1.99.113 published so the docs say "From desktop 1.99.113:".

## Risks

- **The site changes at once for everyone.** That means new pricing and account pages, new docs, and changed sign-in checks for 1.99.111 and 1.99.112 users. Old clients are covered by tests only. Check 7 covers them for real.
- **The scheduled jobs start immediately.** They do nothing while Stripe has no key. If a Stripe key is ever added before you are ready, they start acting on Stripe data.
- **Four checks failed once on `f062bcce`.** A Windows unit job, two Windows engine shards and the packet capture each failed on the first attempt and passed when re-run unchanged. Their causes are being found. Passing on a re-run does not show the cause, so a later run can fail the same way.
- **Main is red today.** Its own test run on `4299d743` fails 7 tests in 8 of its 17 jobs. `self-evolving` changes each of those tests (see "CI evidence").
- **Session and timeline performance has not been measured.**
- **The Mac is checked only by hand.**
- **The other branches have conflicts to fix afterwards.** Hands has the most: 68 files, mostly in the engine and the composer. VectorScope has 10, Codium 7 and @vector 2.
- **Main's `bun.lock` still says the desktop is 1.99.111.** The merge keeps that. It is harmless, because install rewrites it, and the VectorScope merge or the release preparation fixes it. Don't fix it by hand in this merge.
- **Merging by squash or rebase would cause trouble.** `codium` shares the A00–A28 commits with `self-evolving`. A squash or rebase would break that link and turn Codium's and VectorScope's later merges into many more conflicts.

## Open items

- **Owner question: terminals for helpers.** In 1.99.112, every agent may open a terminal, helpers included, and a helper's program can outlive the helper. The contract says helpers should not run background commands. Main's behaviour is kept until you decide. The final review changed one thing: "Stop including helpers" now also closes the helpers' terminals.
- **Owner question: settings import in shared folders.** This is about a shared folder such as `/tmp` above a workspace that is not a git repository. There, a settings file that does not say it is Vector's can still stop Vector from starting. The safe choice, stopping, is kept until you decide.
- **Final review (history, on `98c6423a`).** It raised 26 findings. 15 were confirmed and fixed in `98c6423a`, and 11 were rejected after a second check. CI run 41982324473 was green on `98c6423a`, before main was merged in.
- **The four first-attempt failures on `f062bcce`.** Each is being diagnosed. This plan will name each cause once it is found.
- **The pull request's description.** It still says `self-evolving` is at `f062bcce` and that the first-attempt failures were runner timing and DNS. Neither cause has been shown yet. It also says the 6 skipped checks were skipped by path filters or manual inputs; two of them skip because a preview is not a production deployment. Whether to edit the description is up to you.
- **Not covered by automated tests:**
  - a real Ctrl+C on `vector run`, which is tested only with a fake signal;
  - the desktop's "Open output" button;
  - a page reload while queued messages are being sent.
- **Known limits, listed in the release notes:**
  - the desktop queue sends only while a Vector window is open;
  - spotting files a shell command writes is best effort;
  - there is no ceiling across the whole computer, only one per conversation;
  - before going back to an older Vector, merge or discard every kept worktree;
  - Settings → Agents counts background commands only in the 20 most recent conversations;
  - saving settings stops running background commands.
- **A failure that happens only on a Mac.** `isolation-terminal.test.ts` has one existing case that fails on a Mac because of the `/var` and `/private/var` paths. Linux CI covers that case. This build did not cause it.
- **A leftover in the sync checkout (5 November, on the earlier build Mac; not checked since).** The push checkout, `~/.cache/vector-sync-evolve`, has one uncommitted line in `bun.lock` from an install: the desktop version. It was left alone.

## How to merge, and how to undo

- **Merge.** Use the pull request's "Create a merge commit" button. Don't squash or rebase it (see Risks).
- **Undo the website.** Vercel can switch production back to the previous deployment within a minute.
- **Undo the code.** Revert the merge commit on main. Merging again later then needs that revert undone first, so prefer the Vercel switch for a website problem and fix forward on `self-evolving`.
