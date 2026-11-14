# Vector Signature: final concept for Vector's glassy desktop shell

Status: final concept for the owner to approve. This is design only. Nothing has been built, no repository file was touched, and nothing was installed or run against the app.

Target: the first release after the Hands, Codium and VectorScope merges (1.99.114 or later), behind a new `shell.signature` flag.

All sizes are CSS px; on the owner's 2x screenshots, 1 pt is about 1 px here. Every colour has an exact dark and light value. Where the candidate concepts or judges disagreed, section 12 records how it was resolved.

**"Glassy" means only what the owner clarified:** the look of the Codex and Claude desktop apps themselves.
- Neutral dark greys.
- A sidebar one step lighter than the content, faintly tinted by the wallpaper.
- Crisp 1 px hairlines.
- Soft inset rounded selection pills.
- Quiet near-white text and calm spacing.
- A soft rounded composer.

It does not mean Apple Liquid Glass, heavy blur or floating glass panels. The shell contains **no CSS `backdrop-filter`**.

---

## 1. The concept in one paragraph

One edge-to-edge sidebar in graphite with a faint violet cast, one step lighter than an opaque reading stage. The sidebar is faintly tinted by the wallpaper through the operating system's own sidebar material (macOS vibrancy, Windows 11 Mica), under a strong tint, and falls back to solid colour in every case where translucency would hurt.

The sidebar holds:
- five verbs;
- a self-hiding **Live strip**, which is Vector's own idea and lists everything happening right now;
- Pinned;
- host-scoped project trees, where child sessions hang off their parent on node-and-edge connectors;
- the account row.

Home is retired. Its jobs move into the sidebar, and "/" becomes a calm empty state built around the composer. It shows the Vector chip mark as the one brand moment on the screen.

---

## 2. Design principles (5)

1. **Calm material, opaque reading.** Translucency exists in one place only: the native window material showing through the sidebar's tint. Everything people read (stage, transcript, composer, menus) is opaque. There is no CSS blur, no floating panel and no glass on glass.
2. **Live work is never buried.** Anything running, waiting on you, or recently failed appears in one capped Live list, whatever the grouping, scroll position or collapse state. When the sidebar is hidden, the list becomes a pill in the header.
3. **Shape carries status; colour never carries text.** Every status pairs a distinct shape with a colour and has a tooltip and a legend. Words stay in neutral greys. Emphasis changes colour only, never weight, so text never reflows.
4. **Stable and keyboard-first.** Hosts, projects and Live order never reshuffle on their own. The tree is a real ARIA tree, and every action has a key path.
5. **Vector's own, with one brand moment per screen.** Vector's names, icons, palette and status shapes are used throughout. Lavender appears only for running work, focus, Send and accent words. The Vector gradient appears once per screen.

---

## 3. Layout at a glance

Mac, 1280 x 800, dark theme, flush frame (the default), sidebar expanded to 264 px, with one session open.

```
x0                          264                                                    1280
+---------------------------+------------------------------------------------------+ y0
| o o o  [|]  <  >   [◇|▤]  |  Warn on review model evidence v     +318 −32 ⌨ ▤ ↗  |  44 chrome / header
|  ✎  New session           |------------------------------------------------------|  (header hairline only once scrolled)
|  ⌕  Search                |                                                      |
|  ↻  Automations     2:00  |        transcript column, max 720, opaque            |
|  ◎  Vectorscope        3  |                                                      |
|  ⋯  More                  |                                                      |
| .=Live 4==============v.  |  <- 1 px Vector-gradient top edge (static)           |
| | ◆ Fix Codium P8 CI [Review]                                                      |
| | ◌ Recheck keyboard f… 12m|                                                      |
| | ◌ Vectorscope review…◎ 1m|                                                      |
| | ◌ Reproduce Windows… ☁ 4m|                                                      |
| '-------------------------'|                                                      |
|  Pinned                   |                                                      |
|     Release 1.99.114 ch… 1d|                                                     |
|  ▭ This Mac •          +  |                                                      |
|  [V] vector  main       4 |                                                      |
|   ◌ Recheck keyboard fo… 12m                                                      |
|    ╰• ◌ Swarm worker 2 +142 −18                                                   |
|    ╰• ✓ Review: Hands Wi… 12m                                                     |
|  ▐✓ Warn on review mode… +318 −32▌ (selected pill)                                |
|   × Give the packaging d…  2h|   .----------------------------------------------. |
|     Checks failed · 3     |   | +  Reply, @ for files, / for commands   🎙 [↑] | |  composer, radius 14
|   Shorten Windows instal… • 3h '----------------------------------------------' |
|  [C] vector-codium  codium|   ▭ This Mac · [V] vector v · scope-evidence v      |  chips row (left: where)
|   ◆ Fix Codium P8 CI    2m|              Auto v · Balanced · Manual · ◔ 64%     |  (right: how)
|     Wants to run pnpm i…  |                                                      |
|  [H] vector-hands       5 |                                                      |
|  [V] vectordev.ai       2 |                                                      |
|  ☁ Cloud computer •    +  |                                                      |
|---------------------------|                                                      |
| (Y) You · Codium Max [Founding]  ?  ⚙                                            |  48 footer
+---------------------------+------------------------------------------------------+
```

---

## 4. Information architecture

### 4.1 Shell frame

- **Grid.** The shell is a CSS grid: `sidebar | stage | side panel (optional)`. The sidebar appears on **every route**, including "/", "/code", "/work" and "/cloud". Today's `navUnlocked()` rule, which hides the sidebar on those routes, is removed.
- **Flush frame (default).** The sidebar runs edge to edge: full height and flush with the window's left, top and bottom edges, with no radius and no shadow. Its right edge is a 1 px `--vxs-edge` line. The stage starts exactly at that line, is opaque, and has no inset.
- **Inset card frame (A/B option, owner to choose).** This option is shown in the mockup as a toggle and stored as Settings › Appearance › Frame: Flush / Inset card.
  - The stage becomes a card: left = sidebar width, top = 6, right = 0, bottom = 0.
  - Radius 10 on the top-left corner only (8 on Windows), with a 1 px `--vxs-edge` hairline on the top and left edges.
  - The 6 px strip above the card is the same sidebar material and acts as a drag region.
  - The card header is 32 tall (y 6–38), so its centre stays on the same chrome line (y 22) as the traffic lights, and no window-button repositioning is needed.
  - In this mode the sidebar's own right edge line is dropped, because the card hairline replaces it.
- **Side panel.** Opaque, flush, with a 1 px left hairline. It holds Changes, Browser, Context, Tasks and Vectorscope.

### 4.2 Sidebar, top to bottom

The fixed blocks are A (chrome), B (verbs), C (Live), G (update row) and H (footer). Only D–F scroll. The scroller shows a 12 px `mask-image` fade at its top and bottom edges while there is content beyond them.

#### A. Chrome row (44 tall, drag region)
The row is `-webkit-app-region: drag`. Every control inside it is `no-drag`. All controls are centred on the chrome line, y = 22.

**Mac**
- Traffic lights at `trafficLightPosition {x: 16, y: 16}`. They span x 16–68.
- Sidebar toggle, 28 x 28 at x 78, with the 16 px `sidebar` icon (`sidebar-open` when the sidebar is collapsed).
- Back at x 106 and Forward at x 134, each 28 x 28 with a 12 px chevron. Shortcuts are ⌘[ and ⌘]. With no history, the button draws in `--vxs-text-disabled` and does nothing.
- **Agent | Editor switch**, right-aligned 8 px from the sidebar edge.
  - Overall 56 x 26. The track has radius 8, fill `--vxs-seg-track`, and a 1 px `--vxs-hairline` border.
  - Two 26 x 22 segments, inset 2, radius 6. Glyphs are Vector's own `mode-agent` (the chip glyph) and `mode-editor` (file tree).
  - The active segment is filled `--vxs-seg-active` with its icon in `--vxs-text`. The inactive icon is `--vxs-text-3`.
  - Tooltips: "Agent ⌘⇧E" and "Editor ⌘⇧E". The highlight slides between segments in 140 ms.
- At the minimum width of 236 the switch starts at x 172, leaving a 10 px gap after Forward, which ends at 162. That gap sets the minimum width.

**Windows**
- A 28 x 28 app-menu button at x 8 showing the monochrome Vector chip mark. It opens the existing `WindowsAppMenu`.
- Then the toggle at x 40, Back at x 68 and Forward at x 96, with the switch right-aligned as on Mac.
- Caption buttons come from `titleBarOverlay` (height 44) and sit over the top-right of the **stage**, never the sidebar.

#### B. Verbs (5 rows, never more)
- Rows are 28 tall at a 30 px pitch (density-scaled; see 7.6), starting 4 px below the chrome row.
- Pill: inset 8 from both edges, radius 7.
- Icon: 16 px at x 18, in `--vxs-icon`.
- Label: at x 42, 13/18 weight 400, in `--vxs-text-row`.
- Meta: right-aligned at W − 18, 11/14 tabular, in `--vxs-text-3`. A shortcut hint shows on hover only, also in `--vxs-text-3`.
- Plugins can never add rows here. New items go into More.

| # | Label | Icon | Meta at rest | Action |
|---|---|---|---|---|
| 1 | New session | `compose` | (⌘N on hover) | Opens the empty state (4.7) on the current host and project, with the composer focused |
| 2 | Search | `magnifier` | (⌘K on hover) | Palette over sessions on all hosts, projects, commands and files. ⌘P opens it scoped to Files |
| 3 | Automations | `automation` (a clock with a loop arrow) | next run, e.g. `2:00`; `Paused` when everything is paused; a failed glyph (×) when the last run failed | Opens the existing Automations modal (unchanged in v1) |
| 4 | Vectorscope | `vectorscope` (a lens) | number of reviews waiting, e.g. `3` | Opens the Vectorscope review panel in the side panel |
| 5 | More | `dots` | none | Opens the More menu: 240 wide, anchored to the right of the row |

**More menu**, top to bottom, with separators where marked:
- Agent Dashboard
- Coordinated runs, with a count when any exist
- Browser
- Code editor
- Terminal
- *separator*
- MCP
- Plugins
- Connected tools (hidden until the owner approves that UI)
- *separator*
- Vector Cloud (only until the Cloud computer host exists)
- Getting started `3/7` (hidden once complete)

#### C. Live strip (Vector's own; see 4.3)
Shown only while something is live, with 12 px of space above it.

#### D. Pinned (shown only when not empty)
- Header row, 24 tall: "Pinned" at 12/16 weight 600 in `--vxs-text-3`, at x 18.
- Up to 8 pinned sessions or projects from any host. Rows from a host other than This Mac carry a 12 px host badge in the meta slot.
- Drag to reorder. A pinned row also stays in its own project group.

#### E. Host groups
There is one group per host, in a fixed order:
1. This Mac (This PC on Windows).
2. Paired remote servers, alphabetical. This makes today's unused `HomeServerRow` code real.
3. Cloud computer (after Codium merges; behind its feature check).
4. Paired phones, which only appear as hosts when they run sessions.

Host order never changes because of activity. The user can drag hosts to reorder them.

**With 1 or 2 hosts**, every group is stacked in the sidebar.

**With 3 or more hosts**, the host header becomes a **switcher** and the tree shows one host at a time (This Mac by default).
- The host name gains a `⌄`. Clicking it opens the **host popover** (280 wide). It lists each host with its glyph, connection dot, running count and needs-you count, followed by:
  - All hosts (stacked view)
  - Pair a phone…
  - Add server…
- Cross-host attention is never lost, because Live always lists every host.

**Host header row (28 tall)**
- 14 px host glyph at x 18: `host-mac`, `host-pc`, `host-server`, `host-cloud` (a cloud with a small screen) or `host-phone`. On hover the glyph becomes a 12 px collapse chevron. Clicking the header collapses or expands the group.
- Name at x 40, 12/16 weight 600, in `--vxs-text-2`.
- A 6 px connection dot, 6 px after the name:
  - Ready: `--vxs-ready`. Tooltip "Runtime ready".
  - Reconnecting: a static 6 px ring (1.5 px stroke) in `--vxs-needs`, followed by "Reconnecting…" at 11 px in `--vxs-text-3`.
  - Offline: a `--vxs-text-3` ring followed by "Offline".
- Always visible: `+`, a 24 x 24 button at the right. It opens the **host add menu**:
  - New session on This Mac ⌘N
  - Open a folder…
  - Clone from GitHub…

  The `+` always acts on its own host.
- On hover: **View**, a text button (12/16 in `--vxs-text-2`, 24 tall, padding 0 6) placed left of `+`. It opens **View options**:
  - Group by: Project (default) / Status / Recent
  - Sort projects: Manual (default) / Recent activity
  - Second line: Attention only (default) / All rows
  - Density: Compact / Default / Comfortable
  - Show archived
  - Mark all read
  - Status legend
  - Host settings…
  - Disconnect (remote hosts only)
- A collapsed host header shows its active-session count at 11 px in `--vxs-text-3`. If anything on that host needs you, it also shows a diamond glyph and that count.

**Grouping options**
- **Status:** sections Needs you / Running / Ready to review / Done / Idle, each with a count. Order inside each section is stable (by start time).
- **Recent:** a flat list with date sub-headers: Today / Yesterday / This week / Older.
- Parent/child nesting is kept in every grouping.

#### F. Projects and sessions (inside each host)

**Project header row** (28 tall; 4 px gap above each project)
- 16 px letter tile at x 18, radius 4.
  - The letter is the first letter of the last hyphen-separated part of the folder name: `vector-hands` gives H, `vector-codium` gives C, `vector` gives V.
  - The tile colour is picked from the tile palette (7.1) by hashing the folder path.
  - The letter is 10/12 weight 600.
- Name at x 42, 13/18 weight 500, in `--vxs-text`. Groups are keyed on the real folder or worktree, never the git remote, and always show the short folder name, never a full path.
- Branch chip, shown only when the branch is not the default: mono 11/14 in `--vxs-text-3`, 6 px after the name.
- Meta: the number of active sessions in `--vxs-text-3`. If any session needs you, the meta is a diamond glyph followed by that count.
- On hover:
  - The tile becomes a 12 px chevron.
  - The meta is replaced by `+` (new session in this project) and `⋯`, each 24 x 24.
  - The `⋯` menu holds: New session, Edit repository…, Trust settings…, Reveal in Finder / Show in File Explorer, Close repository.
- Double-clicking the header starts a new session.
- Projects keep a manual order set by dragging. A new project goes to the top **once** and never moves on its own after that.
- Projects are collapsed by default, except the project of the open session and any project with live work.

**Sessions under a project**
- Shown: the 6 most recent, plus every session that is running, needs you, unread or failed.
- Then a "Show N more" row: 26 tall, 12/16 in `--vxs-text-3`, at x 42.
- At the end of each host group, "View all" opens All sessions / Archived in the stage. That view keeps the Today / Yesterday / Older groups and is virtualised.
- A session is archived automatically when its pull request merges. The archive can be undone from Archived.

**Session row anatomy** (default density, sidebar width W = 264)
- **Pill:** x 8 to W − 8, radius 7. Height 28 on one line, 44 on two lines.
- **Status slot:** 16 x 16 at x 18, with the glyph centred at x 26 (see 7.10).
- **Title:** at x 42, 13/18 weight 400.
  - Colour: `--vxs-text-row` at rest; `--vxs-text` when the row is selected, needs you, is unread or failed. Colour changes only; the weight never changes.
  - Long titles fade out over their last 20 px using `mask-image`, instead of an ellipsis. The full title is in the tooltip and the `aria-label`.
- **Meta slot:** right-aligned at W − 18, 11/14 tabular, in `--vxs-text-3`. On the selected pill it switches to `--vxs-text-2`, because `--vxs-text-3` there is only 4.2:1. The first matching entry wins:
  1. On hover: two 24 x 24 icon buttons, Archive and `⋯`, with a 2 px gap.
  2. On a collapsed parent: the child count, e.g. `3`.
  3. On parallel workspaces and worktrees: the diff, e.g. `+142 −18`, with `+` in `--vxs-diff-add` and `−` in `--vxs-diff-del`.
  4. Otherwise: an optional unread dot (6 px, `--vxs-text`), then an optional 12 px host badge (only when the session runs somewhere other than its group's host, for example after a hand-off), then the relative time: `now`, `4m`, `2h`, `3d`, `2w`, `Oct 2`.
- **Line 2:** 12/16 in `--vxs-text-2`, at x 42. It is **always neutral text**; only the glyph carries colour. Setting "Attention only" (the default) shows it on needs-you rows (the request, e.g. "Wants to run pnpm install --frozen-lockfile") and failed rows (the reason, e.g. "Checks failed · 3"). Setting "All rows" also shows:
  - live activity on running rows ("Editing findings.ts");
  - `+318 −32 · <last message>` on finished rows.
- **Status and location** use separate slots. A host or location badge never replaces the status glyph.
- **Row `⋯` menu:** Open in new window, Rename, Pin / Unpin, Mark as read / unread, Move to Cloud computer… (after Codium), Copy session link, Archive.

**Children: node-and-edge connectors**
- Child sessions, parallel workspaces and swarm workers nest under their parent, indented 18 px per level:
  - Level 1: glyph centre at x 44, title at x 60.
  - Level 2: glyph centre at x 62, title at x 78.
  - Level 3: glyph centre at x 80, title at x 96.
- The connector is a 1 px line in `--vxs-connector`:
  - It drops from the bottom of the parent's glyph (row top + 20) at the parent glyph's centre x.
  - At each child's midline it turns right with a 6 px radius.
  - It ends in a **4 px node dot** centred 11 px left of the child's glyph centre (x 33 for level 1). The dot takes the child's status colour, or the connector colour when the child is idle or done.
- At most 3 levels are drawn. Anything deeper is drawn at level 3 with "via <parent title>" as line 2. The data model has no depth limit.
- **Collapse:** on hover a 12 px caret replaces the parent's glyph; on keyboard focus, ← and → collapse and expand.
- **A collapsed parent** shows:
  - its child count in the meta slot;
  - a **rolled-up glyph** in its own status slot: the most urgent state among itself and all its descendants, in the order Needs you › Failed › Running › Ready to review › Queued › Paused › Stopped › Done. The tooltip names the source, e.g. "Needs you · from Swarm worker 2".
- Children are never regrouped away from their parent.

#### G. Update row (conditional; 32 tall, 8 px above the footer)
- A 6 px `--vxs-accent` dot, then "Restart to update to 1.99.114" at 12/16 in `--vxs-text-2`, then `›`.
- Clicking it opens the existing "Restart to update" confirmation.

#### H. Footer (48 tall, 1 px `--vxs-hairline` above)
- **Avatar:** a 22 px circle at x 16. The initial "Y" is 11/14 weight 600 in `#E6DDFF` on `rgba(146,116,236,0.28)` (light: `#4B34A6` on `rgba(106,79,214,0.14)`). A photo replaces the initial when one exists.
- **Name:** "You" at x 46, 13/18 in `--vxs-text`. Then " · Codium Max" at 12/16 in `--vxs-text-3`.
- **Founding badge** (after Codium): 16 tall, radius 8, padding 0 6, 1 px border in `--vxs-accent` at 40%. Text "Founding" at 11/14 weight 500 in `--vxs-accent-text`.
- **Right side:** Help `?` and the Settings gear, each 28 x 28.
- **Help menu:** Docs, Best practices, Changelog, Send feedback, Diagnostics, Open debug tools.
- **Account popover:** opens upward from the avatar or name. 280 wide, radius 10. Contents:
  - "You · Codium Max"
  - **Codium meter:** a 4 px bar, radius 2, in `--vxs-accent`, with "64% left · resets Fri" at 12/16 in `--vxs-text-2`. Percentages only, never tokens or prices.
  - **Activity:** "5 day streak" with seven 6 px day dots (`--vxs-accent` for active days, `--vxs-hairline-strong` for inactive ones), favourite model, and chats completed this week.
  - Pair a phone…
  - Account settings
  - Plans
  - Sign out
- The Codium percentage also always sits under the composer (4.6), so nothing critical lives only in the footer.

### 4.3 Live strip (Vector's own idea)

**Purpose.** One place that answers "what is happening right now, and does anything need me?" It covers every surface where Vector runs work:
- local agent sessions;
- parallel workspaces and swarm workers;
- Coordinated runs: one item each, with a child count;
- Vectorscope review runs;
- Hands background tasks and computer use;
- the Cloud computer and its Done by Morning jobs;
- running automations.

The Hands, Cloud computer and Done by Morning sources each sit behind their own feature check until their branch merges.

**When it shows.** While at least one item is Running, Needs you, Queued-and-starting, or Failed in the last 10 minutes. Otherwise the strip is absent: there is no empty card and no "all quiet" text.

**Anatomy**
- **Card:** margin 0 8, radius 10, padding 4, fill `--vxs-live-fill`, 1 px `--vxs-live-border`. No shadow.
- **Top edge:** a 1 px line inset 10 px at each end.
  - On session routes it is the Vector gradient (`--vxs-gradient-line`) at 55% opacity.
  - On the empty state, which already carries the gradient chip tile, it is solid `--vxs-accent` at 40%. That keeps the gradient to one place per screen.
  - It never animates.
- **Header (24 tall):**
  - "Live" at 12/16 weight 600 in `--vxs-text-2`.
  - The count, 6 px after it, at 11/14 tabular in `--vxs-text-3`.
  - A 24 x 24 collapse chevron at the right. Collapsed, the card shows only its header, with the diamond count when anything needs you.
- **Items:** row height (28 by default), at most **4** visible, then "+N more" (24 tall, 12/16 in `--vxs-text-3`), which opens Search filtered to Live.
  - Status glyph in the 16 px slot.
  - Title at 13/18, coloured by the same rules as session rows.
  - Trailing:
    - for kinds other than agent sessions, a 12 px **kind glyph** in `--vxs-text-3`: `vectorscope`, `hands-task`, `host-cloud`, `automation` or `workflow`;
    - then the elapsed time (11/14 tabular).
- **Order:** Needs you › Failed › Running › Queued. Within each tier, oldest first by start time, so items never jump around.
- **Needs-you items** show a **Review** pill instead of the time.
  - Pill: 20 tall with a 24 px hit area, padding 0 8, radius 6, transparent fill, 1 px `--vxs-hairline-strong`. Label 11/14 weight 500 in `--vxs-text`. Hover fill `--vxs-row-hover`.
  - It **opens the session scrolled to the permission prompt**. It never approves.
- **v1 behaviour: Open only.**
  - Clicking an agent item opens the session.
  - A review item opens the Vectorscope panel.
  - A Hands task opens the Tasks pane.
  - A Cloud computer item opens the cloud session view.
  - Inline Approve, Retry, Watch / Take over and Stop all are **not in v1**. They are listed as a later option (section 13) that needs a separate safety review.
- **Height stability:**
  - The header count updates immediately.
  - Inserting or removing items is deferred while the pointer is pressed in the sidebar or hovering over the tree. Deferred changes apply 400 ms after the pointer leaves, or after at most 3 s.
  - Re-sorting happens at most every 500 ms.
- **Duplication:** live sessions also stay in their project tree with the same glyph. Live is the summary; the tree is where the session lives.
- **Hidden sidebar:** Live moves to the stage header as the **Live pill** (see 8.1).
- **System echo:**
  - The macOS Dock badge (`app.setBadgeCount`) and the Windows taskbar overlay icon show the needs-you count.
  - A needs-you item fires one OS notification when the window is not focused, using the existing notification setting.
  - The paired phone receives the existing "Needs you" alert.

### 4.4 Stage header (44 tall in flush; 32 in inset)
- Drag region. A 1 px `--vxs-hairline` along the bottom fades in over 120 ms once the transcript scrolls; there is none at rest.
- **Title:** at x 20, 13/18 weight 500 in `--vxs-text`, followed by a 12 px chevron in `--vxs-text-3`.
- **Chevron menu:** Rename, Pin, Transcript view: Normal / Verbose, Open in ▸ (the existing editor list), Copy link, Archive.
- While the session runs, the title is followed by an orbit glyph and "Agent working" at 12/16 in `--vxs-text-2`.
- **Right side**, left to right, gap 4:
  - the Live pill (only when the sidebar is hidden);
  - Changes `+318 −32` (28 tall, padding 0 8, 11/14 tabular, diff colours);
  - Terminal (28 x 28);
  - Tasks (28 x 28);
  - Side panel toggle (28 x 28);
  - Open in `⌄` (28 x 28).
- On Windows the header reserves `env(titlebar-area-width)` on the right, about 138 px, for the caption buttons.
- With the sidebar hidden on Mac, the header pads left to 170, and the toggle, Back and Forward move into it at x 78, 106 and 134. On Windows they move to x 40, 68 and 96.

### 4.5 Transcript
- Centred column, max-width 720, side padding at least 32. Body text 14/22 in `--vxs-text`.
- **User message:** a right-aligned block, max 80% of the column width, radius 12, fill `--vxs-row-hover`, padding 10 14, 14/22 in `--vxs-text`.
- **Agent message:** plain text, no bubble.
- **Tool steps:** one-line rows, 13/20.
  - A 16 px line icon in `--vxs-text-3`, then the verb in `--vxs-text-2`, then the target in `--vxs-text-3` (paths in mono 12).
  - Results are trailing, in `--vxs-text-3`.
  - Clicking a row expands its detail.
- **File edit card:** 36 tall, radius 10, 1 px `--vxs-hairline`, no fill.
  - File icon, path in mono 12 `--vxs-text-2`, `+84 −12` in tabular diff colours, then "Open diff ›" at 12/16 in `--vxs-text-3`.
- **Child-session card:** 36 tall, radius 10, 1 px `--vxs-hairline`, no fill. Status glyph, title at 13/18, status word at 12/16 in `--vxs-text-3`, `›`.
- **Vectorscope finding card:** radius 10, 1 px `--vxs-hairline-strong`, transparent fill, padding 12 14.
  - Header row: `vectorscope` glyph 14 px in `--vxs-text-2`, "Vectorscope" at 12/16 weight 600 in `--vxs-text-2`, then the severity: a 10 px diamond outline (Medium) or filled diamond (High) in `--vxs-needs`, or a ring (Low) in `--vxs-text-3`, with the word in `--vxs-text`.
  - Title: 13/18 weight 500 in `--vxs-text`.
  - Location: mono 12 in `--vxs-text-3`.
  - Body: 13/20 in `--vxs-text-2`.
  - Actions:
    - **Ask Vector to fix**: 28 tall, radius 7, fill `--vxs-text`, label 12/16 weight 600 in `--vxs-main`, padding 0 12.
    - **Open in diff**: a text button, 12/16 in `--vxs-text-2`.
- **Notices:** a centred line in 12/16 `--vxs-text-3`, with 1 px hairline rules on both sides.
- **Long transcripts:** each block uses `content-visibility: auto; contain-intrinsic-size: auto 120px`.

### 4.6 Composer and chips (identical in a session and in the empty state)
- **Width:** the same as the transcript column (max 720). 16 px from the bottom of the stage.
- **Box:** radius 14 (16 in the empty state), fill `--vxs-raised`, 1 px `--vxs-raised-border`, `--vxs-raised-highlight`, shadow `--vxs-shadow-composer`.
- **Session size:** a single row, minimum height 48, growing to 280 and then scrolling. Padding 10.
  - Left: `+` (28 x 28). It opens Attach file, Add @ files and Plan first.
  - Textarea: 14/22 in `--vxs-text`. Placeholder in `--vxs-text-3`: "Reply, @ for files, / for commands".
  - Right: mic (28 x 28, "Dictate"), then **Send**.
- **Send:**
  - 28 x 28, radius 8, fill `--vxs-accent-strong`, with a 14 px arrow-up in `#FFFFFF` at a 2 px stroke.
  - With empty input: fill `--vxs-row-pressed`, arrow in `--vxs-text-disabled`.
  - While the agent runs, Send becomes **Stop**: fill `--vxs-text`, with a 10 px rounded square (radius 2) in `--vxs-main`.
- **Focus:** the border becomes `--vxs-focus` at 45%. There is no glow.
- **Chips row** (8 px below the composer, 24 tall, 12/16):
  - Chips are plain text with no fill at rest. On hover they fill `--vxs-row-hover`, radius 6, padding 2 6. Every menu opens upward.
  - **Left group ("where"):**
    - host: 14 px host glyph + "This Mac", in `--vxs-text-2`;
    - project: 14 px tile + "vector ⌄", in `--vxs-text`;
    - branch: 12 px branch glyph + "scope-evidence ⌄", mono 12 in `--vxs-text-2`. The branch menu also holds Local checkout / New worktree…
    - In a session, the host chip's menu offers "Move to Cloud computer…" (after Codium). This replaces Codium's separate "Run on my cloud computer" button.
  - **Right group ("how"):**
    - model: "Auto ⌄" in `--vxs-text`;
    - `·` in `--vxs-text-3`;
    - effort: one of Default / Light / Balanced / Extra / Max, in `--vxs-accent-text`;
    - `·`;
    - mode: Manual in `--vxs-text-2`; Plan in `--vxs-accent-text` with a 6 px accent dot; Full access in `--vxs-text-2` with a 12 px `shield-alert` glyph in `--vxs-needs`;
    - `·`;
    - Codium: a 14 px ring (2 px stroke; accent arc on a `--vxs-hairline-strong` track; the arc turns `--vxs-needs` below 20% and `--vxs-failed` below 5%), followed by "64%" at 11/14 tabular in `--vxs-text-3`. Tooltip: "Codium · 64% left this week · resets Fri".
  - Below 640 px the two groups wrap onto two lines, "where" first.
- **Notices above the composer** (offline, usage):
  - An outline card 12 px above the composer: radius 12, 1 px `--vxs-hairline-strong`, transparent fill, padding 12 14.
  - 16 px icon, title at 13/18 weight 500, subline at 12/16 in `--vxs-text-2`.
  - One pill action: 28 tall, radius 7, fill `--vxs-text`, label in `--vxs-main`.

### 4.7 Empty state that replaces Home (route "/" and New session)

- **Header** (44 tall): "New session" at 13/18 in `--vxs-text-2`. The right side holds only the side panel toggle, plus the Live pill when the sidebar is hidden.
- **Backdrop: the "vector field".** A static SVG pattern of 1 px dots on a 20 px pitch. Dot colour is `--vxs-text` at 3% (dark) or 4% (light). It is masked by `radial-gradient(ellipse 60% 50% at 50% 30%, #000, transparent 70%)`, drawn once and never animated. It replaces the animated ASCII field and is dropped under `forced-colors`.
- **Centred column:** max-width 720, top at `max(96px, 24vh)`.
  1. **Brand tile:** the 32 px Vector chip mark on a tile with radius 8.
     - Fill: `linear-gradient(135deg, #D9C6FF 0%, #A883FF 52%, #7C4DFF 100%)`.
     - Chip glyph: `#0F0D19`.
     - This is **the only gradient on the screen**.
  2. **Headline**, 16 px below the tile: "Give Vector one concrete outcome."
     - Geist (Google Fonts family "Geist", bundled locally as Geist Variable), 24/30, weight 600, −0.015em, in `--vxs-text`.
     - On first run with no projects: "Choose a repository to start."
  3. **Composer**, 24 px below the headline, at empty-state size.
     - Radius 16, minimum height 112, maximum 320.
     - Textarea 15/22, padding 16 16 8.
     - Placeholder: "Describe the outcome. @ to add files, / for commands".
     - Bottom row inside the box (44 tall): `+` on the left; mic and Send on the right.
     - The composer is autofocused.
  4. **Chips row** as in 4.6. The **project chip is the project picker.**
     - With no project chosen, it reads "Choose a project ⌄" in `--vxs-accent-text`.
     - The composer stays usable. Send, once there is text, opens the picker and sends as soon as a project is chosen. It is never a dead end.
  5. **Recent projects**, 20 px below the chips.
     - Label "Recent projects" at 12/16 in `--vxs-text-3`.
     - Up to 4 pills: 28 tall, radius 8, 1 px `--vxs-hairline`, transparent fill, padding 0 10. Each has a 16 px tile and the name at 13/18 in `--vxs-text-row`, with hover fill `--vxs-row-hover`. Clicking a pill sets the project chip.
     - Then two more pills: "+ Open a folder…" and "Clone from GitHub…".
  6. **First run only:** one dismissible row, "Getting started · 0/7 ›", at 12/16 in `--vxs-text-2`.
- **Offline:** the notice card sits 12 px above the composer.
  - Title: "Vector runtime is offline".
  - Subline: "Sessions start once it reconnects."
  - Action: "Reconnect".
- **Project picker popover** (320 wide, max 420 tall, radius 10):
  - a search field;
  - projects grouped by host, each with its tile, name, and short path in `--vxs-text-3`;
  - a divider;
  - "Open a folder…" and "Clone from GitHub…".
  - Keys: ↑↓ move, ↵ chooses, Esc closes.
- **Nothing else appears:** no dashboard cards, streak, Automations card or recents grid. Those moved elsewhere (4.8).
- ⌘N from anywhere returns here with the composer focused. Sending turns the draft into a session in place, using the existing draft-to-session hand-off, so the route never flashes.

### 4.8 Where every Home job goes

| Home today (pages/home.tsx) | New home |
|---|---|
| "Runtime ready / offline" pill | Host header connection dot plus tooltip; offline notice card above the composer |
| Eyebrow, headline, body, "Start building" | Empty-state tile, headline and composer |
| "Vector Cloud" button | More › Vector Cloud until Codium merges, then the Cloud computer host (the /cloud route becomes that host's view) |
| Update (HomeUpdate) | Footer update row (4.2 G) |
| Settings button | Footer gear |
| Help | Footer `?` |
| Project deck: recent repo cards, Active/Ready | Project headers in the host tree; empty-state Recent projects pills; project picker |
| Double-click a card to start a session | Double-click the project header, or its hover `+` |
| "From GitHub", "Add repository", add cards | Host `+` menu (Open a folder… / Clone from GitHub…); empty-state pills; picker footer |
| Card menu (Start new session, Edit, Trust, Close) | Project header `⋯` menu |
| Usage pulse (streak, 7 dots, favourite model, completed chats) | Account popover › Activity; the Codium % ring under every composer |
| Automations block (next run, paused count) | Automations verb with next-run meta; running automations in Live |
| Recent work grid, session search, Today / Yesterday / Older | Host tree; Search ⌘K; Group by › Recent; View all |
| Empty "No tasks yet" | Empty state |
| Hidden `HomeServerRow` multi-server grouping | Host groups and, with 3 or more hosts, the host switcher |
| VectorAsciiField | Replaced by the static vector-field dot backdrop |
| Getting started N/M | More › Getting started; one first-run row in the empty state |
| Done by Morning (codium branch) | Cloud computer › Morning queue; running jobs in Live |
| Hands Tasks pane and computer card | Live items; the stage header Tasks button opens the Tasks pane |
| Phone pairing | Account popover › Pair a phone…; host popover › Pair a phone… |
| Title-bar "Open tasks" tabs and the Home toggle ⌘B | Tabs off by default behind Settings › Appearance › "Show open sessions as tabs" (owner decision, section 13). ⌘B toggles the sidebar |

### 4.9 Keyboard (Windows uses Ctrl for ⌘ and Alt for ⌥)

| Keys | Action |
|---|---|
| ⌘N | New session (empty state, composer focused) |
| ⌘K / ⌘P | Search / Search scoped to Files |
| ⌘B | Show or hide the sidebar (also in View › Show Sidebar / Hide Sidebar) |
| ⌘[ / ⌘] | Back / Forward |
| ⌘1–⌘9 | Jump to the Nth target: Pinned first, then the visible tree order. Holding ⌘ for 600 ms shows the numbers in the meta slots |
| Ctrl+Tab / Ctrl+⇧Tab | Cycle sessions by most recent use |
| ⌘⇧J | Jump to the next session that needs you |
| ⌘⇧L | Focus the Live strip (or open the Live pill popover) |
| ⌘⇧E | Switch Agent / Editor |
| F6 / ⇧F6 | Cycle focus: sidebar → stage header → transcript → composer → side panel |
| ↑ ↓ ← → ↵ | In the tree and Live: move, collapse or go to the parent, expand or go into children, open |
| ⌘⌫ (Ctrl+Del) | Archive the focused session, with a 6 s undo toast |
| Esc | Close a menu, popover, drawer or palette |

Every new binding must be checked against Vector's keybinding map before the build. Approve has **no** shortcut.

---

## 5. Visual system: tokens

All tokens are new and isolated in the `--vxs-*` namespace, which is currently unused. They are scoped to `html[data-shell="signature"]`. Dark is the default. Light applies under `[data-theme="light"]`, and under `@media (prefers-color-scheme: light)` when the theme is System. The existing `--vx-*` tokens, including `--vx-stage` with its 45 uses, are left untouched, so other branches' surfaces don't change.

### 5.1 Colour tokens

The palette is graphite with a faint violet cast: the blue channel sits 2–5 units above red and green. That is distinct from the warm brown, the pure grey and the teal used by the reference apps.

**Surfaces**

| Token | Dark | Light | Use |
|---|---|---|---|
| `--vxs-main` | `#161519` | `#FFFFFF` | Stage, header, transcript, side panel (always opaque); window `backgroundColor` in solid mode |
| `--vxs-sidebar` | `#201F24` | `#F4F3F7` | Solid sidebar (fallback, drawer, phone) |
| `--vxs-sidebar-tint-vibrancy` | `rgba(32,31,36,0.86)` | `rgba(244,243,247,0.84)` | Sidebar fill over macOS `sidebar` vibrancy |
| `--vxs-sidebar-tint-mica` | `rgba(32,31,36,0.84)` | `rgba(244,243,247,0.82)` | Sidebar fill over Windows 11 Mica |
| `--vxs-edge` | `rgba(255,255,255,0.08)` | `rgba(24,22,32,0.10)` | Sidebar/stage divider; inset card hairline |
| `--vxs-hairline` | `rgba(255,255,255,0.07)` | `rgba(24,22,32,0.08)` | Header, footer, card and pill borders |
| `--vxs-hairline-strong` | `rgba(255,255,255,0.12)` | `rgba(24,22,32,0.15)` | Outline notice cards, Review pill, Codium track |
| `--vxs-raised` | `#27262C` | `#FFFFFF` | Composer |
| `--vxs-raised-border` | `rgba(255,255,255,0.08)` | `rgba(24,22,32,0.12)` | Composer and menu border |
| `--vxs-raised-highlight` | `inset 0 1px 0 rgba(255,255,255,0.045)` | `inset 0 1px 0 rgba(255,255,255,0.90)` | Composer top edge |
| `--vxs-menu` | `#2A292F` | `#FFFFFF` | Menus, popovers, palette (opaque) |
| `--vxs-tooltip-bg` / `--vxs-tooltip-text` | `#35343B` / `#ECEBEF` | `#1C1B21` / `#F4F3F7` | Tooltips |
| `--vxs-live-fill` | `rgba(255,255,255,0.03)` | `rgba(255,255,255,0.72)` | Live card |
| `--vxs-live-border` | `rgba(255,255,255,0.07)` | `rgba(24,22,32,0.08)` | Live card |
| `--vxs-row-hover` | `rgba(255,255,255,0.045)` | `rgba(24,22,32,0.045)` | Row and chip hover, user message block |
| `--vxs-row-selected` | `rgba(255,255,255,0.085)` + `inset 0 0 0 1px rgba(255,255,255,0.025)` | `#FFFFFF` + `0 0 0 0.5px rgba(24,22,32,0.10), 0 1px 2px rgba(24,22,32,0.06)` | Selected pill |
| `--vxs-row-selected-inactive` | `rgba(255,255,255,0.06)` | `rgba(24,22,32,0.05)` (no shadow) | Selected pill while the window is unfocused |
| `--vxs-row-pressed` | `rgba(255,255,255,0.11)` | `rgba(24,22,32,0.08)` | :active; disabled Send |
| `--vxs-seg-track` | `rgba(255,255,255,0.05)` | `rgba(24,22,32,0.05)` | Agent / Editor track |
| `--vxs-seg-active` | `rgba(255,255,255,0.10)` | `#FFFFFF` + `0 1px 2px rgba(24,22,32,0.10)` | Active segment |
| `--vxs-connector` | `rgba(255,255,255,0.14)` | `rgba(24,22,32,0.16)` | Child connector lines |
| `--vxs-scrim` | `rgba(0,0,0,0.32)` | `rgba(24,22,32,0.16)` | Drawer scrim |

**Text and icons**

| Token | Dark | Light | Use |
|---|---|---|---|
| `--vxs-text` | `#ECEBEF` | `#1C1B21` | Primary; emphasised titles; headings |
| `--vxs-text-row` | `#BDBBC4` | `#3B3942` | Session titles and verb labels at rest |
| `--vxs-text-2` | `#A9A7B0` | `#4F4D57` | Secondary: host headers, chips, line 2, tool verbs; meta on the selected pill |
| `--vxs-text-3` | `#95929C` | `#66636D` | Tertiary: meta, counts, times, section labels, shortcut hints, placeholders |
| `--vxs-text-disabled` | `#5D5B63` | `#A3A1AB` | Disabled only, never information |
| `--vxs-icon` | `#A9A7B0` | `#5F5D68` | Icons at rest (`--vxs-text` on hover or selected) |

**Accent, status and diff**

| Token | Dark | Light | Use |
|---|---|---|---|
| `--vxs-accent` | `#9274EC` | `#6A4FD6` | Meter, Codium arc, drop line, Founding border, update dot |
| `--vxs-accent-strong` | `#7C5CE6` | `#6A4FD6` | Send fill and any fill carrying white (4.64:1 / 5.67:1) |
| `--vxs-accent-text` | `#B69FF7` | `#5B3FC9` | Accent words: effort, Plan, Founding, "Choose a project" |
| `--vxs-accent-soft` | `rgba(146,116,236,0.16)` | `rgba(106,79,214,0.10)` | Drop targets |
| `--vxs-focus` | `#B69FF7` | `#6A4FD6` | Focus ring |
| `--vxs-running` | `#A58CF2` | `#6F52DA` | Orbit glyph (glyph only) |
| `--vxs-needs` | `#E2AB57` | `#A86C12` | Diamond, reconnecting ring (glyph only) |
| `--vxs-ready` | `#62C48D` | `#23864F` | Check ring, connected dot (glyph only) |
| `--vxs-failed` | `#E8777D` | `#C43E47` | Failed glyph (glyph only) |
| `--vxs-diff-add` | `#62C48D` | `#1D7444` | `+` counts (text, at least 4.5:1 everywhere they appear) |
| `--vxs-diff-del` | `#EE8388` | `#B3343D` | `−` counts (text, at least 4.5:1 everywhere they appear) |
| `--vxs-gradient-brand` | `linear-gradient(135deg,#D9C6FF 0%,#A883FF 52%,#7C4DFF 100%)` | same | Empty-state chip tile only |
| `--vxs-gradient-line` | `linear-gradient(90deg,#7C4DFF 0%,#A883FF 52%,#D9C6FF 100%)` at 55% | same | Live top edge on session routes only |

**Project tile palette** (chosen by a hash of the folder path)

| Hue | Dark fill / letter | Light fill / letter |
|---|---|---|
| Violet | `#6B5A9E` / `#F4F3F7` | `#E6E0F7` / `#4A3A8C` |
| Teal | `#4F7F86` / `#F4F3F7` | `#DCEBEC` / `#2D5A60` |
| Ochre | `#8A6F3D` / `#F4F3F7` | `#F1E7D6` / `#6B4F1C` |
| Rose | `#8A5560` / `#F4F3F7` | `#F3E0E3` / `#6E3340` |
| Steel | `#56708F` / `#F4F3F7` | `#E0E7F1` / `#34496B` |
| Olive | `#5E6A45` / `#F4F3F7` | `#E6EAD9` / `#46502D` |

**Contrast** (WCAG ratios computed from these tokens; the material figures are estimates)
- **Dark, solid sidebar `#201F24`:**

  | Token | Ratio |
  |---|---|
  | `--vxs-text` | 13.8 |
  | `--vxs-text-row` | 8.6 |
  | `--vxs-text-2` | 6.9 |
  | `--vxs-text-3` | 5.35 |

- **Dark, over a bright-wallpaper sidebar material** (modelled as `#404042` to `#6A6670` under the tint): `--vxs-text-3` is 4.72–5.06 at the 0.86 vibrancy tint and 4.64–5.04 at the 0.84 Mica tint.
- **Dark, selected pill:** `--vxs-text-3` is only 4.16, so meta switches to `--vxs-text-2` (5.35) there. `--vxs-diff-del` is 4.99 and `--vxs-diff-add` 5.93 on the pill.
- **Dark, stage:**

  | Token | Ratio |
  |---|---|
  | `--vxs-text` | 15.3 |
  | `--vxs-text-2` | 7.65 |
  | `--vxs-text-3` | 5.95 |
  | `--vxs-accent-text` | 8.0 |

- **Light, solid sidebar `#F4F3F7`:**

  | Token | Ratio |
  |---|---|
  | `--vxs-text` | 15.5 |
  | `--vxs-text-row` | 10.3 |
  | `--vxs-text-2` | 7.5 |
  | `--vxs-text-3` | 5.3 |

  Over a dark-wallpaper material (worst case modelled as `#8A8A92`), `--vxs-text-3` is 4.56 at the 0.84 tint.
- **Light, other pairs:** `--vxs-accent-text` on the sidebar is 6.3. White on `--vxs-accent-strong` is 5.67.
- **Status colours are used for glyphs only.** Light `--vxs-needs` is 3.95 on the sidebar, which passes the 3:1 non-text rule but would fail as text. That is why no status word is ever drawn in a status colour.
- **Correction carried from the review:** no tint holds contrast over a pure white backdrop (0.84 tint over white gives `--vxs-text-3` at 2.77:1). The design relies on the OS sidebar material, which in dark appearance is itself dark and never passes pure white through. That assumption must be checked by eye on the owner's macOS 27 Mac (section 14).

### 5.2 Glass recipe ("glassy" as the owner means it)

| Surface | CSS backdrop blur | Saturate | Fill (dark / light) | Inner highlight | Border | Shadow |
|---|---|---|---|---|---|---|
| Sidebar, Mac | 0 (OS `sidebar` vibrancy) | OS default | `--vxs-sidebar-tint-vibrancy` | none | right 1 px `--vxs-edge` (flush) | none |
| Sidebar, Windows 11 | 0 (OS Mica) | OS default | `--vxs-sidebar-tint-mica` | none | right 1 px `--vxs-edge` | none |
| Sidebar, solid fallback | 0 | n/a | `--vxs-sidebar` | none | right 1 px `--vxs-edge` | none |
| Inset-mode 6 px strip | 0 | n/a | same as the sidebar | none | none | none |
| Stage, side panel | 0 | n/a | `--vxs-main` (opaque) | none | inset card: top and left 1 px `--vxs-edge` | none |
| Live card | 0 | n/a | `--vxs-live-fill` | none | 1 px `--vxs-live-border` + top 1 px gradient line | none |
| Selected pill | 0 | n/a | `--vxs-row-selected` | dark: `inset 0 0 0 1px rgba(255,255,255,0.025)` | none | light only, see token |
| Composer | 0 | n/a | `--vxs-raised` | `--vxs-raised-highlight` | 1 px `--vxs-raised-border` | dark `0 8px 24px rgba(0,0,0,0.22)`; light `0 1px 2px rgba(24,22,32,0.05), 0 6px 20px rgba(24,22,32,0.05)` |
| Menus, popovers, palette | 0 (opaque) | n/a | `--vxs-menu` | dark `inset 0 1px 0 rgba(255,255,255,0.04)` | 1 px `--vxs-raised-border` | dark `0 0 0 0.5px rgba(255,255,255,0.08), 0 2px 6px rgba(0,0,0,0.30), 0 14px 36px rgba(0,0,0,0.45)`; light `0 0 0 0.5px rgba(24,22,32,0.10), 0 2px 6px rgba(24,22,32,0.06), 0 14px 36px rgba(24,22,32,0.12)` |
| Tooltip | 0 | n/a | `--vxs-tooltip-bg` | none | none | dark `0 4px 12px rgba(0,0,0,0.30)`; light `0 4px 12px rgba(24,22,32,0.18)` |
| Drawer (narrow window) | 0 | n/a | `--vxs-sidebar` (solid) | none | none | dark `16px 0 40px rgba(0,0,0,0.35)`; light `16px 0 40px rgba(24,22,32,0.14)` |
| Dragged row | 0 | n/a | `--vxs-raised` at 96% opacity | none | `0 0 0 1px --vxs-hairline-strong` | dark `0 6px 18px rgba(0,0,0,0.35)`; light `0 6px 18px rgba(24,22,32,0.14)` |

The "glass" therefore comes from exactly three things:
1. The OS material showing through a strong tint, so 14–18% of the wallpaper's colour reads through. The sidebar also flattens on its own when the window is inactive.
2. The sidebar sitting one step lighter than the stage in dark mode (`#201F24` against `#161519`). In light mode it is the familiar grey sidebar next to a white stage.
3. Crisp hairlines and soft inset pills.

There is no `backdrop-filter` anywhere in the shell, no floating panel, and no glass on glass.

**Scroll edges** use `mask-image` gradients, not blur:
- Sidebar scroller: 12 px at the top and bottom, only while there is overflow on that side.
- Transcript: 24 px at the top, under the header.

### 5.3 Radii

| Value | Elements |
|---|---|
| 2 | Stop square, meter bar |
| 4 | Project tile, skeleton bars |
| 6 | Tooltip, chips (on hover), segment, Review pill, menu item |
| 7 | Row pills (nav, Live, project, session), icon buttons, primary pill buttons |
| 8 | Segment track, Send, recent-project pills, brand tile, Founding badge, inset card on Windows |
| 10 | Live card, menus, popovers, palette, transcript cards, inset card on Mac |
| 12 | Notice cards, user message block, Live pill in the header |
| 14 | Session composer |
| 16 | Empty-state composer |
| full | Avatar, Codium ring, connection dot, node dots |
| 0 | Sidebar, stage, side panel (flush). Window corners are left to the OS |

### 5.4 Spacing scale
`2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64`

**Sidebar geometry**
- Pill inset 8 from both edges.
- Inside a pill: 10 px left padding, then a 16 px glyph slot (x 18–34), an 8 px gap, and the label at x 42. The right padding is 10, so the meta ends at W − 18.
- Child indent: 18 per level.

**Vertical rhythm**
- 4 px after the chrome row.
- Verbs at a 30 px pitch.
- 12 px above Live.
- 16 px above Pinned and above the first host.
- 12 px between host groups.
- 4 px above each project header.
- No gap between session rows.
- 8 px above the update row.

**Stage geometry**
- Header padding: 0 12 0 20.
- Transcript side padding: at least 32.
- 16 px between transcript blocks; 4 px between consecutive tool steps.
- Composer: 16 px from the bottom.
- Chips row: 8 px below the composer.

### 5.5 Heights

| Element | Desktop | Phone drawer |
|---|---|---|
| Chrome row / stage header | 44 (inset card header 32) | 52 floating header |
| Verb row | 28 (30 pitch) | 44 |
| Section header (Pinned, Live header) | 24 | 32 |
| Host header, project header | 28 | 44 |
| Session row, 1 line / 2 lines | 28 / 44 (see density) | 44 / 56 |
| "Show N more", "View all" | 26 | 40 |
| Update row | 32 | 44 |
| Footer | 48 | 56 |
| Menu item | 28 | 44 |
| Icon buttons | 28 x 28 (24 x 24 inside rows and headers) | 44 x 44 |
| Composer minimum | 48 session, 112 empty state | 48 |

### 5.6 Density
Settings › Appearance and View options › Density. Density never changes silently.

| Density | Row | Two-line row | Verb pitch | Title | Line 2 |
|---|---|---|---|---|---|
| Compact | 26 | 40 | 28 | 13/18 | 12/16 |
| Default | 28 | 44 | 30 | 13/18 | 12/16 |
| Comfortable | 32 | 50 | 34 | 14/20 | 12/16 |

### 5.7 Sidebar width
- **Expanded:** default 264, resizable from 236 to 360.
  - The resize handle is a 6 px hit area centred on the edge line. On hover the line becomes `--vxs-focus` at 60%.
  - Double-clicking the handle resets the width to 264.
  - The width is stored per viewer. Migrate `vector.navigation-width.v1`, clamped into 236–360, then save as `vector.sidebar.width.v2`.
- **Collapsed:** 0 by default. The optional slim rail is 52 wide (8.2).
- **Stage minimum:** the stage never drops below 420. If it would, the sidebar hides.

### 5.8 Typography
- **UI font:** the system stack, `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`. This is the existing `--vx-workspace-font`.
- **Display font:** Geist, from Google Fonts family "Geist", already bundled as Geist Variable. It is used only for the empty-state headline.
- **Mono:** `"SF Mono", ui-monospace, "Cascadia Code", Menlo, Consolas, monospace`.
- **Smoothing:** in Mac dark mode, use `-webkit-font-smoothing: antialiased`.

| Role | Size / line | Weight | Colour |
|---|---|---|---|
| Meta: time, counts, diff, kbd | 11/14, `tabular-nums`, +0.01em | 400 | text-3 (text-2 on the selected pill) |
| Branch chip | mono 11/14 | 400 | text-3 |
| Section label (Pinned) | 12/16, sentence case | 600 | text-3 |
| Live header | 12/16 | 600 | text-2 |
| Host header | 12/16 | 600 | text-2 |
| Line 2, chips, tooltips, notices | 12/16 | 400 | text-2 |
| Verb labels, session rows, menus | 13/18 (14/20 Comfortable) | 400 | text-row at rest; text when emphasised (colour only) |
| Project header, stage title | 13/18 | 500 | text |
| Tool steps | 13/20 | 400 | verb text-2, target text-3 |
| Transcript body, session composer | 14/22 | 400 | text |
| Transcript headings | 16/24 | 600 | text |
| Empty-state composer | 15/22 | 400 | text |
| Empty-state headline | Geist 24/30, −0.015em | 600 | text |

Hierarchy rule: a header always differs from a row in at least two of size, weight and colour. No row ever changes weight. There are no uppercase micro-labels, and no mono in the chrome apart from branch names and paths.

### 5.9 Icons
- Vector's own stroke set only. Extend `ui/src/v2/components/icon.tsx`. No third-party icon set and no glyphs taken from the reference apps.
- Drawn on a 16 px grid with a 1.5 px stroke, round caps and joins, rectangle corners rounded 2 px, `currentColor`, and no fills (status glyphs are the only filled shapes).
- Sizes:
  - 16 in rows and buttons;
  - 14 for host glyphs in headers and chips;
  - 12 for meta badges and status glyphs;
  - 12 for chevrons, at a 1.5 px stroke.
- Colour: `--vxs-icon` at rest, `--vxs-text` on hover or selected. Only status glyphs, the brand tile and project tiles carry colour.
- **New glyphs needed:**
  - `compose`, `automation`, `vectorscope`, `hands-task`, `workflow`, `live`;
  - `host-mac`, `host-pc`, `host-server`, `host-cloud`, `host-phone`;
  - `orbit`, `diamond`, `check-ring`, `x-ring`, `square-stop`, `dash-ring`, `pause-bars`;
  - `mode-agent`, `mode-editor`;
  - `branch`, `pin`, `archive`, `shield-alert`.

### 5.10 Status vocabulary
One vocabulary is used in the sidebar, Live, Search, the rail and the phone. Each glyph is drawn in a 12 px box centred in the 16 px slot. Every glyph has a tooltip, such as "Running · 12m" or "Needs you · Wants to run pnpm install --frozen-lockfile". View options › Status legend lists them all.

| State | Glyph | Colour | Title colour |
|---|---|---|---|
| Running | `orbit`: a 10 px ring (1.5 px stroke) at 30% alpha, with a 3 px dot orbiting it once every 1.6 s, linear | `--vxs-running` | text-row |
| Needs you | `diamond`: an 8 x 8 square rotated 45°, filled, corner radius 1.5 | `--vxs-needs` | text |
| Failed | `x-ring`: an 11 px circle filled at 18% alpha, with a 1.5 px x of 5 px | `--vxs-failed` | text |
| Ready to review | `check-ring`: an 11 px ring (1.5 px stroke) with a 6 px check inside | `--vxs-ready` | text-row |
| Queued / scheduled | `dash-ring`: a 10 px ring, 1.25 px stroke, 2/2 dashes | `--vxs-text-3` | text-row |
| Paused (Hands: "You have control") | `pause-bars`: two 1.5 x 6 bars, 3 px apart | `--vxs-text-2` | text-row |
| Stopped | `square-stop`: an 8 px square outline, 1.5 px stroke, radius 2 | `--vxs-text-3` | text-row |
| Done / read / idle | empty slot | n/a | text-row |
| Unread (modifier) | a trailing 6 px dot in the meta slot, plus the title in `--vxs-text` | `--vxs-text` | text |

Shapes stay distinct for colour-blind users, so amber and green are never told apart by colour alone.

### 5.11 Focus
- Shown only on `:focus-visible`.
- **Rows and pills:** `box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--vxs-focus) 85%, transparent)`.
- **Buttons, chips, segments:** `outline: 2px solid var(--vxs-focus); outline-offset: 2px`.
- **Composer:** the border becomes `--vxs-focus` at 45%.
- **Sidebar:** a single tab stop with roving tabindex (see 4.9).

### 5.12 Motion

| Token / interaction | Value |
|---|---|
| `--vxs-ease` | `cubic-bezier(.22,1,.36,1)` (the existing `--vx-ease`), for every enter |
| `--vxs-ease-exit` | `cubic-bezier(.4,0,1,1)`, for every exit |
| Hover fill | 100 ms in, 160 ms out |
| Selection pill | 120 ms colour change; it never slides between rows |
| Segment switch | 140 ms slide |
| Chevron rotate | 140 ms |
| Menus and popovers | in 140 ms (opacity 0 → 1, translateY 4 → 0, scale .98 → 1, origin at the anchor); out 100 ms |
| Tooltips | 300 ms delay, 100 ms fade |
| Live items | enter 160 ms (opacity + translateY 4 → 0); leave 120 ms opacity; re-ordering snaps |
| Tree expand / collapse | 120 ms opacity only; no height animation |
| Sidebar collapse / expand | `transform: translateX(-100%)` ↔ 0 over 180 ms; the stage width changes once, at the start; no per-frame reflow |
| Drawer | in 200 ms, out 160 ms; scrim fades in over 160 ms |
| Header hairline | 120 ms fade |
| Orbit | 1.6 s linear, infinite, transform only |
| Needs-you arrival | one flash of the row fill from `rgba(226,171,87,0.16)` to transparent over 900 ms; plays once and never loops |

Under `prefers-reduced-motion: reduce`, every transition becomes an 80 ms opacity change or nothing. The orbit stops, with its dot at 12 o'clock and the ring at 60%. There is no arrival flash.

---

## 6. States

| State | Treatment |
|---|---|
| **Hover** (row) | Fill `--vxs-row-hover`. Title and icon turn `--vxs-text`. The meta slot swaps to Archive and `⋯` (24 x 24). Verb rows show their shortcut in `--vxs-text-3`. Project tiles become chevrons; host glyphs become chevrons. The title never moves. Pointer cursor: off by default (setting). |
| **Selected** | Inset pill `--vxs-row-selected`, radius 7, never full-bleed, no side bar. Title in `--vxs-text`, meta in `--vxs-text-2`. A selected child also turns its connector node to `--vxs-text`. `aria-selected="true"`, and `aria-current="page"` for the open session. Selection takes priority over hover. |
| **Window inactive** | The native material flattens (`followWindow`, and Mica's own behaviour). The selected pill becomes `--vxs-row-selected-inactive`. Status glyphs keep their colours. The orbit pauses after 10 s unfocused. |
| **Running** | Orbit glyph. The item is in Live. The stage header shows "Agent working". A collapsed parent or project rolls it up. The title stays `--vxs-text-row` unless selected. The meta shows a live relative time. |
| **Needs approval / input** | Diamond glyph, title in `--vxs-text`, two-line row with the request in `--vxs-text-2`. First in Live, with the Review pill. Dock / taskbar badge count, one OS notification when unfocused, phone alert, one arrival flash. ⌘⇧J jumps to it. Resolved items leave Live within 300 ms, with a 120 ms fade. |
| **Unread** | A session that finished while you were elsewhere: trailing 6 px dot and title in `--vxs-text`. Cleared **when the session is opened**, or with Mark as read / Mark all read. It never clears passively. |
| **Ready to review** | Check-ring glyph. The meta shows the diff when there is one. |
| **Failed** | X-ring glyph, title in `--vxs-text`, two-line row with the reason in `--vxs-text-2`. It stays in Live for 10 minutes. A failed automation shows the x-ring in the Automations verb meta. The tooltip carries the full error. |
| **Paused / Stopped / Queued** | Their glyphs. Queued items show their scheduled time in the meta (e.g. `6:00`). |
| **Pinned** | Listed in Pinned (max 8, reorderable), and still in its own group. No pin icon on the row itself. Pin / unpin from `⋯` or by dragging. |
| **Drag** | Draggable: projects within a host, pinned rows, host order, and a session dropped on another host header (hand-off). The lifted row uses the dragged-row recipe (5.2) with no scale; its source stays as a 28 px gap. Drop line: 2 px `--vxs-accent`, inset 12, with a 4 px accent node at its left end (the connector motif). Hand-off target: the host header gets `--vxs-accent-soft` fill and a 1 px dashed `--vxs-accent` outline, radius 7, and the drop asks for confirmation ("Move to Cloud computer?"). Auto-scroll up to 600 px/s near the edges. Esc cancels. Sessions are never reordered inside a project. |
| **Offline / reconnecting host** | Static amber ring plus "Reconnecting…", or a grey ring plus "Offline". Rows dim to 60% opacity. `+` stays enabled and queues the request. The empty state shows the offline notice. |
| **Empty host or project** | "No projects yet" at 12/16 in `--vxs-text-3` at x 42, followed by "Open a folder…" and "Clone from GitHub…" as text buttons in `--vxs-accent-text`. |
| **Loading** | 6 skeleton rows: 8 px bars, radius 4, `--vxs-row-pressed`, widths 70% / 55% / 62% repeating. No shimmer. |
| **Scrolled sidebar** | Mask fades at the edges (5.2). Overlay scrollbar: a 6 px thumb, radius 3, `rgba(255,255,255,0.14)` (light `rgba(24,22,32,0.18)`), visible only while hovering or scrolling. |
| **Side panel open** | Changes, Browser, Context, Tasks or Vectorscope open at 420 by default (range 340 to 50% of the window), opaque, with a 1 px left hairline. Tabs are 12/16 weight 500, with the active tab in a `--vxs-row-selected` pill (radius 6). If the transcript would fall below 560, the sidebar hides automatically (to 0, or to the rail if the rail is enabled). It comes back when the panel closes, unless the user hid it by hand. No toast. |

---

## 7. Collapsed, narrow and phone behaviour

### 7.1 Collapsed (default: hidden)
- ⌘B, the toggle, or View › Hide Sidebar.
- The sidebar slides out (180 ms translateX), and the stage takes its width in one step.
- The toggle, Back and Forward move into the stage header (4.4).
- **Live pill:** if anything is live, it appears in the stage header, to the left of the actions.
  - 24 tall, radius 12, 1 px `--vxs-hairline-strong`, padding 0 8, 11/14 tabular.
  - Content: needs-you diamond + count, a 4 px gap, orbit + running count, e.g. `◆ 1 · ◌ 3`. Glyphs are 10 px. The orbit in the pill is static.
  - Clicking it (or ⌘⇧L) opens a 320 wide popover with the same Live list and the same rules.
  - With nothing live, the pill is absent.

### 7.2 Optional slim rail
Turned on in Settings › Appearance › "When the sidebar is hidden: Hide completely (default) / Keep a slim rail". The rail is never forced on.
- 52 wide, with the same material, tint and right edge line as the sidebar.
- On Mac the traffic lights stay in the 44 px chrome row and spill over the stage header, which pads left to 78.
- Contents, top to bottom:
  - Expand (toggle), New session, Search, Live (the `live` glyph with a 14 px count badge; the badge is drawn as a diamond-shaped amber badge when anything needs you), Vectorscope.
  - A 20 px hairline separator.
  - Up to 6 **attention tiles**, one per running, needs-you or unread session: a 24 px project tile with the status glyph as a 10 px corner badge, ringed by 2 px of the rail colour. Tooltip: the session title.
  - A spacer.
  - The avatar and the gear.
- Buttons are 36 x 32, radius 8, with 16 px icons. The selected item takes `--vxs-row-selected`. Tooltips appear to the right after 300 ms.
- While the rail is on, the Live pill still shows in the stage header.

### 7.3 Narrow window (window `minWidth` 560, `minHeight` 420)

| Window width | Behaviour |
|---|---|
| ≥ 1100 | Sidebar and side panel both docked |
| 900–1099 | Sidebar docked. The side panel opens as an overlay from the right (menu shadow, no scrim) whenever the transcript would fall below 560 |
| 640–899 | The sidebar follows the collapsed setting (hidden or rail). ⌘B opens it as an **overlay drawer**: 264 wide, solid `--vxs-sidebar`, drawer shadow, `--vxs-scrim`. It closes on Esc, on selecting a row, or on a click on the scrim |
| 560–639 | As above. In addition, the chips wrap to two lines, header actions collapse into `⋯`, and the Live pill shows counts only |

### 7.4 Phone drawer (phone remote page, viewport < 600)
- The same sections in the same order, using the same tokens. **No material**: the drawer is solid `--vxs-sidebar`.
- **Drawer:** width `min(86vw, 340px)`, full height, padding `env(safe-area-inset-top/bottom)`.
  - Opens with `translateX(-100%) → 0` over 240 ms `--vxs-ease`, while the scrim fades in over 200 ms.
  - A swipe from the left 16 px opens it; a swipe left closes it; tapping a row navigates and closes it.
- **Sizes:**
  - rows 44, two-line rows 56;
  - titles 16/21, meta 13/16;
  - icons 20, tiles 20;
  - pill inset 8, radius 10.
  - Second line defaults to "All rows" on the phone.
- **Live** becomes a sticky card at the top of the Sessions screen. Its Review buttons are full-width and 36 tall; they open the session's permission prompt.
- **Floating header** (52 tall): menu button, session title with chevron, Live pill.
- The composer is pinned above the safe area, and the chips row scrolls horizontally.
- **Footer:** "You · Codium Max", plus "Paired with This Mac".
- **Pairing:** QR pairing lives in Settings › Hosts › This Mac › Pair a phone.

---

## 8. Implementation notes (for the later build; nothing is built now)

### 8.1 Electron window (`packages/desktop/src/main/windows.ts`, `createMainWindow`)

Electron is 42.11.4. Today the window sets only `titleBarStyle: 'hidden'`, `trafficLightPosition {12,14}` and the Windows `titleBarOverlay`, with no material. The new options:

```ts
type Material = 'vibrancy' | 'mica' | 'solid'
const dark = nativeTheme.shouldUseDarkColors
const solidBase = dark ? '#161519' : '#FFFFFF'            // --vxs-main
const material: Material = resolveMaterial()

const win = new BrowserWindow({
  width: 1280, height: 800, minWidth: 560, minHeight: 420,
  backgroundColor: material === 'solid' ? solidBase : '#00000000', // never transparent: true
  ...(process.platform === 'darwin' && {
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },                 // 12 px lights centred on y 22
    ...(material === 'vibrancy' && { vibrancy: 'sidebar', visualEffectState: 'followWindow' }),
  }),
  ...(process.platform === 'win32' && {
    frame: false,
    titleBarStyle: 'hidden',
    roundedCorners: true,
    titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#ECEBEF' : '#1C1B21', height: 44 },
    backgroundMaterial: material === 'mica' ? 'mica' : 'none',
  }),
})
```

**`resolveMaterial()` returns `'solid'` if any of these is true:**
- the user's glass preference is off (the existing `data-vector-glass` / `LAUNCH_STORAGE_KEYS.glass`, relabelled "Translucent sidebar" in Settings › Appearance);
- `nativeTheme.prefersReducedTransparency`;
- `nativeTheme.shouldUseHighContrastColors`;
- `nativeTheme.inForcedColorsMode`;
- the machine is on the lite launch tier (4 or fewer cores, or 4 GB or less memory);
- the platform is Linux;
- the platform is Windows with an `os.release()` build below 22621 (Windows 10 and early 11);
- **on Mac: the embedded Browser panel is visible** (see below).

Otherwise it returns `'vibrancy'` on Mac and `'mica'` on Windows. Battery power does not switch the material: vibrancy is composited by the OS, and Mica handles Battery Saver itself.

**Runtime switching**
- Main exposes `shell:setMaterial`.
  - To solid: `win.setVibrancy(null)` or `win.setBackgroundMaterial('none')`, then `win.setBackgroundColor(solidBase)`.
  - Back on: `win.setVibrancy('sidebar')` or `win.setBackgroundMaterial('mica')`, then `win.setBackgroundColor('#00000000')`.
- Re-run `resolveMaterial()` on `nativeTheme.on('updated')` **and** on every window `focus`, because 'updated' is not confirmed to fire when Reduce Transparency changes.
- Send the result over IPC (`vector:material`). The renderer sets `html[data-vxs-material="vibrancy|mica|solid"]`.
- The renderer's existing `setBackgroundColor()` path must not overwrite `#00000000` while a material is active.
- On Windows, re-apply the overlay on zoom (existing code).

**Embedded Browser panel (Electron issue 41979)**
- `packages/desktop/src/main/browser-agent.ts` embeds a WebContentsView in the main window. Vibrancy has been reported to visually wipe such views on Electron 30 and later.
- A spike on a separate machine must confirm whether Vector is affected. If it is, `resolveMaterial()` returns `'solid'` on Mac **only while the Browser panel is visible**. The switch is instant, without animation, and the material comes back when the panel closes. At a 0.86 tint the visible change is small.
- If the spike shows the problem cannot be contained, ship Mac with the solid sidebar first.

### 8.2 CSS layers (bottom to top)

| Layer | What paints |
|---|---|
| L0 window | `html, body { background: transparent }` when `[data-vxs-material="vibrancy"\|"mica"]`; otherwise `background: var(--vxs-main)` |
| L1 sidebar | `.vxs-sidebar { background: var(--vxs-sidebar); box-shadow: inset -1px 0 0 var(--vxs-edge); contain: layout paint style; isolation: isolate; }`. With `[data-vxs-material="vibrancy"]` the background is `var(--vxs-sidebar-tint-vibrancy)`; with `[data-vxs-material="mica"]` it is `var(--vxs-sidebar-tint-mica)`. In inset mode, the same tint is painted across the whole `.vxs-shell`, so the sidebar and the 6 px strip are one surface with no seam |
| L1 stage | `.vxs-stage { background: var(--vxs-main); contain: layout paint; isolation: isolate; }`. Flush mode: it starts exactly at the sidebar edge. Inset mode: it gets `margin-top: 6px; border-top-left-radius: 10px; box-shadow: inset 1px 1px 0 var(--vxs-edge); overflow: hidden` |
| L2 | Row pills, the Live card, chips: fills only, with no shadows or filters |
| L3 | Composer: `--vxs-raised` plus border, highlight and shadow |
| L4 | Menus, popovers, palette, tooltips, drawer: opaque with shadows, portalled to `#vector-overlay-root` |

Grid: `.vxs-shell { display: grid; grid-template-columns: var(--vxs-sb-w, 264px) minmax(0,1fr) auto; height: 100dvh; }`.

Collapse:
- Set `--vxs-sb-w: 0px` once at the start.
- The sidebar is then positioned absolutely during the 180 ms `translateX` exit.
- Width is never animated.

Z-index:

| Layer | z-index |
|---|---|
| Sidebar, stage | 0 |
| Sticky stage header | 10 |
| Side panel overlay | 20 |
| Drawer scrim | 30 |
| Drawer | 31 |
| Menus, popovers | 40 |
| Tooltips | 50 |
| Toasts | 60 |
| Modals | 70 |

Only the sidebar (and, in inset mode, the strip) ever paints translucent.

**Backdrop-filter audit**
- `packages/app/src` has 58 `backdrop-filter` uses today.
- Under `html[data-shell="signature"]`, every shell surface sets `backdrop-filter: none; -webkit-backdrop-filter: none` explicitly: sidebar, headers, composer, menus, popovers, palette, drawer, Live and toasts.
- That includes the legacy `blur(18px) saturate(1.2)` rules in `vector-premium.css` and `layout-new.tsx`.

### 8.3 Fallbacks (one switchboard; every path lands on the same solid tokens)

```css
html[data-vxs-material="solid"] .vxs-sidebar,
html[data-vector-glass="false"] .vxs-sidebar,
html[data-vector-launch-tier="lite"] .vxs-sidebar { background: var(--vxs-sidebar); }

@media (prefers-reduced-transparency: reduce) {
  html[data-shell="signature"] { --vxs-sidebar-tint-vibrancy: var(--vxs-sidebar); --vxs-sidebar-tint-mica: var(--vxs-sidebar); }
}

@media (prefers-contrast: more) {
  html[data-shell="signature"] {
    --vxs-sidebar-tint-vibrancy: var(--vxs-sidebar); --vxs-sidebar-tint-mica: var(--vxs-sidebar);
    --vxs-edge: rgba(255,255,255,.22); --vxs-hairline: rgba(255,255,255,.22); --vxs-hairline-strong: rgba(255,255,255,.30);
    --vxs-text-row: #ECEBEF; --vxs-text-2: #C8C6CE; --vxs-text-3: #AFACB6; --vxs-row-selected: rgba(255,255,255,.14);
  }
  html[data-shell="signature"][data-theme="light"] {
    --vxs-edge: rgba(24,22,32,.30); --vxs-hairline: rgba(24,22,32,.30); --vxs-hairline-strong: rgba(24,22,32,.40);
    --vxs-text-row: #1C1B21; --vxs-text-2: #3B3942; --vxs-text-3: #4F4D57;
  }
  .vxs-row[aria-selected="true"] { box-shadow: inset 0 0 0 1px rgba(255,255,255,.40); } /* light: rgba(24,22,32,.45) */
  :focus-visible { outline-width: 3px; }
}

@media (forced-colors: active) {
  .vxs-sidebar, .vxs-stage, .vxs-composer, .vxs-menu { background: Canvas; color: CanvasText; border-color: ButtonBorder; }
  .vxs-row:hover { outline: 1px solid ButtonBorder; }
  .vxs-row[aria-selected="true"] { background: Highlight; color: HighlightText; outline: 1px solid HighlightText; forced-color-adjust: none; }
  .vxs-stage { border: 1px solid ButtonBorder; }          /* box-shadow hairlines are dropped */
  .vxs-status svg { forced-color-adjust: auto; }           /* shapes still carry the state */
  .vxs-field { display: none; }                            /* empty-state dot field */
  :focus-visible { outline: 2px solid Highlight; }
}

@media (prefers-reduced-motion: reduce) { /* see 5.12 */ }
```

- **Lite tier:** solid material, a static orbit, and status updates batched every 1 s.
- **Battery** (`powerMonitor.isOnBatteryPower()`): keep the material, pause the orbit after 10 s unfocused, and batch status and Live updates every 1 s.
- **Windows Battery Saver or Transparency effects off:** Mica goes solid by itself. The 0.82–0.84 tint keeps the look the same.

### 8.4 Accessibility semantics
- The sidebar is `<nav aria-label="Vector sidebar">`. Each host tree is `role="tree"`. Project, session and child rows are `role="treeitem"` with `aria-level`, `aria-expanded`, `aria-selected` and `aria-setsize` / `aria-posinset`.
- Status is exposed through `aria-description`, e.g. "Needs you: wants to run pnpm install --frozen-lockfile".
- Live is `role="list"` with `aria-label="Live"`.
- Needs-you count changes are announced in a polite live region, e.g. "1 session needs you".
- F6 / ⇧F6 cycle the regions. Every icon-only control has a tooltip and an `aria-label`.
- Hit targets are at least 24 x 24 everywhere (WCAG 2.5.8), and 44 x 44 on the phone.

### 8.5 Performance budget
- **Effects:**
  - 0 `backdrop-filter` in the shell.
  - 1 native material per window, composited by the OS.
  - No `will-change`, except on orbit glyphs while they spin.
- **Animation:**
  - At most 6 orbiting glyphs on screen at once, counting Live and the tree. Beyond 6, rows show the static ring.
  - Transform and opacity only.
  - Nothing animates while `document.hidden`.
  - At rest, with nothing running, the shell runs 0 animations.
- **Updates:**
  - Status updates are coalesced in `requestAnimationFrame` and batched every 250 ms (1 s on battery, lite tier or unfocused; 2 s when hidden).
  - All relative times share one 60 s timer.
  - The Live list re-sorts at most every 500 ms.
  - Rows are keyed by session id, and order never changes because of status alone.
- **Rendering:**
  - Fixed row heights per density, so windowing is simple.
  - Virtualise the tree above 150 rows, with ±20 rows of overscan.
  - Collapsed groups use `content-visibility: auto`.
  - Sidebar DOM: 600 nodes or fewer.
  - Icons are inline SVG, served from one `<symbol>` sprite.
  - The session store holds 500 sessions; older ones page in from View all.
  - Search virtualises after 50 hits and debounces filtering by 80 ms off the render path.
  - Resize drag: pointermove, then rAF, then set `--vxs-sb-w`. The width is persisted only on pointerup.
- **Targets:**
  - Sidebar paint: 2 ms or less per frame while a transcript streams.
  - Hover or selection paint: 4 ms or less.
  - Switching sessions from the sidebar: no long task over 50 ms.
  - Shell first paint: within 50 ms of the session list arriving.
  - Idle renderer CPU with 3 running sessions: under 1.5%.
- **Verification:** use a static HTML mock reviewed by the owner, plus profiling on CI or a second machine. **Do not run heavy local test suites or dev servers on the owner's Mac while Vector runs.**

### 8.6 Where it lands in code, and timing
- `packages/desktop/src/main/windows.ts`: material options, `resolveMaterial()`, `shell:setMaterial`, plus the preload bridge.
- `packages/app/src/components/workspace-navigation.tsx` (1,031 lines): rebuilt as the sidebar. It keeps the account, help, update, resize and drag logic.
- `packages/app/src/pages/layout-new.tsx` (7,522 lines): `navUnlocked()` returns true on every route, and the hidden legacy `<nav>` is deleted.
- `packages/app/src/pages/home.tsx` (2,001 lines): becomes the empty state.
- `packages/app/src/components/titlebar.tsx` and `titlebar-tab-strip.tsx`: the chrome controls move into the sidebar row, and the tabs go behind a flag.
- `prompt-input.tsx`: composer layout and chips row.
- `background-tasks`: feeds Live.
- `vector-premium.css`: the `--vxs-*` block.
- `ui/src/v2/components/icon.tsx`: the new glyphs.
- **New work in every option:** the parent/child tree, status roll-up, virtualisation, and a **Live aggregator store** over the agent sessions, Vectorscope runs, Hands tasks, Cloud computer jobs and automations.
- **Shipping:** behind `shell.signature`, with the legacy shell kept until the following release.
- **Timing:** build only after the Hands, Codium and VectorScope merges, because those branches edit the same files. The Hands, Cloud computer and Morning queue Live sources stay behind their own feature checks.
- **Held back:** the Connected tools and @vector UI stay hidden until the owner approves them. Their slots are reserved: More › Connected tools for setup, and Live for cross-tool hand-offs.

### 8.7 Persisted preferences
All per viewer, in localStorage, with every access wrapped in try/catch.

| Key | Holds |
|---|---|
| `vector.sidebar.width.v2` | Sidebar width |
| `vector.sidebar.collapsed` | Whether the sidebar is hidden |
| `vector.sidebar.rail` | Whether the slim rail is on |
| `vector.sidebar.density` | `compact` / `default` / `comfortable` |
| `vector.sidebar.secondLine` | `attention` / `all` |
| `vector.sidebar.groupBy` | Grouping |
| `vector.sidebar.order.v1` | Host, project and pinned order |
| `vector.sidebar.collapsedGroups.v1` | Collapsed groups |
| `vector.sidebar.host` | Selected host in switcher mode |
| `vector.live.collapsed` | Whether Live is collapsed |
| `vector.shell.frame` | `flush` / `inset` |

---

## 9. Exact mockup content

The mockup shows the target state after the Hands, Codium and VectorScope merges: dark theme, flush frame, Mac, 1280 x 800, default density, sidebar at 264 px. There are no personal names; the account row says "You".

### 9.1 Sidebar, top to bottom
1. **Chrome:** traffic lights · sidebar toggle · Back (enabled) · Forward (disabled) · Agent | Editor, with Agent active.
2. **Verbs:**
   - New session (shows ⌘N on hover)
   - Search (⌘K on hover)
   - Automations, meta `2:00`
   - Vectorscope, meta `3`
   - More
3. **Live 4** (gradient top edge, because a session is open):

   | # | Glyph | Title | Trailing |
   |---|---|---|---|
   | 1 | ◆ needs you | Fix Codium P8 CI | [Review] pill |
   | 2 | ◌ running | Recheck keyboard focus across menu reads | `12m` |
   | 3 | ◌ running | Vectorscope review · PR #2184 | `vectorscope` glyph, `1m` |
   | 4 | ◌ running | Reproduce Windows packaging limit | `host-cloud` glyph, `4m` |

4. **Pinned:** Release 1.99.114 checklist (done, no glyph), `1d`.
5. **This Mac** (green dot; `+` visible).
   - **[V violet] vector**: no branch chip; meta `4`; expanded.
     - ◌ Recheck keyboard focus across menu reads, running, `12m`. Expanded parent with two children:
       - ╰• ◌ Swarm worker 2, running, `+142 −18` (node dot in the running colour)
       - ╰• ✓ Review: Hands Windows fixes, ready to review, `12m` (node dot in the ready colour)
     - ✓ **Warn on review model evidence**, ready to review, `+318 −32`. **Selected, and the open session.**
     - × Give the packaging dry-run a Windows-sized limit, failed, `2h`. Line 2: "Checks failed · 3".
     - Shorten Windows installer progress copy, done and unread (trailing dot), `3h`.
     - "Show 7 more"
   - **[C teal] vector-codium**: branch chip `codium`; meta `◆ 1`; expanded.
     - ◆ Fix Codium P8 CI, needs you, `2m`. Line 2: "Wants to run pnpm install --frozen-lockfile".
   - **[H ochre] vector-hands**: branch chip `hands`; collapsed; meta `5`.
   - **[V steel] vectordev.ai**: collapsed; meta `2`.
6. **Cloud computer** (`host-cloud`, green dot, `+`):
   - **Morning queue** (sub-group label, 12/16 weight 600 in text-3), count `1`:
     - ◌ dashed: Upgrade Astro on vectordev.ai, queued, `6:00`.
   - **[V violet] vector**:
     - ◌ Reproduce Windows packaging limit, running, `4m`.
7. **Footer:** (Y) You · Codium Max [Founding] · `?` · gear. There is no update row in the default mockup. A variant shows "Restart to update to 1.99.114".

### 9.2 Stage header
"Warn on review model evidence ⌄", then on the right: `+318 −32` · Terminal · Tasks · Side panel toggle · Open in ⌄.

### 9.3 Open session transcript, in order
1. **You** (user block): "Warn in the Vectorscope review panel when a finding's model evidence is missing or older than the diff. Keep the panel layout as it is."
2. **Vector:** "I'll find where Vectorscope builds findings, add an evidence check, then show a warning row in the panel."
3. **Tool step:** `magnifier` · **Searched** `modelEvidence` in packages/app/src · *6 results*
4. **Tool step:** `file` · **Read** review-panel.tsx, findings.ts
5. **File edit card:** `packages/app/src/vectorscope/findings.ts` · `+84 −12` · Open diff ›
6. **File edit card:** `packages/app/src/vectorscope/review-panel.tsx` · `+41 −6` · Open diff ›
7. **Tool step:** `terminal` · **Ran** `pnpm --filter @vector/app typecheck` · *passed · 41s*
8. **Vector:** "Findings now carry an evidence state: Checked, Missing or Stale. The panel shows a warning row for Missing and Stale. I asked Vectorscope to review the change."
9. **Child-session card:** ✓ Vectorscope review · *1 finding* · ›
10. **Vectorscope finding card:**
    - Header: `vectorscope` glyph, "Vectorscope", then a diamond outline and "Medium".
    - Title: "Stale evidence is labelled as checked"
    - Location: `packages/app/src/vectorscope/findings.ts:142`
    - Body: "When the evidence timestamp is older than the head commit on this branch, the row still says 'Evidence checked'. Compare it with the head commit time before calling it current."
    - Actions: [Ask Vector to fix] · Open in diff
11. **File edit card:** `packages/app/src/vectorscope/findings.ts` · `+9 −2` · Open diff ›
12. **Vector:** "Fixed: evidence older than the head commit now reads 'Evidence may be stale'. Ready for your review: 6 files, +318 −32."
13. **Notice line:** "Vectorscope re-checked · no open findings"

### 9.4 Composer and chips (session)
- Placeholder: "Reply, @ for files, / for commands". Send is disabled because the input is empty.
- **Left chips:** `host-mac` This Mac · [V] vector ⌄ · `branch` scope-evidence ⌄
- **Right chips:** Auto ⌄ · **Balanced** (accent) · Manual · ◔ 64%

### 9.5 Second mockup frame: empty state (route "/")
- **Same sidebar**, with no selection. The Live top edge switches to solid accent at 40%.
- **Header:** "New session".
- **Body:**
  - Gradient chip tile.
  - Headline: "Give Vector one concrete outcome."
  - Composer, with placeholder "Describe the outcome. @ to add files, / for commands".
  - **Chips:** This Mac · [V] vector ⌄ · main ⌄ | Auto ⌄ · **Balanced** · Manual · ◔ 64%
- **Recent projects:** [V] vector · [C] vector-codium · [H] vector-hands · [V] vectordev.ai · + Open a folder… · Clone from GitHub…
- **Toggles on the mockup page:** Frame (Flush / Inset card), Theme (Dark / Light), Sidebar (Expanded / Hidden with Live pill / Slim rail), Density (Compact / Default / Comfortable).

---

## 10. What was borrowed, and from which reference pattern

| Pattern | Reference | How Vector uses it |
|---|---|---|
| One edge-to-edge sidebar, one step lighter than an opaque content area; verbs, then a host-scoped session tree, then an account row with a gear | Claude desktop, Code tab (the layout the owner pointed at) | The same structure, with Vector's verbs, hosts, names and palette |
| Title-bar controls inside the sidebar: toggle, back/forward, a 2-segment mode switch | Claude desktop, Code tab | Agent / Editor, Vector's existing switch, with Vector's own glyphs |
| Host header with its own `+`; child session indented under its parent with a connector line | Claude desktop, Code tab | Node-and-edge connectors with status-coloured nodes, 3 levels, collapse and roll-up (the reference has one level, no collapse) |
| Plain-text chips under a rounded composer, with one accent word for effort | Claude desktop, Code tab | Vector's model, effort and mode names, plus the Codium % ring |
| Translucency only at the window's outer chrome, faintly tinted by the wallpaper, with opaque reading surfaces | Codex desktop (its tinted rail) | Native vibrancy or Mica under a 0.84–0.86 tint on the whole sidebar, with no CSS blur |
| Inset content card with a hairline and a rounded top-left corner | Codex desktop | Offered as the Inset card A/B option; flush is the default |
| Soft inset selection pill; sentence-case grey section labels; one-line muted tool steps; outline notice cards with one solid pill action; big rounded composer with controls tucked in | Codex desktop | Vector values: radius 7 pill, radius 14 composer, violet rounded-square Send (not a white circle) |
| One list for every place an agent runs; two-line rows only when they carry a signal; diff counts on rows; labelled grouping controls | Cursor Agents Window | Host groups plus a "View" text button with Group by, Sort, Second line and Density |
| Grouping by state; letter tiles as project avatars; desktop/phone parity; a cut-out status badge on tiles | Paseo | Vector's own tile palette; status badges on rail tiles; the same IA on the phone |
| Native material only (macOS vibrancy, Windows 11 Mica) with a solid fallback; edge-to-edge sidebar | Apple HIG and Microsoft Mica guidance | One switchboard covering preference, accessibility, lite tier, platform and Browser panel |

None of these is borrowed: another product's name, logo, icon set, palette (no warm brown-grey, no pure-neutral greys with a purple accent word, no teal), mode-switch glyphs, nav labels, white circular send button, bell, mascot, or "Approve for me"-style chip text.

## 11. What is Vector's own

1. **The Live strip.** One self-hiding card that merges agent sessions, Coordinated runs, Vectorscope reviews, Hands tasks, the Cloud computer, Done by Morning and automations. It becomes a header pill when the sidebar is hidden and a sticky card on the phone. No reference app shows reviews, computer use and a cloud machine in one live list.
2. **Node-and-edge connectors.** Child sessions and swarm workers hang off their parent on lines that end in status-coloured nodes, forming a small "vector graph". The same node marks drag drop lines.
3. **The status shapes.** Orbit (running), diamond (needs you), check ring, x ring, dashed ring, pause bars and stop square. Shape always pairs with colour, and status words stay neutral.
4. **The palette.** Graphite with a faint violet cast (`#201F24` sidebar over a `#161519` stage). Vector lavender (`#9274EC` / `#B69FF7`, `#6A4FD6` in light) appears only for running work, focus, Send, accent words and Founding.
5. **One brand moment per screen.** The gradient chip tile on the empty state, or the gradient Live edge on session routes, never both. The static "vector field" dot backdrop sits behind the empty state.
6. **Vector's hosts and names.**
   - Hosts: This Mac / This PC, remote servers, Cloud computer with its Morning queue, paired phones.
   - Verbs: New session, Search, Automations, Vectorscope, More.
   - Switch: Agent | Editor.
   - Effort: Default / Light / Balanced / Extra / Max. Mode: Manual / Plan / Full access.
   - Usage: Codium as a percentage. Plan badge: Founding.
   - Headline: "Give Vector one concrete outcome."
7. **Vector's icon set.** A 1.5-stroke 16 px set, with new host, Live, automation, Vectorscope and status glyphs.
8. **Fixes for the references' known complaints:**
   - headers differ from rows;
   - titles are soft at rest, and emphasis never changes weight;
   - a legend for every glyph;
   - location never covers status;
   - stable, user-ordered hosts and projects;
   - a `+` per host that acts on that host;
   - a resizable width with a reset;
   - three densities;
   - an optional rail that is never forced;
   - usage always beside the composer;
   - live work never buried;
   - a fully specified light theme;
   - real material with a solid fallback and no live blur.

---

## 12. Decision log: how candidate and judge conflicts were resolved

| Topic | Options | Resolution | Why |
|---|---|---|---|
| Base concept | Column (usability pick), Card, Signature (appeal and fit picks) | **Signature** as the base, with the grafts below | 2 of 3 judges picked it; it has the only ownable signature and the fewest sidebar sections |
| Inline Approve in Live | Signature: one-click Approve plus ⌘↵ | **Not in v1.** Needs-you items show a **Review** pill that opens the permission prompt; no Approve shortcut | Usability and fit judges: misclick and safety risk |
| Weight change on emphasis | Signature: 500 on selected, unread, needs you | **Colour only, never weight** | Appeal and usability judges: no text reflow |
| Status-coloured text | Column and Signature used amber/red words | **Words neutral (text-2); only glyphs carry colour.** Diff counts are the one exception, using dedicated `--vxs-diff-*` tokens at 4.5:1 or better | Light-mode status words were 3.3–4.0:1 |
| Tertiary text contrast | Signature `#8A8891` / `#6E6C77` | **`#95929C` / `#66636D`** (5.35 / 5.3 on the solid sidebar); text-2 light moved to `#4F4D57` to keep the step | Survives the material: worst case 4.64 dark, 4.56 light |
| Meta on the selected pill | text-3 everywhere | **text-2 on the selected pill** | text-3 there is 4.16:1 |
| Mica tint | Column 0.72, Card 0.78, Signature 0.86 | **0.84 dark / 0.82 light** (vibrancy 0.86 / 0.84) | Usability judge: at least 0.80 |
| Shortcut hints | text-4 (2.4:1) | **text-3** | They carry information |
| Hover action targets | 20 px | **24 px** | WCAG 2.5.8 |
| Density | Signature: Calm / Detailed (line 2); Card: 3 heights | **Compact / Default / Comfortable** heights, **plus** a separate Second line: Attention only / All rows | Usability judge graft from Card; keeps Signature's detailed mode |
| Needs-you glyph | Column: filled rounded square with a "!"; Card: dot with a halo; Signature: diamond | **Diamond (8 px, filled)** | Shape-distinct from green, as the usability judge required; lighter than Column's heavy filled glyph, as the appeal judge required |
| Failed glyph | Column: solid red circle with x; Signature: 18% fill with x | **Signature's 18% fill** | Calm |
| Needs-you section | Column and Card: a separate section; Signature: Live | **Live only** (capped at 4, needs you first), plus the header pill, ⌘⇧J and the Dock badge | One place for live state (fit judge) |
| Live height jumps | Not addressed | **Inserts and removals deferred while the pointer is in the sidebar** (max 3 s); re-sort at most every 500 ms; stable order within tiers | Usability concern about the tree moving |
| Gradient | Signature: Live edge; Column: empty-state tile; Card: New session tile | **Tile on the empty state; Live edge on session routes; solid accent edge when both would show.** No gradient on New session | One per screen (appeal judge) |
| Empty-state hero | Signature: 24 px monochrome chip, 20/28 headline | **Column's 32 px gradient tile, Geist 24/30 headline, static dot field** | Appeal judge |
| Empty state with no project | Card: Send disabled | **Composer usable; Send opens the picker** | Usability judge |
| Project chosen in two places | Signature: subline and chip | **Chip only** | Usability judge |
| Title truncation | Ellipsis | **20 px mask fade**, with the full title in the tooltip and aria-label | Appeal judge graft from Card |
| Frame | Card: inset card; others: flush | **Flush default; Inset card as an A/B option** (6 px strip, radius 10 / 8, header 32 on the same chrome line) | Owner pointed at a flush reference; Card's frame is the biggest premium lift |
| Hosts | Signature: all stacked; Card: switcher | **Stacked with 1–2 hosts; switcher popover with 3 or more**, plus All hosts | Fit judge graft |
| Vibrancy and the embedded browser | Signature: drop vibrancy entirely; Column: drop it only while the Browser panel is open | **Solid only while the Browser panel is visible**, pending the spike | Fit judge; `browser-agent.ts` embeds a WebContentsView |
| Collapse motion | Column: animated grid columns; Card: snap; Signature: translateX | **translateX 180 ms, with one width change** | No per-frame layout (fit judge) |
| Collapsed default | Card: rail; Column and Signature: hidden | **Hidden, plus the Live pill in the header; rail optional (52 px)** | Owner wants one sidebar; attention never depends on the sidebar |
| Battery | Column: switch to solid on Windows battery | **Keep the material; throttle updates and pause the orbit** | Materials are OS-composited; Mica handles Battery Saver itself |
| Token namespace | Column extended `--vx-*` and redefined `--vx-stage` (45 uses) | **New `--vxs-*` under `html[data-shell="signature"]`** | No leaks into other branches (fit judge) |
| Automations | Column: a new page | **Existing modal in v1** | Less scope |
| Unread clearing | Signature: after 1.5 s on screen | **When the session is opened**, or via Mark as read | Usability judge |
| Sidebar width | 256, 264 or 264; minimum 220 / 228 / 232 | **264 default, 236–360** | 236 is the smallest width at which the chrome row fits without collision |
| Keyboard and AT model | Partial in Signature and Card | **Column's:** role=tree, roving tabindex, F6 cycling, ⌘⇧J, aria-description, polite live region | Usability judge graft |
| Coordinated runs | Only in More | **One Live item each, with a child count**; setup stays in More | Fit judge gap |

---

## 13. Open decisions for the owner

1. **Frame:** Flush (default) or Inset card. Both are in the mockup.
2. **Title-bar session tabs:** retire them (the spec has them off by default behind a setting) or keep them on.
3. **⌘B:** rebind it from the Home toggle to show/hide the sidebar.
4. **Inline Approve in Live:** add it in a later release after a separate safety review. It would apply only to a single permission request with a default, never anything ambiguous.
5. **Model chip label:** the mockup shows "Auto"; the real list comes from Vector's model picker.
6. **Duplication:** live sessions appear in both Live and their project tree. The alternative is to remove them from the tree while they are live, which hides their context.
7. **Palette cast:** the faint violet cast is a single token change if the owner prefers pure neutral or warm.

## 14. Risks

- **Electron issue 41979 (vibrancy wiping WebContentsView content).** The Browser panel needs a spike on a separate machine. The fallback is solid-while-visible, or a solid Mac sidebar at first.
- **macOS 27 material.** Nobody has checked how the NSVisualEffectView `sidebar` material reads with macOS 27's Liquid Glass clear-to-tinted slider. The tint may need retuning between 0.82 and 0.90.
- **Contrast is estimated, not measured.** The figures over material are estimates. Check them by eye with bright and saturated wallpapers in both themes. The design assumes the OS material never passes pure white through.
- **Mica on frameless windows** in Electron 42.11.4 may still flicker or turn black when resizing or maximising. Ship Windows solid first if the manual check fails. Windows 10 and Linux get solid only.
- **Reduce Transparency changes.** `nativeTheme` 'updated' may not fire when they happen. The re-check on focus means a toggle can apply late.
- **The Live aggregator is new work** over five sources, several of them owned by unmerged branches. Their labels (Watch, Take over, Hands statuses) may change before merge.
- **Live can get noisy under heavy multi-agent load.** The cap of 4, the strict order and the deferred inserts limit this, but it needs a review under real load.
- **Shortcut and habit changes.** Rebinding ⌘B and ⌘1–9, adding ⌘⇧J, ⌘⇧L and ⌘⇧E, and retiring the tabs all change muscle memory. Check them against the keybinding map, and add a changelog note.
- **Merge conflicts.** The build touches files that the Hands, Codium and VectorScope branches also edit. Build only after they merge.
- **Light mode is new.** Today's `--vx` light block is dead code. Every light value here needs a visual pass.
- **The mockup measurements** come from reference screenshots assumed to be 2x (±5%). Judge final spacing on screen.
- **Profiling must not run on the owner's Mac while Vector is running.**
