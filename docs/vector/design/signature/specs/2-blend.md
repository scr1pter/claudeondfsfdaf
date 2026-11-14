# Vector Signature Blend: spec for the whole desktop app

Status: design spec for artboards only. Nothing is built, no repository file is touched, nothing is installed, launched or tested. Every repository fact below was read from the read-only checkout `/Users/aik010/.cache/vector-review-main` (origin/main `0dcbb8e2d`), from `origin/hands`, `origin/codium`, `origin/vectorscope` and `origin/connected-workspace` with `git show`, and from the owner's two screenshots. Revised on 2026-11-11 after a review; what changed and why is in section 11.

Inputs:
- Signature spec: `scratchpad/vector-glass-concept-spec.md` (called "SIG" below; section numbers like SIG 4.6).
- Signature artboards: `scratchpad/vector-glass-canvas/project/Main.dc.html` ("Main") and `Sidebar.dc.html`.
- Owner screenshot of Signature: `images/3.png`. Owner screenshot of today's app: `images/4.webp` (ground truth for today's look; reference only, nothing in today's app is redesigned from scratch).

All paths in this file are relative to `docs/vector/design/signature/` (boards in `canvas/`, specs in `specs/`) unless they start with `/` or `packages/`.

Rules that apply to every artboard:
- The account row and every mockup say "You" and "Codium Max". The GitHub login in mockups is "@you". No personal names or emails anywhere.
- No other product's logos, names or exact look. No third-party brand marks, favicons, provider icons or model names in mockups (use "Codium Auto", which is Vector's own model name). Never name an open-source project Vector's code may derive from.
- Codium shows percentages and the word "Codium", never tokens or prices.
- All sizes are CSS px. Dark theme only on the new boards (today's app has no light theme; the `--vxs-*` light values stay defined but are not drawn).

---

## 1. The blend in one table

| Area | Comes from | What changes |
|---|---|---|
| Window frame, wallpaper, material | Signature (Main) | Nothing. Same frame recipe and wallpaper |
| Sidebar | Signature | Project letter tiles removed everywhere (section 3.1). Footer becomes today's account row (section 3.2). Everything else identical |
| Session header | Today's buttons in Signature finish | Title and project name; branch chip, status chip, Tasks, Changes, Terminal on row 1; usage pill, context ring, "…" on row 2. Same set, order, icons and labels; 2 to 4 px smaller |
| Composer | Signature shape, today's controls | Signature box (radius 14, raised fill, hairline) with today's paperclip in Signature's left slot. Today's model, mode, effort, speed pickers, mic and square send, all kept, smaller |
| Transcript | Signature layout, today's pieces | Today's tool rows, error rows, edit cards, task cards, finding cards and docks in Signature type and spacing |
| Changes screen | Today, unchanged | Only the outer shell around it changes (section 5) |
| Browser | New | Two concepts: the panel browser in three modes (A "Beside", B "Run view", C "Inspect") and D "In the chat", live page cards in the transcript (section 6) |
| Vectorscope, Settings, Tasks, Search, MCP, Plugins, Automations, Agent Dashboard, New workspace, Coordinated runs, saved workflows | Today's structure in Signature finish | Section 7 |

---

## 2. Shared foundation

### 2.1 Frame and wallpaper (copy from Main, unchanged)

Copy these blocks from Main exactly:
- `<helmet>` styles (Main lines 10-39) including `.vx-h`, `.vx-row`, `.vx-composer`, `.vx-scroll`, `.vx-pop`, the `vx-orbit` and `vx-in` keyframes and the reduced-motion rule.
- The outer artboard div (line 41): `data-theme`, wallpaper `background-color: {{wall.base}}; background-image: {{wall.image}}`, the blurred ribbon (line 42) and glow (line 43).
- The window div (line 45): radius 12, `overflow: hidden`, `box-shadow: {{t.windowShadow}}`.
- Traffic lights (lines 47-51): 12 px circles at left 16, top 16, gap 8, `#FF5F57 #FEBC2E #28C840`.
- The script helpers `rgb`, `rgba`, `mix`, `accents` and the dark `t` and `wall` objects, all in Main's script block (lines 830-984). Only dark values are used.

Board sizes:

| Board group | Artboard | Window | Artboard padding |
|---|---|---|---|
| Chat, Settings | 1440 x 960 | 1360 x 860 | 50 top/bottom, 40 left/right |
| Changes, Browser A/B/C, Vectorscope, Everyday | 1600 x 1000 | 1520 x 900 | 50 top/bottom, 40 left/right |

The sidebar is 264 wide in every board, so the stage is 1096 (small boards) or 1256 (large boards).

### 2.2 Tokens

Use the SIG 5.1 dark tokens unchanged. The names below are the ones used in this spec; their values are repeated so an author never has to look them up.

| Token | Dark value |
|---|---|
| `--vxs-main` | `#161519` |
| `--vxs-sidebar` | `#201F24` (mockup material: `rgba(32,31,36,0.86)` + `blur(20px) saturate(1.15)`, as Main's `t.sbBg`) |
| `--vxs-edge` | `rgba(255,255,255,0.08)` |
| `--vxs-hairline` | `rgba(255,255,255,0.07)` |
| `--vxs-hairline-strong` | `rgba(255,255,255,0.12)` |
| `--vxs-raised` | `#27262C` |
| `--vxs-raised-border` | `rgba(255,255,255,0.08)` |
| `--vxs-raised-highlight` | `inset 0 1px 0 rgba(255,255,255,0.045)` |
| `--vxs-shadow-composer` | `0 8px 24px rgba(0,0,0,0.22)` |
| `--vxs-menu` | `#2A292F` |
| `--vxs-menu-shadow` | `inset 0 1px 0 rgba(255,255,255,0.04), 0 0 0 0.5px rgba(255,255,255,0.08), 0 2px 6px rgba(0,0,0,0.30), 0 14px 36px rgba(0,0,0,0.45)` |
| `--vxs-tooltip-bg` / `-text` | `#35343B` / `#ECEBEF` |
| `--vxs-row-hover` | `rgba(255,255,255,0.045)` |
| `--vxs-row-selected` | `rgba(255,255,255,0.085)` + `inset 0 0 0 1px rgba(255,255,255,0.025)` |
| `--vxs-row-pressed` | `rgba(255,255,255,0.11)` |
| `--vxs-seg-track` / `--vxs-seg-active` | `rgba(255,255,255,0.05)` / `rgba(255,255,255,0.10)` |
| `--vxs-text` | `#ECEBEF` |
| `--vxs-text-row` | `#BDBBC4` |
| `--vxs-text-2` | `#A9A7B0` |
| `--vxs-text-3` | `#95929C` |
| `--vxs-text-disabled` | `#5D5B63` |
| `--vxs-icon` | `#A9A7B0` |
| `--vxs-accent` | `#9274EC` |
| `--vxs-accent-strong` | `#7C5CE6` |
| `--vxs-accent-text` | `#B69FF7` |
| `--vxs-accent-soft` | `rgba(146,116,236,0.16)` |
| `--vxs-focus` | `#B69FF7` |
| `--vxs-running` | `#A58CF2` |
| `--vxs-needs` | `#E2AB57` |
| `--vxs-ready` | `#62C48D` |
| `--vxs-failed` | `#E8777D` |
| `--vxs-diff-add` / `--vxs-diff-del` | `#62C48D` / `#EE8388` |
| `--vxs-gradient-brand` | `linear-gradient(135deg,#D9C6FF 0%,#A883FF 52%,#7C4DFF 100%)` |

**New blend tokens** (dark only). Each one carries a value from today's app, so today's controls keep their look:

| Token | Value | Use | Today's source |
|---|---|---|---|
| `--vxs-code` | `#121117` | Code blocks, bash output, suggested-change boxes | diff fill in session-review-v2.css |
| `--vxs-card` | `rgba(255,255,255,0.035)` | Task, dashboard and plugin cards | replaces `#211e26` on the darker stage |
| `--vxs-card-2` | `rgba(255,255,255,0.055)` | Phase blocks inside task cards | replaces `#29252f` |
| `--vxs-chip-fill` | `rgba(255,255,255,0.025)` | Header branch and status chips | `[data-vector-session-branch]` |
| `--vxs-chip-border` | `rgba(255,255,255,0.07)` | Same | same |
| `--vxs-active-fill` | `rgba(182,159,247,0.11)` | Active header tool button, Review button, Commit button | `[data-active=true]` |
| `--vxs-active-border` | `rgba(182,159,247,0.28)` | Same | same |
| `--vxs-badge-fill` / `-text` | `rgba(255,255,255,0.07)` / `rgba(255,255,255,0.64)` | Count badges | `[data-vector-session-count]` |
| `--vxs-badge-accent-fill` / `-text` | `rgba(182,159,247,0.14)` / `#B69FF7` | Running count, Changes tab count | Tasks badge |
| `--vxs-badge-needs-fill` / `-text` | `rgba(226,171,87,0.16)` / `#E2AB57` | "Waiting on you" count | Tasks badge |
| `--vxs-dot-neutral` | `#8A8595` | Manual, Normal dots | prompt-input.tsx, research-model.ts |
| `--vxs-dot-violet` | `#9B6CFF` | Plan, Fast dots | same |
| `--vxs-dot-full` | `#E6A15C` | Full access dot | same |
| `--vxs-dot-quick` | `#70C7B1` | Quick dot | same |
| `--vxs-dot-research` | `#6EA8FE` | Deep research dot | same |
| `--vxs-glow-text` | `#C9B2FF` + `text-shadow: 0 0 10px rgba(155,108,255,0.45)` | Fast label, Max effort label | same |
| `--vxs-quick-text` / `--vxs-research-text` | `#9CE0CF` / `#A9C8FF` | Quick and Deep research labels | same |
| `--vxs-add-bg` / `--vxs-add-text` | `rgba(98,196,141,0.10)` / `#A8E2BF` | Added code lines outside Changes | Changes snippet |
| `--vxs-del-bg` / `--vxs-del-text` | `rgba(238,131,136,0.10)` / `#F0B0B3` | Removed code lines outside Changes | Changes snippet |
| `--vxs-terminal` | `#121115` | Terminal panel, Inspect device canvas | darker than stage |
| `--vxs-viewport` | `#242428` | Browser viewport behind a loading page | PreviewPanel |
| `--vxs-icon-quiet` | `rgba(255,255,255,0.38)` | Account row Help and Settings icons | `[data-vector-nav-footer]` |
| `--vxs-avatar` / `-text` | `#9274EC` / `#FFFFFF` | Account avatar without a photo | `--vx-purple` |
| `--vxs-drive-line` | `rgba(165,140,242,0.60)` | Top line of the browser driving bar | new |
| `--vxs-drive-outline` | `rgba(165,140,242,0.45)` | Static frame round a page Vector drives | new |
| `--vxs-control-line` | `rgba(226,171,87,0.60)` | Top line of the "You have control" bar | new |

### 2.3 Type

The SIG 5.8 stack: UI `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`; mono `"SF Mono", ui-monospace, "Cascadia Code", Menlo, Consolas, monospace`; Geist only for the empty-state headline. Antialiased.

| Role | Size / line | Weight | Colour |
|---|---|---|---|
| Header title | 13/18 | 500 | text |
| Header project name | 11/14 | 400 | text-3 |
| Header chip and tool labels | 12/16 (chips 11/14) | 400 | text-2 |
| Composer text | 14/22 | 400 | text |
| Picker chips | 12/16 | 400 model, 500 mode and speed | text-2 |
| Transcript body | 14/22 | 400 | text |
| Tool row title / detail | 13/20 | 500 / 400 | text-2 / text-3 |
| Card titles | 13/18 | 500 | text |
| Meta, counts, kbd | 11/14 tabular, +0.01em | 400 | text-3 |
| Badges | mono 10/12 | 600 | badge tokens |
| Menu rows | 13/18 | 400 | text-row (text on hover) |
| Menu secondary text (descriptions, badges, keys, paths, times on rows) | 11/14 or 12/16 | 400 | text-2 (text-3 fails on hovered and keyboard-active rows) |
| Menu headings | 11/14 | 500 | text-3 |
| Section labels | 12/16 sentence case | 600 | text-3 (never uppercase) |

### 2.4 Icons

Today's icons keep their shapes; they take the Signature finish: round caps and joins, `currentColor`, no fills except where noted. A blended icon is "today's path, drawn at the blend size and stroke".

| Icon | viewBox | Path data (today's shape) | Size | Stroke |
|---|---|---|---|---|
| `task` (Tasks) | 0 0 20 20 | `M10 2.08V17.92M7.08 3.75H2.08V16.25H7.08M12.92 16.25H17.92V3.75H12.92` | 14 | 1.5 |
| `review` (Changes) | 0 0 20 20 | `M7 14.5H13M7 8H13M10 5V11M18 18V2L2 2L2 18H18Z` | 14 | 1.5 |
| `review-active` | same | same, plus the square filled `currentColor` at 10% | 14 | 1.5 |
| `terminal` | 0 0 20 20 | `M6.5 8L8.64 10L6.5 12M10.93 12H13.5M2 18H18V2H2V18Z` | 14 | 1.5 |
| `session-branch` (header, left of title) | 0 0 16 16 | `M4.1 2.3v6.1a2.7 2.7 0 0 0 2.7 2.7h2.45M4.1 2.3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm7.8 8.8a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm0 0V5.85A2.7 2.7 0 0 0 9.2 3.15H7.45` | 14 | 1.25 |
| `chevron-down` | 0 0 20 20 | `M6.67 8.33L10 11.67L13.33 8.33` | 12 | 1.75 |
| `outline-dots` ("…") | 0 0 16 16 | three filled squares 1.6 x 1.6, rx 0.4, at (2.2,7.2), (7.2,7.2), (12.2,7.2) | 14 | fill |
| `generic-provider` (model) | 0 0 24 24 | rects 16x7 rx 2 at (4,4) and (4,13); `M8 7.5h.01M8 16.5h.01M12 7.5h4M12 16.5h4` | 14 | 1.75 |
| `mic` | 0 0 16 16 | `M8 9.6a2.1 2.1 0 0 0 2.1-2.1V4.1a2.1 2.1 0 1 0-4.2 0v3.4A2.1 2.1 0 0 0 8 9.6Zm4-2.1a4 4 0 0 1-8 0M8 11.5v2M6 13.5h4` | 14 | 1.4 |
| `paperclip` | 0 0 16 16 | `M12.8 7.2 8.3 11.7a2.6 2.6 0 0 1-3.68-3.68l4.6-4.6a1.75 1.75 0 0 1 2.47 2.47l-4.6 4.6a.9.9 0 0 1-1.27-1.27l4.24-4.25` | 14 | 1.4 |
| `arrow-up` (Send, Queue) | 0 0 24 24 | `M12 19V5.5M6.5 11L12 5.5l5.5 5.5` | 14 | 2 |
| `stop` | CSS | 10 x 10 square, radius 2 | 10 | fill |
| `circle-ban` (tool error) | 0 0 16 16 | circle cx 8 cy 8 r 6; `M3.76 12.24 12.24 3.76` | 16 | 1.4 |
| `warning` (permission) | 0 0 16 16 | `M8 2.5 14.2 13.5H1.8Z M8 6.6v3.1 M8 11.7v.01` | 16 | 1.4 |
| `help` (account row) | 0 0 16 16 | circle r 6.1; `M6.2 6.25a1.85 1.85 0 0 1 3.6.55c0 1.15-1.8 1.35-1.8 2.4`; dot r 0.7 at (8,11.35) filled | 14 | 1.25 |
| `gear` (account row) | 0 0 16 16 | `M8 10.35A2.35 2.35 0 1 0 8 5.65a2.35 2.35 0 0 0 0 4.7Zm4.72-1.35a4.8 4.8 0 0 0 0-2l1.2-.92-1.2-2.08-1.42.58a5.1 5.1 0 0 0-1.72-1L9.4 2H6.6l-.18 1.58a5.1 5.1 0 0 0-1.72 1L3.28 4l-1.2 2.08 1.2.92a4.8 4.8 0 0 0 0 2l-1.2.92L3.28 12l1.42-.58a5.1 5.1 0 0 0 1.72 1L6.6 14h2.8l.18-1.58a5.1 5.1 0 0 0 1.72-1l1.42.58 1.2-2.08-1.2-.92Z` | 14 | 1.25 |
| `window` (Browser tab, today) | 0 0 16 16 | `M2.25 4.25A1.25 1.25 0 0 1 3.5 3h9A1.25 1.25 0 0 1 13.75 4.25v6.5A1.25 1.25 0 0 1 12.5 12h-9a1.25 1.25 0 0 1-1.25-1.25v-6.5Z M2.75 5.5h10.5` | 14 | 1.25 |
| `lock` | 0 0 16 16 | `M5 7V5.2a3 3 0 0 1 6 0V7M4.2 7h7.6v6H4.2z` | 12 | 1.3 |
| `vectorscope` (lens) | 0 0 24 24 | circle r 7.5; circle r 2.5; `M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3` (Main) | 14-16 | 1.75 |
| `globe` | 0 0 24 24 | circle r 8.5; `M3.5 12h17M12 3.5c2.5 2.6 3.7 5.4 3.7 8.5s-1.2 5.9-3.7 8.5c-2.5-2.6-3.7-5.4-3.7-8.5S9.5 6.1 12 3.5Z` | 14-16 | 1.75 |
| `crosshair` (pick) | 0 0 24 24 | circle r 6; `M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4` | 14 | 1.75 |
| `camera` (capture) | 0 0 24 24 | `M4 8.5a2 2 0 0 1 2-2h2l1.5-2h5L16 6.5h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z`; circle cx 12 cy 13 r 3.5 | 14 | 1.75 |
| `device-phone` / `-tablet` / `-desktop` | 0 0 24 24 | rect 10x18 rx 2.5 at (7,3) + `M11 18h2` / rect 14x18 rx 2.5 at (5,3) / rect 18x12 rx 2 at (3,4.5) + `M9 20h6M12 16.5V20` | 14 | 1.75 |
| `rotate` | 0 0 24 24 | `M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19.5 9M19.5 4.5V9H15` | 14 | 1.75 |
| `expand` / `collapse` | 0 0 24 24 | `M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5l-6 6M4.5 19.5l6-6` / arrows reversed | 14 | 1.75 |
| `external` (open in system browser) | 0 0 24 24 | `M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 14v3.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2H10` (Main "Open in") | 14 | 1.75 |
| `sidebar-toggle` (Vector sidebar, today) | 0 0 24 24 | rect 18x15 rx 3 at (3,4.5); `M9 4.5v15` | 14 | 1.75 |

Status glyphs are the SIG 5.10 set exactly (orbit, diamond, x-ring, check-ring, dash-ring, pause-bars, square-stop), copied from Main lines 213-217.

### 2.5 Component recipes used everywhere

| Recipe | Spec |
|---|---|
| **Icon button** | 24 x 24 (in headers, rows, toolbars) or 28 x 28 (in the composer and footers). Radius 6 (24) / 7 (28). Transparent. 14 px icon in `--vxs-icon`. Hover `--vxs-row-hover`, icon `--vxs-text`. Pressed `--vxs-row-pressed`. Disabled icon `--vxs-text-disabled`. Focus `outline: 2px solid --vxs-focus; outline-offset: 2px` |
| **Blend chip** | 24 tall, padding 0 6, radius 6, gap 5, transparent at rest. 12/16. Hover `--vxs-row-hover`; open `--vxs-row-pressed` with text `--vxs-text`. Trailing 12 px `chevron-down` in `--vxs-text-3`, margin-left -1. Menus open upward, gutter 6 |
| **Header chip** | 22 tall visual inside a 24 hit area (1 px transparent outer margin). Padding 0 7, radius 6, gap 6, 1 px `--vxs-chip-border`, fill `--vxs-chip-fill`. Hover border `--vxs-hairline-strong`, fill `--vxs-row-hover`, text `--vxs-text` |
| **Tool button** (header) | 24 tall, padding 0 7 0 6, radius 6, gap 5, 1 px transparent border. 14 px icon + 12/16 label in `--vxs-text-2`. Hover fill `--vxs-row-hover`, border `rgba(255,255,255,0.06)`, text and icon `--vxs-text`. Active: fill `--vxs-active-fill`, border `--vxs-active-border`, text and icon `--vxs-accent-text`, icon switches to its `-active` variant. This purple is today's active state, kept because the owner likes today's top buttons; Signature keeps purple for running, focus and Send only. The neutral alternative (`--vxs-row-selected`, text and icon `--vxs-text`, `-active` icon kept) is open decision 8 |
| **Count badge** | min-width 14, height 14, padding 0 3, radius 4, mono 10/14 weight 600, tabular. Neutral: `--vxs-badge-fill` / `--vxs-badge-text`. Running: accent badge. Waiting: needs badge |
| **Primary pill** | 28 tall (24 in toolbars, 20-22 in bars and pills), padding 0 12, radius 7, fill `--vxs-text`, label 12/16 weight 600 in `--vxs-main`. Hover fill `#FFFFFF`. Optional 14 px leading icon in `--vxs-main`. Give back is always this pill (today's cloud bar uses the white "contrast" button for it), in the cloud bar and in every browser concept |
| **Accent pill** | Same size, fill `--vxs-accent-strong`, label `#FFFFFF` (4.64:1). Used only where today's button is purple and carries white (Send, Delegate, Use on the model suggestion) |
| **Secondary button** | 28 (or 24) tall, padding 0 10, radius 7, transparent, 1 px `--vxs-hairline-strong`, 12/16 weight 500 `--vxs-text`. Hover `--vxs-row-hover` |
| **Ghost button** | Same size, no border, 12/16 weight 500 `--vxs-text-2`. Hover `--vxs-row-hover`, text `--vxs-text` |
| **Danger button** | Secondary with border `rgba(238,131,136,0.45)` and label `--vxs-diff-del`. Hover fill `rgba(238,131,136,0.10)` |
| **Tint button** | Today's violet tint, smaller: 24 tall, padding 0 10, radius 6, fill `--vxs-active-fill`, 1 px `--vxs-active-border`, 12/16 weight 500 `--vxs-accent-text`. Hover fill `rgba(182,159,247,0.16)` |
| **Menu** | Fill `--vxs-menu`, radius 10, 1 px `--vxs-raised-border`, `--vxs-menu-shadow`, padding 4. Rows 28 tall, padding 0 10, radius 6, 13/18 `--vxs-text-row`; hover `--vxs-row-hover` with text `--vxs-text`; keyboard-active row `--vxs-row-selected`. Secondary text on a row (descriptions, badges, key chips, paths, times) is `--vxs-text-2`: 6.07:1 at rest, 5.30 hovered, 4.66 keyboard-active (`--vxs-text-3` drops to 4.12 and 3.62). `--vxs-text-3` stays only on text that never sits on a hovered row (headings, captions, notes, empty lines; 4.72 on the menu fill). Separator 1 px `--vxs-hairline`, margin 4 6. Heading 11/14 weight 500 `--vxs-text-3`, padding 6 10 4. Enter 140 ms (`vx-in`), exit 100 ms |
| **Tooltip** | Fill `--vxs-tooltip-bg`, text 12/16 `--vxs-tooltip-text`, padding 4 8, radius 6, shadow `0 4px 12px rgba(0,0,0,0.30)`. Shortcut after an 8 px gap in `--vxs-text-2` (5.18:1 on the tooltip fill; `--vxs-text-3` is 4.03). 300 ms delay |
| **Outline card** | Radius 10 (transcript) or 12 (docks), 1 px `--vxs-hairline` (or `--vxs-hairline-strong` for docks and findings), transparent fill, no shadow |
| **Switch** | Track 32 x 18, radius 9. Off: fill `rgba(255,255,255,0.12)`, 1 px `rgba(255,255,255,0.12)`. On: fill `--vxs-accent-strong`, no border. Thumb 14 px `#F4F3F7`, shadow `0 1px 3px rgba(0,0,0,0.35)`, inset 2, moves 14 px in 140 ms |
| **Segmented control** | Track 26 tall, radius 8, fill `--vxs-seg-track`, 1 px `--vxs-hairline`, inset 2. Segments 22 tall, padding 0 8, radius 6, 12/16 `--vxs-text-2`. Active fill `--vxs-seg-active`, text `--vxs-text`. Disabled 40% |
| **Text field** | 28 tall, padding 0 10, radius 7, fill `--vxs-row-hover`, 1 px `--vxs-hairline`, 13/18 `--vxs-text`, placeholder `--vxs-text-3`. Focus border `rgba(182,159,247,0.45)` |

---

## 3. Sidebar: Signature, logos removed, today's account row

The sidebar is Main's expanded `<nav aria-label="Vector sidebar">` (Main lines 52-256) and the rail `<nav aria-label="Vector sidebar, collapsed">` (lines 258-290), copied with the deltas below and nothing else changed: chrome row, five verbs, More menu, Live strip, Pinned, host groups, connectors, status glyphs, meta slots, hover rules, Show N more, all as in SIG 4.2-4.3.

### 3.1 Logos removed

The project letter tiles go everywhere they appear. Nothing replaces them with another mark; alignment is kept by leaving the slot empty.

| Place | Main line | Today in Main | Blend |
|---|---|---|---|
| Project header row | 188 | 16 px letter tile at x 18 | **A 12 px open/closed chevron, always visible, centred in the 16 x 16 slot at x 18-34**, in `--vxs-text-3`: pointing right when the project is collapsed, down when expanded (rotation 140 ms). It is a control (it toggles the project), not a logo, and today's sidebar shows the same chevron before project names. Name stays at x 42, 13/18 weight 500 `--vxs-text`, aligned with session titles under it. Why the chevron is always on: a session row turns `--vxs-text` when it is selected, needs you, is unread or failed, and then a header would differ from it by weight alone, which breaks SIG 5.8's rule that a header differs from a row in two of size, weight and colour. The chevron gives the header a second, constant difference. Hover no longer changes the slot; the meta still swaps to `+` and `⋯` (SIG 4.2) |
| Pinned project rows | in the Pinned `sc-for` | (a pinned project would show its tile) | Same as a project header: chevron in the slot, name at x 42, weight 500 |
| Rail attention items | 278 | 24 px letter tile with a 10 px status corner badge | **The status glyph alone**, at 14 px, centred in the 36 x 32 button (orbit, diamond, x-ring, check-ring; an unread session shows the 6 px `--vxs-text` dot). Tooltip: "{session title} · {project}". Selected item `--vxs-row-selected`, radius 8 |
| Composer project chip (session) | 568 | 14 px tile + "vector ⌄" | **"vector ⌄" only**: name 12/16 `--vxs-text`, chevron 12 px `--vxs-text-3`, blend chip recipe. The "·" separators either side stay |
| Composer project chip (empty state) | 628 | same | Same. With no project it reads "Choose a project ⌄" in `--vxs-accent-text` (SIG 4.7) |
| Project picker rows | 662, 671 | 16 px tile + name + path | **Name + path only**: row 32 tall, padding 0 10, name 13/18 `--vxs-text`, 8 px gap, short path 12/16 `--vxs-text-3`, check 14 px `--vxs-accent-text` on the chosen row. Group headings ("This Mac", "Cloud computer") keep their host names; add the 14 px host glyph before each heading in `--vxs-icon` so the groups stay distinct |
| Recent projects pills (empty state) | 689 | 16 px tile + name | **Name only**: pill 28 tall, padding 0 12, radius 8, 1 px `--vxs-hairline`, 13/18 `--vxs-text-row`. "+ Open a folder…" and "Clone from GitHub…" keep their 14 px glyphs (they are actions, not logos) |
| Host switcher popover (3+ hosts) | SIG 4.2 E | host glyph per host | Unchanged: host glyphs are icons, not logos. It lists hosts only, no project tiles |
| Sidebar states board | Sidebar.dc.html | tiles in its sample columns (`letter`, `tileBg`, `tileFg` in its script) and two "Upgrade Astro on vectordev.ai" titles (lines 769, 845) | **Refresh it in the same pass as the new boards** (section 8.1): apply every delta in this table and in 3.2, and rename both titles to "Upgrade the site's framework on vectordev.ai". If it cannot be refreshed in that pass, retitle its board "Sidebar states (Signature, before the blend)" and add a note beside it: "Replaced by the blend boards: logos removed, today's account row." Never leave it looking current |

Kept on purpose: host glyphs (`host-mac`, `host-cloud`, …), status glyphs, Live kind glyphs, the Windows app-menu chip mark (Vector's own) and the empty-state gradient chip tile (Vector's one brand moment per screen). None of these sit next to a project name.

The script deltas: in Main's data (lines 1012-1015) drop `letter` and `tile` from projects; remove `tileBg`, `tileFg`, `letter`, `projLetter`, `projBg`, `projFg` from the render values (lines 1078, 1159, 1215, 1229, 1248).

### 3.2 Account row: today's form in the Signature footer

Replace Main's footer (lines 246-254) with today's account row (workspace-navigation.tsx lines 826-990), restyled only where a Signature token takes the place of a `--vx` one.

- **Footer:** height 50 (today's min-height), 1 px `--vxs-hairline` along the top, padding 8 12, gap 4, no fill of its own (the sidebar material continues under it). CSS grid as today's: `1fr auto auto` (chip, Help, Settings); `1fr auto auto auto` while the Update button shows (chip, Help, Update, Settings).
- **Account chip** (left cell): a button 34 tall, padding 4, radius 6, gap 8, transparent; hover `--vxs-row-hover`. It opens the SIG account popover (section 3.3).
  - **Avatar:** a 24 px circle. A photo when the person has one; otherwise fill `--vxs-avatar` `#9274EC` with the initial "Y" at 11/14 weight 500, `#FFFFFF`, uppercase. This replaces Signature's tinted 22 px avatar.
  - **Text**, one line, ellipsis, all 12.5/16 weight 400: "You" in `--vxs-text` `#ECEBEF`, then " · " in `--vxs-text-3` `#95929C`, then "Codium Max" in `--vxs-text-2` `#A9A7B0`. (Today: `#e8e8e8`, `#878787`, `#a8a8a8`.)
  - **Founding badge** (codium branch, founding members only; off in the default artboards, on in the "Founding" tweak): 6 px after the text, 16 tall, padding 0 6, radius 8, 1 px `rgba(146,116,236,0.40)`, "Founding" 10/14 weight 500 `--vxs-accent-text`.
  - **Signed out** variant: no avatar circle fill (24 px outline ring 1 px `--vxs-hairline-strong`), text "Sign in to Vector" 12/16 `rgba(255,255,255,0.60)`.
- **Help** (middle cell): icon button 28 x 28, radius 7, `help` icon 14 px in `--vxs-icon-quiet`; hover icon `--vxs-text`, fill `--vxs-row-hover`. Tooltip "Help". Opens the SIG Help menu (Docs, Best practices, Changelog, Send feedback, Diagnostics, Open debug tools).
- **Update** (optional, only when an update waits): today's "Update" button sits between Help and Settings: 24 tall tint button, gap 5, today's 14 px down-arrow glyph (`M7 11V3M3.5 7.63L7 11L10.5 7.63`, viewBox 0 0 14 14, stroke 1.3) then "Update" ("Updating…" with a 12 px spinner while installing). Tooltip "Restart to update to Vector 1.99.114". The SIG update row (SIG 4.2 G) is left out because today's account row already carries Update; that drop is open decision 9.
- **Settings** (right cell): icon button 28 x 28, `gear` icon 14 px in `--vxs-icon-quiet`. Tooltip "Settings ⌘,". Opens Settings.
- **Collapsed rail** (Main lines 287-288): the account button stays 36 x 32, radius 8, but holds today's 24 px solid avatar (fill `--vxs-avatar`, "Y" 11/14 weight 500 `#FFFFFF`) instead of Signature's 22 px tinted one; tooltip "You · Codium Max". The rail's Settings button below it uses today's 16-unit `gear` path from section 2.4 at 16 px in `--vxs-icon`, not Signature's gear.

### 3.3 Account popover (Signature, one fix)

As SIG 4.2 H, 280 wide, radius 10, menu recipe, opening upward from the chip. One correction against the product: Codium usage is monthly, so the meter line reads **"64% of this month left · renews Dec 1"**, not "this week · resets Fri". The same wording goes in the composer's Codium ring tooltip (section 4.4).

### 3.4 Where today's sidebar items live now

Nothing today's sidebar reaches is lost:

| Today | Blend |
|---|---|
| Agent / Editor tabs, hide sidebar | Chrome row switch and sidebar toggle |
| Home | New session verb (empty state) |
| Search ⌘P | Search verb (⌘K; ⌘P scoped to files) |
| Agents tree (projects, workspaces, "New workspace +") | Host groups, project rows, session rows; host `+` and project hover `+` |
| Repository tools: Agent Dashboard, Coordinated runs, Browser | More menu |
| Connections: Vectorscope | Vectorscope verb |
| Connections: MCP, Plugins | More menu |
| Account row, Help, Settings | Footer (section 3.2) |

---

## 4. The blended chat area

### 4.1 Session header, row 1 (44 tall)

Bar: height 44, fill `--vxs-main`, padding 0 12 0 20, drag region (controls are `no-drag`). No bottom line at rest; a 1 px `--vxs-hairline` fades in over 120 ms once the transcript scrolls (SIG 4.4). The header spans the whole stage, including above a side panel (today's layout).

**Left, identity:**
- `session-branch` icon 14 px in `--vxs-icon` at x 20.
- Title at x 40: 13/18 weight 500 `--vxs-text`, ellipsis, max 45% of the header. Falls back to "Untitled session" or "New session". There is no chevron menu on the title; its Signature items move into the "…" menu (section 4.2), so the session has one menu.
- **Project name** `[data-vector-session-path]` (today's, session-header.tsx line 318): 8 px after the title, 11/14 weight 400 `--vxs-text-3`, ellipsis (shrinks before the title does), e.g. "vector". Plain text, not a control. Hidden below 1100 px, as today.

**Right, controls**, left to right. Gap 4 between items; an extra 4 px (8 total) between the status chip and Tasks to separate the two groups.

1. **Live pill**, only while the sidebar is hidden (SIG 7.1): 24 tall, radius 12, 1 px `--vxs-hairline-strong`, padding 0 8, 11/14 tabular `--vxs-text-2`, e.g. diamond `1` · orbit `3`.
2. **ProjectTrustPrompt** and **PresenceBanner**: unchanged in meaning, only when they apply. Draw as a 22 tall header chip with the 12 px `warning` glyph in `--vxs-needs` and "Trust this repository" (or the presence names as "2 people here") at 11/14.
3. **Branch chip** `[data-vector-session-branch]`: header chip, mono 11/14 `--vxs-text-2`, max-width 160 (180 when it is a picker). As a picker it adds a 12 px chevron-down at 70%. Aria "Branch main. Switch branch"; tooltip "Switch branch". Opens the **branch popover**: menu recipe, 300 wide, opens downward, gutter 6:
   - search field (text field recipe), placeholder "Switch to or create a branch" ("Name a new branch" in create mode);
   - branch rows, 28 tall, mono 12/16, current branch with a 14 px check in `--vxs-accent-text`;
   - separator; "Create branch" with a 14 px plus;
   - when blocked, a 12/16 `--vxs-text-3` note "Wait for the agent to finish before switching branches."
   When the repo has no branch, the chip is a plain span (no chevron), as in today's screenshot.
4. **Status chip** `[data-vector-session-status]`: header chip, 11/14 sans `--vxs-text-2`.
   - Ready: 6 px dot `--vxs-ready`, no glow, "Ready".
   - Agent working: 10 px orbit glyph `--vxs-running` (1.6 s), "Agent working".
   - Testing: 10 px orbit glyph `--vxs-running` turning at today's faster 1.15 s, plus a 3 px solid centre dot in `--vxs-running` inside the ring, "Testing". Today's chip is amber; the blend keeps it violet because amber means "needs you" in Signature's status vocabulary, so the faster turn and the centre dot carry the difference instead of the colour.
   Words stay neutral; only the glyph carries colour (SIG principle 3). Under reduced motion the orbit stops at 12 o'clock, and the centre dot still tells Testing from Agent working.
5. **StatusPopover** (only when Settings › visibility › status is on): 24 x 24 icon button, 14 px status icon, tooltip "Status".
6. **Tasks** `.vector-bg-tasks-launch`: tool button, `task` icon, label "Tasks", then a count badge when tasks run: accent badge while running, needs badge when work waits on you. Tooltip "Background tasks" (or "Background tasks, 1 running" / "…1 waiting on you") with ⌘⇧B. Toggles the Tasks pane (section 4.9). Shown only when background tasks have a root session (today's rule); mockups show it.
7. **Changes**: tool button, `review` icon (`review-active` when open), label "Changes", neutral count badge with the number of changed files (e.g. `6`). Tooltip "Toggle review" ⌘⇧R. Toggles the side panel on the Changes tab (section 5).
8. **Terminal**: tool button, `terminal` icon, label "Terminal". Tooltip "Toggle terminal" ⌃\`. Toggles the bottom terminal panel (section 4.9).

Below a 1100 px window width, as today (vector-premium.css 3847-3850 and on): the project name and the status chip hide, the three tool labels hide and each tool button becomes 24 x 24, icon only (today it became 30 px wide). Count badges stay.

Windows: the header reserves `env(titlebar-area-width)` (about 138 px) on the right for caption buttons. With the sidebar hidden on Mac, the header pads left to 170 and the sidebar toggle, Back and Forward move into it (SIG 4.4).

### 4.2 Session header, row 2 (sticky, 32 tall)

Today's sticky title row, smaller. It is the first child of the transcript scroller, `position: sticky; top: 0`, height 32, padding 0 12 0 20, background `linear-gradient(180deg, #161519 0%, #161519 70%, rgba(22,21,25,0) 100%)`, z-index above transcript blocks. Its right edge lines up with row 1's right edge (Terminal).

**Left:** only for subagent sessions, the breadcrumb: parent title 12/16 weight 500 `--vxs-text-3` (button; hover `--vxs-text`), "/" 11/14 `--vxs-text-3`, child title 12/16 weight 500 `--vxs-text`. The child title renames on click: hover fill `--vxs-row-hover` radius 6, Enter saves, Escape cancels. Root sessions show nothing.

**Right**, gap 4:
1. **Usage pill** `[data-component="session-cost-readout"]`, once the session has spent something: 20 tall, radius 10, 1 px `--vxs-hairline`, fill `rgba(236,235,239,0.03)`, padding 0 8, gap 5, 11/14 weight 500 tabular. First word is the spend label in `--vxs-accent-text` (amber `--vxs-needs` when warning); then "·" in `rgba(236,235,239,0.25)`; then the value in `rgba(236,235,239,0.62)`; hover text 80%.
   - Codium session (mockups): the pill reads **"Codium"** alone, no tokens or price.
   - Own-key session: "$0.04 · 58.7k". Free model: "free · 58.7k".
   - Tooltip (230 wide, menu recipe, 12/16 rows with label `--vxs-text-3` left and value `--vxs-text` right): Session cost, This run, Tokens, "Of which" breakdown (helpers, subagents, up to 8 children), Desktop task spend, notes. On Codium every cost and token cell reads "Codium".
2. **Context ring** (session-context-usage.tsx): icon button 24 x 24 holding a 14 px ring, stroke 1.5, rotated -90°, track `--vxs-hairline-strong`, arc `--vxs-text-3`. Aria "View context usage". Tooltip (120 wide): Cost / Usage % / Tokens (Codium: "Codium" / "38%" / "Codium"). Click toggles the Context tab in the side panel.
3. **More "…"**: icon button 24 x 24, `outline-dots`. Aria "More options". Menu 220 wide, opens downward-right-aligned:
   - Share publicly…
   - Rename
   - Pin (from Signature)
   - Copy link (from Signature)
   - Open in ▸ (from Signature: the existing editor list)
   - Transcript view ▸ Normal / Verbose (from Signature)
   - separator
   - Archive (from Signature)
   - Delete… (label `--vxs-diff-del`)
   Hidden on subagent sessions (today's rule).

### 4.3 Composer box

Placement: the composer dock is centred, width = transcript column (max 720), padding 0 32 16 around box + chips row (SIG 4.6). Docks (section 4.6) stack above the box with 8 px gaps.

**Box** (`.vx-composer`): radius 14, fill `--vxs-raised`, 1 px `--vxs-raised-border`, `box-shadow: --vxs-raised-highlight, --vxs-shadow-composer`. Focus-within border `rgba(182,159,247,0.45)`, no glow. Default layout ("pickers below", the default tweak): one row, min-height 48, padding 10, `align-items: flex-end`, gap 2. This is Signature's outline: a 28 px button on the left inside the box, the editor, then the right-side buttons.

Contents, left to right:
1. **Attach** `[data-action="prompt-attach"]`, in Signature's left slot: icon button 28 x 28, radius 7, today's `paperclip` 14 px in `--vxs-icon`. Title "Add files" ⌘U (today's control and words; it replaces Signature's `+` menu, which is not used). Multiple files: images, PDFs, text. The "Attach on the right" tweak puts it back where today has it, between mic and Send.
2. **Editor** (contenteditable, role textbox): flex 1, 14/22 `--vxs-text`, padding 3 4, min 28, grows to 280 then scrolls. Placeholder in `--vxs-text-3`, one line, truncated:
   - normally **"Ask anything, / for commands, @ for context..."** (today's string);
   - in Deep research "What should Vector research?";
   - in Terminal mode "Run a terminal command... git status" in mono 13/22.
   - @file mentions in `--vxs-accent-text`; @agent mentions in `#A9B7F2`. Pick atoms from the browser (section 6.0) are inline atoms at the caret.
3. **Mic** `[data-action="prompt-mic"]`, only when dictation is available: icon button 28 x 28, `mic` 14 px `--vxs-icon`. Title and aria "Dictate prompt". Listening: icon `--vxs-failed` with `box-shadow: 0 0 0 4px rgba(232,119,125,0.18)` on the button; the mic is replaced by the **dictation pill**: 28 tall, flex 1 1 240 (min 160), radius 14, 1 px `--vxs-hairline`, fill `rgba(255,255,255,0.045)`, padding 0 2 0 10, gap 8: a waveform of 2 px bars (radius 1, `--vxs-text-2`, heights 4-14), a timer 11/14 weight 600 tabular `rgba(255,255,255,0.58)`, and a 24 px round stop button (fill `rgba(255,255,255,0.09)`, 8 px square `--vxs-text`).
4. **Stop menu** `[data-action="prompt-stop-menu"]`, only while stopping with helper agents live: icon button 28 x 28 with a 12 px chevron-down. Aria "Choose what to stop". Menu: "Stop the main turn", "Stop including helpers (2)".
5. **Send / Queue / Stop** `[data-action="prompt-submit"]`: 28 x 28, radius 8, 1 px `--vxs-hairline-strong` border in every state (today's square edge), margin-left 2.
   - Empty input, idle: fill `--vxs-row-pressed`, `arrow-up` 14 px in `--vxs-text-disabled`, disabled. Tooltip "Send ↵".
   - With text: fill `--vxs-accent-strong` `#7C5CE6`, arrow `#FFFFFF`. Hover `filter: brightness(1.1)`; active `transform: translateY(0.5px) scale(0.98)`. Tooltip "Send ↵".
   - Agent working, input empty: **Stop**: fill `--vxs-text`, 10 px square radius 2 in `--vxs-main`. Tooltip "Stop esc".
   - Agent working, input has text: **Queue**: accent fill, arrow-up. Tooltip "Queue ↵" (⌥↵ does the other of steer/queue, per setting).
   - Terminal mode: accent fill with today's `arrow-undo-down` glyph.

**Inside the box, above the editor** (the box switches to a column: these rows, then the editor row). Each row has padding-bottom 8:
- **Context chips** (file comments, context-items.tsx): horizontal scroll, gap 6. Each chip 40 tall, max 200 wide, radius 8, fill `--vxs-row-hover`, 1 px `--vxs-hairline`, padding 4 4 4 8. Line 1: 14 px file icon `--vxs-text-3`, name 12/16 weight 500 `--vxs-text` (14-character truncation), range ":12-20" in `--vxs-text-3`, then a 16 px close button (24 hit area via negative margin; aria "Remove file from context"). Line 2: the comment, 12/16 `--vxs-text-2`, one line. Tooltip: full path.
- **Image attachments**: thumbs 48 x 48, radius 8, 1 px `--vxs-hairline` (hover `--vxs-hairline-strong`), gap 8. Filename overlay 10/12 white on `rgba(0,0,0,0.5)` along the bottom. Remove: 18 px round button at -6/-6, fill `--vxs-menu`, 1 px `--vxs-raised-border`, 10 px x, visible on hover.
- **Remember chips** ("save this to memory"): 22 tall, radius 11, 1 px `--vxs-hairline-strong`, padding 0 4 0 8, 11/14 `--vxs-text-2`, a 12 px plus (or check once saved) and a 16 px dismiss.
- **Research chips** (Deep research only), below the editor instead: 22 tall, radius 11, 1 px `--vxs-hairline`, fill `rgba(255,255,255,0.03)`, 11/14: "Depth" (`--vxs-text-3`) "Auto ⌄"; "Sources" "Web and brain ⌄" (or Web only / Brain and files only); a static cap chip in `--vxs-text-3` with its tooltip.

**Drag overlay** (drag-overlay.tsx): covers the box, fill `rgba(39,38,44,0.94)`, border 1 px dashed `--vxs-focus`, radius 14. Centred: 24 px photo icon (link icon for @mention) in `--vxs-text-2`, 13/18 `--vxs-text` "Drop images, PDFs, or text files here" ("Drop to @mention file").

**Terminal mode**: typing "!" at the start switches the editor to mono, the "how" chips fade to 40% and stop taking clicks, Send shows `arrow-undo-down`. Esc exits. New in the blend (today has no such hint): a 11/14 `--vxs-text-3` hint "esc to exit" sits left of the mic.

**"Pickers inside" tweak** (for the owner to compare): the box becomes two rows, min-height 84: the editor row (padding 12 14 4) and a 36 tall controls row inside the box (padding 0 8 8 8) holding the paperclip, then the "how" chips (section 4.4) including the Codium ring, then on the right mic and send. The compact "where" group stays alone under the box: still one row (section 4.4). (Until 2026-11-11 the ring stayed under the box too.)

**"Attach on the right" tweak**: the paperclip leaves the left slot and sits between mic and Send, as today; the text then starts 14 px from the box edge (10 box padding + 4 editor padding).

### 4.4 Chips row under the box

**One row, always** (owner, 2026-11-11). The owner looked at the two lines under the composer ("This Mac · vectordev.ai ⌄", then the "how" chips) and said: "this is too much, there shouldn't be 2 rows, only one." So the chips row is one row on every board, in every state and tweak, at every composer width:
- Margin-top 8 under the box, height 24, `display: flex; flex-wrap: nowrap; align-items: center; justify-content: space-between; gap: 12px` (12 is the least space between the groups). The "where" group is `flex: 0 1 auto; min-width: 0; white-space: nowrap`; the "how" group is `flex: none; white-space: nowrap`.
- It never wraps. A narrow composer compacts the row (below); it never grows a second line.
- Every chip is the blend chip recipe and every menu opens upward.
- Withdrawn: the earlier rule that wrapped the groups onto two lines (50 tall) below a 640 px composer, which the split boards drew.

**Left group, "where"** (compact; gap 2; no "·" separator: the host glyph separates host from project):
1. **Host**: an icon-only button, 24 x 24 (icon button recipe, radius 6), holding the 14 px host glyph in `--vxs-icon`: laptop for This Mac, cloud for Cloud computer. Tooltip and aria-label "This Mac" (or "Cloud computer"); the words now live in the tooltip and the host menu. Menu: hosts, and in a session "Move to Cloud computer…" (after Codium; this replaces Codium's separate "Run on my cloud computer" button).
2. **Project**: "vector ⌄" (or whichever project the board shows) in `--vxs-text`, directly after the host button, no tile (section 3.1). In a session the menu shows the project's path and "Reveal in Finder"; in the empty state it is the project picker, anchored to the row's left edge.
3. **Branch**, **empty state only, and only when the row still fits with it**: 12 px branch glyph + mono 12 "main ⌄" in `--vxs-text-2`; menu also holds Local checkout / New worktree…. When the row would not fit, the chip is left out and the branch choice (branches, Local checkout, New worktree…) moves into the project chip's menu. In a session the header's branch chip is the one branch control, so it is not repeated here.

**Right group, "how"** (today's composer pickers, same order, smaller; gap 2; no "·" separators, because each chip's leading glyph or trailing chevron already separates it; mockup lists in this file write the "how" chips with commas for that reason):
1. **Agent** `[data-action="prompt-agent"]`, only when Settings shows custom agents: today's 14 px `sliders` glyph in `--vxs-icon`, agent name 12/16 `--vxs-text-3`, max-width 150, chevron. Tooltip "Cycle agent ⌘.".
2. **Model** `[data-action="prompt-model"]`: `generic-provider` 14 px in `--vxs-icon` at 70% opacity (4.36:1 on the stage; 40% would be 2.26, under the 3:1 icon minimum), 100% on hover; provider marks are not drawn in mockups, name 12/16 weight 400 `--vxs-text-2`, max-width 200 with a 16 px mask fade, chevron. Mockup value **"Codium Auto"**. Tooltip "Choose model ⌘'" (adds "· May train on your prompts" for free models that may train). Opens the model picker (menu recipe, 340 wide, max 420 tall, search field on top, 28 px rows, section headings; not opened in the artboards).
3. **Mode** `[data-action="prompt-mode"]`: 6 px dot, label 12/16 weight 500 `--vxs-text-2`, chevron. No tooltip. Values and dots: Manual `--vxs-dot-neutral`; Plan `--vxs-dot-violet`; Full access `--vxs-dot-full`. Menu 248 wide, heading "Mode"; rows padding 6 8, radius 6, gap 8, `align-items: flex-start`: 8 px dot (margin-top 5), label 13/18 weight 500 `--vxs-text`, description 11/14 `--vxs-text-2` under it (menu secondary text, section 2.5), 14 px check `--vxs-accent-text` on the current row. Descriptions (today's strings):
   - Manual: "Ask before editing files or running commands"
   - Plan: "Plan and explain only — no file changes"
   - Full access: "Edit files, run commands, and use the browser without asking"
4. **Effort** `[data-action="prompt-model-variant"]`, only when the model has effort levels: label then the 12 px `chevron-down` in `--vxs-text-3` (blend chip recipe, as on the other pickers; today's trigger has the chevron, prompt-input.tsx 2315-2330), 12/16 weight 400, capitalised, min-width 0, max 160. Colour `--vxs-text-2` for Default / Light / Balanced / Extra; **Max** uses `--vxs-glow-text`. Tooltip: label, description, "Cycle thinking effort ⇧⌘D". Popover 248 wide, menu recipe, padding 10 12:
   - line "Effort" 12/16 weight 500 `--vxs-text` with the value right-aligned 12/16 `--vxs-text-2` (Max in `--vxs-glow-text`);
   - a segmented track 24 tall, radius 7, 5 segments with 4 px gaps: unlit `rgba(255,255,255,0.06)` with `inset 0 0 0 1px rgba(255,255,255,0.045)`; lit `--vxs-accent`; at Max every segment lit with `box-shadow: 0 0 10px rgba(146,116,236,0.45)` (no gradient: the screen's one gradient is elsewhere);
   - "Light" and "Max" under the ends, 10/12 `--vxs-text-3`;
   - a description card: radius 8, 1 px `--vxs-hairline`, fill `rgba(0,0,0,0.25)`, padding 8 10, 11/16 `--vxs-text-2`. Today's strings: Default "Uses the model provider's recommended effort level."; Light "Prioritizes speed and lower cost for small, well-scoped tasks."; Balanced "Balances response speed with careful reasoning for everyday engineering work."; Extra "Spends more effort on multi-file changes, debugging, and complex decisions."; Max "Uses maximum effort for difficult, high-impact engineering tasks."
5. **Speed** `[data-action="prompt-execution-mode"]` (hidden in Terminal mode): 6 px dot, label 12/16 weight 500, chevron. Max-width 116 (148 for Deep research).
   - Normal: dot `--vxs-dot-neutral`, label `--vxs-text-2`.
   - Quick: dot `--vxs-dot-quick`, label `--vxs-quick-text`.
   - Fast: dot `--vxs-dot-violet`, label `--vxs-glow-text`. Hidden for models on self-hosted servers.
   - Deep research: dot `--vxs-dot-research`, label `--vxs-research-text`, then a "Preview" pill: 14 tall, padding 0 5, radius 7, 1 px `rgba(107,166,221,0.45)`, 10/14 weight 500 `--vxs-research-text`. Only when the engine has the research agent.
   - Menu 268 wide, same row style as Mode; heading "Mode" (today's string; see open decision 3). Descriptions (today's): Normal "Standard execution speed and token use."; Quick "Answers simple questions quickly with minimal context and fewer tokens."; Fast "Targets 1.5x speed with priority capacity and wider parallel execution. Uses more tokens."; Deep research "Researches a question across the web and this repository's brain, then writes a report with each claim cited. Makes no code changes."
6. **Local status pill**, only when the Vector Local policy is on: chip with today's 12 px lock glyph, text 12/16 `--vxs-text-2` (max 180), and a 6 px `--vxs-needs` dot when a change waits for you.
7. **Codium ring** (from Signature; plan usage, distinct from the session's usage pill): 14 px ring, 2 px stroke, track `--vxs-hairline-strong`, arc `--vxs-accent` (`--vxs-needs` below 20%, `--vxs-failed` below 5%), then "64%" 11/14 tabular `--vxs-text-3`. Tooltip "Codium · 64% of this month left · renews Dec 1". Opens Settings › Usage. Only for Codium subscribers.

The "how" chips keep the order, values, menus, tooltips and colours above; only the "where" group and the row's layout changed.

**Compaction order** (when the composer is narrower than the full row). Apply the steps in this order, and only as many as the width needs:
1. The Codium ring drops its "64%" text: ring only, in a 24 px hit area. The tooltip keeps the percentage.
2. The model name truncates with its 16 px mask fade, down to a 72 px minimum name width.
3. The chevrons on Mode, Effort and Speed hide until the chip is hovered or focused. Keep 16 px free at the row's end so a chevron can appear without pushing the row. The menus don't change.
4. The Speed chip shows only its 6 px dot while the value is Normal: a 24 x 24 chip, with "Normal" in its tooltip and aria-label ("Speed: Normal"). Quick, Fast and Deep research keep their labels.

Widths come from the real font sizes and paddings above. With the project "vector" the full row needs about 530 px (Changes board: host 24, "vector ⌄", Codium Auto, Manual, Balanced, Normal, ring with "64%"). With "vectordev.ai" it needs about 572 px (Browser A's breakpoints: step 1 at 571 px or less, step 2 at 532, step 4 at 486). Each board measures its row at every composer width it draws and applies only the steps that width needs. Known results:
- 720 (Search, Vectorscope review, Browser D, every composer at the 720 cap): no steps.
- Chat 656 (default): no steps.
- Changes 536: no steps (the row needs 529).
- Browser A 536, with "vectordev.ai": step 1.
- Browser C 496: steps 1-3, plus step 4 when Mode is Full access with Balanced and Normal.
- Below step 4 (Chat 363, with the Tasks pane docked and expanded; Changes 216, in its narrow state): the four steps are not enough. The boards add a fallback that the owner has not approved (open decision 11). Chat adds a fifth step: the model chip shows only its glyph, with the name in its tooltip. Changes and Tasks let the "how" group scroll sideways under a 16 px right-edge fade, with the scrollbar hidden.

**Under the chips** (only when it applies): "May train on your prompts" 11/14 `--vxs-text-3`, margin-top 2, left-aligned.

### 4.5 "/" and "@" popover

Menu recipe, width = composer box width, placed 8 px above the box (above any docks), max-height 320, padding 4, z-index 70.
- "/" rows: 28 tall, padding 0 10, radius 6. "/trigger" 13/18 `--vxs-text`, 8 px gap, description 12/16 `--vxs-text-2` (ellipsis), then right-aligned: a badge (Workflow / Skill / MCP / Custom: 18 tall, padding 0 6, radius 6, 1 px `--vxs-hairline-strong`, 11/14 `--vxs-text-2`) and the keybind 11/14 tabular `--vxs-text-2`. Active row `--vxs-row-selected`.
- "@" rows: agents first (14 px agent glyph `--vxs-icon`, name `--vxs-text`), then files and folders (14 px file icon, name `--vxs-text`, directory 12/16 `--vxs-text-2`).
- Empty: "No results" / "No commands", 12/16 `--vxs-text-3`, 32 tall, centred.

Mockup "/" list (when the editor holds "/"): `/review` "Review the current changes" [Skill]; `/browser` "Open Vector's controlled browser beside the current task"; `/workflow` "Run a saved workflow" [Workflow]; `/vectorscope` "Review uncommitted changes with Vectorscope" [Custom]; `/compact` "Summarise the conversation to free context".

### 4.6 Docks above the composer

Stacked top to bottom (today's order), each 8 px apart, all within the composer width:

1. **Working line**: 12/16 `--vxs-text-3`, padding 0 4 2, a 10 px orbit in `--vxs-running` first. Format "12s · 3.4k tokens · 1 running task · {phrase}"; on Codium "1m 12s · Codium · 1 running task · Double-checking 1 finding".
2. **Question dock** / research plan card.
3. **Permission dock** (session-permission-dock.tsx): outline card radius 12, 1 px `--vxs-hairline-strong`, fill `--vxs-raised`, `--vxs-raised-highlight`, padding 12 14.
   - Header row, gap 8: `warning` 16 px in `--vxs-needs`, "Permission required" 13/18 weight 500 `--vxs-text`.
   - Hint 12/16 `--vxs-text-2`, margin-top 4. Patterns as inline code (mono 12, fill `rgba(255,255,255,0.06)`, radius 4, padding 1 4); terminal statements in a block (radius 8, fill `--vxs-code`, 1 px `--vxs-hairline`, mono 12/18, padding 8 10, margin-top 8).
   - Footer, margin-top 12, right-aligned, gap 8: **Deny** (ghost 28), **Allow always** (secondary 28; only when allowed), **Allow once** (primary pill 28).
   - Browser variant: section 6.0.
4. **Todo dock**: outline card radius 12, 1 px `--vxs-hairline-strong`, transparent. Header 32 tall, padding 0 6 0 12: "2 of 5 todos completed" 12/16 `--vxs-text-2` (digits tabular), 8 px gap, current todo preview 12/16 `--vxs-text-3` (ellipsis), a 24 px chevron button (rotates 180° when open). List max-height 168, padding 0 12 8, rows 24 tall: 12 px glyph (done: check-ring `--vxs-ready`; in progress: orbit; pending: 10 px ring 1.25 stroke `--vxs-text-3`) then 13/18 text (done: `--vxs-text-3` with line-through).
5. **Revert dock** and **Interrupted dock**: outline card radius 12, padding 10 14, 13/18 text + one secondary button.
6. **Follow-up queue**: outline card radius 12, 1 px `--vxs-hairline-strong`. Rows 36 tall, gap 10, padding 0 6 0 12, hairline between: 14 px queue glyph `--vxs-text-3`, text 13/18 `--vxs-text` (ellipsis), "Steer" ghost 24 with a 12 px enter glyph (or "Retry" with reset), a 24 x 24 trash icon button. Paused line: 12/16 `--vxs-text-3` "Queue paused" + "Resume" ghost 24.
7. **Delegation suggestion**: 28 tall pill, radius 14, 1 px `--vxs-hairline-strong`, padding 0 4 0 12, gap 8: "⑂" in `--vxs-accent-text`, text 12/16 `--vxs-text-2` "Looks like 3 independent tasks — delegate to parallel agents?", "Delegate" accent pill 20 tall (radius 10, padding 0 10, 11/14 weight 600), "Dismiss" ghost 20 (11/14 `--vxs-text-3`).
8. **Model recommendation**: same pill, "✦" in `--vxs-accent-text`, today's text "Suggested for this {task category}: {model} · {effort} effort — {evidence} · {n}/{N} priced" (prompt-input.tsx 2100-2102), buttons "Use" (accent pill 20) / "Dismiss". The "· n/N priced" fragment shows for own-key users and is hidden on Codium, where prices never show.
9. **Codium cloud computer bar** (codium branch, one per live cloud session): card radius 12, 1 px `rgba(146,116,236,0.50)` (dashed while you have control; `rgba(226,171,87,0.55)` when Vector needs you), fill `rgba(146,116,236,0.07)`, padding 8 12, wrapping row. Title 13/18 weight 500 "Vector is using its cloud computer" (or "You have control of the cloud computer"); meta 12/16 `--vxs-text-2` "{title} · Working"; alert 12/16 `--vxs-text` with a 12 px diamond `--vxs-needs`. Buttons 24 tall: Watch (ghost), Take over (primary pill 24), Open control (ghost), Give back (primary pill 24), Files (ghost), Stop (ghost; "Stop now" danger on second press). Link under the stack: "Done by Morning: jobs and reports" 12/16 `--vxs-accent-text`, underlined.
10. Then the box, or the child-session notice (outline card radius 12, 13/18 "This is a subagent of {parent}" + "Talk to this subagent" ghost + "Back to parent" ghost).

First-run model card (`.vector-model-start`, no model connected): outline card radius 12 above the box, 16 px icon, title 13/18 weight 500 "Connect a model to start", subline 12/16 `--vxs-text-2`, primary pill "Connect".

### 4.7 Transcript pieces

Column: centred, max-width 720 (Signature, from today's 980), side padding at least 32, padding-top 8 (row 2 sits above), blocks 16 apart, consecutive tool rows 4 apart. Long transcripts use `content-visibility: auto; contain-intrinsic-size: auto 120px`. Scroll edge: 24 px top mask under row 2.

**User message**: right-aligned block, max-width 80%, radius 12, fill `--vxs-row-hover`, padding 10 14, 14/22 `--vxs-text`, pre-wrap; @file mentions `--vxs-accent-text`. Attachments above it, right-aligned, gap 6: image tiles 40 x 40 radius 8, file tiles 200 x 40 radius 8 (1 px `--vxs-hairline`, 14 px file icon, name 12/16 `--vxs-text`, size 11/14 `--vxs-text-3`). On hover a 24 tall row appears under the block, right-aligned: time "11:42" 11/14 `--vxs-text-3` + copy icon button 24.

**Assistant text**: no bubble, 14/22 `--vxs-text`. Headings 16/24 weight 600. Inline code: mono 12.5, fill `rgba(255,255,255,0.06)`, radius 4, padding 1 4, `#D6D3DB`. Code blocks: radius 10, fill `--vxs-code`, 1 px `--vxs-hairline`, padding 10 12, mono 12/18, syntax colours from section 5.9; a 24 px copy button top-right on hover. Links `--vxs-accent-text`, underline on hover. Hover reveals a copy row on the left (24 px icon button). Reasoning ("Thinking", "Thinking - topic"): a tool row with a 12 px chevron; expanded body 13/20 `--vxs-text-3`.

**Tool row** (basic-tool, today's titles in Signature finish): a button, min-height 28, padding 4 8, margin 0 -8, radius 7, gap 8, 13/20; hover `--vxs-row-hover`.
- 16 px icon in `--vxs-text-3` (magnifier for Explored/Search, file for Read, terminal for Shell, globe for Browser, plug for MCP calls). While running the icon slot holds a 12 px orbit in `--vxs-running` (no shimmer).
- Title (today's tool title: "Shell", "Read", "Explored", "Called `browser`") 13/20 weight 500 `--vxs-text-2`.
- Detail 13/20 weight 400 `--vxs-text-3`; commands and paths in mono 12/20.
- Spacer, result 12/20 `--vxs-text-3` (e.g. "passed · 41s", "6 results"), a 12 px chevron (rotates 90° open).
- Expanded: margin 4 0 4 24, padding 8 12, radius 8, 1 px `--vxs-hairline`, fill `--vxs-code`, mono 12/18 `--vxs-text-2`. Shell output starts with "$ cmd" in `--vxs-text`; a 24 px copy button top-right.
- Context group ("Explored" + "1 search, 2 reads"): same row; expanded children are tool rows indented 24 with gap 4.

**Tool error row** (tool-error-card): same row metrics, padding-left 12, plus a 2 px bar at left 0, top 6, bottom 6, radius 1, `--vxs-failed`. Icon `circle-ban` 16 px `--vxs-failed`. Title = tool name, 13/20 weight 500 `--vxs-text`; message 13/20 `--vxs-text-2`. Expanded: error text with padding-left 24 and a copy button.

**Edited files card**: outline card radius 10, overflow hidden.
- Header 36 tall, padding 0 6 0 12, gap 8: "Edited 2 files" 12/16 weight 500 `--vxs-text-2`, diff total 11/14 tabular (`--vxs-diff-add` / `--vxs-diff-del`), spacer, **Rewind** (ghost 24 with today's 12 px undo glyph), **Review** (tint button 24).
- Rows 32 tall, 1 px `--vxs-hairline` above each, padding 0 6 0 12, gap 10: 14 px file icon `--vxs-text-3`; path mono 12/16 (directory `--vxs-text-3`, file name `--vxs-text-2`); spacer; `+84 −12` 12/16 tabular in diff colours; "Open diff ›" ghost 24 (12/16 `--vxs-text-3`). Clicking opens the Changes panel at that file.
- A single edit outside a group is one such row as its own outline card (36 tall, Signature file-edit card).

**Todos tool part (plan)**: outline card radius 10, padding 10 12. Header 20 tall: "Todos" 12/16 weight 600 `--vxs-text-2`, "3 of 4" 11/14 tabular `--vxs-text-3`, chevron. Items 22 tall with the todo dock glyphs (section 4.6) and 13/18 text.

**Subagent / background task card** (subagent-task-chip and task tool): outline card radius 10, 1 px `--vxs-hairline`, transparent, padding 10 12, max 100%.
- Line 1 (20 tall): 12 px status glyph (orbit running, check-ring done, x-ring failed, square-stop stopped, diamond waiting), title 13/18 weight 500 `--vxs-text` (2 lines max), spacer, elapsed 11/14 tabular `--vxs-text-3`, 12 px chevron.
- Line 2: meta 12/16 `--vxs-text-2`, e.g. "Subagent specialists · Phase 2 · 3 agents"; "Needs you" in `--vxs-text` underlined when waiting.
- Line 3 (margin-top 8): today's task squares, 8 px, gap 3: subagents rounded 2 px squares, specialists circles. Running `--vxs-running` (breathing opacity 1 → 0.55 over 1.6 s); waiting `--vxs-needs`; done `rgba(236,235,239,0.30)`; failed `--vxs-failed`; stopped 1 px outline `--vxs-text-3` with a 4 px dash; pending 1 px outline `--vxs-text-3`.
- Role glyphs replace today's coloured subagent avatar tiles: a 14 px glyph in `--vxs-icon` before each agent name in expanded detail (Explore magnifier, Judge balance, Debug bug, Migration arrow crossing a line, Performance rising trace, Review document with check, Security shield, Test flask). Agent names are `--vxs-text` (no per-agent text colour).
- "Move to background": 12/16 `--vxs-text-3` underlined, to the right of the card's first line (outside the card on wide columns, under it on narrow).
- Click shows the phase in Tasks; ⌘-click opens the agent. Hover shows a 16 px open icon top-right.
- Child-session card (Signature): 36 tall outline card, status glyph, title 13/18, status word 12/16 `--vxs-text-3` (e.g. "1 finding"), "›".

**Vectorscope finding card**: outline card radius 10, 1 px `--vxs-hairline-strong`, transparent, padding 12 14. Uses the product's real words (the Signature card's "Medium", "Ask Vector to fix" and "Open in diff" are replaced).
- Header row 20 tall, gap 6: `vectorscope` glyph 14 px `--vxs-text-2`, "Vectorscope" 12/16 weight 600 `--vxs-text-2`, "·" `--vxs-text-3`, an 8 px severity dot (Blocking `--vxs-failed`, Concern `--vxs-needs`, Nit `--vxs-text-3`) and the word 12/16 `--vxs-text` ("Blocking" / "Concern" / "Nit"), spacer, the category 11/14 `--vxs-text-3` (e.g. "correctness"), and when verified a chip "Double-checked" (18 tall, radius 9, 1 px `--vxs-hairline`, 11/14 `--vxs-text-2`, 10 px check in `--vxs-ready`).
- Title 13/18 weight 500 `--vxs-text`, margin-top 8; backticks render as inline code.
- Location: mono 12/16 `--vxs-text-2` "path:line" (hover underline, opens Changes at that line), plus a place note 11/14 `--vxs-text-3` ("outside the changed lines", "elsewhere in these changes").
- Body 13/20 `--vxs-text-2`, margin-top 6.
- Suggested change (when there is one): margin-top 10, radius 8, 1 px `--vxs-hairline`, fill `--vxs-code`, overflow hidden. Header 24 tall, padding 0 10, 11/14 `--vxs-text-3` "Suggested change". Lines mono 12/18, padding 0 10: "−" lines fill `--vxs-del-bg` text `--vxs-del-text`; "+" lines fill `--vxs-add-bg` text `--vxs-add-text`.
- Apply error (when it failed): 12/16 `--vxs-text` with a 12 px diamond `--vxs-needs`: "Those lines changed since the review, so the fix was not applied."
- Actions row, margin-top 12, gap 8: **Apply fix** (primary pill 28 with today's 14 px wand glyph; "Applying…", then "Fix applied" with a check; tooltip "Replaces the reviewed lines in your checkout with the suggested change. Nothing is committed."; only when the checkout is the reviewed version), **Ask the agent** (secondary 28 with 14 px comment glyph; tooltip "Sends this finding to the agent in the task you have open, to check it and fix it in your checkout."), **Fix in a new workspace** (secondary 28 with 14 px plus; tooltip "Opens an isolated agent workspace with this finding as its task. You start it."), spacer, **Dismiss** (ghost 28).
- Dismiss menu (menu recipe, 240 wide): caption 11/14 `--vxs-text-3` "Dismiss with a reason. It is left out of what you post." (local review: "Dismiss with a reason."); rows "Not a bug", "Intended behaviour", "Fixed elsewhere", "Won't fix in this pull request" (local: "Won't fix now"); separator; a 14 px rule glyph + "Don't flag this again" with the hint 11/14 `--vxs-text-3` "Saves a repository rule in .vector/RULES.md that every review reads".
- Dismissed card: border 1 px dashed `--vxs-hairline-strong`, severity dot at 50%, title struck through in `--vxs-text-3`, then the reason 12/16 `--vxs-text-3` and "Undo" ghost 24.

**Research report card**: outline card radius 10, padding 12 14. Top row: "Research report" 11/14 weight 500 `--vxs-text-3`, "Preview" pill (as the speed chip's), "Kept in brain" tag (18 tall, radius 9, 1 px `--vxs-hairline`, 11/14 `--vxs-text-3`). Body markdown 13/20; citation chips (18 tall, radius 6, 1 px `--vxs-hairline`, fill `rgba(255,255,255,0.04)`, 11/14). Confidence pill: 18 tall, radius 9, 1 px border of its colour at 50%, text `--vxs-text` with a 6 px dot (High `--vxs-ready`, Medium `#6BA6DD`, Low `--vxs-needs`). Notice 12/16 `--vxs-text-2` in a radius 8 box `rgba(255,255,255,0.03)`. Action row (top hairline, padding-top 10, gap 6, wraps), all 24 tall: "Keep in brain" (accent pill), "Export Markdown", "Export JSON", "Export Word", "Export PDF", "Save to repository", "Keep this format", "Sources" (secondary 24), "Forget this research" (danger 24).

**Notices and dividers**: centred 12/16 `--vxs-text-3` with 1 px `--vxs-hairline` rules either side (gap 12). Compaction uses the same.

**Diagnostics block**: radius 8, 1 px `rgba(238,131,136,0.30)`, fill `rgba(238,131,136,0.06)`, mono 12/18 `--vxs-text-2`, labels 11/14 weight 600 `--vxs-text-3` (sentence case).

### 4.8 Empty state (route "/" and New session)

SIG 4.7 unchanged except:
- Header (**new in the blend**): "New session" 13/18 `--vxs-text-2` at x 20. Right side: the Terminal tool button only, plus the Live pill when the sidebar is hidden. Today's new-session header also shows the branch chip (falling back to "main"), the "Ready" status chip and Changes; the blend drops them here because the composer's "where" chips already carry the branch, nothing is running yet and Changes has no session to show. They return as soon as the session starts.
- Backdrop dot field, gradient chip tile, headline "Give Vector one concrete outcome." (Geist 24/30, 600, −0.015em) as Signature.
- Composer at empty-state size: radius 16, min-height 112, max 320. Editor 15/22, padding 16 16 8, placeholder **"Ask anything, / for commands, @ for context..."** (today's string; the same in a session). Bottom row inside the box 44 tall, padding 0 10 10: left the paperclip (Signature's slot, section 4.3); right mic and send (section 4.3 recipes). The "how" pickers stay under the box, as in a session.
- Chips row (one row, section 4.4): where = laptop glyph (tooltip "This Mac") + vector ⌄ + main ⌄ (the branch chip only while the row fits; otherwise the branch sits in the project menu); how = Codium Auto ⌄, ● Manual ⌄, Balanced ⌄, ● Normal ⌄, ring 64%.
- Recent projects without tiles (section 3.1): vector · vector-codium · vector-hands · vectordev.ai · + Open a folder… · Clone from GitHub…
- Live strip top edge solid `--vxs-accent` at 40% (the gradient tile is on screen).

### 4.9 In-session panels: Tasks pane and Terminal

**Tasks pane** (background-tasks; today's structure, smaller):
- Docked: last column of the stage row below the header, 320 wide (expanded `clamp(320px, 46vw, 720px)`), full height, fill `--vxs-main`, 1 px `--vxs-edge` on the left. Floating: radius 12, 1 px `--vxs-raised-border`, fill `--vxs-main` (opaque; no blur), `--vxs-menu-shadow`, hung 8 px under the header, right 12, height `clamp(220px, 100vh - top - 190px, 640px)`, pops in with `vx-in`.
- Header 40 tall, padding 0 8 0 16: "Background tasks" 13/18 weight 500 `--vxs-text`; three icon buttons 24 x 24: Pop out / Dock, Expand / Collapse, Close. Pressed: fill `--vxs-active-fill`, icon `--vxs-accent-text`.
- Under it, padding 0 16 8, 12/16 `--vxs-text-3`: limits line "2 of 8 running · 1 waiting · 3 of 12 started this request" and "Subagent spend · Codium" (own keys: "$0.42").
- List padding 0 8 12, sections 12 apart. Section heads 28 tall, padding 0 8: 12/16 weight 600 `--vxs-text-3` ("Running", "Background commands", "Finished 4 ›", "Interrupted when Vector restarted"), with a 24 px Stop-all or trash icon button on the right where today has one; "Resume all (2)" ghost 24.
- Cards: fill `--vxs-card`, radius 10, padding 12, 6 apart, no border. Head: title 13/18 weight 500 (2 lines), live card adds a 24 x 24 Stop button (fill `--vxs-card-2`, 8 px square `--vxs-text`); finished card adds a status word 11/14 `--vxs-text-2` with its glyph. Meta 12/16: kind `--vxs-text-2`, "Needs you" `--vxs-text` underlined, elapsed `--vxs-text-3` tabular. Counts 12/16 ("3 agents · Codium"). Description 12/16 `--vxs-text-3`, 4 lines. "Phases" 12/16 weight 500 `--vxs-text`, margin 12 0 6.
- Phase block: radius 8, fill `--vxs-card-2`, padding 8 10 10; running phase fill `rgba(165,140,242,0.08)` and its name `--vxs-accent-text`. Row: name 12/16, "2/5" 11/14 `--vxs-text-3`, chevron 12; then the 8 px squares (section 4.7).
- Agent table 11/14: columns Agent | Model 48 | Tokens 48 | Time 52 (Codium: Tokens cells read "Codium"). Detail links 12/16 `--vxs-text-2` underlined, 28 px hit: "Details", "Talk to this subagent", "Ask Vector about this", "Stop". Worktree row: "Worktree · 3 files changed" with Review / Merge / Discard ghost 24 ("Confirm merge" / "Confirm discard" as danger 24).
- Empty: "No background tasks" 13/18 `--vxs-text`, then "Subagents and subagent specialists show up here while they work." 12/16 `--vxs-text-3`, max 240, centred.
- Hands (hands branch): a pinned card above "Running": fill `--vxs-card`, 1 px `rgba(146,116,236,0.40)`, radius 10; "Vector Hands" 13/18 weight 500 + status word right 12/16 `--vxs-text-2` with its glyph; step line 12/16; app chips (20 tall, radius 6, fill `--vxs-card-2`, 12 px app glyph, 11/14); meta "4m 12s · 12 actions"; a 160 x 100 thumbnail radius 6; buttons 24 tall: Watch (ghost), Take over (secondary), Stop (accent pill).

**Terminal panel**: bottom of the stage under the conversation column (today's position), fill `--vxs-terminal`, 1 px `--vxs-edge` on top, a 6 px drag handle centred on that line (hover line `rgba(182,159,247,0.60)`); default height 240, min 100 (dragging below 50 closes). Tab strip 32 tall, padding 0 6, gap 2, 1 px `--vxs-hairline` below: tabs 24 tall, padding 0 4 0 8, radius 6, 12/16 weight 500, inactive `--vxs-text-2`, active fill `--vxs-row-selected` text `--vxs-text`; an agent-opened tab starts with the 12 px `task` glyph ("Opened by an agent"); suffix "exited 0" 11/14 `--vxs-text-3`; close 16 px on hover; trailing "+" 24 x 24 (tooltip "New terminal ⌃⌥T"). Body: mono 12/18, padding 8 12, text `--vxs-text`, selection `rgba(236,235,239,0.25)`.

### 4.10 Size mapping (today → blend)

| Control | Today | Blend |
|---|---|---|
| Header bar | 50 | 44 |
| Branch chip, status chip | 26, radius 5, mono 11.5 | 22 (24 hit), radius 6, mono 11 |
| Tasks / Changes / Terminal | 28, radius 5, 16 px icon, 12 px label | 24, radius 6, 14 px icon, 12/16 label |
| Count badges | 16 min, mono 10 | 14 min, mono 10 |
| Row 2 | 48 | 32 |
| Usage pill | 24 | 20 |
| Context ring, "…" | 28 x 28, 14 px ring | 24 x 24, 14 px ring |
| Composer box | 88 min, radius 16, controls inside | 48 min (one row), radius 14; pickers under it (tweak: inside, 84 min) |
| Model / Mode / Effort / Speed pickers | 28, radius 5, 13 px, 16 px chevron | 24, radius 6, 12/16, 12 px chevron |
| Server glyph | 16 | 14 |
| Mode / speed dots | 6 | 6 |
| Mic, Attach | 36 x 36, 16 px icon | 28 x 28, 14 px icon |
| Send | 38 x 38, radius 8, 16 px arrow | 28 x 28, radius 8, 14 px arrow |
| Context chips | 48 tall | 40 tall |
| Image thumbs | 64 | 48 |
| Dictation pill | 40 | 28 |
| Permission buttons | 32-36 | 28 |
| Follow-up rows | 54 | 36 |
| Tool rows | 14 px, min 24 | 13/20, min 28 (with hover pill) |
| User bubble | radius 5, padding 9 12 | radius 12, padding 10 14 |
| Account row | 50, 24 avatar, 32 px icon buttons | 50, 24 avatar, 28 px icon buttons |

### 4.11 Control checklist (every current control, where it lives)

| Today's control | Lives in | Same icon | Same words |
|---|---|---|---|
| Session title and project name | Header row 1 left | `session-branch` | same |
| Branch chip / BranchPicker | Header row 1 | branch label + chevron | "Switch branch", "Create branch" |
| Status chip (Ready / Agent working / Testing) | Header row 1 | dot / orbit | same |
| StatusPopover | Header row 1 | status icon | "Status" |
| Tasks + badge | Header row 1 | `task` | "Tasks", "Background tasks" |
| Changes + count | Header row 1 | `review` | "Changes", "Toggle review" |
| Terminal | Header row 1 | `terminal` | "Terminal", "Toggle terminal" |
| Trust prompt, presence | Header row 1 | warning | same |
| Subagent breadcrumb | Header row 2 left | — | same |
| Usage pill | Header row 2 | — | spend label · value |
| Context ring | Header row 2 | ring | "View context usage" |
| "…" menu (Share publicly…, Rename, Delete…) | Header row 2 | `outline-dots` | same, plus Signature items |
| Agent picker | Chips row, how | `sliders` | "Cycle agent" |
| Model picker | Chips row, how | `generic-provider` | "Choose model" |
| Mode picker (Manual / Plan / Full access) | Chips row, how | dot | same strings |
| Effort picker + popover | Chips row, how | chevron | Default / Light / Balanced / Extra / Max |
| Speed picker (Normal / Quick / Fast / Deep research) | Chips row, how | dot | same strings |
| Local status pill | Chips row, how | lock | same |
| Add project (new session toolbar slot) | Project chip "Choose a project ⌄" | — | — |
| Mic + dictation pill | Composer box | `mic` | "Dictate prompt" |
| Attach | Composer box, left slot (tweak: right) | `paperclip` | "Add files" |
| Update (account row) | Sidebar footer | down arrow | "Update", "Restart to update to Vector …" |
| Stop menu | Composer box | chevron | "Choose what to stop" |
| Send / Queue / Stop | Composer box | arrow-up / stop / arrow-undo-down | "Send", "Queue", "Stop" |
| Context chips, images, remember chips, research chips | Inside the box | file / photo | same |
| Drag overlay | Over the box | photo / link | same |
| "/" and "@" popover | Above the box | — | same |
| Docks (working line, question, permission, todo, revert, interrupted, queue) | Above the box | today's | same |
| Delegation and model suggestion chips | Above the box | ⑂ / ✦ | same |
| "May train on your prompts" | Under the chips | — | same |

---

## 5. Changes screen: today's design, kept

Nothing inside the panel changes: layout, controls, words, sizes, colours and diff skin are today's ReviewPanelV2 → SessionReviewV2 (packages/session-ui/src/v2/components/session-review-v2.css, session-review-list-v2.tsx, session-review-file-preview-v2.tsx; diff skin packages/session-ui/src/pierre/index.ts lines 226-461; frame vector-premium.css 3623-3836). The values below are copied from today's code so the artboard can be drawn without opening it. Do **not** carry over Main's redrawn panel (Main lines 702-830: Changes / Files / Vectorscope pill tabs, file-icon rows, two number columns, hunk band).

### 5.1 What the shell changes around it

- The panel sits under the blended 44 px session header (today 50) and to the right of the chat column. The header spans the full stage width (today's layout).
- The header's Changes button shows the active state (tint fill, `review-active`, count badge `6`).
- Split: chat column width `min(session.width, max(280px, 100% − 240px))`, default **600** (resizable from 280); a resize handle on the chat column's right edge (6 px hit area; hover line `rgba(182,159,247,0.60)`); the panel is `flex: 1` (minimum 240). Open and close animate width over 240 ms `cubic-bezier(0.22,1,0.36,1)`. The panel is hidden on a new session and below 768 px.
- Gradient rule: the panel keeps its 2 px gradient top line. While it is open, the sidebar Live strip's top edge switches to solid `--vxs-accent` at 40%, so the screen still has one gradient (SIG gradient rule).
- The SIG side-panel tab style (12/16 pills) is **not** used here; today's tab strip stays.
- Shell tokens never reach inside the panel; the panel keeps its own tokens (5.3).
- The optional file-tree column (`#file-tree-panel`, session-side-panel.tsx, with its "6 Changes / All files" tabs, 200 wide by default) is kept unchanged and stays off by default, as today (opened with "Toggle file tree" from the Search palette). It is not drawn on the Changes board.

### 5.2 Frame and tab strip

- `aside#review-panel [data-vector-review-panel]`: fill `#17151c`, `border-left: 1px solid rgba(226,213,237,0.09)`, radius 0, no shadow.
- `::before`: a 2 px strip along the top, `linear-gradient(90deg, rgba(182,159,247,.28), #9274ec, rgba(205,190,252,.24))`, z-index 30.
- **Tab strip**: 43 tall, padding-left 12, gap 8. The tabs block is `#16151c`; `::after` fills the rest of the strip with `#221e29`, so the close button sits right after the tabs, not at the far right. Bottom rule `inset 0 -1px 0 rgba(226,213,237,.07)`.
- Order: [Context?] [Browser?] [Sources?] **[Changes]** [file tabs…] **[panel close]**. With Browser active, Changes and file tabs hide.
- **Tab chip**: 24 tall, radius 7, padding 0 3 0 5 (0 5 0 5 without a close), gap 7, 14px weight 400 in -apple-system / SF Pro Text / Inter. Text `#a8a6ad` at rest, `#ebe7ee` selected or hovered. Hover fill `rgba(255,255,255,.04)`; selected fill `#231f2a` with a 1.5 px `#e2dfe7` underline flush with the strip's bottom edge (`bottom: -9.5px`).
- **Changes chip**: `review` icon 14 px `#b3a1f2`; "Changes"; count badge (fill `rgba(182,159,247,.14)`, `#b69ff7`, 600 10px/1 mono, padding 2 3, radius 4, min-width 13, margin-left 2); close-small 16 x 16, radius 6, `#878590`, 14 px icon (hover fill `rgba(255,255,255,.07)`, white).
- **Panel close**: `close` icon 16 px in a 28 x 28 button, radius 6, `#a8a6ad`, on `#16151c` with padding 0 8 0 5. Tooltip "Close panel" with an Esc key cap.

### 5.3 Panel tokens (today's, verbatim)

panel `#17151c`; diff `#121117`; raised `#1b1922`; text `#ebe7ee`; text-1 `#e8e8ea`; text-2 `#a8a6ad`; text-3 `#878590`; code `#d6d3db`; violet `#b69ff7`; violet-icon `#b3a1f2`; hunk `#8a84c9`; purple `#9274ec`; focus `#9d84ee`; green `#65c78e`; red `#e6787d`; add-text `#a8e2bf`; del-text `#f0b0b3`; line `rgba(226,213,237,.07)`; border `rgba(255,255,255,.06)`; hover `rgba(255,255,255,.04)`; opened `rgba(182,159,247,.08)`. Root font 13px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter; mono ui-monospace, "SF Mono", Menlo. Focus ring 2 px `#9d84ee`, offset 2.

### 5.4 List view (`data-view="list"`)

Scroller padding 12 10 0, thin scrollbar `rgba(255,255,255,.12)`.

**Summary row**: padding 0 8 10, gap 10. Label 13px/16px `#a8a6ad`, flex 1: "6 files changed" (git), "6 files changed on this branch" (branch), "6 files changed last turn" (turn). Then "+318" green and "−32" red (U+2212), 12px mono tabular. When more than one mode exists the label is an inline select: plain text + a 14 px chevron-down `#878590`; hover makes it a 24 px pill, radius 5, text `#ebe7ee`; menu items "Git changes", "Branch changes", "Last turn changes". With 0 files and switchable modes it reads "0 files changed ⌄" with no counts.

**Filter** (only above 8 files, after "/", or while it has text): full width, 28 tall, radius 6, background a faint white gradient over `#1d1d1f`, shadow `0 1px 2px rgba(0,0,0,.45), 0 0 0 .5px rgba(255,255,255,.14)`; 14 px magnifier `#928aa1` on the left; placeholder "Filter files" 13px weight 440; focus outline 1 px `#9b6cff`; clear × while it has text; padding-bottom 8.

**File rows** (`ul`, grid gap 2): button, min-height 38, padding 6 10 6 6, radius 6, gap 8.
- chevron-right 14 px `#878590` (violet on the last-read file), rotates 90° when expanded (160 ms);
- filename 13px/15px `#e8e8ea` over its directory 11.5px/13px `#878590`, both ellipsis;
- optional comment badge: 16 tall, radius 4, fill `rgba(182,159,247,.12)`, violet, comment icon 11 px + number 600 10px;
- "+A" green, "−D" red, 12px mono.
- Hover, expanded or keyboard-highlighted: `rgba(255,255,255,.04)`. Last opened (`data-opened`): `rgba(182,159,247,.08)`, name `#ebe7ee`.
- Image, audio and binary rows open the reader directly.

**Expanded snippet** (a button under the row): width `calc(100% − 28px)`, margin 2 0 8 28, padding 8 0, 1 px `rgba(255,255,255,.06)`, radius 6, fill `#121117`, 11px/17px mono `#a8a6ad`. Rows padding 0 10, pre, ellipsis, tab size 2. First row the hunk header in `#8a84c9`; then up to 6 rows (up to 2 leading context lines, then the change block) with literal " ", "+", "-" prefixes. Added rows fill `rgba(101,199,142,.10)` text `#a8e2bf`; deleted rows fill `rgba(230,120,125,.10)` text `#f0b0b3`. Last line 11px sans: "⋯ 3 more hunks" (or "⋯ N more lines") in `#878590` on the left, "Open diff →" violet on the right, hidden until hover. Hover: border `rgba(182,159,247,.28)` and the bottom line turns violet.

**Footer** (sticky; only with diffs): margin-top auto, padding 10 8 12, border-top 1 px `rgba(226,213,237,.07)`, fill `#17151c`, 12px `#878590`. Left note: git "Working tree vs HEAD, untracked files included"; branch "Compared with the merge base on main"; turn "Files the last turn edited". Right, git mode with changes only: **"Commit to main"**: 28 tall, padding 0 10, 1 px `rgba(182,159,247,.28)`, radius 6, fill `rgba(182,159,247,.11)`, `#b69ff7`, 500 12px; hover fill .16; pending "Committing…".

**Commit dialog** (CommitToMainDialog), titled "Commit to main": multiline field "Commit message" prefilled "Update 6 files"; note "Stages every change and commits it to the current branch. This is reversible with `git reset --soft HEAD~1`."; buttons Cancel (ghost) and Commit to main ("Checking…" while the message is checked; a warning title and bullet lines above the note when the check finds something). Toasts: "Committed to main" / "Nothing to commit" / "Commit failed". Draw it in **today's Vector dialog look**, not the blend recipe in 7.5, because the owner asked for Changes to stay as it is (vector-premium.css 1805-1960): overlay `rgba(9,7,13,0.6)` with `blur(6px) saturate(120%)`; panel min-width 384, 1 px `rgba(226,213,237,0.16)`, radius 14, fill `radial-gradient(120% 96px at 50% 0%, rgba(182,159,247,0.14), transparent 72%), #211e26`, shadow `inset 0 1px 0 rgba(255,255,255,0.04), 0 24px 70px rgba(0,0,0,0.42)`; a 1 px gradient line along the top from 14% to 86% (`linear-gradient(135deg, #7659d0, #8b6ce3 38%, #a287ef 70%, #c0acf9)`, masked at both ends); title 16/22 weight 600 `#ebe7ee`, −0.01em; body 13px in today's weak text token (`text-text-weak`); field 1 px `rgba(226,213,237,0.16)`, focus border `#9274ec` with a 3 px `rgba(182,159,247,0.14)` ring; primary button in the same gradient, white label, `inset 0 1px 0 rgba(255,255,255,0.24), 0 0 0 1px rgba(118,89,208,0.55), 0 6px 18px -8px rgba(118,89,208,0.9)`. While it is open the scrim dims everything behind it; the gradient rule's exemption for today's Changes surfaces is in section 9, check 7.

### 5.5 Empty and loading states

Wrapper padding 48 16 0, centred, 13px `#a8a6ad` (the state sits about 60 px below the panel top). The summary row stays above when modes are switchable.
- Loading: "Loading changes...".
- No changes: column, gap 16: v2 `review` icon 20 px `#928aa1`; "No file changes yet" 13px weight 530 line-height 1 `#e8e8e8`, margin-top 4; "Repository changes will appear here" 13px/20px weight 440 `#a8a8a8`, max-width 282.
- No Git: mono `.gitignore` file icon 20 px `#928aa1`; "No tracked changes"; "Track, review, and undo changes in this folder" (max-width 360); neutral button "Create Git repository" ("Creating Git repository..." while pending).
- Filter with no match: "No files match the filter".

### 5.6 Reader view (`data-view="file"`)

**Header**: 48 tall, padding 0 8 0 6, gap 8, border-bottom 1 px `rgba(226,213,237,.07)`, fill `#17151c`. Once scrolled: `box-shadow: 0 10px 18px -14px rgba(0,0,0,.9)`; a 1 px reading-progress line along its bottom (gradient `rgba(182,159,247,.2)` → `rgba(146,116,236,.85)`) scales with scroll. Header buttons 28 x 28, radius 6, `#a8a6ad`, 16 px icons; hover fill `rgba(255,255,255,.07)`, white; disabled .35. Left to right:
1. Back (arrow-left). Tooltip "Back to Changes" + Esc key cap.
2. Title block (flex 1): filename 500 13px/15px `#ebe7ee`; optional status pill "New file" (fill `rgba(101,199,142,.12)`, `#a8e2bf`) or "Deleted file" (fill `rgba(230,120,125,.12)`, `#f0b0b3`), 500 10.5px/13px, padding 1 5, radius 4; directory under it 11.5px/15px `#878590`.
3. "+A" (hidden for deleted files), 4. "−D" (hidden for added files), 12px mono.
5. Divider 1 x 16 `rgba(255,255,255,.06)`.
6. Pager: 24 x 28 chevron up (tooltip "Previous file", key `<`), position "1/6" 11px mono `#878590` min-width 30 centred, 24 x 28 chevron down (tooltip "Next file", key `>`).
7. Open in editor (open-file icon).
8. More actions (dot-grid icon) → menu: fill `#202023`, radius 6, padding 2, shadow `0 28px 90px rgba(0,0,0,.42), 0 0 0 .5px rgba(255,255,255,.13)`; items 28 tall, 13px: ☐ Show full file; ☐ Split view (disabled below 820 px with the hint "Widen the panel to use split view" 11px faint); separator; Previous change `[`; Next change `]`; separator; Copy path.

**Body**: scroller padding 10 10 24, thin scrollbar. Diff card: 1 px `rgba(255,255,255,.06)`, radius 8, fill `#121117`, `overflow: clip`; focused inside → border `rgba(182,159,247,.16)`. Binary: "Binary file" (padding 14 12, 12px `#878590`). Below the card: "Next in Changes" 11.5px `#878590`, margin 16 4 0; next-file card: min-height 44, margin-top 6, padding 6 10, 1 px `rgba(255,255,255,.06)`, radius 8, transparent; filename 13/15 over directory 11.5px `#878590`, then +A −D, then arrow-right 16 px `#878590`; hover border `rgba(182,159,247,.28)`, fill `rgba(182,159,247,.05)`. On the last file instead: a card with a violet check reading "End of changes · Back to Changes" ("· Back to Changes" violet), margin-top 16.

### 5.7 Diff skin

- Unified by default; split only when the reader is at least 820 px wide and the user turned it on. Long lines wrap with a hanging indent (padding-inline 4ch / 12px, text-indent −2ch). Mono 12px, line-height 20px, ligatures off, italics normal.
- Context: fill `#121117`, text `#d6d3db`, hover `#18171d`.
- Added: row `#1a2323` (hover `#1d2926`), text `#a8e2bf` (syntax mixed 70% toward it), sign "+" `rgba(101,199,142,.85)`, number cell fill `#1e2a28` with number `rgba(101,199,142,.75)` and a 2 px `#65c78e` bar on its left edge.
- Deleted: row `#271b21` (hover `#2e1e24`), text `#f0b0b3` (syntax mixed 55%), sign "−" `rgba(230,120,125,.85)`, number cell `#301f25`, number `rgba(230,120,125,.66)`, 2 px `#e6787d` bar.
- Word highlights `rgba(101,199,142,.26)` / `rgba(230,120,125,.26)`, radius 2.
- Gutter: one number column (min 3ch), 11px `rgba(135,133,144,.6)` (`#a8a6ad` on hover); a deleted row's old number only on hover; cell padding 0 8 0 24; inset right rule `rgba(255,255,255,.04)`.
- Syntax: keyword `#b69ff7`; type `#a9b7f2`; string, regexp `#d6a95c`; constant `#6ba6dd`; comment `#878590`; punctuation `#8f8c97`; operator `#a8a6ad`; primitive `#cdbefc`; variable, property, object `#d6d3db`; info `#8a84c9`; critical `#e6787d`.
- Fold bars: 28 tall, fill `#191721`, hairlines `rgba(226,213,237,.06)` top and bottom, "12 unmodified lines" 11px/28px sans `#878590`, expand buttons `#8a84c9` (hover fill `#221f2d`, text `#b69ff7`). Partial patches: 8 px `#17151c` bars with hairlines. Split view empty sides flat `#141218`.
- Selection: violet overlay `rgba(182,159,247,.13)`; selected number cells fill `#302b3f`, text `#cbbdf9`, inset 2 px `#9d84ee` left and 2 px `#9274ec` right. Find (⌘F): matches `rgba(214,169,92,.3)`, current .55.

### 5.8 Line comments

- Gutter "+" on a hovered row: 16 x 16, radius 4, fill `#9274ec`, white 600 12px "+", shadow `0 1px 6px rgba(146,116,236,.45)`, at left 5 / top 2 in the number cell. Dragging along numbers selects a range.
- Comment card: max 560, margin 6 10 8 12; padding 10 12, 1 px `rgba(182,159,247,.18)`, radius 8, fill `#1b1922`, shadow `0 6px 18px rgba(0,0,0,.28)`; text 12.5px/18px `#d6d3db`; meta "line 145" 11px mono `#878590`; a 20 x 20 "⋯" with Edit and Delete. In unified view the gutter shows a 2 px `#9274ec` rail.
- Editor: border `rgba(157,132,238,.55)` + ring `0 0 0 3px rgba(157,132,238,.12)`; label "Comment" 13px weight 530; textarea min 80, 1 px `rgba(255,255,255,.08)`, radius 6, fill `#141218`, 13px/19px, placeholder "Add context for this change"; footer: meta left, "Cancel" (neutral) and "Comment" (26 tall, radius 6, fill `#9274ec`, white; hover `#8466e0`) right.

### 5.9 Keyboard

⌘⇧R toggles the panel; `<` / `>` previous or next file; `[` / `]` previous or next change; Esc back from the reader, a second Esc closes the panel; `/` reveals the filter; ↑ ↓ ↵ move in the filtered list; ⌘F find in the reader.

### 5.10 Not in the panel (unchanged)

No per-file or per-hunk accept, reject or revert. Revert is Rewind on the chat's "Edited N files" card; Review on that card opens the panel.

### 5.11 Known contrast misses in today's panel (recorded, not changed)

Measured with `scratchpad/blendcrit/c.py`. They are today's values and the Changes board draws them as they are; fixing them is a separate change to today's panel, not part of the blend.
- Gutter line numbers, `rgba(135,133,144,.6)` on `#121117`: 2.62:1.
- A deleted row's old number, `rgba(230,120,125,.66)` on `#301f25`: 3.18:1.
- The directory under the last-opened row's name, `#878590` on the `rgba(182,159,247,.08)` wash: 4.39:1.
- Faint text in the reader's More actions menu, `#878590` on `#202023`: 4.48:1.

---

## 6. Browser: two concepts, the first in three modes

Today the browser is the side panel's "Browser" tab (PreviewPanel; a native Electron WebContentsView laid over a placeholder div). Every concept keeps everything it does today (back, forward, reload, the address field with its status dot and go arrow, "Toggle Vector sidebar", "Open in system browser", local-server detection, "Waiting for your app", the composer's permission dock, the "Browser handoff" question) and adds what research found people rely on: a visible "who is driving" state, Take over / Give back, picks and screenshots that reach the chat, and a privacy indicator. All labels are Vector's own words; none is copied from another product.

Changed by 6.G (owner reference, 2026-11-11): "Toggle Vector sidebar" and "Open in system browser" moved into the More menu. Local-server detection now feeds the dev-server list. The new-tab card replaces "Waiting for your app". The status dot and go arrow are optional (6.G, Left open).

Said plainly, there are two concepts:
- **The panel browser, in three modes.** A "Beside", B "Run view" and C "Inspect" share one frame, toolbar, bars and tab strip. **A** is the default, **B** is A expanded to the whole stage, **C** is A switched to Inspect. They are one design with modes, not three designs.
- **D "In the chat"**, a genuinely different shape: no panel; the page lives as a live card inside the transcript, where the work happens, and opens into A's panel only when you want to use it yourself.

The owner can choose the panel family, D, or D with A behind its Open button.

### 6.0 Shared parts

**Native view rule.** The page is a WebContentsView that paints above all app HTML. So:
- Nothing from the app's DOM is drawn over the live page. The agent cursor, target outlines and the step pill are drawn by a preload overlay inside the page (shadow DOM, `pointer-events: none`).
- The driving frame is drawn **outside** the view: the viewport div is inset 2 px and the frame is a 1.5 px line in that inset.
- Anything that must float over the page (pick popover, numbered pins, B's floating chat card) either uses a frozen screenshot of the page while it is open (pick mode) or its own stacked WebContentsView (B's card; see 6.B).
- D's transcript cards never host the native view; they draw captured frames (section 6.D).
- The sidebar material goes solid while a browser surface is visible (SIG risk: Electron issue 41979).

Changed by 6.G: the toolbar is now the reference's row 2, the nav row: 44 tall on `--vxs-browser-panel`, with 28 px buttons and 16 px icons. The address field is 29 tall, radius 8, fill `--vxs-browser-field`, no border, text 14/20, placeholder "Type a URL" (was "Search or type a URL"). A new tab opens with the field focused, shown by a 1.5 px `--vxs-accent` ring (this replaces the border-and-glow focus style below). Items 5-8 moved to row 1 and the More menu, and the "⋯" menu's "Local servers ▸" became the Dev servers popover. The list below is kept as history.

**Toolbar** (36 tall, fill `--vxs-main`, 1 px `--vxs-hairline` below, padding 0 8, gap 4):
1. Back: icon button 24, chevron-left 14. Aria "Go back". Disabled `--vxs-text-disabled`.
2. Forward: icon button 24, chevron-right 14. Aria "Go forward".
3. Reload: icon button 24, circular arrow 14; spins while loading; disabled with no URL. Aria "Reload page".
4. **Address field**: flex 1, 26 tall, radius 7, fill `rgba(0,0,0,0.22)`, 1 px `--vxs-hairline`, padding 0 4 0 10, gap 6. Focus: border `rgba(182,159,247,0.50)` + `0 0 0 2px rgba(182,159,247,0.16)`, fill `rgba(0,0,0,0.32)`.
   - 6 px status dot: `--vxs-ready` when a page is loaded; `--vxs-text-3` breathing (opacity 1 → 0.4, 1.4 s) while waiting.
   - Origin marker: 12 px `lock` in `--vxs-text-3` for https, or a "localhost" tag for local servers: 16 tall, padding 0 5, radius 4, fill `rgba(98,196,141,0.12)`, gap 4, a 4 px `--vxs-ready` dot, then "localhost" in mono 10/14 `--vxs-text-2` (the dot carries the colour; the word stays neutral).
   - URL 12/16: host `--vxs-text`, path `--vxs-text-3`; selects all on focus; Esc reverts and blurs. Placeholder **"Search or type a URL"** (today's string names another company's search engine; the blend drops the name).
   - **Sharing chip** (privacy, all concepts; Vector's own form, no eye glyph): a toggle 18 tall, radius 5, padding 0 6, gap 4, transparent, hover `--vxs-row-hover`. **Shared**: a 6 px solid dot in `--vxs-running` (Vector's status colour) + "Shared" 10/14 weight 500 `--vxs-text-2`; tooltip "Vector can read and screenshot this page. Click to make it private." **Private**: a 6 px ring (1.25 px) in `--vxs-needs` + "Private" in `--vxs-text`; tooltip "Private: Vector can't read or screenshot this page, so it pauses here." `aria-pressed`, aria label "Share this page with Vector".
   - Go: 20 x 20, radius 5, 12 px arrow-right `--vxs-text-3`. Aria "Open URL".
5. Concept-specific buttons (each concept lists them).
6. "Toggle Vector sidebar" (today): icon button 24, `sidebar-toggle` 14. Hidden at panel width ≤ 420 (today's container query).
7. "Open in system browser" (today): icon button 24, `external` 14. Only when a URL is loaded. Hidden at ≤ 420.
8. **"⋯"** icon button 24 → menu 260 wide: "Local servers ▸" (each server as "vectordev.ai web · localhost:4321" with Run or Stop, then "Stop every server"), "Check changes in the browser after each edit" (switch), separator, "Browsing data…" (opens the privacy popover), "Site permissions…" (Settings › Browser, section 6.E), separator, "Open in system browser", footer note 11/14 `--vxs-text-3` padding 6 10: "Downloads, camera, microphone and location are off in Vector's browser."

**Page tabs** (only with 2 or more tabs; 28 tall row under the toolbar, padding 0 8, gap 2, 1 px `--vxs-hairline` below): tabs 22 tall, padding 0 4 0 8, radius 6, max-width 180, 12/16, gap 6. No site icons (no third-party marks): a 12 px `globe` in `--vxs-text-3`, or the 4 px `--vxs-ready` dot for localhost. Active tab fill `--vxs-row-selected`, text `--vxs-text`; others `--vxs-text-2`. A tab Vector is using shows a 10 px orbit in `--vxs-running` before its title. Close × 16 on hover. Trailing "+" icon button 22. Tabs Vector opens open in the background and never take focus.
Changed by 6.G: the tab strip is always shown, even with one tab, as row 1 (39 tall) above the nav row. Tabs are 28 tall, radius 7, 14/20, max-width 200. A lone tab has no fill. With two or more tabs the active one gets `--vxs-browser-tab-on`. The "+" (28) follows the tabs. Row 1 also holds the five window icons.

Changed by 6.G, for this bar and the two below: the copy, buttons and meaning stay, but where they sit now depends on the concept. A puts the controls in the nav row and turns the line under that row into a 2 px coloured line. B puts its run pill in row 1. C keeps a 28 px bar row under the nav row, filled `--vxs-browser-field`.

**Driving bar** (28 tall, between the tabs and the page, only while Vector acts): fill `--vxs-raised`, 1 px `--vxs-drive-line` along its top, padding 0 4 0 10, gap 8.
- 12 px orbit `--vxs-running`; text 12/16 `--vxs-text-2` "Vector is using this tab · " + the step in `--vxs-text` (e.g. 'Clicking "Max"'), ellipsis;
- spacer; **Take over** (secondary 22: radius 6, 11/14 weight 500); **Stop** (icon button 22 with an 8 px square radius 2 in `--vxs-text`; tooltip "Stop the run esc"). This Stop is the composer's Stop: it always cancels the whole run.
- The page frame shows 1.5 px `--vxs-drive-outline`, static (no pulse, no glow).
- The bar always describes the tab you are looking at. When Vector works in a tab you are not looking at (tabs it opens stay in the background), the bar reads "Vector is using another tab · " + that tab's title in `--vxs-text`, with "Show" (ghost 22) that switches to it, plus Stop; the frame and the cursor appear only on the tab Vector is using.
- Agent cursor (preload overlay): 14 px arrow, fill `#A58CF2`, 1.2 px `#FFFFFF` stroke; tag "Vector" 10/12 weight 600 `#FFFFFF` on `#7C5CE6`, radius 4, padding 1 4, offset (12, 14). A click shows one ring growing 6 → 20 px, 1.5 px `#A58CF2`, fading over 180 ms (off under reduced motion). The target element gets a 1.5 px `#A58CF2` outline, radius 4.

**You-have-control bar** (same slot and size): 1 px `--vxs-control-line` on top; 12 px `pause-bars` in `--vxs-text-2`; text 12/16 `--vxs-text-2` "You have control · Vector is paused · no screenshots"; spacer; **Give back** (primary pill 22, radius 6, 11/14 weight 600); **Stop** (as above). The page frame line disappears. Clicking into the page while Vector drives switches to this state at once (today's rule: the user's own clicks are theirs); Take over does the same.

**Waiting bar** (same slot, while a permission ask is open): 1 px `--vxs-control-line` on top; 12 px diamond `--vxs-needs`; "Vector is waiting for you · Open vectordev.ai?"; spacer; **Review** (secondary 22) scrolls to and focuses the permission dock. The page is never covered.

**Permission prompt** (today's dock, browser copy; section 4.6 recipe):
- External open (`browser_external`): header "Permission required"; line 13/18 `--vxs-text` "Open **vectordev.ai** in Vector's browser"; hint 12/16 `--vxs-text-3` "Allow always remembers this site. Local servers never ask."; buttons Deny / Allow always / Allow once. This matches today's rule (packages/engine/src/tool/browser.ts, `approve`): a site asks every time until you choose Allow always, which is remembered for its origin; localhost, 127.0.0.1, ::1 and `*.localhost` never ask.
- After the chat has read the web: a new address always asks, whatever was allowed before, and there is no Allow always. The dock reads "Open **vectordev.ai/pricing** in Vector's browser", hint (today's reason) "This conversation read the web, and this address is new: neither you nor an earlier result gave it. A page can steer the agent into putting your data in an address.", buttons Deny / Allow once.
- Interaction on an external page (`browser_interact`): line "Click and type on **vectordev.ai**".
- Sensitive verbs (`browser_sensitive`: buy, pay, send, delete, publish, submit, deploy, merge): line 'Submit the form "Feedback" on vectordev.ai'; hint "Vector asks before every action like this."; buttons Deny / Allow once (no Allow always).
- Handoff (question dock): header "Browser handoff"; text "Sign in or get past the paywall yourself in Preview, then press Continue."; options "Continue" (primary pill; "I am done in the browser; carry on from the page it shows") and "Cancel" (ghost; "Carry on without this page"). The page switches to the You-have-control bar while the handoff is open.

**Privacy popover** ("Browsing data…", or ⌥-clicking the sharing chip): menu recipe, 280 wide, padding 8.
- Heading 12/16 weight 600 `--vxs-text-2` "Vector's browser profile".
- 12/16 `--vxs-text-3` "Kept on this computer. Separate from your own browser."
- "Sites with saved cookies" (Vector knows which sites stored cookies, not whether you are signed in): rows 28 tall with a 12 px `globe` in `--vxs-text-3`, host 12/16 `--vxs-text` ("localhost:4321", "vectordev.ai"), and a 20 px × "Clear this site's cookies".
- Switch row "Remember sign-ins between sessions" (on), with 11/14 `--vxs-text-2` "Saves cookies in Vector's browser profile."
- Danger button 24 "Clear browsing data…".

**Transcript browser row** (replaces today's generic "Called `browser`" row): tool row with the `globe` icon, title "Browser" 13/20 weight 500 `--vxs-text-2`, detail 13/20 `--vxs-text-3` (verb + target, e.g. 'Clicked "Max" · localhost:4321/codium'), result 12/20 `--vxs-text-3` (e.g. "7 steps"). Under it (margin 6 0 0 24) a strip of up to 3 screenshots, each 96 x 60, radius 6, 1 px `--vxs-hairline`, gap 6, then a "+4" tile (same size, fill `rgba(255,255,255,0.04)`, 12/16 `--vxs-text-2`). Clicking a thumbnail opens the filmstrip viewer: a stage overlay (fill `rgba(22,21,25,0.96)`), the shot at up to 80% of the stage, 64 x 40 thumbnails along the bottom (active outline 1.5 px `--vxs-focus`), step caption 13/18, ← → keys, Esc closes, "Send to chat" secondary 28.

**Picks and screenshots reaching the chat** (shared mechanics):
- A pick inserts an **inline atom at the caret** in the editor (like @file mentions), never appended at the end: 20 tall, radius 6, fill `--vxs-row-selected`, padding 0 4 0 6, gap 5, 12 px `crosshair` `--vxs-text-2`, label mono 11/14 `--vxs-text` (e.g. "div.plan-card"), a 16 x 12 thumbnail (radius 2, 1 px `--vxs-hairline`), × 14. With several picks each atom starts with a 16 px number badge (circle, fill `--vxs-accent-strong`, 10/16 weight 700 `#FFFFFF`, 4.64:1; never smaller than 10 px text) matching the pin on the page. The atom grows to 22 tall when it carries a badge.
- **Pick shortcut: ⌥⌘P** (Ctrl+Alt+P on Windows), free in today's keymap. ⇧⌘S is not used: it is today's "New task".
- What a pick attaches: element selector, component name when known, attributes, computed styles, and a screenshot of the element's box.
- A screenshot goes into the image attachments row inside the box (48 x 48 thumb) with the caption "localhost:4321/codium · 768 × 1024".
- A console error sent to chat becomes an atom with a 12 px x-ring `--vxs-failed` and the label "console · TypeError".

### 6.A Concept A: "Beside" (docked panel; the default)

**Idea.** Today's Browser tab, made legible: compact chrome, page tabs, a driving state you can see, and a Steps drawer that shows what Vector did, with screenshots, without leaving the chat.

Changed by 6.G:
- The panel is now row 1 (39), row 2 (44), the viewport and the Steps drawer. The 2 px gradient line, the 43 px strip with the Browser chip, the toolbar, the page-tab row and the bar row are gone.
- The concept buttons moved: camera to More, expand to row 1. "Expand to Run view" now reads "Expand to full view".
- The run controls sit in row 2.
- The empty state is the new-tab card.
- The narrow-panel rule keeps only "≤ 300 hides Back"; the other buttons it hid are in More now.

**Layout** (window 1520 x 900): sidebar 264 | stage 1256. Header 44 spans the stage. Below it: chat column 600 | resize handle | side panel 655 (flex). The side panel is today's frame: 2 px gradient top line, 43 px two-tone tab strip holding the **Browser** chip (today's `window` icon 14 px in `#c4a6ff`, "Browser", close × with tooltip "Close browser") and the panel close. Under the strip, top to bottom: toolbar 36, page tabs 28 (when 2+), driving / control / waiting bar 28 (when active), page viewport (flex; fill `--vxs-viewport` until the page paints), Steps drawer (28 collapsed / 220 open).

**Concept buttons** in the toolbar (after the address field): **Add screenshot to chat** (icon button 24, `camera` 14; tooltip "Add a screenshot to the chat"), **Pick an element** (icon button 24, `crosshair` 14; tooltip "Pick an element ⌥⌘P"), **Expand to Run view** (icon button 24, `expand` 14; tooltip "Run view"). Then Toggle Vector sidebar, Open in system browser, "⋯".

**Steps drawer** (A's own piece): along the panel bottom, 1 px `--vxs-hairline` on top, fill `--vxs-main`.
- Collapsed row 28: padding 0 8 0 12, 12 px chevron-up, "Steps" 12/16 weight 600 `--vxs-text-2`, "7" 11/14 `--vxs-text-3`, spacer, the latest step 12/16 `--vxs-text-3` (ellipsis).
- Open (220 tall, resizable 120-360): rows 36 tall, padding 0 8 0 12, gap 10: number 11/14 tabular `--vxs-text-3` (width 16); thumbnail 48 x 30 radius 4, 1 px `--vxs-hairline`; verb 12/16 `--vxs-text-2` + target 12/16 `--vxs-text` (ellipsis); time 11/14 tabular `--vxs-text-3`. The running step has a 12 px orbit instead of the number and `--vxs-row-selected` fill. Hover: "Send to chat" ghost 22. Clicking a row opens the filmstrip at that step.

**Agent-driving state**: driving bar under the tabs; the active tab shows the orbit; frame and cursor on the page; the Steps drawer's latest line updates. The chat column shows the working line above the composer.

**Take-over state**: You-have-control bar; the Steps drawer adds a muted row "You took over · screenshots paused" (12/16 `--vxs-text-3`, pause-bars glyph). Give back resumes from the page as it is.

**Permission**: the dock above the chat column's composer (section 6.0); the panel shows the waiting bar.

**Privacy indicator**: the sharing chip in the address field, plus the privacy popover from "⋯ › Browsing data…".

**Screenshots and picks to chat**: camera button → image attachment in the box; pick button → atom at the caret; transcript browser rows carry screenshot strips; any Steps row → "Send to chat".

**Empty state** (no URL, no local server): today's, smaller: Vector chip mark 32 px (radius 8, fill `rgba(255,255,255,0.06)`, glyph `--vxs-text-2`; not the gradient), "Waiting for your app" 14/20 weight 600 `--vxs-text`, "Start your app and Vector will attach its controlled browser here automatically." 12/16 `--vxs-text-3` max 300, centred (today's strings); under it a secondary 28 "Start your app…" (lists the project's run scripts).

**Narrow panel**: ≤ 420 hides Toggle Vector sidebar, Open in system browser and the camera; ≤ 300 hides Back (today's rule, with the attribute fixed).

### 6.B Concept B: "Run view" (full stage, floating chat)

**Idea.** When Vector does a long job in the browser, the page gets the whole stage and the chat floats in a card, with a step pill on the page and a single run pill that always says who is in control.

Changed by 6.G:
- Rows 1 and 2 span the stage under the header, so the viewport is 1256 x 773 (inset 2 for the frame).
- The run pill sits in row 1, 8 px before the five icons.
- Row 1's fourth icon is `collapse` ("Back to the side panel") and its fifth is Close browser.
- Open in system browser and "⋯" moved to More and to row 1's second icon.
- The empty state is the new-tab card.

**Layout** (window 1520 x 900): sidebar 264 | stage 1256. Header 44 (unchanged; Tasks, Changes, Terminal still work). Toolbar 36 full stage width. Page viewport 1256 x 820 (inset 2 for the frame). Floating chat card at right 16, bottom 16.

**Toolbar** (shared, plus): after the address field a **Run pill** (24 tall, radius 12, 1 px `--vxs-hairline-strong`, padding 0 3 0 8, gap 6, 11/14):
- driving: 10 px orbit `--vxs-running` + "Vector is driving" `--vxs-text-2` + "Take over" (20 tall, radius 10, fill `--vxs-row-pressed`, 11/14 weight 500 `--vxs-text`, padding 0 8) + Stop (20 x 20, radius 10, 8 px square);
- you have control: pause-bars `--vxs-text-2` + "You have control · no screenshots" + "Give back" (20 tall, radius 10, primary pill) + Stop;
- waiting: diamond `--vxs-needs` + "Waiting for you" + "Review" (20 tall, radius 10, 1 px `--vxs-hairline-strong`);
- idle: no pill.
Then **Pick** (crosshair 24; ⌥⌘P), **Collapse to side panel** (icon button 24, `collapse` 14; tooltip "Back to the side panel"), Open in system browser, "⋯", and last **Close browser** (icon button 24, 14 px ×; tooltip "Close browser"), which leaves Run view and closes the Browser tab, so the chat fills the stage again. There is no separate driving bar in B: the run pill replaces it.

**Step pill on the page** (preload overlay): top centre, 12 below the page top, 28 tall, radius 14, fill `rgba(22,21,25,0.92)`, 1 px `rgba(255,255,255,0.12)`, padding 0 12, gap 8, 12/16 `#ECEBEF`: 10 px orbit `#A58CF2` + "Step 7" `#95929C` (4.81:1 even over a white page) + 'Typing "site permissions" into Search docs'. The target gets the 1.5 px outline and a tag above-left: "Typing" 10/12 weight 600 `#FFFFFF` on `#7C5CE6`, radius 4, padding 1 5. The agent cursor sits at the end of the typed text. While you have control the pill reads "Paused · you have control" with pause-bars.

**Floating chat card**: its own WebContentsView stacked above the page view (so it can float over the native page), 380 wide, height 540 (max `min(560px, viewport − 32px)`), radius 12, fill `--vxs-main` (opaque), 1 px `--vxs-raised-border`, `--vxs-menu-shadow`. Draggable by its header; snaps to the four corners (16 px inset).
- Header 40, padding 0 6 0 8, 1 px `--vxs-hairline` below: segmented control "Chat | Steps" (26 tall); spacer; usage pill (20, "Codium"); context ring button 24; "…" 24; **Minimize** icon button 24 (a 14 px dash).
- Chat tab: the transcript at compact size (13/20 body, user blocks radius 10 padding 8 12, tool rows 12/18 min 24, max-width 100%), docks, then the composer: box radius 12, min 44, padding 8 8 8 12, editor 13/20, mic / attach / send 28; chips row under it with the "how" group only (where chips hidden; model label max 96; Codium ring hidden; one row that never wraps, compacting per section 4.4; it wrapped to two lines below 340 until 2026-11-11).
- Steps tab: numbered rows 44 tall: number 11/14 `--vxs-text-3`, thumbnail 56 x 36 radius 4, verb + target 12/16, time 11/14 `--vxs-text-3`; the current step has the orbit and `--vxs-row-selected`. Hover "Send to chat" ghost 22.
- **Menus inside the card**: the card is its own view, so nothing it opens can paint outside its 380 x 540 bounds. Every menu, popover and tooltip from the card flips and clamps to stay inside them (8 px inset). The model picker, the "/" and "@" popover and the Effort popover open as sheets over the card's transcript area (full card width minus 16, anchored above the composer, radius 10, menu recipe, max height = card height − composer − 56), never past the card's edge. Hover tooltips on the card's buttons open toward the card's centre.
- Minimized: a 220 x 32 pill at the same corner, radius 16, fill `--vxs-main`, 1 px `--vxs-raised-border`, `--vxs-menu-shadow`, padding 0 4 0 12: 10 px orbit + "Chat · Vector is typing…" 12/16 `--vxs-text-2` (ellipsis) + a 24 expand button. A diamond replaces the orbit when Vector waits for you.

**Agent-driving state**: run pill "Vector is driving", step pill, cursor, outline, frame on the viewport.

**Take-over state**: run pill "You have control · no screenshots" with Give back; the step pill says "Paused · you have control"; the Steps tab adds "You took over · screenshots paused".

**Permission**: the dock appears above the card's composer and the card un-minimizes; the run pill shows "Waiting for you".

**Privacy indicator**: the sharing chip in the address field, plus the run pill's wording "no screenshots" while you have control. "⋯ › Browsing data…" as shared.

**Screenshots and picks to chat**: screenshots live in the Steps tab and the transcript rows; "Send to chat" on any step; Pick works as in C (frozen frame while picking); atoms land at the caret of the card's composer.

**Empty state** (Run view opened with no page and no local server): the stage viewport shows A's empty state centred (chip mark, "Waiting for your app", today's line, "Start your app…"); the address field is empty with its placeholder; no run pill; the chat card stays open at its corner.

**Closing**: Close browser (toolbar ×) leaves Run view and closes the Browser tab; Collapse returns to A with the page as it is; Esc does not close (Esc is the run's Stop).

**Tasks, Changes and Terminal in Run view** (the header stays; nothing may draw over the native page except the card):
- **Tasks** opens the Tasks pane docked as the stage's last column (320 wide, section 4.9); the page viewport narrows by 320 and the card moves left with it. Never floating in Run view.
- **Changes** leaves Run view: the layout returns to the split (chat column and side panel) with the panel on Changes; the Browser tab stays in the panel's tab strip, so one click brings the page back (in A).
- **Terminal** opens the terminal panel under the page viewport (full stage width, 240 tall); the page viewport gets shorter and the card stays inside it.

### 6.C Concept C: "Inspect" (split dev preview)

**Idea.** For building vectordev.ai and other web apps: the browser tab switches to Inspect, showing the app on its local server at real device sizes, with a console you can read, and element picking straight into the chat.

Changed by 6.G:
- The viewport bar is gone. Its device control, readout and rotate sit in row 2 after the address field, then an Inspect toggle (it replaces Browse | Inspect), then Pick.
- The page colour-scheme toggle moved to More.
- The server pill left the address field; the Dev servers popover and the drawer's Server log row hold the server.
- The bar stays as a 28 px row under row 2.
- Zoom is now 69% idle and 65% while driving (it was 65% and 62%).
- The empty state is the new-tab card on the canvas.

**Layout** (window 1520 x 900): sidebar 264 | stage 1256. Header 44 spans. Below: chat column 560 | resize handle | side panel 695 (today's frame and tab strip, Browser chip active). Under the strip: toolbar 36, viewport bar 32, driving bar 28 (when active), device canvas (flex), drawer (28 collapsed / 160 open, resizable 100-320).

**Toolbar** (shared, with changes):
- The address field's left part becomes a **server pill** inside it: 20 tall, radius 5, fill `rgba(255,255,255,0.05)`, padding 0 6, gap 5: 6 px `--vxs-ready` dot, mono 11/14 `--vxs-text` "localhost:4321", 11/14 `--vxs-text-3` "Running", 12 px chevron. Then the path "/codium" 12/16 `--vxs-text-2`. The pill's menu: "Local servers" heading; "vectordev.ai web · localhost:4321 · Running" (check), "Stop", "Restart"; separator; "Start your app…"; "Check changes in the browser after each edit" switch; note 11/14 `--vxs-text-3` "Local servers never ask for permission."
- **Browse | Inspect** segmented control (26 tall) right of the field; Inspect active.
- **Pick** (icon button 24, `crosshair`; pressed fill `--vxs-active-fill`, icon `--vxs-accent-text`; tooltip "Pick an element ⌥⌘P"), **Capture** (camera 24; tooltip "Add a screenshot of this device to the chat"), Open in system browser, "⋯".

**Viewport bar** (32 tall, padding 0 8, gap 8, 1 px `--vxs-hairline` below, fill `--vxs-main`):
- Segmented control: "Phone 375" (with `device-phone` 12), "Tablet 768" (`device-tablet`), "Desktop" (`device-desktop`), "Fit".
- Readout 11/14 tabular `--vxs-text-3` "375 × 812".
- Rotate (icon button 24, `rotate`).
- Page colour scheme toggle (icon button 24; sun / moon 14; tooltip "Show the page in light or dark").
- Spacer; zoom readout 11/14 tabular `--vxs-text-3` "65%" (see the geometry below).

**Device canvas**: fill `--vxs-terminal` `#121115`, the page centred in a device frame: radius 12 (Phone and Tablet) or 6 (Desktop), 1 px `rgba(255,255,255,0.10)`, shadow `0 12px 32px rgba(0,0,0,0.40)`, 16 px margin top and bottom and at least 16 at the sides. A 11/14 `--vxs-text-3` label 8 px under the frame: "vectordev.ai · localhost:4321/codium". Scale = min((canvas width − 32) / device width, (canvas height − 32 − 22) / device height), shown in the zoom readout rounded to a whole percent. On the board (window 900 tall): canvas height = 900 − 44 header − 43 tab strip − 36 toolbar − 32 viewport bar − 160 open drawer = 585, so Phone 812 tall scales to 531 / 812 = **65%**; with the driving bar showing (28 more) it is 503 / 812 = 62%.

**Pick mode**: the live view is swapped for a frozen screenshot of itself (so outlines and popovers can draw over it); the canvas dims the page 8% (overlay `rgba(0,0,0,0.08)`). Hover draws a 1 px `--vxs-focus` outline with a tag above-left (18 tall, radius 4, fill `--vxs-menu`, 1 px `--vxs-raised-border`, mono 11/14 `--vxs-text`, e.g. "div.plan-card · 343 × 212"). Shift-drag draws an area: 1 px dashed `--vxs-focus`, fill `rgba(182,159,247,0.08)`. A click pins it: 16 px number badge (as the composer atom's) at the element's top-left, and opens a **note popover** next to it (menu recipe, 280 wide, padding 8): a 3-line text field "Add a note…", then 11/14 `--vxs-text-3` "↵ attach · ⌘↵ send", primary pill 24 "Attach". A floating mode palette sits at the canvas bottom centre: segmented "Element | Area" (26 tall) plus "Done" ghost 22. Esc leaves pick mode; the live view returns.

**Drawer** (1 px `--vxs-hairline` on top, fill `--vxs-terminal`):
- Header 28, padding 0 6 0 8, gap 2: tabs 22 tall (radius 6, 12/16 weight 500; active `--vxs-row-selected`): "Console" with an error count badge "2" (count badge recipe, fill `rgba(232,119,125,0.16)`, text `--vxs-diff-del`); "Network"; "Server log". Spacer; "Send to chat" ghost 22 (enabled when rows are selected); clear (icon button 22, trash 12); collapse chevron 22.
- Rows mono 11/16, 24 tall (wrap allowed), padding 0 10, hairline between, gap 8: level glyph 12 (error x-ring `--vxs-failed`; warning `warning` `--vxs-needs`; log none), message `--vxs-text-2` (errors `--vxs-text`), source right 11/16 `--vxs-text-3`. Error rows fill `rgba(232,119,125,0.06)`. Hover shows "Send to chat" ghost 20 at the right.
- Network rows: method `--vxs-text-3`, path `--vxs-text`, status (`--vxs-text-2`; 4xx/5xx rows tinted like errors), type, size, time; columns 48 | flex | 40 | 72 | 56 | 52.

**Agent-driving state**: driving bar under the viewport bar; frame round the device frame (1.5 px `--vxs-drive-outline`, offset 3, radius of the frame + 3); cursor in the page.

**Take-over state**: You-have-control bar in the same slot.

**Permission**: localhost never asks (the server pill note says so). Following a link off the local server (e.g. to vectordev.ai/docs) raises the dock in the chat column and the waiting bar.

**Privacy indicator**: the server pill (which stands in for the "localhost" tag) plus the sharing chip; the pill's note "Local servers never ask for permission"; "⋯ › Browsing data…".

**Screenshots and picks to chat**: Pick → numbered atoms at the caret with notes; Capture → device screenshot thumb in the box ("Phone 375 × 812"); console and network rows → "Send to chat" atoms.

**Empty state** (Inspect with no local server running): the server pill reads "No server" with a 6 px `--vxs-text-3` ring and no path; the viewport bar stays (device sizes can be chosen in advance); the empty device frame (fill `--vxs-viewport`) holds A's empty state scaled to fit: chip mark, "Waiting for your app", today's line, "Start your app…" secondary 28; the drawer's Console reads "Nothing logged yet" and Server log "No server output yet" (12/16 `--vxs-text-3`, centred, 48 tall); Pick and Capture are disabled.

### 6.D Concept D: "In the chat" (live page cards in the transcript)

**Idea.** No panel and no split. When Vector uses the browser, the page shows up as a live card in the transcript, at the point in the conversation where the work happens, like a tool row that grew a screen. The chat keeps the whole stage; you watch the page in the same place you read Vector's replies. When the run ends the card settles into a still with its steps. To use the page yourself, Open docks it into A's panel.

**Why it is different**: the page is part of the conversation's history instead of a place beside it. Scrolling up shows what each page looked like when Vector used it; there is no browser chrome on screen until you ask for it.

**Native view rule for D**: a WebContentsView cannot scroll or clip with the transcript, so the card never hosts it. The card draws captured frames of the page into a `<canvas>` (up to 10 frames a second while the card is on screen, none while it is scrolled away or the window is hidden). Because the card is app DOM, the agent cursor, target outline and pick outlines are drawn by the app over the frames, scaled. The page itself keeps running in its hidden view; Open shows that real view in A's panel.

**Layout** (window 1520 x 900): sidebar 264 | stage 1256. Header 44 spans the stage. Transcript column max 720 centred, no side panel; the composer as in section 4.3 at full width (where and how chips on one line).

**Page card** (outline card radius 12, 1 px `--vxs-hairline-strong`, fill `--vxs-raised`, overflow hidden, width = column width; while Vector drives the border is the static 1.5 px `--vxs-drive-outline`):
- **Top bar** 36 tall, padding 0 6 0 12, gap 8, 1 px `--vxs-hairline` below: state glyph 12 px (orbit `--vxs-running` driving; `pause-bars` `--vxs-text-2` you have control; diamond `--vxs-needs` waiting; `globe` `--vxs-text-3` idle); origin (the "localhost" tag, or `lock` + host) with host 12/16 `--vxs-text` and path `--vxs-text-3`, ellipsis; spacer; the sharing chip; icon buttons 24: Add screenshot to chat (`camera`), Pick an element (`crosshair`, ⌥⌘P), Open (`expand`; tooltip "Open the page beside the chat"), "⋯" (Open in system browser, Browsing data…, Site permissions…, Hide live view).
- **Live frame**: full card width; height = min(card width × page height / page width, 560). The page is scaled to fit and centred; any spare width is `--vxs-viewport`. A 1280 x 800 page in a 720 card is 720 x 450 (scale 56%); a 768 x 1024 tablet page is 420 x 560, centred. Private page: no frames; the frame shows "Private page · Vector can't see it" 12/16 `--vxs-text-2` centred on `--vxs-viewport` (this is also the privacy proof).
- **Step strip** 36 tall, padding 0 6 0 12, gap 8, 1 px `--vxs-hairline` above: "Step 7 of 7" 11/14 tabular `--vxs-text-3`; the step text 12/16 `--vxs-text-2` with its target in `--vxs-text` (e.g. 'Typing "site permissions" into Search docs'), ellipsis; spacer; the latest three step thumbnails 40 x 25, radius 4, 1 px `--vxs-hairline`, gap 4 (click → filmstrip, section 6.0); then by state: **Take over** (secondary 24) + **Stop** (icon button 24, 8 px square) while driving; **Give back** (primary pill 24) + Stop while you have control; **Review** (secondary 24) while waiting; **Open** (ghost 24) when idle.
- **Settled** (the run moved on or ended): the live frame becomes the last frame cropped to 240 tall from the top, the top bar's glyph is the `globe`, the step strip reads "5 steps · 0:09" and keeps its thumbnails and Open. Only one card is live at a time: when Vector starts on another page later, the earlier card settles and a new live card appears at the bottom, next to the composer.
- **Scrolled away while live**: a 28 tall bar pins under the header, centred to the column, radius 8, fill `--vxs-raised`, 1 px `--vxs-drive-line` on top: 10 px orbit, "Vector is using vectordev.ai · Typing into Search docs" 12/16 `--vxs-text-2`, "Jump" (ghost 22), Stop (icon button 22).

**Agent-driving state**: the live card's border, cursor and target outline over the frames, step strip with Take over and Stop; the working line above the composer as usual.

**Take-over state**: Take over opens the real page in A's panel in its You-have-control state (the stage splits 600 | panel); the card's strip shows "You took over · screenshots paused" with Give back. Clicking a card's frame never clicks the page.

**Permission**: the dock above the composer as always (section 6.0 copy); the live card's glyph turns to the diamond and its strip shows "Waiting for you" with Review; no new card appears for a page that was not allowed.

**Privacy indicator**: the sharing chip on each card, and the "Private page" frame.

**Screenshots and picks to chat**: camera → image attachment in the box; Pick freezes the card's current frame and picks on it (the preload maps the scaled point to the page's element), then adds the numbered atom at the caret and a pin on the frame; any thumbnail → filmstrip → "Send to chat".

**Empty state**: there is nothing to draw until Vector uses a page. "/browser" or More › Browser with no page inserts a card whose frame holds A's empty state ("Waiting for your app", today's line, "Start your app…").

**Narrow columns**: below a 560 px column the card keeps the column width and the top bar drops Pick and the camera into "⋯".

### 6.E Settings › Browser (shared by all concepts)

A Settings page (section 7.2 recipes) titled "Browser", subtitle "How Vector's own browser behaves. It is separate from the browser you use." Sections and rows:
- **Access**: switch "Vector can use the browser" (on), description "Lets the agent open, read and click pages in Vector's browser."; select "New sites" Ask (default) / Allow / Read only / Block; boxed list "Sites" (rows 48: host 13/18 `--vxs-text`, per-site select "Use and click" / "Read only" / "Blocked", "Remove" ghost 24). Mockup rows: "vectordev.ai" Use and click, "localhost" Use and click with the tag "Never asks", "docs.example.com" Read only.
- **Profile**: switch "Remember sign-ins between sessions" (on), description "Saves cookies in Vector's browser profile on this computer."; danger button 28 "Clear browsing data…".
- **Links**: select "Open external links in" Vector / Your default browser.
- **Checks**: switch "Check changes in the browser after each edit" (off), description "After Vector edits a page it opens it on your local server and looks for errors."
- **Local servers**: boxed list (rows 48: "vectordev.ai web" 13/18, mono 12/16 `--vxs-text-2` "localhost:4321 · pnpm dev", status dot + "Running", "Stop" ghost 24); empty "No local servers found in this project."

### 6.F Which to choose

| | A Beside (panel) | B Run view (panel, expanded) | C Inspect (panel mode) | D In the chat |
|---|---|---|---|---|
| Best for | Everyday: Vector checks a page while you keep chatting | Long browser jobs you want to watch or take over | Building and fixing web pages | Following what Vector did, page by page, without browser chrome on screen |
| Chat | Full column | Floating card | Full column | Whole stage |
| Page size | Panel (655 here) | Whole stage | Device frame | Column-wide card (720 x 450 for a desktop page) |
| Driving state | Driving bar + frame + cursor | Run pill + step pill + cursor | Driving bar + frame + cursor | Card border + cursor + step strip |
| Unique piece | Steps drawer | Floating card with Chat / Steps | Viewport bar, console drawer, pick with notes | Page history in the transcript; settled cards |
| Build risk | Low (today's panel) | Highest (stacked native view for the card) | Medium (frozen frame, console capture) | Medium (frame capture stream, coordinate mapping for picks) |

Recommendation for the owner: the panel family (A as the default, B behind "Expand", C behind the Inspect switch), with D drawn so the owner can compare a different shape. D and A also combine: cards in the chat, Open into A's panel.

### 6.G Owner reference: browser chrome (2026-11-11)

The owner pasted a screenshot of a docked browser panel and said "browser should look kind of like this". The screenshot is not in this folder. The values below were measured in CSS px from a 2x capture of the panel, about 692 x 772.

What it replaces, for A, B and C:
- 6.0's toolbar, page-tab row and the slot of the three bars;
- 6.A's chip strip and gradient line;
- 6.B's toolbar;
- 6.C's viewport bar and server pill;
- every "Waiting for your app" empty state.

What stands from 6.0-6.E: the native view rule, the frame round a driven page, the agent cursor, the bars' copy and buttons, the permission prompts, the privacy popover, the sharing chip, picks and screenshots reaching the chat, A's Steps drawer, B's card, C's canvas and drawer, and D.

Browser-A, -B and -C were reworked to match on 2026-11-11.

**Character.** Quiet and utilitarian: one flat panel, small type, generous empty space. Icon buttons have no visible labels, only tooltips and aria-labels. No coloured bars or fills while idle.

**Browser chrome tokens** (dark only; neutral greys as in the reference, used only on the browser surface):

| Token | Value | Use |
|---|---|---|
| `--vxs-browser-panel` | `#1A1A1A` | Panel, both rows, new-tab body |
| `--vxs-browser-line` | `#2C2C2C` | Left edge, line under row 1, line under row 2 |
| `--vxs-browser-field` | `#262626` | URL field; C's bar row |
| `--vxs-browser-card` / `-card-line` | `#1D1D1D` / `#2E2E2E` | Dev-server card fill / border |
| `--vxs-browser-play` | `#3A3A3A` (hover `#474747`) | Play, Stop and Open buttons on server rows |
| `--vxs-browser-tab-on` | `rgba(255,255,255,0.05)` | Active tab, only with 2+ tabs |
| `--vxs-browser-icon-off` | `#8A8A8A` | Disabled Back, Forward, Reload, Pick, Rotate |

Text and icons use the nearest blend tokens:

| Reference colour | Blend token | Note |
|---|---|---|
| Near-white `#E8E8E8` | `--vxs-text` | |
| The dimmer pop-out icon | `--vxs-text-2` | |
| Server name `#C8C8C8` | `--vxs-text-row` | |
| Port `#A0A0A0` | `--vxs-text-2` | |
| Placeholder `#8A8A8A` | `--vxs-text-3` | `#8A8A8A` on the field is 4.4:1; `#95929C` is 4.95:1 |

**Surface.**
- Fill `--vxs-browser-panel`, opaque. No gradient, no glass, no 2 px gradient top line; the glass tweak never reaches it.
- 1 px `--vxs-browser-line` on the left edge.
- Full-width 1 px lines under row 1 and under row 2 (`box-shadow: inset 0 -1px 0`).
- Nothing else decorates it.

**Row 1: tab strip** (39 tall, padding 0 12, `display: flex; align-items: center`).
- **Tabs**: `role="tablist"`, aria "Pages". The strip scrolls sideways with its scrollbar hidden.
  - Each tab: 28 tall, radius 7, max-width 200, padding-left 8, gap 6, 14/20.
  - **One tab**: no fill, text `--vxs-text`, padding-right 12, no close. The text starts 20 px from the panel edge.
  - **Two or more tabs**:
    - Active tab: fill `--vxs-browser-tab-on`, text `--vxs-text`.
    - Other tabs: transparent, text `--vxs-text-2`, hover `--vxs-row-hover`.
    - Padding-right 26, for a 16 px close × (right 5, `--vxs-text-2`). The × shows on the active tab and on hover or focus. Tooltip "Close tab ⌘W".
    - The tab that Vector's live run is on can't be closed while the run is live.
  - **Leading 12 px slot**, only on the active tab or the tab Vector is using:
    - the 10 px orbit in `--vxs-running` when Vector is using the tab;
    - else the 6 px `--vxs-ready` dot for a local server;
    - else a 12 px `globe` in `--vxs-text-3`.
    - A blank tab reads "New tab" and has no glyph.
  - Tooltip: the title, plus " · Vector is using this tab" when it is.
- **New tab**: icon button 28, radius 7, margin-left 6, with a 16 px "+" in `--vxs-text`. Its glyph sits 24 px after a lone tab's text. Tooltip "New tab ⌘T". It opens a blank tab with the address field focused.
- A spacer (min 12), then **five window icons**:
  - 28 x 28 buttons, radius 7, gap 4, so centres are 32 apart.
  - 16 px glyphs, stroke 1.75, round caps and joins, in `--vxs-text`; the pop-out is in `--vxs-text-2`.
  - The last glyph ends 18 px from the panel's right edge.
  - Hover `--vxs-row-hover`; while its popover is open, `--vxs-row-pressed`.
  - Glyphs (viewBox 0 0 24 24):
    1. `dev-servers`: rect 16 x 16 rx 3 at (4,4); `M4 12h16M8 8h3M8 16h3`.
    2. `more`: three filled circles, r 1.5, at (6,12), (12,12) and (18,12).
    3. `pop-out`: rect 17 x 14 rx 2.5 at (3.5,5); a filled rect 5.5 x 4.5 rx 1 at (12,11.5).
    4. `expand` / `collapse`: the 2.4 paths, drawn at 16.
    5. `close`: `M6.5 6.5l11 11M17.5 6.5l-11 11`.

Action and tooltip of each window icon, per concept (the aria-label is the tooltip without a shortcut):

| # | A "Beside" | B "Run view" | C "Inspect" |
|---|---|---|---|
| 1 | "Dev servers": opens the Dev servers popover | same | same |
| 2 | "More": opens the More menu | same | same, plus C's items |
| 3 | "Open in a window": moves the browser, with its tabs as they are, into a window of its own; the chat fills the stage | same; Run view ends | same |
| 4 | `expand`, "Expand to full view": switches to B with the page as it is | `collapse`, "Back to the side panel": returns to A with the page as it is | `expand`, "Expand to full view": switches to B; collapsing returns to C with the device, console and picks as they were |
| 5 | "Close browser": closes the browser panel; the chat fills the stage | "Close browser": leaves Run view and closes the browser | "Close browser": closes the browser view; the panel shows Changes if that is open, otherwise the panel closes |

While the browser is the panel's view, this row is the panel's top row. Today's panel strip, with a "Browser" tab to come back to, returns only while another panel view, such as Changes, is showing (C's board).

**Row 2: nav row** (44 tall, padding 0 12 0 14, gap 4).
- **Back, Forward, Reload**: icon buttons 28, radius 7, aria "Go back", "Go forward", "Reload page".
  - Glyphs: 16 px, stroke 1.75; `M19 12H5M11 6l-6 6 6 6`, `M5 12h14M13 6l6 6-6 6`, and `M19.5 12a7.5 7.5 0 1 1-2.2-5.3` + `M19.5 4.5v3.8h-3.8`.
  - Colour: enabled `--vxs-text-row`, disabled `--vxs-browser-icon-off`. All three are disabled on a new tab.
  - The first glyph starts 20 px from the edge; centres are 32 apart. Reload spins while a page loads (6.0).
- **URL field**: flex 1, min-width 0, margin-left 8, 29 tall, radius 8.
  - Fill `--vxs-browser-field`, no border, padding 0 6 0 12, gap 6.
  - Input 14/20 in `--vxs-text`. Placeholder **"Type a URL"** in `--vxs-text-3`. Visually hidden label "Address".
  - With a page loaded, left to right: the origin marker (12 px `lock` in `--vxs-text-3` for https, or 6.0's "localhost" tag); the host in `--vxs-text` and path in `--vxs-text-3`; then the sharing chip (6.0).
  - On a new tab: no marker and no chip.
- Between the field and Pick: A's run controls and C's device controls (both below). B has nothing there.
- **Pick an element**: icon button 28, so its glyph sits 10 px after the field.
  - Glyph: 16 px `pointer`, `M6 3.5V18l3.8-3.4 2.6 5.7 2.3-1-2.6-5.7H17z`, in `--vxs-text-row`. It replaces `crosshair` on this button.
  - Pressed: fill `--vxs-active-fill`, icon `--vxs-accent-text`, `aria-pressed`.
  - Disabled, in `--vxs-browser-icon-off`, when the tab has no page.
  - Tooltip "Pick an element ⌥⌘P".

**URL field focus.**
- A new tab opens with the field focused: a caret, and a crisp 1.5 px ring, `box-shadow: 0 0 0 1.5px var(--vxs-accent)`. No border, no glow, and the fill doesn't change.
- The ring follows the accent tweak: purple by default, blue, pink or a custom accent on the boards. It contrasts 4.75:1 with the panel.
- The global `:focus-visible` outline is turned off on this input; the ring is its focus indicator.
- After that, the ring follows real focus: shown while the field has focus, gone on blur. A loaded page's field is not focused and has no ring.
- Focus selects all. Esc reverts the text and blurs. Enter opens the address in the current tab.
- This replaces 6.0's focus style (a `rgba(182,159,247,0.50)` border, a 2 px glow and a darker fill).

**New-tab body** (a blank tab, and the empty state of every concept).
- Fill `--vxs-browser-panel`. `--vxs-viewport` stays only behind a page that is loading.
- **One card**, centred both ways in the body (`position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px`). C draws it on the canvas, and its device controls and drawer stay. D's empty card holds it too.
- The card: 400 wide (max 100%), radius 10, 1 px `--vxs-browser-card-line`, fill `--vxs-browser-card`, `role="group"`, aria "Dev servers".
- **Rows**: one per dev server, 51 tall (so one row makes a 53 px card), padding 0 11 0 16. Each row, left to right:
  - a 16 px `dev-servers` glyph in `--vxs-text-3`;
  - a 12 px gap;
  - the name, 14/20, `--vxs-text-row`, with an ellipsis;
  - a spacer (min 12);
  - while starting, "Starting…" in 14/20 `--vxs-text-3`, margin-right 10;
  - while running, a 6 px `--vxs-ready` dot, margin-right 8, aria "Running";
  - the port, 14/20 tabular, `--vxs-text-2` (":4321");
  - a 14 px gap, then the play button.
- **Play button**: 32 x 28, radius 6, fill `--vxs-browser-play`, hover `#474747`, glyph `#FFFFFF`.

| Server state | Glyph | Disabled | Tooltip | Aria-label |
|---|---|---|---|---|
| Stopped | 14 px outlined triangle, `M8 5.5v13l10.5-6.5z`, stroke 2 | No | "Start vector-web and open it here" | "Start vector-web" |
| Starting | 14 px spinner, 0.9 s | Yes | "Starting vector-web" | "Starting vector-web" |
| Running (already up) | 14 px arrow-right | No | "Open localhost:4321 in this tab" | "Open vector-web in this tab" |

- While starting, a polite live region also says "Starting vector-web".
- **Play** starts that server, then opens its address in this tab as soon as it answers. If Vector's run was waiting for the app, the run carries on from that page.
- A second press while starting does nothing. Stopping the server (or every server) cancels a start.

**Dev-server list.** One list in three places, which always agree.
- **Where the rows come from**: the open project's dev servers. That is:
  - the servers Vector detects (today's local-server detection: the project's run scripts that start a server, and the project's servers already listening on localhost);
  - plus those configured in Settings › Browser › Local servers (6.E).
- One row per server: its name (the package or configured name; "vector-web" in mockups) and its port. 6.0, 6.C and 6.E call the same server "vectordev.ai web"; use the row's name everywhere.
- **The three places**:
  - the new-tab card;
  - the **Dev servers popover** from row 1's first icon;
  - **C's server drawer**: the "Server log" tab starts with the same row (name, port, a state word "Running", "Starting…" or "Stopped", the same button) above the log lines.
  - C's More menu also has a "Dev servers · 1 running" row that opens the popover.
- The Tasks pane and the terminal read the same running state. On a new tab with nothing started, Tasks shows vector-web as "Stopped" and the terminal's `pnpm dev` tab as stopped.
- **Dev servers popover**: `role="dialog"`, menu recipe, 300 wide, opening under its button (top 34), right-aligned.
  - Heading "Dev servers in vectordev.ai", 11/14 weight 500, `--vxs-text-3`, padding 6 8 4.
  - Rows: 40 tall, padding 0 6 0 8; the card's row at menu size (name and port 13/18, "Starting…" 12/16).
  - The button differs from the card's:
    - when the server is running, it is **Stop**: a 9 px square, radius 2, tooltip "Stop vector-web";
    - play only starts the server ("Start vector-web"), unless the tab in view is blank, where it also opens it.
  - Then a separator, and:
    - "Restart vector-web" (disabled unless the server is running);
    - "Stop every server";
    - the switch "Check changes in the browser after each edit";
    - the note "Local servers never ask for permission." (11/14 `--vxs-text-3`, padding 6 10).
- The boards draw subsets of the popover:
  - A: the rows only.
  - B: the rows with text Run / Stop ghost buttons, and "Stop every server".
  - C: the rows, Restart, the switch and the note.
  - Build the full list above.

**More menu** (row 1's second icon). It is 6.0's "⋯" menu, rearranged: menu recipe, 260 wide, right-aligned under the button.
1. "Add a screenshot to the chat", disabled without a page. C in Inspect reads "Add a screenshot of this device to the chat". The camera button left the chrome.
2. C in Inspect only: the switch "Show the page in light" (it was the colour-scheme toggle on C's viewport bar).
3. Separator. "Dev servers · 1 running ›", which opens the popover. The switch "Check changes in the browser after each edit".
4. Separator. "Browsing data…" (the privacy popover, 6.0). "Site permissions…" (Settings › Browser).
5. Separator. "Open in system browser" (disabled without a page). "Copy URL". "Hide Vector sidebar ⌘B" or "Show Vector sidebar ⌘B" ("Toggle Vector sidebar" left the chrome).
6. Footer note, 11/14 `--vxs-text-3`: "Downloads, camera, microphone and location are off in Vector's browser."

The boards word this menu differently. A has "Open in your browser", "Clear site data…" and "Browser settings", and lacks the switch. Only B has the sidebar item. C lacks Copy URL. Build the list above.

**Who is driving, inside this chrome.** 6.0's three bars keep their copy, buttons and meaning. Idle shows none of them. Where they sit depends on the concept:
- **A**: no extra row.
  - The line under row 2 becomes 2 px: `--vxs-drive-line` while Vector drives (this tab or another); `--vxs-control-line` while you have control or Vector waits.
  - The run controls sit between the URL field and Pick: margin-left 6, gap 4, all 28 tall (table below).
  - The bar's sentence (for example "Vector is using this tab · Typing …") becomes the group's tooltip and a visually hidden `role="status"` line.
  - The frame, cursor, target outline and the tab's orbit are as in 6.0.
- **B**: the run pill (6.B, unchanged: 24 tall, radius 12) sits in row 1, after the spacer and 8 px before the five icons. There is no bar and no line change.
- **C**: keeps a 28 px bar row under row 2, because row 2 is full with the device controls.
  - Fill `--vxs-browser-field`; a 1 px top line in `--vxs-drive-line` or `--vxs-control-line`; 1 px `--vxs-browser-line` below; padding 0 4 0 10, gap 8.
  - It holds 6.0's glyph, sentence and 22 px buttons.
  - The frame goes round the device frame, as in 6.C.
- **D** has no panel chrome; its Open shows A's.

A's run controls:

| State | Control | Tooltip |
|---|---|---|
| Driving this tab | **Take over**: secondary 28 with a 12 px orbit | "Take over the page" |
| Driving another tab | **Show Vector's tab**: ghost 28 with the orbit | "Show the tab Vector is using" |
| You have control | **Give back**: primary pill 28 | "Give the page back to Vector" |
| Waiting | **Review**: secondary 28 with a 12 px diamond | "Go to the permission prompt" |
| Driving or in control, after the above | **Stop**: icon button 28 with an 8 px square | "Stop the run esc" |

**C's row 2 in detail.** The rest of row 2 is the same as in A. After the URL field come:
- **Device control**: a segmented control 26 tall, radius 8, track `--vxs-seg-track`, 1 px `--vxs-browser-line`. Four 24 x 22 icon segments, with the label in each tooltip: "Phone 375", "Tablet 768", "Desktop 1280", "Fit to the panel".
- **Readout**: 11/14 tabular, `--vxs-text-3`, "375 × 812 · 69%".
- **Rotate**: 28; disabled for Desktop and Fit.
- **Inspect toggle**: 28, a monitor-and-phone glyph, pressed fill `--vxs-seg-active`. Tooltip "Inspect: device sizes and console", or "Inspect is on: device sizes and console" while on. It replaces the Browse | Inspect segmented control.
- **Pick**.
- The URL field shows the address as in A, plus a 6 px `--vxs-ready` "Page loaded" dot and the Go arrow (Left open).
- Zoom: the canvas is 856 − 39 − 44 − 160 = 613 tall, so Phone scales to (613 − 54) / 812 = **69%** idle, and 65% with the bar showing.

**Left open by the reference.** It shows one blank tab, one server and an idle panel. Open points:
- **No dev servers.** Suggested: the card shows one muted row, "No dev servers found in vectordev.ai", and a secondary 28 "Start your app…" listing the run scripts (6.A).
- **Several servers.** Rows stack in the one card with a 1 px `--vxs-browser-card-line` between them. The boards draw one.
- **A server that fails to start or exits.** Neither the state nor a link to its log is drawn.
- **The loaded-page field.** The reference shows only a blank tab. A and B drop 6.0's status dot and go arrow; C keeps both. Pick one.
- **Where the run controls sit.** A puts them in row 2, B in a pill in row 1, C in a bar row. One placement for all three would be simpler; A's (no extra row) keeps closest to the reference's empty space.
- **Enter with text that is not an address.** The placeholder is now "Type a URL". Whether such text searches, and with what, is not decided.
- **Shortcuts.** B and C show ⌘[ / ⌘] / ⌘R on Back, Forward and Reload, but ⌘[ and ⌘] are also the app's own Back and Forward (sidebar chrome; section 7.1). Scope them, and ⌘T / ⌘W for tabs, to focus inside the browser, or drop them from the tooltips.
- **"Open in a window"** does nothing on A and C; B shows a note. The window's own chrome is not drawn.
- **Tab overflow.** The strip scrolls; no overflow menu is drawn. C's board caps tabs at 4.
- **Live strip edge.** 8.2 turns the edge solid while a side panel with the gradient line is open. The browser panel no longer draws that line, but A and C keep the edge solid.

---

## 7. Other screens in the blended language

All are routes inside the shell unless stated. The sidebar stays visible; the matching verb or More item shows the selected pill. Every screen uses the section 2 recipes.

### 7.1 Vectorscope (stage route; replaces today's full-window modal)

Opened by the Vectorscope verb. Esc or ⌘[ returns to the last session. This changes two things: today's full-window modal, and Signature's behaviour, where the verb opened Vectorscope in the side panel (SIG 4.2 B). Both are listed in open decision 6.

The Vectorscope verb's meta in the sidebar is the **number of open pull requests in the current project**, the same number as the header subtitle ("vector · 3 open pull requests"); it is hidden when signed out or at 0. This narrows SIG's "reviews waiting" so the two places never disagree.

While this route is on screen the sidebar Live strip's top edge is solid `--vxs-accent` at 40%, because the route draws its own gradient tile (the AI review tile, or the signed-out tile).

**Header** 44, padding 0 12 0 20: `vectorscope` 14 px `--vxs-icon` at x 20; "Vectorscope" 13/18 weight 500 at x 40; 8 px gap; subtitle 12/16 `--vxs-text-3` "vector · 3 open pull requests" (signed out: "Create, review with Vectorscope, and merge without leaving Vector"). Right, gap 6: busy text 12/16 `--vxs-text-3` with a 10 px orbit (e.g. "Loading pull requests…"); **New pull request** (primary pill 24 with a 12 px plus); **account pill** (24 tall, radius 12, 1 px `--vxs-hairline`, padding 0 4 0 3, gap 6: 18 px circle `--vxs-avatar` with "Y" 9/12 weight 600 white, "@you" 12/16 `--vxs-text-2`, a 20 px logout icon button "Sign out of GitHub"); close icon button 24 ("Close Vectorscope", Esc).

**Sends-to strip** (new; 28 tall, padding 0 20, 1 px `--vxs-hairline` below, 12/16 `--vxs-text-2`, gap 8): 12 px shield glyph `--vxs-text-3`; "Reviews send the diff to Vector Codium"; "·" `--vxs-text-3`; "Nothing is posted until you choose Comment, Request changes or Approve"; spacer; "Review model: Codium Auto" 12/16 `--vxs-text-3` + "Change" ghost 20 (opens Settings › Vector Local roles). Vector Local blocking GitHub adds a row "Off in Vector Local · GitHub · Why · Allow…".

**List column** (300 wide, fill `--vxs-main`, 1 px `--vxs-edge` right, padding 8):
- Filter field (text field), placeholder "Filter by title, number, author or branch", 16 px search glyph.
- "Your changes" row: 44 tall, radius 7, padding 5 10, gap 8: 16 px `vectorscope` glyph `--vxs-accent-text`; title 13/18 `--vxs-text`; line 2 12/16 `--vxs-text-2` "3 uncommitted files · +84 −12" (diff colours). Selected `--vxs-row-selected` (no side bar).
- Section label "Pull requests" (12/16 weight 600 `--vxs-text-3`, padding 12 10 4).
- PR rows: min 56, radius 7, padding 7 10, gap 8: 16 px pull glyph (`--vxs-ready` open; `--vxs-text-3` draft); title 13/18 2-line clamp; meta 11/14 `--vxs-text-3` "#2184 · you · 3h ago" (+ "Draft" tag 16 tall radius 8 1 px `--vxs-hairline`); right column: "+318 −32" 11/14 tabular, and under it the decision 11/14 `--vxs-text-2` with a 6 px dot (Approved `--vxs-ready`, Changes requested `--vxs-failed`, Review required `--vxs-needs`). Disabled while a review runs. Empty: "No open pull requests." 12/16 `--vxs-text-3`.
- "Automatic reviews" row: 44 tall, 6 px dot + title 13/18 + state 12/16 `--vxs-text-2` ("On: every pull request is reviewed").
- "Checks" section label with the branch mono 11/14 `--vxs-text-3` right-aligned; run rows 28: 6 px dot (amber in progress, green success, red failure), "CI · build" 12/16 `--vxs-text-row`, right "success" 11/14 `--vxs-text-3` or "Inspect" ghost 20. Expanded failure: "job › step · kind" 12/16 `--vxs-text` with a 12 px x-ring, log excerpt (radius 8, `--vxs-code`, mono 11/16, max 160 tall), tint button 24 "Copy fix prompt for the agent" → "Copied, paste it to the agent".

**Main pane** (scroll, content max 880, centred, padding 24 32 48):
- PR head: status pill "Open" (20 tall, radius 10, 1 px `--vxs-hairline-strong`, 12 px pull glyph `--vxs-ready`, 11/14 `--vxs-text`); "#2184" mono 12/16 `--vxs-text-3`; title 18/24 weight 600 `--vxs-text`; meta 12/16 `--vxs-text-2` "@you wants to merge into [main] from [scope-evidence] · +318 −32 · 6 files · updated 3h ago" (branch chips 18 tall, radius 5, fill `--vxs-accent-soft`, mono 11/14 `--vxs-accent-text`); "GitHub ↗" secondary 24 right.
- **AI review card**: radius 10, 1 px `--vxs-hairline-strong`, fill `rgba(255,255,255,0.015)`, margin-top 20.
  - Header 52, padding 0 12 0 14, gap 10: 24 px tile radius 7 fill `--vxs-gradient-brand` with the `vectorscope` glyph 14 px in `#0F0D19` (the screen's one gradient); "AI review" 13/18 weight 600; status 12/16 `--vxs-text-3` "Reviewed 9f8e7d6 · Codium Auto · Codium · 1m 52s"; right **Review again** (secondary 24 with refresh 12; tooltip "Reviews the files that changed since the last review; the rest keep their findings."). Running: **Stop review** (danger 24 with an 8 px square). Idle: **Review with Vector** (primary pill 24 with the lens glyph).
  - Estimate strip (over 50 files): 32 tall, fill `--vxs-accent-soft`, 12/16 `--vxs-text`, "Your uncommitted changes touch 64 files. Runs on your Vector Codium plan." + "Start review" primary pill 22 + "Cancel" ghost 22.
  - Running: 12/16 `--vxs-text-2` step with a 10 px orbit (e.g. "Double-checking 1 finding…") over a 3 px bar (radius 2, track `rgba(255,255,255,0.06)`, a 33% segment `--vxs-running` sliding 1.4 s).
  - Body grid `1fr 200px`, gap 20, padding 14: summary 13/20 `--vxs-text`; grounding chips (20 tall, radius 10, 1 px `--vxs-hairline`, 11/14 `--vxs-text-2`, gap 6): "Double-checked 1 · 0 dropped" (10 px check `--vxs-ready`), "2 CI checks read", "12 call sites read", "Repository rules applied" (12 px rule glyph); "Cost by pass" 12/16 weight 600 `--vxs-text-3` then mono 11/16 `--vxs-text-2` lines "Review · Codium Auto · Codium" and "Double-check · Codium Auto · Codium". Right: **Risk card** radius 8, 1 px `--vxs-hairline`, padding 10 12: "Risk" 11/14 `--vxs-text-3`; "Medium" 13/18 weight 500 `--vxs-text`; a 3-segment bar (4 tall, radius 2, gap 3; two `--vxs-needs`, one `--vxs-row-pressed`); counts 11/14 `--vxs-text-2` with 6 px dots "0 blocking · 1 concern · 1 nit".
  - Every count leaves dismissed findings out, as today (ai-review.ts `findingSections`, pull-requests.tsx `counts`); a dismissed finding stays visible, struck through, at the end of its section.
  - Findings toolbar (1 px `--vxs-hairline` above, padding 10 14): "Findings" 12/16 weight 600 `--vxs-text-3`; segmented "All 2 | Blocking 0 | Concerns 1 | Nits 1" (a 6 px dot before each severity; zero segment disabled).
  - Sections "Concerns 1", "Nits 1" (12/16 weight 600 `--vxs-text-2` with the dot), cards as section 4.7's finding card, 8 apart, padding 0 14 14; the dismissed nit sits last in "Nits".
  - "Not reviewed: package-lock.json (lockfile)" 12/16 `--vxs-text-3`.
  - Post bar: 1 px `--vxs-hairline` on top, padding 10 14, gap 8: **Comment** (primary pill 28 with comment 14), **Request changes** (secondary 28), **Approve** (secondary 28 with check 12; disabled with tooltip "Approve is off while a blocking finding stands."); right "Posting as @you" 12/16 `--vxs-text-3`. After posting: "Review posted with 2 comments on the lines they're about" 12/16 `--vxs-text` with a check-ring + "See it on GitHub ↗" ghost 24.
- Below the card, 24 apart, each with a 12/16 weight 600 `--vxs-text-3` label: "Description" (13/20 body, scroll past 320), "Files changed 6" (rows 28: folder `--vxs-text-3` + name `--vxs-text-2`, +/− right), "Conversation 2" (cards radius 10, 1 px `--vxs-hairline`, 20 px initial circle `rgba(255,255,255,0.08)` with a letter in `--vxs-text-2`), **Merge card** (radius 10, 1 px `--vxs-hairline`, padding 12 14: merge glyph 14, "Merge" 13/18 weight 500, note 12/16 `--vxs-text-2` "Merges only the commits shown here. If anything is pushed first, GitHub refuses the merge.", segmented "Squash | Merge commit | Rebase", **Merge…** danger 28 → "Cancel" ghost + "Confirm squash merge" (fill `--vxs-failed`, label `#161519`, 28)).

Views: Pull request (default), Your changes running a review, Signed out (centred column max 520: 40 px tile radius 10 `--vxs-gradient-brand` with the lens; "Review pull requests with Vectorscope" 16/24 weight 600; body 13/20 `--vxs-text-2`; outline card "Connect GitHub" with the device-code flow; second outline card "Review your uncommitted changes" + secondary 28 "Review my changes").

### 7.2 Settings (full window, own nav)

Settings keeps today's full-window takeover and page set; it takes the Signature finish.

- **Nav** (264 wide, the sidebar material and right edge line): chrome row 44 (traffic lights; "← Back" ghost 28 at x 78, tooltip "Back to Vector Esc"); identity row 44, padding 0 18: 24 px `--vxs-avatar` circle "Y", "You" 13/18 weight 500 `--vxs-text`, "Settings" 11/14 `--vxs-text-3` under it; search field (text field, margin 8 8 12) "Search settings"; groups with 12/16 weight 600 `--vxs-text-3` labels (padding 12 18 4): **Personal** (Account, General, Memory, Vector Local, Usage & streak, Spend limits), **Agents & environment** (Agents, Providers & keys, Default models, Environment & servers), **Workspace** (Repository trust, Keyboard shortcuts, Notifications, Accessibility, **Appearance** (new: Frame, Density, sidebar when hidden, "Show open sessions as tabs", from SIG), **Browser** (new, 6.E)), **More** (Updates & about). Items are SIG verb rows: 28 tall, pill inset 8, radius 7, 16 px icon at x 18, label 13/18 at x 42 `--vxs-text-row`; selected `--vxs-row-selected` with text `--vxs-text`. Footer 40, 1 px `--vxs-hairline` on top: "Vector 1.99.113" and "Desktop" 11/14 `--vxs-text-3`.
- **Content** (fill `--vxs-main`, scroll): column max 720, centred, padding 40 32 64. Page title 20/28 weight 600 `--vxs-text`; subtitle 13/20 `--vxs-text-2`, margin-top 4, max 640; 24 below the header.
- **Section**: title 13/18 weight 600 `--vxs-text`; description 12/16 `--vxs-text-2`; head padding 16 0 10; body starts with a 1 px `--vxs-hairline`; 16 between sections. No card boxes.
- **Row**: min 56, padding 12 0, 1 px `--vxs-hairline` below, grid `1fr auto`, gap 16. Title 13/18 weight 500 `--vxs-text`; description 12/16 `--vxs-text-2`. Controls: switch (2.5), inline select (blend chip, value 12/16 weight 500 `--vxs-text` + chevron; min-width 140), buttons 28 (secondary, ghost, danger), slider (track 4 tall `rgba(255,255,255,0.12)`, radius 2, filled part `--vxs-accent`, thumb 14 `#F4F3F7`; value 11/14 tabular in a 48 column).
- **Boxed lists** (Providers, Models, Servers, Shortcuts): radius 10, 1 px `--vxs-hairline`, rows 48 tall padding 0 14, hairlines between; tags 18 tall radius 9 1 px `--vxs-hairline` 11/14 `--vxs-text-3`. Provider rows use a 16 px `generic-provider` glyph in mockups (no brand marks) and neutral names ("Your API key", "Custom provider").
- **Tiles** (Account, Usage): grid `repeat(auto-fit, minmax(160px, 1fr))`, gap 8; tile radius 8, 1 px `--vxs-hairline`, padding 10 12; label 11/14 `--vxs-text-3`; value 13/18 tabular `--vxs-text`. Meter 4 tall radius 2, track `rgba(255,255,255,0.08)`, fill `--vxs-accent` (amber low, red empty).

Settings mockup pages:
- **General** (default view): sections and rows exactly as today: "While Vector works" (Follow-up behavior: Steer ⌄; Stop button: "Stop the main turn" ⌄), "Crash diagnostics" (Share crash diagnostics: off), "Usage counts" (Share usage counts: on), "Local data" (Clear application cache · secondary with trash 12; Restore default settings · danger with reset 12), "Verified completion" (Automatic model routing: off; LLM-as-a-judge: on; Tasks the judge checks: Large tasks ⌄), "Terminal" (Terminal Shell: Auto (Default) ⌄). Subtitle: "Manage what Vector does while it works, diagnostics, verification defaults, and the terminal shell. Memory has a page of its own."
- **Account**: profile row (padding 16 0, hairline below: 48 px `--vxs-avatar` circle "Y" 20/24 weight 500; "You" 15/20 weight 500; 12/16 `--vxs-text-2` "Signed in to Vector"; "Sign out" secondary 28). Section "Vector Codium" ("Coding models included in your Vector Codium plan. Usage shows as a share of this month."): tiles Plan "Max", This month "64% of this month's usage left" + meter, Renews "Dec 1"; buttons View usage (secondary), Change plan (secondary), Manage billing and invoices (ghost), Refresh (ghost). Section "Delete account": ghost "Delete account…" in `--vxs-diff-del`.
- **Usage & streaks**: Codium block tiles (Plan, Renews, This month "36% used · 64% left", Today "12% · resets 4:00 PM"), checkbox "Notify me when 80% of this month's usage is used" with note "Vector never shows Codium tokens or dollars"; metrics strip with today's eight cells in today's order (settings-v2/usage.tsx; radius 10, 1 px `--vxs-hairline`, grid of 4 x 2: value 17/22 weight 500, label 11/14 `--vxs-text-3`): Lifetime tokens "Codium", Completed chats "128", Conversations "41", Current streak "5 days", Longest streak "12 days", Recorded cost "Codium", Average time per run "3m 10s", Average own tokens per chat "Codium" (the token and cost cells show "Codium" as their value for a Codium Max user; an own-key user sees the numbers); streak card and 7-day dots (7 px circles, `--vxs-accent` active, `--vxs-hairline-strong` inactive); "Model activity" heatmap (7 rows, 11 px squares radius 2, empty `rgba(255,255,255,0.05)`, 4 steps of `--vxs-accent` at 30/50/75/100%).
- **Appearance** (new): Frame (segmented Flush | Inset card), Density (Compact | Default | Comfortable), "When the sidebar is hidden" (Hide completely ⌄), "Show open sessions as tabs" (switch off), "Translucent sidebar" (switch on).
- **Browser** (new): section 6.E, exactly.
- **Providers & keys** (today's providers page, settings-v2/providers.tsx): title "Providers", subtitle "Connect the models Vector can use." (today's subtitle is a placeholder line). Section "Connected providers", boxed list rows 48 with a 16 px `generic-provider` glyph: "Vector Codium" (tag "Codium"; 12/16 `--vxs-text-2` "Included in Codium Max"; no Disconnect), "Your API key" (tag "API key"; "Disconnect" ghost 24), "Local model server" (tag "Environment"; "Connected from your environment variables"). Section "Popular providers": three rows whose names are drawn as skeleton bars (8 tall, radius 4, `rgba(255,255,255,0.08)`, widths 96 / 120 / 84; no real provider names), each with "Connect" secondary 24; then "Show more providers" ghost 28. Section "Custom provider" (tag "Custom"): "Add a provider by its base URL." (today's sentence names another company's API; the mockup drops the name) + "Connect" secondary 28.
- **Agents** (today's settings-v2/subagents.tsx, Signature finish): title "Subagents and subagent specialists", subtitle "Vector's agent can hand independent parts of a task to other agents and keep working. There are two kinds, and you will see both in the chat and in Background tasks." Sections:
  - "Subagents": rows "General subagents" (switch on) and "Subagent specialists" (switch on), today's descriptions, 2-line clamp.
  - "Subagent specialists" ("Named agents with one focus each and the permissions to match. To ask for one yourself, type @ and its name in the composer."): rows 48 with the 14 px role glyph in `--vxs-icon` (section 4.7; no coloured avatars), name 13/18 + summary 12/16 `--vxs-text-2`, a "read-only" tag on Explore and Review, and a switch: Explore, Review, Test, Debug, Security, Performance.
  - "Limits": rows "At once" (select "8 ⌄"), "Per request" (select "12 ⌄"), "Spend ceiling" (value "Codium" on a Codium plan).
  - "Workflows": "Workflows" (switch on; "Let the agent run workflows, and let you start saved ones with /workflow. Off removes the workflow tool."), "Before a run" (today's description "Whether a plan within these limits waits for your approval."; select "Wait for my approval ⌄").

### 7.3 Tasks and Agent Dashboard

- **Tasks pane**: section 4.9.
- **Agent Dashboard** (More › Agent Dashboard; stage route). Header 44: "Agent Dashboard" 13/18 weight 500 + 12/16 `--vxs-text-3` "Every workspace, agent, and review in one place"; right 12/16 `--vxs-text-2` "3 running · 1 needs you · 5 done" (numbers `--vxs-text`). Controls row (padding 16 24 8, gap 8): segmented "Board | List"; search field 28 (max 420) "Search agents, tasks, models, or activity"; filter chips (blend chip with chevron): Status, Team, Runtime, Pull request; "Clear" ghost 24. Summary 12/16 `--vxs-text-3` "8 agents · 23 files touched · 1 team · 1 file conflict" ("1 file conflict" `--vxs-text` with an x-ring). Conflict banner: radius 10, 1 px `rgba(238,131,136,0.35)`, fill `rgba(238,131,136,0.06)`, padding 10 14: "Two agents are editing the same file" 13/18 weight 500, mono 12/16 `--vxs-text-2` "packages/app/src/components/menu.tsx · Swarm worker 2, Recheck keyboard focus", 12/16 `--vxs-text-2` "Review one workspace before merging the other." Board: 3 columns (Running, Needs you, Done), gap 12, padding 0 24 24; column radius 10, fill `rgba(255,255,255,0.02)`, 1 px `--vxs-hairline`, padding 8; head 28 "Running" 12/16 weight 600 `--vxs-text-2` + count 11/14 `--vxs-text-3`. Cards radius 10, fill `--vxs-card`, padding 12, 8 apart, hover fill `rgba(255,255,255,0.05)`: row 1: 14 px role glyph `--vxs-icon` (no coloured tiles, no two-letter tiles), runtime 11/14 `--vxs-text-3`, role tag (16 tall radius 8 1 px `--vxs-hairline`, 10/14 `--vxs-text-2` "worker"), elapsed 11/14 right; title 13/18 weight 500 (2 lines); status glyph + activity 12/16 `--vxs-text-2` ("Editing menu.tsx"); while running a 3 px bar (radius 2, track `rgba(255,255,255,0.06)`, fill `--vxs-running`); footer (1 px `--vxs-hairline` above, padding-top 8) 11/14 `--vxs-text-3` "3 files changed · Codium" … "Codium Auto"; optional "Pull request ready" with a 6 px `--vxs-ready` dot. Empty column: dashed 1 px `--vxs-hairline-strong` box radius 8, "Nothing here" 12/16 `--vxs-text-3`.

### 7.4 Search palette (⌘K; ⌘P scoped to files)

Over the stage, centred, top 96: menu recipe, width `min(100vw − 32px, 640px)`, max 480 tall, padding 0. Search field 44 tall, padding 0 16, 14/22 `--vxs-text`, no icon (today's), placeholder "Search files, commands, and sessions", 1 px `--vxs-hairline` below. List padding 4 4 8. Sticky section labels 12/16 weight 600 `--vxs-text-3`, padding 8 10 4, fill `--vxs-menu`: "Commands", "Files", "Sessions". Rows 32 tall, radius 6, padding 0 10, gap 10, 13/18: command title `--vxs-text` + description 12/16 `--vxs-text-2` + right key chip (18 tall, padding 0 5, radius 4, 1 px `--vxs-hairline-strong`, 11/14 `--vxs-text-2`); file: 16 px file icon + folder 12/16 `--vxs-text-2` + name `--vxs-text`; session: status glyph slot + title `--vxs-text` + "vector" 12/16 `--vxs-text-2` + time 11/14 `--vxs-text-2` right (archived rows 70%). Secondary text is `--vxs-text-2` because every row can be the active row (section 2.5). Active row `--vxs-row-selected`. Empty query shows: New task ⇧⌘S, New workspace ⇧⌘W, Previous session ⌥↑, Next session ⌥↓, Toggle terminal ⌃\`, Toggle review ⇧⌘R, then recent files. Empty: "No results found" 12/16 `--vxs-text-3`, 48 tall. Scrim `rgba(0,0,0,0.32)`.

### 7.5 Connections: MCP and Plugins (dialogs)

**Dialog recipe**: scrim `rgba(0,0,0,0.32)`; panel centred, radius 12, fill `--vxs-main`, 1 px `--vxs-raised-border`, `--vxs-menu-shadow`, max-height 80vh; header padding 16 16 12: title 15/20 weight 600 `--vxs-text`, description 12/16 `--vxs-text-2`, close icon button 24 top-right; body padding 0 16 16, scroll; footer (when any) 1 px `--vxs-hairline` on top, padding 12 16, buttons right.

**MCP** (560 wide; More › MCP; needs an open repository, otherwise the toast "Open a repository first / MCP servers are scoped to a repository so their tools cannot access unrelated files."): title "MCPs", description "1 of 3 connected".
- "Connect an MCP server" row: 36 tall, radius 8, 1 px `--vxs-hairline`, padding 0 10, 13/18 `--vxs-text`, chevron that rotates; open: two forms side by side (gap 12), each an outline card radius 10 padding 12: "Local MCP command" (Name; Command mono; primary pill 28 "Add local server") and "Remote MCP URL" (Name; URL mono; "Bearer token environment variable, optional"; primary pill 28 "Add remote server").
- "Configured servers" (13/18 weight 600) + 12/16 `--vxs-text-2` "Turn a server on or off. If a server can't connect, the reason appears below its name."; boxed list radius 10 with a search field row on top; rows 48: name 13/18 `--vxs-text`, under it a 6 px dot + state 11/14 `--vxs-text-2` (connected `--vxs-ready`, failed `--vxs-failed`, needs auth / registration `--vxs-needs`, disabled `--vxs-text-3`); error 11/14 `--vxs-text-3` (2 lines, click to expand); right "Remove" ghost 24 (→ "Remove server?" danger 24) and a switch. Mockup rows: "filesystem" connected (on), "docs" needs auth (on), "tickets" disabled (off). Empty: "No MCPs configured".

**Plugins** (760 wide): title "Plugins", description "2 connected · 31 available. One-click integrations that make Vector a better IDE."; category labels 12/16 weight 600 `--vxs-text-3` (sentence case, generic names only: "Issue tracking", "Docs and knowledge", "Monitoring", "Design"); two-column grid, gap 8; cards radius 10, 1 px `--vxs-hairline` (hover `--vxs-hairline-strong`), fill `rgba(255,255,255,0.015)`, padding 12; a 28 px neutral glyph tile (radius 7, fill `rgba(255,255,255,0.05)`, 14 px category glyph `--vxs-icon`; no brand marks, no letters); name 13/18 weight 500 (generic in mockups: "Issue tracker", "Error monitor", "Docs search", "Design files"); optional "Community" tag; blurb 12/16 `--vxs-text-2` 2 lines; right action by state: "Connect" secondary 24 / "Soon" tag (cards at 60%) / switch + "Remove" ghost 24 / "Authorize" tint 24 / "Fix token…" secondary 24; status line (indent 40) 6 px dot + 11/14 `--vxs-text-2`. Footer note 11/14 `--vxs-text-3`: "Plugins run as MCP servers scoped to this repository. Tokens stay in Vector's encrypted credential vault."

### 7.6 Automations (stage route)

Opened by the Automations verb. Header 44: "Automations" 13/18 weight 500 + "2 scheduled" 12/16 `--vxs-text-3`. Content column max 720, padding 32 32 48:
- Title 20/28 weight 600 "Work Vector repeats without you"; intro 13/20 `--vxs-text-2`; three feature tiles (section 7.2 tile recipe, 3 columns): "Across repositories", "New or existing sessions", "While you are away"; missed-run note 12/16 `--vxs-text-3`; **New automation** primary pill 28.
- Form (outline card radius 12, padding 16): field labels 12/16 weight 500 `--vxs-text-2` (sentence case, no uppercase): "What should Vector do, every time?" (textarea min 80, text field recipe), "Name (optional)" (placeholder "Morning repo brief"), "Where it runs" (rows 36 with a 14 px checkbox radius 4: checked fill `--vxs-accent-strong` with a white 10 px check; name 13/18 + "12 sessions" 11/14 `--vxs-text-3`; a selected row adds the select "Start a new session each run ⌄"), "Repeat" (segmented Once | Every day | Weekdays | Weekly), "Time" (text field 28 "8:00 AM"). Footer: summary 12/16 `--vxs-text-3` "Weekdays at 8:00 AM · first run tomorrow", "Cancel" ghost 28, "Create automation" primary pill 28.
- "Your automations" label; rows (outline card radius 10, padding 12 14, 8 apart): title 13/18 weight 500 + "Paused" tag; meta 12/16 `--vxs-text-3` "Every weekday at 8:00 · next in 14h · 2 repositories"; hover shows "Pause" / "Resume" and "Delete" ghost 24; prompt 12/16 `--vxs-text-2` 2 lines; per-target lines 11/14 `--vxs-text-3` "vector · new session each run · completed" with a status glyph (check-ring / x-ring / orbit / dash-ring). Empty: dashed box "Nothing scheduled yet. Create one above, or start from a suggestion below."
- "Start from a suggestion" rows 44: 12 px dash-ring `--vxs-text-3`, title 13/18 + schedule 12/16 `--vxs-text-3`, description 12/16 `--vxs-text-2`: "Morning repo brief · Weekdays at 8:00 AM", "Dependency check · Mondays at 9:00 AM", "Weekly review · Fridays at 4:00 PM".

### 7.7 New workspace launcher (dialog; today's "Launch parallel work")

Opened by the host `+` / project hover `+` › New workspace (today's "New workspace" button) or ⇧⌘W. Dialog recipe (7.5), 560 wide, title "New workspace", description "Isolated agents and automatic swarms" (today's line).
- Mode cards, two side by side, gap 8, each an outline card radius 10, padding 12, 1 px `--vxs-hairline` (selected: `--vxs-row-selected` fill and 1 px `--vxs-hairline-strong`): "New agent chat" 13/18 weight 500 + "Same Vector experience, isolated files." 12/16 `--vxs-text-2`; "Automatic swarm" + "One objective. Vector plans and coordinates the work."
- Fields (text field recipe; labels 12/16 weight 500 `--vxs-text-2`, sentence case): "Chat name" (agent chat) or "Swarm name (optional)"; a textarea, min 96, placeholder "What should this agent build, fix, or investigate?" (swarm: "Describe the outcome. Vector will decompose, assign, validate, and integrate the work.").
- Row of blend chips: model ("Codium Auto ⌄", `generic-provider` glyph); for a swarm, segmented "Economy | Balanced | Quality" and "Concurrent workers" with a select "4 ⌄".
- No provider: an outline card "No AI provider connected yet" + "Connect a provider" ghost 24.
- Footer: "Cancel" ghost 28, primary pill 28 "Create chat with agent" ("Launch automatic swarm"; pending "Creating agent chat…" / "Launching swarm…").

### 7.8 Coordinated runs drawer (More › Coordinated runs)

Today's right-hand drawer, in the Signature finish. Scrim `rgba(0,0,0,0.32)`; drawer from the right, width `min(920px, 94vw)`, full height, fill `--vxs-main`, 1 px `--vxs-edge` on the left, shadow `-28px 0 90px rgba(0,0,0,0.48)`.
- Header 52, padding 0 12 0 20, 1 px `--vxs-hairline` below: "Multi-agent orchestration" 15/20 weight 600; right "New coordinated run" (accent pill 28, today's purple) and close (icon button 24, "Close orchestration").
- Body grid `250px 1fr`. Left list (padding 8, 1 px `--vxs-hairline` right): section labels 12/16 weight 600 `--vxs-text-3`, sentence case (today's are uppercase micro-labels): "Agent workspaces", then "Coordinated runs". Run rows: radius 7, padding 8 10: 6 px dot (running `--vxs-running` breathing; needs review `--vxs-needs`; failed `--vxs-failed`; done `--vxs-ready`), name 12/16 weight 500 `--vxs-text`, progress 11/14 tabular `--vxs-text-3` right ("62%"), current step 11/14 `--vxs-text-2` under it. Selected `--vxs-row-selected`. Workspace rows reveal "Review & merge" (secondary 24) on hover. Empty: "No coordinated runs yet." / "Start one objective and Vector will assign the work." 12/16 `--vxs-text-3`, centred.
- Right detail (padding 20): run name 15/20 weight 600, status word with its glyph; task cards (outline card radius 10, padding 10 12, 6 apart): 6 px dot + title 12/16 weight 500 + role tag (16 tall, radius 8, 1 px `--vxs-hairline`, 10/14 `--vxs-text-2`, sentence case), last action 12/16 `--vxs-text-2`, "Open workspace →" 12/16 `--vxs-accent-text`. Footer (1 px `--vxs-hairline` above, padding-top 12, gap 8): "Stop run" (danger 28; "Stopping…"), "Resume" (secondary 28, after a failure), spacer, "Discard" (ghost 28 → "Confirm discard" danger), "Merge result" (primary pill 28 → "Confirm merge"). Today's green merge button becomes the primary pill. Empty detail: "Select a run to inspect its agents, dependencies, and merge result." 12/16 `--vxs-text-3`, centred.

### 7.9 "Run a saved workflow" dialog (/workflow, or the Search palette command "Run a saved workflow")

Dialog recipe (7.5), 560 wide, title "Run a saved workflow", description "A workflow runs many subagents in stages. Check its plan and ceilings, then run it." (today's strings, workflow-dialog.tsx).
- List view: rows (radius 7, padding 8 12, gap 2, hover `--vxs-row-hover`): title 13/18 weight 500 `--vxs-text`, "{name} · this repository" / "· your config" 12/16 `--vxs-text-2`, description 12/16 `--vxs-text-2`; a row with problems is at 60% with its issues 12/16 `--vxs-failed`. Loading "Loading saved workflows…"; empty "No saved workflows. Add one as workflows/<name>.json in your Vector config folder, or in a trusted repository's .vector folder." 12/16 `--vxs-text-3`.
- Form view: title + name; one text field per input ("{name} (required)"); after "Check plan", the plan: ceilings line 12/16 `--vxs-text-2` and one line per stage (12/16 `--vxs-text`, numbered); warnings with a 12 px diamond `--vxs-needs`. Footer: "Back" ghost 28, primary pill 28 "Check plan" → "Run" ("Checking…", "Starting…"; "Ask Vector to run it" while Vector is working).
- Sent state: "Vector is working" / "The request to run this workflow is in the composer. Send it, and the agent runs it." or "Its stages show in Background tasks. Vector tells you when it ends." + "Show tasks" secondary 28.
- Mockup: list with "Release checklist · release · this repository" ("Bumps versions, runs the packaging dry run, drafts the notes.") and "Dependency sweep · deps · your config"; form view for Release checklist with the input "version (required)" = "1.99.114" and a checked plan of 3 stages.

---

## 8. Artboard plan

### 8.1 Files and canvas

New files go in `scratchpad/vector-glass-canvas/project/` beside Main and Sidebar, in the same `.dc.html` format (`<x-dc>`, `<helmet>`, `sc-if`, `sc-for`, a `<script type="text/x-dc" data-dc-script data-props='…'>` with `class Component extends DCLogic` and `renderVals()`; the `./support.js` script tag as in Main). Each file copies section 2.1's frame, wallpaper and helpers and section 3's sidebar.

Add to `canvas.json` `boards` (and `order` in this sequence), keeping Main and Sidebar where they are:

| File | x | y | w | h | Title | Interactive |
|---|---|---|---|---|---|---|
| Chat.dc.html | 0 | 1200 | 1440 | 960 | "Blend: chat (click around)" | yes |
| Changes.dc.html | 1520 | 1200 | 1600 | 1000 | "Blend: Changes (today's design)" | yes |
| Browser-A.dc.html | 0 | 2400 | 1600 | 1000 | "Browser A: Beside" | yes |
| Browser-B.dc.html | 1680 | 2400 | 1600 | 1000 | "Browser B: Run view" | yes |
| Browser-C.dc.html | 3360 | 2400 | 1600 | 1000 | "Browser C: Inspect" | yes |
| Browser-D.dc.html | 5040 | 2400 | 1600 | 1000 | "Browser D: In the chat" | yes |
| Vectorscope.dc.html | 0 | 3600 | 1600 | 1000 | "Blend: Vectorscope" | yes |
| Settings.dc.html | 1680 | 3600 | 1440 | 960 | "Blend: Settings" | yes |
| Everyday.dc.html | 3200 | 3600 | 1600 | 1000 | "Blend: Tasks, Search, MCP, Plugins, Automations, Dashboard, New workspace, Coordinated runs, Workflows" | yes |

Notes to add: a `title1` note at (0, 1060) "The blend: Signature sidebar and finish, Vector's own controls"; a purple `howto` note at (-480, 1200), w 400: "Chat: switch views in Tweaks (session, running, permission, new), type in the composer, open Mode, Effort and Speed, press Tasks, Changes or Terminal. Logos are gone from the sidebar; the account row is today's." A note at (-480, 2400): "Two browser concepts. A, B and C are one panel browser in three modes: A is the default, B is A expanded, C is A in Inspect. D is a different shape: live page cards in the chat. Tweaks switch each board between empty, idle, Vector driving, you in control, and waiting for you."

Existing canvas items to fix in the same pass:
- The existing `title` note (canvas.json, at (0, −300)) names two other products in its text. Replace it with "Vector Signature: one calm sidebar".
- Sidebar.dc.html: refresh it per section 3.1's last table row (or retitle it as superseded).

### 8.2 Shared sidebar content (every board with the sidebar)

As Main's sidebar sample (SIG 9.1), with section 3 applied:
1. Chrome: traffic lights · toggle · Back · Forward (disabled) · Agent | Editor (Agent).
2. Verbs: New session · Search · Automations `2:00` · Vectorscope `3` (open pull requests in the current project, section 7.1) · More.
3. Live 4: ◆ Fix Codium P8 CI [Review] · ◌ Recheck keyboard focus across menu reads `12m` · ◌ Vectorscope review · PR #2184 (lens) `1m` · ◌ Reproduce Windows packaging limit (cloud) `4m`. Top edge: the gradient only when nothing else on screen draws one. It is solid accent 40% on the empty state, whenever a side panel with the gradient line is open, on the Vectorscope route (its review or signed-out tile), and on any other route or dialog that draws its own gradient.
4. Pinned: Release 1.99.114 checklist `1d`.
5. This Mac: **vector** (no tile; meta `4`) with Recheck keyboard focus… (running, children Swarm worker 2 `+142 −18` and Review: Hands Windows fixes `12m`), Warn on review model evidence (ready, `+318 −32`), Give the packaging dry-run a Windows-sized limit (failed, "Checks failed · 3"), Shorten Windows installer progress copy (unread `3h`), Show 7 more; **vector-codium** `codium` (◆ 1) with Fix Codium P8 CI (needs you, "Wants to run pnpm install --frozen-lockfile"); **vector-hands** `hands` (collapsed, `5`); **vectordev.ai** (collapsed, `2`; expanded on the browser boards, see 8.5).
6. Cloud computer: Morning queue `1` with one queued job, `6:00`. Main's sample title for it names a third-party framework; use "Upgrade the site's framework on vectordev.ai" instead. Then vector: Reproduce Windows packaging limit (running `4m`).
7. Footer: today's account row: (Y) You · Codium Max · Help · Settings.

The selected row differs per board (stated below).

### 8.3 Chat.dc.html

- **Props** (`data-props`): `view` enum session | running | permission | new (default session); `sidebar` enum expanded | hidden | rail (default expanded); `pickers` enum below | inside (default below); `attach` enum left | right (default left); `active` enum purple | neutral (default purple; open decision 8); `effort` boolean (default true: the model has effort levels); `founding` boolean (default false); `$preview` 1440 x 960.
- **Selected row**: Warn on review model evidence (all views except new; new has no selection).
- **Header row 1**: `session-branch` icon · "Warn on review model evidence" · "vector" (project name) | branch chip "scope-evidence ⌄" · status chip ("Ready" in session; "Agent working" in running and permission) · Tasks (badge: none in session; accent `1` in running) · Changes (badge `6`) · Terminal.
- **Header row 2**: usage pill "Codium" · context ring (38%) · "…".
- **Transcript (session view)**, in order:
  1. User block: "Warn in the Vectorscope review panel when a finding's model evidence is missing or older than the diff. Keep the panel layout as it is."
  2. Vector: "I'll find where Vectorscope builds findings, add an evidence check, then show a warning row in the panel."
  3. Tool row (context group): magnifier · **Explored** · "1 search, 2 reads" · chevron. Expanded children: "Searched `modelEvidence` in packages/app/src · 6 results"; "Read ai-review.ts"; "Read pull-requests.tsx".
  4. Tool error row: **Read** · "File not found: packages/app/src/vectorscope/findings.ts".
  5. Vector: "That path moved; findings are built in ai-review.ts."
  6. Edited files card: "Edited 2 files" `+125 −18` · Rewind · Review. Rows: `packages/app/src/features/pull-requests/` **ai-review.ts** `+84 −12` · Open diff ›; `packages/app/src/features/pull-requests/` **pull-requests.tsx** `+41 −6` · Open diff ›.
  7. Tool row: terminal · **Shell** · `pnpm --filter @vector/app typecheck` · "passed · 41s". Expanded: "$ pnpm --filter @vector/app typecheck" then "Done in 41s".
  8. Vector: "Findings now carry an evidence state: checked, missing or stale. The review card shows a note for missing and stale evidence. I asked Vectorscope to review the change."
  9. Child-session card: check-ring · "Vectorscope review" · "1 finding" · ›.
  10. Finding card: header "Vectorscope · ● Concern" · "correctness" · "Double-checked". Title "Stale evidence is labelled as checked". Location `packages/app/src/features/pull-requests/ai-review.ts:147` · "outside the changed lines". Body: "When the evidence timestamp is older than the head commit on this branch, the row still says 'Evidence checked'. Compare it with the head commit time before calling it current." Suggested change: `−      : "checked"` / `+      : verified.at < ctx.head.committedAt ? "stale" : "checked"`. Actions: Apply fix · Ask the agent · Fix in a new workspace · Dismiss.
  11. Edit row card: `ai-review.ts` `+9 −2` · Open diff ›.
  12. Vector: "Fixed: evidence older than the head commit now reads 'Evidence may be stale'. Ready for your review: 6 files, +318 −32."
  13. Notice: "Vectorscope re-checked · no open findings".
- **Running view**: transcript ends after item 9 with a running task card instead of the child-session card: orbit · "Vectorscope review" · "Specialist · Review · 2 agents" · `41s`; squares ● ● (running, done) as specialist circles; then a running tool row (orbit) **Shell** `pnpm --filter @vector/core test model-evidence`. Working line: "1m 12s · Codium · 1 running task · Double-checking 1 finding". Composer empty → Stop. The selected sidebar row's glyph becomes the orbit; Live shows 5 items (4 visible + "+1 more").
- **Permission view**: as running, plus the permission dock above the composer: "Permission required"; hint "Vector wants to run a command in vector."; block `pnpm --filter @vector/core test model-evidence`; Deny · Allow always · Allow once. The selected row shows the diamond and Live puts it first with a Review pill.
- **New view**: section 4.8, with the empty-state chips and recent projects listed there.
- **Composer**: paperclip in the left slot (right when `attach` is right); placeholder "Ask anything, / for commands, @ for context..."; where chips: the laptop glyph (tooltip "This Mac") then "vector ⌄"; how chips "Codium Auto ⌄, ● Manual ⌄, Balanced ⌄, ● Normal ⌄" (Balanced only when `effort`), Codium ring 64%. One row in every view and tweak (section 4.4). The default composer (656 wide) needs no step. The narrowest, with the Tasks pane docked and expanded (363), uses all four steps plus the board's fifth (open decision 11). With `pickers` inside, the how chips and the ring sit in the box and the where group is alone below.
- **Interactions** (state in the component): typing enables Send; "/" as the first character opens the "/" popover with the five rows in 4.5 (↑ ↓ ↵ Esc); "@" opens "@" with "Explore" (agent) then `ai-review.ts`, `pull-requests.tsx`, `model-evidence.ts`; Mode, Effort and Speed chips open their menus and set the value (Max shows the glow, Fast the glow, Deep research the Preview pill and the research placeholder and research chips); mic toggles the dictation pill (timer counts up); paperclip adds one image thumb "screenshot.png" (removable); Send appends the typed text as a user block and switches to running; Stop switches back to session; branch chip opens the branch popover (main, scope-evidence ✓, codium, hands; Create branch); "…" opens its menu; Tasks toggles the docked Tasks pane (section 4.9; content: the Vectorscope review task in Running, two finished tasks under "Finished 2 ›"); Changes toggles the side panel with Changes.dc.html's list view (same markup); Terminal toggles the terminal panel (tabs "Terminal 1" active and "▤ typecheck · exited 0"; body "~/vector  scope-evidence  $ pnpm --filter @vector/app typecheck" then "Done in 41s" then a prompt); hovering the usage pill and context ring shows their tooltips; sidebar interactions as Main.

### 8.4 Changes.dc.html

- **Props**: `view` enum list | expanded | reader | empty (default list); `mode` enum git | branch | turn (default git); `$preview` 1600 x 1000.
- **Layout**: window 1520 x 900; sidebar (selected: Warn on review model evidence); header as Chat's session view with **Changes active** (`review-active`, tint, badge `6`); chat column 600 showing Chat's transcript items 8-13 scrolled to the bottom with the composer (536 wide; its chips row is one row: laptop glyph, "vector ⌄" … "Codium Auto ⌄, ● Manual ⌄, Balanced ⌄, ● Normal ⌄, ◔ 64%". The full row needs 529 px, so no step applies; with the panel closed the composer is 720. The narrow state (chat 280, composer 216) uses all four steps and then scrolls the how group, open decision 11); resize handle; panel 655 with today's design (section 5). Live top edge solid accent 40%.
- **Tab strip**: Changes chip active with badge `6`; one file tab "ai-review.ts" (in reader view); panel close.
- **List content** (summary "6 files changed ⌄ +318 −32"):

| # | Directory | File | + | − | First hunk (snippet) | More |
|---|---|---|---|---|---|---|
| 1 | packages/app/src/features/pull-requests/ | ai-review.ts | 93 | 14 | `@@ -142,6 +142,12 @@ function toFinding(raw: RawFinding, ctx: ReviewContext): Finding {` / `   const verified = ctx.verify.get(raw.id)` / `-  const evidence = verified ? "checked" : "missing"` / `+  const evidence = !verified` / `+    ? "missing"` / `+    : verified.at < ctx.head.committedAt` / `+      ? "stale"` | ⋯ 3 more hunks |
| 2 | packages/app/src/features/pull-requests/ | pull-requests.tsx | 41 | 6 | `@@ -1611,3 +1611,7 @@ function FindingCard(props: { finding: Finding }) {` / `   <FindingHeader finding={props.finding} />` / `+  <Show when={props.finding.evidence !== "checked"}>` / `+    <EvidenceNote state={props.finding.evidence} />` / `+  </Show>` / `   <FindingBody finding={props.finding} />` | ⋯ 2 more hunks |
| 3 | packages/core/src/review/ | model-evidence.ts | 38 | 9 | `@@ -58,4 +58,8 @@ export function evidenceFor(model: ModelRef, now: Date) {` / `   const record = certificates.find((item) => item.model === model.id)` / `-  if (!record) return { status: "unvetted" }` / `+  if (!record) return { status: "unvetted", checkedAt: undefined }` / `+  if (record.expires < now) return { status: "expired", checkedAt: record.at }` | ⋯ 1 more hunk |
| 4 | packages/core/src/review/ | config.ts | 12 | 3 | `@@ -88,2 +88,4 @@ const FIELDS = {` / `   modelEvidence: field.enum(["off", "warn"]).default("off"),` / `+  // Older than the head commit counts as stale.` / `+  staleEvidence: field.enum(["warn", "off"]).default("warn"),` | ⋯ 1 more hunk |
| 5 | packages/app/src/i18n/ | en.ts | 6 | 0 | `@@ -1490,1 +1490,7 @@` / `   "review.finding.verified": "Double-checked",` / `+  "review.evidence.missing": "No evidence on record for this finding",` / `+  "review.evidence.stale": "Evidence may be stale",` | ⋯ 4 more lines |
| 6 | packages/core/test/review/ | model-evidence.test.ts (New file) | 128 | 0 | `@@ -0,0 +1,128 @@` / `+test("evidence older than the head commit is stale", () => {` / `+  const finding = toFinding(raw, context({ verifiedAt: "2026-11-01", head: "2026-11-08" }))` / `+  expect(finding.evidence).toBe("stale")` / `+})` | ⋯ 124 more lines |

  Row 2 is the last-opened row (violet wash, violet chevron). Row 1 carries a comment badge `1`. Footer: "Working tree vs HEAD, untracked files included" · Commit to main. Branch mode: "6 files changed on this branch" and "Compared with the merge base on main" (no Commit button). Turn mode: "1 file changed last turn" listing only ai-review.ts `+9 −2` and "Files the last turn edited".
- **Expanded view**: list with row 2 expanded (snippet as in the table), hover state on its snippet showing "Open diff →".
- **Reader view** (ai-review.ts, position "1/6", +93 −14): fold bar "141 unmodified lines", then:

| New # | Kind | Code |
|---|---|---|
| 142 | context | `  const verified = ctx.verify.get(raw.id)` |
| (143) | deleted | `  const evidence = verified ? "checked" : "missing"` |
| 143 | added | `  const evidence = !verified` |
| 144 | added | `    ? "missing"` |
| 145 | added | `    : verified.at < ctx.head.committedAt` |
| 146 | added | `      ? "stale"` |
| 147 | added | `      : "checked"` |
| 148 | context | `  return {` |
| 149 | context | `    id: raw.id,` |
| 150 | context | `    severity: raw.severity,` |
| 151 | added | `    evidence,` |
| 152 | added | `    evidenceAt: verified?.at,` |
| 153 | context | `    title: raw.title,` |

  then a fold bar "38 unmodified lines", then 192 context `export function summarize(findings: Finding[]) {`, deleted `  const checked = findings.filter((f) => f.verified).length`, 193 added `  const checked = findings.filter((f) => f.evidence === "checked").length`, 194 added `  const stale = findings.filter((f) => f.evidence === "stale").length`, 195 context `  return { checked, stale, total: findings.length }`. A comment card under line 145: "Compare with the head commit time, not the branch's first commit." · "line 145". "changed" words highlighted: `!verified`, `stale`. Below the card: "Next in Changes" → pull-requests.tsx `+41 −6`.
- **Empty view**: tab strip "Changes" without badge; "0 files changed ⌄" then the no-changes state (section 5.5); the header's Changes button without a badge.
- **Interactions**: click a row → expand/collapse its snippet; click a snippet or "Open diff →" → reader; Back / Esc → list; pager ‹ › moves through the 6 files (only ai-review.ts has full content; others show their snippet lines as the diff); More actions menu opens; hovering a diff row shows the violet "+"; clicking it opens the comment editor; the summary label opens the mode menu and switches `mode`; Commit to main opens the commit dialog in today's dialog look (section 5.4); the header Changes button closes the panel (chat column then fills the stage).

### 8.5 Browser boards (shared)

- Sidebar: vectordev.ai expanded with two sessions: "Check the Codium page at tablet width" (running on A, B and D; ready on C; meta `4m`) and "Stack the Codium plan cards on phones" (selected on C, ready, `+14 −6`). On A, B and D the first one is selected. Live adds the running one (5 items, 4 visible + "+1 more").
- Header on A, B and D: `session-branch` · "Check the Codium page at tablet width" · "vectordev.ai" | "main" · status (Ready / Agent working by state) · Tasks · Changes · Terminal. On C: "Stack the Codium plan cards on phones" · "vectordev.ai" | "main" · Ready · Tasks · Changes `1` · Terminal.
- **One story, three views**: A, B and D show the same session at the same moment by default, so the owner can compare the shapes side by side. The step list they share (A's idle state shows it finished):
  1 "Opened" localhost:4321/codium `0:02`; 2 "Resized to" 768 × 1024 `0:04`; 3 "Took a screenshot" `0:05`; 4 "Read the page" `0:06`; 5 "Clicked" "Max" `0:09`; 6 "Opened in a background tab" vectordev.ai/docs/browser `0:12`; 7 "Typing into" "Search docs" (running: `now`; finished: `0:15`).
  In the default driving state step 7 is running on the docs page, and the agent is typing "site permissions" into "Search docs".
- **Page content: localhost:4321/codium** (vectordev.ai dev build), drawn as a simple dark page so it reads as the user's own site, not a real third-party page: fill `#0F0E13`; top nav 48 tall: "Vector" wordmark 14/18 weight 600 `#ECEBEF` (Vector's own), links "Docs · Models · Codium · Download" 12/16 `#A9A7B0`; hero: "Vector Codium" 28/34 weight 600 (scaled with the viewport), subline 14/22 `#A9A7B0` "Coding models included in one plan."; four plan cards (radius 12, 1 px `rgba(255,255,255,0.08)`, fill `rgba(255,255,255,0.03)`, padding 16): names "Plus", "Pro", "Max", "Ultra" 16/22 weight 600, three skeleton lines (8 tall, radius 4, `rgba(255,255,255,0.08)`, widths 80/64/72%), button "Choose {name}" (28 tall, radius 7, fill `#ECEBEF`, label `#161519`). No prices.
- **Page content: https://vectordev.ai/docs/browser** (the public docs site; Vector's own): a dark docs page, fill `#121115`; left docs nav 200 wide (Getting started, Agents, Browser (selected), Vectorscope, Codium; 13/20 `#A9A7B0`, selected `#ECEBEF` with a 2 px `#9274EC` bar); a "Search docs" field at the top (28 tall, radius 7); article: H1 "Browser" 24/30 weight 600, paragraphs as skeleton lines, H2 "Site permissions" 16/24 weight 600.
- **Props** on every browser board: `state` enum empty | idle | driving | control | waiting (default driving on A, B and D; idle on C, where Vector has asked you to pick a card and waits for your reply).
- Composer chips are one row on every browser board (section 4.4; until 2026-11-11 the split boards drew two lines):
  - A's 536 px composer, with "vectordev.ai", applies step 1.
  - C's 496 px composer applies steps 1-3, plus step 4 when Mode is Full access with Balanced and Normal.
  - B's card shows the "how" group only, still one row.
  - D's full-width composer needs no step.
- Browser chrome on A, B and C follows 6.G (owner reference, 2026-11-11). Where 8.6-8.8 list toolbar contents, a bar row, the Browser chip or a "Waiting for your app" empty state, 6.G's two rows, its run-control placement and its new-tab card win.

### 8.6 Browser-A.dc.html

- **Extra props**: `steps` boolean (default true: drawer open); `tabs` boolean (default true: two tabs).
- **Panel (driving, the default)**: Browser chip active; toolbar with back, forward (disabled), reload, address "vectordev.ai/docs/browser" (green dot, `lock`, sharing chip "Shared"), camera, crosshair, expand, sidebar toggle, external, "⋯"; page tabs: "Codium · localhost:4321" (background, no orbit) and "Browser · vectordev.ai" (active, orbit): you switched to the tab Vector is using, so the bar, frame and cursor are all on the tab in view. Viewport: the docs page at 655 wide; cursor at the caret in "Search docs", target outline, the bar 'Vector is using this tab · Typing "site permissions" into Search docs'.
- **Steps drawer** (open): the shared 7 steps (section 8.5), step 7 running with the orbit and `--vxs-row-selected`.
- **Chat column** transcript: user "Check that the Codium page reads well at tablet width, then find what our docs say about site permissions."; Vector "I'll open the Codium page at 768 px, check the plan cards, then look up site permissions in the docs."; browser row "Browser · Opened localhost:4321/codium · Tablet 768 × 1024" with 3 thumbs (+2), result "5 steps"; Vector "The Max and Ultra cards wrap their buttons at 768 px. Checking the docs next."; running browser row (orbit) "Browser · Typing into Search docs · vectordev.ai/docs/browser" (1 thumb). Composer with one row of chips (section 8.5), Stop.
- **States**:
  - idle: no bar, no orbit; the Codium tab active showing the Codium page at 655 wide (cards in 2 x 2); steps drawer shows the finished list; the last transcript row reads "Browser · Typed into Search docs · 2 steps".
  - driving: above. Tweak `tabs` off: one tab only (the docs page), no tab row.
  - "Another tab" variant (shown when the Codium tab is clicked while driving): the Codium page with the bar "Vector is using another tab · Browser · vectordev.ai" + Show + Stop; no frame or cursor on it.
  - control: You-have-control bar on the docs tab, drawer row "You took over · screenshots paused".
  - waiting: the moment before step 6: the Codium tab only, waiting bar "Vector is waiting for you · Open vectordev.ai?" and the permission dock in the chat column: "Open **vectordev.ai** in Vector's browser" / "Allow always remembers this site. Local servers never ask." / Deny · Allow always · Allow once.
  - empty: no tabs, the empty state (section 6.A) in the viewport, address field empty.
- **Interactions**: Take over / Give back / Stop switch `state`; Review in the waiting bar focuses the dock; Allow once / Allow always open the docs tab in the background and return to driving; Deny returns to idle with a Vector line "I'll skip the docs."; clicking a step opens the filmstrip overlay (Esc closes); camera adds a thumb to the composer; crosshair enters pick mode on a frozen frame (outline + tag "input.docs-search", click → atom at the caret); clicking a tab switches it (the Codium tab shows the "another tab" bar while driving); "⋯" opens its menu; "⋯ › Browsing data…" opens the privacy popover; the sharing chip toggles Shared / Private.

### 8.7 Browser-B.dc.html

- **Extra props**: `card` enum chat | steps | minimized (default chat).
- **Stage**: toolbar (address "vectordev.ai/docs/browser" with `lock` and the sharing chip; run pill by state; crosshair; collapse; external; "⋯"; close ×); page: the docs page at 1252 wide, the agent typing "site permissions" into "Search docs" (cursor at the caret, target outline, tag "Typing"); step pill 'Step 7 · Typing "site permissions" into Search docs' (the same step 7 as A and D).
- **Floating card** (chat tab): header "Chat | Steps" · usage pill "Codium" · ring · "…" · minimize. Compact transcript: A's transcript from Vector "The Max and Ultra cards wrap their buttons at 768 px. Checking the docs next." on, which ends with the running browser row (orbit) "Browser · Typing into Search docs". Composer: placeholder "Ask anything, / for commands, @ for context...", chips "Codium Auto ⌄, ● Manual ⌄, ● Normal ⌄", Stop (agent working).
- **Steps tab**: the shared 7 steps (section 8.5) at 44 px rows with 56 x 36 thumbs, step 7 running.
- **States**: driving (run pill "Vector is driving"); control (run pill "You have control · no screenshots" with Give back as a primary pill, step pill "Paused · you have control"); waiting (run pill "Waiting for you", the card un-minimized with the interaction dock "Click and type on **vectordev.ai**" / Deny · Allow always · Allow once); idle (no run pill, no step pill, no cursor); empty (section 6.B's empty state).
- **Interactions**: Take over / Give back / Stop; Chat / Steps tabs; minimize ↔ pill; dragging the card header snaps it to the nearest corner; the model chip opens its sheet inside the card (section 6.B); Tasks docks its pane and narrows the page; Terminal opens under the page; Changes and the collapse button show a note "Back to the side panel (Browser A)"; close × shows a note "Browser closed; the chat fills the stage".

### 8.8 Browser-C.dc.html

- **Extra props**: `device` enum phone | tablet | desktop | fit (default phone); `drawer` enum console | network | server | closed (default console); `pick` boolean (default true).
- **Panel**: Browser chip; toolbar (server pill "localhost:4321 · Running", path "/codium", sharing chip, Browse | Inspect with Inspect active, crosshair pressed when `pick`, camera, external, "⋯"); viewport bar (Phone 375 active, "375 × 812", rotate, scheme, "65%"; "62%" in the driving state, section 6.C geometry); canvas with the phone frame showing the Codium page at 375 (cards stacked; the Pro card's name wrapping under its badge).
- **Pick (on)**: frozen frame; card 2 outlined with tag "div.plan-card · 343 × 212" and pin "1"; the note popover beside it with the note "The name wraps under the badge at 375 px"; palette "Element | Area" + Done.
- **Drawer (console)**, rows:
  1. error `Uncaught TypeError: Cannot read properties of undefined (reading 'label')` · `plan-card.ts:41`
  2. error `Failed to load resource: the server responded with a status of 404 (Not Found) /og/codium.png` · `codium:1`
  3. warning `Image without width and height shifts layout: hero.webp` · `codium:88`
  4. log `[vector] preview attached · localhost:4321`
  Network: `GET /codium 200 document 18 KB 42 ms`; `GET /_assets/codium.css 200 stylesheet 9 KB 11 ms`; `GET /og/codium.png 404 image — 6 ms` (tinted); `GET /api/plans 200 fetch 2 KB 23 ms`. Server log: "ready in 412 ms · http://localhost:4321"; "watching for file changes"; "12:41:03 update src/components/plan-card.ts"; "12:41:04 page reload /codium".
- **Chat column** (560): user "Make the Codium plan cards stack cleanly on a phone. The plan name wraps under its badge."; Vector "I'll open the Codium page at phone width and check the console first."; browser row "Browser · Opened localhost:4321/codium · Phone 375 × 812" (2 thumbs); Vector "The console shows a TypeError in plan-card.ts:41: the Ultra card has no label yet. Pick the card you mean, or I'll fix all four."; composer with the atom "① div.plan-card [thumb] ×" at the start, then typed text "keep the badge on one line" and Send enabled; chips on one row (section 8.5).
- **States**: idle (the default: no bar; Vector has asked and waits for your reply); driving (driving bar 'Vector is using this tab · Resizing to 375 × 812', frame round the device, zoom 62%; `pick` is forced off, since picking freezes the page); control; waiting (Vector follows "Docs" off localhost: waiting bar "Vector is waiting for you · Open vectordev.ai?" and the dock in the chat column); empty (section 6.C's empty state; the transcript ends after the first user message and Vector's "Start the site and I'll open it at phone width.").
- **Interactions**: device segments resize and rescale the frame (Tablet 768 × 1024 at fit, Desktop 1280 × 800 at fit, Fit fills the canvas); rotate swaps width and height; drawer tabs switch; "Send to chat" on a console row adds the "console · TypeError" atom to the composer; crosshair toggles pick; clicking a card in pick mode adds a numbered pin and atom; Browse | Inspect switches to Browser A's layout inside the panel (toolbar without the viewport bar; page full width).

### 8.9 Browser-D.dc.html

- **Extra props**: `live` enum card | pinned (default card: the live card is on screen; pinned: scrolled up so the pinned bar shows).
- **Layout**: window 1520 x 900; sidebar as 8.5; header as A's; transcript column 720 centred; no side panel; Live top edge gradient (nothing else on screen draws one).
- **Transcript**, in order: user "Check that the Codium page reads well at tablet width, then find what our docs say about site permissions."; Vector "I'll open the Codium page at 768 px, check the plan cards, then look up site permissions in the docs."; **settled card 1**: localhost tag + "localhost:4321/codium", the last frame (Codium page at tablet width, cropped to 240 tall), strip "5 steps · 0:09" with 3 thumbs and Open; Vector "The Max and Ultra cards wrap their buttons at 768 px. Checking the docs next."; **live card 2**: `lock` + "vectordev.ai/docs/browser", sharing chip "Shared", the docs page at 1280 x 800 drawn 720 x 450 with the cursor at the caret in "Search docs", the target outline and the tag "Typing", border `--vxs-drive-outline`; strip "Step 7 of 7 · Typing "site permissions" into Search docs", thumbs of its own steps 6 and 7, Take over, Stop. Working line above the composer "41s · Codium · Typing into Search docs"; composer with Stop, chips on one line.
- **States**: driving (above); control (card 2's strip "You took over · screenshots paused" with Give back, and the stage split with A's panel in its You-have-control state on the right, 600 | 655); waiting (card 2 absent; card 1 settled; the dock above the composer "Open **vectordev.ai** in Vector's browser" / "Allow always remembers this site. Local servers never ask." / Deny · Allow always · Allow once); idle (card 2 settled: "2 steps · 0:15", Open); empty (one card whose frame holds A's empty state).
- **Interactions**: Take over / Give back / Stop switch `state`; Open on either card docks the page into A's panel (the board shows A's layout with that page); a thumbnail opens the filmstrip; the camera adds a thumb to the composer; Pick freezes card 2's frame and picks on it (tag "input.docs-search", click → atom at the caret and pin "1" on the frame); the sharing chip toggles and Private shows the "Private page" frame; scrolling the transcript up (or `live` pinned) shows the pinned bar with Jump.

### 8.10 Vectorscope.dc.html

- **Props**: `view` enum pr | local | signedout (default pr); `$preview` 1600 x 1000.
- Sidebar: Vectorscope verb selected (pill); no session selected.
- PR view content: list (Your changes "3 uncommitted files · +84 −12"; PRs: #2184 "Warn on review model evidence" · you · 3h ago · +318 −32 · Review required (selected); #2179 "Recheck keyboard focus across menu reads" · you · 1d ago · +142 −18 · Approved; #2171 "Shorten Windows installer progress copy" · Draft · you · 2d ago · +12 −9; Automatic reviews "On: every pull request is reviewed"; Checks on `scope-evidence`: "CI · build" success, "CI · test" Inspect (failure, expanded with "test › model-evidence · assertion", a 3-line log, and "Copy fix prompt for the agent")). Main pane per 7.1 with the summary "Findings now carry an evidence state. One concern: stale evidence still reads as checked when the evidence predates the head commit. Two nits on naming." The Concern card is Chat's finding card; Nits: "`evidenceAt` duplicates `checkedAt`" (`packages/core/src/review/model-evidence.ts:61`, category "naming", no suggested change, Ask the agent · Fix in a new workspace · Dismiss) and a dismissed nit "Prefer `stale` over `old` in copy" (dashed, "Intended behaviour", Undo), last in its section. Counts leave the dismissed nit out: segments "All 2 | Blocking 0 | Concerns 1 | Nits 1", sections "Concerns 1" and "Nits 1", risk card "0 blocking · 1 concern · 1 nit"; after posting, "Review posted with 2 comments on the lines they're about". Live top edge solid accent 40% (the review tile is the screen's gradient).
- Local view: "Your changes" selected; review running: header button Stop review; step "Reading your changes…" with the sliding bar; checkout strip "Reviewing the uncommitted changes in your checkout".
- Signed-out view per 7.1.
- Interactions: list rows switch views; findings filter segments filter; Dismiss opens its menu; Apply fix → "Applying…" → "Fix applied"; Merge… → confirm pair.

### 8.11 Settings.dc.html

- **Props**: `page` enum general | account | usage | appearance | browser | providers | agents (default general); `$preview` 1440 x 960. Window 1360 x 860; Settings nav replaces the sidebar (section 7.2).
- Content per 7.2. Interactions: nav items switch `page`; switches toggle; selects open blend menus; search filters the nav and shows "No settings found" / "Try a feature name such as model, memory, update, or notifications." when empty.

### 8.12 Everyday.dc.html

- **Props**: `screen` enum tasks | search | mcp | plugins | automations | dashboard | launcher | runs | workflow (default tasks); `$preview` 1600 x 1000.
- tasks: Chat's session view with the Tasks pane docked (section 4.9), Tasks button active. Cards: Running "Vectorscope review" (Specialist · Review, 2 agents, phases "Review" (running, 1/2) and "Double-check" (pending)), Finished 2: "Recheck keyboard focus across menu reads" (Done), "Swarm worker 2" (Stopped). A floating-mode toggle in the pane header switches to the floating card.
- search: Chat's session view dimmed by the scrim with the palette open, query empty (commands + recent files: ai-review.ts, pull-requests.tsx, model-evidence.ts); typing "evid" shows Files (model-evidence.ts, model-evidence.test.ts) and Sessions (Warn on review model evidence · vector · 2h).
- mcp, plugins: Chat's session view under the scrim with the dialog (section 7.5).
- automations: the Automations route with the Automations verb selected; two automations ("Morning repo brief", "Weekly review" Paused), the form closed; "New automation" opens it.
- dashboard: More › Agent Dashboard route, Board view, cards: Running "Recheck keyboard focus across menu reads" (Editing menu.tsx, 3 files changed), "Swarm worker 2" (worker, Editing menu.tsx) with the conflict banner, "Reproduce Windows packaging limit" (Cloud computer); Needs you "Fix Codium P8 CI" (diamond, "Wants to run pnpm install --frozen-lockfile"); Done "Review: Hands Windows fixes" (Pull request ready), "Warn on review model evidence", "Shorten Windows installer progress copy", two more.
- launcher: Chat's session view under the scrim with the New workspace dialog (section 7.7), "Automatic swarm" selected, the outcome "Make every menu reachable from the keyboard and add tests for focus order.", Balanced, 4 workers.
- runs: Chat's session view under the scrim with the Coordinated runs drawer (section 7.8): workspaces "Swarm worker 2" (`+142 −18`) and "Review: Hands Windows fixes"; runs "Keyboard focus sweep" (running, 62%, "Recheck keyboard focus across menu reads") selected, "Installer copy pass" (needs review, 100%); the detail shows three task cards and Stop run.
- workflow: Chat's session view under the scrim with the "Run a saved workflow" dialog (section 7.9) in its list view; clicking "Release checklist" shows the form with the checked plan.

---

## 9. Checks before handing the boards over

1. No project letter tile anywhere: search each new file **and Sidebar.dc.html** for `letter`, `tileBg`, `projLetter` (none may render); project headers show the always-on chevron; no "Astro" title remains.
2. The footer reads "You · Codium Max" with a solid `#9274EC` avatar, Help and Settings, on every board with the sidebar; the collapsed rail shows the same 24 px avatar.
3. Header row 1 shows title and project name, then branch chip, status chip, Tasks, Changes, Terminal in that order; row 2 shows usage pill, context ring, "…". All 24 tall or less, none missing.
4. The composer's left slot holds the paperclip ("Add files ⌘U"; no Signature `+` menu); the right side has mic and the square Send; the chips row has Model (server glyph at 70%), Mode (dot), Effort (when on, with its chevron), Speed (dot).
5. The placeholder reads exactly "Ask anything, / for commands, @ for context...".
6. The Changes panel matches section 5 value for value (including today's contrast misses in 5.11), the commit dialog uses today's dialog look, and Main's redrawn panel is not reused.
7. One gradient per screen: the Live edge, the empty-state tile, the Changes top line, or a route's own tile (Vectorscope review or signed-out); the Live edge turns solid whenever another one is on screen. The one exemption is today's Changes surfaces drawn verbatim: the commit dialog's top line and button sit over the Changes panel's line while that dialog is open, as they do today.
8. No third-party names, marks, favicons or model names; no prices; Codium appears only as "Codium" and percentages. No label or shortcut copied from another product: browser copy uses section 6's words ("Use and click / Read only / Blocked", "Vector can use the browser", "Local servers", "Check changes in the browser after each edit", "Remember sign-ins between sessions", the sharing chip), and Pick is ⌥⌘P.
9. Every hit target is at least 24 px; menu rows are 28.
10. Contrast: text at least 4.5:1, icons at least 3:1, measured on the surface it sits on, including hovered and keyboard-active menu rows (menu secondary text is `--vxs-text-2`; tooltip shortcuts `--vxs-text-2`; no text under 10 px).
11. Nothing was run against the repositories; the boards were checked only by opening the canvas.

## 10. Open decisions for the owner

1. **Pickers below or inside the composer.** Default below (closest to the Signature chatbar the owner liked); the Chat board's "pickers" tweak shows inside.
2. **Browser shape.** The panel browser (A as default with B and C as its modes), D's live cards in the chat, or D with Open into A's panel.
3. **Menu heading.** Today both the permission menu and the speed menu are headed "Mode". Keep, or rename the second to "Speed"?
4. **Founding badge** in the account row after Codium merges (today's codium branch has it; main does not).
5. **Settings as a full-window takeover** (today, kept) or as a stage route with the Signature sidebar visible.
6. **Vectorscope as a stage route** (blend). This replaces today's full-window modal and also changes Signature, where the Vectorscope verb opened it in the side panel (SIG 4.2). The route gives the PR list, review and merge card room; the side panel would have kept the chat visible.
7. **Tasks label at narrow widths.** Labels hide below 1100 px, as today; the owner may prefer a lower breakpoint now that buttons are smaller.
8. **Active state of the header tool buttons.** Today's purple tint (kept, because the owner likes today's top buttons) or Signature's neutral selected fill with `--vxs-text`. The Chat board's `active` tweak shows both.
9. **Signature's update row.** Dropped because today's account row already has its Update button. Keep it dropped, or show both the row and the button?
10. **Testing colour.** Today's Testing chip is amber; the blend keeps it violet (faster orbit plus a centre dot), because amber means "needs you" in Signature.
11. **Chips row below step 4.** At the narrowest composers (Chat 363, Changes 216) the four steps in section 4.4 still don't fit. Chat adds a fifth step (the model chip shows only its glyph). Changes and Tasks let the "how" group scroll under a fade. Approve one of these, or choose another, such as an overflow chip.
12. **Browser chrome details the reference leaves open** (6.G, "Left open"). Above all: one placement for the run controls in A, B and C; the loaded-page field (status dot and go arrow); and the no-servers card.

## 11. Review notes

The review was applied as targeted edits. Nothing was restarted, and today's screenshot stayed reference only. Each point was checked against Main.dc.html, Sidebar.dc.html, SIG and the read-only checkout at `0dcbb8e2d`. Contrast figures come from `scratchpad/blendcrit/c.py` and `c2.py`.

**Applied, confirmed in code or maps**
- Effort chip chevron restored (prompt-input.tsx 2315-2330 has it).
- Project name restored after the title (session-header.tsx 318, 11.5 px tertiary today). Below 1100 px the project name and status chip now hide too (vector-premium.css 3847-3850).
- Testing now differs from Agent working: 1.15 s orbit plus a centre dot. It stays violet; that is open decision 10.
- Marked as new: the "esc to exit" hint (today has none) and the empty-state header (today shows branch, Ready and Changes there).
- Model suggestion keeps "· n/N priced" for own-key users only. It also reads "this {task category}", as today, not "this task".
- Account grid gets a fourth `auto` while Update shows (workspace-navigation.tsx). Update gets today's down-arrow glyph. The collapsed rail uses today's 24 px avatar and today's gear.
- Paperclip moved into Signature's left slot (Main 546 and 611 have the left 28 px button). Today's right-side placement is a tweak.
- Separator lists: the "how" lists now use commas. L476 already did; L967 and L1031 did not.
- Chips wrapping: wrapping below 640 was already specified. The spec now says it means composer width, and the split boards draw two lines. Superseded on 2026-11-11 by the owner's one-row rule (section 4.4).
- Commit dialog drawn in today's dialog look (vector-premium.css 1805-1960). Its gradient over the Changes line is a stated exemption in check 7.
- File-tree column noted: kept unchanged, off by default and 200 wide (layout.tsx).
- Today's Changes contrast misses recorded in 5.11 and left unchanged. A fourth one was found: the More menu's faint text, 4.48:1.
- Project headers always show the chevron. SIG 5.8's two-of-three rule held only by weight once a row turns `--vxs-text`.
- Sidebar.dc.html must be refreshed or marked superseded. It has `letter`, `tileBg` and `tileFg`, plus "Upgrade Astro" at lines 769 and 845.
- Browser family stated honestly as one design with three modes. Concept D, live page cards in the transcript, was added as a different shape, with a board.
- B now has an empty state, a close button, rules for Tasks, Changes and Terminal, and card menus clamped to the card's own view. C now has an empty state.
- A's contradiction fixed. A, B and D now share one step list and one moment (step 7 on the docs tab, which the user switched to). A new rule covers Vector working in a tab you are not looking at.
- Step pill set to Step 7. C's zoom now has a formula: 65% idle, 62% while driving. C's default state became idle, because the old default combined driving with pick and with a transcript waiting on the user.
- Permission hint corrected to today's rule (browser.ts `approve`). The after-web variant with today's reason string was added.
- Privacy copy: "Sites with saved cookies" and "Clear this site's cookies".
- Contrast: tooltip shortcuts and menu secondary text moved to `--vxs-text-2`. This covers Mode and Speed, "/", "@" and the Search palette. Model glyph at 70% (4.36:1). Pick badge text at 10 px in a 16 px circle.
- Copied names replaced with Vector's own words in 6.0, 6.C and 6.E. Pick moved to ⌥⌘P: ⇧⌘S is "New task" (use-session-commands.tsx 408), and ⌥⌘P is unbound in the desktop app's keymap and menus. The eye toggle became the Shared / Private chip.
- Vectorscope: the Live edge is solid on routes with their own gradient. The sidebar "3" is defined as open pull requests, matching the subtitle. Fixed "@you wants to merge". Counts leave the dismissed nit out (ai-review.ts `findingSections`).
- Give back is the primary pill everywhere (today's cloud bar uses the "contrast" button).
- Decision 6 now names Signature's side-panel behaviour too.
- Settings board gains Browser, Providers & keys and Agents pages. The Usage page keeps today's eight cells (usage.tsx); the review counted six.
- New workspace launcher, Coordinated runs drawer and "Run a saved workflow" dialog added as 7.7-7.9, with Everyday screens.

**Applied as decisions rather than changes**
- Purple active state of the header buttons, as open decision 8, with a tweak. The owner said they like today's top buttons.
- Dropped Signature update row, as open decision 9.

**Found in passing**
- The existing canvas `title` note names two other products. Section 8.1 replaces it.
- Today's Providers page names another company in its custom-provider line. The mockup drops the name.
- The other c.py results below 4.5:1 do not apply to the new boards:
  - text-3 on a selected sidebar row: SIG already uses text-2 there;
  - the usage pill's 25% "·": decorative, today's value;
  - text-3 on an active segment: active segments use `--vxs-text`;
  - the 0.38 account icons: 3.4-3.5:1, which passes the 3:1 icon rule.
