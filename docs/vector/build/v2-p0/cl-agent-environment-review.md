# cl-agent-environment-review: P1-3 AE-REVIEW

Drafted on branch `agent-environment-review` from origin/main `edbc4a8c3` (2026-11-21) and assembled on branch
`cl-agent-environment-review` from origin/main `c89a69bd1` (2026-11-25; see the section of that date). It covers one
Vector v2 leftover item, P1-3 AE-REVIEW: a three-angle review of the agent's terminal and browser tools, the repairs it
found outside #73's files, and the status doc `docs/vector/build/agent-environment-status.md`, which holds every
finding with file:line, severity and a fix proposal. This note is the dated record of the repairs.

Files changed:

- Engine: `packages/engine/src/tool/browser.ts`, `packages/engine/src/tool/terminal.ts`,
  `packages/engine/test/tool/browser.test.ts`, new `packages/engine/test/tool/terminal-agent-review.test.ts`.
- Desktop: `packages/desktop/src/main/browser-agent.ts`, `packages/desktop/src/main/browser-bridge.ts`, new
  `packages/desktop/src/main/browser-bridge-agent-review.test.ts`, and `packages/desktop/src/main/browser-agent-tabs.test.ts`.
  The tabs test joined under the branch rule for other desktop `browser-agent-*` files: no other wave-B branch and no
  open PR names it (checked against every open head on 2026-11-21). The new bridge test sits beside the listed
  `browser-bridge.test.ts`, which keeps no module mocks, so the bridge's own handling is tested in a file of its own.
- Docs: `docs/vector/build/agent-environment-status.md` (new) and this note.

Not touched: `packages/engine/src/tool/registry.ts` and `registry.test.ts` (#73 then; a pinned review-pipeline file
since #73 merged), `packages/engine/test/tool/terminal.test.ts` (connect-permission-rulings then; out of this branch's
files), app files, `terminal.txt`, `browser.txt`. Overlap check against every open PR head and the queued branches
(workspace-clone-depth, codium-run-headroom, install-ps1-cmdlets): no shared file. Rechecked on 2026-11-25 (see that
section).

The drafter held no Bun turn, so no test was run here. Each section names the test, the source to revert for the red
run, and the mutation. The builder records the red run, the green run, the mutation result and the sha256 after the
restore under each.

## 2026-11-21: the browser in a session an invited guest acted in (S1)

**Gap.** The desktop keeps one browser profile for Preview and every session (`persist:vector-browser`), and a handoff
asks the user to sign in there. In a session an invited guest has acted in, the browser tool still opened, read and
drove pages in it. Full access answers `browser_external` and `browser_interact` alone, so a guest's prompt could have
the agent read the user's signed-in pages into the transcript the guest sees. The terminal tool keeps the user's
terminals from such a session and the computer tool refuses it.

**Change.** `browser.ts` takes FreeModelGuests with `Effect.serviceOption`, as it takes Question and ResearchRun. The
registry builds the tools with it present, since the terminal tool requires it there. Tests that build the browser
alone leave it out, as before. In a marked session every action but `close` returns `GUESTED` before any ask or
desktop command. `close` still runs: it reads nothing and stops what is open.

**Lead ruling.** Refuse the whole browser in such a session, not only external pages. A page on this computer shares
the same profile and its cookies (cookies ignore the port), and the computer tool refuses such a session outright.
This is the safest choice that closes the gap.

**Test.** `packages/engine/test/tool/browser.test.ts`, "in a session an invited guest has acted in, the browser reads,
opens and drives nothing and asks nothing; close still closes it". Twelve actions, reads, opens (local included),
clicks, typing, a screenshot and a handoff, send nothing and ask nothing. `close` sends `closeBrowser`, and a session
no guest acted in reads as before.

- Red run: in `packages/engine/src/tool/browser.ts`, delete the guest check (`:589-590`, the `if` and its `return`),
  keeping the `GUESTED` export the test imports. That is the tool as `14acaf2c6^` left it (on this branch:
  `50cf48407^`). Expected: `read` sends `inspectDom`, `readPage`, so `sent` is not `[]`. Builder: record.
- Mutation: `guests.marked(ctx.sessionID)` to `guests.marked(ctx.parentID)` at `browser.ts:589` (undefined there, so
  never marked). Expected: the case fails. Builder: record the result and the sha256 after the restore.

## 2026-11-21: a queued browser command after the turn was stopped (P1)

**Gap.** The engine's bridge call carries the call's abort signal, so the user's Stop aborts it. The desktop never
learned this: a command queued behind another on the same page ran when its turn came, after the Stop.

**Change.** Desktop `browser-bridge.ts`: `callerGone(response)` aborts a signal once the response closes before it was
sent, and the bridge passes it to `runBrowserAgent` as a new optional third argument. `browser-agent.ts`: a queued
command whose signal is aborted when its turn comes is not run. It reports "Vector did not run <command>: its call
ended while it waited for the page." (`abandonedReport`). Commands that run at once (the panel's, the user's,
`closeBrowser`) and the IPC path, which passes no signal, are unchanged.

**Lead ruling.** Only a command that has not started is dropped. A running one finishes (status doc P3). Cutting a
typing run midway first needs the failed-check distinction in status doc S6, or the cut-off text would fall through to
the native setter fallback.

**Tests.**

- `packages/desktop/src/main/browser-agent-tabs.test.ts`, "a command still waiting for its page when its call ended
  never runs; the one running finishes". A `wait` holds the page and an `openUrl` waits behind it. Its call is aborted
  while it waits: it does not run (the page's history stays one entry) and reports why. The same `openUrl` with a
  live signal runs.
- `packages/desktop/src/main/browser-bridge-agent-review.test.ts`, "a call to the agent browser" > "whose response
  closed before it was sent has ended, so its command is given up" and "whose response was sent has not: a command
  that finished is no call that ended".
- Red run: revert `packages/desktop/src/main/browser-agent.ts` and `packages/desktop/src/main/browser-bridge.ts` to
  `9f5a70f25^` (on this branch: `2672d0f19^`, the same text as origin/main). Expected: the tabs case fails
  (`report.ok` is true and the page moved to `/next`), and the bridge cases fail (`callerGone` is not exported).
  Builder: record.
- Mutation: replace `gone?.aborted ?` with `false ?` at `browser-agent.ts:1661`. Expected: the tabs case fails.
  Builder: record the result and the sha256 after the restore.

## 2026-11-21: a non-web address asked under the origin null (S2)

**Gap.** The desktop opens only http and https, but the engine asked first. A `file:`, `data:` or `javascript:`
address, or one with no scheme (`localhost:3000`), has the origin `null`, so `browser_external` asked with the pattern
`null` and offered "always" for it: one approval would have covered every such address. An address that does not
parse (`example.com/login`) threw in `approve` and ended the call with an error.

**Change.** `browser.ts`: `webAddress` and a check after the research lead's own refusal. `open_url`, `open_tab` and
`handoff` with an address that is not full http or https return `NOT_WEB`, before any ask or command.

**Test.** `browser.test.ts`, "an address that is not http or https is refused before anything is asked or sent, not
asked under origin null". Five addresses send nothing and ask nothing, and a full https address still asks for its
origin and opens.

- Red run: in `packages/engine/src/tool/browser.ts`, delete the address check (`:594-599`, the `if` and its `return`),
  keeping the `NOT_WEB` export the test imports. That is the tool as `c8e629ed0^` left it (on this branch: `cb4696184^`,
  origin/main). Expected:
  `file:///etc/passwd` asks `browser_external` and sends `openUrl`, and `example.com/login` ends the call with an
  Invalid URL error. Builder: record.
- Mutation: drop `params.action === "open_tab" || ` from that check. Expected: the `data:` case (an `open_tab`) fails.
  Builder: record the result and the sha256 after the restore.

## 2026-11-21: a terminal reveal took the keyboard into another's terminal (S3)

**Gap.** `reveal` with `focus: true` asks nothing and published focus for any terminal: the user's own, or another
session's agent's. The app keeps the focus while a text field holds it (335be5b77). At any other moment one session's
agent could put the user's next keystrokes into a terminal another session's agent reads as its own.

**Change.** `terminal.ts`, `reveal`: focus only when the agent opened the terminal (`own`). Others are shown without
focus, and the result says the focus stayed. The agent's own terminals still take the keyboard, for the user to type a
password there. The existing terminal.test.ts reveal case uses the agent's own terminal, and its output is unchanged.

**Test.** `packages/engine/test/tool/terminal-agent-review.test.ts` (new; terminal.test.ts belongs to
connect-permission-rulings this wave), "tool.terminal reveal" > "moves the keyboard only into a terminal the agent
opened, never the user's or another session's". Stand-in terminals, so nothing is spawned and it runs on every
platform.

- Red run: revert `packages/engine/src/tool/terminal.ts` to `86bb9881d^` (on this branch: `c48b20e72^`, the same text
  as origin/main). Expected: the user's terminal is revealed
  with `focus: true`, and the output has no focus sentence. Builder: record.
- Mutation: replace `params.focus === true && own(info, ctx)` with `params.focus === true` at `terminal.ts:673`.
  Expected: the case fails. Builder: record the result and the sha256 after the restore.

## Recorded, not built

All are in the status doc, with file:line and a proposal.

- D1, follow-up (pinned `registry.ts`; "after #73" when drafted): `tool.terminal` has no flag or per-agent gate
  (`registry.ts:424` on origin/main `c89a69bd1`; `:408` when drafted).
- D2, owner item **OWN-RELEASE-ACCEPT**: whether helpers keep `terminal` and `terminal_input`. Recommendation: deny
  terminals to helpers by default. Not decided in code. A "deny" ruling lands in registry.ts or the agent defaults,
  as a follow-up of its own.
- F1, app, later branch: no app-wide indicator for a running agent terminal while the terminal panel is closed.
- P2, core `pty.ts`, later branch: after an engine crash, a terminal program that ignores the hangup survives, and
  Windows has no job object for terminal programs.
- P3 and S6: stopping a running browser command midway, after guarded typing tells a failed focus check from a failed
  send.
- S4: `read_html` sends hidden input values. Proposal only.
- S5: name signal and rename in the `terminal` permission's text (app i18n and the schema comment).
- `terminal.txt`: one line on the new focus limit, for whichever branch next edits it.

No tripwire flipped, no test skipped or loosened, no deadline changed, no generated file touched, no flag turned on.

## 2026-11-25: assembled on cl-agent-environment-review

**Base and recheck.** Worktree branch `cl-agent-environment-review`, cut with `--no-track` from origin/main
`c89a69bd1` (#152 the newest merge). `git log edbc4a8c3..origin/main` shows no change to any file this branch edits
(`tool/terminal.ts`, `tool/browser.ts`, engine `browser.test.ts`, desktop `browser-agent.ts`, `browser-bridge.ts`,
`browser-agent-tabs.test.ts`) nor to the files the repairs call or the status doc cites for them
(`free-model-guests.ts`, core `pty.ts`, `pty/process.ts`, `pty/hold.ts`, `process-isolation.ts`,
`session/unattended-shell.ts`, engine `tool/browser-bridge.ts`, `tool/computer.ts`, `permission-policy.ts`, the desktop
`browser-page.ts`, `browser-navigation-policy.ts`, `browser-credential-*.ts`, app `i18n/en.ts`). `registry.ts`,
`task/isolation.ts` and `task/manager.ts` moved on main: the status doc now cites main's `registry.ts:424`, `:442`
and `:689` and `task/isolation.ts:3424`; `task/manager.ts:1471-1487` still holds.

**Picks.** The five drafts, whole and in order, each applied with no conflict:

| Draft | On this branch | Subject |
| --- | --- | --- |
| `c8e629ed0` | `cb4696184` | fix(browser): refuse an address that is not http or https before anything is asked (S2) |
| `14acaf2c6` | `50cf48407` | fix(browser): keep the user's signed-in browser out of a session a guest acted in (S1) |
| `9f5a70f25` | `2672d0f19` | fix(desktop): a browser command whose call ended while it waited never runs (P1) |
| `86bb9881d` | `c48b20e72` | fix(terminal): a reveal moves the keyboard only into a terminal the agent opened (S3) |
| `441ba5d76` | `260aa66a6` | docs(agent-environment): the review's status, findings and dated repair record |

Then one assembly commit: `git mv` of the drafted entry `v2-p0/agent-environment-review.md` to this name, the status
doc's pointer to it, the moved `registry.ts` and `task/isolation.ts` line numbers, the "#73" wording (merged since;
`registry.ts` is pinned), and this section.

**Dropped.** Nothing. No draft hunk is covered by main or by a Codex PR: of the PRs since #76, open or merged, none
touches a terminal or browser tool file, a desktop `browser-*` file or the review docs (#105 and #146 touch app e2e
and app browser tests only).

**Overlap check.** 2026-11-25, before the first edit and again before the last commit: `gh pr list --state open`
(42 open: the held owner draft #68 and Codex's #98 to #171), then `gh pr diff --name-only` for each. No open PR names
a file of this branch. Neither `registry.ts` (pinned) nor `terminal.test.ts` is edited.

**Checked by reading (no Bun turn, so no typecheck).** Every import, type and signature the picks use, in its source:
`FreeModelGuests.Interface` (`mark`, `marked`) and `FreeModelGuests.Service.of`, as other engine tests build it;
`Effect.serviceOption` is read inside `Tool.define`'s init, so the test's `provideService` on `BrowserTool` reaches it,
and the registry provides the service (the terminal tool requires it there); `own(info, ctx)` in `terminal.ts`;
`Pty.Interface.reveal(id, { focus })`; `Layer.mock(Pty.Service, ...)` and `buildLocationServiceMap([[Pty.node, layer]])`
as `terminal.test.ts`'s synthetic terminals use them; desktop `queueTurn`, `stoppedReport` and the test's
`FakeContents.history`; the engine bridge's fetch carries the call's signal (`tool/browser-bridge.ts`). The desktop
runner (`scripts/test.ts`) runs each test file in its own process, so the bridge test's `mock.module` stays in its
file. No other engine test sends the browser tool an address that is not http or https (`browser-actions.test.ts`,
`local-mode/local-run.test.ts`), and the one `terminal.test.ts` reveal case reveals the agent's own terminal, so its
output is unchanged.

**Lead rulings (2026-11-25).**

- The picks are made without `-x`: each draft message ends with the Co-Authored-By trailer, and `-x` would add a
  line after it. The table above is the provenance.
- D1 and D2 stay recorded follow-ups, not built: a flag or per-agent gate on `tool.terminal` needs `registry.ts`, a
  pinned review-pipeline file (`REVIEW_PIPELINE_FILES`), and the helpers' terminal access is the owner's question.
- Whether helpers keep `terminal` and `terminal_input` stays the owner's call (OWN-RELEASE-ACCEPT), with the
  recommendation "deny terminals to helpers by default". Not decided in code.
- F1 (app agent-terminal indicator), P2 (core `pty.ts`), P3 with S6, S4 and S5 stay recorded in the status doc, not
  built.
- The 2026-11-21 rulings above stand: the whole browser is refused in a guested session (only `close` runs), and only
  a browser command that has not started is dropped when its call ends.

**Owner items.** OWN-RELEASE-ACCEPT: whether helpers keep the terminal tools.

**Runs (owed to the Bun-turn holder).** One file at a time.

- S2, non-web address. Red-before: in `packages/engine/src/tool/browser.ts` delete the address check (`:594-599`, the
  `if` and its `return`), keeping the `NOT_WEB` export, run `bun test --timeout 30000 test/tool/browser.test.ts`
  from `packages/engine`, expect "an address that is not http or https is refused before anything is asked or sent,
  not asked under origin null" red. (Restoring `browser.ts` whole from origin/main also removes the `GUESTED` and
  `NOT_WEB` exports, so the file fails to load: red, but not this case alone.) Green: the same on the branch.
  Mutation: drop `params.action === "open_tab" || ` from that check, expect the same case red (its `data:` address is
  an `open_tab`). sha256 of `browser.ts` after restore: owed.
- S1, guested session. Red-before: in `browser.ts` delete the guest check (`:589-590`), keeping the `GUESTED` export,
  run `bun test --timeout 30000 test/tool/browser.test.ts` from `packages/engine`, expect "in a session an invited
  guest has acted in, the browser reads, opens and drives nothing and asks nothing; close still closes it" red.
  Green: the same on the branch. Mutation: `guests.marked(ctx.sessionID)` to `guests.marked(ctx.parentID)` at
  `browser.ts:589`, expect the same case red. sha256 of `browser.ts` after restore: owed.
- P1, queued browser command. Red-before: restore `packages/desktop/src/main/browser-agent.ts` from origin/main, run
  `bun --no-env-file test --timeout 30000 ./src/main/browser-agent-tabs.test.ts` from `packages/desktop`, expect "a
  command still waiting for its page when its call ended never runs; the one running finishes" red; then restore
  `packages/desktop/src/main/browser-bridge.ts` from origin/main, run
  `bun --no-env-file test --timeout 30000 ./src/main/browser-bridge-agent-review.test.ts` from `packages/desktop`,
  expect "whose response closed before it was sent has ended, so its command is given up" red (`callerGone` is not
  exported). Green: both the same on the branch. Mutation: `gone?.aborted ?` to `false ?` at `browser-agent.ts:1661`,
  expect the tabs case red; and in `browser-bridge.ts` drop the `if (!response.writableFinished)` guard so every
  close aborts, expect "whose response was sent has not: a command that finished is no call that ended" red. sha256
  of `browser-agent.ts` and of `browser-bridge.ts` after each restore: owed.
- S3, terminal reveal. Red-before: restore `packages/engine/src/tool/terminal.ts` from origin/main, run
  `bun test --timeout 30000 test/tool/terminal-agent-review.test.ts` from `packages/engine`, expect "tool.terminal
  reveal" > "moves the keyboard only into a terminal the agent opened, never the user's or another session's" red.
  Green: the same on the branch. Mutation: `params.focus === true && own(info, ctx)` to `params.focus === true` at
  `terminal.ts:673`, expect the same case red. sha256 of `terminal.ts` after restore: owed.
- Also owed: engine typecheck (`tsgo --noEmit` in `packages/engine`) and desktop typecheck (`tsgo -b` in
  `packages/desktop`); `bun test --timeout 30000 test/no-personal-paths.test.ts` from the repository root (it scans
  both docs).

**Owed after the runs.** Merge origin/main into the branch if main moved (git merge, no rebase), push, open the PR
(not draft), and read its `test.yml` run. #77 split the Windows engine suite into 18 round-robin shards, and the new
engine test file reshuffles them: read the run shard by shard, and report a shard that crosses the 45-minute step
limit instead of lengthening it.

No tripwire flipped, no test skipped or loosened, no deadline changed, no generated file touched, no flag turned on.

## 2026-11-25: verified on cl-agent-environment-review

The runs owed above, made by the verifier in this branch's worktree, one Bun process at a time, after
`bun install --ignore-scripts`. Bun 1.3.14 on macOS.

**Merge and recheck.** `fdde5fbbe` merges origin/main `b57b8d53a` (#160 the newest merge) with no conflict; main
touched no file of this branch since `c89a69bd1`, and no `package.json` or lockfile. Open PRs rechecked live before
the first commit and again before the last: 38 open (the held owner draft #68 and Codex's #98 to #171), and
`gh pr diff --name-only` for each names no file of this branch. Of the merged PRs, none since #32 (agent-environment)
touches a terminal or browser tool file, so no Codex PR covers this item. Nothing dropped.

**Runs.** Each red run restored the source and was followed by `git checkout HEAD -- <file>`, a clean `git status`,
and the sha256 below.

| Repair | Red-before | Green | Mutation | sha256 after restore |
| --- | --- | --- | --- | --- |
| S2 non-web address | red (see below) | 27/27 | red | `browser.ts` `d1290e72fe0c2e9833041e2a542a7653886d3fbda5146394fa2f4a84dfe0af96` |
| S1 guested session | red (see below) | 27/27 | red | `browser.ts` as above |
| P1 agent tabs | red | 22/22 | red | `browser-agent.ts` `10c8ee4341f6f34b27024add0fe35519a822d7439957175f7b6f13a9588193cd` |
| P1 bridge | red | 3/3 | red (two) | `browser-bridge.ts` `5e8f45edb871e51af9847b5a8720ecc150de100c5fe14fbc7c4307c87f703835` |
| S3 terminal reveal | red | 1/1 | red (two) | `terminal.ts` `d8f6043a5d477f173f68335bd9efe6e039297ee224908e13c33d6e28baa7cd15` |

- S2 and S1, `test/tool/browser.test.ts` from `packages/engine`. Restoring `browser.ts` whole from origin/main fails
  the file at load (`Export named 'GUESTED' not found`). So the red run used origin/main's `browser.ts` with only the
  two exported messages appended: 25 pass, 2 fail, each for its own reason. The guest case: `read` sent
  `inspectDom` and `readPage` and answered with the page. The address case: `file:///etc/passwd` asked
  `browser_external`. Mutation S2: the drafted text `params.action === "open_tab" || ` matches two lines, the new check
  (`:595`) and the older ask (`:705`). Dropped at `:595` only: the address case alone is red (26 pass, 1 fail).
  Dropped at both, "tab actions go straight to the desktop and ask nothing, and open_tab asks as open_url does" is red
  too, so the mutation is the one at `:595`. Mutation S1: `guests.marked(ctx.sessionID)` to
  `guests.marked(ctx.parentID)` at `:589`: the guest case alone is red.
- P1 tabs, `./src/main/browser-agent-tabs.test.ts` from `packages/desktop` (`bun --no-env-file test --timeout 30000`).
  Red-before with origin/main's `browser-agent.ts`: "a command still waiting for its page when its call ended never
  runs; the one running finishes" is red at `report.ok` (true: the waiting `openUrl` ran). The first red run also
  showed the existing "the user's own Preview navigation follows a redirect to another site; the agent's does not"
  timed out, reported at 294 s against the 30 s limit. A machine stall, not this change: that case sends no signal, so
  both sources take the same path. A rerun of the same red source passed it (21 pass, 1 fail: the new case only), and
  every green run passes it. Mutation `gone?.aborted ?` to `false ?` at `browser-agent.ts:1661`: the new case alone is
  red.
- P1 bridge, `./src/main/browser-bridge-agent-review.test.ts`. The two drafted cases proved `callerGone` but not that
  the bridge hands its signal to `runBrowserAgent`: dropping that third argument at `browser-bridge.ts:68` left every
  test green. Fixed in `24b05a2cd` with a third case, "over the bridge, each agent command is handed the end of its
  call". It starts the desktop's own bridge on 127.0.0.1 (no outside host), sends one agent command with the address
  and the random token the bridge makes for itself, and checks that `runBrowserAgent` received a live `AbortSignal`.
  Red-before with origin/main's `browser-bridge.ts`: 0 pass, 3 fail. The two `callerGone` cases fail with "callerGone
  is not a function", and the new case because nothing was handed (`undefined`). Mutation A: drop `gone` from the
  `runBrowserAgent` call: the new case alone is red. Mutation B: drop the `if (!response.writableFinished)` guard: the
  "whose response was sent has not" case and the new case are red.
- S3, `test/tool/terminal-agent-review.test.ts` from `packages/engine`. Red-before with origin/main's `terminal.ts`:
  red at the user's terminal's output, which has no focus sentence. Mutation `params.focus === true && own(info, ctx)`
  to `params.focus === true` at `:673`: red at the same output. A second mutation keeps the sentence and passes the
  asked-for focus through, `pty.reveal(info.id, { focus: params.focus === true })` at `:674`. It is red at the
  `revealed` list: the user's and the other session's terminals were revealed with `focus: true`.

**Lead ruling (2026-11-25): what the bridge case can prove under Bun.** A probe in Bun 1.3.14 showed its `node:http`
server never emits a response's `close` when the client aborts mid-request (only after a sent answer). Node, which
Electron's main process runs, emits it on a connection terminated early, as `callerGone` expects. A second probe
showed Bun's `fetch` closes the connection at once when its signal aborts, which is how the engine calls the bridge.
So the abort itself stays proven on `callerGone` with Node's event contract. The over-the-wire case proves the
hand-over and that a sent answer does not abort. It does not attempt an abort Bun's server cannot report. No test
waits on it, and no timeout changed.

**Typecheck.** `bun typecheck` in `packages/engine` (`tsgo --noEmit`) and in `packages/desktop` (`tsgo -b`): clean.

**Existing tests of the changed modules, one file at a time, all green.**

- Engine: `test/tool/terminal.test.ts` 55/55, `test/tool/browser-actions.test.ts` 9/9,
  `test/tool/browser-cleanup.test.ts` 2/2, `test/tool/browser-format.test.ts` 11/11, `test/tool/parameters.test.ts`
  62/62, `test/question/expire.test.ts` 3/3, `test/local-mode/local-run.test.ts` 31/31.
- Desktop: `browser-bridge.test.ts` 14/14, `browser-agent-input.test.ts` 24/24, `browser-agent-permissions.test.ts`
  14/14, `research-browser.test.ts` 26/26.
- Root: `bun test --timeout 30000 ./test/no-personal-paths.test.ts` from the repository root 1/1, with both docs as
  committed here (the `./` matters: the root `bunfig.toml` points a bare name at an empty test root).

**CI only (corrected 2026-11-25 after review).** In `test.yml` the two engine files, `test/tool/browser.test.ts`
and `test/tool/terminal-agent-review.test.ts`, run in the engine shard jobs on both systems: eight shards on Linux
and #77's 18 round-robin shards on Windows, which the new engine file reshuffles. The two desktop files,
`src/main/browser-agent-tabs.test.ts` and `src/main/browser-bridge-agent-review.test.ts`, run in no pull-request
workflow. `test.yml`'s only desktop step, "Run desktop computer-use tests", runs a fixed list (the computer-use files,
`config-skew`, `ipc-security` and `keep-awake`), and its own comment says desktop tests otherwise run only in the
release workflow. These two files run there, in the release workflow's Linux "Test (desktop)" job, which starts only
on a tag or by hand. So the macOS runs recorded above are their only evidence before merge. A shard over the
45-minute step limit is reported, never answered with a longer limit.

**After the merge of origin/main c2396f1c0 (2026-11-25).** Main gained only #118 (Vector everywhere files), none of
this branch's files. Reruns, one file at a time: engine `test/tool/browser.test.ts` 27/27 and
`test/tool/terminal-agent-review.test.ts` 1/1; desktop `./src/main/browser-agent-tabs.test.ts` 22/22 and
`./src/main/browser-bridge-agent-review.test.ts` 3/3; root `./test/no-personal-paths.test.ts` 1/1. `bun typecheck`
in `packages/engine` and `packages/desktop`: clean. A live check of the 38 open PRs found none touching a file of this
branch, and no merged PR covers this item.

**Still owed.** Push, open the PR (not draft), and read its `test.yml` run shard by shard (it covers the engine
files only). Owner item unchanged: OWN-RELEASE-ACCEPT.

## Done

The item's own Done is a full green `test.yml` run on this branch's PR, on CI. The Bun-holding builder runs it.

## Lane pointers to fold back

None: the copied spec asks for no lane pointer.
