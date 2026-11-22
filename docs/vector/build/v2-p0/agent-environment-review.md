# agent-environment-review: P1-3 AE-REVIEW

Branch `agent-environment-review`, cut from origin/main `edbc4a8c3`. It covers one Vector v2 leftover item, P1-3
AE-REVIEW: a three-angle review of the agent's terminal and browser tools, the repairs it found outside #73's files,
and the status doc `docs/vector/build/agent-environment-status.md`, which holds every finding with file:line,
severity and a fix proposal. This note is the dated record of the repairs.

Files changed:

- Engine: `packages/engine/src/tool/browser.ts`, `packages/engine/src/tool/terminal.ts`,
  `packages/engine/test/tool/browser.test.ts`, new `packages/engine/test/tool/terminal-agent-review.test.ts`.
- Desktop: `packages/desktop/src/main/browser-agent.ts`, `packages/desktop/src/main/browser-bridge.ts`, new
  `packages/desktop/src/main/browser-bridge-agent-review.test.ts`, and `packages/desktop/src/main/browser-agent-tabs.test.ts`.
  The tabs test joined under the branch rule for other desktop `browser-agent-*` files: no other wave-B branch and no
  open PR names it (checked against every open head on 2026-11-21). The new bridge test sits beside the listed
  `browser-bridge.test.ts`, which keeps no module mocks, so the bridge's own handling is tested in a file of its own.
- Docs: `docs/vector/build/agent-environment-status.md` (new) and this note.

Not touched: `packages/engine/src/tool/registry.ts` and `registry.test.ts` (#73), `packages/engine/test/tool/terminal.test.ts`
(connect-permission-rulings), app files, `terminal.txt`, `browser.txt`. Overlap check against every open PR head and
the queued branches (workspace-clone-depth, codium-run-headroom, install-ps1-cmdlets): no shared file.

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
  keeping the `GUESTED` export the test imports. That is the tool as `14acaf2c6^` left it. Expected: `read` sends
  `inspectDom`, `readPage`, so `sent` is not `[]`. Builder: record.
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
  `9f5a70f25^`. Expected: the tabs case fails (`report.ok` is true and the page moved to `/next`), and the bridge cases
  fail (`callerGone` is not exported). Builder: record.
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
  keeping the `NOT_WEB` export the test imports. That is the tool as `c8e629ed0^` left it. Expected:
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

- Red run: revert `packages/engine/src/tool/terminal.ts` to `86bb9881d^`. Expected: the user's terminal is revealed
  with `focus: true`, and the output has no focus sentence. Builder: record.
- Mutation: replace `params.focus === true && own(info, ctx)` with `params.focus === true` at `terminal.ts:673`.
  Expected: the case fails. Builder: record the result and the sha256 after the restore.

## Recorded, not built

All are in the status doc, with file:line and a proposal.

- D1, after #73: `tool.terminal` has no flag or per-agent gate (`registry.ts:408`).
- D2, owner item **OWN-RELEASE-ACCEPT**: whether helpers keep `terminal` and `terminal_input`. Recommendation: deny
  terminals to helpers by default. Not decided in code. A "deny" ruling lands in registry.ts or the agent defaults,
  after #73.
- F1, app, later branch: no app-wide indicator for a running agent terminal while the terminal panel is closed.
- P2, core `pty.ts`, later branch: after an engine crash, a terminal program that ignores the hangup survives, and
  Windows has no job object for terminal programs.
- P3 and S6: stopping a running browser command midway, after guarded typing tells a failed focus check from a failed
  send.
- S4: `read_html` sends hidden input values. Proposal only.
- S5: name signal and rename in the `terminal` permission's text (app i18n and the schema comment).
- `terminal.txt`: one line on the new focus limit, for whichever branch next edits it.

No tripwire flipped, no test skipped or loosened, no deadline changed, no generated file touched, no flag turned on.

## Done

The item's own Done is a full green `test.yml` run on this branch's PR, on CI. The Bun-holding builder runs it.

## Lane pointers to fold back

None: the copied spec asks for no lane pointer.
