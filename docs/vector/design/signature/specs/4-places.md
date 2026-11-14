# Vector Signature: where future features live (placement spec)

Status: design spec for six new artboards only. Nothing is built, installed, launched or run; no repository file and no existing board is touched. Written 2026-11-11 and revised the same day after a review ("Review notes" at the end lists every change).

This file **extends** `scratchpad/vector-blend-spec.md` ("BLEND", section numbers like BLEND 4.4) and `scratchpad/vector-screens-spec.md` ("SCREENS"). It reuses their tokens (BLEND 2.2, `--vxs-*`), type (2.3), icons (2.4, SCREENS 1.5), recipes (2.5: icon button, blend chip, header chip, tool button, count badge, primary pill, accent pill, secondary, ghost, danger, tint, menu, tooltip, outline card, switch, segmented control, text field), permission dock (4.6.3), driving bars (6.0), route header (SCREENS 1.2), status chips (SCREENS 1.4) and dialog recipe (BLEND 7.5). No new tokens.

What the owner asked (2026-11-11): show where Plan, Artifacts, an iOS Simulator, On-call (@vector on Slack, Linear, Jira, GitHub), computer use (as a command, not a button) and a short beginner walkthrough would live. Kept from the review: the Signature sidebar (no project logos), today's top buttons and account row (smaller), the Changes screen as is, and one row of chips under the composer.

Facts come from: `scratchpad/vam-spec.md` (@vector), `/Users/aik010/.cache/vector-everywhere/docs/vector/build/vector-everywhere-spec.md` ("VE"; the owner confirmed every recommended answer in its section 10 on 2026-11-11), `/Users/aik010/.cache/vector-connect/docs/vector/build/connected-workspace-spec.md` ("CW"), `/Users/aik010/.cache/vector-review-hands/docs/vector/build/hands-build-spec.md` ("HANDS"), `scratchpad/codium-spec.md` ("CODIUM"), and the read-only checkout `/Users/aik010/.cache/vector-review-main` ("main"). Anything Vector does not do today, or that no spec plans, is marked **(new)**.

Mockup rules (BLEND's, unchanged): "You", "Codium Max", "@you"; no personal names (other people are "a teammate"); Codium as "Codium" and percentages; no third-party logos or marks. **Stated exceptions** (open decision 3), always in plain text with Vector's own neutral glyphs (5.3), never logos, colours or the real app's look: the four platforms Vector connects to (GitHub, Slack, Linear, Jira) where On-call needs them; the platform names the iOS Simulator pane cannot work without (iOS, iPhone, iPad, Xcode, Simulator); and the plain OS app name "Notes" in the computer-use sample (3.2, 6.6), which Hands' allowlist of ordinary apps includes.

---

## 0. Placement map

| Feature | Lives in | How you reach it | Board |
|---|---|---|---|
| **Plan** (the steps Vector writes in Plan mode) | Side panel pane "Plan"; progress mirrored by the todo dock above the composer | Mode chip › Plan, or `/plan`; Panels menu; ⌥⌘3; ⌘K "Toggle Plan"; opens itself when a plan starts drafting; "Open plan" on the plan dock | Plan.dc.html |
| **Artifacts** (pages, documents, diagrams, reports, screenshots) | Side panel pane "Artifacts"; ⌘K "Artifacts" results group **(new)** | Panels menu; ⌥⌘4; ⌘K; "Open in Artifacts" on transcript screenshots, report cards and viewable files | Artifacts.dc.html |
| **iOS Simulator** **(new)** | Side panel pane "iOS Simulator" (macOS with Xcode only) | `/simulator`; Panels menu; ⌥⌘5; ⌘K; opens itself when Vector builds an iOS target | Simulator.dc.html |
| Browser (today) | Side panel pane (Concept A) | `/browser` (today); Panels menu; ⌥⌘2; ⌘K "Toggle Browser" (today) | Browser-A/B/C (existing) |
| Changes (today) | Side panel pane | Header **Changes** (today); ⇧⌘R (today); ⌥⌘1 alias | Changes (existing) |
| Panels menu **(new)** | Header row 1, right after Terminal; "+" in the side panel's tab strip | Click; ⌥⌘0 shows or hides the side panel | Plan, Artifacts, Simulator |
| **On-call** | Sidebar verb after Automations → stage route | Sidebar verb; ⌘K "Open On-call"; running jobs in Live; OS and phone "Needs you" alerts | Oncall.dc.html |
| @vector (GitHub mentions) and Vector everywhere (Slack, Linear, Jira) | On-call › Sources (connect), On-call › Requests (inbox), result PRs in Vectorscope | On-call route | Oncall.dc.html (`view=sources`, `view=inbox`) |
| Production checks (CODIUM's "On Call" perk) | On-call › Requests as source "Production check" | Phone alert, then tap; On-call route | Oncall.dc.html (`request=needs`) |
| **Computer use** (Vector Hands) | Composer command `/computer` **(new)**, which inserts the hands branch's `@Hands` mention; running: desktop edge glow, top banner, click ring or ghost cursor, pinned card in Tasks, Live item | "/" menu; "@" menu (`@Hands`, hands branch); ⌘K "Let Vector use your computer" | Commands.dc.html (`state=firstrun`, `running`) |
| **Cloud computer** | Composer command `/cloud`; host chip › "Move to Cloud computer…"; running: cloud bar above the composer, Tasks card, Live item | "/" menu; ⌘K "Run on your cloud computer"; host chip | Commands.dc.html (`state=cloud`) |
| Vectorscope (today) | Sidebar verb + `/vectorscope` (CW, owner-confirmed) | Verb; `/vectorscope`; ⌘K "Review with Vectorscope" | Vectorscope boards (existing) |
| Tasks (today) | Header **Tasks** → Tasks pane: running work only | Header; ⇧⌘B | Tasks (existing) |
| **Walkthrough** | Overlay over the session screen: a welcome card and four stops | Opens once after a session's first reply (new users, and existing users after the update); Help › "Take the tour"; ⌘K "Take the tour"; More › Getting started | Walkthrough.dc.html |
| Share links (today) | Session "…" › Share publicly… (today); Artifacts › Copy link | Header row 2 "…"; Artifacts preview | Artifacts.dc.html |

---

## 1. Side panel panes

### 1.1 The one pattern: a Panels button plus pane tabs

**Recommendation.** One new header control and today's tab strip:
1. **Panels button** in header row 1, right after Terminal (gap 4): an icon menu button, 24 tall, padding 0 4 0 5, radius 6, gap 2, 1 px transparent border; 14 px `panel-right` in `--vxs-icon` + 12 px `chevron-down` in `--vxs-text-3`; no label. Hover as the tool button (BLEND 2.5). Active (side panel open on any pane except Changes: Browser, Plan, Artifacts, iOS Simulator, Context or Sources): the tool button's active state (`--vxs-active-fill`, `--vxs-active-border`, icon `--vxs-accent-text`). While Changes shows, the Changes button is active instead, as today. Aria "Panels", `aria-haspopup="menu"`; tooltip "Panels" with "⌥⌘0" in `--vxs-text-2`. About 38 px wide; unchanged below 1100 px (it is icon-only already). **Not shown in the empty state**: BLEND 4.8 keeps only Terminal there, and every pane belongs to a session (5.2); it appears with Tasks and Changes once the session starts.
2. **Panels menu** (menu recipe, 252 wide, opens downward, right-aligned to the button, gutter 6). Heading "Beside the chat". Rows 28: 16 px glyph slot (`--vxs-icon`), label 13/18, then right-aligned extras and a key chip (18 tall, padding 0 5, radius 4, 1 px `--vxs-hairline-strong`, 11/14 `--vxs-text-2`). The pane on screen shows a 14 px check in `--vxs-accent-text` before its key chip.
   - `review` Changes · count badge `6` · ⇧⌘R
   - `window` Browser · ⌥⌘2
   - `checklist` Plan · "Ready" 11/14 `--vxs-text-2` with a 6 px `--vxs-needs` dot (only while it waits for you) · ⌥⌘3
   - `artifact` Artifacts · count badge `7` · ⌥⌘4
   - `device-phone` iOS Simulator · ⌥⌘5 (macOS only)
   - separator; Context (today's ring tab); Sources (today's research tab, only after a research run)
   - separator; "Hide side panel" ⌥⌘0 (or "Show side panel", which reopens the last pane)
3. **Pane tabs** in today's side panel tab strip (BLEND 5.2, today's tab chip recipe and panel tokens, unchanged). Open panes show as chips in a fixed order: Context, Changes (+ its file tabs), Browser, Plan, Artifacts, iOS Simulator, Sources. Each chip: 14 px glyph in `#b3a1f2`, label, optional badge, close-small. A pane stays in the strip until its × closes it. This replaces today's rule "with Browser active, Changes and file tabs hide" **(new)**.
   - After the last chip, gap 8: a **"+"** button 24 x 24, radius 6, 14 px plus in `#a8a6ad`, hover fill `rgba(255,255,255,.07)` and `#ffffff`; tooltip "Open a panel"; opens the same Panels menu downward-left.
   - When the chips would exceed the panel width − 72, inactive chips drop their labels from the right end first (glyph + tooltip); the active chip always keeps its label.
   - Chip states: Plan shows `2/5` in the Changes count-badge recipe while running and a 6 px `#E2AB57` dot after its label while it waits for you; Artifacts a neutral count; iOS Simulator and Browser a 10 px orbit in `--vxs-running` in place of the glyph while Vector drives them.
4. **Shortcuts and commands.** ⌥⌘1 Changes (alias; ⇧⌘R stays), ⌥⌘2 Browser, ⌥⌘3 Plan, ⌥⌘4 Artifacts, ⌥⌘5 iOS Simulator, ⌥⌘0 show or hide the side panel. All are free in main's keymap (⇧⌘3-5 are macOS screenshots, so not used). Windows and Linux: Ctrl+Shift+digit (Ctrl+Alt is AltGr on many layouts). ⌘K gets "Toggle Browser" (today), "Toggle Plan", "Toggle Artifacts", "Toggle iOS Simulator", "Toggle side panel" with these chips. Panes that start work also have slash commands (section 3).
5. **Auto-open.** Plan opens itself when Vector starts drafting a plan (window ≥ 1100; otherwise the plan dock offers "Open plan"). iOS Simulator opens on `/simulator` or when Vector builds an iOS target. Browser keeps today's rule. Artifacts never opens itself.

**Why this one.** Today's three labelled buttons stay exactly as they are and the header grows by one 38 px control instead of four new buttons. The side panel is already a tabbed container in today's code (Context, Browser, Sources, Changes), so new panes are new tabs, not a new idea. The same menu sits where you look when the panel is closed (header) and where you switch when it is open (strip "+"). Digits follow the menu order, so they are learnable. Rejected: a button per pane (crowds the header), a pane rail on the right edge (a second sidebar against Signature's one calm sidebar), panes only in ⌘K (beginners never find them).

**Pane body (new panes).** Under the 43 px strip, the pane draws in the shell's tokens, like Browser A: fill `--vxs-main`; a **pane toolbar** 36 tall, 1 px `--vxs-hairline` below, padding 0 8 0 12, gap 4 (BLEND 6.0 toolbar recipe). Board size: header 44, chat column 600 | resize handle | panel 655 (BLEND 6.A); panel body 813 tall.

### 1.2 Plan pane

Today: Plan mode writes the plan to `.vector/plans/<created>-<slug>.md` (main, engine session.ts `plan`), then `plan_exit` asks "Plan at {path} is complete. Would you like to switch to the build agent and start implementing?" with Yes / No. The pane draws that file as a checklist and answers that question.

**Toolbar** (36, padding 0 8 0 16, gap 8): plan title 13/18 weight 500 `--vxs-text`, ellipsis, flex 1; **state chip** (SCREENS 1.4 chip): "Drafting" (10 px orbit `--vxs-running`), "Ready for you" (10 px diamond `--vxs-needs`), "Running · 3 of 5" (orbit), "Done" (10 px check-ring `--vxs-ready`), "Stopped" (square-stop `--vxs-text-3`); icon button 24 `open-file` (UI kit), tooltip "Open plan file"; "⋯" 24 → menu 220: Copy as Markdown · Open in editor · Earlier versions ▸ **(new)** · separator · Discard plan (label `--vxs-diff-del`).

**Progress line** (running and done): 3 px flush under the toolbar, track `rgba(255,255,255,0.06)`, fill `--vxs-running` (done `--vxs-ready`), width done/total, 240 ms.

**Body** (scroll, padding 16 20 24):
- Meta 12/16 `--vxs-text-3`: "5 steps · touches 4 files · Codium Auto · Plan mode".
- "Goal" (section label 12/16 weight 600 `--vxs-text-3`, margin 16 0 6), then the request 13/20 `--vxs-text-2`, 3 lines then "More" (12/16 `--vxs-accent-text`).
- "Steps" label, then step rows 4 apart. **Step row**: grid `20px 1fr auto`, gap 10, padding 10 12, radius 8, hover `--vxs-row-hover`.
  - Marker (20 x 20, centred on the title line): pending, an 18 px circle with 1 px `--vxs-hairline-strong` and the number 11/14 tabular `--vxs-text-2`; running, 12 px orbit `--vxs-running`; done, 14 px check-ring `--vxs-ready`; skipped, 14 px dash-ring `--vxs-text-3`; failed, 14 px x-ring `--vxs-failed`.
  - Title 13/18 weight 500 `--vxs-text` (done `--vxs-text-2`; running `--vxs-accent-text`). Description 12/16 `--vxs-text-2`, margin-top 2, 2-line clamp.
  - **Files** (margin-top 6, gap 4, wrap): chips 18 tall, padding 0 6, radius 5, fill `--vxs-chip-fill`, 1 px `--vxs-chip-border`, gap 4: 12 px `file` in `--vxs-text-3` + file name mono 11/14 `--vxs-text-2` (tooltip: full path; a new file adds "new" 10/14 `--vxs-text-3`). "+2" chip in `--vxs-text-3`. Click opens the file in the Changes reader when it changed, else in the editor.
  - **Sub-steps** (margin-top 6): rows 22, gap 8: 10 px marker (pending ring 1.25 `--vxs-text-3`, done check `--vxs-ready`, running orbit) + 12/16 `--vxs-text-2` (done `--vxs-text-3` struck through, as the todo dock).
  - Right column: when the step has comments, a neutral count badge with an 11 px `comment` glyph; on hover a 24 px `comment` icon button "Comment on this step".
  - Running row: fill `rgba(165,140,242,0.08)` (the Tasks running-phase tint); under its sub-steps a 12/16 `--vxs-text-3` line with a 10 px orbit naming what runs now ("Editing pull-requests.tsx").
  - A step that handed work to helpers: "2 helpers · Open in Tasks ›" 12/16 `--vxs-accent-text`, which opens the Tasks pane at that card.
- Done state only: "Also changed" 12/16 `--vxs-text-3` listing files outside the plan.

**Comments.** The step's Comment button opens an inline editor (margin 6 0 4 30): outline card radius 8, 1 px `rgba(182,159,247,0.45)`, fill `--vxs-raised`, padding 8 10; textarea 13/20, min 56, placeholder "What should change in this step?"; Cancel (ghost 24) · Add comment (tint 24). A saved comment shows under its step (12/16 `--vxs-text-2`, 12 px `comment` glyph `--vxs-text-3`, Edit and Delete ghost 20 on hover) and as a **context chip** in the composer (BLEND 4.3 recipe with the 14 px `checklist` glyph: line 1 "Plan · Step 3", line 2 the comment), exactly as Changes' line comments become context chips today. Comments go with "Keep planning" or with the next message; while the plan runs they join the follow-up queue as Steer items.

**Edits** (Edit button): each row swaps its marker for a 12 px `dot-grid` drag handle `--vxs-text-3`; title becomes a text field (28), description a textarea (min 40); file chips gain a 12 px ×, plus "+ file" ghost 20; a 24 px trash icon button on the right; "+ Add step" ghost 28 ends the list. Saving writes the plan file and adds one user line to the conversation, e.g. "Edited the plan: renamed step 3, removed step 4." **(new)**.

**Footer** (sticky, 1 px `--vxs-hairline` on top, fill `--vxs-main`, padding 12 20, gap 8):

| State | Left | Right |
|---|---|---|
| Drafting | 10 px orbit + 12/16 `--vxs-text-3` "Vector is writing the plan. Nothing changes until you approve." | none |
| Ready | 12/16 `--vxs-text-3` "Run in" + mode blend chip "● Manual ⌄" (menu: Manual, Full access, today's descriptions) | **Keep planning** ghost 28 (tooltip "Vector revises the plan with your comments"; label "Send 2 comments" when there are any) · **Edit** secondary 28 · **Approve and run** primary pill 28 |
| Edit | 12/16 `--vxs-text-3` "Drag to reorder. Vector reads your edits before it starts." | Cancel ghost 28 · **Save plan** primary pill 28 |
| Running | 12/16 `--vxs-text-3` "Step 3 of 5 · 4m 12s" | Show in chat ghost 28 (no Edit while it runs; the composer's Stop ends the run) |
| Done | 12 px check-ring + 12/16 `--vxs-text` "Done · 5 of 5 steps · 6 files changed" | **Review changes** secondary 28 (opens Changes) · New plan ghost 28 |
| Stopped | 12 px square-stop `--vxs-text-3` + 12/16 `--vxs-text-2` "Stopped at step 3 of 5" | New plan ghost 28 · **Continue** secondary 28 (sends "Continue the plan from step 3", a normal message) |

Approve and run is today's `plan_exit` "Yes" (switch to the build agent and implement); Keep planning is its "No". The transcript's dock for that question becomes a **plan dock** (outline card radius 12, padding 10 14): `checklist` 14 + "Plan ready · 5 steps · 4 files" 13/18 weight 500 + Open plan (ghost 24) + Approve and run (primary pill 24). Answering in either place answers both.

**Empty** (no plan in this session; body margin-top 96, centred): 20 px `checklist` `--vxs-text-3`; "No plan yet" 13/18 weight 500 `--vxs-text`; "Choose Plan in the mode menu, or type /plan, and Vector writes the steps here before it changes anything." 12/16 `--vxs-text-3`, max 300; secondary 28 "Plan the next message" (sets the mode chip to Plan).

**Plan and Tasks.** Tasks is running work (helpers, specialists, workflows, background commands, Hands, cloud computer). Plan is the intended steps of this session's main task. When a plan runs, its steps seed the todo list **(new)**, so the todo dock reads "2 of 5 steps done" and gains "Open plan" (ghost 20). Steps link to Tasks cards; Tasks cards never show plan steps.

### 1.3 Artifacts pane

Collects what a session makes that you can look at **(new; today these are scattered across tool-row thumbnails, report cards and Changes)**: files the session created with a viewable type (`.html` pages, `.md` documents, `.svg` and diagram sources, images, PDFs), browser screenshots sent to chat, and research reports.

**Toolbar** (36, padding 0 8 0 12, gap 6): segmented "This session | This project" (26 track); type filter blend chip "All types ⌄" (menu: All types, Pages, Documents, Diagrams, Reports, Screenshots, each with its count 11/14 `--vxs-text-2`); spacer; search icon button 24 that expands to a 200 px text field "Filter artifacts".

**List** (padding 8; `This project` groups by session, newest session first; `This session` is one flat list):
- Group head 32, padding 0 8: session title 12/16 weight 600 `--vxs-text-2` (ellipsis); on the current session a "This session" tag (16 tall, radius 8, 1 px `--vxs-hairline`, 10/14 `--vxs-text-2`); time 11/14 `--vxs-text-3` right; click collapses.
- Row 48, radius 7, padding 0 8, gap 10: leading **thumb** 48 x 30 (radius 4, 1 px `--vxs-hairline`) for pages and screenshots, or **type tile** 28 (radius 7, fill `rgba(255,255,255,0.05)`, 14 px glyph `--vxs-icon`) for the rest; title 13/18 `--vxs-text` (ellipsis); line 2 11/14 `--vxs-text-3` "{Type} · {detail}"; time 11/14 tabular `--vxs-text-3` right. On hover or focus the time gives way to Copy link (icon button 24 `link`) and Download (icon button 24 `download`). Selected `--vxs-row-selected`.
- Type glyphs: Page `globe`, Document `file`, Diagram `diagram`, Report `report`, Screenshot `camera` (section 5.3).

**Preview** (`view=preview`; the Changes reader's shape, BLEND 5.6): header 48, padding 0 8 0 6, gap 8, 1 px `--vxs-hairline` below:
1. Back icon button 28 (`arrow-left`), tooltip "Back to Artifacts" + Esc chip.
2. Title block (flex 1): title 13/18 weight 500 `--vxs-text`; 11/14 `--vxs-text-3` "Page · Stack the Codium plan cards on phones · 11:58".
3. Pager: 24 x 28 chevron up / "2/7" mono 11/14 `--vxs-text-3` / chevron down ("Previous artifact", "Next artifact").
4. **Open** secondary 24 with a 12 px `external` ("Open in Browser" for pages, a Browser tab; "Open in editor" for documents and diagrams).
5. **Copy link** icon button 24 `link`, tooltip "Copy share link". If the session is shared, copies its public link anchored at this artifact **(new anchor)** and shows the toast "Link copied"; if not, opens today's "Share session publicly…" flow ("Review the public copy, publish, copy its link, or unshare") with this artifact in view.
6. **Download** icon button 24 `download` (page `.html`, document `.md`, diagram `.svg`, report through the report's own exports, screenshot `.png`).
7. "⋯" 24: Add to chat · Show in session · Rename… · Delete…
Body: pages and screenshots on `--vxs-viewport`, padding 16, the capture in a frame radius 8, 1 px `--vxs-hairline-strong`, fitted to width (phone-size pages centred at their own width); documents as rendered Markdown 13/20 on `--vxs-main`, max 560; diagrams as SVG centred; reports as BLEND 4.7's research report card.

**Transcript tie-in.** Browser screenshot strips, research report cards and edited-file rows of a viewable type gain a hover icon button 24 `artifact`, "Open in Artifacts".

**Empty**: 20 px `artifact` `--vxs-text-3`; "Nothing to look at yet" 13/18 weight 500; "Pages, documents, diagrams, reports and screenshots Vector makes show up here." 12/16 `--vxs-text-3`, max 300.

**No match** (a type filter or the filter field hides every row): centred in the list, margin-top 48: "No artifacts match" 13/18 weight 500 `--vxs-text`; ghost 24 "Clear filter".

### 1.4 iOS Simulator pane (new)

A live simulator device in the panel (macOS with Xcode only; elsewhere the Panels menu hides it and `/simulator` answers "The iOS Simulator needs a Mac with Xcode."). The pane drives the device directly (touch and key events to the simulator), not through Vector Hands; Hands is for apps with no better tool (HANDS). **One rule copied from Hands (INV-S1, new for the pane):** when the app on the device is Vector's own (Vector Remote in the sample), Vector may look at it and tap through its screens, but it never taps an approval control there (Deny, Allow once); such a tap is refused and the step says "Vector can't answer its own approvals".

**Toolbar** (36, padding 0 8 0 10, gap 4):
1. Device blend chip: 14 px `device-phone` + "iPhone 17 Pro" 12/16 `--vxs-text-2` + chevron. Menu 260: heading "iPhone", device rows with "iOS 27" 11/14 `--vxs-text-2` right; heading "iPad"; separator; "Manage simulators…".
2. App blend chip: "Vector Remote ⌄" 12/16 `--vxs-text` (the project's run targets).
3. **Build and run**: primary pill 24 with a 12 px `play`. Building: secondary 24 "Building…" with a 12 px orbit and a × to cancel; a 3 px bar under the toolbar (BLEND 7.1 running bar). Failed: right side reads a 12 px x-ring + 12/16 `--vxs-text` "Build failed · 2 errors" + "Send to chat" tint 24.
4. Spacer; **Rotate** icon button 24 (`rotate`); **Home** icon button 24 (`home-button`); **Screenshot to chat** icon button 24 (`camera`, tooltip "Add a screenshot to the chat"; adds a 48 x 48 thumb in the composer with caption "iPhone 17 Pro · 402 × 874"); "⋯" 24: Appearance ▸ Light / Dark · Erase content and settings… · Open in the Simulator app · Shut down device.

**Bars** (28, same slot and recipes as BLEND 6.0): driving bar "Vector is using the simulator · " + step in `--vxs-text` ('Tapping "Done"') + Take over (secondary 22) + Stop (22); you-have-control bar ("You have control · Vector is paused · no screenshots", Give back primary pill 22, Stop); waiting bar ("Vector is waiting for you · Use the iOS Simulator?", Review secondary 22). Clicking or typing into the device while Vector drives takes over at once (today's browser rule).

**Device stage** (fill `--vxs-terminal`, device centred, padding-top 24): screen 290 x 630 (402 x 874 pt at 72%), radius 40; bezel 9 px, outer 308 x 648, radius 49, fill `#0B0A0E`, `box-shadow: 0 0 0 1px rgba(255,255,255,0.10), inset 0 0 0 1px rgba(255,255,255,0.06), 0 24px 60px rgba(0,0,0,0.45)`; island 88 x 26, radius 13, `#000` at screen top 10. Under it, margin-top 12, 11/14 `--vxs-text-3` centred: "iPhone 17 Pro · iOS 27 · 72%". The screen is a frame stream drawn in the page, so overlays may sit on it.

**"Vector is tapping" (the computer-use look in miniature)**: HANDS' glow scaled to the device: the bezel gains `box-shadow: 0 0 0 2px rgba(184,146,255,0.90), 0 0 14px rgba(139,92,246,0.55), 0 0 40px rgba(102,51,204,0.28)`, breathing 72 → 100% opacity over 2.8 s (still at 90% under reduced motion; 38% and still while you have control). **Touch point**: 22 px circle, fill `rgba(165,140,242,0.30)`, 1.5 px `#A58CF2`; tag "Vector" (BLEND 6.0 agent tag: 10/12 weight 600 `#FFFFFF` on `#7C5CE6`, radius 4, padding 1 4) at (14, 16). **Tap ripple**: one ring 8 → 32 px, 1.5 px `#A58CF2`, fading over 220 ms (off under reduced motion). Typing shows the device keyboard as normal.

**First use per session (new)**: the permission dock in the chat column (BLEND 4.6.3): "Permission required"; line 13/18 `--vxs-text` "Use the **iOS Simulator**"; hint 12/16 `--vxs-text-2` "Vector can install and open apps in the simulator, tap, type and take screenshots there. It can't reach anything outside the simulator."; Deny · Allow always · Allow once. The pane shows the waiting bar meanwhile.

**Logs drawer** (BLEND 6.A Steps drawer shape): collapsed row 28, padding 0 8 0 12: 12 px chevron-up, "Logs" 12/16 weight 600 `--vxs-text-2`, a 10 px x-ring `--vxs-failed` + "2" 11/14 `--vxs-text-2`, spacer, latest line mono 11/14 `--vxs-text-3` (ellipsis). Open 200 tall (120-360): a 28 px row with segmented "All | Errors" (22 tall) + text field 24 "Filter logs" + "Send errors to chat" ghost 22; rows mono 11/16, padding 2 12: time 10/14 tabular `--vxs-text-3` (56 wide), level glyph 10 (error x-ring `--vxs-failed`, warning diamond `--vxs-needs`, info none), process 11/16 `--vxs-text-3`, message `--vxs-text-2`; hover "Send to chat" ghost 20.

**Idle**: the screen dark with, centred, 13/18 weight 500 "No app running", 12/16 `--vxs-text-3` "Build and run Vector Remote, or ask Vector to.", secondary 28 "Build and run". Device off: the device frame (bezel and screen only) at 40%; over it, at full colour, 13/18 weight 500 `--vxs-text` "Simulator is off" and secondary 28 "Start iPhone 17 Pro". **No iOS app in this project**: the app chip reads "No iOS app" (no menu), Build and run is hidden, and the screen shows 13/18 weight 500 "Nothing to run here" + 12/16 `--vxs-text-3` "This project has no iOS app. Ask Vector to make one, or open a project that has one."

**Sample app: Vector Remote** (sample data; drawn in Vector's dark tokens, sizes at 72%): status bar 38 tall ("9:41" 11/14 weight 600 `#ECEBEF` at x 22; signal bars and an 18 x 8 battery, radius 2); large title "Sessions" 22/28 weight 700 at x 16, y 52; "This Mac · 3 live" 11/14 `--vxs-text-2`; segmented "Live | Needs you 1 | Done" (24 tall); cards (radius 12, fill `rgba(255,255,255,0.05)`, padding 10, 8 apart, margin 0 12):
1. 10 px diamond `--vxs-needs` · "Fix Codium P8 CI" 13/18 weight 600 · "vector-codium" 11/14 `--vxs-text-3`; "Wants to run" 12/16 `--vxs-text-2` + mono "pnpm install --frozen-lockfile"; buttons 32 tall (44 pt): Deny (secondary), Allow once (primary). The phone never offers "always" (CODIUM S6), and Vector never taps these buttons (the approval rule at the top of 1.4).
2. 10 px orbit · "Recheck keyboard focus across menu reads" · "vector · 12m".
3. 10 px orbit · "Reproduce Windows packaging limit" · 10 px `host-cloud` + "Cloud computer · 4m".
Tab bar 56 tall: Sessions (active, `--vxs-accent-text`), Approvals, Computers, Alerts (18 px glyphs, 9/12 labels); home indicator 100 x 4, radius 2, white 60%, 6 from the bottom. Note: Remote is a phone web app today (packages/app/src/phone); the board shows it opened from the home screen. Build and run runs the project's iOS run target: a web build opened in the simulator for Remote, the Xcode scheme for a native app.

---

## 2. On-call

**What it is.** One place for work Vector picks up from other tools on its own: GitHub mentions through @vector, and Slack mentions, Linear and Jira assignments through Vector everywhere, plus CODIUM's production-check alerts. It draws only what those specs do; the schedule is the one new behaviour.

Facts it must keep (VE, @vector, CODIUM):
- **Local first.** Slack, Linear and Jira jobs run on this Mac in an unattended session on a new `vector/ve-…` branch, while Vector is open and the Mac is awake ("a closed lid means queued until you open it"). When the Mac is off, a job waits for it (≈2 hours; 10 minutes for Jira), then Vector replies that it could not run. GitHub mentions run in the repository's own GitHub Actions (@vector), and on this Mac only for your own mentions once @vector agrees (VE Q13). A GitHub Actions fallback for Slack, Linear and Jira comes later (VE R-A4). The cloud computer is **not** a route at launch (VE Q9). Vector's servers pass messages and never hold code.
- **Unattended rules.** Read, search and edit only; the shell only inside an offline sandbox; no browser, no Hands, no cloud computer, no questions; every permission ask refused and listed in the result; personal memory off; the runner (not the model) pushes and opens a **draft** PR with your GitHub login; commits carry `[skip ci]`; never merges, deploys or posts beyond the result. Public repositories keep the branch on this Mac until you confirm (VE Q8).
- **Who may ask.** Slack, Linear and Jira: at launch only you (your linked account); teammates' requests are declined (VE Q2, VE 3.9). GitHub mentions keep @vector's rule: anyone with write access to a bound repository can start a run in its GitHub Actions, on your plan (VE 3.9, @vector G).
- **What On-call's switch and hours govern.** Only jobs that run on this Mac (VE's "This computer takes jobs"): Slack, Linear and Jira, and later your own GitHub mentions (Q13). GitHub mentions in GitHub Actions and production checks run whatever the switch or hours say.
- **Pull requests.** Slack, Linear and Jira jobs open a **draft** PR (VE). A GitHub mention on an issue opens a ready PR that closes the issue; on someone else's PR, a draft PR into it (@vector E).
- **Production checks** (CODIUM "On Call", Max and Ultra): Vector checks your verified production URLs, alerts your phone after two failures in a row, and on your tap starts a fix run in your repository's own Actions. Copy rule: "Vector's agent is on call, not a person." No uptime or response-time promise.

### 2.1 Sidebar verb

Covered in 5.1. The route opens from it; Esc or ⌘[ returns.

### 2.2 Route frame

**Route header** (SCREENS 1.2): `oncall` glyph; "On-call"; subtitle 12/16 `--vxs-text-3` "On call · weekdays 9 AM to 6 PM" (off: "Off call until 9:00 AM"). Right, gap 6: segmented "Requests | Rules | Sources" (26); **On call** label 12/16 `--vxs-text-2` + switch (VE's "This computer takes jobs", off by default; tooltip "This Mac takes Slack, Linear and Jira jobs. GitHub mentions run in GitHub Actions either way."). This is the only On-call switch; Rules does not repeat it. Turning it off with jobs in flight shows an inline confirm under the switch: "Turn off On-call? 1 job stops and pushes nothing." + Turn off (danger 24) + Cancel (ghost 24). Then Close ("Close On-call").

**Duty strip** (28, padding 0 20, 1 px `--vxs-hairline` below, 12/16 `--vxs-text-2`, gap 8; the Vectorscope sends-to strip recipe): 12 px `oncall` `--vxs-text-3`; "Opens pull requests for you to review"; "·" `--vxs-text-3`; "Never merges or deploys"; spacer; "Vector's servers never hold your code" 12/16 `--vxs-text-3`. Three facts that hold for every source.

### 2.3 Requests (`view=inbox`)

**List column** (380 wide, fill `--vxs-main`, 1 px `--vxs-edge` right, padding 8, own scroll):
- Segmented "All 8 | Needs you 1 | Working 2 | Done 5" (26, full width), then text field 28 "Filter requests" (margin-top 8).
- Day labels "Today", "Yesterday" (section label, padding 12 10 4).
- **Request row**: min 60, radius 7, padding 8 10, gap 10; selected `--vxs-row-selected`; hover `--vxs-row-hover`.
  - 14 px source glyph `--vxs-icon` in a 16 slot, top-aligned with line 1.
  - Line 1: title 13/18 `--vxs-text`, one line, ellipsis.
  - Line 2: 11/14 `--vxs-text-3`: "{Source} · {place} · {who} · {age}", e.g. "Slack · #support · you asked · 6m".
  - Right column: status chip (SCREENS 1.4 recipe), top-aligned.

**Status words** (word neutral, glyph coloured; tooltip carries the reason):

| Word | Glyph | VE / @vector state |
|---|---|---|
| Picked up | 10 px ring, 1.25, `--vxs-running` | offered, claimed |
| Working | 10 px orbit `--vxs-running` | running |
| Waiting for this Mac | 12 px pause-bars `--vxs-text-2` | waiting (queue) |
| Needs you | 10 px diamond `--vxs-needs` | held (public repo, posting check), needs-approval, production alert waiting for your tap |
| PR opened | 12 px `pull` `--vxs-ready` | settled with a pull request (draft for Slack, Linear and Jira jobs) |
| Done | 10 px check-ring `--vxs-ready` | settled, reply only ("No changes") |
| Declined | 10 px dash-ring `--vxs-text-3` | refused (not allowed, not in plan, off call) |
| Didn't finish | 10 px x-ring `--vxs-failed` | lost, expired, failed, interrupted, over budget, stopped (cancelled) |

**Empty and quiet states.** Set up but no requests yet: the list shows, centred, margin-top 48, 13/18 weight 500 `--vxs-text` "No requests yet" + 12/16 `--vxs-text-3` "Mention Vector in Slack or comment /vector on GitHub, and requests show up here.", max 280; the detail column is empty. A segment with no rows: 12/16 `--vxs-text-3` "Nothing needs you" / "Nothing working" / "Nothing done yet", 32 tall, centred. Rows but none selected (after a dismiss): the detail column shows 12/16 `--vxs-text-3` "Choose a request to see it here", centred.

**Detail** (flex; content max 720, centred, padding 24 32 48; own scroll):
- Source line 12/16 `--vxs-text-2`: 14 px glyph + "Slack · #support · you asked · 10:42"; right "Open in Slack ↗" secondary 24.
- Title 18/24 weight 600 `--vxs-text`, margin-top 8.
- Status row (margin-top 8, gap 8): status chip + 12/16 `--vxs-text-3` "On this Mac · vector · branch " + mono 11/14 "vector/ve-3f9a2c1d7e04".
- **Request** (section label, then quote box: radius 8, 1 px `--vxs-hairline`, fill `rgba(255,255,255,0.025)`, padding 10 12, 13/20 `--vxs-text`): the requester's own words. Under it 11/14 `--vxs-text-3` "Thread: 6 messages read once as context, kept only for this job." (VE Q5).
- **Vector's plan** (label + 11/14 `--vxs-text-3` "Shown here only. Slack sees progress steps, never this text."): compact plan rows (1.2 step row at 28 tall, no files or sub-steps).
- **Progress**: timeline rows 24, gap 8: 10 px glyph, 12/16 `--vxs-text-2`, time 11/14 tabular `--vxs-text-3` right: "Picked up on this Mac", "Editing · 2 files", "Testing", "Pushing", "Draft PR opened", "Reply posted in the thread" (VE milestones).
- **Result**: PR card (outline card radius 10, padding 12 14): 14 px `pull` `--vxs-ready`; "Draft PR #2191 · Fix checkout button on narrow screens" 13/18 weight 500; mono 11/14 `--vxs-text-2` "vector/ve-3f9a2c1d7e04 → main" + 12/16 `--vxs-text-2` "+24 −6 · 2 files"; 12/16 `--vxs-text-3` "Checks didn't run: Vector's commits skip CI. Start them on GitHub."; buttons 24, gap 6: Open PR ↗ (secondary), Review with Vectorscope (tint; opens the Vectorscope route at that PR), Continue in a new session (ghost; VE "Continue in a new session on this branch"; laptop jobs only). Then the **reply card** (outline card, padding 10 12): "Posted in #support" 12/16 weight 600 `--vxs-text-3`; the posted line 13/20 `--vxs-text-2` "Opened a draft pull request: Fix checkout button on narrow screens" + the PR link; note 11/14 `--vxs-text-3` "#support is a public channel, so Vector posted only the outcome and the link. The summary below came to you privately." Under it "Summary" 12/16 weight 600 `--vxs-text-3` and the summary 13/20 `--vxs-text-2`. In a private place (a direct message or a private channel) the card reads "Reply in Slack" and shows the summary as posted (VE 3.7 shared places).
- Footer (1 px `--vxs-hairline` above, padding-top 12, margin-top 24, gap 8): working → Stop (danger 28; "Stops the job. Nothing is pushed."); didn't finish → Continue in a new session (secondary 28; laptop jobs, whose worktree stays 7 days) + 11/14 `--vxs-text-3` "To retry, ask again in Slack." (VE: a retry is a new job the requester starts); always → Dismiss (ghost 28).
- **Needs you, public repository** (VE Q8, outcome `held`): status row, request box, then 12/16 `--vxs-text` with a 12 px diamond `--vxs-needs`: "This repository is public, so the branch stays on this Mac until you confirm. Pushing makes it visible to everyone." + primary pill 28 **Push and open draft PR** + Continue in a new session (ghost 28).
- **Needs you, permission refused** (outcome `needs-approval`): 12/16 `--vxs-text` "Vector needed a permission it can't ask for on its own:" + the permission names as inline code; Continue in a new session (secondary 28), where you can allow it yourself.
- **Needs you, production check**: source "Production check · vectordev.ai/pricing"; title "vectordev.ai/pricing failed twice in a row"; request box "Returned 502 at 10:12 and 10:17."; primary pill 28 **Start fix run** with 12/16 `--vxs-text-3` "Runs in your repository's GitHub Actions and opens a pull request for you to review."; Dismiss ghost 28; footnote 11/14 `--vxs-text-3` "Vector's agent is on call, not a person."
- **Declined**: request box, then 12/16 `--vxs-text` with a 12 px dash-ring: "A teammate asked. Only you can start jobs for now." + 11/14 `--vxs-text-3` "Vector replied in Jira with this reason."

### 2.4 Rules (`view=rules`)

Content column max 720 (BLEND 7.2 section and row recipes). **(new: the hours and time zone; everything else is VE's Settings › Vector everywhere page and its unattended rules (E7), which links here as "Manage in On-call", plus @vector's GitHub rule in "Who can ask".)**
- **Schedule** (the On call switch itself stays in the route header, 2.2): "Hours" (segmented "Weekdays | Every day | Custom" + text fields 28 "9:00 AM" and "6:00 PM", 96 wide, "to" 12/16 `--vxs-text-3` between; caption "This Mac picks up Slack, Linear and Jira requests during these hours."); "Time zone" (select "This Mac's time zone ⌄"); "Outside these hours" (12/16 `--vxs-text-2`, no control: "Vector replies that it is off call. Requests can't wait overnight: a request's text is kept for at most 2 hours. GitHub mentions still run in GitHub Actions."); "Stay awake to take jobs while plugged in" (VE; switch off; "A closed lid still means queued until you open it.").
- **Where jobs run** (rows 48, each a 14 px glyph `--vxs-icon` + title 13/18 + description 12/16 `--vxs-text-2`):
  - `host-mac` "This Mac first" · tag "On" · "Slack, Linear and Jira requests run here while Vector is open."
  - `pull` "GitHub mentions" · "Run in your repository's GitHub Actions, as @vector does."
  - `pause-bars` "When this Mac is off, wait for it" · switch on · "Up to about 2 hours, 10 minutes for Jira."
  - `globe` "Then your GitHub Actions" · tag "Later" · "Private repositories only."
  - `host-cloud` "Your cloud computer" · tag "Not at launch" · "It would keep your code on Vector-hosted disks." (only its glyph and tag drawn at 60%; the title and description keep their normal colours, so the text keeps its contrast)
  - Tags: 18 tall, radius 9, 1 px `--vxs-hairline`, 11/14 `--vxs-text-3`.
- **Results** (VE Q8, one switch): "Push the branch and open a draft pull request" (on; "With your GitHub login, on private repositories. In a public repository the branch stays on this Mac until you confirm."). Everything else a job does is fixed by VE, so there are no other switches.
- **Never, whatever you choose** (rows 36, 12 px `lock` `--vxs-text-3`, 13/18 `--vxs-text-2`, no control): "Merge a pull request" · "Deploy or publish" · "Push to a branch it didn't create" · "Say yes to a permission ask: it refuses and lists what it needed" · "Use the browser, your apps or the cloud computer" · "Read your personal memory".
- **Limits and model** (VE's computer caps): "Model" (select "Codium Auto ⌄"), "Longest job" (select "45 minutes ⌄"), "At once" ("1 ⌄"), "Jobs a day" ("20 ⌄").
- **Projects** (boxed list, rows 36, checkbox recipe from SCREENS 7): ☑ vector · ☑ vectordev.ai · ☐ vector-codium · ☐ vector-hands; caption 12/16 `--vxs-text-3` "Only projects you tick. A repository can never opt itself in."
- **Who can ask** (no control): "Slack, Linear and Jira: only you" + 12/16 `--vxs-text-3` "Teammates can't start jobs yet."; "GitHub: anyone with write access" + 12/16 `--vxs-text-3` "As @vector: they start runs in the repository's GitHub Actions, on your plan."

### 2.5 Sources (`view=sources`)

Content column max 720. Boxed list, rows 64, padding 0 14, gap 12: 28 px neutral tile (radius 7, fill `rgba(255,255,255,0.05)`, 14 px source glyph `--vxs-icon`); name 13/18 weight 500 + state (SCREENS 1.4 member state: Ready dot, Off ring, Needs you diamond) 12/16; how-to 12/16 `--vxs-text-2`; right action.

| Source | How-to | Sample state | Action |
|---|---|---|---|
| GitHub | "Comment /vector on an issue or pull request. Runs in the repository's GitHub Actions." | Ready · "2 repositories · linked as @you" | Manage (ghost 24) |
| Slack | "Mention @Vector in a channel, or send it a direct message." | Ready · "1 workspace · linked as you" | Manage |
| Linear | "Assign or delegate an issue to Vector, or mention it." | Off · "Not connected" | Connect (secondary 24) |
| Jira | "Assign a work item to Vector, or mention it. Jobs there finish within 50 minutes." | Off · "Not connected" | Connect |
| Production checks | "Vector checks your production URLs and alerts your phone after two failures in a row." + tag "Codium" | Ready · "3 URLs" | Manage |

Connect and Manage open vectordev.ai/everywhere (VE's install and link page), except Production checks' Manage, which opens the codium branch's production-check settings (its ops page, where URLs and domains are verified). GitHub's mention handle is the GitHub App's own (never "vector"), so copy says "/vector" until it exists (@vector 1.1). Footer 11/14 `--vxs-text-3`: "Vector's servers pass messages along and never hold your code. Installs and account links are managed on vectordev.ai/everywhere."

### 2.6 Setup (`view=setup`; never set up)

Centred column max 520, margin-top 96: 40 px tile (radius 10, fill `rgba(255,255,255,0.06)`, 20 px `oncall` `--vxs-text-2`; no gradient, the Live edge keeps it); "Let Vector take requests" 16/24 weight 600; 13/20 `--vxs-text-2` "Ask Vector from GitHub, Slack, Linear or Jira, or assign it an issue. It works on a new branch and answers with a pull request for you to review."; three tiles (BLEND 7.2, 3 columns): "Local first" / "Slack, Linear and Jira jobs run on this Mac. Vector's servers never hold your code."; "Never merges" / "Vector never merges or deploys. You do."; "Your hours" / "Set when this Mac takes requests."; primary pill 28 "Set up On-call" (→ Sources) + ghost 28 "How it works"; footnote 11/14 `--vxs-text-3` "Vector's agent is on call, not a person."

---

## 3. Computer use as commands

Commands replace buttons. Each is a row in the "/" menu and a command in ⌘K with the same words. The "/" menu holds only commands that start work (1.1 item 4); panes and routes that only open (Artifacts, On-call) are reached from the Panels menu, the sidebar and ⌘K. New commands: `/computer`, `/cloud`, `/simulator`, `/plan` **(all new)**; `/vectorscope` is CW's; the rest are today's.

### 3.1 "/" menu (extends BLEND 4.5)

Menu recipe, width = composer box, 8 px above the box, max-height 320 (BLEND's, unchanged): the first two groups (8 rows and 2 headings, about 280 px) show whole. Group headings (menu heading 11/14 weight 500 `--vxs-text-3`, padding 6 10 4). Rows 28 **(new: a 16 px glyph slot, gap 8, `--vxs-icon`)**, then "/trigger" 13/18 `--vxs-text`, description 12/16 `--vxs-text-2` (ellipsis), right badge and key chip in `--vxs-text-2`. Active row `--vxs-row-selected`.

| Group | Command | Glyph | Description (row) | ⌘K title |
|---|---|---|---|---|
| Use a computer | `/computer` | `hands` | Let Vector use apps on your computer (HANDS' @Hands row; "Off — set it up" while Hands is off; no row on Linux) | Let Vector use your computer |
| | `/cloud` | `monitor` | Move this session to your cloud computer | Run on your cloud computer |
| | `/browser` | `window` | Open Vector's controlled browser beside the current task (today's) | Toggle Browser (today's) |
| | `/simulator` | `device-phone` | Run your iOS app in a simulator beside the chat | Toggle iOS Simulator · ⌥⌘5 |
| Plan and review | `/plan` | `checklist` | Vector writes a plan for you to approve first | Plan first |
| | `/vectorscope` | `vectorscope` | Review uncommitted changes with Vectorscope · [Custom] (CW) | Review with Vectorscope |
| | `/review` | `review` | Review the current changes · [Skill] (today's) | unchanged |
| | `/workflow` | `task` | Run a saved workflow · [Workflow] (today's) | unchanged |
| This session | today's: `/compact`, `/fork`, `/share`, `/undo`, `/redo`, `/new`, `/context`, `/terminal`, `/mcp`, `/plugins`, `/codespace`, `/open`, `/agent`, `/model`, `/workspace` | today's | today's | unchanged |

⌘K keeps "Toggle Artifacts · ⌥⌘4" and "Open On-call" as commands without a "/" row.

`/review` stays the generic review skill and `/vectorscope` is Vectorscope, per the owner's CW answer (Q2); the brief's "/review (Vectorscope)" would reverse it (open decision 10).

### 3.2 What each command does

| Command | What happens | First time | While it runs |
|---|---|---|---|
| `/computer` | Inserts a "Hands" atom at the caret (the `@Hands` mention, BLEND 6.0 atom recipe with the 12 px `hands` glyph); the message then runs with Vector Hands | HANDS onboarding dialog (3.3) if Hands is off; then the per-app ask "Allow Vector Hands to use Notes?" in the permission dock (Deny / Always allow / Allow; Allow disabled for 700 ms) | Desktop edge glow and banner (3.4); click ring in "Take the screen", ghost cursor in "Alongside me"; working line "Using Notes"; violet dot on the Tasks button (HANDS); pinned Hands card in Tasks (SCREENS 4); Live item with the `hands` kind glyph. Hands never uses Vector itself, any channel (Vector Dev included), terminals or password managers (HANDS INV-S1) |
| `/cloud` | Same as host chip › "Move to Cloud computer…": the session moves; the host glyph becomes `host-cloud` (tooltip "Cloud computer") and the session moves under the Cloud computer host in the sidebar | Dialog (BLEND 7.5, 440 wide): "Move to your cloud computer?"; 13/20 `--vxs-text-2` "Vector copies this project to a computer Vector hosts and keeps working there, even with your laptop closed. Watch, take over or stop at any time. Passwords and codes are always handed to you."; 12/16 `--vxs-text-3` "Uses your Codium plan's cloud computer hours."; checkbox "Don't ask again"; Cancel (ghost 28) · Move (primary pill 28) | Cloud computer bar above the composer (BLEND 4.6.9: "Vector is using its cloud computer"; Watch, Take over, Give back, Files, Stop); pinned Cloud computer card in Tasks; Live item with `host-cloud`. No glow on this Mac (HANDS: a remote backend draws none) |
| `/browser` | Today's: opens the Browser pane | None (each site asks, today's rules) | BLEND 6.0 driving bar, frame and cursor |
| `/simulator` | Opens the iOS Simulator pane and boots the last device | Permission dock (1.4) the first time Vector drives it in a session | Driving bar, device glow, touch point (1.4); working line "Using the iOS Simulator" |
| `/plan` | Sets the mode chip to Plan for this message; the Plan pane opens when drafting starts | None | Plan pane states (1.2) |
| `/vectorscope` | CW's command (`uncommitted`, `staged`, `branch <base>`) | None | Child-session card, Tasks specialist card, Live item with the lens |

**Buttons this removes**: the codium branch's composer monitor button "Run on my cloud computer" (hosted-composer.tsx; `/cloud` and the host chip replace it); **More › Browser** (the Panels menu, `/browser` and ⌥⌘2 replace it). No new header or composer button is added for computer use.

### 3.3 First-time ask for /computer (HANDS step 1, its exact words)

Dialog recipe, 480 wide, title "Let Vector use your apps". Four lines, 13/20 `--vxs-text-2`, 12 apart, each led by a 14 px glyph in `--vxs-icon` (in order: `hands`, `window`, `globe`, `lock`):
- "Vector Hands lets Vector see and use apps on this computer to do what you ask. It asks before it uses each app, and again before anything you can't undo."
- "While it works, the edges of your screen glow purple and a bar at the top says “Vector is using your computer”. Press Esc or Stop at any time."
- "What it sees goes to the model you picked: whatever is on screen in the apps you allow. Other windows and notifications are blacked out."
- "It never uses terminals, Vector itself, password managers or security settings, and it never types passwords."
Footer: Not now (ghost 28) · **Turn on Vector Hands** (primary pill 28). Then HANDS step 2 (macOS Screen Recording and Accessibility rows with "Open System Settings"), not drawn.

### 3.4 Running look (HANDS recipe, drawn on the board's edges as the display)

- **Edge glow**: four strips along the artboard edges, three inset layers: 2 px `#b892ff` at 90%, 18 px blur `#8b5cf6` at 55%, 60 px blur `#6633cc` at 28%; opacity breathes 72 → 100% over 2.8 s ("Alongside me": 60% with a 4.2 s breath); still at 90% under reduced motion; 38% and still while paused.
- **Banner**: pill at top centre, 8 px from the top, 40 tall, 560 wide (HANDS: 420-640), fill `rgba(18,13,29,0.92)`, 1 px `rgba(184,146,255,0.55)`, radius 20, padding 0 6 0 14, gap 10: 6 px `#b892ff` dot + "Vector is using your computer" 13/18 weight 500 `#ECEBEF`; the step 12/16 `--vxs-text-2` truncated ('Typing in “Codium bugs” in Notes'); key hint chip "Esc"; **Take over** (secondary 24; only in "Take the screen", HANDS D: in "Alongside me" any mouse or key use in other apps is simply ignored, so there is nothing to take over); Stop (accent pill 24). Paused: "Paused — you have control" + Resume (primary pill 24) + Stop. Behind your windows: the step reads "Working in Notes behind your windows".
- **Pointer** (HANDS D): "Take the screen" (foreground) shows a violet ring ripple where Hands clicks (one ring 8 → 32 px, 1.5 px `#A58CF2`, 220 ms; off under reduced motion), no cursor. "Alongside me" (background) shows the **ghost cursor**: BLEND 6.0 agent cursor (14 px arrow `#A58CF2`, 1.2 px white stroke) with the tag "Vector", drawn only over the visible part of the target window.

---

## 4. Walkthrough

A tour for beginners: **five cards in all**, a welcome card and four stops, one short sentence each, moving round the window. It shows a few places, not every control. It replaces today's 43-step spotlight tour (main, features/onboarding/spotlight-steps.ts, "welcome" to "finale") as the first-run tour (open decision 11).

**When.** Once, automatically, after a session's first reply finishes, so every stop exists and has real content. New users see it after their first reply; people who already use Vector see it once after updating to the new design (a new onboarding flag, `tour-signature`, so today's `tour` flag does not hide it). Never again after Done or Skip. Replay: **Help › Take the tour** (new first row of the account row's Help menu, then a separator, then Docs, Best practices, Changelog, Send feedback, Diagnostics, Open debug tools); ⌘K "Take the tour"; More › Getting started. If the sidebar is hidden, the tour shows it for its run and hides it again at the end (as today's tour does).

**Spotlight.** Scrim `rgba(10,9,13,0.55)` over the whole window (sidebar included), drawn as one SVG mask with a rounded hole round the target (hole = target box + 6 px, radius = target radius + 4) and a 1.5 px `rgba(182,159,247,0.80)` ring on the hole's edge. Hole and card move together over 280 ms `cubic-bezier(0.22,1,0.36,1)`; they jump under reduced motion. Targets are found by `data-tour` ids: `tour-composer`, `tour-sidebar`, `tour-header`, `tour-search`. The target is not clickable during the tour, and the tour never opens or changes a panel.

**Coach mark** (role="dialog", aria-label "Tour, step N of 4", focus starts on Next and stays inside): 280 wide, radius 12, fill `--vxs-menu`, 1 px `--vxs-raised-border`, `--vxs-menu-shadow`, padding 14 16 12. Arrow: a 10 px square rotated 45°, same fill, border on its two outer sides, centred on the target's facing edge (clamped 20 px from the card's corners); the card sits 12 px from the hole.
- Title 14/20 weight 600 `--vxs-text` (at most 4 words). Body 13/20 `--vxs-text-2`, margin-top 4 (at most 16 words, everyday words, no feature names a beginner has not seen yet).
- Footer, margin-top 14, 24 tall: **step dots** (one per stop, 6 px, gap 6; current a 16 x 6 pill radius 3 `--vxs-accent` (4.07:1 on the card); visited a filled circle `--vxs-text-3`; upcoming a 6 px ring, 1 px `--vxs-text-3` (4.7:1; a `--vxs-hairline-strong` dot would be 1.46:1, under the 3:1 minimum for a control); each a button with a 24 px hit area, aria "Go to step N"); spacer; **Back** ghost 24 (hidden on stop 1); **Next** primary pill 24 ("Done" on stop 4). Esc skips; there is no separate Skip button after the welcome card.
- Keys: → or Enter next, ← back, Esc skip.

| # | Target | Placement | Title | Sentence |
|---|---|---|---|---|
| Welcome | none (centred on the stage) | n/a | A quick tour of Vector | Four places you'll use most. It takes 30 seconds. |
| 1 | Composer box and its chips row (`tour-composer`) | above, arrow down | Ask for anything | Type what you want and press Enter. By default, Vector asks before changing files. |
| 2 | Sidebar Live strip and the project list under it (`tour-sidebar`) | right, arrow left | Your work lives here | Sessions sit under their projects. Live shows what's running and what needs you. |
| 3 | Header Tasks, Changes, Terminal and Panels (`tour-header`) | below, arrow up, right-aligned | See what Vector did | Changes lists edited files. The panel button opens the plan, browser and more. |
| 4 | Sidebar Search row (`tour-search`) | right, arrow left | Find anything | Press ⌘K to search sessions, files and settings. Type / in the chat for commands. |

On Windows and Linux, ⌘K reads Ctrl+K. The path moves bottom centre → left → top right → top left. **Welcome card**: 360 wide, same recipe, padding 20 20 16, centred on the stage, scrim with no hole; a 28 px Vector chip tile (radius 8, fill `rgba(255,255,255,0.06)`, glyph `--vxs-text-2`; no gradient); title 16/24 weight 600 (margin-top 12); line 13/20 `--vxs-text-2`; then 12/16 `--vxs-text-3` "Replay it any time from Help." Footer: Skip (ghost 28) · spacer · **Start** (primary pill 28). There is no closing card: Done on stop 4 ends the tour.

---

## 5. Sidebar change

### 5.1 The On-call verb

Verbs become six: New session · Search · Automations · **On-call** · Vectorscope · More. SIG's rule stands: plugins never add verbs.
- Row: the SIG verb row (28 tall, pill inset 8, radius 7, 16 px icon at x 18 in `--vxs-icon`, label 13/18 at x 42 `--vxs-text-row`, meta right at W − 18). Icon `oncall` 16, stroke 1.75. Selected (route open) `--vxs-row-selected`, text `--vxs-text`.
- **Meta** (11/14 tabular `--vxs-text-3`), first match wins: anything needs you → a 10 px diamond `--vxs-needs` + count ("◆ 1"); jobs working → their count ("2"); off call → next shift start ("9:00"); on call and quiet, or never set up → none.
- Tooltip: "On-call · 1 needs you · 2 working · on until 6:00 PM".
- **Rail**: a 36 x 32 button after Vectorscope, 16 px `oncall`, a 6 px `--vxs-needs` dot at its top-right while anything needs you; tooltip as above.
- **Live**: on-call jobs running on this Mac, or held for you, appear with the 12 px `oncall` kind glyph. Production alerts waiting for a tap stay out of Live (verb meta, OS and phone alerts carry them).
- **Project tree**: a job's session sits under its project, titled as VE names it ("Slack: Checkout button does nothing…"), with the 12 px `oncall` kind glyph before its meta.

### 5.2 Decided: no sidebar items for Artifacts, Plan or the Simulator

Artifacts, Plan and the Simulator belong to a session, so they live where the session's work is (the side panel). A project-wide list of artifacts is the pane's "This project" scope and ⌘K's Artifacts group. Keeping them out keeps Signature's short verb list. More menu: "Browser" leaves it (3.2).

### 5.3 Glyphs new in this file

Drawn per BLEND 2.4 (round caps and joins, `currentColor`).

| Glyph | viewBox | Path | Size | Stroke |
|---|---|---|---|---|
| `panel-right` | 0 0 20 20 | `M2.08 3.75H17.92V16.25H2.08Z M12.5 3.75V16.25` | 14 | 1.5 |
| `checklist` (Plan) | 0 0 20 20 | today's UI-kit path: `M9.58 13.75H17.08M9.58 6.25H17.08M2.92 6.67L4.58 7.92L7.08 4.17M2.92 14.17L4.58 15.42L7.08 11.67` | 14 | 1.5 |
| `artifact` | 0 0 20 20 | `M6.25 2.5H17.5V13.75H6.25Z M2.5 6.25V17.5H13.75` | 14 | 1.5 |
| `oncall` | 0 0 24 24 | circle cx 12 cy 12 r 8.5; `M6.5 12h2.6l1.6-3.2 2.8 6.4 1.6-3.2h2.4` | 16 verb, 12 kind | 1.75 |
| `play` | 0 0 16 16 | `M5 3.5v9l7.5-4.5z` | 12 | fill |
| `home-button` | 0 0 16 16 | circle cx 8 cy 8 r 5.25 | 14 | 1.25 |
| `report` | 0 0 24 24 | `M6 3.5h12v17H6z M9 8h6M9 11.5h6M9 15h3.5` | 14 | 1.75 |
| `diagram` | 0 0 24 24 | `M4.5 4.5h6v6h-6z M13.5 13.5h6v6h-6z M10.5 7.5h3.5a2.5 2.5 0 0 1 2.5 2.5v3.5` | 14 | 1.75 |
| `issue` (Linear) | 0 0 16 16 | circle cx 8 cy 8 r 6; circle cx 8 cy 8 r 1.75 filled | 14 | 1.25 |
| `ticket` (Jira) | 0 0 16 16 | `M2.5 4.5h11v2.25a1.25 1.25 0 0 0 0 2.5v2.25h-11V9.25a1.25 1.25 0 0 0 0-2.5z` | 14 | 1.25 |
| Slack | | today's UI-kit `speech-bubble` | 14 | 1.25 |
| GitHub | | SCREENS `pull` | 14 | 1.25 |
| Production check | | BLEND `globe` | 14 | 1.75 |

Reused: `device-phone`, `window`, `camera`, `rotate`, `globe`, `external`, `vectorscope` (BLEND 2.4); `hands`, `monitor`, `file`, `comment`, `pull` (SCREENS 1.5); `open-file`, `dot-grid`, `link`, `download`, `review`, `task` (UI kit).

Existing boards get the On-call verb, the Panels button and the Live kind glyph **only after the owner approves**; the six new boards draw them now.

---

## 6. Artboard plan

### 6.1 Shared

- Files in `scratchpad/vector-glass-canvas/project/`, the `.dc.html` format of Main (BLEND 8.1). Each board is **1600 x 1000**, window 1520 x 900, artboard padding 50 / 40, sidebar 264, stage 1256 (SCREENS 1.1). Copy Chat.dc.html's helmet styles, frame, wallpaper, helpers, tokens, sidebar, header and composer, after the running chips pass lands; lay out at 1600 as Tasks.dc.html does.
- **Sidebar**: BLEND 8.2 content plus the On-call verb (meta "◆ 1" on every board). Live 4 as BLEND 8.2 (Oncall adds its job; 6.5).
- **Header**: BLEND 4.1 plus the Panels button after Terminal.
- **Composer chips: one row, never wrapping.** Left "where": the 14 px host glyph alone in a 24 x 24 chip (tooltip "This Mac"), then the project chip ("vector ⌄" or "vectordev.ai ⌄"). Right "how": model "Codium Auto ⌄", mode "● Manual ⌄", effort "Balanced ⌄", speed "● Normal ⌄", Codium ring "◔ 64%". `flex-wrap: nowrap`. When the composer narrows, compact in this order until the row fits: (1) the ring drops "64%"; (2) the model name truncates (min 72 px, 16 px mask fade); (3) mode, effort and speed hide their chevrons until hover or focus; (4) speed shows only its dot while Normal. Split boards (chat 600, composer 536) normally need steps 1 and 2.
- **Canvas** (`canvas.json`, after the existing boards; the other run edits boards, so add these entries when it has finished): title note `title1` at (0, 8220) "Where future features live"; purple note at (−480, 8520), w 400: "Six boards show where planned features would sit. Plan, Artifacts and the iOS Simulator are side-panel panes, opened from the new Panels button by Terminal or with ⌥⌘ digits. On-call is a new sidebar verb. Computer use is the /computer command. The walkthrough is a welcome card and four quick stops. Tweaks switch each board's states."

| File | x | y | Title |
|---|---|---|---|
| Plan.dc.html | 0 | 8520 | "Plan pane" |
| Artifacts.dc.html | 1680 | 8520 | "Artifacts pane" |
| Simulator.dc.html | 3360 | 8520 | "iOS Simulator pane" |
| Oncall.dc.html | 0 | 9940 | "On-call" |
| Commands.dc.html | 1680 | 9940 | "Commands: computer use and the cloud computer" |
| Walkthrough.dc.html | 3360 | 9940 | "Walkthrough (first run)" |

All interactive, `$preview` 1600 x 1000.

### 6.2 Plan.dc.html

- **Shows**: Chat's session "Warn on review model evidence" (selected in the sidebar), chat column 600 | panel 655 with the Plan pane active; strip chips Changes `6` · Plan; Panels button active.
- **Props**: `state` enum drafting | ready | running | done | stopped | empty (default ready); `edit` boolean (default false; only in ready).
- **Plan** (goal = Chat's first user message):
  1. "Find where findings are built" · ai-review.ts · sub-steps "Search for modelEvidence in packages/app/src", "Read ai-review.ts and pull-requests.tsx".
  2. "Add an evidence state to each finding" · ai-review.ts, model-evidence.ts · "Checked, missing or stale", "Stale when the evidence is older than the head commit".
  3. "Show a note on the finding card" · pull-requests.tsx · "A note for missing and stale evidence", "Keep the panel layout as it is"; one comment: "Use the words 'Evidence may be stale'."
  4. "Add tests" · model-evidence.test.ts (new).
  5. "Typecheck and ask Vectorscope to review" · no files · "pnpm --filter @vector/app typecheck".
- **Per state**: drafting (steps 1-3 written, 4-5 skeleton bars 8 tall radius 4 `rgba(255,255,255,0.08)`; mode chip "● Plan"); ready (all steps; plan dock in the chat; mode chip "● Plan"; context chip "Plan · Step 3" in the composer); running (1-2 done, 3 running "Editing pull-requests.tsx", Plan chip `2/5`; chat shows Chat's items 1-6, working line, Stop; todo dock "2 of 5 steps done" + Open plan; mode "● Manual"); done (all done, Chat's full transcript, "Also changed: model-evidence.test.ts"); stopped (1-2 done, 3 with the square-stop marker, state chip "Stopped", Stopped footer); empty (empty state; Plan chip only).
- **Interactions**: Approve and run → running; Keep planning → drafting; Edit toggles `edit`; Comment opens the inline editor and adds the context chip; file chips open Changes (strip switches to Changes); Panels menu opens; "+" opens the same menu.

### 6.3 Artifacts.dc.html

- **Shows**: vectordev.ai session "Stack the Codium plan cards on phones" (selected), chat 600 | panel 655, Artifacts active (chips Browser · Artifacts `7`).
- **Props**: `view` enum list | preview | empty (default list); `scope` enum session | project (default project).
- **Sample** (`project`):
  - "Stack the Codium plan cards on phones" (This session): Page "Plan cards, phone layout" · localhost:4321/codium · 11:58; Screenshot "Before: cards at 390 × 844" · 11:52; Screenshot "After: cards stacked" · 11:59; Diagram "Card breakpoints" · 3 widths · 11:55.
  - "Check the Codium page at tablet width": Screenshot "Codium page at 768 × 1024" · 11:42; Document "Tablet check notes" · 4 findings · 11:45.
  - "Draft the Codium FAQ": Report "What people ask about Codium" · 12 sources · Kept in brain · Yesterday.
- **Preview**: the Page artifact, the Codium page content of BLEND 8.5 at 390 wide with the four plan cards stacked; pager "1/7".
- **Interactions**: rows open preview; Back returns; scope and type filter switch the list; Copy link shows the toast "Link copied" (the sample session is shared); Open switches the strip to Browser.

### 6.4 Simulator.dc.html

- **Shows**: vector session "Check Remote's Sessions screen on iPhone" (selected, running), chat 600 | panel 655, iOS Simulator active (orbit on its chip while driving).
- **Props**: `state` enum idle | building | driving | control | permission (default driving); `logs` boolean (default false).
- **Chat**: user "Check Remote's Sessions screen on iPhone. The Done tab looks empty even when sessions finished today."; Vector "I'll build Remote, open Sessions in the simulator and tap through the tabs."; tool row `device-phone` · **Simulator** · "Built and opened Vector Remote · iPhone 17 Pro" · "38s" **(new row kind)**; simulator row with three 40 x 86 portrait thumbs, "Tapped “Needs you” · Sessions", "3 steps"; running row (orbit) "Simulator · Tapping “Done”"; working line "1m 10s · Codium · Using the iOS Simulator"; Stop.
- **Pane**: as 1.4; driving shows the touch point on the "Done" segment, ripple, device glow, driving bar 'Vector is using the simulator · Tapping "Done"'. Logs (open with `logs`): "10:41:02 · Vector Remote · Loaded 3 sessions"; "10:41:05 · warning · Sessions › Done: list is empty for today"; "10:41:06 · error · TypeError: finishedAt is undefined".
- **Per state**: idle (no app running), building (Building… bar), control (you-have-control bar, glow at 38%), permission (dock in chat, waiting bar).
- **Interactions**: Take over / Give back / Stop switch `state`; Allow once → driving; rotate swaps the frame to landscape (648 x 308); the camera adds a thumb to the composer; device menu opens.

### 6.5 Oncall.dc.html

- **Shows**: the On-call route (sidebar On-call verb selected, meta "◆ 1"); Live 5 (4 visible + "+1 more"): ◆ Fix Codium P8 CI [Review] · ◌ Recheck keyboard focus… `12m` · ◌ "Slack: Checkout button does nothing…" (`oncall` kind glyph) `6m` · ◌ Reproduce Windows packaging limit (cloud) `4m`.
- **Props**: `view` enum inbox | rules | sources | setup | empty (default inbox; `empty` is set up with no requests yet, 2.3); `request` enum working | pr | needs | declined (default working; which row is selected and in what state); `duty` enum on | off (default on).
- **Inbox rows**:
  - Today: Slack · #support · you asked · 6m · "Checkout button does nothing on narrow screens" · Working. GitHub · vectordev.ai · issue #2203 · you commented /vector · 38m · "Settings search misses Default models" · PR opened (ran in GitHub Actions; PR #2204, which closes the issue). Production check · vectordev.ai/pricing · 14m · "vectordev.ai/pricing failed twice in a row" · Needs you. Linear · VEC-118 · you assigned it · 1m · "Add an empty state to Automations" · Picked up. Jira · OPS-42 · a teammate assigned it · 2h · "Rotate the staging certificates" · Declined.
  - Yesterday: GitHub · vectordev.ai · PR #2188 · you commented "/vector fix the lint error" · Done ("No changes needed: lint passes on the latest commit."). Slack · direct message · "Why is the nightly build slow?" · Done. Linear · VEC-112 · "Rename the Coordinated runs copy" · Didn't finish ("This Mac went to sleep. Ask again to retry.").
- **Detail (working)**: request "@Vector the checkout button does nothing on narrow screens, can you take a look?"; plan: "Find the checkout handler" (done), "Reproduce with a test" (done), "Fix the click target" (running), "Run the tests", "Push a branch and open a draft PR"; progress: Picked up 10:42, Editing · 2 files 10:44 (running). `pr` is the same Slack request after it finished: its row reads "PR opened", the plan is all done, progress runs to "Reply posted in the thread", and the detail shows 2.3's result block (draft PR #2191 + the "Posted in #support" reply card, since #support is public); `needs` the production-check detail; `declined` the declined detail.
- **duty=off**: subtitle "Off call until 9:00 AM", switch off, verb meta "9:00", duty strip "Off call · Slack, Linear and Jira get an off-call reply · GitHub mentions still run in GitHub Actions".
- **Interactions**: rows select; segmented switches `view`; the switch toggles duty (with the inline confirm while a job runs); Start fix run turns the alert into Working; Stop turns Working into Didn't finish ("Stopped by you. Nothing was pushed.").

### 6.6 Commands.dc.html

- **Shows**: a new vector session "Put the Codium bugs in a note" (selected; a new row at the top of the vector project, so BLEND 8.2's other rows stay as they are), full-stage chat (composer 720). Chat: user "Put the five Codium bugs from today's review into a new note called “Codium bugs” in Notes."; Vector "I'll open Notes, make a note called “Codium bugs” and add the five bugs as a list." The sample is an ordinary app on Hands' allowlist; Vector itself (any channel, Vector Dev included) is on Hands' never-list, so no board shows Hands using Vector.
- **Props**: `state` enum menu | palette | firstrun | running | cloud (default menu); `mode` enum screen | alongside (default screen; running only).
- **menu**: the editor holds "/"; the "/" menu with 3.1's groups, `/computer` active; host glyph chip "This Mac".
- **palette**: ⌘K (SCREENS 5 board recipe) with query "use", Commands group: Let Vector use your computer · Run on your cloud computer · Toggle iOS Simulator ⌥⌘5 · Toggle Browser ⌥⌘2; Sessions group: "Put the Codium bugs in a note".
- **firstrun**: the editor holds the Hands atom + "put the five Codium bugs into a new note in Notes"; the 3.3 dialog over the window (scrim).
- **running**: edge glow on the artboard edges, banner at top centre. A "Notes" window (720 x 460; the Signature frame recipe at radius 10, title "Notes", drawn plainly and not in the real app's look: a 200 px note list with "Codium bugs" selected, and the note on the right with its title and three of five bullet lines typed, a 2 px `#B69FF7` caret after the third). `mode=screen` ("Take the screen"): Notes in front of Vector's window at artboard (760, 300); banner with Esc, Take over and Stop; a click ring on the note; glow breathing 72 → 100%. `mode=alongside` ("Alongside me"): Vector's window in front, Notes behind it to the right with its note column showing; the ghost cursor "Vector" on the visible note; banner with Esc and Stop (no Take over); glow at 60% with the 4.2 s breath. Vector's window in both: Hands tool row (`hands` glyph) **Vector Hands** · "Typing in Codium bugs · Notes" with two thumbs; working line "1m 48s · Codium · Using Notes"; Tasks pane docked (320) with SCREENS 4's Hands card (`hands=working`), Tasks button violet dot; Live item with the `hands` kind glyph.
- **cloud**: after `/cloud`: host glyph `host-cloud` (tooltip "Cloud computer"); cloud computer bar above the composer; the session row moved under "Cloud computer" in the sidebar; no glow.
- **Interactions**: ↑ ↓ ↵ in the menu (↵ on /computer → firstrun; on /cloud → the 3.2 dialog, Move → cloud); Turn on Vector Hands → running; banner Take over (`mode=screen`) → paused banner ("Paused — you have control", glow 38%) and Resume; Stop → back to menu with "Stopped" on the Hands row; ⌘K toggles palette.

### 6.7 Walkthrough.dc.html

- **Shows**: Chat's session view at 1600 ("Warn on review model evidence", done) with the tour overlay.
- **Props**: `step` enum welcome | 1 | 2 | 3 | 4 | replay (default welcome). `replay` shows no overlay and the Help menu open with "Take the tour" first and hovered.
- **Content**: section 4's table exactly. No step opens or closes a panel; stop 3 spotlights the header group with the Panels button in it.
- **Interactions**: Next, Back, the dots and the arrow keys move between stops (and set `step`); Skip (welcome card) and Esc go to `replay`; Done on stop 4 goes to `replay`; "Take the tour" in the Help menu goes to `welcome`.

---

## 7. Open decisions for the owner

1. **Panels**: one Panels button by Terminal plus pane tabs (recommended), or no header button (strip "+" and ⌘K only).
2. **On-call as a sixth sidebar verb** (recommended), or a More item.
3. **Third-party names** in plain text with Vector's own glyphs, as exceptions to the mockup rule: the platforms (GitHub, Slack, Linear, Jira), the Simulator pane's platform names (iOS, iPhone, iPad, Xcode), and "Notes" as the computer-use sample app.
4. **On-call hours (new).** Vector everywhere has only "This computer takes jobs". A request's text expires within 2 hours (10 minutes for Jira), so outside the hours Vector replies "off call" rather than queuing overnight. Queuing overnight would need VE to keep job text longer.
5. **Cloud computer for On-call**: drawn as "Not at launch" (VE Q9). Say if it should become a route.
6. **Teammates' requests** from Slack, Linear and Jira show as Declined (VE Q2). Say when teammates may ask. (GitHub writers can already start @vector runs in Actions; that is @vector's rule and unchanged.)
7. **Plan feedback (new)**: plan edits and step comments go back into the conversation, and plan steps seed the todo list.
8. **Artifact links (new)**: anchor into the session's public share (drawn), or a share link per artifact.
9. **Simulator**: a per-session permission ask before Vector drives it (drawn), macOS only, and never tapping approval controls in Vector's own apps (drawn as a rule, copied from Hands INV-S1).
10. **`/review`** stays the generic review skill and `/vectorscope` is Vectorscope (your CW answer). Switching `/review` to Vectorscope reverses that.
11. **Tour**: replace today's 43-step spotlight tour with the five-card tour (a welcome card and four stops), shown once to existing users after the update too; keep the old one as "Full tour" in Help, or delete it.
12. **More › Browser** removed (Panels menu covers it).
13. **Shortcuts** ⌥⌘1–5 and ⌥⌘0 for panes.

---

## Review notes (2026-11-11)

Checked against the owner's words, BLEND, SCREENS, @vector (`vam-spec.md`), VE, CW, HANDS, CODIUM and main (read-only). Every item the owner named already had a place; these are the problems found and what changed.

**Claims the sources do not support**
1. **Computer use sample used Vector Dev.** HANDS puts `ai.vector.app.dev` (Vector Dev) on its never-list (INV-S1, 2.2), so Hands can never drive it, and the first-run dialog on the same board says so. The Commands board, 3.2 and 3.4 now use an ordinary allowed app, Notes ("Put the Codium bugs in a note"), drawn plainly; the board says why.
2. **Banner showed Take over with the ghost cursor.** HANDS D: Take over is a foreground ("Take the screen") control; "Alongside me" ignores input in other apps and shows the ghost cursor, foreground shows a click ring. 3.4 now splits the two; the board's `front` boolean became `mode` screen | alongside.
3. **"Only you can start jobs" was wrong for GitHub.** @vector lets any writer of a bound repository start runs (VE 3.9). Section 2 facts, duty strip, Rules › Who can ask and open decision 6 now say Slack, Linear and Jira are you-only; GitHub keeps @vector's rule.
4. **The On call switch and hours looked like they stop everything.** They govern only this Mac's jobs ("This computer takes jobs"); GitHub Actions runs and production checks continue. Added to the facts, the switch tooltip, the hours copy and the `duty=off` strip.
5. **Invented Rules switches.** Triage / Reproduce / Fix are not in VE. Replaced by VE's one real switch (push and open a draft PR, Q8) and VE's model cap; the "new" label now names only the hours.
6. **"Never merges or deploys without you"** implied it could with you. VE never merges or deploys. Duty strip and setup tile fixed.
7. **GitHub issue runs open a ready PR, not a draft** (@vector E). Status table, sample row and facts fixed.
8. **Public channel reply.** VE posts only the outcome and link in a public Slack channel such as #support; the reply card showed the summary there. It now shows what was posted, and the summary as sent privately.
9. **"Ask again" from the desktop** is not a VE action (a retry is a new job the requester starts). Replaced with "Continue in a new session" plus "To retry, ask again in Slack."
10. **Production checks' Manage** opened vectordev.ai/everywhere; it belongs to the codium branch's ops page.
11. **GitHub how-to** said "Mention Vector" while the same section says copy uses `/vector` until the App handle exists. Fixed.
12. **Today's tour is 43 steps**, not 45 (spotlight-steps.ts).

**Crowding and consistency**
13. **Panels button in the empty state** went against BLEND 4.8 (Terminal only) and against 5.2 (panes belong to a session). It now appears with the session.
14. **`/artifacts` and `/oncall`** broke 1.1's own rule that only panes that start work get "/" commands. Removed from "/" (⌘K keeps them), which lets the "/" menu keep BLEND's 320 px max height instead of 400.
15. **Duplicate On call switch** in Rules › Schedule removed; the route header holds the only one.
16. **Plan footer**: a disabled Edit in the running state removed; Done's "Review changes" was a 24 px tint button next to 28 px buttons, now secondary 28.
17. **Placement map row "Vector Remote"** was sample content, not a place. Removed. `/computer`, `/cloud`, `/simulator`, `/plan` and the Simulator pane are now marked (new).
18. ⌘K title "Let Vector use this Mac" became "Let Vector use your computer" (Hands runs on Windows too and uses this wording); the "/" row uses Hands' own words and states the off and Linux cases. Today's `/agent`, `/model` and `/workspace` added to the session list.
19. **Simulator and Vector's own approvals.** The sample puts Remote's Deny / Allow once on the device while Vector taps. Added a rule copied from Hands INV-S1: the pane never taps approval controls in Vector's own apps (open decision 9).

**Walkthrough**
20. **Too long.** It was seven cards (welcome, five stops, done). Now five cards in all: a welcome card and four stops (composer, sidebar, header with the Panels button, Search). Titles at most 4 words, sentences at most 16, no jargon such as "Manual mode". No step opens a panel any more, and there is no closing card.
21. **Existing users would never see it** because today's `tour` flag is already set for them. A new flag shows it once after the update.
22. Added what happens when the sidebar is hidden, and Ctrl+K for Windows and Linux.

**Contrast**
23. Upcoming tour dots in `--vxs-hairline-strong` were 1.46:1 on the card (under 3:1 for a control). Now a `--vxs-text-3` ring (4.7:1).
24. "Row at 60%; its text stays full contrast" contradicted itself; now only the glyph and tag dim. The device-off text now sits at full colour over the dimmed frame.

**Missing states added**
25. Artifacts "No artifacts match"; Simulator "No iOS app in this project"; On-call "No requests yet", per-segment empty lines and no-selection detail (`view=empty` on the board); On-call detail for a held public-repository branch (Push and open draft PR) and for a refused permission; a Plan "Stopped" footer and `state=stopped`.

**Not changed, and why**: the Panels button plus strip "+" (one control in the header, and the strip already has a "+" slot); the Plan footer's "Run in" mode chip (the composer chip reads "Plan" while planning, so it is the only place to choose how the plan runs); `/cloud` (SIG retires the Vector Cloud entry once the Cloud computer host exists, so the name does not clash for long); On-call as a sixth verb (open decision 2).
