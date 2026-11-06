# Merging self-evolving into main: the plan

Written 5 November 2026 for your approval. Nothing has been merged into main and nothing has been pushed to main.

- `self-evolving` is at `98c6423a` ("fix(multiagent): final review"). GitHub has the same commit.
- `main` is at `1d853606` ("docs(catalog): record the Codium catalog merge and the release pin it needs").
- `self-evolving` is 155 commits ahead of main. Main has 5 commits that `self-evolving` lacks: the Codium model catalog restoration and the approved fixes from pull request #19.

## Main moved on 5 November 2026

After this plan was written, main took 243 more commits (`4299d743`):

- the tokenomics agent's consolidation: spend accounting, run budgets, guard spend, prompt cache boundaries, usage uncertainty, title limits, task-wait cancellation, stats and benchmark evidence;
- research pull request #16: local OCR, scoped claims, document exports, and the combined research and revocation migrations.

Merging main into `self-evolving` then had 33 conflicting files. Main was merged into `self-evolving` in the commit "Merge main into self-evolving", and every conflict was resolved. Main's tokenomics and research code is kept as main has it, and the multi-agent and Codium behaviour is added around it. Where this plan says the merge is clean or has no conflicts, it describes main before 5 November. Nothing was pushed, and main was not changed.

The brain migrations run in date order: facets, revocation (main), learned skills and workflow (`self-evolving`), research claims (main). None was renumbered, and none had shipped in a release, so every existing brain.db upgrades.

Judgement calls, in plain words:

- **Subagent spend ceiling message.** When helpers stop at the shared spend ceiling because of steps it cannot price, the message now says "unpriced or incomplete steps". Main now also counts steps with incomplete usage there.
- **Standard request note.** It keeps main's "not routine tool calls". It drops the older "do the work yourself" and "Subagents are not offered", because Standard requests may now hand work to helpers. The task-size test expects the new wording.
- **Failed compaction.** As on main, a compaction call that was attempted always records its cost fields, even when it failed. On Codium that is cost 0, marked Codium.
- **Codium title and memory requests.** Main now charges title and memory requests to the run. A Codium one counts as a Codium step, not as an unpriced one, so it can no longer trip main's unpriced-step stop. This was added in main's title-usage code and in the prompt's helper cost check. Every other model is charged exactly as on main.
- **Codium usage.** A Codium step reports no provider-measured bill (`billed: false`). Before, the field was missing. Nothing behaves differently.
- **Stats.** `vector stats` uses main's labels and main's counting of title and memory receipts. Codium requests are counted as Codium, never as unpriced/incomplete requests, tokens or dollars. For data without Codium every number matches main.
- **Stopped launch notes.** Main's rule is unchanged: a note from a stopped launch does not restart work. It now sits in the one place `self-evolving` delivers helper notes from (TaskNotify), because the code main changed no longer exists in the task tool.
- **Context display.** The sidebar keeps "N% of context used", the Codium wording. Main's test now checks that text. The app's ledger shows main's "cumulative chat usage" note when the engine has recorded this chat's own totals. Otherwise it says the bar is the latest turn's mix. Main's app test now gives its sample session the "own totals recorded" flags that the merged engine sets. It checks the same numbers.
- **Helper forks.** A step's forks now settle inside main's cancel-proof step recording, so a cancel cannot settle them as aborted.
- **Tests adjusted to the other side's rules, none weakened.** Main's brain migration test also expects the research claims migration, which main's own CI misses today (run 42130320793). A Codium compaction test now counts the earlier no-usage turn as one unpriced step, under main's rule that missing usage is not zero. Main's nested-activity CLI test shortens the helper note window to fit its 1-second idle limit. That test still fails without main's fix.

## Recommendation

Merge `self-evolving` into main now. Do it through a pull request, and leave Codium's pages as they are. Git merges the two cleanly, with no conflicts. The result is `self-evolving` plus main's restored model catalog. Nothing goes on sale: Stripe is not connected, Codium sales are off, and no model route has been accepted, so every plan button on the pricing page says "Coming soon". The website still changes the moment main moves. It gets a new four-plan pricing page, a new account card, new docs pages marked "Coming in desktop 1.99.113", and new sign-in checks that today's desktop and CLI use. Desktop and CLI users get nothing new until you publish 1.99.113. Before you press merge, do three things. Let the pull request run the checks that have never run on this branch: typecheck, the 30-minute Verify capture and the API checks. Look at its preview. And decide whether to allow the timeline benchmark the repository asks for, which has not been run. After this merge, merge VectorScope, then Codium once track A finishes, then @vector and Hands. Each of those branches then fixes a few conflicts on its own side; Hands has the most, about 67 files.

## Conflicts

### This merge

Against main as it was when this plan was written, there were none. Main then moved on 5 November, and the 33 files that conflicted were resolved by the merge of main into `self-evolving` (see "Main moved on 5 November 2026" above). The earlier in-memory merge had finished with no conflicts, and Git merged one file on its own, `packages/web/test/model-plan-catalog.test.ts`.

Main and `self-evolving` both changed 37 of the same files. Here is how each side is kept:

- **Main's side is kept for 4 files.** These are main's Codium catalog restoration: `packages/web/public/models/api.json` (the model list vectordev.ai serves), `docs/vector/owner-actions/model-catalog.md`, `docs/vector/build/catalog-112.provenance.json`, and the catalog test, which main un-skipped. `self-evolving` never touched these files after the shared starting point, so git takes main's copy.
- **`self-evolving`'s side is kept for 12 files.** `self-evolving` already holds main's version of each one and builds on it. The files are `.github/workflows/test.yml` (twelve Windows shards and the website test step), `prompt-input/submit.ts` and its test, `core/src/task-size.ts` and its test, `engine/src/provider/error.ts`, `engine/src/provider/provider.ts`, `engine/test/session/prompt.test.ts`, `script/agent-eval/footprint.ts`, `test/investor-page.test.ts`, `docs/vector/build/tokenomics-follow-up.md` and `docs/vector/owner-actions/first-request-cache-check.md`.
- **The other 21 files are already identical on both sides.**

In total, main would change in 1,067 files. The merged result differs from the tested `self-evolving` tip in only those 4 catalog files.

### The other branches, after this merge lands

These are the files each branch would have to fix when it later merges main. I worked them out with in-memory merges and changed no branch.

| Branch | Conflicts with main today | Conflicts after self-evolving lands | Files |
| --- | --- | --- | --- |
| `codium` (track A, A29–A43 so far) | 1 (`test.yml`) | 3 | `settings-v2/general.tsx`, `context/settings.tsx`, `engine/src/tool/task.ts` |
| `vectorscope` (Phases 0–1) | 0 | 3 | `pull-requests/ai-review.ts` and its test, `engine/src/review/run.ts` |
| `vector-at-mention` (@vector, Codex) | 0 | 2 | `engine/src/index.ts`, `engine/src/cli/vector-account.ts` |
| `hands` (Codex) | 24 | 67 | Mostly the engine's session, prompt, permission and shell code, the app's composer, `bun.lock`, the generated SDK, and the release copy |

Codium's 3 conflicts and VectorScope's 3 exist no matter which branch goes first. Someone has to join those files once.

## What goes live the moment main moves

A push to main deploys the website and the API to vectordev.ai through Vercel. Vercel has already built a preview of `98c6423a` without errors (5 November, 06:45 UTC). The link is on that commit's GitHub deployment.

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

1. **`self-evolving` now**, through a pull request, once its checks pass and you approve.
2. **`vectorscope` next.** Phases 0–1 are done, and VS-08 to VS-12 are waiting for this merge. It has 3 conflicts to fix on its own branch. It also carries the `bun.lock` desktop version fix.
3. **`codium` when track A finishes** (A44–A58 are still being built). It brings the legal drafts, founding members, roadmap vote, Remote, Vault and Playbooks, and each of those needs your own go-ahead. It has 3 conflicts. It deserves its own merge plan.
4. **`vector-at-mention` (@vector)** when Codex finishes. It has 2 conflicts, and VectorScope's VS-05 waits for it.
5. **`hands`** when Codex finishes. It has 67 conflicts after this merge, against 24 today. Codex should merge main into `hands` soon after this lands, so that it fixes the conflicts once rather than twice.

Why this order:

- `self-evolving` is finished, reviewed and green. Every week it waits makes the merge bigger.
- VectorScope cannot go further until this is on main.
- Codium's 3 conflicts are the same whichever goes first.
- **Holding Codium's pages back** would mean new code on a reviewed, green branch. A00–A28 is woven through the API, core, engine and desktop (A16 and A19 above all). Pulling out only the pages would need its own review and CI. It would also protect very little, because nothing is for sale.
- **Waiting for Codium to finish** delays multi-agent and VectorScope by days. It also makes the eventual merge carry more public pages and legal text, which means more for you to decide at once.

If you don't want the new pricing page live yet, there is another way. Keep main's current `/codium` page in a small commit on `self-evolving` before merging. That needs one more review and CI run, and the current page also sells nothing.

## CI evidence seen for the current tip

- **Full test run on `98c6423a`.** [Run 41982324473](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41982324473) passed on its first attempt, with all 21 real jobs green: the desktop engine bundle under Node, unit tests on Linux and Windows, end-to-end tests on Linux and Windows, engine Linux shards 1–4 and engine Windows shards 1–12. Three manual jobs were skipped: the production app benchmark, the offline footprint and the published release evidence. The run before it, 41971876322 on `d624e760`, was also green.
- **Main's tip `1d853606`.** test, typecheck and Verify are green on it, and it was deployed to production on 4 November at 23:26 UTC.
- **Vercel preview.** It built `98c6423a` without errors.
- **What has never run on `self-evolving`:**
  - typecheck;
  - Verify, the 30-minute packet capture of the desktop;
  - the API checks that run only on pull requests: free models and sharing, both of which this merge triggers;
  - the production app benchmark.
- **What has not run on the merged result.** The merged result, with main's 4 catalog files, has not had a CI run of its own. A pull request runs all of the above on exactly that result.
- **No macOS runner.** CI has no macOS runner at all. On a Mac, the multi-agent build has been checked only by running single test files on this Mac.

## Owner checks

### Before merging

1. Open a pull request from `self-evolving` into main, but don't merge it yet. Wait until test, typecheck, Verify, and the free models and sharing checks all pass.
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
- **The merged result has not had its own full CI run.** Only 4 catalog files differ from the tested tip, and the pull request closes this gap.
- **Session and timeline performance has not been measured.**
- **The Mac is checked only by hand.**
- **The other branches have conflicts to fix afterwards.** Hands has the most: 67 files in the engine and the composer.
- **Main's `bun.lock` still says the desktop is 1.99.111.** The merge keeps that. It is harmless, because install rewrites it, and the VectorScope merge or the release preparation fixes it. Don't fix it by hand in this merge.
- **Merging by squash or rebase would cause trouble.** `codium` shares the A00–A28 commits with `self-evolving`. A squash or rebase would break that link and turn Codium's and VectorScope's later merges into many more conflicts.

## Open items

- **Owner question: terminals for helpers.** In 1.99.112, every agent may open a terminal, helpers included, and a helper's program can outlive the helper. The contract says helpers should not run background commands. Main's behaviour is kept until you decide. The final review changed one thing: "Stop including helpers" now also closes the helpers' terminals.
- **Owner question: settings import in shared folders.** This is about a shared folder such as `/tmp` above a workspace that is not a git repository. There, a settings file that does not say it is Vector's can still stop Vector from starting. The safe choice, stopping, is kept until you decide.
- **Final review.** It raised 26 findings. 15 were confirmed and fixed in `98c6423a`, and 11 were rejected after a second check. The fix is pushed, and CI 41982324473 is green on it.
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
- **A leftover in the sync checkout.** The push checkout, `~/.cache/vector-sync-evolve`, has one uncommitted line in `bun.lock` from an install: the desktop version. It was left alone.

## How to merge, and how to undo

- **Merge.** Use the pull request's "Create a merge commit" button. Don't squash or rebase it (see Risks).
- **Undo the website.** Vercel can switch production back to the previous deployment within a minute.
- **Undo the code.** Revert the merge commit on main. Merging again later then needs that revert undone first, so prefer the Vercel switch for a website problem and fix forward on `self-evolving`.
