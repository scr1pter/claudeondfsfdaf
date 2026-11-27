# Agent environment: review status

The review item P1-3 AE-REVIEW asks for: the agent's terminal and browser tools, read from three angles (security
and permissions, process ownership, fit with the owner's four criteria in `v2-master-prompt.md` section 8.6). Read
on origin/main `edbc4a8c3`, 2026-11-21, and assembled on branch `cl-agent-environment-review` from origin/main
`c89a69bd1`, 2026-11-25. Line numbers are this branch's (rechecked 2026-11-25: the reviewed terminal, browser and
desktop files did not change on main in between; the `registry.ts` and `task/isolation.ts` numbers were moved to
main's). The dated record of the repairs, their tests and their red runs is `v2-p0/cl-agent-environment-review.md`.

The owner's criteria (section 8.6): a visible indicator and stop; permissioned use; separate from the user's own
terminals and browser profile; built on main's owned processes, isolated checkout terminals and browser panel.

Read in full: `packages/engine/src/tool/terminal.ts`, `browser.ts`, `browser-bridge.ts`; desktop `browser-agent.ts`,
`browser-bridge.ts`, `browser-navigation-policy.ts`, `browser-credential-field.ts`, `browser-credential-input.ts`; the
parts of `browser-page.ts` that read a page and type into it. Read for context: core `pty.ts`, `pty/process.ts`,
`pty/hold.ts`, `process-isolation.ts`, `free-model-guests.ts`; engine `session/unattended-shell.ts`,
`task/isolation.ts` (`closeSessionTerminals`), `task/manager.ts` (stopping helpers), `tool/registry.ts`; schema
`permission-policy.ts`; app `context/terminal.tsx` and the terminal tab.

Severity: **medium** is a gap a guest, a stopped turn or another session can use today; **low** needs an unusual
page or moment, or only misleads; **info** is a note with no defect.

## Summary

| ID | Angle | Finding | Severity | State |
| --- | --- | --- | --- | --- |
| S1 | Security | The browser read the user's signed-in pages in a session an invited guest acted in | medium | fixed on this branch |
| P1 | Ownership | A browser command queued behind another ran after the user stopped the turn | medium | fixed on this branch |
| S2 | Security | A non-web address was asked about under the origin `null`, offering "always" for all of them | low | fixed on this branch |
| S3 | Security | A terminal reveal moved the user's keyboard into the user's or another session's terminal | low | fixed on this branch |
| F1 | Fit | No app-wide sign of a running agent terminal while the terminal panel is closed | medium | app, later branch |
| D1 | Security | `tool.terminal` is offered to every agent with no flag or per-agent gate | info | follow-up (pinned registry.ts) |
| D2 | Security | Helpers keep `terminal` and `terminal_input` (owner question OWN-RELEASE-ACCEPT) | owner | after the owner rules |
| P2 | Ownership | After an engine crash, a terminal program that ignores the hangup outlives it | low | core `pty.ts`, later branch |
| P3 | Ownership | A browser command already running when its call ended runs to its end | low | later, needs S6 first |
| S4 | Security | `read_html` sends a page's hidden input values (CSRF tokens) to the model | low | proposal only |
| S5 | Security | Signal and rename on another's terminal ask under `terminal`, whose description omits them | info | app and schema text |
| S6 | Security | Guarded typing takes a failed focus check for "not moved" and then writes the rest | low | proposal only |

Every other point read holds; each is listed under its angle with what was read and why it holds.

## 1. Security and permissions

### S1. The browser in a session an invited guest acted in (medium, fixed)

- **Where.** `packages/engine/src/tool/browser.ts`, before this branch: no guest check anywhere in the tool. The desktop
  keeps one browser profile, `persist:vector-browser` (desktop `browser-agent.ts:128`), for the Preview and for every
  session. A handoff asks the user to sign in there (`HANDOFF_QUESTION`), so it holds the user's sign-ins.
- **Gap.** In a session an invited guest has acted in (FreeModelGuests marks the whole tree), the tool still opened,
  read and drove pages in that profile. Full access answers `browser_external` and `browser_interact` alone
  (`permission-policy.ts:192`), so a guest's prompt could have the agent read the user's signed-in mail or dashboard
  into the transcript the guest sees. The terminal tool keeps the user's terminals from such a session
  (`terminal.ts:708`) and the computer tool refuses it (`ComputerAvailability.sessionReason`).
- **Fix.** `browser.ts:577` takes FreeModelGuests as the tool takes Question and ResearchRun (present wherever the
  registry builds tools, since the terminal tool requires it there). `browser.ts:589` refuses every action but `close`
  in a marked session, before any ask or desktop command, with `GUESTED`.
- **Test.** `packages/engine/test/tool/browser.test.ts`, "in a session an invited guest has acted in, the browser
  reads, opens and drives nothing and asks nothing; close still closes it".

### S2. A non-web address asked under the origin `null` (low, fixed)

- **Where.** `browser.ts`, `approve` (`:702`), reached for any `open_url`, `open_tab` or `handoff` address that
  `isLocalUrl` (`:260`) does not call local.
- **Gap.** The desktop opens only http and https (`safeUrl`, desktop `browser-agent.ts:401`), but the engine asked
  first. A `file:`, `data:` or `javascript:` address, or one with no scheme such as `localhost:3000`, has the origin
  `null`, so the ask's pattern and its "always" were `null`: one "Always allow" would cover every such address. An
  address that does not parse (`example.com/login`) threw in `approve` and ended the call with an error.
- **Fix.** `webAddress` (`browser.ts:280`) and the check at `:594` refuse those addresses with `NOT_WEB` before any
  ask or command. The research lead's own refusal (`RESEARCH_ONLY`) still comes first.
- **Test.** `browser.test.ts`, "an address that is not http or https is refused before anything is asked or sent, not
  asked under origin null".

### S3. A terminal reveal took the keyboard into another's terminal (low, fixed)

- **Where.** `terminal.ts`, `reveal` (`:671`), which asks nothing, for any terminal of the location.
- **Gap.** `focus: true` published `pty.revealed` with focus for the user's own terminals and for another session's
  agent's. Since 335be5b77 the app keeps the focus while a text field holds it, but at any other moment one session's
  agent could put the user's next keystrokes into a terminal another session's agent reads as its own.
- **Fix.** `terminal.ts:673`: focus only for a terminal the agent opened (`own`, `:890`), where it asks the user to
  type a password. Other terminals are shown without focus, and the result says the focus stayed.
- **Test.** `packages/engine/test/tool/terminal-agent-review.test.ts`, "moves the keyboard only into a terminal the
  agent opened, never the user's or another session's".
- **Left.** `terminal.txt` still describes `focus` without the "your own terminal" limit. The result text tells the
  model; the one-line description change belongs to whichever branch next edits that file.

### D1 and D2. Who gets the terminal (deferred)

- `packages/engine/src/tool/registry.ts:424` lists `tool.terminal` among the builtins with no flag. `tool.browser`
  (`:442`) is offered only when the desktop sets `VECTOR_BROWSER_BRIDGE_URL` and `_TOKEN`.
- Helpers: `open` refuses a helper while background subagents are off (`terminal.ts:331`). A helper still types into
  and reads its parent's terminals as its own (`own`, `:890`), under the `own:` pattern, which auto-accept may answer.
- A flag or a per-agent gate needs `registry.ts`. #73 has merged since the review, but `registry.ts` is a pinned
  review-pipeline file (`REVIEW_PIPELINE_FILES`), so the gate stays a follow-up and is not built (lead ruling
  2026-11-25).
- **Owner question OWN-RELEASE-ACCEPT:** whether helpers keep `terminal` and `terminal_input`. Recommendation: deny
  terminals to helpers by default. Not decided in code. A "deny" ruling lands in the agent and helper defaults
  (registry.ts or agent config), as a follow-up of its own.

### S4. `read_html` sends hidden input values (low, proposal)

- `inspectPageHtml` returns `document.documentElement.outerHTML` (desktop `browser-agent.ts:1808`). Value attributes
  of hidden inputs (CSRF tokens) and of any server-filled password field reach the model. `read` and `observe` do not:
  `readPage` skips inputs (`browser-page.ts:92-107`) and `observePage` names only buttons by value.
- Proposal: blank the `value` attribute of hidden, password and credential-flagged inputs in that serialization. Not
  built: it changes what a developer debugging their own page sees, and no promise is broken today.

### S5. What the `terminal` permission names (info)

- `signal` and `rename` on a terminal the agent did not open ask under `terminal` (`askOther`, `terminal.ts:288`).
  The permission's text (`permission-policy.ts:124-128`, app `i18n/en.ts:1312`) names reading, waiting, resizing and
  closing. An "always" given for reading a terminal also covers interrupting, terminating or killing its program.
  Closing is under the same permission already, so no new power. Proposal: name signal and rename in both texts.

### S6. Guarded typing on a failed focus check (low, proposal)

- `type` and `typeRef` (desktop `browser-agent.ts:1095`, `:1136`) map any rejection of `sendGuardedCharacters` other
  than `CredentialFocusChangedError` to "not moved". That is meant for a character no key types (the native setter
  writes it after). A focus check that fails because the page navigated mid-typing is taken the same way: the text is
  then written whole into whatever the selector matches on the new page. The credential check in `replaceText` and the
  navigation rule (approved origins only) still apply.
- Proposal: tell a failed check from a failed send, and stop on the first. Needed before P3.

### What holds

- **Terminal input** (`terminal.ts:438-538`): `terminal_input` is asked under `own:` or `other:` first (`:454`).
  Each line the keystrokes submit is then asked as the shell command it is. A line the shell may have filled from
  history, the kill ring or a hook asks every time (`HISTORY :195`, `HOOKS :203`, `RECALLS :218`), as does a line the
  grammar cannot parse (`shell.ts`, `unread`). All of it is admitted before the first keystroke (`:505`), and
  `beforeRun` runs before each write. `other:` asks are never answered by auto-accept or Full access
  (`permission-policy.ts:147`, `:192`).
- **Open** (`terminal.ts:323-417`): the cap of 8 per conversation (`:336`); a terminal outside the shell sandbox asks
  `unsandboxed_terminal`, which has no "always" and no auto-answer (`:359`, `:871`). The environment is filtered
  (core `pty.ts:233`). Spawns go through `ProcessIsolation.launch` (core `pty.ts:241`). Native isolation stays off
  (`process-isolation.ts:26`, FLOOR false), and only hosted agents require it.
- **Guest sessions** (terminal): only the agent's own terminals are listed or used (`:302`, `:708`).
- **Unattended and offline sessions**: the terminal refuses every action in an unattended session (`:690`, R-M2), and
  `open`, `type`, `keys` and `signal` under Web access None (`:696`). The browser has no unattended check. It is
  offered only under the desktop bridge (`registry.ts:442`), and unattended runs are created only on the Everywhere
  paths, whose flags stay off (LAPTOP_ROUTE_WIRED false). Note for the day a laptop route is wired: refuse the browser
  in an unattended session there, as the terminal is refused.
- **Codium step budget**: neither tool calls a model. Each call is a tool call inside a model step, so the step budget
  applies unchanged.
- **Navigation**: the desktop opens only http and https (`safeUrl :401`). Automation reaches only approved origins
  (`allowNavigation :533`, `isAllowedBrowserNavigation`, policy `:24`), main-frame redirects included (`:568`); a
  popup becomes a tab (`:544`). The user's own click or key approves where it leads (`USER_NAVIGATION_WINDOW_MS`,
  policy `:55`). The engine asks for every action on an external page by its origin (`browser.ts:630`, `:702-729`),
  and a sensitive one every time. The desktop checks the page's origin and the click's label again inside the
  command's turn (`checkExpected :1505`).
- **Credential fields**: `isCredentialField` (`browser-credential-field.ts:8`) is checked before every key event
  (`browser-credential-input.ts:13`) in `type`, `typeRef` and `press` (`browser-agent.ts:1081`, `:1163`).
- **file:// and loopback**: `file:` is refused by the desktop, and now by the engine too (S2). A page on this computer
  asks nothing, by design: it is the agent's own work, such as a dev server (`browser.ts:260`). That covers every
  localhost port.
- **Downloads, permissions, pickers**: downloads are cancelled and reported (`browser-agent.ts:310`). A page gets no
  permission but fullscreen (`:239`, `:306`). File choosers are held by the debugger and dropped (`:816`), and dialogs
  are answered at once.
- **The bridge**: 127.0.0.1 only (`browser-bridge.ts:79`), with a bearer token (`:44`), POST only and a 256 KiB body
  cap (`:11`).

## 2. Process ownership

### P1. A queued browser command ran after the turn was stopped (medium, fixed)

- **Where.** Desktop `browser-bridge.ts` and `runBrowserAgent` (`browser-agent.ts:1619`). The engine's fetch carries
  the call's abort signal (`browser.ts`, `bridgeRequest`), so the user's Stop aborts it.
- **Gap.** The desktop never learned that the call ended. A command queued behind another on the same page (two calls
  of one message, or one behind a slow `wait_for_selector`) ran when its turn came, after the Stop, with the asks it
  carried.
- **Fix.** `callerGone` (`browser-bridge.ts:23`) aborts a signal when the response closes before it was sent, and the
  bridge makes one per request (`:37`) and passes it on (`:68`). A queued command whose signal is aborted when its
  turn comes is not run (`browser-agent.ts:1661`). It reports that it did not run (`abandonedReport :1955`). Commands
  that run at once (the panel's, the user's, `closeBrowser`) are unchanged.
- **Tests.** Desktop `browser-agent-tabs.test.ts`, "a command still waiting for its page when its call ended never
  runs; the one running finishes". New `browser-bridge-agent-review.test.ts`, the three "a call to the agent browser"
  cases: `callerGone`'s two, and the bridge handing each agent command its signal.

### P2. A terminal program after an engine crash (low, deferred)

- What holds: a terminal records its owner (`terminal.ts:379`). Deleting a session closes its terminals
  (`task/isolation.ts:3424`). Stopping a conversation closes its helpers' terminals and browsers
  (`task/manager.ts:1471-1487`); the main agent's stay, shown in the panel. `close` kills the program's group if it
  ignores the hangup (`pty/process.ts:87`). A location's end tears down every terminal in it (core `pty.ts:151`,
  `:164`), and so does an orderly engine exit.
- Gap: after a crash, a POSIX program that ignores SIGHUP (nohup, setsid, a dev server that daemonizes) outlives the
  closed pty. On Windows no job object holds a terminal's programs (none in core, engine or desktop sources), so what
  survives depends on how ConPTY closes.
- Proposal (core `pty.ts`, not this branch): a job object with KILL_ON_JOB_CLOSE for each terminal's process on
  Windows; on POSIX, a run file of running terminal process groups, reaped at the next engine start.

### P3. A browser command already running when its call ended (low, deferred)

- The rest of a `type`, or a click's settle, runs to its end, at most `TURN_DEADLINE_MS` (60 s). Stopping it midway
  needs a cancellation path through `type`, `typeRef` and `press`, and S6's distinction first, or a cut-off typing run
  would fall through to writing the whole text.

### What holds (browser)

- A session's browser closes with the session (`browser.ts:292`), with the Preview's window (`browser-agent.ts:751`),
  after 15 idle minutes with no Preview (`:476-492`), and on the app's Stop (`destroyContext :911`). After an engine
  crash the session's browser waits for the idle close, 15 to 16 minutes. A desktop crash ends every page with it.

## 3. Fit with the owner's criteria

1. **Visible indicator and stop.**
   - Browser: holds. Every main window hears what each agent browser does (`emitActivity`, `browser-agent.ts:453`).
     The session page shows "Agent is using the browser" with Show and Stop (66ebcc069). The turn's Stop now also
     stops queued commands (P1).
   - Terminal: agent terminals join the panel's tabs, marked "Opened by an agent"
     (`session-sortable-terminal-tab.tsx:147`), and closing the tab ends the program.
   - **F1 (medium, app, later branch):** while the terminal panel is closed, nothing shows that an agent terminal runs.
     `open` without `reveal` leaves the panel closed. The browser has had such an indicator since 66ebcc069. Proposal:
     a session-page line, "Agent is running N terminals", with Show (opens the panel on the tab) and Stop (closes the
     agent's terminals), as `features/browser-agent/browser-activity.tsx` does for the browser. App files are not in
     this branch.
2. **Permissioned use.** Holds, with S1 to S3 fixed. See section 1.
3. **Separate from the user's own terminals and browser profile.**
   - Terminals: the owner field tells the agent's terminals from the user's. Asks about the user's are never answered
     alone. Guest sessions see only their own, and a reveal no longer takes the keyboard into another's (S3).
   - Browser: Vector's own Electron profile, apart from the user's system browsers. It is shared, by design, with the
     user's Preview (a handoff signs in there) and across sessions (`persist:vector-browser`, `browser-agent.ts:128`).
     The guest gap that sharing opened is closed (S1). A profile per session or per conversation would separate
     sessions' sign-ins. That is a design option for later, not a defect.
4. **Built on main's newer pieces.** Holds. The terminals are core Pty sessions in the location's services, the same
   the app's panel lists (`registry.ts:689`). They are held alive while they run (`pty/hold.ts`) and closed with
   helper checkouts (`TaskIsolation.closeSessionTerminals`). The browser is the Preview panel's WebContentsView, driven
   through the desktop bridge (`browser-agent.ts:111-115`).

## The late commits

- **66ebcc069** (show and stop the agent's browser, close it with its session): read the activity feed, Show and Stop,
  closing with the session and the helpers' stop, and the idle close. Holds. P1 was found next to it.
- **335be5b77** (a reveal never takes the keyboard from a typing user): the app guard holds. The engine side left
  other terminals focusable (S3, fixed).
- **fa938a090** (double and right clicks): the same asks as a click, a sensitive ask included (existing
  `browser.test.ts` case). The bridge takes only 1 or 2 and left or right. A double or right click needs its point
  uncovered (`clickTarget`). Holds.
