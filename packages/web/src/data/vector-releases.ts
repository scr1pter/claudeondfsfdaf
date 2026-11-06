export type VectorRelease = {
  version: string
  title: string
  summary: string
  // Site-only status for a release whose notes are written but whose installers are not published yet.
  // Kept out of the summary, which the desktop app shows as that version's notes once it ships.
  availability?: string
}

// Shared by the landing release feed and documentation changelog. This is not a versioned release:
// it lists services that stay switched off or unpublished after the published personal-account release.
export const upcomingRelease = {
  label: "Upcoming — unversioned",
  title: "Features waiting on Vector's own setup",
  summary:
    "Features still waiting on separate setup include consent-based public sessions on Vector's service, Vector Teams, the Vector GitHub App, the public SDK and container images, and provider sign-ins needing registrations, such as xAI, Poe, DigitalOcean, GitLab and GitHub Copilot.",
  status:
    "No release date is announced for the services still awaiting setup. Version 2 is reserved for the final release.",
}

// The desktop release the download page offers today. Not every entry in release199 was published as a
// desktop or npm release (1.99.9 has notes but no installers), so the releases page marks this one Latest.
// Update it in the same change that publishes the next desktop installers.
export const publishedDesktopVersion = "1.99.112"

// Vector Brain arrives in desktop 1.99.110. The site deploys from main, so until the download page offers that release
// the landing page and the investor page say it is coming in it, and from then on that it is new in it. The readme and
// heading labels are for README.md, which has had no section on the brain since 24 October 2026.
export function brainCopy(published: string) {
  const [major = 0, minor = 0, patch = 0] = published.split(".").map(Number)
  if (major > 1 || (major === 1 && (minor > 99 || (minor === 99 && patch >= 110))))
    return {
      kicker: "new in desktop 1.99.110",
      since: "From desktop 1.99.110,",
      stage: "Desktop 1.99.110",
      lede: "from desktop 1.99.110",
      readme: "From desktop 1.99.110, Vector is a self-evolving agentic harness.",
      heading: "### Vector Brain (from desktop 1.99.110)",
    }
  return {
    kicker: "coming in desktop 1.99.110",
    since: "Coming in desktop 1.99.110:",
    stage: "Coming in 1.99.110",
    lede: "coming in desktop 1.99.110",
    readme: "Coming in desktop 1.99.110: Vector becomes a self-evolving agentic harness.",
    heading: "### Vector Brain (coming in desktop 1.99.110)",
  }
}

export const brainRelease = brainCopy(publishedDesktopVersion)

// Deep research, the research browsers, Vector Local in the app, memory of you in every agent and learning about you
// arrive in desktop 1.99.111. Their docs say they are coming in it until the download page offers it, and from then on
// that they are in it. test/release-111-docs.test.ts holds the pages to this.
export const release111Version = "1.99.111"

export function release111Copy(published: string) {
  const [major = 0, minor = 0, patch = 0] = published.split(".").map(Number)
  if (major > 1 || (major === 1 && (minor > 99 || (minor === 99 && patch >= 111))))
    return { since: "From desktop 1.99.111:", stage: "Desktop 1.99.111", shipped: true }
  return { since: "Coming in desktop 1.99.111:", stage: "Coming in 1.99.111", shipped: false }
}

export const release111 = release111Copy(publishedDesktopVersion)

// What desktop 1.99.112 changes in the docs, said as coming until the download page offers it.
export const release112Version = "1.99.112"

export function release112Copy(published: string) {
  const [major = 0, minor = 0, patch = 0] = published.split(".").map(Number)
  if (major > 1 || (major === 1 && (minor > 99 || (minor === 99 && patch >= 112))))
    return { since: "From desktop 1.99.112:", stage: "Desktop 1.99.112", shipped: true }
  return { since: "Coming in desktop 1.99.112:", stage: "Coming in 1.99.112", shipped: false }
}

export const release112 = release112Copy(publishedDesktopVersion)

// Learned skills, workflow insights and the prompt guard arrive in desktop 1.99.113. Their docs say they are coming in it
// until the download page offers it, and from then on that they are in it. test/release-113-docs.test.ts holds the
// pages to this.
export const release113Version = "1.99.113"

export function release113Copy(published: string) {
  const [major = 0, minor = 0, patch = 0] = published.split(".").map(Number)
  if (major > 1 || (major === 1 && (minor > 99 || (minor === 99 && patch >= 113))))
    return { since: "From desktop 1.99.113:", stage: "Desktop 1.99.113", shipped: true }
  return { since: "Coming in desktop 1.99.113:", stage: "Coming in 1.99.113", shipped: false }
}

export const release113 = release113Copy(publishedDesktopVersion)

export const releaseSeries: VectorRelease[] = [
  {
    version: "1.0",
    title: "Desktop foundation",
    summary: "Vector became a local desktop engineering workspace with repository-aware agent sessions.",
  },
  {
    version: "1.1",
    title: "Project sessions",
    summary: "Projects, conversations, local persistence, and repeatable repository entry flows were established.",
  },
  {
    version: "1.3",
    title: "Visible execution",
    summary: "Tool calls, file activity, terminal work, and clearer execution state became part of the session.",
  },
  {
    version: "1.4",
    title: "Vector identity",
    summary: "The interface, desktop packaging, assets, and product language moved to the Vector brand.",
  },
  {
    version: "1.5",
    title: "Review foundations",
    summary: "Changed-file review, checkpoints, and safer project recovery began to form a trust layer.",
  },
  {
    version: "1.6",
    title: "Codespace",
    summary: "A dedicated editor experience added file navigation, language-aware editing, and project diagnostics.",
  },
  {
    version: "1.7",
    title: "Project tools",
    summary: "Terminal, browser preview, project context, and engineering utilities became connected session tools.",
  },
  {
    version: "1.8",
    title: "Personal workspace",
    summary: "Appearance, behavior, keyboard, editor, chat, and local preference controls were expanded.",
  },
  {
    version: "1.9",
    title: "Code intelligence",
    summary: "Search, completion, diagnostics, inline assistance, and code-oriented context were strengthened.",
  },
  {
    version: "1.10",
    title: "Browser engineering",
    summary: "Browser control evolved from a passive preview toward visible testing and diagnostic workflows.",
  },
  {
    version: "1.11",
    title: "Project history",
    summary: "Timeline events, checkpoints, change explanations, and project memory became easier to inspect.",
  },
  {
    version: "1.12",
    title: "Parallel execution",
    summary: "Isolated agent workspaces introduced independent files, branches, terminals, and review boundaries.",
  },
  {
    version: "1.13",
    title: "Cloud connections",
    summary: "Publishing, deployment state, environment configuration, and project connections joined the workspace.",
  },
  {
    version: "1.14",
    title: "Reliability pass",
    summary:
      "Desktop launches, model selection, settings behavior, preview reliability, and cross-platform packaging received sustained fixes.",
  },
  {
    version: "1.15",
    title: "Integrated engineering",
    summary:
      "Agent, editor, browser, review, terminal, and cloud surfaces were brought into a more consistent project model.",
  },
  {
    version: "1.16",
    title: "Agent coordination",
    summary:
      "Parallel workspaces, background status, subagents, model routing, and orchestration controls were expanded.",
  },
  {
    version: "1.17",
    title: "Unified Vector workspace",
    summary:
      "The current line focuses on task-specific state, live multi-agent work, a controlled browser, transparent usage, and production packaging.",
  },
]

export const release117: VectorRelease[] = [
  {
    version: "1.17.0",
    title: "Unified shell",
    summary: "Introduced the current project-centered desktop shell and consolidated the primary engineering surfaces.",
  },
  {
    version: "1.17.1",
    title: "Workspace navigation",
    summary: "Improved movement between project sessions, tools, and isolated workspaces.",
  },
  {
    version: "1.17.2",
    title: "Agent workspace detail",
    summary: "Expanded per-workspace conversation, terminal activity, changed files, status, and review context.",
  },
  {
    version: "1.17.3",
    title: "Background execution",
    summary: "Agent runs could remain visible and manageable while users moved through other Vector surfaces.",
  },
  {
    version: "1.17.4",
    title: "Browser state",
    summary:
      "Connected visible browser state, navigation, screenshots, and diagnostics more closely to project sessions.",
  },
  {
    version: "1.17.5",
    title: "Engineering timeline",
    summary: "Recorded important file, terminal, browser, checkpoint, and review events per project.",
  },
  {
    version: "1.17.6",
    title: "Codespace stabilization",
    summary: "Focused the editor on real repository files, direct local saves, diagnostics, and dependable navigation.",
  },
  {
    version: "1.17.7",
    title: "Review detail",
    summary: "Improved changed-file inspection and the path from agent output to a reviewable diff.",
  },
  {
    version: "1.17.8",
    title: "Project memory",
    summary: "Added repository-owned context and stronger task-specific indexing for later sessions.",
  },
  {
    version: "1.17.9",
    title: "Trust signals",
    summary: "Expanded risk, secret, validation, rollback, and checkpoint information around proposed changes.",
  },
  {
    version: "1.17.10",
    title: "Model economics",
    summary: "Made model usage, token categories, context consumption, and recorded cost easier to inspect.",
  },
  {
    version: "1.17.11",
    title: "Canvas",
    summary: "Introduced a multitasking surface for arranging project tools without abandoning the active repository.",
  },
  {
    version: "1.17.12",
    title: "Cloud workspace",
    summary: "Expanded deployment, domain, environment, health, log, and data-service project controls.",
  },
  {
    version: "1.17.13",
    title: "Desktop hardening",
    summary: "Addressed launch behavior, window lifecycle, permissions, platform identity, and packaging reliability.",
  },
  {
    version: "1.17.14",
    title: "Provider and MCP reliability",
    summary: "Improved provider discovery, model selection, MCP setup, and clear connection states.",
  },
  {
    version: "1.17.15",
    title: "Agent runtime choices",
    summary: "Added clearer integration paths for Vector Agent and detected Claude Code, Codex, and Cursor runtimes.",
  },
  {
    version: "1.17.16",
    title: "Parallel workspace execution",
    summary:
      "Strengthened isolated workspace creation, status, terminal boundaries, review, merge, and discard behavior.",
  },
  {
    version: "1.17.17",
    title: "Controlled-browser loop",
    summary: "Improved the loop from page observation to diagnostics, repair, screenshot evidence, and retesting.",
  },
  {
    version: "1.17.18",
    title: "Task-specific state",
    summary:
      "Scoped browser, usage, context, cloud, and engineering-tool state more consistently to the active task and repository.",
  },
  {
    version: "1.17.19",
    title: "Composer refinement",
    summary: "Refined effort controls, prompt layout, voice dictation feedback, and task steering.",
  },
  {
    version: "1.17.20",
    title: "Stable project workspace",
    summary: "Consolidated the project sidebar, agent workspaces, review affordances, and local execution behavior.",
  },
  {
    version: "1.17.21",
    title: "Follow-up queue",
    summary:
      "Added visible queued prompts, steering, queue limits, completion notifications, and focused settings cleanup.",
  },
  {
    version: "1.17.22",
    title: "Repository language",
    summary:
      "Updated project entry language, onboarding, and home navigation around repositories rather than generic tasks.",
  },
  {
    version: "1.17.23",
    title: "Editor navigation",
    summary:
      "Separated code-editor search from project review navigation and improved direct file opening in Codespace.",
  },
  {
    version: "1.17.24",
    title: "Cross-platform repair",
    summary:
      "Fixed installer, sidebar, browser, cloud, voice, and layout issues across macOS, Windows, and Linux builds.",
  },
  {
    version: "1.17.25",
    title: "In-app updates",
    summary:
      "Introduced the visible update workflow, refreshed release artifacts, and improved the path to the latest desktop build.",
  },
  {
    version: "1.17.26",
    title: "Updater and navigation repair",
    summary:
      "Rebuilt the macOS replacement handoff, added clearer version state, simplified the workspace navigation, and refreshed the Vector website and documentation.",
  },
  {
    version: "1.17.27",
    title: "Living workspace",
    summary:
      "Brought Vector's interactive ASCII field into the desktop Home workspace, made the packaged window open reliably on launch, refreshed the release history, and synchronized the macOS, Windows, and Linux release line.",
  },
  {
    version: "1.17.28",
    title: "Task-bound agents",
    summary:
      "Kept every isolated agent and worktree attached to the task that created it, prevented managed agent folders from appearing as standalone projects, and cleaned stale workspace entries from Vector's project memory.",
  },
  {
    version: "1.17.30",
    title: "The Vector product suite",
    summary:
      "Introduced one unified Product Hub for Vector Code, Vector Work, and Vector Cloud; added project-based Work tasks with optional repositories; made Cloud globally project-selectable; and launched Vel as Vector's task-aware voice assistant.",
  },
  {
    version: "1.17.31",
    title: "Focused Work and session-bound Vel",
    summary:
      "Limited Vector Work to agent chat, parallel workspaces, browser control, Vel, MCP, and plugins; moved Vel into active task and session tools; and ensured voice requests stay inside the exact visible session.",
  },
  {
    version: "1.17.32",
    title: "Conversational Vel and separate Work projects",
    summary:
      "Turned Vel into a spoken active-session agent with native desktop replies and real coding handoffs, while keeping Vector Work projects separate from Vector Code repositories.",
  },
  {
    version: "1.17.33",
    title: "Natural voice turns with Vel",
    summary:
      "Added automatic end-of-speech detection, voice-first session creation, interruptible spoken replies, and clearly italicized Vel conversations inside the active Vector chat.",
  },
  {
    version: "1.17.34",
    title: "One Vector workspace",
    summary:
      "Retired the Vector Work product split, restored the repository-first home, moved Cloud Services directly into that workflow, and repositioned Vector as one local-first, bring-your-own-key agentic workspace for builders.",
  },
  {
    version: "1.17.35",
    title: "Vel, inside every session",
    summary:
      "Moved Vel into the chat composer, connected every spoken request directly to the selected session's real agent and reply, and made Cloud Services a repository-level destination available from Home.",
  },
  {
    version: "1.17.36",
    title: "Guided workspace onboarding",
    summary:
      "Introduced an interactive spotlight tour over Vector's real controls, added a durable Getting Started guide, and made the path from repository setup to agents, tools, Cloud Services, and Settings easier to learn.",
  },
  {
    version: "1.17.37",
    title: "Open beta downloads",
    summary:
      "Opened direct beta access to current macOS, Windows, and Linux installers, refreshed Vector's animated product story, and introduced a more distinct neon workspace editor treatment.",
  },
  {
    version: "1.17.38",
    title: "Faster parallel sessions",
    summary:
      "Made isolated agents appear faster as complete Vector sessions with their own subagent access, simplified inactive Settings controls, and introduced a continuous purple Matrix rainfall across the landing page.",
  },
  {
    version: "1.17.39",
    title: "A more focused private beta",
    summary:
      "Expanded Vector's engineering plugin catalog, refined the new-session workspace, and closed public installer access while preserving every cross-platform release artifact for controlled distribution.",
  },
  {
    version: "1.17.40",
    title: "Reliable visual context",
    summary:
      "Made JPEG and other common image attachments dependable, added local conversion for camera and design formats, and taught Vector to select a connected image-capable model before a visual task begins.",
  },
  {
    version: "1.17.41",
    title: "Cloud command center",
    summary:
      "Rebuilt Cloud Services around explicit repository selection, moved GitHub and GitLab publishing into Cloud, added provider-backed Supabase and AWS service views, and connected Vector's main agent to real cloud preparation, inspection, environment sync, and deployment actions.",
  },
  {
    version: "1.17.42",
    title: "Editor Agent workbench",
    summary:
      "Rebuilt the Code Editor into a focused explorer, Monaco, and resizable agent workspace; added shared model, effort, speed, Plan, and permission controls; and replaced the editor-only review queue with direct, visible workspace edits and inline Cmd+K changes.",
  },
  {
    version: "1.17.43",
    title: "One agent across chat and code",
    summary:
      "Unified the Code Editor with the active Vector conversation, model, effort, speed, permissions, attachments, and voice controls; added live file following with conflict-safe drafts; and refined the full IDE shell with workspace search, a resizable explorer, code outline, Monaco editing, and a responsive agent pane.",
  },
  {
    version: "1.17.44",
    title: "A quieter, focused IDE",
    summary:
      "Reduced the Code Editor to one Explorer control and one Agent control, moved the compact shared-agent composer beneath its conversation, removed Vel from the editor composer, and replaced the purple file canvas with a mature charcoal Monaco theme.",
  },
  {
    version: "1.17.46",
    title: "Unified account foundation",
    summary:
      "Introduced unified Vector accounts, account-protected downloads, server-managed provider and MCP connections, and production-safe quota and security boundaries.",
  },
  {
    version: "1.17.47",
    title: "One account for every Vector surface",
    summary:
      "Rebuilt the signed-in experience as an animated Vector command center, added complete website settings for profile, security, and legal controls, and unified product access behind one account.",
  },
  {
    version: "1.17.48",
    title: "Your models, tools, and computer",
    summary:
      "Added encrypted BYOK model providers, managed MCP connections, and an approval-gated Vector desktop companion with independent browser and terminal permissions.",
  },
  {
    version: "1.17.49",
    title: "Desktop-first Vector",
    summary:
      "Retired the experimental website account, Builder, Cloud Agent, and API Studio surfaces; restored Vector's public site to product, documentation, releases, and legal pages; and removed the unused desktop companion while keeping Vector Cloud Services inside the IDE.",
  },
  {
    version: "1.17.50",
    title: "Orchestrated and verified completion",
    summary:
      "Added dependency-aware subagent orchestration with file ownership boundaries, optional LLM-as-a-judge verification and repair loops, durable scheduled-agent completion tracking, in-session GitHub pull-request review, visible testing state, and a substantially expanded MCP plugin catalog.",
  },
  {
    version: "1.17.51",
    title: "Real spend, real answers",
    summary:
      "The model economics engine now records the provider's reported tokens for each session and prices them at catalog rates instead of estimating from character counts, and ranks models on measured spend once correctness ties. Added the Vector Help AI Assistant, a docs-and-chat side panel answering strictly from Vector's own documentation so it cannot invent controls that do not exist. Replaced the workspace settings gear with a one-click bug reporter that sends your app version and platform along with the report.",
  },
  {
    version: "1.17.52",
    title: "Agents that work together",
    summary:
      "Agents can now share one workspace instead of each getting their own: they see each other's edits as they happen, message each other while working, and Vector names the file and both agents when two of them hold the same one. The Agent Dashboard in Project tools shows every agent live with its task, model, spend (measured for external CLIs, estimated for Vector agents), and the conversation between them, and the code editor attributes each edit to the agent that made it. Adds Pull Requests with Vector AI review, local memory that follows you across every repository and can be erased outright, a Vector Help AI Assistant answering only from Vector's own documentation, one-click bug reporting, selectable Claude Code, Codex, and Cursor runtimes, and a rebuilt Scheduled tasks screen with real recurrence.",
  },
  {
    version: "1.17.53",
    title: "Plugins that install themselves",
    summary:
      "Connecting a plugin no longer sends you to a terminal. Vector resolves whatever runner a plugin needs, fetches it when it is missing, and pins an interpreter the package can actually run on, so Computer Use — full desktop control with screen reading, mouse, keyboard, and window management — connects on machines that had neither uv nor a recent Python. Retired the in-session Review PR button in favour of Project tools, Pull Requests, which lists, reviews, and merges rather than acting on one pasted link.",
  },
  {
    version: "1.17.54",
    title: "Licensing and disclosure",
    summary:
      "Removed the last copyleft dependency: HEIC images are now converted by the operating system rather than a bundled LGPL decoder, which also drops about three megabytes from every build. Expanded the privacy policy to cover local memory, the help assistant, bug reports, and optional screen and desktop control, and added a terms section describing what Vector can do on your machine and on services you connect.",
  },
  {
    version: "1.17.55",
    title: "Economics that actually learn",
    summary:
      "Model economics only ever learned from validated parallel runs, so it rarely gathered enough evidence to recommend anything. Every ordinary session now contributes what it truly cost — provider-reported tokens, spend, latency, and files touched — so recommendations appear from normal use. Removed a ranking signal nothing ever produced, which had been the primary sort key and rendered a permanently blank win rate. The site now says plainly which capabilities exist nowhere else: agents that message each other while working, per-agent attribution of live edits, and running Claude Code, Codex, or Cursor as engines inside Vector.",
  },
  {
    version: "1.17.56",
    title: "Agents can actually reach each other",
    summary:
      "Collaborative agents could not message each other. The teammate tool was registered in one tool registry while sessions resolve tools through another, so every call returned an unknown-tool error and the agent wrote its message into its own reply instead. The tool now lives where the engine looks, and the workspace is resolved through the location layer so the message queue lands in the right tree whether agents share one or work in isolation. Verified against a live model on a real repository: one agent renamed an export and told its teammate, and the teammate fixed the failing import.",
  },
  {
    version: "1.17.57",
    title: "Undo that cannot delete your work",
    summary:
      "Session snapshots were written as bare git trees with nothing pointing at them, so the engine's own scheduled garbage collection removed them after a week. Reverting to a collected snapshot then read as \"this file was never in the snapshot\" and deleted the file from your working tree, while reporting that the undo had succeeded. Snapshots are now anchored behind a ref so collection cannot reach them, a revert that cannot read its snapshot refuses to delete anything and says why, and a restore that fails no longer claims to have worked. Scheduled tasks became usable: the screen had no way to create one, so the list was always empty. It now has a real form with one-off, daily, weekday, and weekly schedules, and the suggestions fill it in. Agent teams were running unisolated, because a coordination file was written into the workspace before the git worktree was created; git refuses to create a worktree in a directory that already has contents, so every team silently fell back to a plain copy. Teams now get real isolated worktrees. Files inside newly created directories were missing from every workspace diff. LLM-as-a-judge now applies to every prompt and every agent workspace instead of only the session you typed in, and a failed verdict must name the specific repair rather than only the problem. Model economics prices runs from the engine's own live rate catalog instead of a hand-maintained table that had no entry for the default models and billed cached tokens at ten times their real rate. An unsubstantiated performance comparison was removed from the site.",
  },
  {
    version: "1.17.58",
    title: "Merges that keep a copy",
    summary:
      'Merging an agent workspace back into a project that is not a git repository could destroy work permanently. The copy-mode merge deleted and overwrote files in the real project directly, and the "checkpoint" it promised beforehand was only a map of file hashes — enough to detect a conflict, but incapable of restoring a single byte. Both copy merge paths now copy every file they are about to overwrite or delete into the checkpoint first, and a non-git checkpoint stores real file copies alongside a README explaining how to put them back. The same guarantee already covered git projects and now covers all four merge paths.',
  },
  {
    version: "1.17.59",
    title: "Nothing spends your key without saying so",
    summary:
      "Vector silently rerouted prompts it judged complex to a stronger model — on a bring-your-own-key product that can be many times the token price you chose — while the composer kept showing the model you picked, so there was no way to tell what you were being billed for. Routing is now off by default, has its own setting, honours models you hid in Settings, and switches the composer to whatever it actually used. Theme, colour scheme, and language controls returned: they existed only in a legacy shell that a hardcoded flag made unreachable, so the shipped app had no way to change any of them. A download is now recorded once the bytes arrive rather than before they are sent. The what's-new feed is now generated at build time; it had never existed, so the release-notes dialog had never run.",
  },
]

export const release118: VectorRelease[] = [
  {
    version: "1.18.0",
    title: "Agents you can leave alone",
    summary:
      "Vector can now sandbox the commands its agents run. Enable the shell-sandbox environment flag (read as VECTOR_SHELL_SANDBOX from 1.99.99) and every shell command from an agent is confined to the workspace it belongs to by the operating system's own mechanism \u2014 a seatbelt profile on macOS, bubblewrap on Linux \u2014 with reads of SSH keys, cloud credentials, and keychains denied outright. Windows has no equivalent that ships with the OS, so Vector says so and runs unconfined rather than pretending. It is off by default and degrades to an ordinary command whenever a host cannot sandbox, so it can never cost you a command that used to work. Scheduled work now actually happens while you are away: Vector keeps a tray presence and stays resident after the last window closes, showing what is armed and when it next runs, notifying you when a run finishes, and never staying alive without a tray to quit from. Repository context stopped being a keyword search. An on-device structural index ranks files with BM25 over identifiers and paths, then spreads through the real import graph and the files git history shows change together, so an agent receives the code that matters instead of whatever happened to share a word with the request. Vector now remembers how a project fails: normalised failure signatures accumulate per repository, a repair that worked once is offered the next time the same failure appears, and a test that passes and fails without any relevant change is reported as flaky instead of being chased through another repair loop. Unattended spend is capped rather than merely displayed \u2014 five dollars a run and twenty-five a day by default for scheduled and background agents, with a run that reports no usage recorded as unmeasured rather than free, so it can never silently trip a limit. Adds an eval harness that scores Vector's own agent against objectively-checkable tasks, and can run the same set through the Claude Code, Codex, and Cursor runtimes for comparison. The model effort slider is now a dot matrix that brightens toward the level you pick. Fixed continuous integration: tests and typechecks were gated on a branch this repository does not have, so no push had run them.",
  },
]

export const release119: VectorRelease[] = [
  {
    version: "1.19.0",
    title: "Work that repeats, and agents you can pair",
    summary:
      "Scheduled work moved out of the session and onto the home screen as Automations, and became a real automation engine rather than a reminder. Write the task yourself, then choose the repositories it runs in and, for each one, a fresh session or an existing thread to keep adding to. Every repository reports its own result, so one failing does not condemn the rest, and a recurring task now computes its next occurrence from the rule itself instead of drifting forward from whenever the last run happened to finish. A schedule missed while Vector was closed catches up once and says so rather than firing a burst. Agents can now be paired deliberately: a team is everyone-to-everyone, a coordinator broadcasting down to workers who do not chatter among themselves, or any pairing you set, and a message to an unlinked teammate is refused and told so instead of vanishing. Launching Claude Code, Codex, or Cursor Agent works again on ordinary machines: Vector looked for those CLIs using the stripped-down environment a desktop app inherits when it is opened from Finder, so anyone whose tools live under nvm, fnm, mise, asdf, volta, or a custom prefix was told the runtime was not installed, and the picker then hid it entirely. Vector now reads your login shell the way the engine already did, reports a runtime that is present but signed out as signed out with the command that fixes it, and shows an uninstalled runtime with its install steps rather than hiding the option. Fixed a defect that had been quietly deleting your work since 14 August: identifiers pack a millisecond timestamp into six bytes, which overflows and repeats roughly every 795 days, and the most recent repeat inverted the comparison behind tool-output retention — so every cleanup deleted the newest saved output and kept the oldest. Timestamps are now reconstructed across that boundary, with the identifier format unchanged. The test suite is green again: 24 failures, most of them assertions left behind by the rebrand, were repaired rather than deleted, and continuous integration, which had been running on a branch this repository does not have, now runs on every push.",
  },
  {
    version: "1.19.1",
    title: "One workspace, evenly told",
    summary:
      "The site led with running many agents at once, which is one capability rather than the reason to use Vector. It now gives equal weight to nine parts of the same workspace \u2014 the editor with search, diagnostics and a terminal; local memory that stays on your machine; spend measured from what the provider actually reported; the browser that will not type into a password field; optional judge verification; deployments on accounts that are already yours; the connector catalogue; parallel agents; and recurring automations \u2014 with a section that states plainly where each one is conditional. The model effort control is now a rounded rectangle rather than a capsule, so its frame matches the handle inside it, and at full effort the dot matrix carries purple flowing toward the handle instead of a flat pulse. Repaired the first-run test, which had asserted onboarding copy that stopped existing when the tour was rebuilt on 10 August and had been failing unnoticed ever since.",
  },
  {
    version: "1.19.2",
    title: "Undo that keeps your files",
    summary:
      "Undo could delete the work it was meant to restore. Reverting a step that touched two or more files asked git which of them were in the snapshot without disabling path quoting, so any name that is not plain ASCII came back quoted, failed to match, and the file was deleted as though it had never been in the snapshot \u2014 including untracked work that existed nowhere else. That path was also the only one that never checked the snapshot was readable first, so an unreadable snapshot read as an empty one. Reverting a rename was worse: git collapses a rename into a single entry naming only the destination, so undo deleted the new file and never restored the original. Both are fixed, the batch now refuses to delete when it cannot read the snapshot, and each has a regression test that fails without the fix. Scheduled automations could never report success \u2014 the poller looked for a message shape the route it calls does not return, so every run polled to its six-hour ceiling and was recorded as failed. A parallel agent whose turn ended in a provider error was recorded as complete with no changes, on exactly the unattended path the feature exists to protect. Merging was impossible in any project with local dev dependencies, because an isolated workspace has no node_modules and the resulting exit 127 was treated as a failed check rather than a skipped one. Non-ASCII paths broke merges after they had already written to the project, and files with Windows line endings could never be merged hunk by hunk. The one function guarding a merge against data loss silently skipped symlinks and swallowed every copy failure. Vector's subagents now have names and faces: Scout the fox explores, Veri the owl judges, Rook the raven watches the boundaries, and six more, each shown by name in the timeline and in the Agent Dashboard, with a new Pets page in Settings introducing the whole crew. Settings also gains Voice and Personalization, where custom instructions you write are applied to every new session in every repository. Pull Requests moved to Connections and now lists your CI runs, turning a failed one into a repair prompt. Scheduled runs left the session sidebar, since Automations on the home screen replaced it. Adds Graphify to the plugin catalogue.",
  },
  {
    version: "1.19.3",
    title: "Trust before autonomy",
    summary:
      "Vector now treats agent autonomy as a security boundary. Packaged builds seal the credential-vault key with the operating system's secure storage and stop visibly if no protected store is available instead of falling back to a plaintext vault. Agent shell confinement remains an opt-in preview on supported macOS and Linux hosts instead of being enabled during this release; enable the shell-sandbox environment flag (read as VECTOR_SHELL_SANDBOX from 1.99.99) to try it. When enabled, unavailable confinement needs explicit approval and linked-worktree Git objects, refs, and reflogs stay read-only, while web access and reads of common SSH, cloud, Kubernetes, Docker, environment, and private-key files ask first. The hosted help and bug-report endpoints now validate origins, content types, sizes, and structured fields, and use atomic Redis rate limits that fail closed in production before model or email capacity can be spent. First launch no longer forces the exhaustive tour. It presents a short activation path with a read-only starter task, keeps the full guide optional, and only marks provider setup and the first task complete after a real model response finishes successfully. V2 sessions now calculate model spend from catalog input, output, reasoning, cache read, cache write, and context-tier prices, honor authoritative Copilot billing metadata, persist normalized token breakdowns, and keep session totals exact through event replay, replacement, and revert paths; usage without a finite catalog price keeps the existing $0 compatibility fallback. Releases are now blocked on package typechecks, unit tests, and desktop and website build smoke tests; macOS artifacts must be signed and notarized, Windows installers must carry a valid signature and an updater publisher identity, every expected architecture is checked, checksums are published, and update feeds must succeed before the release is published. The objective agent eval expands from five tasks to eight with billing-idempotency, path-containment, and concurrent-allowance cases, plus repeated trials for exposing run-to-run variance. Embedded SDK hosts now resolve their database location when their runtime is built rather than capturing a stale import-time path. The subagents Vector delegates to are now named and described for the work they do \u2014 Explore, General, Judge, Debug, Migration, Performance, Review, Security and Test \u2014 each with its own mark, a summary of what it handles, and a read-only badge where that matches its permissions. They appear by name in the session timeline, in the Agent Dashboard, and on a new Subagents page in Settings. Settings also gains Voice and Personalization, where custom instructions you write are saved to the instruction file every new session already loads. The settings panels scroll again: they were scrollable all along, but the scrollbar was hidden, so a page taller than the dialog simply looked cut off.",
  },
  {
    version: "1.19.4",
    title: "The boundaries hold",
    summary:
      "A symlink committed inside a project defeated the permission gate that keeps an agent within your workspace. The check compared paths as text, so a link placed by a dependency, a merged pull request, or an agent following instructions in a page it fetched gave read and write access to the rest of the disk with no prompt. Containment is now decided on where a path really lands, dangling links are followed by hand, and a file that does not exist yet is resolved through its parent, so creating one cannot escape either; a permission you already granted on a link keeps working, because only the containment decision changed. The edit tool could replace more than it was asked to and report success: a difference of a single space matched a whole indented line and wrote back an unindented replacement, and an anchored match swallowed a line the model never saw. Edits are now reconciled against exactly what was described, and an edit that cannot be reconciled is refused rather than quietly applied. The browser's refusal to type into password, one-time-code and card fields was reachable only through one input path, so the agent's own key-press command walked around it; every path that can put characters into a field now shares the same check, decides on the focused element rather than a named selector, recognises a masked field whose type claims otherwise, and refuses on an unfamiliar key. Beyond those: the shell tool now tells the model when a command exits non-zero instead of leaving it to assume success, searching a single file no longer searches its whole directory, the Cloud Console and the agent's own cloud tool finally read the same saved setup, the secret scan inspects the directory that actually gets deployed, deployments are no longer silently cut off at two hundred files, publish and cloud logs are redacted, the file holding cloud environment variables is no longer world-readable, and joining an existing team no longer erases the pairing you configured.",
  },
  {
    version: "1.19.5",
    title: "Agents that actually reach each other",
    summary:
      "Putting agents in one workspace so they can message each other is something only Vector offers, and it did not work. The machinery was right \u2014 an agent really did queue its message \u2014 but there was one point where messages were read and one where they were written, and they sat at opposite ends of a run. Every member of a team starts at the same moment, so when the first prompts went out nobody had written anything yet, and by the time anything was collected everyone had already finished. The tool told each agent its message would arrive at the start of its teammate's next turn, and there was no next turn. Messages are now delivered while the team is still working, so one agent renaming a module can tell another to fix its imports and have that actually land. A repair pass counts as a turn and delivers too, and a run that fails or is stopped no longer strands whatever it had queued. Claude Code, Codex and Cursor agents can now be told what their teammates did, but they cannot reply \u2014 none of them has a teammate-message tool to call \u2014 so the launch screen now says which runtimes can send instead of promising it to all of them.",
  },
  {
    version: "1.19.6",
    title: "Agents you can talk back to",
    summary:
      "Launching a Claude Code, Codex or Cursor agent gave you a review page and nothing else. That was not a bug in the screen — it was the shape of the whole feature. Vector ran those CLIs in their one-shot batch modes, which accept exactly one prompt, run to completion and exit, so once a run finished there was nothing left to talk to. Worse, the conversation was thrown away: both CLIs announce a conversation id on their very first line of output, and Vector captured neither, so a thread that still existed on disk was orphaned the moment the run ended. External agents are now conversations. Vector records the agent's own conversation id as it appears, and a follow-up message resumes that same thread instead of starting over — the agent still remembers the file it just changed and why. The workspace drawer is now a transcript with a message box: your turns, the agent's replies, its live output while it works, and a quiet note whenever Vector itself steps in to repair a failed check. A follow-up that only asks a question no longer drags the whole check suite behind it. Two things had to be right for this to be honest rather than merely present. The id is captured on the line it arrives on, because the output buffer keeps only the most recent lines and Codex announces its thread exactly once, at the very top — read it any later and every real run would have lost it. And when a CLI refuses to resume, Vector re-briefs it with a written summary of the work so far and labels that turn as restarted rather than pretending the agent remembers. The runtime picker also stopped over-promising. It knew only whether a CLI was installed, so a signed-out Claude Code showed a green tile with its version number and then failed at the sign-in wall on every run — which is what made launching one feel broken. Vector now asks each CLI whether it is actually signed in, shows Signed out where that is true, and offers the one command that fixes it instead of telling you to reinstall something you already have. When a run does fail, the reason survives: the sentence naming the cause used to be discarded in favour of a dozen lines of raw machine output. Also fixed: discarding a workspace while its agent was still running made the failure handler itself fail.",
  },
  {
    version: "1.19.7",
    title: "Your house, your rules",
    summary:
      "Two things your team already does in review, now done by every agent. Rules are standards written the way you would say them to a new teammate \u2014 we don't put database query logic in the controller \u2014 pointed at a repository and, when it matters, at the files they govern. Vector saves them to .vector/RULES.md inside the repository itself, which makes them a committed, reviewable file rather than a preference buried on one machine: clone the repo and the rules come with it. Vector's own agents read that file on every prompt. Claude Code, Codex and Cursor read their own instruction files and would never see it, so Vector carries the matching rules into the prompt it hands them instead \u2014 one rule, written once, enforced by whichever agent picks up the work. A rule can be scoped to a folder or a glob, and the scope travels as words rather than as a pattern nothing downstream re-reads, so it still means something to the model. The Agent Dashboard now opens on a board: Running, Needs you, Done. Cards carry the task, what the agent is doing right now, how long it has been at it, and whether a pull request is already waiting. Search across names and tasks, then narrow by status, runtime, team, or to just the runs that opened a PR \u2014 two statuses means either, a status and a runtime means both, and the chips are built from the agents actually on screen so one can never empty the board. Needs you deliberately merges failed with needs review, including a finished run that reported an error: both are stopped and waiting on a person, and splitting them would put the same decision in two places. Teams stay first-class and filter as a unit, because in Vector they are not independent runs that happen to sit next to each other \u2014 they message each other while they work. Two connectors join the catalogue. Greptile connects through its own hosted MCP endpoint with your API key. CodeRabbit publishes no MCP server at all \u2014 it is an MCP client that reads other servers for review context \u2014 so the entry is the community server that reads CodeRabbit's review threads back off a GitHub pull request, labelled as community and authenticating with a GitHub token rather than pretending to be official. The catalogue count on the site was also four behind reality and now reads 118, which is what is actually there.",
  },
  {
    version: "1.19.8",
    title: "Click around before you download",
    summary:
      "The Agent Dashboard's board grew up. Status, Team, Pull request and Agent are now labelled dropdowns rather than a loose row of chips \u2014 with four facets a bare chip loses its heading, and \u201cmerged\u201d on its own never says which question it is answering. Each menu checks off the values you pick, the button carries what you chose, and the board narrows as you go: two values in one menu means either, values in two menus means both. Pull request now separates open from merged from never-opened, because a merged run still carries a pull request URL and would otherwise sit under \u201copen\u201d forever. The list view was rebuilt as grouped rows under the same three headings instead of a second, differently-shaped rendering of the same records, and both the board and the list now name the team a run belongs to above its task. And the landing page stopped being a gallery of screenshots. The Agent Dashboard now runs inside the page: switch the board to a list, open the filters, pick a status or a team or a pull request state, search across tasks, watch the columns recount and empty. It is real interaction against local data, not a video and not a picture, so you can decide whether you like Vector before you download anything. Every card in it is rendered with the page rather than assembled by script, which is why it still reads correctly with JavaScript yet to run.",
  },
  {
    version: "1.19.9",
    title: "Three doors to your rules",
    summary:
      "Rules shipped in 1.19.7 and were almost impossible to find, which is the same as not shipping them. They now have three doors: Project rules in the workspace rail, a Set your rules card on the home screen next to Automations, and their own page in Settings. All three open the same panel, where you write a standard in plain English, point it at a repository and optionally at the files it governs, and Vector writes it to .vector/RULES.md in the repo for the whole team. Automations was redesigned. It had a close button floating alone above the title, four different text opacities competing inside one paragraph, and vertical spacing that changed with every block. It now opens under a real header bar that carries the title and the count, uses one spacing rhythm between sections, one uppercase treatment for every section heading and form label, and two text tones instead of five. The empty state reads as a state rather than a stray sentence, and the primary action is an actual primary button. The landing page demo grew from one screen into the app. A rail on the left moves between the Agent Dashboard, Codespace, your project rules and the browser, so you can look around Vector before downloading it \u2014 real clicks, real filtering, no video and no screenshots. The documentation gained four sections for everything added recently: Project rules, the Agent Dashboard board and its filters, running Claude Code, Codex and Cursor including how follow-up turns resume their conversation, and Automations.",
  },
  {
    version: "1.19.91",
    title: "Room to breathe",
    summary:
      "The landing page stopped being a narrow ribbon down the middle of the screen. It had six unrelated container widths \u2014 620, 820, 980, 1080, 1150 \u2014 which on any wide display left most of the screen empty while the content queued up in a column through the centre. There is now one measure for the whole page: 1240px for sections, 1440px for the app preview, and a hero that is wider without becoming harder to read. Feature sections became two columns wherever there is room, with the writing on one side and the interactive preview on the other, and each one alternating which side leads so the run of them stops reading as a single long column. The call to action moved inside the copy it belongs to, instead of orphaning onto a row of its own once the layout split in two. Below 1000px everything returns to a single column, and the line length in the copy stays around sixty characters at every width \u2014 wider was the goal, harder to read was not. Product screenshots were replaced with fixture-driven interface previews you can click: open a sample file, forget a sample memory fact, step through a browser check, pick a deploy target, or pause a sample automation before downloading the desktop app.",
  },
  {
    version: "1.19.92",
    title: "The interface, in the page",
    summary:
      "The demo on the landing page did not look like Vector, and the reason turned out to be simple: it was drawn with the website's palette rather than the product's. The site is near-black with a vivid purple; the app is a grey ramp \u2014 #15141a canvas, #222028 sidebar, #201e27 surfaces, #35313f borders \u2014 with a muted #9274ec. It has been rebuilt from the app's own token file, so the frame, the sidebar, the panels, the type colours and the accent mirror values the product ships. The preview sidebar mirrors the app too: Project tools with Session, Agent Dashboard, Project rules, Code editor, Browser and Canvas, then Connections with Pull Requests, MCP and Plugins \u2014 the same labels, grouping, 32px rows and 7px corners. All nine sample surfaces go somewhere. There is a session view with a fixture transcript, tool calls and a composer; the composer is deliberately inert, because a prompt box on a page with no model behind it can only pretend, and it says so rather than swallowing what you type. The effort control was rebuilt to match its reference: a dark capsule, a blue-to-purple fill, a scattered starfield across it and a white circular thumb. The dots sit on three pitches with no common factor, so they read as scattered instead of as a grid, and at maximum effort the whole field drifts along the bar \u2014 each layer travelling a whole number of its own tiles, so the loop closes with no seam.",
  },
  {
    version: "1.19.93",
    title: "Levels, tickets, and where the money goes",
    summary:
      "The effort control was redrawn around what it actually is. Effort is four or five named levels, not a continuous quantity, so it is now one segment per level rather than a smooth bar \u2014 it reads as three of five at a glance, which a gradient never does, and it stops implying a precision the setting does not have. The lit run uses Vector's own gradient rather than a second palette, and at maximum a single highlight sweeps across it: one moving thing, not a field of them. The landing page gained two things. The first is what engineering work actually looks like: most coding tools stop at the code, but the work starts in a tracker and ends in a review, a deploy and a message to the people waiting. Vector reaches Jira, Linear, Slack, GitHub, Sentry and the rest of the catalogue through MCP, so a ticket is something an agent reads in full rather than something you paraphrase into a prompt \u2014 and the page now walks that round trip, from ticket to pull request to the channel your team is already watching. The second is an honest account of money. Spend is measured from what the provider itself reported, an unmeasured run is recorded as unmeasured rather than as free, and the ledger stays on your machine.",
  },
  {
    version: "1.19.94",
    title: "Where the work comes from",
    summary:
      "Work is the new surface in the rail, and it is the piece that turns Vector from a coding tool into somewhere the job actually starts. It reads the tickets assigned to you \u2014 GitHub issues through your own gh sign-in with nothing to connect, plus Linear and Jira once you paste a token \u2014 and groups them the way you already think about them: in progress, in review, to do, done. Each tracker's own vocabulary is normalised on the way in, so Backlog and Icebox and To Do all land in one column and a board built from three systems still reads as one list. Pressing Start an agent hands the ticket over whole. Not the title retyped into a prompt \u2014 the description, the labels, the link, and the comments underneath, which is where the actual requirement usually hides. The agent is told to read the repository before changing anything and to say so plainly if the ticket is ambiguous or the code contradicts it, rather than guessing. What comes back is an ordinary isolated workspace on the same board, under the same review and merge flow as work started any other way. Every tracker is read independently, so one expired Jira token reports itself and leaves the rest of the board standing instead of quietly emptying it. Also fixed: the install command on the Pull Requests screen. Vector handed out one command per platform \u2014 brew install gh on a Mac, sudo apt install gh on Linux \u2014 and both fail often enough to matter. A Mac without Homebrew answers command not found, and gh is not in Debian's or Ubuntu's default repositories at all. Vector now looks for what is actually installed and only ever prints a command that can run; when nothing on the machine can install it in one step, it offers the download instead of a line that was always going to fail.",
  },
  {
    version: "1.19.95",
    title: "Straight lines",
    summary:
      "Work is gone. It was built last release and it is not what Vector is for, so it has been removed rather than left in the sidebar collecting dust. Four surfaces got the same treatment Automations got. Settings cards had their heading inset at 18px and their contents at 14px, so on every card in the app the title sat very slightly proud of everything beneath it; both are 18px now, the page header carries a rule so it reads as a header, and the Rules page stopped inventing its own form styling with inline styles and uses the shared fields like every other panel. The Agent Dashboard dropped the strip of seven counters above the board \u2014 three of them were Working, Needs you and Done, which are the column headings directly underneath, so it was the same number printed twice \u2014 keeping only what the columns cannot say, and its column headings now share one treatment with the rest of the app. The new workspace panel had three different sizes of uppercase section label in a single dialog, at three different opacities; there is one now. And the code editor's header was painted #101010, a near-black that appears nowhere else in the product and is darker than the canvas it sits on, which is why that screen never looked like the rest of Vector; it uses the sidebar token now. The help assistant also stops repeating the server's own words at you. It has been answering with an internal message about request protection, which describes a problem on our side and gives you nothing to do about it \u2014 it now says plainly that the outage is ours, and where to reach us.",
  },
  {
    version: "1.19.96",
    title: "Tested from the outside",
    summary:
      "Version 1.19.96 is a reliability pass across the path from choosing a repository to shipping the result. Start a session in a different project and Code, Browser, Review, Terminal, Rules, MCP, plugins and the other project surfaces now follow the repository you actually selected; cloud release state remains scoped to that project across chats, and malformed route, event, session or workspace identifiers can no longer become a fake project or send an update to the wrong session. Automations refresh across repository changes and app focus, retain their last good state if a refresh fails and show the error. Rules and local memory also show load and save failures instead of silently looking empty, while manually edited rules and global rules survive synchronization. Vector now probes Claude Code, Codex and Cursor Agent for local sign-in state and stops presenting a runtime as ready when its CLI confirms it is signed out. Follow-up drafts stay with their own workspace, the first Codex response no longer claims the conversation restarted, and abandoned external runs have a bounded timeout and process-tree cleanup. The editor hides dependency and build folders and relies on the workspace language service for TypeScript and JavaScript diagnostics, removing duplicate isolated-file warnings. Trust boundaries received the same pass: browser typing re-checks the focused field before every character it sends, release secret scans fail closed when they cannot inspect the full tree, GitHub CLI discovery uses the user's login-shell path, and teammate messages use durable, idempotent delivery. The website now passes full Astro validation, distinguishes its fixture-driven interface preview from the desktop runtime, discloses that an existing local-memory file is automatically included in built-in agent context sent to the chosen model provider, hands protected card fields back to the user consistently, and keeps its navigation and product totals useful without JavaScript.",
  },
  {
    version: "1.19.97",
    title: "The screens you actually launch from",
    summary:
      "The screen you see when you launch Claude Code, Codex or Cursor Agent was built out of raw white-on-black utilities rather than the product's own palette \u2014 fourteen different text opacities, flat translucent fills, and a one-pixel grey outline around every box. That combination is what reads as black and white and grey lines: a flat rectangle, a hard edge, grey text, no depth anywhere and nothing for the eye to land on. The runtime picker, its setup panel and the external agent transcript are now built from the same token ramp as the rest of Vector. Depth comes from a vertical gradient on a real surface rather than from an outline; there are three text tones instead of fourteen; and the selected runtime is the single accent on the screen, glowing from within rather than gaining a bright border, because a bright border on a dark panel is exactly the look the design system warns against. Status dots carry a coloured halo as well as a hue, so ready, signed out and not installed stay distinguishable at six pixels. Your turn and the agent's turn no longer look like two identical grey boxes: one sits right and lifts, the other sits left and recedes. Project rules are genuinely per-repository. The panel asked the backend for rules without naming a repository, so every project's rules panel listed every project's rules, and deleting one repopulated it with all of them again. It now asks for the repository it was opened for, re-reads when you switch projects, and still lists rules you have switched off \u2014 the prompt filter drops those, and reusing it here made a disabled rule impossible to find and turn back on. Project rules also left the task sidebar. It was a third door to a panel already reachable from the home screen when you pick a repository and from Settings, and the sidebar is for the task you are in. Update Vector works again. It broke in 1.19.96 and the cause was one missing file: a packaged app carries app-update.yml, which tells the updater where its release feed lives, and electron-builder only writes that file when it produces a real installer \u2014 a directory-only build silently skips it. 1.19.96 packaged, signed and launched perfectly with no feed address inside it, so every check died on a missing file and the menu reported only that updates were unavailable. The file is back, and packaging now refuses to finish without it: a build that cannot reach its update feed fails the release rather than shipping. The messages around it are honest too. A build with no release channel says so instead of showing a greyed-out Check now with no reason, and a failed check carries the actual error rather than only offering Try again.",
  },
  {
    version: "1.19.98",
    title: "The download is the release",
    summary:
      "Vector's download now points to one complete desktop release instead of whichever installer happened to be left behind. Mac, Windows and Linux \u2014 on both supported architectures \u2014 are described by the same versioned manifest, and the website and direct downloads both resolve through it. Explicit platform links keep the architecture the user chose, checksums are published beside the files, and every response says exactly which Vector version and checksum it is serving. The release pipeline stages every installer and updater payload first, verifies their names, sizes, hashes and update metadata, and only then changes the public download pointer; a failed or partial build can no longer leave one platform on a different version or cache an old installer as current. Vector can also be downloaded without creating an account or entering an email. Inside the product, the code editor now exposes language-server quick fixes and refactors through its lightbulb menu, including edits spanning files. Packaged builds carry their update feed and fail packaging if it is missing, so Update Vector cannot silently ship disconnected from the release it is meant to find. This interim build is checksum-verified but not Apple-notarized or Windows Authenticode-signed, so the operating system may show an unidentified-developer or unknown-publisher warning.",
  },
  {
    version: "1.19.99",
    title: "Every agent gets the whole workspace",
    summary:
      "Claude Code, Codex and Cursor Agent no longer open in a temporary side sheet. Each runtime now gets the same first-class, full-screen workspace as a Vector agent, with dedicated Chat, Files, Changes, Terminal, Browser and Activity views. You can search the repository, open files as tabs, follow the live transcript, inspect the resulting diff and validations, send another turn into the same conversation, stop a run, merge its work or open a pull request without leaving that workspace. Canvas launches those runtimes through the same canonical parallel-workspace path too, replacing its separate one-shot executor, so isolation, persisted history, status, review, cleanup and merge behavior stay consistent no matter where a run begins. Settings is now a persistent destination in the project navigation instead of a panel users have to rediscover. Together these changes make mixed-runtime work feel like one coordinated engineering system: independent agents and their files remain easy to distinguish, while the editor, browser, terminal and review controls stay in the same predictable places.",
  },
]

export const release199: VectorRelease[] = [
  {
    version: "1.99.1",
    title: "One workspace, two ways to work",
    summary:
      "Vector keeps the familiar project-first workspace with a calmer purple interface and no extra global session-tab strip. Agent and Editor are two views of the same session: search for a file, edit it directly, or ask the agent beside it to make the change. Claude Code, Codex and Cursor Agent now use readable conversations with formatted replies and expandable tool activity, not report cards or raw runtime output. Their file editor keeps the same agent, conversation and follow-up draft beside the code. You can draft while an agent works, stop it without losing your text, and recover a failed send without overwriting a new draft. Runtime streaming preserves repeated text and multi-paragraph answers, including interrupted turns. The Agent Dashboard has matching board and list views for Running, Needs you and Done. Full-screen settings bring searchable categories, consistent typography and Updates & about together; help, browser, terminal and review share the compact shell. Canvas and the Vel control are retired. Session navigation loads additional history correctly and no longer leaves deferred review panels stuck after navigation. Draft projects become real sessions before the editor opens, and isolated project copies establish their baseline before an agent runs so unchanged files are not reported as thousands of edits. Installer builds verify their version and channel; unsigned releases remain manual-download-only and cannot replace signed update feeds.",
  },
  {
    version: "1.99.2",
    title: "Your account, your Vector",
    summary:
      "Vector's download is now an account handoff rather than an anonymous file link. You can create an account with Google or with an email and password, then use one dedicated account page to download the desktop app. Supabase owns customer identity, and Vector no longer exposes a second place to manage customers. The sign-in experience carries the landing page's ASCII matrix atmosphere through registration, email confirmation, and return-to-download flows, while protected download routes require a valid session. The desktop Agent Dashboard is visible again too: it now begins below the native macOS and Windows window chrome instead of underneath it, keeping its title, close control, filters, board, and agent cards readable and scrollable throughout the available window.",
  },
  {
    version: "1.99.5",
    title: "Multiplayer, and an editor that follows the agent",
    summary:
      "Vector becomes a workspace you can share. `vector invite` serves your live workspace over one link: a teammate opens it and lands in the same sessions, files, and agents you are looking at, as a guest with their own credential, and the header shows who is present as people come and go. It works across your network out of the box, or anywhere through a tunnel you already trust. The editor now follows the agent as it types: the file an agent edits opens on its own, scrolls to the lines it changed, tints them in that agent's colour, and carries a labelled cursor, so several agents working at once read like named cursors in a shared document. Your own saves and build output never steal the view, and the whole behaviour is one toggle in the Codespace toolbar. Work can now start from GitHub and come back as a pull request: comment /vector on an issue and Vector opens a branch and a PR whose body carries its own evidence, a table of every file changed, the test, typecheck, lint and build commands it ran with their exit codes and output, what the run cost, and the judge's verdict, with a link back to the run. Underneath, the engine got quieter and more honest. A chatty MCP server can no longer wedge the app by filling its error pipe, and a server that stops answering is dropped and offered for reconnect instead of being cached dead until restart. Sessions are never posted to the public share service unless you opt in, and unsharing always reaches the service, so a session marked private is private. The desktop app finds node and npx again when it was launched from the Dock.",
  },
  {
    version: "1.99.6",
    title: "Cloud that closes the loop",
    summary:
      "Cloud work becomes part of the task instead of a detour. Vector's agent already drove the cloud through one permission-gated tool, checking your connected providers, detecting build settings, preparing a Supabase-backed database or authentication, syncing environment values to the linked host, publishing, and listing deployments. Two things were missing, and both are here. When a deploy misbehaves, the agent reads the recent deployment logs itself and diagnoses from the real build or runtime error, rather than asking you to open a dashboard and paste it back. And the database schema now belongs in your repository: the agent applies the .sql migrations it finds there to your linked database, in filename order, recording which ones already ran so re-running is safe, stopping at the first failure and telling you exactly which file broke and why. A dry run reports the plan without touching anything, and applying a migration asks permission first, because it changes a real database. Publishing already ends with a real browser load of the deployed URL that reports the page and console errors it found, so a deploy is verified rather than assumed. Everything runs on your own Vercel, Netlify, Supabase and AWS accounts. Vector does not host your app, and log tails are truncated and stripped of environment values before the agent ever sees them.",
  },
  {
    version: "1.99.7",
    title: "A database it can create for you",
    summary:
      "Vector can now create your database, not just connect to one you already made. Ask for signup or accounts and the agent offers to create a real Supabase project on your own connected account: it reuses a project you already linked, asks which organization when you belong to several rather than deciding who gets billed, names the project after your repository, generates the database password and stores it encrypted without ever showing it, waits until the project is healthy, then writes the keys and the client into your repository. The result is identical to a project you linked by hand, so status checks, services and migrations all work on it afterwards. The project is recorded before the wait begins, so a run you interrupt resumes the same project instead of creating a second one you pay for, and quota or payment limits are reported in Supabase's own words. Cloud actions also stopped failing when they were only unfinished: an account you have not connected yet now reads as an instruction saying what to connect, rather than as a crashed tool call, which is what it looked like before. Together with the deployment logs and repository migrations added in the last release, the whole cloud loop now runs from inside a task: create the database, write the schema, apply it, publish, check the deployed page in a real browser, and read the logs when something is wrong.",
  },
  {
    version: "1.99.8",
    title: "Subagents that work in parallel",
    summary:
      "Vector's agent now splits its own work the way Claude Code does. When a task is big, spanning several files or areas, splitting into independent parts, or needing research as well as changes, the main agent hands each independent part to a Subagent, a general-purpose worker that takes a single self-contained piece, works through it in its own context and reports back once. It launches them together so they run in parallel, without being asked, and keeps the integration and final checks for itself; a small task, such as a one-file fix or a quick question, it still does on its own. The eight focused agents Vector already had, Explore, Review, Judge, Debug, Test, Security, Performance and Migration, are now Subagent specialists: the main agent chooses one when the work clearly matches it. Subagents can be turned off with the General subagents switch in Settings → Agents, or in the terminal with agent.general.disable in Vector's config file, and the specialists keep working when they are. Subagents appear as cards in the conversation and in a Background tasks panel that shows what each one is doing, how long it has run and what it has used, and whether it finished, failed or was stopped, and running work can be stopped from there. Vector also reviews pull requests. Say yes to automatic review in vector github install and Vector reviews each pull request when it opens and again on every push: one summary comment with the risk and the files that matter, edited in place, and comments on the exact lines, each with a severity and, where it is safe, a fix you can commit from GitHub. It follows the plain-English rules you write in .vector/review.md, and on the next push it reviews only what changed and says what got fixed instead of repeating itself. The vector review command runs the same review on your machine before you push, and Review with Vector in the desktop app's Pull Requests panel reviews a pull request there and lets you post the result. Every review states the model it ran on and what it cost. The editor now follows every agent as it edits, Vector's main agent included, alongside its subagents and Claude Code, Codex and Cursor Agent: the file opens, the change types itself in that agent's colour, and each agent keeps its own labelled cursor. Conversations with Claude Code, Codex and Cursor Agent answer like any other chat, showing whether the agent is thinking or working and for how long, instead of stalling on a working indicator that never ended. The 16-agent limit is gone: Vector runs as many agents as your machine can and says when a large run will strain its processor or disk. The model picker lists every model your connected providers offer, new releases such as GPT-6 Astra included, and no provider is marked Recommended. Vector now opens on a glass launch screen while the workspace loads. This interim build is checksum-verified but not Apple-notarized or Windows Authenticode-signed, so the operating system may show an unidentified-developer or unknown-publisher warning; existing installs get it by downloading it from vectordev.ai rather than through Update Vector.",
  },
  {
    version: "1.99.9",
    title: "Meet Vectorscope, the code review bot",
    summary:
      "Vector's code review system has a name, a command and a front door: Vectorscope. It is the same reviewer that reads the repository around a change rather than the diff alone, now reachable wherever you are working. On a pull request it answers /vectorscope review, /vectorscope review full, /vectorscope pause, /vectorscope resume and /vectorscope fix on a comment; the mentions installed before the name, /vector and /vx, still work, so no workflow needs rewriting. In a terminal, vector vectorscope runs the same review on your branch against its merge base, or on your uncommitted work with --uncommitted, and posts nothing anywhere. In the desktop app the Pull Requests panel reviews a pull request in place and lets you decide whether to post it. Reviews now sign their summary as a Vectorscope review, with the risk, the files that matter, comments on the exact lines with a severity and, where it is safe, a fix you can commit from GitHub, and every review still ends with the model it ran on and what it cost. The documentation was rebuilt around it: every subject is now its own page under /docs with a breadcrumb, the page's own headings beside it, previous and next at the foot, and search across all sixty pages, and the old single-page links still land on the right page. The landing page now carries twenty feature cards covering the browser, agent workspaces, subagents, cloud publishing and the ledger, each sentence checked against the code that ships it. Two more things in this release: you can delete your Vector account yourself, from the account page — it stops the CLI tokens the account issued, after asking you to type your own email address to confirm — and the reviewer is called Vectorscope rather than the name it shipped under this morning.",
  },
  {
    version: "1.99.99",
    title: "Vector is free, updates itself, and agents can change branch",
    summary:
      "Vector is now free: create a free Vector account to download the desktop app, and the same account signs in the terminal agent. Installed copies now update from inside the app: choose Check for Updates and Vector downloads the new release, installs it and restarts. You can change an agent's branch: click the branch name in the session header to switch that checkout to another local branch, or type a new name to create one from the current commit. Vector never stashes or discards your work to switch, and it refuses while a Vector agent is running in that checkout; in agent workspaces Vector manages, you can create a branch but not switch to an existing one. 1.99.99 is the first release with no dependency on the upstream service. Connect a provider with your own API key, sign in with ChatGPT for OpenAI models, or use Connect OpenRouter with your own OpenRouter account; its eligible zero-price models appear under Free models inside of Vector and stop at their limits instead of switching to a paid model, and the free models provided by Vector stay off. The model list is current again, including GPT-6 Astra, GPT-6 Sol, GPT-6.1 Sol and GPT-6 Luna for ChatGPT sign-in, and Vector refreshes it from vectordev.ai when it starts and every hour. On first launch after upgrading, Vector imports your 1.99.8 settings, agents, commands, skills, plugins, MCP servers and permission rules, and keeps the originals. Security fixes keep stored API keys, auth headers and MCP tokens out of what Vector's server sends to connected clients and invite guests (an invite guest still has full access to your workspace, including the terminal, so invite only people you trust), keep Vector's internal secrets out of the integrated terminal, and protect passwordless local servers from rebinding web pages. Cloud connections keep client secrets on Vector's server, project variables keep their names when you change projects, local .env writes preserve literal values, and agent publishing uses one linked destination or asks you to choose; registration of the Cloud sign-ins is still pending. Reliability: stopping a prompt during first startup no longer leaves later prompts stuck, search recovers after an interrupted first lookup, an interrupted workspace no longer hangs shutdown, shell commands keep their final output when a process exits quickly, local plugins resolve JavaScript-style imports to their TypeScript source, and switching agents keeps the selected free model. In the desktop app, agents spend less: subagents start from a much shorter prompt, small fixes and lookups stay with the main agent instead of starting a subagent, explore no longer runs at a model's highest thinking budget, the LLM-as-a-judge instructions are sent once per session rather than with every message, a background subagent's report is capped like any other tool result, and the cost shown for a session includes what its subagents spent. Read-only agents such as explore and review now keep your deny rules and the prompts before reading secret files, and can no longer write files through a shell redirect. Code Archaeology has been removed; Rewind code + chat still takes you back to earlier work. Dialogs have a look of their own, the send button lines up with the composer, the code reviewer is called Vectorscope, crash reports open as editable drafts, and providers without artwork use a neutral Vector icon. The Terms and software licence now include a minimum liability cap. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
  {
    version: "1.99.100",
    title: "Messages work again in the desktop app",
    summary:
      "This release fixes the desktop app, where in 1.99.99 every message failed with \"Bun is not defined\" on macOS, Windows and Linux. Local plugins and skills loaded from a URL failed in the desktop app with the same error, and plugins installed from npm and providers whose SDK Vector downloads on first use could not load there; all of them work now. The 1.99.99 apps for Intel Macs, Windows on Arm and Linux on Arm did not open, because they were built without the terminal component for their processor. 1.99.100 includes it on every platform, and a terminal component that cannot load now affects only terminals. A copy that does not open never reaches its update check, so on those computers download 1.99.100 from vectordev.ai/download with your free Vector account and install it over the old one; your repositories and settings stay where they are. On Windows, Vector's Git commands now follow your Git line-ending and symlink settings: a file whose only change is its line endings no longer shows as edited or blocks switching an agent's branch, and Vector's commits keep the line endings your repository expects. Also on Windows, Claude Code and Codex installed with npm receive the whole Parallel Workspace prompt instead of only its first line, Cursor Agent installed as a command script says it cannot take the prompt instead of running with part of it, detecting these agents no longer fails when one of them or VS Code is installed as a command script, Publish finds Vercel and Netlify CLIs installed with npm, and merge and pull-request checks run npm, pnpm and yarn instead of skipping them. A failed agent check no longer repeats in a loop while the Parallel Workspace composer is open. On Linux, Restart in 1.99.99 and in-app updates to it could open a new, empty profile; 1.99.100 opens your original profile again, so anything you signed in to or set up only in that empty profile needs to be set up again. The terminal agent was not affected and stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
  {
    version: "1.99.101",
    title: "Open a GitHub repository from Vector",
    summary:
      "Besides opening a folder on your computer, you can now open a repository from GitHub: choose Open from GitHub on the Home screen or in the project menu, or press Shift+Cmd+O (Shift+Ctrl+O on Windows and Linux). Pick one of your repositories or paste a GitHub link, choose where to put it, and Vector clones it with a progress bar and opens it like Open Project. Public repositories work without signing in; connect GitHub to see your own and your organizations' repositories and to clone private ones. Vector uses your GitHub sign-in only for the clone and never writes it into the repository, its settings or Vector's logs, and a canceled or failed clone leaves nothing behind and never replaces an existing folder. Push to GitHub now lists only repositories you can push to, and on Windows Vector also finds Git for Windows installed after Vector started. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
  {
    version: "1.99.102",
    title: "A redesigned Changes panel",
    summary:
      "The Changes panel is redesigned. Each changed file is now one row with its name over its folder and its added and removed line counts, under a summary of every file's totals, and a row expands into a short preview of its first change. Opening a file fills the panel with a focused reader instead of a side-by-side diff next to a file tree: one column of line numbers, a + or − beside each changed line, word-level highlights, your line comments inline, and a header with Back, the file's counts, a pager across the changed files, Open in editor, and a menu for the full file, split view (when the panel is wide enough), the previous or next change and Copy path. Back or Esc returns to the list, and a second Esc closes the panel; < and > move between files, [ and ] between changes, and Cmd+F (Ctrl+F on Windows and Linux) finds within the diff. Diffs in the conversation and in file tabs look as before. Background tasks now opens as a floating window by default, beside the Changes panel when there is room; its dock button still docks it, and Esc closes it either way. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
  {
    version: "1.99.103",
    title: "Pull Requests with your GitHub sign-in",
    summary:
      "Pull Requests now works with your GitHub sign-in in Vector, and nothing has to be installed. Open Pull Requests, choose Connect GitHub, enter the code it shows on github.com, and your repository's pull requests appear: list, open, read the diff, create, comment, approve, request changes and merge, and run a Vectorscope review, all from Vector. Failed GitHub Actions runs and their logs come through the same sign-in, cut down to the step that failed. This is the same GitHub sign-in Open from GitHub uses, and the token stays in your computer's keychain; Sign out of GitHub in the panel switches accounts. If the GitHub CLI is already signed in on your computer, Pull Requests uses that login without asking again. When an organization requires single sign-on or approval for Vector, the panel says where to authorize it. Links you click in Vector's browser now open, including Google search results, results that pass through a redirect and links that open a new tab; before, a click that led to another website did nothing. The agent still needs your approval for each new website it visits, and when it is stopped it now names the link so it can ask you for it. Release notes and Changelog in the app open the changelog in the documentation. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
  {
    version: "1.99.104",
    title: "Vectorscope double-checks its reviews",
    summary:
      "Pull Requests is now called Vectorscope, with the same icon, and its screen is redesigned. Reviews are more careful: after the review, a second pass re-reads the code behind every finding above a nit and drops the ones it cannot confirm, and the findings it keeps are marked Double-checked. The reviewers also read the failing CI checks for the commit under review, with the log of the step that failed, the places in your project that use the functions and types the pull request changes, and your project's rules in AGENTS.md (or CLAUDE.md) and .vector/RULES.md. A review runs on the model you last chose for the agent, and its progress line names that model; a model set in .vector/review.json still takes precedence. Comment, Request changes and Approve now post each finding on its own line, with GitHub's one-click suggested change when a fix is safe to commit; if GitHub refuses the line comments, the review goes out as one summary that lists every finding. Dismiss a finding with a reason to leave it out of what is posted, and choose Don't flag this again to save a project rule to .vector/RULES.md that later reviews follow. Fix with agent opens an isolated agent on the pull request's code with the finding as its task: it checks the problem is real, fixes it, runs the tests and commits without pushing. Reviews and merges are pinned to the commit you were looking at, so a push that arrives in the meantime is never reviewed or merged by mistake. The panel no longer reloads itself while agents are running, and its header is no longer hidden under the window's title bar. In Settings, text boxes and buttons no longer sit directly on a section's dividing line, and the search field shows one frame instead of two. Built-in Sign in with ChatGPT is turned off until OpenAI authorizes it: connect OpenAI with an API key, or use the separately installed Codex runtime. If you signed in with ChatGPT before, Vector tells you once and stops using that sign-in. The Terms, Privacy Policy and Software License now name Krishna B / VectorDev.ai and keep your rights under the LGPL for the open-source libraries Vector includes. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
  {
    version: "1.99.105",
    title: "Subagents keep working in the background",
    summary:
      "Subagents now run in the background by default: the agent hands a task off, keeps working with you, and gets an automated report when the task finishes, and tasks that finish together report in one message. A message sent to a running subagent reaches it at its next step, and one that depends on other tasks waits for them. Stopping the agent's turn leaves the subagents it handed off running; stop them all from the background tasks panel. A settings change, such as a new provider key, no longer stops running subagents: Vector applies it once their work ends. Vectorscope can now review your own changes before you commit: Review my changes reviews the staged, unstaged and new files in the open project, as `vector review --uncommitted` does. Set up automatic reviews opens a pull request that adds the GitHub Actions workflow `vector github install` writes, on your agent's model, and lists the repository secrets to add; no API key is sent to GitHub, and Vector asks GitHub for permission to change workflow files only for this. A repository whose workflow reviews only when someone comments /vector review is shown as such. Branch names and pull request references now show in violet. A new install can start free: Start free with OpenRouter, in the composer and in the getting started checklist, connects your own OpenRouter account and selects its best free model, with your draft kept ready to send. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
  {
    version: "1.99.106",
    title: "Agents keep working while your computer is idle, and Sign in with ChatGPT is back",
    summary:
      "While any agent or subagent is running, Vector now keeps your computer from going to sleep, so long runs no longer freeze when you step away; the display can still turn off, and closing a laptop lid still puts it to sleep. When you come back to Vector after it was in the background, or after its connection to the agent engine drops, the open session and its subagent cards reload, so finished subagents no longer stay marked as running. Pressing Stop on a subagent that already finished now settles its card and says so, instead of appearing to do nothing. Sign in with ChatGPT is back: connect OpenAI with a ChatGPT Plus or Pro account to use GPT models. Vector now sends a daily usage count: how many sessions and subagent sessions ran, and, when you are signed in, token totals, recorded cost, the models and effort levels used, and streaks, with the app version and operating system. It never sends prompts, code, file names, model output, keys or IP addresses. Turn it off in Settings, General, Share usage counts.",
  },
  {
    version: "1.99.108",
    title: "Background subagents you can steer, Vercel and Supabase controls, project trust and per-run spend caps",
    summary:
      "Vector now starts batches of up to eight subagents in the background by default, leaving the conversation available while they work. It can explicitly wait when it needs their results, inspect their latest activity, give them new instructions at a safe step, and stop selected tasks or the whole batch. Results that finish together arrive in one notification. The Background tasks panel brings subagents, team members, swarm workers and outside agents into one view, with activity, dependencies, elapsed time and recorded spend. Talk to this subagent sends a correction to a supported running agent; Ask Vector about this adds a progress question to your conversation. Unsupported controls stay unavailable, and missing outside-agent token or cost data is shown as unknown. Individual swarm workers can be stopped, including before they start; their dependent work stops too, and completed changes are retained. Subagents can receive compact context and dependency results instead of rereading whole conversations. Scoped messages have size and rate limits, explicit file edits respect assigned paths, and child and batch spend caps stay under the launching run's Run Guard. After an engine restart, interrupted tasks keep their records and partial results and require an explicit continuation. The new vector tasks commands and the TUI's /tasks panel inspect, message and stop work; headless vector run waits for background results with a finite timeout. These terminal features need the new standalone CLI release and are not added to an already installed older CLI or WSL engine by a desktop update. Offline scripted comparisons are published with the benchmark method; they do not establish live price, speed or quality parity. Vector Cloud now runs your Vercel and Supabase accounts from the workspace, and supports only those two: Netlify, the read-only AWS inventory and Vector's own hosted publish target are removed, so Vercel is the only place the agent publishes. A Netlify connection saved by an earlier version is deleted from this computer on first launch; the access you granted Vector stays on your Netlify account until you remove it there. For Vercel: projects, deployments with Promote, Roll back and Redeploy, environment variables and domains. Publishing now makes a preview unless you choose production, where 1.99.106 went straight to production, and Vector no longer adds a Deployed with Vector badge to your site's index.html. Domains are read from the Vercel project itself; the domain records earlier versions kept on this computer are no longer read. For the linked Supabase project: the database, with the exact SQL shown before it runs, migrations, storage limits, functions, logs and security checks, and a new organization when your account has none. Vector's migration history moves from public.vector_migrations to a private vector.schema_migrations table: on the next migration run Vector copies the old rows into your Supabase database's new table and drops the public one, counts migrations the Supabase CLI recorded as applied, and stops before applying anything if an applied migration file was edited. The agent has the same controls as the Cloud screens, and Logs, Database logs and Security can hand what they show to the agent. Every change to a cloud account asks each time, with no Always allow, even in automatic mode, and that includes vercel and supabase commands in the shell and release or settings buttons on their dashboards in Vector's browser. Disconnecting a sign-in also asks Vercel or Supabase to remove Vector's access, and says so when they did not confirm it. In a project you have not trusted, Vector ignores the project's own settings, commands and skills and does not start your language servers, formatters or MCP servers there. Nothing carries over from earlier versions, so after updating each project asks once: choose Trust project in the session header to load its settings again, and changing those settings asks again. Invited guests can no longer switch on tools in their own sessions, commit, switch branches or write inside .git, and they see and add to sessions only in their own workspace. Shell commands that read a .env file now ask like the read tool, a git diff that would print files outside the work tree is checked like a file read, file writes are checked where they really land, and an MCP server's sign-in opens only web pages. Vector's own helpers, such as Vectorscope reviews, Codespace edit and autocomplete, the Browser Agent planner and the swarm planner, stay inside the screen that started them and never show up as sessions, in session lists, notifications or session counts; the session that started them shows their tokens and cost, including for stopped and failed work. The Run Guard caps what one run spends: set it in Settings, Spend limits. Vector estimates each next step and stops before one that would cross the cap, within one step for each agent running, and subagents and helpers count against the same cap. Under a dollar cap, a model with no catalog price stops after 40 unpriced steps, and Vector Codium steps count as unpriced; free models and ChatGPT plan steps are not counted in dollars. An agent that gets the same result from the same tool call, or the same error, three times in a row is paused, a provider outage ends after 10 retries or 15 minutes, and the stop card says why and offers Continue. Sessions keep stable prompt prefixes so providers can reuse their caches, ChatGPT conversations can continue over a WebSocket connection, history is downloaded again less often, titles no longer hold up the first answer, an edit and its check can share one response, and Vector loads the packages for language servers, MCP, GitLab, PowerShell and telemetry only when they are used. Background subagents and agent swarms are steadier: Stop and Discard finish even when the engine stops answering, swarm workers merge into staging one at a time, a conflicting merge is refused before anything is written and one that stops part-way is undone, Resume no longer reruns a task that had already merged, and the computer stays awake while agents in parallel workspaces or their checks run. Vector Codium is built in for when sales open: a Vector Codium provider then appears in the model picker, Vector never picks it on its own, not even for an attached image, and Settings shows the share of this month's credits left and whether purchased credits are available, running low or used up, never an amount. The /codium page lists $10, $50, $100 and $200 monthly plans and top-ups, and its buttons say Coming soon until sales open. Models included with Vector, through your own free OpenRouter account or the free models provided by Vector while they are on, now follow a no-training policy: Vector offers only free models it has checked with the provider allowlisted to serve them, every request asks OpenRouter to deny data collection, and providers may still keep prompts under their own policies, as the model picker now says. Earlier versions used only zero-data-retention providers, so Vector tells you this once, the first time you send to one of these models. The branch button in the session header is a neutral chip again, and Vectorscope's pull request header and pull request numbers look as they did before 1.99.105. The bottom of the sidebar shows who is signed in, with your Google profile photo (or your initial) and your name or email, and opens Settings; signed out, it offers Sign in to Vector. A saved Light theme, or Follow system on a light system, now applies from launch rather than only after switching it in Settings, and a server's menu in Settings opens above Settings, so a server can be edited, made the default or deleted there. Sign in with ChatGPT remains available. The npm CLI stays at 1.99.99, and vectordev.ai/install currently installs a CLI build numbered 1.99.107 from 11 October, which predates these changes, so vector trust, vector codium, vector tasks, the TUI's /trust and /tasks, and vector run --max-cost and --max-steps arrive with the next CLI release. Windows WSL servers also keep running the 1.99.99 engine this desktop requires until a later desktop release requires the new CLI, so on a WSL server the shell prompts for cloud commands and .env reads, the git diff checks, project trust, the Run Guard, loop pauses and the new subagent controls do not apply yet. The guest limits apply to vector invite from the next CLI release, because vector invite runs from the CLI. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
  {
    version: "1.99.109",
    title: "Simple messages stay simple, free models on your Vector account, billing in the app and one spend limit",
    summary:
      "A greeting or a thank-you now gets a direct answer in one small request, with no tools or extended thinking, and everything else runs with the normal tools at the model's usual effort. Subagents and high effort come in only when you ask for thoroughness, for example \"be thorough\" or \"use subagents\", or when the agent finds the work is large; the LLM-as-a-judge, when you switch it on in Settings, checks large tasks that changed files, or every task that changed files if you choose. Free models inside of Vector now cover every free OpenRouter model that can use tools, plus OpenRouter's Free Models Router, provided by Vector to anyone signed in to Vector, with no OpenRouter account of your own. Free models whose providers may train on prompts are labelled May train on your prompts and are used only after you accept once, and invited guests never reach them. Settings, Account shows who is signed in, your Vector Codium plan, its renewal and the share of this month's credits left; buying credits, subscribing, changing or cancelling a plan, updating your card and invoices open Stripe's own pages in a Vector window, and deleting your account is confirmed in Vector after you sign in again in your browser. Codium sales are still closed, so those buttons say Coming soon. Clicking your name opens Account, and when an update is ready the Update button takes the Settings gear's place, on Home too, and asks before restarting while agents are running. Spend limits are now one overall set per run, per day and per month across all your repositories: the per-repository monthly limit from 1.99.108 is dropped on update, and a repository's own budget.run is ignored with a one-time notice. Settings no longer has the rules, Appearance, Editor, Chat, Voice or Personalization pages: Vector always uses its dark look and your computer's language, Vector Tab turns on and off from the editor's status bar, and repository rules live in .vector/RULES.md, where deleting or editing a line in Vector's section removes or changes that rule. Vector calls your folders repositories everywhere. A repository with its own Vector settings asks once whether to trust it and remembers the answer, repositories created in Vector are trusted automatically and clones always ask, and until you trust one your language servers, formatters and MCP servers stay off in it. Vector Cloud now opens from Home; its button, the database banner and Publish are gone from inside a task. Vectorscope's Apply fix works and refuses to write over lines that changed since the review, an optional triageModel in .vector/review.json runs a cheaper first pass that the review model double-checks, only confirmed findings are posted, a repeated finding names every place in one comment, and a GitHub review that cannot start says which secret or model is missing. The read-only agents (explore, review, judge and security) now refuse shell commands Vector cannot fully check, such as hidden command substitutions, and other agents ask before running them; allow rules, including Always allow answers, no longer approve them. Redirects through a link that points outside the repository ask first, and a linked rules file is never read into a prompt. GitHub reviews and the terminal get these Vectorscope, sizing and shell changes with the next CLI release, and Windows WSL servers keep running the 1.99.99 engine until a later desktop release requires the new CLI. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
  {
    version: "1.99.110",
    title: "The self-evolving AI agentic harness: Vector Brain learns about you, your company and each repository",
    summary:
      "Vector now keeps a brain on this computer, one for you and one for each repository: the rules you write, your MEMORY.md, what you ask it to remember, what it learns while it works, and what your company's specs, PDFs, runbooks and API descriptions say once you give them to it. Every request but a greeting carries your rules, about the first 800 tokens of MEMORY.md, where 1.99.109 sent the whole file, and the entries you pinned, then recalls only the few lines that bear on it, within a budget set by the request's size. A greeting or a bare \"ok\" carries none of it unless work is waiting on it. Vector saves a short lesson, decision or preference when you state one, when a fix makes a failing check pass, or when a lasting decision is made, and uses it from the next request. Each one shows as a Learned line in the session and under Recently learned in the new Settings → Memory page, with Undo; after Undo, Vector does not save the same words, or a close rewording, for 180 days. What it learns in a session that read web pages or other outside content, ran MCP tools, or had a guest or a subagent in it waits for your review. A card or memory entry an answer cited in a run whose checks went from failing to passing gains weight in recall, and one cited in a run you reverted loses it. Add documents in Settings → Memory → Documents, or choose Remember or Remember instead on a file you attach: PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), Markdown, HTML, OpenAPI, JSON, YAML, CSV and text. Vector reads each one on this computer into sections, passages and typed records, such as requirements, constraints, decisions, contracts and procedures, and brings the few that bear on a request in as short cards. A cited card shows as a chip naming the kind of record, the document and the page, and counts as verified only when Vector gave that card to the model in the session. Pictures of text, such as scanned pages, are named but not read. In a repository you trust, Vector also reads its own READMEs, docs folder, decision records and API specs. Each record is linked to the code that defines, uses or serves what it names, so a requirement comes in when you open its code, or a file that imports it, even when the request shares no word with it, and editing a file linked to a requirement asks the agent to check the change still meets it. When linked code and a document stop agreeing, Needs a look shows both sides, for example \"The document says 50 MB; the code says 64 MB\", with the line in the code, and it lists documents, rules and memory that disagree with each other; only you settle them. An optional local search model, a one-time 24 MB download you ask for in Settings → Memory → Search model, also finds the passages that say what a request means in other words. It runs on this computer, and until you download it, documents are searched by keywords and code links; its full-precision fallback is not yet verified, and the Code-aware model is a preview. Everything the brain keeps is stored and searched on this computer, and beyond your rules, the start of MEMORY.md and the entries you pinned, each request sends your model only the few lines that bear on it. Your MEMORY.md and personal memory (not your rules), private documents and what Vector learns from them never go to a free model labelled May train on your prompts or to a session a guest is in. Vector removes what looks like a secret from what it reads before saving it, and keeps no copy of a file you add unless you turn on Keep copies of added files; a kept copy is the file as you added it, secrets included. Let Vector learn as it works turns learning off, Read this repository's docs stops Vector reading a repository's own docs and forgets what it read of them, Tidy and erase erases what Vector learned and leaves the files you wrote alone, and a session that read outside content asks every time before a tool changes RULES.md, BRAIN.md or MEMORY.md. Deleting your Vector account does not reach the brain, because it is on your computer. Your MEMORY.md is the same file, now edited on the Memory page instead of Settings → General, and what Vector records about checks that fail in a repository, and the repairs that worked, moves from the repository's .vector folder to Vector's data folder on this computer, so a commit no longer takes it along; Vector copies an existing .vector/failure-memory.json and does not delete it, so it stays in the repository until you delete it. Free models inside of Vector are now labelled Provided by Vector, and their limit notices, which already gave a reset time, now say when they are expected to be available again. When an update cannot be installed, Vector points you to vectordev.ai/download with your free Vector account. The agent's search no longer fails when a matching line is not UTF-8 text. Vectorscope reviews in the desktop app do not get linked requirements yet; vector review in the terminal gets them, and vector memory comes to the terminal, with the next CLI release. Windows WSL servers keep running the 1.99.99 engine, without the brain, until a later desktop release requires the new CLI. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
  {
    version: "1.99.111",
    title: "Deep research preview, Vector Local, and new model choices",
    summary:
      "Deep research arrives in preview with editable plans, Focused and Deep modes, isolated research browsers, and reports linked to source quotes. It makes no code changes. Research searches in each agent's own browser, with a fallback when search is blocked, and does not solve CAPTCHAs, disguise the browser or rotate addresses. Vector Local adds desktop controls for the model servers you choose, web access, and an origin-based request log. It is a policy inside Vector, not a firewall; programs the agent starts have separate network behavior, and Windows has no shell sandbox. Settings → Memory → About you makes learned preferences editable and undoable, and more Vector agents can use relevant preferences. Host locally keeps installed coding agents under the owner's control, with up to four running at once, explicit Try a fix actions, and exclusions from background work, learning, training and benchmark exports. The model picker separates free models provided by Vector from your own provider choices, with your own OpenRouter free copies under OpenRouter and labelled (free). Eligible new free models join the daily refresh, with training-policy consent and US only tags where applicable. The Codium catalog and pricing page now feature DeepSeek V4.1 Flash 1017, Claude Haiku 5.5, GPT-6 Luna, Kimi K3.1 Pro, and Gemini 4 Argon; DeepSeek is listed first and is the default, and Kimi and Gemini use credits faster. Model download notices clear when the model is ready. The required CLI remains 1.99.99; desktop connections to older engines explain which newer features are unavailable, and Vector Local prevents an older WSL engine from starting. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
  {
    version: "1.99.112",
    title: "Agent terminals and browser controls, research cleanup, and first-launch help",
    summary:
      "The agent can manage its own terminals and browser tabs, with terminal activity visible in Vector. Asking Vector to save or keep completed research uses Keep in brain, and erasing memory also forgets Deep research runs. Vector Local explains which information it could not read and lets you try again. On macOS, Vector reads its stored credential from Keychain once per launch. A first-launch guide helps new users get started, Settings stays open when the shell list is unavailable, and keyboard shortcuts and the shell picker are available in Settings. Website privacy and account handling are updated. The required CLI remains 1.99.99, so terminal and older WSL engine features still require a separately published CLI. Deep research remains a preview. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  },
]
