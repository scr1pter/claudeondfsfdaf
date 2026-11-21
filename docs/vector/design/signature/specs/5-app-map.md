# Vector v2: the whole app, mapped, and the last ten boards

Status: written 2026-11-20 and revised the same day after a review ("Review notes" at the end lists every change). **All ten boards are now drawn** and sit in `canvas/` next to the approved ones; the live canvas has them in rows 9 to 12. Each was checked by parsing its script and running every tweak value against a stub, then reviewed together for consistency; none was rendered. Where a board departs from this spec (mostly to match today's wording in the code), the board wins: section 8 lists those departures. Section 5 says how Fable, Opus and Sonnet split the build. Facts come from `origin/main` at `f3d7ac742` (read-only checkout `~/.cache/vector-review-main`, read with `git show`), which holds every v2 feature (PR #33 joined them; #34 cloud workspaces, #36 Codium, #38 connected workspace, #40 Hands, #43 @vector came after), and from the specs in `docs/vector/design/signature/specs/`: `1-concept.md` (SIG), `2-blend.md` (BLEND), `3-screens.md` (SCREENS), `4-places.md` (PLACES).

**Owner direction (2026-11-20), binding on every board below**
- The redesign is "just a better Vector, incorporating the same features". Whichever agent runs a session (Vector's own or an installed coding agent), the window looks about the same as the two familiar desktop coding apps the owner named. Vector's only visible differences are tokenomics (usage shown as Codium percentages) and access to more models.
- Build the newer boards 1:1: the blend round (Chat, Changes, Tasks, Browser-A/B/C, Vectorscope-Home/Review, Settings-General/Models/Account, Search, Connections, Automations) and the latest round (Plan, Artifacts, Simulator, Oncall, Commands, Walkthrough). Main and Sidebar are superseded.
- Fewer controls ("this is too much"). The chips under the composer stay on one row. No project logo tiles. Today's account row ("You · Codium Max") and today's top buttons stay, smaller. Codium shows percentages only, never tokens or prices. No team features.

**Editing boards:** the boards live in `docs/vector/design/signature/canvas/`. No copy of `support.js` exists in the repository: the Design canvas host serves it. Keep the `<script src="./support.js"></script>` line exactly and never write a `support.js`. Builders read the boards; they never edit them. A board changes only when the owner changes the design.

**What "build 1:1" means for the More menu.** Chat, Search, Tasks, Connections, Automations, Oncall and the Settings boards draw SIG's first More list as plain text (Agent Dashboard, Coordinated runs, Browser, Code editor, Terminal, MCP, Plugins, Vector Cloud, Getting started 3/7). Build those boards 1:1 except that one menu, which takes section 1's final list on every board (decision D13). Today's checklist has three steps, so "3/7" becomes "2/3".

---

## 1. The More menu, final

**Answer to the owner's question ("what will be in there?").** More holds what today's sidebar keeps under "Repository tools" and "Connections" that is not already a verb or a panel, plus today's Vector Cloud and Getting started. At most seven rows, and four when nothing conditional applies (Agent Dashboard, MCP, Plugins, Deploy). Every row opens a screen that exists on `origin/main` today.

**Geometry.** Menu recipe (BLEND 2.5), 240 wide, `position: absolute` inside the verbs block, `top` = the More row's top (154 with six verbs; Chat's five-verb version uses 124), `left: 252px`. Rows 28 tall, padding 0 8 0 10, gap 8: a 16 px glyph slot in `--vxs-icon`, label 13/18 `--vxs-text-row`, meta right-aligned 11/14 tabular `--vxs-text-2` (every row can be the active row, so not `--vxs-text-3`). The More row shows `--vxs-row-pressed` while the menu is open, and `--vxs-row-selected` while a More route is on screen (Agent Dashboard, Connected tools, Deploy), as Connections already draws. Esc closes and returns focus to the row. Plugins never add rows to More either (new rule, in the spirit of SIG 4.2 B, which forbids plugin verbs).

| # | Glyph | Label | Opens | Meta | Shown when |
|---|---|---|---|---|---|
| 1 | `dashboard`: today's four squares (workspace-navigation.tsx 512-551: rects 4.7 x 4.7 rx 1.1 at (2.3,2.6), (9,2.6), (2.3,8.7), (9,8.7), 16 box), at 16 px, stroke 1.25 | Agent Dashboard | Stage route (BLEND 7.3, section 3.2 here) | none (as today; the Live strip already carries "needs you") | Always |
| 2 | `runs`: today's three linked circles (workspace-navigation.tsx 563-575: circles r 1.6 at (8,3.4), (3.6,12.4), (12.4,12.4); `M7.2 4.8 4.4 11M8.8 4.8l2.8 6.2M5.2 12.4h5.6`, 16 box), stroke 1.25 | Coordinated runs | Right-hand drawer (BLEND 7.8) | today's: "2 running" while any run, otherwise the total, e.g. `3` | Only once a coordinated run exists (today's rule, workspace-navigation.tsx 559) |
| | *separator* | | | | |
| 3 | `mcp` (SCREENS 1.5) | MCP | MCP dialog (BLEND 7.5) | none | Always; with no repository open it shows today's toast "Open a repository first" |
| 4 | `plugin` (SCREENS 1.5) | Plugins | Plugins dialog (BLEND 7.5) | none | Always |
| 5 | `connected` (SCREENS 1.5, the Connected tools route glyph) | Connected tools | Connected tools route (Connections board) | none | While the connected workspace is on (`VECTOR_EXPERIMENTAL_CONNECT`). The owner approved the Connections board, so SIG's "hidden until approved" no longer applies |
| | *separator* | | | | |
| 6 | `deploy` (new, because today's Home button has no glyph of its own: `M12 15V4.5M7.5 9L12 4.5 16.5 9M5 14.5V19h14v-4.5`, 24 box, stroke 1.75) | Deploy | Stage route Deploy: today's Vector Cloud console (`/cloud`) | none | Always, as today's Home button is |
| 7 | progress ring (the composer Codium ring recipe at 14 px, arc `--vxs-accent` at the done share) | Getting started | Getting started dialog: checklist, "Take the tour", where-things-are guide | `2/3` (today shows the count only while incomplete) | Until all three steps are done or the person hides it (today's `dismissed` flag) |

**What changed against SIG's first list (drawn, text-only, on Chat, Search, Tasks, Connections, Automations, Oncall and the Settings boards):**
- **Browser** left: the Panels button, ⌥⌘2 and `/browser` open it (PLACES decision 12).
- **Terminal** left: today's header Terminal button and ⌃\` already open it, which is where both reference apps keep their terminal. One door, not two.
- **Code editor** left: the Agent | Editor switch in the sidebar's chrome row (⌘⇧E) and `/codespace` already open it on every board. It does not move to Panels either: the editor is a whole-stage mode (today's CodespaceWorkbench has its own "Workspace mode" switch), not a pane beside the chat.
- **Vector Cloud is kept and renamed Deploy.** It is not a forerunner of the Cloud computer: it is today's deploy-and-operate console (`features/cloud/cloud-home.tsx`, `cloud-console.tsx`: deployments, logs, observability, domains, environment variables, database, authentication, storage, edge functions), reached today from Home's always-shown "Vector Cloud" button. The Cloud computer host does not replace it. This overrides SIG's "only until the Cloud computer host exists" and PLACES' review note that relied on it; the new name stops it clashing with "Cloud computer", `/cloud` and Connected tools' "Vector cloud" place (decision D1).
- **Added:** Connected tools shown (approved). Nothing else is added.

**Deliberately not in More:** Vectorscope, Automations and On-call (sidebar verbs); saved workflows and Vector Playbooks (`/workflow` and ⌘K "Run a saved workflow", BLEND 7.9's own doors; Playbooks install in Settings › Agents as today); Memory and learned skills (Settings › Memory; the learned chip's "Review" link at the end of a turn; ⌘K "Open Memory"; decision D2); Hands, Cloud computer, iOS Simulator, Browser and Plan (`/` commands and the Panels menu); Race (Tasks pane header, as today, and ⌘K); Remote (account popover › Pair a phone…, Settings › Remote); deep research (Speed › Deep research); cloud workspaces (a website pilot at vectordev.ai/workspaces with no desktop screen). ⌘K lists every More row as a command with the same words.

---

## 2. The app map

Every screen, view, pane, dialog, menu and overlay in `packages/app/src` on `origin/main`, plus what the redesign adds. "Board" names the existing board that draws it, or **MISSING → NewBoard (tweak)** for the board in section 3 that will. Windows and Linux variants (Windows app menu, caption buttons, Ctrl shortcuts) follow SIG 4.2 A and 4.9 and are not drawn.

| Area | Screen (today's code) | Lives in the redesign | Board |
|---|---|---|---|
| Shell | Window frame, wallpaper, traffic lights (native-window-chrome.tsx) | Frame | every board |
| Shell | Launch screen: starting, "Still starting…", "Vector didn't finish starting" (features/launch) | Before the window | **MISSING → Onboarding (step=launch, error)** |
| Shell | Route error page (pages/error.tsx) | Stage error state, same recipe as the failed launch | **MISSING → Onboarding (step=error)** |
| Shell | Titlebar session tabs (titlebar-tab-*.tsx) | Settings › Appearance › Show open sessions as tabs, off (SIG) | not drawn: optional, off by default |
| Shell | Toasts (utils/toast.ts) | Bottom of the stage, menu recipe | Artifacts ("Link copied") |
| Shell | Engineering Console drawer (layout-new.tsx 7310-7400) | Retired: nothing opens it (no `setToolsOpen(true)` on main); its rows live in Connected tools, MCP, Plugins and Settings | none needed |
| Shell | Hands overlay: edge glow, banner, click ring, ghost cursor (features/computer/overlay-*.ts) | Desktop overlay | Commands (running) |
| Shell | Windows app menu and caption buttons (windows-app-menu.tsx); macOS menu bar (desktop-menu.ts); OS notifications for asks (pages/layout/ask-notifications.ts); deep links | Native or Windows-only; SIG 4.2 A | not drawn |
| Sidebar | Chrome row: sidebar toggle, back, forward, Agent \| Editor switch | Sidebar | every board |
| Sidebar | Home (pages/home.tsx, route "/") | New session verb → empty state (SIG 4.7-4.8) | Chat (view=new) |
| Sidebar | Search ⌘P (dialog-select-file.tsx), Find in repository | Search verb, ⌘K; ⌘P scoped to files | Search |
| Sidebar | Agents tree: projects, workspaces, "New workspace +" | Host groups, project rows, session rows, child connectors, host `+`, project hover `+` | every board (Sidebar.dc.html superseded) |
| Sidebar | Live strip (new) | Sidebar | every board |
| Sidebar | Automations, Vectorscope, On-call verbs | Sidebar verbs | Automations, Vectorscope-*, Oncall |
| Sidebar | More menu (Repository tools and Connections groups today) | Sidebar verb › menu (section 1) | Chat and others draw SIG's first list; **final → More (open=more)** |
| Sidebar | Host `+` menu, host switcher popover (3+ hosts), View options (incl. Show archived, today's archived sessions list, home-session-archive.ts), project `⋯`, session row `⋯` (SIG 4.2 E-F) | Sidebar menus | **MISSING → More (menu=hostadd, hosts, view, project, row)** |
| Sidebar | Inline rename (pages/layout/inline-editor.tsx) | Row `⋯` › Rename edits the title in place | not drawn (today's behaviour) |
| Sidebar | Edit repository dialog (dialog-edit-project.tsx) | Project `⋯` › Edit repository…; icon and colour fields removed (no project logos) | **MISSING → More (menu=edit)** |
| Sidebar | Getting started checklist and feature guide (onboarding.tsx `OnboardingProgress`; steps at layout-new.tsx 3298-3380). Today it opens by itself on Home at first launch and after the tour; its sidebar row survives only in the legacy nav (7160-7185, `data-vector-navigation-legacy`) | More › Getting started; still opens by itself at first launch | **MISSING → More (open=getting)** |
| Footer | Account row, Founding badge, signed-out row | Footer | every board; Chat (founding tweak) |
| Footer | Account popover: meter, activity, Pair a phone…, Account settings, Plans, Sign out | Footer | Chat |
| Footer | Help menu (Take the tour first) | Footer | Simulator, Walkthrough (step=replay) |
| Footer | Help panel: help assistant, documentation, Free models card (features/help/help-panel.tsx; on desktop today only Diagnostics' fallback opens it, and Help › Docs opens vectordev.ai/docs in the browser) | Help › Docs opens a Help drawer whose Documentation tab keeps "Open the docs site" (decision D12) | **MISSING → More (menu=help)** |
| Footer | Report a bug (dialog-report-bug.tsx) | Help › Send feedback | **MISSING → More (menu=feedback)** |
| Footer | Release notes (dialog-release-notes.tsx, opened once after an update by context/highlights.tsx) | Unchanged: once after an update. Help › Changelog stays today's link to vectordev.ai/docs/changelog | **MISSING → More (menu=notes)** |
| Footer | Diagnostics, Open debug tools (support-reports.ts) | Help menu rows; actions with no screen | none needed |
| Footer | Update button and restart confirmation (home-update.tsx, updater-action.ts) | Footer Update button (BLEND 3.2) | **MISSING → More (menu=update)** |
| Session | Header row 1: title, branch chip and Switch branch (components/session/branch-picker.tsx), status chip, Tasks, Changes, Terminal, Panels | Header | Chat, Simulator |
| Session | Status chip popover: Servers, MCP, LSP (status-popover*.tsx) | Header status chip | **MISSING → SessionTools (overlay=status)** |
| Session | Header row 2: usage pill, context ring, "…" | Header | Chat |
| Session | Session options "…": Share publicly, Rename, Pin, Copy link, Open in, Transcript view, Archive, Delete | Header row 2 "…"; add "Fork…" and "Push to GitHub…" rows | Chat (two new rows not drawn) |
| Session | Share session publicly (dialog-share-session.tsx) | "…" › Share publicly…, `/share` | **MISSING → SessionTools (overlay=share)** |
| Session | Fork from a message (dialog-fork.tsx) | "…" › Fork…, `/fork` | **MISSING → SessionTools (overlay=fork)** |
| Session | Push to GitHub or GitLab (session-github-push.tsx, session-gitlab-push.tsx), incl. the commit-message memory check (pages/session/commit-check.ts) | "…" › Push to GitHub…, ⌘K | **MISSING → SessionTools (overlay=push)** |
| Session | Find in chat ⌘F (layout-new.tsx 3622-3660; uses the window's own find, so there is no match count) | Bar over the transcript, top right | **MISSING → SessionTools (overlay=find)** |
| Session | Transcript: messages, tool rows, edit cards, task cards, finding cards, child-session cards (pages/session/timeline) | Chat column | Chat |
| Session | Docks: working line, permission dock | Above the composer | Chat |
| Session | Docks: todo, plan | Above the composer | Plan |
| Session | Docks: question, follow-up queue with Steer, delegation suggestion (BLEND 4.6) | Above the composer | **MISSING → SessionTools (view=docks)** |
| Session | Docks: revert, interrupted, model recommendation; step-limit and budget stop rows (budget-stop.tsx) | Above the composer; transcript row | **MISSING → SessionTools (view=docks2)** |
| Session | Research plan card (research/plan-card.tsx) | Question-dock slot; Speed › Deep research starts it | **MISSING → Research (view=plan)** |
| Session | Research report card (research/report-card.tsx) | Transcript; opens in the Artifacts pane | **MISSING → Research (view=report)** |
| Session | Learned chip, workflow chip (memory/learned-chip.tsx, workflow-chip.tsx) | End of a turn in the transcript | **MISSING → Brain (tab=chat)** |
| Session | Prompt-source ask (self-evolving 8.1) | Permission dock variant, asks every time | **MISSING → Brain (tab=chat)** |
| Session | Codium 80% alert, plan used up, payment and sign-in fixes (codium-usage-alert.ts, codium-error.tsx) | Toast; transcript notice card. "Change plan" and "See plans" open Settings › Account with Monthly plans open | **MISSING → Codium (view=alert, limit)**; the plans list is Settings-Account (`plans=true`) |
| Session | Free models daily limit (free-models-limit.tsx) | Transcript notice | **MISSING → Models (account=free)** |
| Session | Free model training question (dialog-free-model-training.tsx) | Dialog before the first prompt to a labelled free model | **MISSING → Models (view=training)** |
| Session | Presence chip: other clients on a shared server (presence-banner.tsx) | Unchanged, outside the redesign (shared-server access is team-like) | not drawn (decision D8) |
| Panels | Panels button and menu, pane strip `+` | Header row 1 after Terminal | Plan, Artifacts, Simulator |
| Panels | Changes: list, reader, line comments (review-panel-v2.tsx, file-tabs.tsx) | Pane; header Changes | Changes |
| Panels | Browser (browser tab, features/browser-agent) | Pane (A default; B, C modes) | Browser-A/B/C |
| Panels | Context (session-context-tab.tsx) | Pane; header context ring | **MISSING → SessionTools (view=context)** |
| Panels | Sources and research browser (research/sources-tab.tsx, source-viewer.tsx) | Pane, after a research run | **MISSING → Research (view=running)** |
| Panels | Plan, Artifacts, iOS Simulator | Panes | Plan, Artifacts, Simulator |
| Panels | Cloud computer live view (today: the bar's Watch and Take over open `hosted.liveView` in a window of its own, hosted-composer.tsx 238-246) | Pane "Cloud computer", only while that session runs there **(new: decision D11)** | **MISSING → Codium (view=watch, control)** |
| Panels | Tasks pane: subagents, specialists, workflow card, Hands card, Cloud computer card, background commands, connected-tool task rows (connect/task-rows-section.tsx) | Header Tasks | Tasks |
| Panels | Hands "Watch" dialog from the Tasks card: the run's steps with each screenshot and click marker (background-tasks/computer-watch.tsx) | Dialog over the session | **MISSING → SessionTools (overlay=watch)** |
| Panels | Terminal panel | Header Terminal | Chat |
| Panels | Agent-opened terminals: "Opened by an agent", "exited 0", "ended" (agent-environment) | Terminal panel tabs | **MISSING → SessionTools (view=terminal)** |
| Panels | Editor mode, Vector Codespace: Explorer, Search and Problems tabs, "Vector Tab" completions, "Agents editing isolated copies of this file", live agent activity (session-side-panel.tsx CodespaceWorkbench, file-tree-v2.tsx, monaco-code-editor.tsx, `/codespace`) | Chrome-row Agent \| Editor switch, ⌘⇧E | **MISSING → SessionTools (view=editor)** |
| Composer | Box: attach, dictation, send, stop and its menu | Composer | Chat |
| Composer | Dictation recording state (dictation-indicator.tsx) | Mic button state inside the box | not drawn (today's, restyled) |
| Composer | Attachments: file and image chips, drop overlay, and the memory chips "Remember", "Remember instead" and "Remember this text" (prompt-input/context-items.tsx, image-attachments.tsx, drag-overlay.tsx, remember-chips.tsx) | Inside the box, above the text; never a second chip row under it | **MISSING → Brain (tab=chat)** |
| Composer | One-row chips: host, project, model, mode, effort, speed, Codium ring | Composer | every session board |
| Composer | Workspace selector on a new session: "Run in" Local or New workspace (prompt-workspace-selector.tsx) | The empty state's branch chip menu, Local checkout / New worktree… (BLEND 4.4 item 3) | Chat (view=new) |
| Composer | Host menu: Run on This Mac or Cloud computer, Move to Cloud computer… | Host chip | Chat |
| Composer | Project menu, Choose a project, Open a folder…, Clone from GitHub… | Project chip | Chat |
| Composer | Mode, Effort and Speed menus | Chips | Chat |
| Composer | "/" and "@" menus (slash-popover.tsx) | Composer | Chat, Commands |
| Composer | Model picker (dialog-select-model.tsx, model-picker-state.ts) | Model chip, ⌘' | **MISSING → Models** |
| Composer | Manage models (dialog-manage-models.tsx) | Model picker › Manage models… | **MISSING → Models (view=manage)** |
| Composer | Model picker for an installed coding agent (agents/external-runtime-models.ts) | Model chip in that agent's session: only the agent's own models | **MISSING → AgentDashboard (view=agent, picker=true)** |
| Composer | Vector Local pill and "What Vector sent" popover (local/status-pill.tsx, egress-popover.tsx) | A lock badge on the host chip (no extra chip) and its popover | **MISSING → Models (local=true, view=sent)** |
| Composer | First-run "Connect a model to start" card (free-model-start.tsx) | Setup card above the composer | **MISSING → Onboarding (step=welcome)** |
| Composer | Cloud computer composer button (hosted-composer.tsx) | Removed: `/cloud` and the host chip | Commands (state=cloud) |
| Composer | Done by Morning queue form (hosted-composer.tsx, the "Done by Morning" tab of today's "Run on my cloud computer" dialog) | ⌘K "Queue a job for the morning" (the composer button that held it is removed, PLACES 3.2); its "Queued jobs and reports" link opens the list below | **MISSING → Codium (view=morning)** |
| Composer | Done by Morning jobs and reports: "Met / Not met" per criterion, recording, "Approve: open the pull request", "Return report here" (hosted-composer.tsx DialogHostedJobs) | Tasks Cloud computer card link "Done by Morning: 1 queued job · 6:00"; sidebar "Morning queue" row | **MISSING → Codium (view=jobs)** |
| Composer | Cloud bar after a plan ends: "Your cloud computer's files" with "Download your files" (hosted-model.ts KEPT_TITLE) | One quiet line in the cloud bar | not drawn (one line; build from the code) |
| Routes | Agent Dashboard incl. preview links on cards and the messages agents in one group send each other (agents/agent-dashboard.tsx, today's "Team conversation") | More › Agent Dashboard, stage route | **MISSING → AgentDashboard** |
| Routes | Isolated agent workspace, incl. installed coding agents (external-agent-workspace.tsx, `/parallel-workspaces/:id`) | Ordinary session view; child row under its parent | **MISSING → AgentDashboard (view=agent)** |
| Routes | Vectorscope: pull requests, review run, checks, merge, signed out, local review (pull-requests.tsx, local-review-panel.tsx) | Verb, stage route | Vectorscope-Home, Vectorscope-Review |
| Routes | Vectorscope review memory (vectorscope/review-memory-*.tsx) | Vectorscope list column link → Settings › Memory | **MISSING → Brain (tab=memory)** |
| Routes | Vectorscope "GitHub workflow & runs" panel: @vector setup card, bindings, runs (pull-requests.tsx 2068-2076, 2249; github-agents/setup-card.tsx) | One home: the Vectorscope list row links to Settings › GitHub, which draws the same parts | **MISSING → Settings-More (page=github)** |
| Routes | Vectorscope workspace review approval (connect/directory-review.tsx) | Agent Dashboard card; Connected tools | **MISSING → AgentDashboard (card=review)** |
| Routes | Automations (scheduled/automations.tsx) | Verb | Automations |
| Routes | On-call: requests, rules, sources, setup; Vector everywhere (Slack, Linear, Jira), @vector mentions, production checks | Verb | Oncall |
| Routes | Connected tools (connect/connected-tools.tsx) | More › Connected tools; Settings › Agents link | Connections |
| Routes | Deploy, today's Vector Cloud (cloud-home.tsx, cloud-console.tsx, cloud/vercel/*, cloud/supabase/*) | More › Deploy | **MISSING → More (open=deploy)** |
| Routes | Settings | Footer gear, ⌘, | Settings-*, Brain, Settings-More |
| Multi-agent | Agent launcher: One agent or Coordinated run, Alone or together (agents sharing one checkout and messaging each other), who may message whom, runtime choice, Compare ready runtimes (layout-new.tsx 4150-4960, `parallelComposerOpen`; the full-window copy at 5582 is switched off) | Host `+` / project `+` › New workspace, ⇧⌘W | **MISSING → Workflows (surface=launcher)** |
| Multi-agent | Host locally: installed coding agents (agents/dialog-host-locally.tsx) | Launcher › Choose a runtime › Host locally | **MISSING → Workflows (launcher=installed)** |
| Multi-agent | Coordinated runs drawer, "Multi-agent orchestration" (layout-new.tsx 5321-5580) | More › Coordinated runs | **MISSING → Workflows (surface=drawer)** |
| Multi-agent | Selective review and merge (parallel-diff-review.tsx) | Drawer "Review & merge"; dashboard card | **MISSING → Workflows (surface=merge)** |
| Multi-agent | Run a saved workflow (background-tasks/workflow-dialog.tsx) | `/workflow`, ⌘K "Run a saved workflow" (BLEND 7.9) | **MISSING → Workflows (surface=workflow)** |
| Multi-agent | Vector Playbooks (settings-v2/playbooks.tsx, rendered inside Settings › Agents) | Where today: Settings › Agents › Workflows › Vector Playbooks (Install). Installed ones then show in the workflow dialog's list from your config | **MISSING → Settings-More (page=playbooks)**; installed row on Workflows (workflow=list) |
| Multi-agent | Race (race/dialog.tsx, opened from background-tasks-pane.tsx) | Tasks pane header, ⌘K "Race models" | **MISSING → Workflows (surface=race)** |
| Multi-agent | MCP and Plugins dialogs (dialog-select-mcp.tsx, dialog-select-plugins.tsx, plugins/catalog.tsx) | More | Connections (dialog=mcp, plugins) |
| Setup | 43-step spotlight tour (onboarding/spotlight-*.ts) | Replaced by the five-card walkthrough | Walkthrough |
| Setup | Sign in to Vector (vector-account.ts) | Setup card, account row | **MISSING → Onboarding (step=signin)** |
| Setup | Connect, select and custom provider dialogs (dialog-connect-provider.tsx, dialog-select-provider.tsx, dialog-custom-provider.tsx) | Setup card; model picker › Connect a provider…; Settings › Providers | **MISSING → Onboarding (step=connect)** |
| Setup | Open a folder (dialog-select-directory-v2.tsx, directory-picker.tsx) | Host `+`, project chip, setup card | **MISSING → Onboarding (step=folder)** |
| Setup | Clone from GitHub, Connect GitHub device code (dialog-clone-github.tsx, github-connect.tsx) | Same doors | **MISSING → Onboarding (step=clone)** |
| Setup | Repository trust prompt (project-trust-prompt.tsx) | Banner above the composer, then a dialog | **MISSING → Onboarding (step=trust)** |
| Setup | Prompt trust banner: held prompt files (prompt-trust-banner.tsx) | Stage banner under the header | **MISSING → Brain (guard=true)** |
| Settings | Route shell and nav | Footer gear | Settings-General |
| Settings | General, Usage & streak, Appearance (new), Browser (new), Providers & keys, Agents (subagents, limits, workflows) | Settings | Settings-General (page tweak) |
| Settings | Default models, incl. review model and Vector Local roles | Settings | Settings-Models |
| Settings | Account: Codium tiles, monthly plans, reports, delete | Settings | Settings-Account |
| Settings | Memory: Memory, Skills, About you, Workflow insights, Documents, Research, Search model; Backup; Brain helpers; "Your memory file" (settings-v2/memory*.tsx, features/memory/local-memory-panel.tsx) | Settings › Memory; the learned chip's Review link; ⌘K "Open Memory" (no More row, D2) | **MISSING → Brain** |
| Settings | Vector Local, setup wizard, allow dialog, network log (settings-v2/local.tsx, features/local/*) | Settings › Vector Local | **MISSING → Settings-More (page=local)** |
| Settings | Vector Hands, incl. macOS permission step (settings-v2/computer.tsx, computer/input-setup.tsx) | Settings › Vector Hands | **MISSING → Settings-More (page=hands)** |
| Settings | GitHub (@vector and Codium's GitHub connections): connection, repository binding, recent runs, schedules, Brain proposals, Run in GitHub (settings-v2/github-agents.tsx, features/github-agents/*) | Settings › GitHub (nav row missing from the boards' nav) | **MISSING → Settings-More (page=github)** |
| Settings | Remote: pair a phone, paired phones (settings-v2/remote.tsx) | Settings › Remote; account popover › Pair a phone… | **MISSING → Settings-More (page=remote)** |
| Settings | Production: On Call URLs, Release Guard, Ship Desk, domains (cloud/ops/ops-settings.tsx) | Settings › Production | **MISSING → Settings-More (page=production)** |
| Settings | Environment & servers, Add server, WSL (settings-v2/servers.tsx, components/server/*, wsl/*) | Settings; host popover › Add server… | **MISSING → Settings-More (page=env)** |
| Settings | Repository trust, Spend limits, Keyboard shortcuts, Notifications, Accessibility, Roadmap vote, Updates & about | Settings | **MISSING → Settings-More (page=trust, spend, keys, notify, a11y, roadmap, updates)** |
| Settings | VectorScope settings: enable reviews, review model (settings-v2/vectorscope.tsx) | Settings › Agents section; Default models | Settings-General (page=agents), Settings-Models (menu=review-model) |
| Settings | Second opinion (second-opinion-model.ts) | Settings › General › Verified completion row | Settings-General (row not drawn; build from the code) |
| Settings | Teams (settings-teams.tsx, settings-vector-teams.tsx) | Not in the redesign: no team features | none |
| Codium | Plan tiles, monthly plans, coming soon (codium-purchase.tsx, codium-billing.ts) | Settings › Account | Settings-Account |
| Codium | Change plan (codium-purchase.tsx; codium-error.tsx's "Change plan" and "See plans") | Account popover › Plans and the used-up notice open Settings › Account with Monthly plans open; no separate dialog (decision D7) | Settings-Account (`plans=true`, `change`, `payment`) |
| Codium | Cloud computer: bar, Tasks card, `/cloud` | Composer bar, Tasks, commands | Commands, Tasks |
| Codium | Brain Vault backup (settings-v2/memory-backup.tsx) | Settings › Memory › Backup | **MISSING → Brain (tab=backup)** |
| Codium | Remote, Playbooks, Race, roadmap vote, reports, second opinion, @vector on Codium | See their rows above | as listed |
| Phone | Vector Remote app: Pair, Sessions and tasks, Approvals, Devices, GitHub runs, Cloud computer, Production, Notifications (packages/app/src/phone) | A separate phone app (SIG 7.4) | not in this canvas (decision D4); desktop pairing on Settings-More |
| Web | Cloud workspaces pilot (packages/web/.../CloudWorkspaces.tsx, `/workspaces`) | The website | not in the desktop app |

---

## 3. The ten new boards

### 3.0 Common to all ten

- **Format:** Design-canvas `.dc.html`, the rules at the end of this file and section 4's shared parts. Each board is 1600 x 1000 with `$preview` `{"width":1600,"height":1000}`, window 1520 x 900, artboard padding 50 / 40, sidebar 264, stage 1256, dark only.
- **Sidebar on every board:** Simulator's sidebar, with the board's own session selected (table in 4.2), the More verb wired to the section 1 menu, On-call as the fourth verb with meta "◆ 1". Session titles in the boards' sample content are the sidebar's own titles (for example the swarm child stays "Swarm worker 2"), so a card, drawer row or banner never names a session the sidebar does not show.
- **Sample models and servers match the approved boards.** Vector Local is the model server "gpu-box" (coder-large, coder-medium, embed-small) and "this computer" (coder-small), as Settings-Models draws them. "build-box" is only a paired remote host (an SSH server that runs sessions), never a model server.
- **No third-party marks or names in visible copy.** Installed coding agents are "Installed agent", with their names drawn as skeleton bars (8 tall, radius 4, `rgba(255,255,255,0.08)`), as BLEND 7.2 draws provider names. Real provider model names appear only where a model is chosen (model picker, Race lanes) and only exactly as `api/_lib/codium-catalog.ts` spells them. Hosting and database accounts in Deploy read "Hosting" and "Database" (the build keeps today's provider names). GitHub stays named (PLACES decision 3).
- **No "team" in visible copy.** Today's multi-agent code says "team" for agents that share a checkout and message each other; the boards say "group" and "together" so nothing reads as a team (people) feature (decision D6).
- **Canvas** (`canvas.json`, appended after Walkthrough, `is_interactive: true`):

| File | x | y | Title |
|---|---|---|---|
| More.dc.html | 0 | 11360 | "More menu, Getting started, Deploy and the sidebar's menus" |
| AgentDashboard.dc.html | 1680 | 11360 | "Agent Dashboard" |
| Workflows.dc.html | 3360 | 11360 | "New agents, coordinated runs, workflows and Race" |
| Models.dc.html | 0 | 12780 | "Model picker" |
| Codium.dc.html | 1680 | 12780 | "Codium: limits, Done by Morning and the cloud computer" |
| Brain.dc.html | 3360 | 12780 | "Memory, learned skills and the prompt guard" |
| Onboarding.dc.html | 0 | 14200 | "First run" |
| SessionTools.dc.html | 1680 | 14200 | "In a session: editor, terminals, context, docks and sharing" |
| Research.dc.html | 3360 | 14200 | "Deep research" |
| Settings-More.dc.html | 0 | 15620 | "Settings: the remaining pages" |

  Row titles (`title1`, maxW 4960): (0, 11060) "The More menu, the Agent Dashboard and multi-agent work"; (0, 12480) "Models, Codium and what Vector learns"; (0, 13900) "First run, session tools and deep research"; (0, 15320) "The rest of Settings". Purple notes (w 400) at (−480, 11360): "More holds the tools you reach less often: Agent Dashboard, Coordinated runs, MCP, Plugins, Connected tools, Deploy and Getting started. Browser, Terminal and the code editor left it: Panels, the header and the Agent | Editor switch already open them."; (−480, 12780): "The model picker is where Vector differs most: Codium, free models, your own keys and models you host, in one list. Codium always shows as a share of the month, never tokens or prices. Memory shows what Vector learned and waits for your review."; (−480, 14200): "First run is one setup card and a few dialogs. In a session, the editor, agent terminals, context and research use the same panels and header as everything else."; (−480, 15620): "Every Settings page the earlier boards did not draw, on the same route shell."
- **Superseded boards.** In the same `canvas.json` pass, retitle Main "Vector window (superseded by the blend boards)" and Sidebar "Sidebar states (superseded by the blend boards)". Only their titles change; never their files.

### 3.1 More.dc.html

**Shows:** Chat's done session "Warn on review model evidence" at 1600 (transcript items 1, 2, 6, 8, 12 of BLEND 8.3; composer; no side panel). The sidebar sample gets a third host, "build-box" (`host-server`, Offline), only for `menu=hosts`.

**Tweaks (data-props):** `open` enum more | getting | deploy (default more), section "More"; `menu` enum none | hostadd | hosts | view | project | edit | row | help | feedback | notes | update (default none), section "Menus"; `runs` boolean (true): the Coordinated runs row shows; `connect` boolean (true): the Connected tools row shows; `setup` boolean (true): the Getting started row shows. With all three off the menu has its four permanent rows.

**open=more:** the section 1 menu, More row pressed, "Agent Dashboard" hovered. Metas: Coordinated runs "2 running"; Getting started `2/3`. No other row has a meta.

**open=getting:** dialog (BLEND 7.5), 560 wide. Title "Getting started"; description "2 of 3 first steps. Vector checks these off as you do them."; a 4 px meter at 66% (`--vxs-accent`).
- Step rows (min 56, hairlines between, glyph slot 16): check-ring "Connect a model" · 12/16 "Codium Max is connected."; check-ring "Open a repository" · "vector is open."; dash-ring "Try a safe first task" · "Ask Vector to look through this repository and explain it without changing files." · **Try it** primary pill 28.
- Then **Take the tour** secondary 28 (starts Walkthrough `step=welcome`) and **Hide Getting started** ghost 28.
- "Where things are" (12/16 weight 600 `--vxs-text-3`), rows 32, title 13/18 + where 12/16 `--vxs-text-2` (today's feature guide, its "where" lines rewritten for the redesign): New session · "Sidebar › New session, or ⌘N"; Several agents at once · "Project + › New workspace, or ⇧⌘W"; Code it yourself · "The Agent | Editor switch at the top of the sidebar"; Browser, plan and artifacts · "The Panels button next to Terminal"; Review changes · "Changes in the header, or ⇧⌘R"; Rewind code and chat · "Rewind on an edited-files card"; Terminal · "Terminal in the header, or ⌃\`"; Scheduled runs · "Sidebar › Automations"; MCP and plugins · "Sidebar › More"; Deploy · "Sidebar › More › Deploy"; Push to GitHub · "Session … › Push to GitHub…"; Models you host · "Settings › Vector Local".

**open=deploy:** More row selected. Route header (SCREENS 1.2): `deploy` 14, "Deploy", subtitle "vector · hosting and database"; right: project select "vector ⌄", Refresh ghost 24, Close. Body grid `220px 1fr`:
- Section nav (SIG verb rows, padding 8), today's sections and labels exactly (cloud-console.tsx 54-80), group labels in sentence case: Overview (selected; today's "Repository overview"); label "Deploy and observe": Deployments, Logs, Observability, Domains, Environment variables; label "Data services": Database, Authentication, Storage, Edge functions, Database logs, Security; label "Setup": Connections, Hosting settings.
- Overview (column max 880, padding 24 32): title 20/28 "vector"; 13/20 `--vxs-text-2` "Build, check, promote and roll back releases, and look after the database, from one place."; tiles (BLEND 7.2): Healthy releases "3 of 3" + "Based on the latest health checks"; Accounts "2 connected"; Environment variables "14" + "Stored for this repository"; Data "Database, authentication, storage".
- "Latest deployments" boxed list, rows 48: 6 px `--vxs-ready` dot · "Production · main · c41e2a9" · "Healthy · 2h ago" · **Roll back** ghost 24; orbit · "Preview · scope-evidence · 9f8e7d6" · "Building · 1m"; x-ring · "Preview · codium-cards · 5d21b07" · "Health check failed · 5h" · **Fix this deploy** tint 24 (today's label; cloud-handoff.ts hands the failing check's evidence to a session).

**menu values:** hostadd: host header `+` menu (New session on This Mac ⌘N, Open a folder…, Clone from GitHub…). hosts: host switcher popover 280 (This Mac · ready · 5 running · ◆ 1; Cloud computer · ready · 1 running; build-box · Offline; separator; All hosts; Pair a phone…; Add server…). view: View options, SIG 4.2 E's rows (Group by Project / Status / Recent; Sort projects Manual / Recent activity; Second line Attention only / All rows; Density; Show archived; Mark all read; Status legend; Host settings…). project: project `⋯`, today's rows (sidebar-project.tsx) with SIG's New session first: New session, Edit repository…, Turn workspaces off (today's enable/disable workspaces), Clear notifications, Close repository. edit: Edit repository dialog 480 (today's dialog-edit-project.tsx minus Icon and Color: Name "vector"; "Workspace startup script" mono "bun install" with 12/16 "Runs after creating a new workspace (worktree)."; Cancel ghost, Save primary). row: session row `⋯` (SIG 4.2 F: Open in new window, Rename, Pin, Mark as unread, Move to Cloud computer…, Copy session link, Archive). help: Help drawer from the right, 400 wide, full stage height (menu fill, 1 px `--vxs-edge` left): title "Help" + 12/16 "Answers only from Vector's documentation" (today's line); segmented Assistant | Documentation; the Free models card (outline card: "Free models inside of Vector", "A daily limit for each account. Some free models may train on your prompts.", "Training notice accepted · Withdraw" ghost 24); three suggestion rows (today's: "How do I run agents in parallel?", "Where is the code editor?", "How do I connect a model provider?"); field at the bottom "Ask about Vector…"; the Documentation tab ends with "Open the docs site" ghost 24. feedback: "Report a bug" 520 (textarea "What happened?"; checkbox "Include diagnostics"; 12/16 "Settings › Account shows what becomes of your report."; Cancel, Send report). notes: release notes 560, shown once after an update (today's highlights), pager "1 / 3": "Vector 2.0", heading "A calmer window", 13/20 body "One sidebar for every project and host, smaller header buttons, and panels beside the chat for changes, the browser, plans and artifacts." update: confirm 440 "Restart to update to Vector 2.0.1?" / "Running sessions pause and continue after the restart." / Cancel, **Restart now**.

**Interactions:** the More row toggles the menu; Getting started and Deploy set `open`; Agent Dashboard and Coordinated runs only close the menu here and name their board in the tooltip; Try it closes the dialog and fills the composer; Deploy nav rows select (only Overview has content); Help menu › Docs sets `menu=help`, › Send feedback `feedback` (Changelog stays an outside link, so it does nothing here); the footer Update button `update`; Esc closes.

**Follow:** SIG 4.2 B, E, F, H; BLEND 3.2-3.4, 7.5; SCREENS 1.2, 1.7; PLACES 4 (tour replay); code workspace-navigation.tsx, onboarding.tsx, layout-new.tsx 3298-3380, help-panel.tsx, free-models-card.tsx, dialog-report-bug.tsx, dialog-release-notes.tsx, home-update.tsx, dialog-edit-project.tsx, cloud-home.tsx, cloud-console.tsx, cloud-handoff.ts.

### 3.2 AgentDashboard.dc.html

**Shows:** the Agent Dashboard route (BLEND 7.3, with the corrections below), More row selected.

**Tweaks:** `view` enum board | list | empty | agent (default board); `card` enum none | review (default none); `conflict` boolean (true); `messages` boolean (true): the group's messages strip shows; `picker` boolean (false): on `view=agent`, the model chip's list is open.

**Header** (route header): `dashboard` glyph, "Agent Dashboard", 12/16 `--vxs-text-3` "Every workspace, agent and review in one place"; right "3 running · 2 need you · 3 done" (numbers `--vxs-text`); Close.

**Controls row:** segmented Board | List; search 28 (max 420) "Search agents, tasks, models or activity"; filter chips Status ⌄, Group ⌄ (today's "Team": it lists coordinated runs and groups of agents that work together, and shows only when one exists; decision D6), Where ⌄ (today's "Runtime": This Mac, Cloud computer, GitHub Actions, Installed agent), Pull request ⌄ (Open, Merged, No pull request); Clear ghost 24. Summary 12/16 `--vxs-text-3`: "8 agents · 23 files touched · 1 file conflict" (BLEND's "1 team" dropped).

**Conflict banner** (`conflict`): BLEND 7.3 recipe: "Two agents are editing the same file" · mono "packages/app/src/components/menu.tsx · Swarm worker 2, Recheck keyboard focus across menu reads" · "Review one workspace before merging the other."

**Messages strip** (`messages`; today's "Team conversation", agent-dashboard.tsx 289-320): one outline card under the banner, radius 10, padding 10 14: "Menu keyboard pass" 13/18 weight 500 · "3 messages" 12/16 `--vxs-text-3` · right "Messages between agents" 12/16 `--vxs-text-3`; rows 12/16: "Swarm worker 2 → Recheck keyboard focus: I'm changing the tab order in menu.tsx; leave lines 40-90 to me."; "Recheck keyboard focus · replied: Understood, I'll only read popover.tsx until you're done."; "Coordinator → Swarm worker 2: Add a test for the new order before you hand back."

**Board** (3 columns, BLEND 7.3 card recipe; row 1 is role glyph, "where · agent" 11/14, role tag, elapsed). Each card is one button that opens its session, as today; there are no other card actions:
- Running 3: (1) "This Mac · Vector" · worker · 12m · "Recheck keyboard focus across menu reads" · orbit "Reading popover.tsx" · bar 60% · "4 files changed · Codium" … "Codium Auto". (2) "This Mac · Vector" · worker · 9m · "Swarm worker 2" · orbit "Editing menu.tsx" · "+142 −18 · Codium" … "Group: Menu keyboard pass". (3) "Cloud computer · Vector" · 4m · "Reproduce Windows packaging limit" · orbit "Running the packaging dry run" · "Codium".
- Needs you 2: (4) "This Mac · Vector" · 2m · "Fix Codium P8 CI" · diamond "Wants to run pnpm install --frozen-lockfile". (5) "This Mac · Vector" · 2h · "Give the packaging dry-run a Windows-sized limit" · x-ring "Checks failed · 3".
- Done 3: (6) "This Mac · Vector" · "Warn on review model evidence" · check-ring "Ready to review · +318 −32" · 6 px `--vxs-ready` "Pull request ready" · today's preview line 11/14 `--vxs-text-2` "Preview: localhost:4321". (7) "This Mac · Vector" · specialist tag "review" · "Review: Hands Windows fixes" · check-ring "1 finding". (8) "This Mac · Installed agent" · "Shorten Windows installer progress copy" · check-ring "Done · 3 files changed" (no Codium line: an installed agent runs on its own account).

**card=review:** on card 6, today's inline approval (connect/directory-review.tsx) under the card: "Approval required" / "Allow Vectorscope to review this workspace?" / 12/16 "Reviews send the diff to Vector Codium." / Not now ghost 24, Allow primary 24; after Allow, "Queued for Vectorscope" with an orbit (the boards' spelling, as on every other board).

**view=list:** table rows 44: status glyph · title · where · role · activity · changed · elapsed. **view=empty:** today's "No agents yet" / "Start an isolated workspace and its live status will appear here." / **New workspace** secondary 28 (opens the launcher, 3.3). With filters on and nothing matching: "No matching agents" / "Try clearing one or more filters."

**view=agent** (the owner's "looks about the same" proof): card 8 opened. The ordinary session view: the sidebar row selected; header row 1 shows the title, "vector", then a tag "Installed agent" (16 tall, radius 8, 1 px `--vxs-hairline`, 11/14 `--vxs-text-2`), branch chip, status "Ready", Tasks, Changes, Terminal, Panels, all as in Chat; transcript: user "Shorten the Windows installer's progress copy to one line per step."; reply "I'll shorten each step's copy and keep the step names."; edited-files card "Edited 3 files +12 −19"; Shell row `bun test installer` "passed · 22s"; composer chips: host, "vector" | model "Agent default ⌄" (the agent's own list). Mode, effort and speed hide when the agent has none; no Codium ring and no usage pill. **picker=true:** the model chip's menu (Models board recipe) lists only the agent's models: caption "This agent's models", "Agent default" (check), three skeleton rows, "Custom model ID…".

**Interactions:** segmented and card 8 set `view`; filter chips open checkbox menus; Allow and Not now on card 6 change `card`; the model chip toggles `picker`; Back (⌘[) returns to the board.

**Follow:** BLEND 7.3, 2.5; SCREENS 1.2, 1.4; code agents/agent-dashboard.tsx, agent-dashboard-model.ts, agent-badge.tsx, agent-runtime-copy.ts, external-agent-workspace.tsx, external-agent-transcript.tsx, external-agent-composer.tsx, external-runtime-models.ts, connect/directory-review.tsx.

### 3.3 Workflows.dc.html

**Shows:** Chat's session view under a drawer or dialog; the More row selected while the drawer is open.

**Tweaks:** `surface` enum drawer | launcher | workflow | race | merge (default drawer); `drawer` enum running | failed | empty (default running); `launcher` enum agent | together | run | installed (default agent); `workflow` enum list | form | sent (default form).

**Drawer** (BLEND 7.8, today's layout-new.tsx 5321-5580). Title "Coordinated runs" (today's "Multi-agent orchestration", renamed to match the More row; decision D5), "New coordinated run" accent pill, Close. Left list: "Agent workspaces": "Swarm worker 2 · +142 −18" (hover Review & merge), "Recheck keyboard focus across menu reads · +36 −9"; "Coordinated runs": "Menu keyboard pass" running 62% "Swarm worker 2: editing menu.tsx"; "Windows packaging limit" needs review 100% "Ready to merge"; "Settings search fix" failed 40% "2 tests failed in search.test.ts". Detail for Menu keyboard pass: "Running · 3 of 5 tasks · started 14m ago"; task cards: "Map every menu's keyboard path" (Explore, read-only) done "Found 9 menus"; "Fix focus order in menu.tsx" (worker · Swarm worker 2) running "Editing menu.tsx"; "Recheck keyboard focus across menu reads" (worker) running "Reading popover.tsx"; "Add focus tests" (Test) waiting "Starts when both fixes are done"; "Review the merged result" (Review) waiting. Footer: Stop run danger 28; spacer; Discard ghost 28; Merge result primary 28, disabled while running (tooltip "Merge is ready when every task is done"). `drawer=failed` selects Settings search fix (x-ring task "Run the search tests" · "2 tests failed in search.test.ts", Resume secondary, Discard, "Open workspace →"); `drawer=empty` shows BLEND's empty lines plus the accent pill.

**Launcher**, 560: today's live launcher (layout-new.tsx 4150-4960, `parallelComposerOpen`), in the dialog recipe. BLEND 7.7 copied the strings of an older full-window launcher that main now switches off (`<Show when={false && …}>`, line 5582); follow the live one. Opened by host `+` / project hover `+` › New workspace (today's button title) and ⇧⌘W.
- Title by mode: "New isolated agent" / "A separate Vector session works in its own git worktree or a managed copy of the repository."; or "Coordinate agents" / "Vector plans dependencies, assigns specialists, validates their work, and prepares one aggregate review." Segmented "One agent | Coordinated run" first.
- `agent` (One agent): "Alone or together", two outline cards: **Alone** (selected) "Its own git branch and files. Agents never see each other's edits and cannot message each other."; **Together** "One shared checkout. Agents see each other's edits and can message each other while working." Then "Choose a runtime": two rows 44, **Vector** (selected; model chip "Codium Auto ⌄") and **Host locally** ("Uses the runtime already installed on this computer" + Change ghost 20); switch "Compare ready runtimes" (off). "Agent mission": Workspace name "Fix focus order"; textarea placeholder "What should this agent build, fix, test, or investigate?". Footer Cancel ghost, **Launch agent**.
- `together`: Together selected; under it "Start a new group" (selected) or "Join Menu keyboard pass"; "Where the group works" segmented "One branch off HEAD | Your repository's files"; "Who can message whom" segmented "Everyone | Coordinator | Custom" with 12/16 "Every agent may message every other agent." Today's code says "team" and "teamwork" here; the board says "group" and "together" (D6).
- `run` (Coordinated run): "Run details": Run name (optional) "Menu keyboard pass"; textarea "Make every menu reachable and usable with the keyboard alone. Keep the visual design as it is."; chips "Codium Auto ⌄", Economy | Balanced | Quality, "Concurrent agents 4 ⌄"; 12/16 `--vxs-text-3` "Concurrent agents can multiply usage. Codium shows it as a share of your month."; footer Cancel, **Start coordinated run**.
- `installed` (Host locally chosen, today's dialog-host-locally.tsx in place): heading "Coding agents on this computer", search "Search coding agents", rows 48 with the `terminal` glyph, a skeleton name (widths 92 / 120 / 76) and 12/16 status: "Ready · your installed command line", "Sign in needed · opens in Vector's terminal", "Not installed"; the selected row adds "Model: Agent default ⌄"; footnote 12/16 `--vxs-text-3` "Runs on this computer under your own account for that agent. Codium isn't used."; "Check this computer again" ghost 24. With "Compare ready runtimes" on: 12/16 "Runs Vector and the installed agent, each in its own isolated workspace and on its own normal usage. Vector compares verified evidence and never merges automatically." (today's line); footer Cancel, **Launch agent**.

**Workflow** (BLEND 7.9), 560. `list`: "Saved workflows": Release checklist · release · this repository ("Bumps versions, runs the packaging dry run, drafts the notes."); Dependency sweep · deps · your config ("Checks outdated packages and opens one pull request per group."); Docs drift check · docs · your config, with a "Playbook" tag (installed from Vector Playbooks, so it lives in your config, as today); at 60%, Nightly docs check · docs · this repository with the issue `--vxs-failed` "Input 'branch' has no default". Footnote 12/16 `--vxs-text-3` "More in Settings › Agents › Vector Playbooks." No Install button here: Playbooks install where they do today. `form`: Release checklist, "version (required)" = "2.0.1"; after Check plan: "Up to 4 agents, 2 at once · at most 2–5% of your month" (the Codium band wording, never an amount); stages 1 "Bump versions in 6 packages · 1 agent", 2 "Run the packaging dry run on macOS and Windows · 2 agents", 3 "Draft the release notes from merged pull requests · 1 agent"; footer Back, **Run**. `sent`: "Vector is working" / "Its stages show in Background tasks. Vector tells you when it ends." / Show tasks.

**Race** (race/dialog.tsx), 560: "Race models" / today's line "Two labs implement the same request in separate worktrees. A third lab compares their reports. Review each lane's changes in Tasks before merging." Request "Make the Codium plan cards stack on phones without changing the desktop layout."; First lane "Claude Sonnet 5.5 ⌄"; Second lane "GPT-6.1 Sol High ⌄"; Judge from a third lab "Gemini 4 Argon ⌄"; 12/16 `--vxs-text-3` today's "Use your configured models. Existing model permissions, spend limits and workflow approvals apply."; footer Preview race secondary, **Run race** (disabled until a preview passes, as today).

**Merge** (parallel-diff-review.tsx), dialog 960: today's title "Selective review" with 12/16 "Swarm worker 2" under it / "Approve only the exact changes you trust."; files: menu.tsx +96 −12 (approved), popover.tsx +30 −4, menu.test.ts +16 −2; split diff with today's Before / After columns and a checkbox "Approve this change" per hunk (BLEND 5.7 diff skin); footer "2 of 3 files approved", Cancel, **Merge approved**.

**Interactions:** New coordinated run → launcher `run`; the One agent | Coordinated run segmented switches `agent` / `run`; Together → `together`; Host locally → `installed`; Review & merge → merge; run rows select; Check plan → plan; Run → sent; Preview race lists the lanes and judge.

**Follow:** BLEND 7.5, 7.7-7.9, 5.7; code layout-new.tsx 4150-4960 (launcher) and 5321-5580 (drawer), background-tasks/workflow-dialog.tsx, workflow-model.ts, race/dialog.tsx, parallel-diff-review.tsx, agents/dialog-host-locally.tsx, host-locally-model.ts, pages/layout-collaboration.ts.

### 3.4 Models.dc.html

**Shows:** Chat's done session; the model chip pressed and the picker open upward from it (menu recipe, 360 wide, max 520 tall, 8 px above the box).

**Tweaks:** `view` enum picker | search | training | manage | sent (default picker); `account` enum codium | free | keys (default codium); `local` boolean (false). (The installed agent's own list is AgentDashboard `view=agent, picker=true`, not drawn twice.)

**Picker, account=codium** (today's two section kinds: captions over Current and Recently used; collapsible headers with a count and a chevron for providers):
- Search field 36 "Search models" with a "⌘'" key chip.
- Current: Codium Auto (Vector chip glyph; 12/16 "Picks the model that passes this repository's checks"; check).
- Recently used: Claude Sonnet 5.5 (tag "Codium"), GPT-6.1 Sol High (tag "Codium"), coder-medium (tag "gpu-box").
- Vector Codium, open, meta "Codium Max · 64% left": Codium Auto first, then the Max models in catalog order and spelling (codium-catalog.ts): DeepSeek V4.1 Flash 1017, Claude Haiku 5.5, GPT-6 Luna, GPT-6.1 Sol High, Kimi K3.1 Pro, Gemini 4 Argon, Claude Sonnet 5.5, GPT-6.1 Sol Deep, each with muted context sizes as Settings-Models already shows them; the Long and Fast variants sit in a "Show 5 more" row; Claude Opus 5.5 and GPT-6.1 Sol Deepest at 60% with an "Ultra" tag (hover adds Upgrade ghost 20). No usage tokens, no prices.
- Collapsed headers: Free models inside of Vector `6`; Your API key `12`; Custom provider `3`; Vector Local `3` (gpu-box and this computer, as Settings-Models).
- Footer rows (hairline above): "Connect a provider…", "Manage models…".

**account=free** (signed in, no plan): a row "Vector Codium · not on a plan" + See plans ghost 20; Free models open first: "Auto (free)" ("Sends each request to a free model Vector picks"), three skeleton-name rows, two tagged "May train on your prompts" (today's label); under them 11/14 "A daily limit for each account." With the limit reached, a notice row "Today's free limit is used. Pick a model from another provider, or add your own key." (free-models-limit.tsx). **account=keys** (no Vector sign-in): no Codium or free sections; "Your API key" open with skeleton names; a row "Sign in to Vector to use free models." + Sign in ghost 20.

**local=true:** the host chip gets a 8 px lock badge (tooltip "This Mac · Vector Local: your network"); "Vector Local" opens first (coder-large and coder-medium on gpu-box, coder-small on this computer; embed-small is not listed because it can't chat); the cloud sections collapse into "Off in Vector Local (3)" at the end (today's group), rows "Vector Codium · sends code to Vector's cloud", "Free models inside of Vector · sends code off your network", "Your API key · sends code to its provider", each with Why ghost 20.

**view=search:** query "sonnet": every matching row with its section caption (Claude Sonnet 5.5 · Vector Codium; Claude Sonnet 5.5 · Your API key); all sections open. **view=training:** dialog 440: title "This free model may train on your prompts"; body today's FREE_MODEL_TRAINING_DISCLAIMER and FREE_MODEL_TRAINING_SCOPE (packages/core/src/free-model-choice.ts); model line "Auto (free)"; Don't send ghost 28, Accept and send primary 28; closing equals Don't send. **view=manage:** Manage models 560: "Choose which models show in the picker." search; groups per provider with a switch per model. **view=sent** (local on): popover from the lock badge, 320: "What Vector sent" + rows "10:41 · gpu-box · Allowed", "10:42 · registry.npmjs.org · Asked · Allowed once", "10:44 · a telemetry host · Blocked" + "Open the network log" (Settings › Vector Local).

**Interactions:** the chip toggles the picker; headers toggle sections; typing switches to search; picking a row sets the chip label (and a "May train" row with no acceptance opens training); Esc closes.

**Follow:** BLEND 4.4 (model chip, compaction), 2.5; code dialog-select-model.tsx, model-picker-state.ts, dialog-manage-models.tsx, dialog-free-model-training.tsx, free-models-limit.tsx, packages/core/src/free-model-choice.ts, api/_lib/codium-catalog.ts, features/local/local-model.ts, off-in-local.tsx, status-pill.tsx, egress-popover.tsx; Settings-Models (its gpu-box sample).

### 3.5 Codium.dc.html

**Shows:** Codium where it touches the app beyond Settings › Account (already drawn, including Change plan and the Monthly plans list, which is why this board draws no plans dialog). Session "Reproduce Windows packaging limit" under the Cloud computer host for watch, control, morning and jobs; Chat's session for alert and limit. The "needs you" hand-off is the Tasks board's `cloud=needs` and is not drawn again.

**Tweaks:** `view` enum watch | control | morning | jobs | alert | limit (default watch).

**view=watch** (new placement, decision D11: today Watch opens the live view in a window of its own): chat 600 | panel 655; strip chips Changes · Cloud computer (orbit while Vector drives); Panels menu gains a checked "Cloud computer" row only while this session runs there. Pane toolbar: `monitor` 14 "Cloud computer" · "Working · 4m" · "Standard"; spacer; Files ghost, Take over secondary, Stop ghost. Driving bar (BLEND 6.0) "Vector is using its cloud computer · Running the packaging dry run". The screen: a plain desktop frame with a terminal window showing `pnpm run package:dry -- --target win` and its last log lines, the ghost cursor "Vector". Under it 11/14 `--vxs-text-3` "3% of this month's cloud computer hours used". Chat: user "Reproduce the Windows packaging limit on a clean machine and tell me which step runs out of room."; reply "I'll move this to the cloud computer, run the packaging dry run there and watch the disk."; tool row `monitor` "Cloud computer · Started · Standard · 38s"; working line "4m · Codium · Using the cloud computer". Cloud bar above the composer (BLEND 4.6.9) with Watch active. Host chip `host-cloud` ("Cloud computer").
- **control:** bar and pane frame dashed; today's lines "You have control of the cloud computer" (CONTROL_LINE) / "You have control. Vector waits until you give it back." / Give back primary; real cursor, no ghost cursor. Control never returns on a timer.

**view=morning:** today's "Run on my cloud computer" dialog on its "Done by Morning" tab (hosted-composer.tsx 585-660), 520: title "Done by Morning" (the composer button that held the dialog is gone, so the tab's name is the title); 13/20 `--vxs-text-2` today's HOSTED_LINE, shortened to its first two sentences: "A computer Vector runs for you: close the laptop and Vector finishes the job. Watch it live and take over whenever you like." Fields: "What should Vector do?" ("Upgrade the site's framework on vectordev.ai and open a draft pull request."); "Success criteria, one per line (the report says whether each one was met)" ("The site builds", "Every page test passes", "The home page looks the same"); Size segmented Standard | Large (today's two sizes, hosted-requests.ts SIZES); Longest job "45 min ⌄"; "Aims to deliver by" "6:00 AM ⌄"; 12/16 `--vxs-text-2` today's ceiling line "The computer's time for this job uses at most 2–5% of your month. Its Codium requests count too."; link "Queued jobs and reports"; Cancel, **Queue it**. The sidebar's "Morning queue" row shows the queued job.

**view=jobs:** today's DialogHostedJobs, 560: "Done by Morning" / "Jobs your cloud computer runs while you are away, and their reports." Rows (outline card radius 10, padding 12 14, 8 apart): "Upgrade the site's framework on vectordev.ai" · "Queued · aims to deliver by 6:00" · Cancel ghost 24; "Update the docs site's dependencies" · "Reported · today 5:52" with lines "Met: The site builds", "Met: Every page test passes", "Not met: The home page looks the same" (x-ring `--vxs-failed`), "Recording" ghost 24, **Approve: open the pull request** secondary 24, "Return report here" ghost 24. Empty: "No jobs yet."

**view=alert:** toast (bottom right) "You've used 80% of this month's Codium usage" / "Check your plan in Settings › Usage."; ring at 20% in `--vxs-needs`. **view=limit:** transcript notice card: diamond "You've used this month's Codium" / "Codium Max renews Dec 1. Change plan to keep going now, or pick a model on your own key or a free model." / **Change plan** primary 28 (today's fix label), Choose another model secondary 28; ring "0%" in `--vxs-failed`.

**Interactions:** Take over → control; Give back → watch; Stop → "Stopped" on the tool row; Queued jobs and reports → jobs; Change plan names Settings › Account in its tooltip (the Settings-Account board, `plans=true`); Choose another model opens the model picker's list in place (Models board).

**Follow:** BLEND 4.6.9, 6.0, 3.3; SCREENS 4 (Cloud computer card); PLACES 3.2 (`/cloud`); code cloud/hosted/hosted-composer.tsx, hosted-model.ts (USING_LINE, CONTROL_LINE, DELIVER_LABEL, ceilingLine), computer-card*.ts(x), codium-error.tsx, codium-usage-alert.ts.

### 3.6 Brain.dc.html

**Shows:** Settings route › Memory (Settings-General's route shell, nav "Memory" selected) for the tabs; the session view for `tab=chat`.

**Tweaks:** `tab` enum skills | memory | insights | documents | backup | chat (default skills); `guard` boolean (false).

**Page:** title "Memory"; subtitle "What Vector remembers, the skills it learned and the defaults it tuned. Anything new waits for your review." Tabs: Memory · Skills · Workflow insights · Documents · Backup (today's seven tabs folded to five: About you becomes the "Your memory" scope of Memory; Research and Search model become sections of Documents; Backup gets its own tab; decision D9).

- **memory:** scope segmented "This repository | Your memory"; switch "Let Vector learn as it works" (on); filters In use 14 · Needs review 2 · Archived 5 · Everything; search "Search memory"; "Needs review": "Run bun typecheck from the package folder, not the root" (From what you typed · 2d; Edit, Reject, Approve) and "Windows tests need --timeout 30000" (From a failing check · 5d); "Pinned": "Keep the Changes panel layout as it is"; "Recently learned" rows; "Review memory for this repository" (Vectorscope's, review-memory-panel.tsx): "Use in reviews: off" switch, entries "Preference · Prefer early returns over nested ifs", "Check · Every new setting needs a test"; on the "Your memory" scope, today's "Your memory file" card (features/memory/local-memory-panel.tsx): the file's path in mono 11/16 `--vxs-text-3` (sample "MEMORY.md"; the build shows the engine's real path), Edit local memory ghost 24, Erase everything ghost 24 in `--vxs-diff-del`; footer row "Tidy and erase".
- **skills:** "How Vector learns skills" select "Review first ⌄" (Review first / Apply automatically after a second matching success / Off); "When a model may word a skill's draft" select "Only with Vector Local ⌄"; one privacy line. "Needs review" card: mono "learned-typecheck-app"; "Turned bun typecheck green in 2 sessions, last 3 days ago"; "Expires in 58 days"; plain-text procedure block ("1. cd packages/app  2. bun typecheck  3. If generated types fail, run bun run gen first"); check "bun typecheck"; Edit ghost, Reject ghost, **Approve** primary. "In use": "learned-windows-test-timeout · v2" with a weight bar at 70%, "9 loads · 8 passes · used 2d ago"; "learned-lockfile-install · v1" with a "fading" tag. "Archived and shared": "learned-release-notes · shared to the repository".
- **insights:** mode segmented Apply | Observe only | Off; switch "Explore cheaper settings"; tier cards Light, Standard, Thorough: Thorough "Your default: Max effort · 3 helpers · Codium Auto" vs "Learned: Balanced effort · solo · Codium Auto", reason "Passed as often in the last 20 runs, for less of your Codium."; arms table effort · split · model | runs | pass rate | checked | average cost, where Codium runs read "Codium"; Reset; fixed copy "Your own picks always win. Learned defaults only drop Thorough's extra effort, skip subagents or use a cheaper subagent model; spend caps are unchanged."
- **documents:** Add documents; switches "Read this repository's docs", "Keep copies of added files"; list "Codium tiers v3.pdf · 14 pages · read · 6 suggestions"; Brain helpers "Suggest records from documents", "Bootstrap this repository"; "Research": "What people ask about Codium · 12 sources" (Export, Forget); "Search model" select.
- **backup** (Brain Vault, settings-v2/memory-backup.tsx): "Back up your memory"; "Where backups go" segmented "Vector vault | Private GitHub repository"; switch "Back up every night while Vector is open" (on); "5% of your Brain Vault used" with a meter; "Versions and restore": "Tonight 2:00 · Restore", "Yesterday 2:00 · Restore", "Nov 18 2:00 · Restore"; "Recovery code": "Shown once when the vault was made." + Make a new recovery code secondary; Delete the vault ghost in `--vxs-diff-del`.
- **chat:** Chat's session after item 12: the learned chip "Learned 2 things" with its popover ("From what you typed: Use the words 'Evidence may be stale'." Approve, Reject) and "Drafted a skill for your review: learned-typecheck-app · Review"; the workflow chip "Learned default · Why" with its popover (reason, "Open Workflow insights", "Stop using learned defaults"); the prompt-source ask in the permission dock: "Permission required" / "Vector wants to edit a file that shapes its own instructions: .vector/agents/review.md. Vector asks every time for these files." / Deny, **Allow once** (no Allow always). In the composer box above the text, an attached file chip "Codium tiers v3.pdf" with today's "Remember" chip (off until turned on; remember-chips.tsx) and, for a long paste, "Remember this text"; never a second chip row under the box.
- **guard=true:** banner under the header, 36 tall, fill `--vxs-needs` at 8%: diamond "2 prompt files outside this repository changed since you last approved them. Vector won't load them until you do." + Review secondary 24; expanded: "~/.config/vector/agents/review.md · changed today", "~/.agents/skills/release/SKILL.md · new", Approve primary 24, Keep them off ghost 24.

**Interactions:** tabs set `tab`; Approve and Reject turn the card into a toast ("Approved. Vector will use it.", "Rejected and forgotten."); chip popovers toggle; Review expands the banner.

**Follow:** docs/vector/build/self-evolving-spec.md 5.6, 6.2, 8.1-8.3, 12; BLEND 7.2 recipes, 4.6.3; code settings-v2/memory.tsx, memory-model.ts, memory-skills*.ts(x), memory-workflow*.ts(x), memory-documents*.ts(x), memory-backup*.ts(x), memory-brain*.ts(x), features/memory/*, prompt-trust-banner.tsx, vectorscope/review-memory-panel.tsx.

### 3.7 Onboarding.dc.html

**Shows:** a first launch: the sidebar with no projects, the account row signed out, the empty state with one setup card above the composer.

**Tweaks:** `step` enum welcome | signin | connect | folder | clone | trust | ready | launch | error (default welcome).

- **launch:** the window's opaque stage with the 28 px Vector chip tile centred and 12/16 `--vxs-text-3` "Still starting…" (features/launch/launch-screen.html). **error:** "Vector didn't finish starting." / **Restart Vector** primary 28 (the route error page uses the same recipe with its own text, pages/error.tsx).
- **welcome:** sidebar: verbs; This Mac with 12/16 `--vxs-text-3` "No projects yet" and rows "Open a folder…", "Clone from GitHub…"; no Live, no Pinned; account row "Sign in to Vector". Stage: empty state (SIG 4.7) with "What should we build?"; composer chips "Choose a project ⌄" and "Choose a model ⌄" in `--vxs-accent-text`. Setup card (outline card radius 12, 560 wide): "Get set up" · "0 of 3". Rows 56: 1 "Connect a model" / "Use your Codium plan, free models, your own key or models you host." / **Sign in to Vector** primary pill 24, Use my own API key ghost 24, Models I host ghost 24. 2 "Open a project" / "Choose a folder on this Mac or clone one from GitHub." / Open a folder… secondary 24, Clone from GitHub… ghost 24. 3 "Try a safe first task" / "Vector reads the project and explains it without changing files." (disabled until 1 and 2 are done).
- **signin:** row 1 becomes an orbit + "Finish signing in in your browser, then return to Vector." + Cancel ghost 24; the account row reads "Finish signing in in your browser". Nothing is typed into Vector.
- **connect:** dialog 560 "Connect a model" (search "Search providers"): "From Vector": Vector Codium ("Coding models in your plan" + Sign in), Free models inside of Vector ("A daily limit; some may train on your prompts" + Sign in); "Popular providers": three skeleton-name rows with Connect; Show more providers; "Models you host": Vector Local ("Models on this Mac or your network" + Set up); "Custom provider": "Add a provider by its base URL." + Connect.
- **folder:** Open a folder 560: path field "~/code"; rows "vector · main", "vectordev.ai · main", "notes"; Cancel, **Open**.
- **clone:** "Open from GitHub" 560: "Connected as @you · Change"; search "Search your repositories or paste a link"; rows "you/vector", "you/vectordev.ai", "you/vector-hands" (Private tag); "Clone into ~/code · Change"; Cancel, **Clone**. Not connected yet: "Connect GitHub" with a device code "WDJB-MJHT" and Open GitHub (github-connect.tsx).
- **trust:** project "vector" chosen; banner above the composer "vector has its own Vector settings. Trust it to let them run." + Trust this project… secondary 24 + Not now ghost 24; dialog 480 "Decide what a repository may run": rows "2 MCP servers", "3 commands", "1 agent" with what each runs; Not now, **Trust**.
- **ready:** "vector" and "Codium Auto" chosen; setup card "2 of 3" with row 3 active: **Try it** fills the composer with "Look through this repository and explain how it is organised. Don't change any files." After the first reply, the walkthrough starts (Walkthrough board).

**Interactions:** each button moves to its step; Cancel returns to welcome; Open and Clone go to trust; Trust and Not now go to ready.

**Follow:** SIG 4.7-4.8; BLEND 4.6 (first-run card), 4.8, 7.5; PLACES 4; code onboarding/onboarding.tsx, onboarding-progress.ts, layout-new.tsx 3298-3380, prompt-input/free-model-start.tsx, free-models-card.tsx, dialog-connect-provider.tsx, dialog-select-provider.tsx, dialog-custom-provider.tsx, dialog-select-directory-v2.tsx, dialog-clone-github.tsx, github-connect.tsx, project-trust-prompt.tsx, settings-v2/project-trust.tsx, features/launch/*, pages/error.tsx, vector-account.ts.

### 3.8 SessionTools.dc.html

**Shows:** session views that no board draws yet, all on Chat's session "Warn on review model evidence". Deep research moved to its own board (3.9) because it needs a different session and project.

**Tweaks:** `view` enum context | editor | terminal | docks | docks2 (default editor); `overlay` enum none | find | status | share | fork | push | watch (default none).

- **context:** Context pane: ring "38% of context used"; rows as shares of the window (System and tools 9%, Memory 4%, Conversation 15%, Files read 7%, Tool output 3%), no token counts for Codium (codium-label-plan D-1); Compact now secondary 28.
- **editor:** the chrome switch on Editor; stage: a 240 side column with today's three tabs as icon buttons (Explorer, Search files in Code Editor, Problems; aria-labels as today) and the file tree (packages/app/src/features/pull-requests open), tabs ai-review.ts · pull-requests.tsx, code with line numbers and add/remove gutter marks on lines the agent changed; on menu.tsx's tab a 6 px `--vxs-needs` dot with today's tooltip "Agents editing isolated copies of this file"; a 360 agent column on the right with the same transcript items and composer chips, topped by today's "Live agent activity" line ("Editing ai-review.ts"); header row 1 shows the file path, a "Vector Tab" switch chip (today's completions toggle) and "Back to Vector Agent" ghost 24 (today's label).
- **terminal:** Chat's Terminal panel open with three tabs: "zsh" (yours), "dev server" with the `task` glyph (tooltip "Opened by an agent"), "tests · exited 0" with the glyph; the dev server tab active: "vector-web ready on :4321".
- **docks:** running; above the composer: question dock ("Vector has a question" / "Which branch should the fix go on?" / radio rows "scope-evidence (current)", "A new branch from main" / Answer primary 24, "Or reply instead"); follow-up queue (rows "Also check the Settings search box", "Run the Windows tests after", each Steer ghost + remove); delegation pill "Looks like 3 independent tasks. Delegate to parallel workspaces? · Delegate · Not now".
- **docks2:** done; revert dock "Reverted 2 files · Redo"; interrupted dock "Vector stopped when this Mac went to sleep. · Resume"; model recommendation pill "Suggested for bug fixes: Codium Auto · Balanced effort · Use · Not now" (a Codium name: real provider model names stay in the picker and Race); transcript row "Loop paused · Continue with a new step limit" (budget-stop-copy.ts; own-key runs may show their dollar cap, Codium runs never do).
- **overlay=find:** bar at the transcript's top right: field "evidence", previous, next, close; the current match highlighted. No "2 of 5" count: today's search uses the window's own find, which gives none; a miss shows today's toast "No chat matches". **status:** popover 300 from the status chip: segmented Servers | MCP | LSP (MCP selected first, as today under the new layout); MCP rows "filesystem · Connected", "docs · Needs sign-in"; Servers "This Mac · Default · Ready", "build-box · Offline"; Manage servers ghost. **watch:** today's Hands "Watch" dialog (computer-watch.tsx), large dialog titled "Vector Hands": the Tasks Hands card's status and controls on top, then the run's steps, each with its screenshot thumbnail and click marker ("Opened Notes", "Typed in “Codium bugs”"), as the transcript's run card shows them. **share:** "Share session publicly" 520: "Anyone with the link can read this copy."; "Included transcript" segmented Whole session | Up to this message; "Public copy expiry" "7 days ⌄"; Create public copy primary; after creating, the link field with Copy and "Remove public copy". **fork:** "Fork from a message" 520: user messages with times; Fork primary. **push:** "Commit and push this repository to GitHub" 520: commit message "Warn on stale review evidence"; branch "scope-evidence"; "Command log" collapsed; Push primary; up-to-date state "Repository is up to date". When the typed message repeats something Vector remembers about you, today's check row appears above the buttons (commit-check.ts): diamond "Your message repeats what Vector knows about you in 1 sentence." + the sentence quoted + **Commit as is** secondary 28 (nothing is changed for you).

**Follow:** BLEND 4.6, 4.7, 4.9, 6.0; PLACES 1.1, 1.3; code session-context-tab.tsx, session-context-*.ts, session-side-panel.tsx (CodespaceWorkbench), file-tree-v2.tsx, monaco-code-editor.tsx, session-sortable-terminal-tab.tsx, context/terminal.tsx, pages/session/composer/*-dock.tsx, followup/followup-queue.tsx, budget-stop*.ts(x), status-popover*.tsx, dialog-share-session.tsx, dialog-fork.tsx, session-github-push.tsx, commit-check.ts, background-tasks/computer-watch.tsx, layout-new.tsx 3622-3660.

### 3.9 Research.dc.html

**Shows:** deep research on the vectordev.ai session "Draft the Codium FAQ" (add the vectordev.ai project and this session to the sidebar data; selected).

**Tweaks:** `view` enum plan | running | report (default running).

- **plan:** Speed chip "Deep research"; the plan card in the question-dock slot (plan-card.tsx): Question "What do people ask before choosing a Codium plan?"; sub-questions "Which limits confuse people most?", "What do they compare plans on?", "What do they ask after buying?"; "Sites to prefer: vectordev.ai, github.com" + field "Add a site, such as arxiv.org"; Time window "Since 2025"; "Deep: up to 4 researchers and a judge"; **Start research** primary 28, "Reply to the plan" ghost 28.
- **running:** chat 600 | panel 655, strip Artifacts · Sources (the Panels menu gains "Sources" after Context, PLACES 1.1); pane toolbar "Research run · 3 researchers" + Stop researcher ghost 24; top 360: "Research browser" showing a plain forum page (orbit chip while it loads, "Waiting for the page…"); below "Sources 12": rows with the `globe` glyph, title, domain, "read · 3 notes". Chat: running research rows; working line "6m · Codium · Researching".
- **report:** report card in the transcript ("Research report · What people ask about Codium · 12 sources · Kept in brain"; Open, Export, Forget) and the Artifacts pane open on the report: headings, paragraphs with [1]-style citations, a sources list.

**Interactions:** Start research → running; Stop researcher stops one lane; the report card's Open → report.

**Follow:** BLEND 4.6, 6.0; PLACES 1.1, 1.3; code research/plan-card.tsx, report-card.tsx, sources-tab.tsx, source-viewer.tsx, research-model.ts.

### 3.10 Settings-More.dc.html

**Shows:** the Settings route shell from Settings-General (route variant only), laid out at 1600, with the full nav: the branch-only rows shown (Roadmap vote, Remote, Production, Vector Hands) and a new "GitHub" row first under Agents & environment (today's registry order).

**Tweaks:** `page` enum hands | local | github | playbooks | remote | production | env | trust | spend | keys | notify | a11y | roadmap | updates (default hands; ids as Settings-General's NAVDEF, plus `github` and `playbooks`); `dialog` enum none | hands-setup | local-setup | local-allow | github-run | pair | add-server (default none).

Each page: BLEND 7.2 sections and rows, today's titles.
- **hands:** "Vector Hands" / "Let Vector see and use apps on this computer when you ask with /computer." Use: status "Ready" + switch on. Permissions: Screen Recording · Allowed; Accessibility · Allowed; Open System Settings ghost. While it works: segmented "Take the screen | Alongside me"; "Esc stops it". Always allowed apps: Notes, Calendar (Remove). Never used (fixed text): terminals, Vector itself, password managers, security settings. Screenshots: "Keep for 7 days ⌄", Erase screenshots. `dialog=hands-setup`: HANDS step 2, 480 "Allow two macOS permissions" with both rows, Open System Settings each, Check again, Done.
- **local:** "Vector Local" / "Keep code on your network: use models you host and block requests that would leave it." Switch on + "Local · your network". Models you host (Settings-Models' sample): gpu-box · 3 models · Ready; this computer · coder-small · Ready; Add server. Roles: Main session coder-medium; Subagents coder-medium; Reviews "Same as the session's model". Web access "Ask each time ⌄". "What Vector sent": table Time · Where · Session · Result. Allowed exceptions with reasons. `local-setup`: the wizard "Set up Vector Local" (Find servers, Roles, Web access). `local-allow`: "This change would loosen Vector Local. Apply it?" + "Say why Vector may use it." field.
- **github:** "GitHub" / "Run Vector in your repositories' GitHub Actions and answer @vector there." GitHub connection: "Connected as @you" + Change ghost 24. Repository binding (today's setup card, github-agents/setup-card.tsx): "vector · Bound repository · Codium (your plan, no key)" with 12/16 today's warning "Anyone with write access to a bound repository can start runs that use your plan."; Recent run "Fix the lint error · PR #2188 · Done · yesterday". GitHub schedules: "Nightly dependency check · 2:00 · vector" + switch. Brain proposals: "3 proposals returned from runs" + Preview secondary. `github-run`: "Run in GitHub" 520: task field, key segmented "Codium (your plan, no key) | Your own key", "Brain preview: 4 approved skills, 12 memory entries go with the run", warning "This repository is public: its Actions logs are public.", **Run in GitHub**.
- **playbooks:** Settings › Agents (nav "Agents" selected) scrolled to its Workflows section, which Settings-General's agents page draws without today's Vector Playbooks list (settings-v2/playbooks.tsx inside subagents.tsx): row "Vector Playbooks" / "Install a checked workflow in your personal configuration. Review its plan before running it with /workflow." + Refresh ghost 24; boxed list rows 48: "Flaky test hunt · Version 2" + **Install** secondary 24; "Docs drift check · Version 1" + "Installed" tag; "Dependency sweep · Version 3" + "Replace personal file" ghost 24 (today's label when your own file has that name). Empty: "No Playbooks are listed for this account yet."
- **remote:** today's remote.tsx in the blend finish: "Remote" (eyebrow "Vector Codium"). "On this computer": switch "Vector Remote" / "While it is on and a phone is paired, this computer keeps one encrypted connection to Vector's relay." "Pair a phone" / "Pairing needs this computer and the phone side by side." + Pair a phone secondary 28. "Paired phones": "iPhone · paired Nov 12" + Forget ghost 24; "Disconnect all phones" ghost 24. `pair`: QR (neutral square pattern) with aria-label "Pairing code for Vector Remote"; steps "Sign in with the same Vector account, choose Devices, then Pair a computer." and "Scan this code, then check that both screens show the same six digits."; "Pairing check code" "482 913".
- **production:** "Production" / "Watch your live site and catch a bad release early." On Call URLs: vectordev.ai/pricing · every 5 min · Healthy; vectordev.ai · Healthy; Add URL. Release Guard: "Production · c41e2a9 · Healthy · Undo here". Ship Desk: card "Settings search misses Default models · PR #2204 · Approve and merge". Domains: "Domain to verify".
- **env:** servers list This Mac · Default · Ready; build-box · SSH · Offline; WSL · Ubuntu; Add server; environment variables. `add-server`: Name, Address, "Connect over SSH", Cancel, Add.
- **trust:** "Repository trust" / "Decide what a repository may run." vector · Trusted · "Runs 2 MCP servers and 3 commands" · Review; vectordev.ai · Not trusted · Trust…; switch "Ask again when its settings change".
- **spend:** "Spend limits" / "Caps for models on your own keys. Codium is part of your plan and shows as Codium." Per run, Per day selects; Models on servers you host; Recent runs (own-key rows show their spend; Codium rows read "Codium").
- **keys:** grouped shortcuts with key chips: New session ⌘N; Search ⌘K; Files ⌘P; Settings ⌘,; Toggle sidebar ⌘B; Agent | Editor ⌘⇧E; Changes ⇧⌘R; Browser ⌥⌘2; Plan ⌥⌘3; Artifacts ⌥⌘4; iOS Simulator ⌥⌘5; Show or hide side panel ⌥⌘0; Background tasks ⇧⌘B; Terminal ⌃\`; New workspace ⇧⌘W.
- **notify:** today's notifications.tsx: "Alerts". "On this computer" / "Notifications and sounds stay on this computer.": Enable notifications, Error notifications, Sound effects (switches). "Phone alerts" / "Alerts show a short title, such as the session's name, sealed so only your paired phones can read it.": An agent finished, An agent needs you, Run Guard, Codium usage ("When 80% of this month's Codium usage is used."), each a switch; Quiet hours with From and Until.
- **a11y:** today's rows: Readable by default, UI scaling, High contrast mode, Reduced motion, Visible focus indicators, Larger click targets.
- **roadmap:** "Roadmap vote" / "This quarter's ballot": features with Vote buttons; Latest results; Nominate a feature.
- **updates:** "Updates & about": "Vector 2.0.0 · up to date" + Check for updates; Vector software license; Third-party licenses.

**Follow:** SCREENS 3.0-3.1; BLEND 7.2; PLACES 3.3 (Hands copy); code settings-v2/settings-registry.ts, dialog-settings-v2.tsx, computer.tsx, computer-model.ts, features/computer/input-setup.tsx, local.tsx, features/local/*, github-agents.tsx, features/github-agents/*, playbooks.tsx, subagents.tsx, remote.tsx, features/cloud/ops/ops-settings.tsx, servers.tsx, components/server/*, wsl/*, project-trust.tsx, spend-limits.tsx, settings-keybinds.tsx, notifications.tsx, general.tsx (accessibility), roadmap.tsx, about.tsx.

---

## 4. Shared parts every new board copies

Source: `docs/vector/design/signature/canvas/Simulator.dc.html` on `origin/main` (1253 lines; the reviewed latest board). Copy these blocks verbatim, then change only what each board lists.

### 4.1 Blocks and their lines

| Block | Lines | What to change |
|---|---|---|
| Head: doctype, charset, `<title>`, `<script src="./support.js"></script>` | 1-8 | the `<title>` only; keep the support.js line exactly |
| `<helmet>` styles (hover, focus rings, keyframes, chip compaction `.vxs-cc`, `.vxs-um`, scrollbars) | 9-61 | add rules a board needs; remove nothing |
| Wallpaper, window (max 1520, radius 12, shadow), traffic lights | 62-74 | none |
| Sidebar `<nav>`: chrome row 77-86; verbs 88-116 (On-call fourth, More sixth); Live 118-154; scroller 156-244 (Pinned, host groups, project and session rows, connectors, Show N more); account row 246-253; Help menu 254-266 | 75-267 | wire More as Chat line 132 does (`onClick="{{more.toggle}}"`, `aria-haspopup="menu"`, `aria-expanded="{{more.expanded}}"`, `background: {{more.bg}}`) and add section 1's menu after the verbs (Chat lines 137-152, plus the glyph slot and meta) |
| `<main>` and header row 1: title, project, branch chip, status chip, Tasks, Changes, Terminal, Panels button and Panels menu | 269-329 | `head.title`, status, the checked pane in `pm.rows`; add "Sources" after Context only after a research run, "Cloud computer" only on Codium watch |
| Conversation column and header row 2: usage pill "Codium", context ring, "…" | 333-347 | none (hide the usage pill for an installed agent) |
| Docks: working line, permission dock | 431-452 | per board |
| Composer box and the one-row chips (host glyph, project, model, mode, effort, speed, Codium ring; `flex-wrap: nowrap`, compaction classes) | 454-525 | chip values only; never a second row |
| Component script: data-props | 839 | the board's own tweaks plus `$preview` 1600 x 1000 |
| Helpers `rgb`, `rgba`; tweak-reset pattern `cur()`/`put()` | 841-867 | rename the keys for the board's tweaks |
| Tokens `t`, `activeFill`, `activeBorder` | 881-901 | none |
| Wallpaper `wall` | 903-908 | none |
| Sidebar data: status words, `S` rows, `mkRow`, `grpOpen`, `mkGroup`, `hosts` | 921-997 | the selected session id (4.2); add only the rows a board needs (the vectordev.ai project and session on Research; build-box on More `menu=hosts`); never rename an existing row |
| Live strip: `defs`, `liveItems`, `live` | 999-1019 | Live items per board |
| Header, Panels button `pb`, Panels menu `pm`, `help` | 1021-1058 | as the header row above |
| Composer `c` | 1091-1105 | chip values |

### 4.2 Per-board sidebar state

| Board | Selected | More row | Notes |
|---|---|---|---|
| More | "Warn on review model evidence" (More route: More row) | pressed when the menu is open; selected on `open=deploy` | build-box host only on `menu=hosts` |
| AgentDashboard | none; More row selected | selected | session row selected on `view=agent` |
| Workflows | "Warn on review model evidence" | selected while the drawer is open | |
| Models | "Warn on review model evidence" | | |
| Codium | "Reproduce Windows packaging limit" (Cloud computer host) or Chat's session | | |
| Brain | Settings gear selected (SCREENS 1.6); Chat's session on `tab=chat` | | |
| Onboarding | none | | empty host, signed-out account row |
| SessionTools | "Warn on review model evidence" | | |
| Research | "Draft the Codium FAQ" (vectordev.ai project) | | |
| Settings-More | Settings gear selected | | |

### 4.3 Recipes reused (no new tokens)

Tokens and type BLEND 2.2-2.3; icons BLEND 2.4 (today's shapes at the blend size and stroke), SCREENS 1.5, PLACES 5.3, plus `dashboard` and `runs` (today's sidebar glyphs, section 1) and `deploy` (the one new glyph); component recipes BLEND 2.5 (icon button, blend chip, primary pill, accent pill, secondary, ghost, danger, tint, menu, tooltip, outline card, switch, segmented, text field); dialog and scrim BLEND 7.5 / SCREENS 1.7; route header SCREENS 1.2; status words SCREENS 1.4; 24 px hit areas SCREENS 1.8; pane body PLACES 1.1; driving bars BLEND 6.0.

---

## 5. How Fable, Opus and Sonnet split the build

The boards are drawn (that was the earlier lane plan). This is the plan for building the app from them. The whole redesign sits behind the `shell.signature` flag, with tokens in the `--vxs-*` namespace (SIG). Every screen is built to match its board 1:1 for every value of every tweak, except the More menu text on the approved boards (D13).

**Rule for every lane:** one writer per file. The frame lane creates the slots (the route list, the Panels list, the More rows, the command list), so the later lanes add files and register them instead of editing shared ones. When a lane must touch a shared file, it asks the frame lane's owner first.

**Phase A, the frame (one lane; everyone else waits): Fable.**
- Tokens, type and icons (BLEND 2.2-2.4), and the component recipes (BLEND 2.5) as shared components.
- The window: sidebar (verbs with On-call fourth, Live strip, Pinned, host groups, account row, Help menu, the More menu from section 1), header rows 1 and 2 (today's buttons, smaller, plus the Panels button), the composer with one row of chips and its compaction order.
- The empty state, and the session view with the side panel (Changes as today).
- Boards: Chat, Simulator (the reference for shared parts, section 4.1), More (menus only).

**Phase B, the screens (three lanes at once, after A is merged):**
- **Opus**, the screens with the most state: Agent Dashboard, Workflows (launcher, Coordinated runs drawer, saved workflows, Race, Selective review), the model picker (Models), Vectorscope (Home, Review), Tasks.
- **Sonnet**, the screens built on fixed recipes: every Settings page (Settings-General, Settings-Models, Settings-Account, Settings-More), Memory (Brain), First run (Onboarding), Search, Connected tools (Connections), Automations.
- **Fable**, the session and the panels: SessionTools (editor, agent terminals, context, docks, overlays), Browser A, B and C, Codium (watch, control, Done by Morning, limits), Research, and the More routes (Deploy, Getting started).

**Phase C, the new features (three lanes at once):**
- **Opus:** On-call, which ties into @vector and Vector everywhere (Oncall board, PLACES 2).
- **Fable:** the Plan, Artifacts and iOS Simulator panes (PLACES 1).
- **Sonnet:** computer use and the rest as commands (Commands board, PLACES 3) and the beginner walkthrough (Walkthrough board, PLACES 4).

**Phase D, the finishing pass:** Fable checks every screen against its board, tweak by tweak, plus copy, contrast, the one-row chips and the "looks about the same" rule (an installed agent's session uses the same window, AgentDashboard `view=agent`). Opus reviews the code. Sonnet fixes what they find in the Settings and recipe screens.

**Decisions:** before building a screen, check section 6 (D1-D13) and the open decisions in BLEND 10, SCREENS 10 and PLACES 7 for anything it depends on, and ask the owner with a recommendation.

## 6. Owner decisions this map raises

- **D1** Keep today's Vector Cloud console in More, renamed "Deploy" (it is the deploy console, not the cloud computer). This reverses SIG's "only until the Cloud computer host exists". Recommended.
- **D2** Memory is reached through Settings › Memory, the learned chip's Review link and ⌘K, not a More row (recommended; today has no sidebar door either). The alternative is a More row with a review count.
- **D3** Terminal and Code editor leave More (header Terminal button; Agent | Editor switch). Recommended.
- **D4** The Vector Remote phone app gets its own canvas later; this one draws only desktop pairing.
- **D5** The drawer title "Coordinated runs" replaces "Multi-agent orchestration".
- **D6** No "team" in visible copy: the Agent Dashboard filter "Team" becomes "Group", "Team conversation" becomes "Messages between agents", the launcher's "teamwork" and "New team" become "Together" and "Start a new group", and "1 team" leaves the summary. The features stay; only the words change.
- **D7** Prices: plan prices appear only where they are bought, on Settings-Account's Monthly plans list (approved, and where Change plan already leads). Every other surface shows Codium as percentages and no prices. The separate plans dialog is dropped. Recommended.
- **D8** The shared-server presence chip stays as today and out of the boards.
- **D9** Memory's seven tabs become five (About you into Memory's scope; Research and Search model into Documents; Backup added).
- **D10** The canvas `title` note still names two other products (BLEND 8.1 asked for "Vector Signature: one calm sidebar").
- **D11** The cloud computer's live view opens as a "Cloud computer" pane beside the chat (new; today it opens a window of its own, and PLACES 1.1's Panels list has no such row). The alternative keeps today's separate window.
- **D12** Help › Docs opens the Help drawer (help assistant, documentation, Free models card) instead of the website, which its Documentation tab still links to. Today the drawer has no desktop door.
- **D13** "Build 1:1" covers every approved board except its More menu text, which becomes section 1's list on all of them.

## 7. Artboard rules and checks before hand-over

- Keep `<script src="./support.js"></script>` exactly; `<x-dc>` root with `<helmet>`; one `<script type="text/x-dc" data-dc-script data-props='…'>` with `class Component extends DCLogic`.
- `<sc-if>` and `<sc-for>` carry `hint-*` attributes. Every `{{hole}}` is a plain dotted lookup into `renderVals()`, never an expression; inside `<sc-for>` only the loop item or top-level names, never a parent loop's item.
- All UI is markup: no `innerHTML`, `appendChild`, window globals or global key handlers. Tags closed, attributes quoted. Inline stroke SVG icons, never emoji. Real `<button>`, `<a>` and `<input>`, with `aria-label` on icon-only buttons.
- Text contrast 4.5:1 and non-text 3:1. `data-props` escapes only `&amp;`, `&#39;` and `\"`. `$preview` is 1600 x 1000.
- Copy: short plain English, sentence case, realistic sample content, no lorem ipsum, no emails, never the name of the project Vector was forked from, no other AI coding product names, Codium as percentages.
- Checks allowed: parse each component script, and run `renderVals()` against a stub `DCLogic` for every value of every tweak. Never render, screenshot or open a board in a browser. Delete scratch files afterwards.

---

## Review notes (2026-11-20)

Checked against the owner's 2026-11-20 direction, SIG, BLEND, SCREENS, PLACES, the approved boards on `origin/main` (`f3d7ac742`) and `packages/app/src` on `origin/main` (read only, with `git show`). Every change below is already applied above.

**More menu (section 1)**
1. **Shorter.** It had nine rows, as many as SIG's first list. Now it has seven at most, and four when nothing conditional applies. "Run a workflow…" is gone: BLEND 7.9 already gives that dialog its doors (`/workflow`, ⌘K), and Playbooks install from Settings › Agents today. "Memory" is gone too: today's app has no sidebar door for it, the self-evolving spec sends review through the learned chip, and Settings › Memory already exists. D2 now recommends Settings only.
2. **Metas.** The Agent Dashboard meta ("◆ 2") is dropped: today's row has none, and the Live strip already shows what needs you. The Coordinated runs meta now follows today's rule ("2 running", otherwise the total).
3. **Glyphs.** `dashboard` and `runs` were new drawings, which breaks BLEND 2.4 ("today's path, drawn at the blend size and stroke"). They now use today's sidebar paths. Only `deploy` is new, because today's Home button has no glyph.
4. **Plugin rule.** "Plugins can never add rows (SIG 4.2 B)" misquoted SIG, which only forbids plugin verbs. It is now stated as a new rule.
5. **D1.** It now says plainly that keeping Deploy reverses SIG's "only until the Cloud computer host exists" and the PLACES review note that relied on it.
6. **Owner's question.** Added the direct answer to "what will be in there?". Also added what "build 1:1" means for the boards that draw SIG's list as text (D13; "3/7" becomes "2/3" because today's checklist has three steps).

**Screens the map missed or got wrong (section 2)**
7. **Agent Dashboard.** Added the messages agents in one group send each other (today's "Team conversation"), the preview link on cards, and the "No matching agents" state.
8. **Launcher.** The live launcher (layout-new.tsx 4150-4960) is: One agent | Coordinated run, Alone or together (a shared checkout where agents message each other), who may message whom, runtime choice and Compare ready runtimes. BLEND 7.7 and the map copied the strings of a full-window launcher that main switches off (`when={false && …}`, line 5582). The Workflows launcher is rewritten to match the live one (`launcher` agent | together | run | installed).
9. **Hands Watch.** The Hands "Watch" dialog (computer-watch.tsx) was mislabelled as the cloud computer's live view. It is now SessionTools `overlay=watch`. The real live view is `hosted.liveView`, which opens a window of its own today, so drawing it as a pane is new (D11).
10. **Done by Morning.** Added the jobs-and-reports list (DialogHostedJobs) as Codium `view=jobs`. Listed the cloud bar's kept-files line.
11. **Vectorscope.** Its "GitHub workflow & runs" panel now has one home, Settings › GitHub.
12. **Memory surfaces.** Composer attachments and the Remember chips go to Brain `tab=chat`. The commit-message memory check goes to SessionTools `push`. "Your memory file" goes to Brain's memory tab.
13. **Smaller items.** The workspace selector (Run in Local / New workspace) goes to the empty-state branch chip (BLEND 4.4). Also listed, each with where it lives or why it is not drawn: branch picker, archived sessions, inline rename, dictation state, connected-tool task rows, Windows and macOS native menus, OS notifications.
14. **Playbooks.** Vector Playbooks are drawn where they live today, Settings › Agents (Settings-More `page=playbooks`), not as an Install button inside the run dialog. Installed ones show in that dialog with a "Playbook" tag.
15. **Entry points.** Getting started opens by itself at first launch, and its sidebar row exists only in the legacy nav. Help › Changelog is a website link. The release-notes dialog shows once after an update, so the menu value `changelog` is now `notes`. Help › Docs opening the drawer is a change from today, recorded as D12.

**Redundant or overloaded boards**
16. **Codium.** `view=plans` repeated Settings-Account's approved Change plan and Monthly plans list and contradicted its prices, so it is dropped (D7 resolved: prices only where plans are bought). `view=needs` repeated Tasks `cloud=needs`, so it is dropped too.
17. **Installed agent.** Models `view=agent` and AgentDashboard `view=agent` drew the same installed-agent session. The agent's own picker is now AgentDashboard `picker=true`.
18. **SessionTools.** It held 8 views and 6 overlays across two sessions. Deep research (plan, running, report) moves to a new Research board with its own session. That makes ten boards; the canvas rows, row titles, notes and lanes are updated, and Settings-More moves to a fourth row at y 15620.
19. **Dashboard buttons.** The hover Steer / Stop / Review buttons and `card=steer` were controls that today's cards do not have (each card is one Open button). They are removed for "fewer controls".

**Contradictions with the owner's rules, the specs or the approved boards**
20. **No team features.** Renaming "Team" to "Run" was inaccurate, because that filter lists both coordinated runs and agent groups. It is now "Group", and every "team" word in the launcher and dashboard becomes "group" or "together" (D6). The features stay.
21. **Vector Local samples.** build-box, coder-32b and coder-7b contradicted Settings-Models (gpu-box; coder-large, coder-medium, coder-small). Models, Settings-More and the "What Vector sent" popover now match Settings-Models. build-box remains only as a paired remote host.
22. **Session titles.** "Fix focus order in menu.tsx" named a session that the copied sidebar calls "Swarm worker 2". The dashboard, drawer, conflict banner and merge dialog now use the sidebar's title.
23. **Model names.** The docks2 recommendation pill named a real model outside a picker; it now says "Codium Auto". Codium model names now follow codium-catalog.ts exactly (for example "DeepSeek V4.1 Flash 1017"), and the five Long and Fast variants sit behind "Show 5 more".
24. **Codium copy against today's code.** Control never returns "in 12 minutes"; today's line is "Vector waits until you give it back". The morning estimate uses today's band line ("at most 2–5% of your month"), not "up to 4%". Sizes are Standard | Large only. The workflow ceiling uses the same band wording instead of "· Codium".
25. **Find in chat.** It showed "2 of 5", a count the window's find cannot give. Removed.
26. **Paraphrased copy.** These now use today's strings: the Race description and footnote, the "Selective review" title, Edit repository ("Workspace startup script", 480 wide, today's project menu rows), Deploy's section labels and "Fix this deploy", the Remote and Notifications pages (the invented "Production alerts" row is removed), and the Help drawer subtitle.

**Other fixes**
27. **support.js.** No copy exists in the repository or the scratchpad. Builders keep the script line and never write the file.
28. **Canvas.** Main and Sidebar get "(superseded by the blend boards)" titles in canvas.json, without touching their files. Fable's finishing pass pointed at section 6 (decisions); it now points at section 7 (checks).
29. **Line references.** Corrected: launcher 4150-4960, drawer 5321-5580, find in chat 3622-3660, Coordinated runs rule 559.

**Not changed, and why**
- MCP and Plugins stay two rows (SCREENS decision 16).
- Deploy stays in More: today's always-visible Home button needs a home, and no verb fits.
- Connected tools stays behind its flag.
- Settings-More keeps 14 pages on one board, because every page uses one recipe and one route shell.
- View options keeps SIG's rows (approved spec), though it is now the longest menu left.

**Final board list (ten new boards; the 20 approved blend and latest-round boards are built 1:1 apart from their More menu text; Main and Sidebar are superseded)**

| Board | Tweaks | Lane |
|---|---|---|
| More.dc.html | open more \| getting \| deploy; menu none \| hostadd \| hosts \| view \| project \| edit \| row \| help \| feedback \| notes \| update; runs, connect, setup | Fable |
| AgentDashboard.dc.html | view board \| list \| empty \| agent; card none \| review; conflict; messages; picker | Opus |
| Workflows.dc.html | surface drawer \| launcher \| workflow \| race \| merge; drawer running \| failed \| empty; launcher agent \| together \| run \| installed; workflow list \| form \| sent | Opus |
| Models.dc.html | view picker \| search \| training \| manage \| sent; account codium \| free \| keys; local | Opus |
| Codium.dc.html | view watch \| control \| morning \| jobs \| alert \| limit | Fable |
| Brain.dc.html | tab skills \| memory \| insights \| documents \| backup \| chat; guard | Sonnet |
| Onboarding.dc.html | step welcome \| signin \| connect \| folder \| clone \| trust \| ready \| launch \| error | Sonnet |
| SessionTools.dc.html | view context \| editor \| terminal \| docks \| docks2; overlay none \| find \| status \| share \| fork \| push \| watch | Fable |
| Research.dc.html | view plan \| running \| report | Sonnet |
| Settings-More.dc.html | page hands \| local \| github \| playbooks \| remote \| production \| env \| trust \| spend \| keys \| notify \| a11y \| roadmap \| updates; dialog none \| hands-setup \| local-setup \| local-allow \| github-run \| pair \| add-server | Sonnet |

---

## 8. Where the drawn boards depart from this spec

The board wins unless the owner says otherwise. Most departures follow today's code, where the spec would have promised behaviour or wording the app doesn't have.

**Settled on the board (build what the board shows)**
- **More:** the update confirmation keeps today's wording ("3 agents in the workspace are still running and will stop.", Later / Restart now). Report a bug has no "Include diagnostics" box and no email field. Deploy's tile reads "Healthy releases 1 of 3", to match its list. The footer Update button is always visible, so "You · Codium Max" truncates with a tooltip.
- **Agent Dashboard:** Clear shows only once a search or filter is on. The empty view hides filters and counts. Close and Esc are not wired on the board (Esc needs a global key handler, which boards can't have).
- **Workflows:** the sent state is today's toast ("Workflow started: …", Show tasks). The More row reads "1 running", worked out from the drawer's own runs (the other boards say "2 running", from their own data).
- **Models:** Ultra rows use the secondary text colour plus an "Ultra" tag, not 60% opacity (contrast). The header usage pill changes with the account ("Codium", "free · 58.7k", or own-key spend). The effort chip hides for local and free models. An extra `limit` tweak shows the free models' daily limit notice.
- **Codium:** the longest job defaults to "1 hour" and the size reads "Large (counts double)" (today's choices). Take over and Stop sit in the pane's driving bar. Jobs use today's "Report ready" plus its summary line.
- **Memory (Brain):** Approve and Reject show an inline status line, as today's learned chip does. Skill toasts use today's strings. "Use Codium for Brain helpers" and "Approve all" are left out (fewer controls).
- **First run (Onboarding):** no Panels button and no counts on the sidebar verbs before a session exists. Steps with buttons are about 90 px tall. Coordinated runs and Connected tools are absent from More on a first run.
- **Session tools:** the budget stop card uses today's copy ("Budget stop", "Step limit reached: 60 of 60 steps used for this run."). The Watch steps follow the approved Tasks board's run.

**Still to settle (owner or the finishing pass)**
1. **Taking over the cloud computer:** the spec says control never goes back on a timer; today's code and the approved Tasks board say "Control goes back to Vector in N minutes, or when you give it back." The Codium board follows the spec.
2. **Session dialogs:** the SessionTools board draws the spec's Status popover, Share, Push and Fork copy. Today's code says "Push to GitHub" / "Commit & push" with a "Connected as" row, "Publish public copy" with a review checkbox, "Fork from message", and an MCP | LSP | Plugins popover with counts.
3. **Selective review:** the board has one "Approve this change" box per hunk; today's code has Accept | Hold per hunk.
4. **The "+" menu on This Mac:** Workflows adds "New workspace… ⇧⌘W"; the More board's host menu doesn't have it. One of them changes.
5. **Search model in Memory:** the board draws a select ("Search by meaning", "Match words only"); the second option is an assumption.

**Not drawn**
- Research: the source viewer, the picker for several runs, paywalled and robots statuses, the guest notice, and the card's save buttons.
- Codium: the empty "No jobs yet." state.
- Memory: confirm dialogs for erase and delete, the memory row "⋯" menu and inline edit.
- First run: the separate route error page (it reuses the launch error layout with its own text).
- Workflows: the Race lane pickers, the Concurrent agents menu, the custom message-pairs table, and today's in-drawer review.
