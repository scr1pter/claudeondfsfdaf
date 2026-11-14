# Vector Signature Blend: screens spec (Vectorscope, Settings, Tasks, Search, Connected tools, Automations)

Status: design spec for artboards only. Nothing is built, no repository file is touched, nothing is installed, launched or tested. Repository facts were read from the read-only checkout `/Users/aik010/.cache/vector-review-main` (origin/main `0dcbb8e2d`) and with `git show` from `origin/hands`, `origin/codium` and `origin/connected-workspace`. Written 2026-11-11; revised the same day after a review (section 12).

This file **extends** `scratchpad/vector-blend-spec.md` (called "BLEND" below; section numbers like BLEND 4.7). It does not restart anything. The owner's screenshot of today's app (`images/4.webp`) is reference for today's look only, as the owner said: it is the same design as the app today, provided for reference. The Signature screenshot is `images/3.png`.

All relative paths are relative to `docs/vector/design/signature/` (boards in `canvas/`, specs in `specs/`). Repository paths starting `packages/` are inside the checkout.

## Rules (all of BLEND's, plus three)

- Reuse BLEND exactly: frame and wallpaper (2.1), tokens (2.2; no new tokens are added here), type (2.3), icons (2.4), component recipes (2.5), sidebar with logos removed and today's account row (3), session header rows 1 and 2 (4.1, 4.2), composer and chips (4.3, 4.4), transcript pieces (4.7), Tasks pane recipe (4.9), dialog recipe (7.5).
- "You", "Codium Max", "@you". No personal names or emails. No third-party product names, logos, favicons, provider names or model names; Vector's own model is "Codium Auto". Other model names are drawn as skeleton bars (8 tall, radius 4, `rgba(255,255,255,0.08)`), or as neutral local ids ("coder-large", "coder-small", "embed-small"). "GitHub" appears only where today's copy already says it.
- Codium usage shows percentages and the word "Codium", never tokens or prices. **One stated exception: public plan prices** ("$100 a month") in the **Monthly plans list on Settings › Account only**, because today's list shows them (codium-purchase.tsx, `offerPrice` → "$N a month", "name and public price and never what it buys"). The plan tile shows no price, as today (account.tsx: Plan, This month, Renews). BLEND check 8 still says "no prices"; that conflict is open decision 12.
- **Today's controls keep today's words.** Where the brief for these screens used other words, the label stays today's and the brief's word is noted: "Ask Vector to fix" is today's **Ask the agent**; "Fix in a worktree" is today's **Fix in a new workspace**; "Manage subscription" is today's **Manage billing and invoices**. Each is an open decision (section 10).
- Every new behaviour (something today's app does not do) is marked **(new)** where it is specified, and listed in section 11.

---

## 0. What this file changes in BLEND

| BLEND | This file | Why |
|---|---|---|
| 7.1 Vectorscope, one route board (8.10) | Two boards: **Vectorscope-Home** (overview) and **Vectorscope-Review** (one run). Same stage route, same list column, plus an Overview row, run history, evidence chips and re-review marks | The brief asks for an overview and a run screen |
| 7.1 and 8.2: Live edge solid on the whole Vectorscope route | Solid only where the route draws its own gradient tile: Vectorscope-Review (AI review tile) and Vectorscope-Home in `state=signedout` (signed-out tile). Vectorscope-Home's other states keep the gradient Live edge | Home has no AI review tile, so a solid edge would leave the screen with no gradient |
| 7.2 Settings as a full-window takeover (open decision 5, takeover the default) | **Proposal, not decided:** the Settings boards draw Settings as a stage route with the Signature sidebar visible, its own nav as an inner column (section 3.0 gives the case). Today's takeover is drawn by the `shell` tweak | Every screen keeps the Signature sidebar; the owner decides (open decision 1, which is BLEND's open decision 5) |
| 7.2 Settings pages | Three boards: **Settings-General** (also draws Usage & streak, Appearance, Browser, Providers & keys and Agents through its `page` prop, so no BLEND 8.11 page is lost), **Settings-Models** (the Default models page, extended), **Settings-Account** | The brief |
| 7.2 Account profile row: 48 px avatar, "Y" 20/24, "You" alone, line 2 `--vxs-text-2` | 40 px avatar, "Y" 16/20, line 1 "You · Codium Max" in the account row's order and colours, line 2 `--vxs-text-3` (5.95:1 on `--vxs-main`) | It repeats the account row's form the owner liked (BLEND 3.2) |
| 4.9 Tasks pane (8.12 `tasks`) | **Tasks** board: every row kind (subagents, specialists and their helpers, workflows, background commands, interrupted helpers, Vector Hands, cloud computer) with states | The brief |
| 7.4 Search palette (8.12 `search`) | **Search** board: adds a Settings group (new) and the ⌘P files scope | The brief |
| 7.5 MCP and Plugins dialogs (8.12 `mcp`, `plugins`) | **Connections** board: the Connected tools route (More › Connected tools); MCP and Plugins dialogs open from it unchanged. **More › MCP and More › Plugins stay in the More menu** (BLEND 3.4) whatever the owner decides about Connected tools, so both dialogs stay reachable while that item is hidden | The brief; SIG's More menu already reserves "Connected tools" |
| 7.6 Automations (8.12 `automations`) | **Automations** board: list, create flow, created and empty states | The brief |
| 8.10, 8.11, 8.12 | Superseded for these screens (section 8); every BLEND 8.11 Settings page is still drawn | |

---

## 1. Shared pieces for these screens

### 1.1 Board sizes and the stage

| Boards | Artboard | Window | Sidebar | Stage |
|---|---|---|---|---|
| Vectorscope-Home, Vectorscope-Review, Tasks, Search, Connections, Automations | 1600 x 1000 | 1520 x 900 | 264 | 1256 x 900 |
| Settings-General, Settings-Models, Settings-Account | 1440 x 960 | 1360 x 860 | 264 | 1096 x 860 |

Artboard padding 50 top and bottom, 40 left and right (BLEND 2.1). The window, wallpaper, traffic lights and sidebar are copied from BLEND 2.1 and 3 with no change. The stage fill is `--vxs-main`.

### 1.2 Route header (stage routes that are not a session)

A sibling of the session header (BLEND 4.1), used by Vectorscope, Settings, Connected tools and Automations.
- 44 tall, fill `--vxs-main`, padding 0 12 0 20, drag region (controls `no-drag`). No bottom line at rest; a 1 px `--vxs-hairline` fades in over 120 ms once the content scrolls.
- Left: the route glyph 14 px `--vxs-icon` at x 20; title 13/18 weight 500 `--vxs-text` at x 40; 8 px gap; subtitle 12/16 `--vxs-text-3`, ellipsis (shrinks first).
- Right, gap 6: the route's controls (each board lists them), then always a **Close** icon button 24 (14 px ×; aria and tooltip "Close {route}" with an Esc key cap). Esc or ⌘[ returns to the last session or route. Esc first closes an open menu, popover or inline confirmation, and does nothing while focus is in a text field (today's Vectorscope rule, pull-requests.tsx 2079-2101).
- Windows: the header reserves `env(titlebar-area-width)` on the right, as BLEND 4.1.

### 1.3 Columns

- **List column** (Vectorscope): 300 wide, full body height, fill `--vxs-main`, 1 px `--vxs-edge` on its right, padding 8, scrolls on its own (`.vx-scroll`), 12 px mask fade at top and bottom while there is more.
- **Content column**: centred in the remaining width, max-width stated per board, scrolls on its own. Section labels 12/16 weight 600 `--vxs-text-3`, sentence case (BLEND 2.3), 24 px above each section, 8 px below its label.
- **Boxed list** (BLEND 7.2): radius 10, 1 px `--vxs-hairline`, rows separated by 1 px `--vxs-hairline`, row hover `--vxs-row-hover`. Group header rows inside a box are 36 tall with a 1 px `--vxs-hairline` below.

### 1.4 Status words used on these screens

Words stay neutral (`--vxs-text` or `--vxs-text-2`); only the glyph carries colour (SIG principle 3). All chips: 20 tall (18 inside finding cards), radius 10 (9), 1 px `--vxs-hairline-strong`, padding 0 8 0 6, gap 5, 11/14 weight 500 `--vxs-text`, transparent fill. Tooltip carries the long wording.

**Review verdict** (connected-workspace `ConnectFrame.shownVerdict`, VERDICT_WORDS). A run that did not finish never reads as clean.

| Chip | Glyph | Tooltip (today's planned wording) |
|---|---|---|
| Clean | 10 px check-ring `--vxs-ready` | "clean (no blocking finding or concern)" |
| Findings | 6 px dot `--vxs-needs` | "findings (concerns to check)" |
| Blocking | 6 px dot `--vxs-failed` | "blocking (at least one blocking finding)" |
| Incomplete | 10 px dash-ring `--vxs-text-3` | "incomplete (part of the change was not reviewed; see the notes)" |
| Not reviewed | 6 px ring, 1.25 stroke, `--vxs-text-3` | "not reviewed" |

**Finding evidence** (per finding). The brief's three states map onto today's words and the session story's strings (BLEND 8.3: "review.evidence.stale"):

| State (legend word) | Chip label | Glyph | Meaning | Today |
|---|---|---|---|---|
| Checked | "Double-checked" | 10 px check `--vxs-ready` | The verify pass confirmed it at the reviewed head | Today's per-finding chip |
| Missing | "Not double-checked" | 6 px ring `--vxs-text-3` | No verify result on record (verify off for its severity, or the pass stopped first) | Today's word, used on the summary chip only (new per finding) |
| Stale | "Evidence may be stale" | 10 px diamond `--vxs-needs` | Double-checked against an older commit than the reviewed head (a carried finding) | New (the change built in BLEND's Chat story) |

Chip tooltips: Checked "Double-checked at a1c4e02, the reviewed head."; Missing "No evidence on record for this finding."; Stale "Double-checked at 9f8e7d6. The head is now a1c4e02."

**Re-review mark** (per finding, after "Review again"; connected-workspace finding status `fixed | still-open | new`, and the CLI's "returned"). **(new in the desktop)**

| Tag | Glyph |
|---|---|
| New | 6 px dot `--vxs-text` (neutral: a violet dot would read as "running" in the Signature colours) |
| Still open | 6 px ring, 1.25 stroke, `--vxs-text-2` |
| Fixed | 10 px check-ring `--vxs-ready` |
| Returned | 6 px dot `--vxs-needs` (fixed before, back again) |

**Sends to** (connected-workspace `describeSendsTo`). A chip: 20 tall, radius 10, 1 px `--vxs-hairline`, padding 0 8 0 6, gap 5, 12 px glyph `--vxs-icon`, 11/14 `--vxs-text-2`; then a **where tag** for code that stays off the internet: 16 tall, radius 8, padding 0 5, fill `rgba(98,196,141,0.12)`, gap 4, 4 px `--vxs-ready` dot, 10/14 weight 500 `--vxs-text-2` (the C browser concept's "localhost" tag recipe, BLEND 6.0). It reads **"local"** only for this computer (including a model server on localhost) and **"your network"** for a model server reached over the network (e.g. gpu-box:8000), so a networked server is never called local.

| sendsTo | Chip text | Glyph | Where tag |
|---|---|---|---|
| `vector-codium` | "Vector Codium" | Main's `host-cloud` (Main line 171) | none |
| `model-server:gpu-box` | "your model server gpu-box" | `generic-provider` | "your network" |
| `this-computer` | "this computer" | Main's `host-mac` (Main line 170) | "local" |
| `provider:<id>` | "{provider name}, a model provider you configured" (mockups: "Your API key, a model provider you configured"; not drawn on the default boards) | `globe` | no |
| none | "Sends no code" in `--vxs-text-3`, no chip | — | — |

**Cost words** (connected-workspace `describeCost`, BLEND rule): "Codium" on cards ("Vector Codium plan usage" in tooltips); "no charge (local model)"; "no charge (free model)". Own-key prices are not drawn on these boards.

**Place** (Connected tools): "This computer", "GitHub Actions" (GitHub's computers; today's copy names it this way, pull-requests.tsx 1841), "Vector cloud", "Remote server" (a remote MCP URL), each 12/16 `--vxs-text-2` with the 12 px glyph `host-mac`, `globe`, `host-cloud`, `globe`.

**Member state** (connected-workspace `state`): Ready (6 px `--vxs-ready` dot), Busy (10 px orbit `--vxs-running`), Needs you (10 px diamond `--vxs-needs`; used for "Needs authorization", "Needs permissions"), Unavailable (10 px x-ring `--vxs-failed`), Off (6 px ring `--vxs-text-3`), Not installed (6 px ring `--vxs-text-3`). Word 12/16 `--vxs-text`, reason 11/14 `--vxs-text-3` under it.

### 1.5 Icons new to these screens

Drawn per BLEND 2.4: round caps and joins, `currentColor`, stroke as listed.

| Icon | viewBox | Path | Size | Stroke | Source |
|---|---|---|---|---|---|
| `pull` (pull request) | 0 0 16 16 | circles r 1.5 at (4.2,3.6), (4.2,12.4), (11.8,12.4); `M4.2 5.1v5.8M11.8 10.9V6.4a2 2 0 0 0-2-2H7.4m0 0 1.6-1.5M7.4 4.4 9 5.9` | 14-16 | 1.25 | today's sidebar Vectorscope item (workspace-navigation.tsx 618-630) |
| `mcp` | 0 0 16 16 | `M3.25 5.25a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm9.5 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 14.75a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM4.95 4.3l1.8 6.5M11.05 4.3l-1.8 6.5M5.1 3.25h5.8` | 14 | 1.25 | today's sidebar MCP item |
| `plugin` | 0 0 16 16 | `M6.1 1.6v2.7M9.9 1.6v2.7M4.6 4.3h6.8v1.7a3.4 3.4 0 0 1-6.8 0V4.3ZM8 9.4v.9c0 1.5-3.2.9-3.2 2.4 0 1.4 2.7 1.6 4.6.9` | 14 | 1.25 | today's sidebar Plugins item |
| `hands` | 0 0 20 20 | today's UI-kit `hands` path (`git show origin/hands:packages/ui/src/components/icon.tsx`, line 98) | 14 | 1.25 | hands branch |
| `monitor` (cloud computer) | 0 0 16 16 | `M2.5 4.25A1.25 1.25 0 0 1 3.75 3h8.5a1.25 1.25 0 0 1 1.25 1.25v5.5A1.25 1.25 0 0 1 12.25 11h-8.5A1.25 1.25 0 0 1 2.5 9.75v-5.5ZM6 13.5h4M8 11v2.5` | 14 | 1.25 | codium branch hosted-composer.tsx |
| `automation` | 0 0 24 24 | copy Main line 76 | 14-16 | 1.75 | Signature |
| `connected` (route glyph) | 0 0 24 24 | circles r 2.5 at (6,12), (18,6), (18,18); `M8.3 11l7.4-3.8M8.3 13l7.4 3.8` | 14-16 | 1.75 | new |
| `overview` | 0 0 24 24 | `M9 6.5h11M9 12h11M9 17.5h11`; dots r 1 filled at (4.5,6.5), (4.5,12), (4.5,17.5) | 16 | 1.75 | new |
| `sends-to` (the shield on sends-to rows; renamed so it never clashes with the UI-kit `shield` that Spend limits uses) | 0 0 24 24 | `M12 3.5l7 2.6v5.4c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6.1z` | 12 | 1.75 | new |
| `wand` (Apply fix) | 0 0 16 16 | `m2.5 13.5 7.5-7.5M11.5 2v2M13.75 4.5h-2M13 3l-1 1M9 3.5l.75 1M12.75 7.25l-1-.75` | 14 | 1.25 | today's Vectorscope icon set (pull-requests.tsx `ICONS`, line 285; drawn there at stroke 1.3) |
| `comment` | 0 0 20 20 | `M16.25 3.75H3.75V16.25L6.875 14.4643H16.25V3.75Z` | 14 | 1.4 | today's UI-kit `comment` |
| `rule` | 0 0 16 16 | `M4.5 2.5h7a1 1 0 0 1 1 1v10l-4.5-2.5-4.5 2.5v-10a1 1 0 0 1 1-1zM6 6h4M6 8.5h2.5` | 12-14 | 1.25 | today's Vectorscope icon set (pull-requests.tsx line 286) |
| `refresh` (Vectorscope's Review again, Check again) | 0 0 16 16 | `M13 8a5 5 0 1 1-1.46-3.54M13 2.75v2.5h-2.5` | 12 | 1.25 | today's Vectorscope icon set (pull-requests.tsx line 272) |
| `reset` (Settings › Account Refresh, Restore default settings) | 0 0 20 20 | today's UI-kit `reset` path (packages/ui/src/components/icon.tsx line 102) | 12 | 1.25 | today's UI kit (account.tsx and general.tsx use it) |
| `merge` | 0 0 16 16 | circles r 1.5 at (4.5,3.5), (4.5,12.5), (11.5,9); `M4.5 5v6M4.5 5c0 2.5 2 4 5.5 4` | 14 | 1.25 | today's Vectorscope icon set (pull-requests.tsx lines 275-282) |
| `file` | 0 0 24 24 | `M7 3.5h6.5L18 8v12.5H7zM13.5 3.5V8H18` | 14-16 | 1.75 | new drawing |
| `session` (palette rows) | 0 0 20 20 | today's UI-kit `bubble-5` path (icon.tsx line 9), the glyph today's palette draws on session rows (dialog-select-file.tsx 478) | 16 | 1.25 | today's UI kit |
| `chevron-right` | 0 0 20 20 | `M8 15L13 10L8 5` | 12 | 1.75 | today's UI kit |
| Settings nav icons | 0 0 20 20 | today's UI-kit paths (packages/ui/src/components/icon.tsx): `user`, `sliders`, `brain`, `server`, `status`, `shield`, `task`, `providers`, `models`, `circle-check`, `keyboard`, `glasses`, `download`, `checklist`, `link`, `warning`, `hands` | 16 | 1.25 | today |

### 1.6 Sidebar on these boards

BLEND 8.2's sidebar content on every board (verbs, Live 4, Pinned, This Mac, Cloud computer, footer "You · Codium Max"). What differs:

- **Live strip on the Vectorscope boards: Live 3.** BLEND 8.2's "Vectorscope review · PR #2184 `1m`" item is left out, because on these boards run 2 finished 4m ago and the PR rows are enabled. It comes back only in a running state (Vectorscope-Review `state=running`: "Vectorscope review · PR #2184"; Vectorscope-Home `state=running`: "Vectorscope review · Your changes"), with the same elapsed time the progress block implies.
- **Tasks board:** the Live item and the Tasks pane's specialist card show the same elapsed time, `1m`.

| Board | Selected in the sidebar | Live strip top edge |
|---|---|---|
| Vectorscope-Home | Vectorscope verb (`--vxs-row-selected`), meta `3` | **gradient** in idle, running, estimate and local (nothing else on Home draws one); solid `--vxs-accent` 40% only in `state=signedout`, where the signed-out tile is the screen's gradient |
| Vectorscope-Review | Vectorscope verb (`--vxs-row-selected`), meta `3` | solid `--vxs-accent` 40% (the AI review tile is the screen's gradient) |
| Settings-* | nothing; the footer **Settings** gear shows `--vxs-row-selected` with the icon in `--vxs-text`, `aria-current="page"` | gradient (nothing else draws one) |
| Tasks, Search | session "Warn on review model evidence" | gradient |
| Connections | More verb (a More route is open) | gradient |
| Automations | Automations verb, meta `2:00` | gradient |

### 1.7 Dialogs and scrim

BLEND 7.5's dialog recipe and scrim `rgba(0,0,0,0.32)` over the whole window (sidebar included). Menus and popovers: BLEND 2.5 menu recipe.

### 1.8 Hit areas for 20 px controls

Every control drawn 20 tall keeps a **24 px hit area** (BLEND 2.5's header-chip rule: the visual stays 20, a transparent 2 px margin or pseudo-element extends the target to 24). This covers every ghost 20 on these boards (Change, Why, Allow…, Inspect, Hide, Open that task, Open run, Show the latest run, Open in editor) and the 20 x 20 "Sign out of GitHub" icon button in the account pill. Neighbouring 20 px controls sit at least 4 px apart so their hit areas never overlap.

---

## 2. Vectorscope

Stage route opened by the Vectorscope verb (BLEND 7.1, open decision 6 there). The sidebar verb meta is the number of open pull requests in the current project, the same number the header subtitle gives.

### 2.1 Route header and sends-to strip (both screens)

**Route header** (1.2): `vectorscope` lens glyph; title "Vectorscope"; subtitle "vector · 3 open pull requests" (signed out: "Create, review with Vectorscope, and merge without leaving Vector"). Right, gap 6:
- busy text 12/16 `--vxs-text-3` with a 10 px orbit, only while busy: "Checking your GitHub sign-in…", "Loading pull requests…", "Opening the pull request…", "Posting review…", "Creating pull request…", "Merging #2184…" (today's strings);
- **New pull request**: primary pill 24 with a 12 px plus (signed in only; toggles today's create form in the main pane);
- **account pill** (signed in only): 24 tall, radius 12, 1 px `--vxs-hairline`, padding 0 4 0 3, gap 6: 18 px `--vxs-avatar` circle with "Y" 9/12 weight 600 white, "@you" 12/16 `--vxs-text-2`, then a 20 x 20 logout icon button "Sign out of GitHub" (only when the sign-in came from Vector);
- Close ("Close Vectorscope").

**Sends-to strip** (BLEND 7.1, refined): 28 tall, padding 0 20, 1 px `--vxs-hairline` below, gap 8, 12/16 `--vxs-text-2`: `sends-to` 12 px `--vxs-text-3`; "Reviews send the diff to"; the sends-to chip for the current review model ("Vector Codium"); "·" `--vxs-text-3`; "Nothing is posted until you choose Comment, Request changes or Approve" (local only: "Nothing is posted anywhere"). When Vector Local is on and the review model is a cloud model (`state=local`), the first row reads instead: "No cloud review will run while Vector Local is on. Choose a model on your model server to review." `--vxs-text` · "Nothing is posted anywhere" `--vxs-text-2`, with no sends-to chip. On the Review screen it adds, right-aligned, "Review model: Codium Auto" 12/16 `--vxs-text-3` + "Change" ghost 20 (opens Settings › Default models at "Model for each job", section 3.3). When Vector Local blocks GitHub, a second 28 tall row: today's OffInLocal row, "Off in Vector Local · GitHub" 12/16 `--vxs-text`, "Why" ghost 20 (expands the reason under it), "Allow…" ghost 20.

Body under the strip: 900 − 44 − 28 = **828** tall. List column 300 | main pane 955 (scrolls). Main content max 880, padding 24 32 48, centred.

### 2.2 List column (both screens)

Top to bottom, padding 8:
1. **Filter** (text field 28, 14 px magnifier inside at left 8, text from 28), placeholder "Filter by title, number, author or branch".
2. **Overview** row **(new)**: 36 tall, radius 7, padding 0 10, gap 8: `overview` 16 px `--vxs-icon`, "Overview" 13/18 `--vxs-text-row`. Selected on Home (`--vxs-row-selected`, text `--vxs-text`).
3. **Your changes** row (today): 44 tall, radius 7, padding 5 10, gap 8: 16 px lens `--vxs-accent-text`; "Your changes" 13/18 `--vxs-text`; line 2 12/16 `--vxs-text-2`: "3 uncommitted files · " + "+84" `--vxs-diff-add` + " −12" `--vxs-diff-del`. Other line-2 states (today's): "Open a repository to review its changes", "Checking for changes…", "Staged, unstaged and new files", "No uncommitted changes". A review running here shows a 10 px orbit at the right edge.
4. Label "Pull requests" (padding 12 10 4) with "3" 11/14 `--vxs-text-3` after it.
5. **PR rows**: min 56, radius 7, padding 7 10, gap 8, grid `16px 1fr auto`: `pull` 16 px (`--vxs-ready` open; `--vxs-text-3` draft); title 13/18 `--vxs-text`, 2-line clamp; meta 11/14 `--vxs-text-3` "#2184 · @you · 3h ago" (+ "Draft" tag: 16 tall, radius 8, 1 px `--vxs-hairline`, 10/14 `--vxs-text-2`); right column, right-aligned: "+372 −36" 11/14 tabular in diff colours, then the decision 11/14 `--vxs-text-2` with a 6 px dot (Approved `--vxs-ready`, Changes requested `--vxs-failed`, Review required `--vxs-needs`). Disabled at 50% while a review runs. Empty: "No pull requests match." / "Loading pull requests…" / "No open pull requests." 12/16 `--vxs-text-3`, padding 8 10.

   | # | Title | Meta | Diff | Decision |
   |---|---|---|---|---|
   | #2184 | Warn on review model evidence | @you · 5m ago | +372 −36 | Review required |
   | #2179 | Recheck keyboard focus across menu reads | @you · 1d ago | +142 −18 | Approved |
   | #2171 | Shorten Windows installer progress copy | Draft · @you · 2d ago | +12 −9 | Review required |

6. Divider (1 px `--vxs-hairline`, margin 8 2), then **Automatic reviews** row: 44 tall, radius 7, padding 5 10, gap 8: 6 px dot `--vxs-ready`; "Automatic reviews" 13/18; "On: every pull request is reviewed" 12/16 `--vxs-text-2`. Other states (today's): "On: when someone comments /vector review", "A pull request that turns them on is open" (amber dot), "Off: one pull request turns them on", "Off: needs write access to the repository", "Off: needs permission to change workflows" (muted dot). Clicking opens today's Automatic reviews view in the main pane.
7. Divider, then **Checks** (max 42% of the column height): label "Checks" with "scope-evidence" mono 11/14 `--vxs-text-3` right-aligned; run rows 28, radius 6, padding 0 10, gap 8: 6 px dot (in progress `--vxs-needs`, success `--vxs-ready`, failure `--vxs-failed`, other `--vxs-text-3`), "CI · build" 12/16 `--vxs-text-row`, right 11/14 `--vxs-text-3` "success" or an "Inspect" ghost 20 ("Hide" when open; "Reading the log…" while loading).
   - "CI · build" success.
   - "CI · test" failure, expanded on the Review board: "test › review.render · TypeError" 12/16 `--vxs-text` with a 12 px x-ring `--vxs-failed`; log excerpt (radius 8, `--vxs-code`, 1 px `--vxs-hairline`, mono 11/16 `--vxs-text-2`, padding 6 8, max 160 tall): `FAIL  packages/engine/test/cli/review.render.test.ts` / `  ✕ prints saved findings without evidence (4 ms)` / `    TypeError: Cannot read properties of undefined (reading 'text')`; then tint button 24 "Copy fix prompt for the agent" → "Copied, paste it to the agent".
   - Empty: "No workflow runs for this branch."

### 2.3 Vectorscope-Home.dc.html (overview)

**Purpose.** What today's main pane shows when nothing is selected ("Select a pull request") becomes an overview: your uncommitted changes with the Review my changes button, the review model and where the diff goes, open pull requests with their last verdict, and recent runs with verdicts and where each diff went.

**Props** (`data-props`): `state` enum idle | running | estimate | signedout | local (default idle); `evidenceNotes` boolean (default false; today's off-by-default `"modelEvidence": "warn"` notes); `$preview` 1600 x 1000.

**Main pane, top to bottom** (content 880 wide):

1. **Page head** (margin-bottom 16): "Overview" 18/24 weight 600 `--vxs-text`; under it 12/16 `--vxs-text-2` "vector · branch scope-evidence · last review 4m ago".

2. **Two cards side by side**, gap 12: "Your changes" 520 wide, "Review model" 348 wide. Both outline cards (BLEND 2.5), radius 10, 1 px `--vxs-hairline-strong`, transparent, padding 12 14.

   **Your changes** (today's local review entry, moved onto the overview):
   - Head 24 tall, gap 8: lens 16 `--vxs-accent-text`, "Your changes" 13/18 weight 500, spacer, **Check again** ghost 24 with `refresh` 12 (today's "Check again").
   - 12/16 `--vxs-text-2`, margin-top 4: "3 uncommitted files · +84 −12 · compared with your last commit" (diff colours).
   - File rows (margin-top 8), 28 tall, gap 8: `file` 14 `--vxs-text-3`; mono 12/16 directory `--vxs-text-3` + name `--vxs-text-2`; spacer; counts 11/14 tabular. None of these files is among PR #2184's eight changed files, so the checkout still matches the reviewed head (ai-review.ts `chooseCheckout` reviews in place only when every changed file matches) and Apply fix on Vectorscope-Review stays truthful:
     - `packages/engine/src/cli/cmd/` **review.format.ts** +52 −6
     - `packages/engine/test/cli/` **review.format.test.ts** +24 −2
     - `docs/vector/` **review.md** +8 −4
   - Last review line (margin-top 8, 20 tall, gap 6): verdict chip "Clean", 11/14 `--vxs-text-3` "52m ago · coder-large on" + sends-to chip "your model server gpu-box" + "your network" tag.
   - Footer (margin-top 12, gap 8): **Review my changes** primary pill 28 with the 14 px lens (today's button and words); 11/14 `--vxs-text-3` "Sends the diff to Vector Codium · nothing is posted anywhere". In `state=local`: "No review runs until you choose a model on your model server · nothing is posted anywhere".
   - Running (`state=running`): the footer becomes a progress block: 10 px orbit + "Reading your changes…" 12/16 `--vxs-text-2`, a 3 px bar under it (radius 2, track `rgba(255,255,255,0.06)`, a 33% segment `--vxs-running` sliding over 1.4 s; still under reduced motion, at 33%), right **Stop review** danger 24 with an 8 px square; under it 11/14 `--vxs-text-3` "Reviewing the uncommitted changes in your checkout · Codium so far". The list column's Your changes row shows the orbit; PR rows are disabled.
   - Estimate (`state=estimate`, over 50 files): the footer becomes a strip 32 tall, radius 8, fill `--vxs-accent-soft`, padding 0 4 0 10, 12/16 `--vxs-text`: "Your uncommitted changes touch 64 files. Runs on your Vector Codium plan." + **Start review** primary pill 22 + **Cancel** ghost 22; the header busy text reads "Waiting for you to start the review…" (today's strings).
   - No changes: the file rows become a dashed box (1 px dashed `--vxs-hairline-strong`, radius 8, padding 12): "No uncommitted changes" 13/18 weight 500, then today's body 12/16 `--vxs-text-2` "Vectorscope reviews what you haven't committed yet: staged and unstaged edits, and new files git doesn't ignore. Change something in this repository, then check again."; Review my changes disabled.

   **Review model** (new card; every value is today's model choice, ai-review.ts `pickReviewModel`):
   - Label "Review model" 12/16 weight 600 `--vxs-text-3`.
   - Model line 28 tall, gap 8: `generic-provider` 14 at 70%, "Codium Auto" 13/18 weight 500, spacer, **Change** ghost 24 (opens Settings › Default models, "Model for each job", Vectorscope row).
   - Fact rows (24 tall, label 11/14 `--vxs-text-3` left, value 12/16 `--vxs-text` right):
     - "Chosen because" → "Vectorscope role model" (other values, today's order: "Model in .vector/review.json", "Vectorscope role model", "Your agent's model", "First connected model", "Free fallback model")
     - "Sends the diff to" → sends-to chip "Vector Codium"
     - "Cost" → "Codium"
     - "Triage model" → "None"
     - "Rules" → `rule` 12 + ".vector/RULES.md · 3 rules"
   - Note 11/14 `--vxs-text-3`, margin-top 8: "A model set in this repository's .vector/review.json wins. vector sets none."
   - `evidenceNotes` on: a note row (margin-top 8, radius 8, 1 px `rgba(226,171,87,0.30)`, fill `rgba(226,171,87,0.06)`, padding 8 10, gap 8): 12 px diamond `--vxs-needs` + 12/16 `--vxs-text` "Codium Auto has no Vectorscope evaluation on record, so how well it reviews is unmeasured." (origin/vectorscope string, spelt "Vectorscope" in UI copy).

3. **Recent runs** section **(new: today's desktop keeps only the last review per subject, in memory)**. It sits directly under the cards so that all six rows, including the "this computer" and "nothing was sent" runs that show where code went, are above the fold (about 800 of the 828 px body). Label "Recent runs" with, right-aligned, a segmented control (BLEND 2.5) "All | Pull requests | Your changes" (All active). A boxed list; rows min 60, padding 10 12, gap 12, grid `104px 1fr 88px` (104 holds the "Not reviewed" chip); hover `--vxs-row-hover`; click opens that run in the Review screen (its run switcher, 2.4).
   - Column 1: the verdict chip (1.4), top-aligned.
   - Column 2, line 1: subject 13/18 `--vxs-text` + 8 px gap + head or scope mono 11/14 `--vxs-text-3`. Line 2 (12/16 `--vxs-text-2`, items joined by " · " in `--vxs-text-3`, chips inline): model, sends-to chip (+ where tag), cost, duration, counts. Line 3 (11/14 `--vxs-text-3`): where the run came from, and the re-review delta or a note.
   - Column 3: time 11/14 tabular `--vxs-text-3`, right-aligned, + 12 px `chevron-right`.

   Newest first. "Now" on these boards is about 5:00 PM (the Nightly automation's next run, 2:00 AM, is 9h away), so its latest run was today at 2:00 AM: "15h ago" (tooltip "Today at 2:00 AM"), never "2d ago".

   | Verdict | Subject · head | Line 2 | Line 3 | Time |
   |---|---|---|---|---|
   | Blocking | Pull request #2184 · a1c4e02 | Codium Auto · [Vector Codium] · Codium · 2m 04s · 1 blocking · 1 concern · 2 nits | Vectorscope · Review again: 1 fixed · 1 still open · 3 new | 4m ago |
   | Clean | Your changes · 3 files | coder-large · [your model server gpu-box · your network] · no charge (local model) · 3m 40s · no findings | vector review --uncommitted, in the terminal | 52m ago |
   | Findings | Pull request #2184 · 9f8e7d6 | Codium Auto · [Vector Codium] · Codium · 1m 52s · 1 concern · 1 nit | Vectorscope | 2h ago |
   | Not reviewed | Branch scope-evidence vs main | Codium Auto · nothing was sent | Automation "Nightly branch review" · Vector Local was on, so cloud models were refused | 15h ago |
   | Clean | Pull request #2179 · 51d0b7a | Codium Auto · [Vector Codium] · Codium · 1m 10s · no findings | Vectorscope | yesterday |
   | Incomplete | Your changes · 2 files | coder-small · [this computer · local] · no charge (local model) · 10m 00s · 1 nit | /vectorscope in "Recheck keyboard focus across menu reads" · Stopped at the 10-minute time limit; 1 file not reviewed | yesterday |

   Under the box, 11/14 `--vxs-text-3`: "Vector keeps the last 20 runs for each repository on this computer." (new; open decision 4).

4. **Pull requests** section (label "Pull requests 3"), a boxed list, rows 52, padding 0 12, grid `16px 1fr 136px 168px 156px` (156 holds the "Review with Vector" pill), gap 12, click opens the PR in the Review screen:
   - `pull` 16; title 13/18 `--vxs-text` + meta 11/14 `--vxs-text-3` under it; decision 11/14 `--vxs-text-2` with its dot; last review: verdict chip + 11/14 `--vxs-text-3` time; action right-aligned.

   | PR | Meta | Decision | Last review | Action |
   |---|---|---|---|---|
   | Warn on review model evidence | #2184 · @you · +372 −36 · 8 files | Review required | Blocking · 4m ago | **Open** secondary 24 **(new)** |
   | Recheck keyboard focus across menu reads | #2179 · @you · +142 −18 · 5 files | Approved | Clean · yesterday | **Open** secondary 24 **(new)** |
   | Shorten Windows installer progress copy | #2171 · Draft · @you · +12 −9 · 2 files | Review required | Not reviewed | **Review with Vector** primary pill 24 with the lens (today's words) |

   The **Open** button is new (today a PR opens by clicking its list row; the whole table is new with the overview). It does the same as clicking the row.

5. **Automatic reviews** (one outline card row, radius 10, 1 px `--vxs-hairline`, padding 10 14, gap 10): 6 px `--vxs-ready` dot, "Automatic reviews" 13/18 weight 500, "On: every pull request is reviewed" 12/16 `--vxs-text-2`, spacer, **View the workflow** ghost 24, **Actions secrets** ghost 24 with `external` 12 (today's installed-state buttons).

**Signed-out state** (`state=signedout`): header subtitle and controls as 2.1 (no New pull request, no account pill). List column: Overview (selected), Your changes, then in place of the PR section an outline card (radius 10, padding 10 12): "Pull requests" 12/16 weight 600 `--vxs-text-3`, 12/16 `--vxs-text-2` "Sign in to GitHub to see and review this repository's pull requests." **(new copy; today's list column has no such card)**, **Connect GitHub** secondary 24; no Automatic reviews row, no Checks. Main pane: page head; the two cards (Your changes with the footer note "No GitHub sign-in needed · nothing is posted anywhere"); then today's signed-out block, centred, max 520: 40 px tile radius 10, fill `--vxs-gradient-brand` with the lens 20 px in `#0F0D19` (the screen's one gradient), "Review pull requests with Vectorscope" 16/24 weight 600, today's body 13/20 `--vxs-text-2` "A reviewer reads each change and the code around it, a security reviewer joins when sensitive files change, and nothing is posted until you choose to.", and an outline card with today's device sign-in: intro 12/16 `--vxs-text-2` "Vector works with pull requests through your own GitHub account. Sign in once, and Vector encrypts the token with your system's keychain.", **Connect GitHub** primary pill 28, "Not now" ghost 28. Recent runs show only Your changes runs.

**Vector Local state** (`state=local`): the strip's second row (OffInLocal for GitHub). The Review model card: "Sends the diff to" reads "Off in Vector Local" 12/16 `--vxs-text` with a 6 px ring, and a note row (diamond `--vxs-needs`) "Vector Local refuses cloud models. Choose a model on your model server to review." + **Change** secondary 24; **Review my changes** disabled with the tooltip "Choose a model on your model server first".

**Interactions**: Overview and Your changes rows select (Your changes scrolls the main pane to its card); PR rows, PR table rows and run rows show their pressed state and a tooltip "Opens the review" (the run screen is drawn on Vectorscope-Review, not on this board); Review my changes → `running` (Stop review → idle); Check again spins its glyph for 600 ms; segmented filter filters Recent runs; Change opens nothing on the board (tooltip "Opens Settings › Default models").

### 2.4 Vectorscope-Review.dc.html (one review run)

**Moment shown.** Pull request #2184 after commit `a1c4e02` ("Fix the stale label; show evidence in the CLI report"). Run 1 reviewed `9f8e7d6` two hours ago (BLEND 8.10's content: one concern, one nit, one dismissed nit). Run 2 is today's **Review again**: only the files that changed since run 1 were reviewed again (ai-review.ts, review.render.ts, review.render.test.ts); the rest kept their findings. It fixed run 1's concern and found three new findings.

**Props**: `state` enum done | running | posted (default done); `filter` enum all | blocking | concerns | nits (default all); `evidence` enum any | checked | missing | stale (default any); `peek` boolean (default true: the blocking card's code peek is open); `menu` enum none | dismiss | runs (default none); `$preview` 1600 x 1000.

**List column**: 2.2 with PR #2184 selected (`--vxs-row-selected`); Checks shows "CI · test" expanded.

**Main pane, top to bottom** (content 880):

1. **PR head** (BLEND 7.1): status pill "Open" (20 tall, radius 10, 1 px `--vxs-hairline-strong`, 12 px `pull` `--vxs-ready`, 11/14 `--vxs-text`); "#2184" mono 12/16 `--vxs-text-3`; title "Warn on review model evidence" 18/24 weight 600; meta 12/16 `--vxs-text-2` "@you wants to merge into [main] from [scope-evidence] · +372 −36 · 8 files · updated 5m ago" (branch chips 18 tall, radius 5, fill `--vxs-accent-soft`, mono 11/14 `--vxs-accent-text`); right **GitHub ↗** secondary 24.

2. **AI review card** (radius 10, 1 px `--vxs-hairline-strong`, fill `rgba(255,255,255,0.015)`, margin-top 20, overflow visible for menus).

   a. **Header** 52, padding 0 12 0 14, gap 10: 24 px tile radius 7 fill `--vxs-gradient-brand` with the lens 14 px in `#0F0D19` (the screen's one gradient); "AI review" 13/18 weight 600; status 12/16 `--vxs-text-3` "Reviewed a1c4e02 · Codium Auto · Codium · 2m 04s"; spacer; **run switcher (new)**: blend chip "Run 2 of 2 ⌄" 12/16 `--vxs-text-2`; **Review again** secondary 24 with `refresh` 12 (tooltip "Reviews the files that changed since the last review; the rest keep their findings."). Running: Review again becomes **Stop review** danger 24 with an 8 px square.
      - Run menu (`menu=runs`; menu recipe, 300 wide, opens downward right-aligned): heading "Runs on this pull request"; rows 36 (two lines; padding 4 10): verdict chip + "Run 2 · a1c4e02" 13/18 + right "4m ago" 11/14 `--vxs-text-2`, line 2 11/14 `--vxs-text-2` "Codium Auto · Vector Codium · 2m 04s" (current row: 14 px check `--vxs-accent-text`); "Run 1 · 9f8e7d6 · 2h ago" Findings. Picking run 1 shows its findings read-only with a 28 tall note under the header "This is an earlier run. Its findings are as they were at 9f8e7d6." + "Show the latest run" ghost 20.

   b. **This run's destination (new)**: 32 tall, padding 0 14, 1 px `--vxs-hairline` below, gap 8, 12/16 `--vxs-text-2`: `sends-to` 12 `--vxs-text-3`, "This run sent the diff to", sends-to chip "Vector Codium"; when the run used a triage model, it adds "·" `--vxs-text-3`, "triage:" and that model's sends-to chip (+ where tag), e.g. "triage: [your model server gpu-box · your network]" (this run had none, so the board shows only the review model); then "·" `--vxs-text-3`, "Nothing is posted until you choose Comment, Request changes or Approve".

   c. **Re-review strip (new)**: 36 tall, padding 0 14, fill `rgba(255,255,255,0.025)`, 1 px `--vxs-hairline` below, gap 14: "Since the review of 9f8e7d6" 12/16 `--vxs-text-2`; then three marks 12/16 `--vxs-text` each with its 1.4 glyph: "1 fixed", "1 still open", "3 new". Right-aligned 11/14 `--vxs-text-3` (today's carried note): "Only the files that changed since the last review were reviewed again; 2 findings were carried over from the others."

   d. **Body** grid `1fr 200px`, gap 20, padding 14:
      - Summary 13/20 `--vxs-text`: "One blocking finding: the new CLI report reads `evidence` from findings saved before the field existed, so `vector review` stops with an error. One concern about how stale evidence is coloured, and two nits."
      - Grounding chips (margin-top 10, gap 6, 20 tall, radius 10, 1 px `--vxs-hairline`, 11/14 `--vxs-text-2`): "Double-checked 1 · 0 dropped" (10 px check `--vxs-ready`); "1 failing CI check read"; "14 call sites read"; "Repository rules applied" (`rule` 12).
      - Amber note (margin-top 10, radius 8, 1 px `rgba(226,171,87,0.30)`, fill `rgba(226,171,87,0.06)`, padding 8 10, 12/16 `--vxs-text`, diamond 12 `--vxs-needs`): "The double-check stopped at its step limit before it reached 1 finding. That finding reads as not double-checked." (mockup wording for today's "double-check unfinished" note).
      - "Cost by pass" 12/16 weight 600 `--vxs-text-3` (margin-top 12), then mono 11/16 `--vxs-text-2` lines: "Review · Codium Auto · Codium" / "Double-check · Codium Auto · Codium".
      - **Risk card** (right column): radius 8, 1 px `--vxs-hairline`, padding 10 12: "Risk" 11/14 `--vxs-text-3`; "High" 13/18 weight 500 `--vxs-text`; a 3-segment bar (4 tall, radius 2, gap 3, all three `--vxs-failed`); counts 11/14 `--vxs-text-2` with 6 px dots "1 blocking · 1 concern · 2 nits". Counts leave dismissed and fixed findings out (today's `findingSections`).

   e. **Findings toolbar** (1 px `--vxs-hairline` above, padding 10 14, gap 10): "Findings" 12/16 weight 600 `--vxs-text-3`; segmented "All 4 | ● Blocking 1 | ● Concerns 1 | ● Nits 2" (today's filter, BLEND 2.5; the 6 px severity dot before each word; a zero segment disabled at 40%); spacer; **evidence filter (new)**: "Evidence" 11/14 `--vxs-text-3`, then three toggle chips (20 tall, radius 10, 1 px `--vxs-hairline`, 11/14 `--vxs-text-2`, gap 4; pressed `--vxs-row-selected` with text `--vxs-text`): check `--vxs-ready` "Checked 1", ring `--vxs-text-3` "Missing 2", diamond `--vxs-needs` "Stale 1". Pressing one shows only that state; pressing it again clears.

   f. **Sections**, padding 0 14 14, cards 8 apart. Section heads 28 tall: 6 px dot + "Blocking 1" / "Concerns 1" / "Nits 2" 12/16 weight 600 `--vxs-text-2`.

   **Finding card**: BLEND 4.7's Vectorscope finding card (outline radius 10, 1 px `--vxs-hairline-strong`, padding 12 14) with these changes:
   - Header row: lens 14 `--vxs-text-2`, "Vectorscope", "·", severity dot + word, then the **re-review tag** (1.4, 18 tall), spacer, category 11/14 `--vxs-text-3`, then the **evidence chip** (1.4, 18 tall) in place of BLEND's "Double-checked" chip.
   - Location: mono 12/16 `--vxs-text-2` "path:line" with a 12 px chevron after it; clicking toggles the **code peek (new)**: margin-top 8, radius 8, 1 px `--vxs-hairline`, fill `--vxs-code`, mono 11/17, padding 6 0; rows padding 0 10, a 36 px number column (11/17 `--vxs-text-3`, right-aligned, 10 px gap); three lines before and after the anchor; the anchor row fill `rgba(182,159,247,0.10)` with a 2 px `--vxs-accent` bar on its left; footer 24 tall, padding 0 6, right-aligned **Open in editor** ghost 20 (today's open-file glyph 12). The lines are the reviewed version, labelled 11/14 `--vxs-text-3` at the footer's left "as reviewed at a1c4e02".
   - Body, suggested change, apply error and actions: as BLEND 4.7 (Apply fix primary pill 28 with `wand`; **Ask the agent** secondary 28 with `comment`; **Fix in a new workspace** secondary 28 with a 14 px plus; spacer; **Dismiss** ghost 28). Apply fix shows only when the card has a suggested change, the checkout is the reviewed version, and (on a pull request) the finding is double-checked; that is today's rule (ai-review.ts `findingGroups`). On this board the checkout matches a1c4e02: Vectorscope-Home's uncommitted files are outside the pull request's files. If an uncommitted edit later touches the anchored lines, the card shows today's apply error 12/16 in `--vxs-needs` "Those lines changed since the review, so the fix was not applied."
   - **After Apply fix** (today's states, plus one new note): the button reads "Applying…", then "Fix applied" with a 12 px check, disabled (today's words); beside it 11/14 `--vxs-text-3` "in your checkout · not committed" **(new; today's tooltip already says "Nothing is committed")**. The card stays in its section with its tag, severity and evidence; counts, the risk card and the evidence filter do not change; Approve stays off. Apply fix only edits your checkout: the pull request's head still has the finding until a commit is pushed and **Review again** reviews the new head. Only a re-review result may tag a finding **Fixed** or move it to "Fixed since …".
   - Dismiss menu (`menu=dismiss`, on the concern card): BLEND 4.7's menu, 240 wide, opening upward: caption "Dismiss with a reason. It is left out of what you post."; "Not a bug", "Intended behaviour", "Fixed elsewhere", "Won't fix in this pull request"; separator; `rule` 14 + "Don't flag this again" with the hint "Saves a repository rule in .vector/RULES.md that every review reads".

   **Cards, in order:**

   *Blocking 1*
   1. Tag **New**; category "correctness"; evidence **Double-checked**. Title "The CLI report reads `evidence` from findings saved before it existed". Location `packages/engine/src/cli/cmd/review.render.ts:88` (no place note: inside the changed lines). Body: "Findings saved by an earlier version have no `evidence` field, so `EVIDENCE_LABEL[finding.evidence]` is undefined and `label.text` throws. `vector review` then prints nothing for that branch. Treat a missing field as \"missing\"." Peek (open by default):

      | # | Line |
      |---|---|
      | 85 | `function findingLine(finding: Finding, width: number) {` |
      | 86 | ``  const where = `${finding.line}`.padStart(4)`` |
      | 87 | `  const severity = SEVERITY_LABEL[finding.severity]` |
      | 88 | `  const label = EVIDENCE_LABEL[finding.evidence]` (anchor) |
      | 89 | ``  return `${where}  ${severity}  ${label.text}  ${finding.title}` `` |
      | 90 | `}` |
      | 91 | (empty) |

      Suggested change: `−  const label = EVIDENCE_LABEL[finding.evidence]` / `+  const label = EVIDENCE_LABEL[finding.evidence ?? "missing"]`. Actions: Apply fix · Ask the agent · Fix in a new workspace · Dismiss.

   *Concerns 1*
   2. Tag **New**; category "clarity"; evidence **Not double-checked**. Title "Stale evidence prints in the same colour as checked". Location `packages/engine/src/cli/cmd/review.render.ts:97`. Body: "Every evidence state uses the success tone, so in the terminal a stale finding looks verified. Use the warning tone for stale and the dim tone for missing, as severities do." Suggested change: `−  const tone = TONE.ok` / `+  const tone = finding.evidence === "checked" ? TONE.ok : finding.evidence === "stale" ? TONE.warn : TONE.dim`. Actions: Ask the agent · Fix in a new workspace · Dismiss (no Apply fix: not double-checked).

   *Nits 2*
   3. Tag **Still open**; category "naming"; evidence **Evidence may be stale**. Title "`evidenceAt` duplicates `checkedAt`". Location `packages/core/src/review/model-evidence.ts:61` + place note "carried over: this file did not change". Body: "Both fields hold the time the evidence was recorded. Keep `checkedAt` and drop `evidenceAt` so callers read one name." No suggested change. Actions: Ask the agent · Fix in a new workspace · Dismiss.
   4. Tag **New**; category "tests"; evidence **Not double-checked** (nits are not double-checked). Title "The new test builds findings by hand instead of the shared fixture". Location `packages/engine/test/cli/review.render.test.ts:14`. Body: "`review.render.test.ts` writes each finding inline, so it misses fields the fixture keeps current, which is how the missing `evidence` case slipped through. Use `fixtureFinding()` and override what the test needs." No suggested change.
   5. Dismissed (BLEND 4.7 dismissed card, last in Nits): "Prefer `stale` over `old` in copy" struck through `--vxs-text-3`, dot 50%, "Intended behaviour" 12/16 `--vxs-text-3`, **Undo** ghost 24. Carried over from run 1.

   *Fixed since 9f8e7d6* **(new group)**: a 28 tall head "Fixed since 9f8e7d6 · 1" 12/16 weight 600 `--vxs-text-2` with a 10 px check-ring `--vxs-ready` and a 12 px chevron (expanded on the board). Rows 36, radius 7, padding 0 10, gap 8: check-ring 12; title 13/18 `--vxs-text-2` "Stale evidence is labelled as checked"; location mono 11/14 `--vxs-text-3` "ai-review.ts:147"; spacer; tag **Fixed** (1.4); "Fixed in a1c4e02" 11/14 `--vxs-text-3`. Fixed findings never count and are never posted.

   g. "Not reviewed: pnpm-lock.yaml (lockfile)" 12/16 `--vxs-text-3`, padding 0 14 12.

   h. **Post bar** (1 px `--vxs-hairline` on top, padding 10 14, gap 8, fill `rgba(255,255,255,0.02)`): **Comment** primary pill 28 with `comment` 14; **Request changes** secondary 28; **Approve** secondary 28 with a 12 px check, **disabled** (a blocking finding stands; tooltip "Approve is off while a blocking finding stands."); spacer; 12/16 `--vxs-text-3` "Approve is off while a blocking finding stands. · Posting as @you". Dismissed and fixed findings are left out of what is posted; Vector never approves on its own.
      - Posted (`state=posted`): the bar shows a 12 px check-ring `--vxs-ready` + "Review posted with 4 comments on the lines they're about" 12/16 `--vxs-text` + **See it on GitHub ↗** ghost 24.

3. Below the card, 24 apart, each with a section label (BLEND 7.1): **Description** (13/20 body, two paragraphs: "Adds an evidence state to each Vectorscope finding: checked, missing or stale. The review card and the CLI report show a note when evidence is missing or older than the head commit." / "Stale is decided against the head commit time, so carried findings read as stale until they are double-checked again."); **Files changed 8** (rows 28: directory `--vxs-text-3` + name `--vxs-text-2`, +/− right): ai-review.ts +93 −14, pull-requests.tsx +41 −6, model-evidence.ts +38 −9, config.ts +12 −3, en.ts +6 −0, model-evidence.test.ts +128 −0, review.render.ts +23 −4, review.render.test.ts +31 −0; **Conversation 1** (one card: 20 px circle `rgba(255,255,255,0.08)` "Y" `--vxs-text-2`, "@you" 12/16 weight 500, "2h ago" 11/14 `--vxs-text-3`, body 13/20 "Pushed a fix for the stale label and the CLI output."); **Merge card** (BLEND 7.1: merge glyph, "Merge", note, segmented "Squash | Merge commit | Rebase", **Merge…** danger 28 → "Cancel" ghost + "Confirm squash merge").

**Running state** (`state=running`): the header shows Stop review; b, c, d and the findings are replaced by today's progress block (padding 14): 10 px orbit + step 12/16 `--vxs-text-2`, the 3 px sliding bar, and 11/14 `--vxs-text-3` "Codium so far". Steps cycle through today's pull-request list: "Checking for new commits…", "Reading the diff…", "Reading CI results…", "Reading your checkout…", "Finding the code that uses what changed…", "Reviewing with Codium Auto…", "Double-checking 2 findings…". The board shows "Double-checking 2 findings…". The post bar hides; the list column's PR rows are disabled.

**Interactions**: segments and evidence chips filter cards and update section counts; the location chevron toggles the peek; Apply fix → "Applying…" (600 ms) → "Fix applied" with a check and the note "in your checkout · not committed" (the card stays where it is; tags, counts and the disabled Approve do not change); Dismiss opens its menu, a reason dims the card into the dismissed form with Undo; Undo restores it; the run switcher opens the run menu; Review again → `running` for 3 s → `done`; Comment → `posted`; Merge… → confirm pair; list rows behave as 2.3.

### 2.5 Today's Vectorscope controls and where they are

| Today's control | Board | Same words |
|---|---|---|
| Filter field, Your changes row, PR rows, Automatic reviews row, Checks (Inspect, Hide, Copy fix prompt for the agent) | List column | yes |
| New pull request, account pill, Sign out of GitHub, Close Vectorscope | Route header | yes |
| OffInLocal row (Why, Allow…) | Sends-to strip | yes |
| Review with Vector, Review my changes, Review again, Stop review, Start review, Cancel, Check again | Home cards, Review header | yes |
| Review everything again (today's unchanged box: "Nothing changed since the last review, so nothing was sent to a model. These are its findings.") | Review, in place of b-d when nothing changed (not on the default board) | yes |
| Grounding chips, cost by pass, notes, risk meter, severity filter | Review body | yes |
| Apply fix, Ask the agent, Fix in a new workspace, Dismiss + reasons, Don't flag this again, Undo | Finding cards | yes |
| Comment, Request changes, Approve, See it on GitHub ↗ | Post bar | yes |
| Description, Files changed, Conversation, Merge card (Squash, Merge commit, Rebase, Merge…, Confirm) | Below the card | yes |
| GitHub sign-in (Connect GitHub, Not now), create form (Title, Base branch, Description, Create as draft, Create on GitHub), Automatic reviews set-up | Signed-out state; New pull request; Automatic reviews row (today's views, Signature finish) | yes |

---

## 3. Settings

### 3.0 Proposal (open decision 1): a stage route, with the Signature sidebar visible

This is a **proposal for the owner, not a decision.** BLEND 7.2 and 8.11 keep today's full-window takeover as the default, and BLEND's open decision 5 is the same question as this file's open decision 1; when BLEND is next revised, its decision 5 should point here. The Settings boards draw the proposal by default and today's takeover with `shell=takeover`, so the two can be compared side by side.

In the proposal, Settings replaces the **stage** (not the window, not a sheet). The Signature sidebar stays on screen; Settings draws its own page nav as a 224 px column inside the stage.

Why:
1. **Running work stays in reach.** The Live strip keeps showing agents, reviews, Hands and the cloud computer while you change a setting; a "needs you" diamond is one click away. Today's takeover hides all of it until you press Back.
2. **The entry point stays visible.** Settings opens from the account row's gear (and the avatar, at Account). With the sidebar on screen the gear shows its selected state, so you can see where you are and close it from the same place.
3. **It matches the other routes.** Vectorscope, Connected tools, Automations and Agent Dashboard are stage routes with the sidebar visible (BLEND 7.1, 7.3, 7.6). Settings working the same way means one way in and out (Esc, ⌘[, or a sidebar row).
4. **A sheet is too small.** Memory, Usage, Keyboard shortcuts and Vector Local are long pages with tables, lists and heatmaps; a sheet over a live chat also fights the scrim and hides the transcript anyway.
5. **The cost is width**, and it fits: 1096 stage − 224 nav = 872 for content, which holds BLEND 7.2's 720 column with padding. Below a 1000 px stage the nav collapses to a 40 px icon rail (labels in tooltips).

What it drops from today: the nav's identity row ("You / Settings"), because the sidebar's account row shows the same thing right beside it. Nothing else.

The takeover stays drawable for comparison: `shell=takeover` draws BLEND 7.2 (Settings nav replacing the sidebar, identity row and "← Back"). This is open decision 1.

### 3.1 The Settings route shell (all three boards)

Window 1360 x 860; sidebar 264; stage 1096 x 860.

**Route header** (1.2): `gear` 14 px (BLEND 2.4); title "Settings"; subtitle the current nav group, e.g. "Personal". Right: Close ("Close settings").

**Nav column** (224 wide, under the header, full height 816, fill `--vxs-main`, 1 px `--vxs-edge` on its right, padding 8, scrolls with SIG's 12 px mask fade when it overflows):
- **Search field** (text field 28, margin-bottom 8; 14 px magnifier at left 8, text from 28), placeholder "Search settings". It filters by label, group and keywords, with a clear × while it has text. Empty: "No settings found" 13/18 `--vxs-text` and "Try a feature name such as model, memory, update, or notifications." 12/16 `--vxs-text-3` (today's strings), padding 12 10.
- **Groups**: label 12/16 weight 600 `--vxs-text-3`, padding 12 10 4. **Items**: SIG verb rows: 28 tall at a 30 pitch, radius 7, padding 0 10, gap 8, 16 px icon `--vxs-icon`, label 13/18 `--vxs-text-row`; hover `--vxs-row-hover`; selected `--vxs-row-selected` with text and icon `--vxs-text`. Today's page names (settings-registry.ts):

| Group | Items (icon) |
|---|---|
| Personal | Account (`user`), General (`sliders`), Memory (`brain`), Vector Local (`server`), Usage & streak (`status`), Spend limits (`shield`) |
| Agents & environment | Agents (`task`), Providers & keys (`providers`), Default models (`models`), Environment & servers (`server`) |
| Workspace | Repository trust (`circle-check`), Keyboard shortcuts (`keyboard`), Notifications (`status`), Accessibility (`glasses`), Appearance (`sidebar-toggle`; new, BLEND 7.2), Browser (`window`; new, BLEND 6.E) |
| More | Updates & about (`download`) |

  Branch items, only with the `branches` tweak (each appears only when its feature is present, as on the branches): Roadmap vote (`checklist`), Remote (`link`), Production (`warning`) after Account (codium); Vector Hands (`hands`) after Agents (hands).
- **Footer** pinned at the column bottom: 36 tall, 1 px `--vxs-hairline` on top, padding 0 10, 11/14 `--vxs-text-3`: "Vector 1.99.113" left, "Desktop" right.
- Height check: search 44 + 4 group labels 128 + 17 items 510 + footer 36 = 718 of 816. With `branches` on (21 items) the list scrolls.

**Content area** (872 wide, scrolls): column max 720, centred, padding 40 32 64. Page head: title 20/28 weight 600 `--vxs-text`; subtitle 13/20 `--vxs-text-2`, margin-top 4, max 640; 24 below. Sections, rows, controls, boxed lists and tiles: BLEND 7.2 recipes exactly (section title 13/18 weight 600; row min 56, grid `1fr auto`, gap 16, title 13/18 weight 500, description 12/16 `--vxs-text-2`; switch 32 x 18; inline select = blend chip with value 12/16 weight 500 `--vxs-text`, min-width 140, menu opens downward). Long descriptions wrap to the copy column's full width (today's behaviour); none is truncated.

**Shared props**: `shell` enum route | takeover (default route, the proposal); `branches` boolean (default false); `query` string (default "": typing filters the nav).

**Settings-General's `page` prop** (so no page BLEND 8.11 drew is lost): `page` enum general | usage | appearance | browser | providers | agents (default general). Each draws BLEND 7.2's content for that page inside this route shell (or the takeover, with `shell=takeover`): General (3.2), **Usage & streak** (where Codium percentages live, and what the composer's Codium ring opens), **Appearance**, **Browser** (BLEND 6.E), **Providers & keys**, **Agents** (with the Connected tools row, section 6). The nav item and the header subtitle follow `page`.

**Shared interactions**: nav items switch the page. On Settings-General the six pages above switch `page`; Default models and Account show a 13/18 `--vxs-text-3` placeholder "Drawn on Settings-Models" / "Drawn on Settings-Account"; the remaining pages (Memory, Vector Local, Spend limits, Environment & servers, Repository trust, Keyboard shortcuts, Notifications, Accessibility, Updates & about) show "Not drawn in this pass". Switches toggle; selects open blend menus and set the value; search filters the nav.

### 3.2 Settings-General.dc.html

Nav: **General** selected. Header subtitle "Personal". Today's page (settings-v2/general.tsx), every row in today's order and words. One change in copy: the crash-diagnostics description names a third-party service; the mockup says "Vector's crash reporting service" instead.

Title "General". Subtitle "Manage what Vector does while it works, diagnostics, verification defaults, and the terminal shell. Memory has a page of its own."

| Section (description) | Row | Control | Row description |
|---|---|---|---|
| **While Vector works** ("What a message you send, and Stop, do while Vector is working. These apply on this device only.") | Follow-up behavior | select **Steer ⌄** (Steer, Queue) | "Steer, the default, joins your message to the running turn at its next step. Queue holds it until the turn ends. Alt+Enter (Option+Enter on a Mac) does the other for one message; slash commands and shell input always queue." |
| | Stop button | select **Stop the main turn ⌄** (Stop the main turn, Stop the main turn and its helpers) | "What Stop, Esc and Ctrl+G stop. Helpers are the subagents, workflow runs and background commands this conversation started; their partial work is kept, and agent workspaces keep running." |
| **Crash diagnostics** ("Optional technical error reports. Disabled until you explicitly enable them.") | Share crash diagnostics | switch **off** | "Send Vector's version, operating system, and stack traces to Vector's crash reporting service when the interface crashes. Request, user, breadcrumb, and extra fields are removed; repository files, prompts, terminal output, and provider credentials are not intentionally attached." |
| **Usage counts** ("Counted under a random install ID, and your Vector account when you are signed in. On by default.") | Share usage counts | switch **on** | "Sends daily session counts and your token use by model, with your app version and OS. Never your prompts, code or files." |
| **Local data** ("Preferences and caches stored on this device. Repository files are never touched.") | (button row, no title; gap 8) | **Clear application cache** secondary 28 with trash 12 · **Restore default settings** danger 28 with reset 12 | — |
| **Verified completion** ("Have Vector prove its work matches what you asked before it reports done.") | Automatic model routing | switch **off** | "Let Vector switch to a stronger model when it judges a task complex. This spends your own provider key at that model's rate, which can be many times higher than the one you picked. Off by default; the composer always shows the model actually in use." |
| | LLM-as-a-judge | switch **on** | "When Vector finishes a task that changed files, a separate judge compares the result against your request. On a failed verdict Vector repairs it and the judge looks again, up to three rounds. Choose below which tasks it checks; greetings and questions are never judged. Costs extra model calls." |
| | Tasks the judge checks (shown while the judge is on) | select **Large tasks ⌄** (Large tasks, Every task that changes files) | "Large tasks are the ones Vector runs as Thorough: when you ask it to be thorough, or when the agent raises an exceptionally hard request to Thorough. Ordinary work, even when Vector hands parts of it to subagents, is checked only with \"Every task that changes files\", which also covers small fixes." |
| **Terminal** ("The terminal and the composer's shell mode both use this shell.") | Terminal Shell | select **Auto (Default) ⌄** | "Choose the shell used for your terminal. Compatible shells are also used for agent tool calls." |

Interactions beyond 3.1: Restore default settings opens an inline confirmation **(new: today it resets at once and announces "Vector preferences restored.", general.tsx 213-216)** under its row (radius 8, 1 px `rgba(238,131,136,0.30)`, fill `rgba(238,131,136,0.06)`, padding 10 12, 12/16 `--vxs-text` "Restore every Vector preference on this device to its default? Repository files are never touched." + **Restore** danger 24 + **Cancel** ghost 24); a toast pill at the content's top-right (24 tall, radius 12, 1 px `rgba(182,159,247,0.34)`, fill `--vxs-menu`, 12/16 `--vxs-text`, today's announce strings, e.g. "Crash diagnostics enabled.") confirms each switch for 2 s. Turning the judge off hides "Tasks the judge checks".

### 3.3 Settings-Models.dc.html

Nav: **Default models** selected (today's label; the page title stays today's "Models"). Header subtitle "Agents & environment".

The page gathers what the brief asks for in one place: Codium models, your providers' models, local models, and which model does each job (the review model among them). The model lists are today's models page (switches decide what shows in the model picker); the jobs section is the same setting as today's Vector Local › Roles (local-model.ts 611-620), shown here too **(new placement; both pages edit one setting)**.

Title "Models". Subtitle "Choose which models show up in the model picker, and which model does each job." (today's first clause; the second is new). Head right: **Search models** text field 28, 220 wide (today's search).

**Section 1: Vector Codium** ("Models included in your Codium Max plan. Usage shows as a share of this month."). Section head right: a 48 x 4 meter (radius 2, track `rgba(255,255,255,0.08)`, fill `--vxs-accent` 64%) + "64% of this month left" 11/14 tabular `--vxs-text-2`.
Boxed list, rows 48, padding 0 14, gap 12:
- `generic-provider` 16 at 70%; "Codium Auto" 13/18 weight 500 + tag "Default" (18 tall, radius 9, 1 px `--vxs-hairline`, 11/14 `--vxs-text-3`); under it 12/16 `--vxs-text-2` "Picks a Codium model for each step."; right a switch **on, disabled** (tooltip "The default model stays in the picker").
- Six rows whose model names are skeleton bars (widths 112, 96, 128, 104, 88, 120), each with a plan tag **(new: today's models page has no plan tags)** and a switch: four tagged "Plus and up" (switches on, on, off, on), one "Max and up" (on), one "Ultra" (switch disabled, 11/14 `--vxs-text-3` "Not in your plan" before it).
- Footer row 40 inside the box: 11/14 `--vxs-text-3` "Codium usage never shows tokens or prices." + right **View usage** ghost 24.

**Section 2: Your providers** ("Models from providers you connected. Keys live in Providers & keys."). Section head right: **Providers & keys** ghost 24 with `chevron-right` 12.
One boxed list per provider (today's structure):
- "Your API key": group header 36: `generic-provider` 16, "Your API key" 13/18 weight 500, tag "API key", "4 of 12 in the picker" 11/14 `--vxs-text-3`, spacer, 12 px chevron (open). Rows 40, padding 0 14: skeleton name bar (widths 132, 108, 120, 96) + switch (on, on, off, on); then **Show 8 more** ghost 24.
- "Custom provider": header only (collapsed), tag "Custom", "2 of 3 in the picker".

**Section 3: Local models** ("Models on servers you or your company host. Servers are added in Vector Local."). Section head right: **Vector Local** ghost 24 with `chevron-right` 12.
- "gpu-box" boxed list: header 36: `generic-provider` 16, "gpu-box" 13/18 weight 500, mono 11/14 `--vxs-text-3` "http://gpu-box:8000", 6 px `--vxs-ready` dot + "Reachable" 11/14 `--vxs-text-2`, spacer, "3 models". Rows 40: name 13/18 `--vxs-text` + 11/14 `--vxs-text-3` facts + switch:
  - "coder-large" · "128k context · tool calls" · on
  - "coder-medium" · "64k context · tool calls" · on
  - "embed-small" · "Embeddings only" · switch disabled, tooltip "This model can't chat"
- "This computer" boxed list: header `host-mac` 16, "This computer", mono "http://localhost:8080", Reachable, "1 model"; row "coder-small" · "32k context · tool calls" · on.
- Under the boxes: **Add server** ghost 24 (opens Vector Local › Model servers).

**Section 4: Model for each job**, today's Vector Local › Roles section (local.tsx 600-665, local-model.ts `ROLES`, `CHECK_RESULT`) drawn in the blend. Section description, today's: "The model each part of Vector uses. Check runs the role's real tools against the model, two or three requests to its server, only when you press it." then **(new)** "The same setting as Vector Local › Roles."

Rows (min 56): title 13/18 weight 500 (today's label), description 12/16 `--vxs-text-2` (today's), and on the right a blend chip select, then the buttons today's rules allow:
- **Select value.** A job with a model set shows that model (`generic-provider` 14 at 70% + name 12/16 weight 500 `--vxs-text`, chevron). A job with no model set shows today's empty option in `--vxs-text-2`: "Same as the session's model", or for Titles and summaries "Picked by Vector from the allowed models".
- **Check** ghost 24 shows only when the job has a check (every job but Titles and summaries) **and** a model is set for it. Pressing it shows "Checking…" as a line under the description, then the result on that line, 12/16 `--vxs-text-2` with a 6 px dot, in today's words: "Works with Vector's tools" (`--vxs-ready`), "Does not call tools", "Rejected Vector's tool definitions", "Context too small", "The check failed" (`--vxs-failed`), "Needs your answer first" (`--vxs-needs`), plus the engine's message after a full stop when there is one. The result stays; it does not replace the Check button.
- **Load it anyway** secondary 24 (today's outline button) shows after Check only when the result is "Needs your answer first" (the model may not fit in free memory); it runs the check again with the answer given.

| Job (today's label) | Description (today's) | Value on the board | Check |
|---|---|---|---|
| Main agent | "The agent you talk to." | "Same as the session's model" | no (no model set) |
| Subagents | "The agents it starts for parts of the work." | "Same as the session's model" | no |
| Judge | "Checks finished work and Deep research's citations." | "Same as the session's model" | no |
| **Vectorscope** | "Reviews changes you run in Vector." | **Codium Auto** (set; this is why Vectorscope-Home's card says "Chosen because: Vectorscope role model") | **Check** |
| Titles and summaries | "Short helper requests, sent with a small reply limit." | "Picked by Vector from the allowed models" | never (no check for this job) |
| Deep research | "Researches and writes cited reports." | "Same as the session's model" | no |

Today's select lists only models on servers you or your company host (local-model.ts `roleModels`); listing Vector Codium and your providers' models in it, as this page does, is **new** (open decision 6).

The **Vectorscope** row is the review model and carries three sub-lines under its description (indent 0, 20 tall each, 12/16 `--vxs-text-2`, gap 6): "Sends the diff to" + sends-to chip "Vector Codium"; "Triage model: none" + 11/14 `--vxs-text-3` "set in .vector/review.json"; 11/14 `--vxs-text-3` "A model set in this repository's .vector/review.json wins. vector sets none." With the `evidenceNotes` tweak, an "Unvetted" chip (20 tall, 1 px `--vxs-hairline-strong`, 6 px ring `--vxs-text-3`, 11/14 `--vxs-text`) after the model chip; tooltip "Codium Auto has no Vectorscope evaluation on record, so how well it reviews is unmeasured."

**Props** (beyond 3.1): `menu` enum none | review-model (default none); `evidenceNotes` boolean (default false); `local` boolean (default false: Vector Local on).
- `menu=review-model`: the Vectorscope row's model menu is open (menu recipe, 300 wide, max 360 tall, search field on top "Search models"): headings "Vector Codium" (Codium Auto ✓), "Your API key" (three skeleton rows), "gpu-box" (coder-large and coder-medium, each with the "your network" tag), "This computer" (coder-small with the "local" tag). Hovering a row shows its destination as row secondary text 11/14 `--vxs-text-2` ("Sends the diff to your model server gpu-box"). Picking coder-large updates the sub-line chip to "your model server gpu-box" + "your network" tag and the Vectorscope route's strip (shared state on a single board only).
- `local=true`: Sections 1 and 2 get a note row at the top of each (diamond `--vxs-needs`, 12/16 `--vxs-text`) "Off in Vector Local: cloud models are refused." + **Why** ghost 20. **Nothing is dimmed as a block:** only the controls are disabled (switches in their disabled look, Show 8 more and View usage disabled); model names, descriptions, tags, the note and Why stay at full opacity so every line keeps its contrast (dimming text to 50% would drop `--vxs-text-2` to 2.84:1 and `--vxs-text-3` to 2.42:1). Any job set to a cloud model reads "Off in Vector Local" in its chip, in `--vxs-text-3`.

### 3.4 Settings-Account.dc.html

Nav: **Account** selected. Header subtitle "Personal". Today's page (settings-v2/account.tsx), in the account row's form.

Title "Account". Subtitle "Your Vector sign-in, your Vector Codium plan and billing, and what is left of this month's usage." (today's).

**Profile row** (today's account row, larger; padding 16 0, 1 px `--vxs-hairline` below, grid `40px 1fr auto`, gap 12, items centred):
- Avatar 40 px circle, fill `--vxs-avatar` `#9274EC`, "Y" 16/20 weight 500 `#FFFFFF` (a photo when there is one).
- Line 1, one line, 15/20: "You" weight 500 `--vxs-text`, " · " `--vxs-text-3`, "Codium Max" weight 400 `--vxs-text-2` (the account row's colours and order, BLEND 3.2). With the `founding` tweak, the Founding badge (BLEND 3.2 recipe) 6 px after it.
- Line 2: 12/16 `--vxs-text-3` "Signed in to Vector" (today shows the email here; mockups never do).
- The 40 px avatar, the "You · Codium Max" line and the `--vxs-text-3` second line differ from BLEND 7.2's profile row (48 px, "You" alone, `--vxs-text-2`); section 0 lists the change.
- Right: **Sign out** secondary 28. Signed out (`signedIn=false`): avatar is a 40 px ring (1 px `--vxs-hairline-strong`), line 1 "Not signed in" 15/20 `--vxs-text`, line 2 today's "Sign in to connect this app to your Vector account. Your provider keys are managed separately.", right **Sign in to Vector** primary pill 28 ("Cancel sign-in" ghost 28 while signing in).

**Section: Vector Codium** ("Coding models included in your Vector Codium plan. Usage shows as a share of this month."):
- Tiles (BLEND 7.2 tile recipe, grid `repeat(auto-fit, minmax(160px, 1fr))`, gap 8):
  - Plan: label "Plan"; value "Codium Max" 13/18. No price (today's tile shows none; prices appear only in Monthly plans).
  - This month: label "This month"; value "64% of this month's usage left" 13/18; a 4 px meter at 64% (`--vxs-accent`; `--vxs-needs` below 20%, `--vxs-failed` at 0), aria "Share of this month's usage left".
  - Renews: label "Renews"; value "Dec 1".
  - With `founding`: Founding member: "#214" + 11/14 `--vxs-text-3` "Your price won't go up while you stay subscribed." (codium branch).
- Scheduled change (`change=downgrade`): a row under the tiles, 12/16 `--vxs-text`: "Switches to Pro on Dec 1" + **Keep my plan** secondary 24 (today's).
- Buttons (margin-top 12, gap 8, wrap): **View usage** secondary 28 with `status` 12 (opens Usage & streak); **Change plan** secondary 28 (toggles Monthly plans); **Cancel plan** ghost 28; **Manage billing and invoices** ghost 28 with `external` 12 (tooltip "Manage your subscription, card and invoices on vectordev.ai"; this is the brief's "Manage subscription"); **Refresh** ghost 28 with the UI-kit `reset` 12 (today's icon).
- **Paused plan** (`payment=update-card` or `payment=confirm`; today's buttons, account.tsx 355-373): under the tiles, before the buttons, today's notice 12/16 `--vxs-text` and one primary pill 28 (today's "contrast" button): **Update card** (opens the billing portal at the card update) or **Confirm payment** (opens the billing portal to finish a payment).
- **Monthly plans** (shown when `plans=true`, the board default; today's CodiumPurchase list, codium-purchase.tsx): margin-top 12; head: label "Monthly plans" 12/16 weight 600 `--vxs-text-3`, and under it today's line 12/16 `--vxs-text-2` "Each plan renews every month. Usage shows as a share of the month." Boxed list, rows min 48, padding 8 14, grid `1fr 148px`, gap 12. Left: line 1 the plan name 13/18 weight 500 `--vxs-text` + " · " `--vxs-text-3` + the public price 13/18 tabular `--vxs-text-2`; line 2, only when today's code gives one, the action's detail 12/16 `--vxs-text-2`. Right, right-aligned: today's action (codium-billing.ts `offerAction`, lines 80-96). Each row shows the name and public price and never what the plan buys (today's rule), so there are no plan descriptions.

  | Plan · price | Detail line (today's) | Action (today's) |
  |---|---|---|
  | Plus · $10 a month | "Plus starts on your renewal date." | **Switch at renewal** secondary 24 (today's outline button) |
  | Pro · $50 a month | "Pro starts on your renewal date." | **Switch at renewal** secondary 24 |
  | Max · $100 a month | — | "Current plan" 12/16 `--vxs-text-2` (text, no button) |
  | Ultra · $200 a month | "Upgrade to Ultra: $200 today, then monthly from today. Keeps what's left of this month." | **Upgrade** secondary 24 (today's outline button, not a primary pill) |

  With `change=downgrade` the Pro row's action reads "Starts Dec 1" as text and the other rows show no button (today: Keep my plan comes first).
- Coming soon (`codium=soon`, today when plans are not on sale): the tiles are replaced by 12/16 `--vxs-text-2` "Vector Codium plans are not on sale yet. Your plan and this month's usage will show here." and a "Coming soon" tag (20 tall, radius 10, 1 px `rgba(182,159,247,0.32)`, fill `--vxs-accent-soft`, 11/14 weight 500 `--vxs-accent-text`) in the section head; buttons: **See plans** secondary 28, Refresh.

**Section: Your reports** (codium branch; only with `founding` or the `codium` tweak): boxed list rows 40: title 13/18 + "Sent Nov 9" 11/14 `--vxs-text-3`, status tag ("Fixed in 1.99.113" with check-ring / "Looking into it" with ring), right mono 11/14 `--vxs-text-3` commit "c41e2a9" for fixed ones. Rows: "Tasks pane jumps when a card finishes" · Fixed in 1.99.113; "Composer loses focus after a browser step" · Looking into it.

**Section: Delete account** ("Deleting removes your sign-in, stops your CLI tokens and ends any Codium plan. It cannot be undone."): **Delete account…** ghost 28 with label `--vxs-diff-del`. With `delete=true` the confirmation box shows under it (radius 10, 1 px `rgba(238,131,136,0.30)`, fill `rgba(238,131,136,0.06)`, padding 12 14): field label 12/16 weight 500 `--vxs-text-2` "Type your account email to confirm"; text field 28 (placeholder "Your account email"); buttons **Confirm with your Vector sign-in** danger 28, **Keep my account** ghost 28, **Delete on vectordev.ai instead** ghost 28 with `external` 12 (today's buttons).

**Props** (beyond 3.1): `signedIn` boolean (true); `plans` boolean (true); `change` enum none | downgrade (none); `payment` enum none | update-card | confirm (none); `codium` enum plan | soon (plan); `founding` boolean (false); `delete` boolean (false).

The SIG account popover's "Account settings" and "Plans" open this page (Plans with `plans=true` and Monthly plans scrolled into view). The popover's meter line reads "64% of this month left · renews Dec 1" (BLEND 3.3).

---

## 4. Tasks.dc.html

**Layout**: window 1520 x 900. BLEND 8.3's session view (session "Warn on review model evidence"; header row 1 and 2; transcript items 1-13; composer) with the **Tasks pane docked** as the stage's last column: chat column 1256 − 321 = 935 (transcript max 720, centred; composer 720 wide, chips row on one line) | 1 px `--vxs-edge` | pane 320 x 856 (under the 44 header). Header row 1: Tasks **active** (tint fill) with the **needs badge** `3` (BLEND 4.1: a subagent waits on you, so today's count of active tasks shows in the needs colours, background-tasks-button.tsx `data-waiting`; tooltip "Background tasks, 3 active, 1 waiting on you" ⌘⇧B), Changes `6`, Terminal; status chip "Ready" (the main turn is idle; background work runs).

**Props**: `mode` enum docked | floating | expanded (default docked; expanded = `clamp(320px, 46vw, 720px)` = 699 at this window); `hands` enum working | needs | paused | off (default working); `cloud` enum working | control | needs | off (default working); `empty` boolean (default false); `scroll` enum top | lower (default top; see Fold below); `$preview` 1600 x 1000.

**Fold.** The pane body is 856 tall. The header and limits take about 88, the two pinned computer cards about 440, so the specialist card reaches the fold even with its agent table collapsed, and the workflow, waiting subagent, background commands, interrupted helper and Finished rows sit below it. So: the agent table is **collapsed by default** (the Double-check phase row shows its chevron closed; `scroll=top` shows the pinned cards and the specialist card whole), and `scroll=lower` draws the same pane scrolled to its end (the workflow card, the waiting subagent, background commands, the interrupted helper and Finished). Together the two views show every row kind (check 8).

**Pane** (BLEND 4.9 recipe for frame, header, limits line, section heads, cards, phase blocks, agent table, squares):
- Header 40: "Background tasks"; Pop out, Expand, Close (24).
- Limits (12/16 `--vxs-text-3`, today's strings): "3 of 8 running · 1 waiting · 5 of 12 started this request" and "Subagent spend · Codium".

**Pinned computer cards** (above the sections; 8 apart; the pane scrolls with them). Both are shared machines, so each shows whatever session is using it and names that session when it is not this one (hands branch rule for the computer: "Waiting for the computer: … is using it" / "Open that task").

1. **Vector Hands** (hands branch; BLEND 4.9's Hands card): fill `--vxs-card`, 1 px `rgba(146,116,236,0.40)`, radius 10, padding 12.
   - Head: `hands` 14 `--vxs-icon`, "Vector Hands" 13/18 weight 500, spacer, status 12/16 `--vxs-text-2` with glyph: working orbit "Working"; needs diamond "Needs you"; paused pause-bars "Paused".
   - "From Recheck keyboard focus across menu reads" 11/14 `--vxs-text-3` + **Open that task** ghost 20.
   - Step 12/16 `--vxs-text`: "Pressing Tab through Settings › Default models in Vector Dev".
   - App chip (20 tall, radius 6, fill `--vxs-card-2`, 12 px app glyph = Vector's own chip mark, 11/14): "Vector Dev".
   - Meta 11/14 tabular `--vxs-text-3`: "1m 48s · 9 actions".
   - Thumbnail 160 x 100, radius 6, 1 px `--vxs-hairline`, a captured frame of a settings page; click → Watch.
   - Buttons (24, gap 6): **Watch** ghost, **Take over** secondary, **Stop** accent pill.
   - `hands=needs`: status "Needs you"; the step line becomes 12/16 `--vxs-text` "Allow Vector Hands to use Vector Dev?" with today's access warning 11/14 `--vxs-text-3` "It can see the window and use the mouse and keyboard in it."; buttons **Deny** ghost 24, **Allow once** primary pill 24 (armed: a 2 px `--vxs-accent` underline drains over 700 ms before it accepts; today's rule), then **Review in the conversation** ghost 24.
   - `hands=paused`: "Paused — you have control" 12/16 `--vxs-text-2` with pause-bars; buttons **Resume** primary pill 24, **Stop** accent pill 24.

2. **Cloud computer** (codium branch; **(new in Tasks)**: today it is the bar above that session's composer, which stays as BLEND 4.6.9): fill `--vxs-card`, 1 px `rgba(146,116,236,0.40)` (dashed while you have control; `rgba(226,171,87,0.55)` when Vector needs you), radius 10, padding 12.
   - Head: `monitor` 14, "Cloud computer 1" 13/18 weight 500, spacer, status 12/16 `--vxs-text-2`: orbit "Working".
   - "From Reproduce Windows packaging limit" 11/14 `--vxs-text-3` + **Open that task** ghost 20.
   - Title line 12/16 `--vxs-text` (today's bar wording): "Vector is using its cloud computer".
   - Meta 11/14 `--vxs-text-3`: "4m · Standard · 3% of this month's cloud computer hours used".
   - Buttons (24, gap 6, wrap): **Watch** ghost, **Take over** primary pill, **Files** ghost, **Stop** ghost (second press: "Stop now" danger).
   - Link under the buttons: "Done by Morning: 1 queued job · 6:00" 12/16 `--vxs-accent-text`, underlined.
   - `cloud=control`: title "You have control of the cloud computer"; 12/16 `--vxs-text-2` "Control goes back to Vector in 12 minutes, or when you give it back."; buttons **Open control** ghost, **Give back** primary pill, **Files** ghost, **Stop** ghost.
   - `cloud=needs`: an alert line 12/16 `--vxs-text` with a 12 px diamond `--vxs-needs`: "Vector needs you: it reached a password or one-time-code field. Take over to type it yourself." (today's string).

**Running** (section head "Running" with a Stop-all icon button 24, tooltip "Stop all background agents"):

3. **Vectorscope review** (a specialist task whose helpers are Vectorscope's review passes; today's helper sessions "Vectorscope review · #2184 · review | security | verify"):
   - Head: title "Vectorscope review · PR #2184" 13/18 weight 500, Stop button 24.
   - Meta 12/16: "Subagent specialist" `--vxs-text-2` · "1m" `--vxs-text-3` (the same elapsed time as the sidebar's Live item).
   - Counts 12/16 `--vxs-text-2`: "3 helpers · Codium".
   - Description 12/16 `--vxs-text-3`: "Review the changes since 9f8e7d6 and double-check what it finds."
   - "Phases": **Review** (done, "1/1", one grey circle), **Security** (skipped: 11/14 `--vxs-text-3` "No sensitive files changed", one outline circle with dash), **Double-check** (running, fill `rgba(165,140,242,0.08)`, name `--vxs-accent-text`, "1/2", circles: running, pending). Agent table under Double-check, **collapsed by default** (opens with the phase row's chevron) (11/14): Agent | Model | Tokens | Time → "✓ Verify review.render.ts:88" | "Auto" | "Codium" | "22s"; "◌ Verify review.render.ts:97" | "Auto" | "Codium" | "9s". Links: Details · Talk to this subagent · Ask Vector about this · Stop.

4. **Workflow: Release checklist** (today's workflow card):
   - Head: "Release checklist" 13/18 weight 500 + Stop 24.
   - Meta: "Workflow" `--vxs-text-2` · "2m 30s" `--vxs-text-3`. Counts "Stages · 3 of 7 agents · Codium".
   - Stage blocks (radius 8, `--vxs-card-2`, padding 8 10, 6 apart), each a name 12/16, "n/N" 11/14 `--vxs-text-3`, and a 6 px segmented bar (radius 3, gap 2; done `rgba(236,235,239,0.30)`, running `--vxs-running`, waiting `--vxs-needs`, failed `--vxs-failed`, skipped `--vxs-text-2` at 40%, pending 1 px outline `--vxs-text-3`): "Bump versions" 1/1 done; "Packaging dry run" 2/4 (two done, one running, one pending; running block tinted); "Draft the notes" 0/2 pending.
   - Buttons: **Open results** ghost 24.

**Waiting** (no head; the card sits in Running with its waiting mark, as today):

5. **Subagent: list every place that renders evidence**: Head title + Stop. Meta "Subagent" · "**Needs you**" `--vxs-text` underlined · "3m". Under it 12/16 `--vxs-text` "Needs your answer · 3m" + **Answer** secondary 24. Squares: one amber rounded square.

**Background commands** (section head):
6. Row (radius 8, fill `--vxs-card`, padding 8 10, gap 8): 12 px orbit; mono 12/16 `--vxs-text` "pnpm --filter @vector/app dev"; 11/14 `--vxs-text-3` "Running · 2.1 MB of output"; right **Stop** ghost 22, **Open output** ghost 22.
7. Row: 12 px check-ring `--vxs-ready`; "pnpm --filter @vector/core test model-evidence"; "Done · exit 0 · 18 KB of output"; **Open output** ghost 22.

**Interrupted when Vector restarted** (section head, with **Resume all (1)** ghost 24):
8. Card: title "Swarm worker 3"; meta "Subagent" · 11/14 `--vxs-text-3` "Stopped when Vector restarted"; square stopped (outline with dash); **Resume** secondary 24.

**Finished 3 ›** (section head as a toggle, trash icon button 24 "Clear finished"): collapsed.

**Empty** (`empty=true`, hands and cloud off): today's empty state centred in the pane (BLEND 4.9).

**Floating** (`mode=floating`): BLEND 4.9 floating frame (radius 12, opaque, menu shadow, hung 8 under the header at right 12); the chat column takes the full stage behind it.

**Interactions**: Pop out / Dock and Expand switch `mode`; Close closes the pane (the Tasks button loses its active state); phase rows expand their agent tables; Finished toggles; Take over / Give back / Allow once switch the card states; Stop on a card turns its status into "Stopped" with square-stop and moves it into Finished (count 4).

---

## 5. Search.dc.html

**Layout**: BLEND 8.3's session view (full stage, no pane) under the scrim (1.7). The palette is centred on the stage (left = 264 + (1256 − 640) / 2 = 572 window x), top 96 from the window top.

**Palette** (BLEND 7.4 recipe exactly: menu fill, 640 wide, max 480 tall, padding 0; search field 44, 14/22, no icon, 1 px `--vxs-hairline` below; list padding 4 4 8; sticky labels 12/16 weight 600 `--vxs-text-3` on `--vxs-menu`; rows 32, radius 6, padding 0 10, gap 10, 13/18; secondary text `--vxs-text-2`; active row `--vxs-row-selected`). Additions:
- **Match highlight**: the matched characters in a row's title in weight 600 `--vxs-text` (titles are `--vxs-text` already; only the weight changes).
- **Settings group (new)**: rows with the page's nav icon 16 `--vxs-icon` (1.5), title 13/18 `--vxs-text`, breadcrumb 12/16 `--vxs-text-2` "Settings › {page} › {section}". Enter opens the Settings route at that page, scrolls to the row and flashes it (`--vxs-accent-soft`, fading over 2 s). Results come from the Settings search index (today's label, group and keywords).
- **Session rows**: status glyph slot 16 (BLEND 3 status glyphs; empty for idle sessions); title; project 12/16 `--vxs-text-2`; a 12 px host glyph before the project for Cloud computer sessions; time right 11/14 `--vxs-text-2`. Archived rows stay at full opacity (at 70% the secondary text would fall to 3.76:1 at rest and 3.11:1 keyboard-active) and carry an "Archived" tag after the title instead: 16 tall, radius 8, 1 px `--vxs-hairline-strong`, padding 0 5, 10/14 weight 500 `--vxs-text-2` (6.07:1 on the menu fill, 4.66:1 keyboard-active).
- **Files scope** (⌘P): a scope chip inside the field before the text: 20 tall, radius 6, fill `--vxs-row-selected`, padding 0 4 0 8, "Files" 12/16 `--vxs-text` + 14 px × (aria "Search everything"); placeholder "Search files"; only the Files group.

**Props**: `query` enum empty | model (default model); `scope` enum all | files (default all); `$preview` 1600 x 1000.

**Content**

`query=empty` (today's empty list): **Commands**: New task ⇧⌘S; New workspace ⇧⌘W; Previous session ⌥↑; Next session ⌥↓; Toggle terminal ⌃\`; Toggle review ⇧⌘R. **Files** (recent): `packages/engine/src/cli/cmd/` review.render.ts; `packages/app/src/features/pull-requests/` ai-review.ts; `packages/core/src/review/` model-evidence.ts.

`query=model` (field shows "model" with the caret after it):

| Group | Row | Secondary | Right |
|---|---|---|---|
| Commands | **Choose model** | "Open the model picker" | ⌘' |
| | **Cycle thinking effort** | "Light, Balanced, Extra, Max" | ⇧⌘D |
| Files | `packages/core/src/review/` **model-evidence.ts** | | |
| | `packages/core/test/review/` **model-evidence.test.ts** | | |
| | `packages/app/src/components/settings-v2/` **models.tsx** | | |
| Sessions | (check-ring) Warn on review **model** evidence | vector | 2h |
| | Pick a default **model** for subagents | vector-codium | 3d |
| Settings | **Default models** (`models` icon) | Settings › Agents & environment | |
| | **Model for each job** (`models`) | Settings › Default models | |
| | Automatic **model** routing (`sliders`) | Settings › General › Verified completion | |
| | **Model** servers (`server`) | Settings › Vector Local | |

The first row (Choose model) is active. Empty result: "No results found" 12/16 `--vxs-text-3`, 48 tall, centred.

`scope=files` with `query=model`: the scope chip, then only the Files rows.

**Interactions**: typing filters (any query containing "mod" shows the `model` set, otherwise the empty set or "No results found"); ↑ ↓ move the active row across groups; ↵ on a Settings row shows a toast "Opens Settings › Default models" (the board does not navigate); Esc or a scrim click closes; ⌘P toggles `scope`.

---

## 6. Connections.dc.html (Connected tools)

**Route**: More › **Connected tools** (SIG's More menu already lists it, hidden until the owner approves this UI). **More › MCP and More › Plugins stay in the More menu** (BLEND 3.4) in every case, so the MCP and Plugins dialogs never depend on this hidden item. Settings › Agents ends with a one-row "Connected tools" section linking here **(new; today's Agents page has no such row)** (connected-workspace CW-12 planned the full list there; this route replaces that, open decision 5). Members, places, sends-to wording, states and review switches come from connected-workspace (spec 3.1, 3.5, 4.3; core/connect/frame.ts). Nothing here changes what a tool may do; each still asks as today.

**Props**: `filter` enum all | computer | actions | vectorcloud | remote (default all); `selected` enum vectorscope | hands | cloud | none (default vectorscope); `local` boolean (default false: Vector Local on); `dialog` enum none | mcp | plugins (default none); `$preview` 1600 x 1000.

**Route header** (1.2): `connected` glyph; "Connected tools"; subtitle "vector · 14 tools". Right: filter text field 28, 220 wide, placeholder "Filter tools"; Close.

**Content** (column max 1040, padding 24 32 48; stage width 1256 leaves 1192):

1. **Intro**: title 20/28 weight 600 "Everything Vector can use or hand work to"; 13/20 `--vxs-text-2`, max 720: "Where each tool runs, where it sends your code, and whether it can work right now. Every tool still asks before it acts, as it does today."

2. **Vector Local line** (margin-top 16): 36 tall, radius 8, 1 px `--vxs-hairline`, padding 0 6 0 12, gap 8: `lock` 12 `--vxs-text-3`; 12/16 `--vxs-text-2` "Vector Local is off. Tools that send code to Vector's cloud or a provider can run."; spacer; **Vector Local settings** ghost 24. With `local=true`: "Vector Local is on. Tools that send code off your network are off." and the affected rows read Off (below).

3. **Filter row** (margin-top 16): segmented "All 14 | This computer 11 | GitHub Actions 1 | Vector cloud 1 | Remote 1".

4. **Table** (margin-top 12): a boxed list. Column header row 28 (fill `rgba(255,255,255,0.02)`, 11/14 weight 600 `--vxs-text-3`, padding 0 14): "Tool" | "Runs on" | "Sends your code to" | "State" | (actions). Grid `1fr 140px 236px 196px 148px`, gap 12 (148 holds "View the workflow" plus the chevron, about 145, and "Open in Memory", about 128; the Tool column keeps about 244). Group rows 32 (12/16 weight 600 `--vxs-text-3`, padding 0 14, 1 px `--vxs-hairline` below), with a group action right-aligned where listed. Member rows min 52, padding 8 14, hover `--vxs-row-hover`, click selects (expands the detail under it; one at a time):
   - Tool: 16 px glyph `--vxs-icon` + name 13/18 weight 500 `--vxs-text` + summary 12/16 `--vxs-text-2` under it (one line, ellipsis).
   - Runs on: place (1.4).
   - Sends your code to: sends-to chip (1.4), or "Sends no code" `--vxs-text-3`, or the text listed.
   - State: 1.4 (word + reason).
   - Actions: right-aligned buttons 24 or a switch, + a 12 px chevron (rotates 90° when selected).

| Group (action) | Tool | Glyph | Summary | Runs on | Sends your code to | State | Actions |
|---|---|---|---|---|---|---|---|
| Agents | **Vectorscope** | lens | "Reviews changes and finds defects before you ship" | This computer | [Vector Codium] (follows the review model) | Ready · "Codium Auto" | **Open** ghost |
| | **Subagent specialists** | `task` | "Explore, Review, Test, Debug, Security, Performance" | This computer | [Vector Codium] (follows your agent's model) | Ready · "6 on" | **Manage** ghost (Settings › Agents) |
| Tools | **Browser** | `window` | "Opens, reads and clicks pages in Vector's browser" | This computer | Sends no code | Ready | **Open** ghost |
| | **Vector Hands** | `hands` | "Uses apps on your computer" | This computer | [Vector Codium] (follows your agent's model) + 11/14 `--vxs-text-3` line "screenshots, which often show code" | Busy · "Working in Vector Dev" | **Watch** ghost |
| | **Deep research** | `globe` | "Researches and writes cited reports" | This computer | [Vector Codium] (follows the Deep research job's model, Codium Auto) + 11/14 `--vxs-text-3` line "what it reads from this repository's brain and files" | Ready | — |
| Services | **Cloud computer** | `monitor` | "A computer Vector runs for you" | Vector cloud | 12/16 `--vxs-text-2` "Vector's cloud computer" + 11/14 `--vxs-text-3` "asks every time" | Busy · "1 running · 1 queued" | **Watch** ghost |
| | **Automatic reviews** | `pull` | "Reviews every pull request in GitHub Actions" | GitHub Actions | 12/16 `--vxs-text-2` "The model in .github/workflows/vector.yml" | Ready · "On" | **View the workflow** ghost |
| MCP servers (**Manage MCP servers** ghost 24 → MCP dialog) | **filesystem** | `mcp` | "Local command" | This computer | 12/16 `--vxs-text-2` "What the agent passes its tools" | Ready · "Connected" | switch on |
| | **docs** | `mcp` | "Remote URL" | Remote server | "What the agent passes its tools" | Needs you · "Needs authorization" | **Authorize** tint 24 |
| | **tickets** | `mcp` | "Local command" | This computer | "What the agent passes its tools" | Off · "Turned off" | switch off |
| Plugins (**Browse plugins** ghost 24 → Plugins dialog) | **Issue tracker** | `plugin` | "Runs as an MCP server in this repository" | This computer | "What the agent passes its tools" | Ready · "Connected" | switch on |
| | **Error monitor** | `plugin` | "Runs as an MCP server in this repository" | This computer | "What the agent passes its tools" | Needs you · "Needs authorization" | **Authorize** tint 24 |
| Workflows and skills | **Release checklist** | `task` | "Saved workflow · this repository" | This computer | [Vector Codium] (follows your agent's model) | Busy · "Running in Warn on review model evidence" | **Run** ghost (opens "Run a saved workflow", BLEND 7.9) |
| | **Learned skills** | `brain` (UI kit) | "4 skills Vector learned in this repository" | This computer | Sends no code | Ready | **Open in Memory** ghost |

   Under the table, 11/14 `--vxs-text-3`: "Reviews never get MCP tools or plugin tools. Fixes from findings always ask before they write."

5. **Selected detail** (expands under the selected row; padding 4 14 14 42, 1 px `--vxs-hairline` below; grid `1fr 1fr`, gap 24):
   - **Vectorscope** (default): left, fact rows (24 tall, label 11/14 `--vxs-text-3`, value 12/16 `--vxs-text`): "Review model" Codium Auto; "Chosen because" Vectorscope role model; "Last run" verdict chip "Blocking" + "4m ago · PR #2184"; "Runs today" "3"; "Reached through" "/vectorscope, the review tool, the Vectorscope screen". Right, "Review loops" 12/16 weight 600 `--vxs-text-3`, then three compact rows (min 44, title 13/18 weight 500, description 12/16 `--vxs-text-2`, blend select on the right):
     - "Before a commit, push or PR" — "Vector offers a review of its changes before it commits, pushes or opens a pull request." — **Offer ⌄** (Off, Offer, Run).
     - "After a run" — "Report posts a quiet note with the result. Repair sends blocking findings back to the agent." — **Off ⌄** (Off, Report, Repair).
     - "Max rounds" — "Repair rounds for one request." — **2 ⌄** (1, 2, 3); disabled at 40% unless After a run is Repair.
     Then buttons (gap 8): **Review my changes** primary pill 24 with the lens, **Open Vectorscope** secondary 24.
   - **Vector Hands** (`selected=hands`): facts "Permissions" "Screen Recording: Granted · Accessibility: Granted"; "Mode" "Alongside me"; "Screenshots kept" "Until the task ends"; "Always-allowed apps" "Vector Dev"; buttons **Watch** secondary 24, **Hands settings** ghost 24 (Settings › Vector Hands). Hidden unless the hands feature is present.
   - **Cloud computer** (`selected=cloud`): facts "Running" "Reproduce Windows packaging limit · 4m"; "Queued" "Upgrade the site's framework on vectordev.ai · 6:00"; "This month" "3% of cloud computer hours used"; "Asks" "Every hand-off asks, because code goes to Vector's cloud"; buttons **Watch** secondary 24, **Done by Morning** ghost 24.

6. **Vector Local on** (`local=true`). Facts: Vector Local refuses cloud models, and `packages/core/src/local-mode/sources.ts` lists both `mcp-remote` and `github` as `allow-with-reason` (blocked unless you allow them with a reason; policy.ts `blocks`). So:
   - **Cloud computer**: Off · "Off in Vector Local", with **Why** ghost 20 and **Allow…** ghost 20 in Actions.
   - **Vectorscope, Subagent specialists, Release checklist, Vector Hands, Deep research**: Off · "Off in Vector Local: cloud models are refused" (each runs on Codium Auto, directly or through your agent's model).
   - **docs** (the remote MCP server): Off · "Off in Vector Local", with **Why** ghost 20 and **Allow…** ghost 20 in place of Authorize. Any remote plugin reads the same; the two plugins on the board run on this computer and are unaffected.
   - **Automatic reviews**: state "Can't check" (6 px ring `--vxs-text-3`), reason "GitHub is off in Vector Local", with **Why** ghost 20 and **Allow…** ghost 20; the expanded row adds 11/14 `--vxs-text-3` "The workflow itself still runs on GitHub; Vector can't read its state while GitHub is off here."
   - Browser, filesystem, tickets, the two plugins and Learned skills keep their states.

7. **Dialogs**: **Manage MCP servers** and **Browse plugins** open BLEND 7.5's MCP and Plugins dialogs over this route unchanged (`dialog=mcp`, `dialog=plugins`), with the scrim.

**Interactions**: rows select and expand; filter segments and the filter field narrow the table (group rows hide when empty; "No tools match." 12/16 `--vxs-text-3` when nothing does); switches toggle (a server's state follows: on → "Connected", off → "Off · Turned off"); review loop selects set their values (Max rounds enables on Repair); group actions open the dialogs.

---

## 7. Automations.dc.html

**Route** (BLEND 7.6, extended): the Automations verb (meta `2:00`, the next run).

**Props**: `view` enum list | create | created | empty (default list); `$preview` 1600 x 1000.

**Route header** (1.2): `automation` glyph; "Automations"; subtitle "3 scheduled · 1 paused". Right: **New automation** primary pill 24 with a 12 px plus (hidden while the form is open); Close ("Close automations").

**Content** (column max 720, padding 32 32 48):

1. Title 20/28 weight 600 "Work Vector repeats without you". Intro 13/20 `--vxs-text-2`, max 640 (today's): "An automation is one task Vector runs again and again on a schedule. Write the task, pick the repositories it runs in — and in each one whether it starts a new session or continues one you already have — then choose how often it repeats."
2. Three tiles (BLEND 7.2 tile recipe, 3 columns, gap 8, margin-top 20): title 12/16 weight 500 `--vxs-text` + body 12/16 `--vxs-text-2` (today's): "Across repositories" / "One task, one schedule, every repository you select. Each run reports back separately."; "New or existing sessions" / "Keep adding to a thread you already started, or open a fresh session for every run."; "While you are away" / "Vector stays in the tray after you close the window, so runs fire without you here."
3. Missed-run note 12/16 `--vxs-text-3`, margin-top 12 (today's): "Runs that fall due while Vector is fully closed are not replayed one by one — the next start catches up with a single run and says how many it skipped."
4. **Form** (`view=create`; outline card radius 12, 1 px `--vxs-hairline-strong`, padding 16, margin-top 20; BLEND 7.6 field recipe: labels 12/16 weight 500 `--vxs-text-2`, sentence case, 6 above each field, 16 between fields):
   - "What should Vector do, every time?": textarea (text field recipe, min 80, padding 8 10, 13/20), value "Review the scope-evidence branch against main with Vectorscope. List anything blocking and open the findings in this session." (placeholder, today's: "Summarise what changed since yesterday and open issues for anything broken").
   - "Name (optional)": text field 28, value "Nightly branch review" (placeholder "Morning repo brief").
   - "Where it runs": rows 36, radius 7, padding 0 10, gap 10: 14 px checkbox (radius 4; checked fill `--vxs-accent-strong` with a white 10 px check; unchecked 1 px border in `--vxs-text-3`, 5.95:1 on `--vxs-main`; `--vxs-hairline-strong` would be 1.41:1, under the 3:1 a control boundary needs), repository 13/18 `--vxs-text` (no tile), "12 sessions" 11/14 `--vxs-text-3`; a checked row adds, right-aligned, a blend select **Start a new session each run ⌄** (options: "Start a new session each run", then "Continue: {session title}" for each session).
     - ☑ vector · 12 sessions · **Continue: Warn on review model evidence ⌄**
     - ☐ vector-codium · 4 sessions
     - ☐ vector-hands · 5 sessions
     - ☐ vectordev.ai · 2 sessions
   - "Repeat": segmented "Once | Every day | Weekdays | Weekly" (Every day active). Weekly adds "Day" (blend select "Friday ⌄"); Once swaps "Time" for "When" (text field "Nov 12, 2:00 AM").
   - "Time": text field 28, 120 wide, value "2:00 AM".
   - Footer (1 px `--vxs-hairline` above, padding-top 12, margin-top 16, gap 8): summary 12/16 `--vxs-text-3` "Every day at 2:00 AM · first run Nov 12, 2:00 AM" (today's format); spacer; **Cancel** ghost 28; **Create automation** primary pill 28 ("Creating…" while saving; disabled until the task and one repository are set).
5. **Your automations** (label, margin-top 28). Rows: outline card radius 10, 1 px `--vxs-hairline`, padding 12 14, 8 apart.
   - Line 1: title 13/18 weight 500 + optional "Paused" tag (18 tall, radius 9, 1 px `--vxs-hairline`, 11/14 `--vxs-text-3`); spacer; on hover **Pause** / **Resume** ghost 24 and **Delete** ghost 24 (label `--vxs-diff-del` on hover).
   - Line 2: meta 12/16 `--vxs-text-3`: schedule · next run · repositories.
   - Line 3: prompt 12/16 `--vxs-text-2`, 2-line clamp.
   - Target lines (margin-top 6, 20 tall each), 11/14 `--vxs-text-3` with a 12 px glyph: check-ring `--vxs-ready` completed; x-ring `--vxs-failed` failed (+ **Open run** ghost 20); orbit running; dash-ring not run yet; Vectorscope's not-reviewed ring (6 px ring, 1.25 stroke, `--vxs-text-3`, 1.4) for a review run that reviewed nothing.
   - Optional caught-up note 12/16 `--vxs-text` with a 12 px diamond `--vxs-needs` (today's `describeMissedRuns` string).

   | Title | Meta | Prompt | Targets |
   |---|---|---|---|
   | Nightly branch review | Every day at 2:00 AM · next in 9h · 1 repository | Review the scope-evidence branch against main with Vectorscope. List anything blocking and open the findings in this session. | vector · continue: Warn on review model evidence · not reviewed today 2:00 AM (Vectorscope's not-reviewed ring, not the dash-ring, which means "not run yet"), note "Vector Local was on, so cloud models were refused" |
   | Morning repo brief | Weekdays at 8:00 AM · next tomorrow at 8:00 AM · 2 repositories | Summarise what changed since yesterday and open issues for anything broken. | vector · new session each run · completed; vectordev.ai · new session each run · failed + Open run; caught-up note "Caught up with a single run; 2 earlier runs were missed while Vector was closed and will not be replayed." |
   | Weekly review (Paused) | Fridays at 4:00 PM · paused · 1 repository | Write a short review of the week's merged work and what is still open. | vector · continue: Release 1.99.114 checklist · completed |

   In `view=created` the new row ("Nightly branch review", first in the list, here with its first run "not run yet") has a 2 s `--vxs-accent-soft` fill that fades, and a toast pill at the column's top-right (24 tall, radius 12, 1 px `rgba(182,159,247,0.34)`, fill `--vxs-menu`, 12/16 `--vxs-text`): "Automation created · first run Nov 12, 2:00 AM". In the default `list` view the Nightly row exists already with the not-reviewed target as above.
6. **Start from a suggestion** (label, margin-top 28): rows 44, radius 7, padding 0 10, gap 10, hover `--vxs-row-hover`: 12 px dash-ring `--vxs-text-3`; title 13/18 + schedule 12/16 `--vxs-text-3`; description 12/16 `--vxs-text-2` under it. Clicking fills the form with that suggestion (today).
   - "Morning repo brief · Weekdays at 8:00 AM" / "Summarise what changed since yesterday and open issues for anything broken."
   - "Dependency check · Mondays at 9:00 AM" / "Check for outdated or vulnerable dependencies and propose safe updates."
   - "Weekly review · Fridays at 4:00 PM" / "Write a short review of the week's merged work and what is still open."
7. **Empty** (`view=empty`): Your automations shows a dashed box (1 px dashed `--vxs-hairline-strong`, radius 10, padding 16, 12/16 `--vxs-text-3`, today's): "Nothing scheduled yet. Create one above, or start from a suggestion below." The header subtitle reads "Nothing scheduled"; the sidebar verb has no meta.

**Interactions**: New automation → `create` (form slides in, `vx-in`); Cancel → `list`; Create automation → `created`; Repeat segments switch the Day / Time / When fields; checking a repository reveals its session select; Pause / Resume toggles the Paused tag and the meta; Delete shows an inline confirmation in the row **(new: today's Delete removes the automation at once, automations.tsx 364)** ("Delete this automation? Runs already done stay in their sessions." + **Delete** danger 24 + **Cancel** ghost 24); a suggestion fills the form.

---

## 8. Canvas plan

New files in `scratchpad/vector-glass-canvas/project/`, in the same `.dc.html` format as Main (BLEND 8.1: `<x-dc>`, `<helmet>`, `sc-if`, `sc-for`, the `data-dc-script` component with `renderVals()`, the `./support.js` tag). Each copies BLEND 2.1's frame, wallpaper and helpers and BLEND 3's sidebar (with 1.6's selection). Boards that show the session view (Tasks, Search) reuse Chat.dc.html's session markup (BLEND 8.3) when that file exists.

Add to `canvas.json` `boards` and `order`, after BLEND's boards:

| File | x | y | w | h | Title | Interactive |
|---|---|---|---|---|---|---|
| Vectorscope-Home.dc.html | 0 | 4800 | 1600 | 1000 | "Vectorscope: overview" | yes |
| Vectorscope-Review.dc.html | 1680 | 4800 | 1600 | 1000 | "Vectorscope: one review run" | yes |
| Settings-General.dc.html | 3360 | 4800 | 1440 | 960 | "Settings: General and other pages (proposal: stage route; today's takeover in Tweaks)" | yes |
| Settings-Models.dc.html | 4880 | 4800 | 1440 | 960 | "Settings: Models (proposal: stage route)" | yes |
| Settings-Account.dc.html | 6400 | 4800 | 1440 | 960 | "Settings: Account (proposal: stage route)" | yes |
| Tasks.dc.html | 0 | 6000 | 1600 | 1000 | "Tasks pane" | yes |
| Search.dc.html | 1680 | 6000 | 1600 | 1000 | "Search palette" | yes |
| Connections.dc.html | 3360 | 6000 | 1600 | 1000 | "Connected tools" | yes |
| Automations.dc.html | 5040 | 6000 | 1600 | 1000 | "Automations" | yes |

Notes: a `title1` note at (0, 4660), "Screens: Vectorscope, Settings and everyday screens in the blend"; a purple `howto` note at (−480, 4800), w 400: "Vectorscope: Home is the overview (your changes, review model, pull requests, recent runs and where each diff went). Review is one run: findings by severity, evidence (checked, missing, stale), re-review marks. Settings is drawn as a proposal: a stage route with the sidebar kept; the Tweaks `shell` switch shows today's full-window takeover, which BLEND keeps as the default until the owner decides. Settings-General's `page` tweak shows Usage & streak, Appearance, Browser, Providers & keys and Agents. Tasks: the `scroll` tweak shows the lower half of the pane."

Relationship to BLEND's combined boards: these boards supersede BLEND 8.10 (Vectorscope.dc.html), 8.11 (Settings.dc.html) and the `tasks`, `search`, `mcp`, `plugins` and `automations` screens of 8.12 (Everyday.dc.html). **No Settings page is lost:** every page 8.11 drew (general, account, usage, appearance, browser, providers, agents) is drawn here, Account on Settings-Account and the rest on Settings-General through its `page` prop (3.1), and `shell=takeover` draws them in today's takeover. If those BLEND boards are not drawn yet, drop Vectorscope.dc.html and Settings.dc.html from the plan and limit Everyday's `screen` enum to dashboard | launcher | runs | workflow. If they are drawn, keep them and add " (earlier pass; see the Screens row)" to their canvas titles.

---

## 9. Checks before handing the boards over

BLEND 9 applies to every board, plus:
1. Every board with the sidebar shows BLEND 8.2's content, no project letter tile, the always-on project chevron, and the footer "You · Codium Max" with Help and Settings; the selected item matches 1.6.
2. Vectorscope keeps every control in 2.5 with today's words. "Ask the agent" and "Fix in a new workspace" appear on finding cards; "Ask Vector to fix" and "Fix in a worktree" appear nowhere.
3. Evidence appears per finding as one of the three chips in 1.4, and the evidence filter's counts match the cards (Checked 1, Missing 2, Stale 1). Severity counts leave dismissed and fixed findings out (All 4, Blocking 1, Concerns 1, Nits 2; risk counts the same).
4. Every run row and the review card name where the diff went (the review card also names the triage model's destination when one was used), with the "local" tag only for this computer and the "your network" tag only for a networked model server. No provider or model names beyond "Codium Auto" and the neutral local ids; skeleton bars elsewhere.
5. Settings nav labels match today's registry names exactly (Account, General, Memory, Vector Local, Usage & streak, Spend limits, Agents, Providers & keys, Default models, Environment & servers, Repository trust, Keyboard shortcuts, Notifications, Accessibility, Updates & about), plus BLEND's Appearance and Browser. Page titles stay today's ("General", "Models", "Account").
6. Codium usage appears only as "Codium" and percentages. Public plan prices appear only in Settings › Account's Monthly plans list (not in the plan tile), under today's line "Each plan renews every month. Usage shows as a share of the month."; no plan description says what a plan buys; actions read today's "Switch at renewal", "Upgrade" (outline) and "Current plan". BLEND check 8's "no prices" is open decision 12.
7. Today's account copy: no email anywhere ("Signed in to Vector"; "Type your account email to confirm").
8. The Tasks board shows each row kind across its default view and `scroll=lower`: Vector Hands, cloud computer and the specialist with helper phases (agent table collapsed) at the top; workflow with stages, waiting subagent, background commands and interrupted helper lower down. The Tasks button shows the needs badge, and the specialist card and the Live item show the same elapsed time.
9. The Search board shows all four groups for "model", Settings rows with breadcrumbs, and the files scope chip.
10. Connected tools shows place, sends-to and state for all 14 tools; Deep research and Vector Hands show the Vector Codium chip, never "Sends no code"; Automatic reviews runs on "GitHub Actions"; with `local=true`, docs, Deep research, Hands and the cloud-model tools read Off and Automatic reviews reads "Can't check". MCP and Plugins open BLEND 7.5's dialogs unchanged and stay in the More menu.
11. One gradient per screen: on Vectorscope-Review the AI review tile, with the Live edge solid; on Vectorscope-Home the Live edge, except in `state=signedout`, where the signed-out tile is the gradient and the Live edge is solid; on every other board the Live edge only.
12. Hit targets at least 24 px, including every 20 px control through 1.8's hit area; text at least 4.5:1 and icons and control boundaries (checkbox borders) at least 3:1 on their own surface. Row secondary text on hoverable rows of the stage is `--vxs-text-2` or `--vxs-text-3` (`--vxs-text-3` still passes there: 5.33:1 hovered, 4.74:1 selected on `--vxs-main`; it is used for PR meta, Recent runs line 3 and time, suggestion schedules and Connected tools reasons); on menus and the palette it is `--vxs-text-2` only (BLEND 2.5). Nothing that carries text is dimmed with opacity (archived palette rows, the Models page under Vector Local).
13. Nothing was run against the repositories; the boards are checked only by opening the canvas.

---

## 10. Open decisions for the owner

1. **Settings layout.** Today's full-window takeover (BLEND 7.2's default; the `shell` tweak draws it) or the stage route with the Signature sidebar visible (this file's proposal, section 3.0, drawn by default on the Settings boards). This is the same question as BLEND open decision 5.
2. **Fix button words.** Keep today's "Ask the agent" and "Fix in a new workspace", or adopt "Ask Vector to fix" and connected-workspace's planned "Fix in a worktree".
3. **Evidence words.** Chips read today's "Double-checked" / "Not double-checked" plus the new "Evidence may be stale", with a Checked / Missing / Stale legend. Alternatively the chips could read Checked / Missing / Stale directly.
4. **Run history.** New: keep the last 20 runs per repository on this computer, gathering the panel's runs, `/vectorscope` runs saved in sessions, the CLI's branch state files and automation runs. Today the desktop keeps only the last review per subject, in memory.
5. **Connected tools placement.** Its own route under More (this file) or a section at the end of Settings › Agents (connected-workspace CW-12). SIG keeps the More item hidden until the owner approves.
6. **Jobs on the Models page.** Show Vector Local's Roles on Settings › Default models as "Model for each job" (both pages editing one setting), or keep them only in Vector Local. Either way, listing Vector Codium and provider models in a job's select is new: today's select lists only models on hosted servers.
7. **Cloud computer in Tasks.** Add the pinned cloud computer card to the Tasks pane, beside today's bar above that session's composer.
8. **Settings in the Search palette.** Add a Settings group to ⌘K results.
9. **"Manage billing and invoices"** (today) or "Manage subscription".
10. **Overview row** at the top of the Vectorscope list, replacing today's "Select a pull request" empty state.
11. **Code peek** under a finding's location on the Vectorscope route (the route has no Changes panel to jump to).
12. **Plan prices on Settings › Account.** Keep today's public prices in the Monthly plans list (this file; today's codium-purchase.tsx shows them), or follow BLEND check 8 ("no prices") and drop them there too. The plan tile shows no price either way.

---

## 11. What is new against today, and where the facts came from

| New on these boards | Where | Grounded in |
|---|---|---|
| Overview pane, Overview row, Review model card | Vectorscope-Home | ai-review.ts `pickReviewModel` order; local-model.ts role "Vectorscope" |
| Pull requests table with its **Open** buttons | Vectorscope-Home | today's PR rows open on click; the table and button are new |
| Signed-out list card ("Sign in to GitHub to see and review this repository's pull requests.") | Vectorscope-Home | not in today's code |
| "your network" where tag (and "local" kept for this computer) | All sends-to chips | local-model.ts server `class` (this computer vs network) |
| Recent runs with verdict, sends-to, cost, source | Vectorscope-Home, run switcher on Review | connected-workspace `describeSendsTo`, `describeCost`, `shownVerdict`; CLI state files `.git/vector/review/<branch>.json`; hidden helper sessions |
| Per-finding evidence chips and evidence filter | Vectorscope-Review | today's "Double-checked" chip and "Not double-checked" summary chip; the Chat story's `review.evidence.*` strings |
| Re-review strip and marks (Fixed, Still open, New, Returned), Fixed group | Vectorscope-Review | connected-workspace finding status; CLI "Since last local review: … fixed · … still open · … returned"; today's carried note |
| "in your checkout · not committed" note after Fix applied | Vectorscope-Review | today's Apply fix tooltip "Nothing is committed" (pull-requests.tsx 555) |
| Triage destination in "This run sent the diff to" | Vectorscope-Review | ai-review.ts triage model; connected-workspace sends-to wording |
| "This run sent the diff to" row | Vectorscope-Review | connected-workspace sends-to wording |
| Code peek | Vectorscope-Review | today's Changes snippet look, in blend tokens |
| Settings as a stage route; nav without the identity row (proposal) | Settings-* | section 3.0 |
| Restore default settings confirmation | Settings-General | today resets at once (general.tsx 213-216) |
| Connected tools row at the end of Settings › Agents | Settings-General (`page=agents`) | connected-workspace CW-12 |
| Models page sections for Codium, local models and jobs; plan tags on Codium models; Codium and provider models in a job's select | Settings-Models | models.tsx (switch lists, no plan tags), local.tsx and local-model.ts (servers, roles, Check; today's select lists hosted models only) |
| Profile row in the account-row form | Settings-Account | account.tsx; BLEND 3.2. The Monthly plans list, its prices, detail lines and actions are today's (codium-purchase.tsx, codium-billing.ts), not new |
| Pinned cloud computer card, "From {session}" lines | Tasks | codium HostedBar wording; hands queued-card rule |
| Settings group, match highlight, files scope chip, "Archived" tag on session rows | Search | Settings search index (label, group, keywords) |
| Connected tools route | Connections | connected-workspace spec 3.1, 3.5, 4.3; SIG More menu |
| Created-state toast and row flash; Delete confirmation | Automations | today's Delete removes at once (automations.tsx 361-367, home.tsx `deleteAutomation`) |

Repository files read (read-only): `packages/app/src/features/pull-requests/pull-requests.tsx`, `ai-review.ts`; `packages/app/src/components/settings-v2/general.tsx`, `account.tsx`, `account-model.ts`, `models.tsx`, `settings-registry.ts`; `packages/app/src/features/local/local-model.ts`; `packages/app/src/features/background-tasks/background-tasks-pane.tsx`; `packages/app/src/features/scheduled/automations.tsx`, `schedule-model.ts`; `packages/app/src/components/workspace-navigation.tsx`; `packages/app/src/i18n/en.ts`; `git show origin/codium:packages/app/src/components/settings-v2/account.tsx`, `…/features/cloud/hosted/hosted-composer.tsx`; `git show origin/hands:packages/ui/src/components/icon.tsx`; `git show origin/connected-workspace:docs/vector/build/connected-workspace-spec.md`, `…/packages/core/src/connect/frame.ts`. Added in the revision: `packages/app/src/components/codium-purchase.tsx`, `codium-billing.ts`; `packages/app/src/components/settings-v2/local.tsx`; `packages/core/src/local-mode/sources.ts`, `policy.ts`; `packages/engine/src/agent/agent.ts`, `prompt/research.txt`; `packages/app/src/features/background-tasks/background-tasks-button.tsx`; `packages/app/src/components/dialog-select-file.tsx`; `packages/ui/src/components/icon.tsx`; `packages/app/src/pages/home.tsx`. Design inputs: BLEND, SIG, Main.dc.html, images/3.png, images/4.webp (reference only).

---

## 12. Review notes

A review on 2026-11-11 raised 26 points. Each was checked against this file, BLEND and the read-only checkout (origin/main `0dcbb8e2d`). **All 26 held and were applied.** The review, like this file, keeps today's screenshot as reference only and restarts nothing. Where a fix differs from the one suggested, the reason is given below.

- **High 1-7:**
  - **1 Apply fix:** now shows "Fix applied" plus "in your checkout · not committed". The card, its counts and the disabled Approve stay as they were; only a re-review can set Fixed. Today's tooltip confirms it ("Nothing is committed", pull-requests.tsx 555).
  - **2 Home's Live edge:** now the gradient, and solid only in the signed-out state.
  - **3 Connected tools:** Deep research and Hands show the Vector Codium chip. In the Vector Local state, docs, Deep research and Hands read Off, and Automatic reviews reads "Can't check". Confirmed in sources.ts (`mcp-remote` and `github` are `allow-with-reason`, which policy.ts blocks), in research.txt, and in agent.ts (Deep research has read, grep and glob).
  - **4 Local copy on Home:** fixed in the strip and the footer.
  - **5 Prices and plan copy:**
    - The price is gone from the plan tile.
    - The Monthly plans list now uses today's head line, actions ("Switch at renewal", "Upgrade" as an outline button, "Current plan") and detail lines (codium-billing.ts 80-96).
    - The invented plan descriptions are dropped.
    - The Models footer reads "Codium usage never shows tokens or prices".
    - BLEND check 8 is open decision 12.
  - **6 Model for each job:** rewritten to local.tsx 600-665: today's description, result words, no Check on Titles and summaries, Check only when a model is set, the empty-option words and "Load it anyway".
  - **7 Settings pages:** kept through Settings-General's `page` prop.
- **Medium 8-17:** all applied.
  - **8:** the Vectorscope boards show Live 3, and the Tasks board uses `1m` in both places.
  - **9:** Home's uncommitted files moved outside the pull request's files, because ai-review.ts `chooseCheckout` reviews in place only when every changed file matches. Today's apply error is documented too.
  - **10:** Automations uses the not-reviewed ring and the corrected date.
  - **11:** the contrast fixes are applied and the ratios recomputed; they match the review.
  - **12:** see the differences below.
  - **13:** the columns are now 156, 148 and 104.
  - **14:** the Tasks button shows the needs badge.
  - **15:** section 1.8 adds the hit-area rule.
  - **16:** More › MCP and More › Plugins are kept.
  - **17:** each new behaviour is marked (new) and listed in section 11.
- **Low 18-26:** all applied.
  - **18:** Settings is titled as a proposal.
  - **19:** Recent runs moved above Pull requests.
  - **20:** the agent table is collapsed by default.
  - **21:** model servers get a "your network" tag.
  - **22:** the place reads "GitHub Actions".
  - **23:** the triage model's destination is named when one is used.
  - **24:** the profile row change is listed in section 0.
  - **25:** Update card and Confirm payment are added.
  - **26:** the New mark uses a neutral dot.
- **Where the applied fix differs from the review:**
  - **12:** `wand`, `rule`, `refresh` and `merge` come from today's own Vectorscope icon set (pull-requests.tsx `ICONS`), not the UI kit. Only Account's Refresh uses the UI-kit `reset`. Palette session rows use the UI-kit `bubble-5`. `shield` is renamed `sends-to`.
  - **14:** today's badge keeps the count of active tasks (`3`) and turns to the needs colours (`data-waiting`), so the board shows the needs badge `3`.
  - **10:** the Nightly run reads "15h ago" (tooltip "Today at 2:00 AM"), not "today 2:00 AM". That keeps Recent runs' relative times and its 88 px Time column. The rows are re-sorted newest first.
  - **20:** collapsing the agent table is not enough on its own: the pinned cards (about 440 px) and the specialist still reach the 856 px fold. So the board adds a `scroll=lower` view, and check 8 counts both views.
  - **18 and 5:** BLEND was not edited, because this step revises only this file. When BLEND is next revised, its open decision 5 should point to open decision 1 here, and its check 8 to open decision 12.
- **Found while checking:** today's job select lists only models on hosted servers (local-model.ts `roleModels`). Offering Vector Codium and provider models in it is therefore new. It is marked in 3.3, open decision 6 and section 11.
- Nothing was run, installed or changed in any repository; only this file was edited.
