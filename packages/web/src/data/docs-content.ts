import { release199, upcomingRelease } from "./vector-releases"

// The tables and lists the documentation pages interpolate.
export const spendRows = [
  [
    "Measured tokens, catalog prices",
    "Token counts come from what the provider reported: input, output, reasoning, cache reads and cache writes. Dollars are those tokens at the model catalog's list price, so plan billing, discounts and negotiated rates are not reflected.",
  ],
  [
    "Unmeasured is not free",
    "In the spend ledger, a run whose provider reported no usage is recorded as unmeasured rather than as zero, because a fabricated zero reads as free and quietly poisons every total built on top of it.",
  ],
  [
    "The ledger is yours and it is local",
    "Spend is kept in a file on your machine, with daily totals retained far longer than the raw events behind them. Vector reads it before an automation or parallel agent starts, and refuses the start once a cap is already spent.",
  ],
  [
    "Your keys, your bill",
    "Connect your own provider account to start. From 1.99.99, guarded personal OpenRouter free access works independently of the free models provided by Vector, which a signed-in Vector account gets only while Vector's service has them switched on. Keep that account free: no credit purchase, payment method, automatic top-ups, paid upstream BYOK credentials, or default or enforced paid plugins. When free limits or eligible endpoints are unavailable, wait; the guarded route does not switch to paid models or providers. Other provider connections have their own pricing.",
  ],
]

// The Run Guard shipped in desktop 1.99.108; the terminal UI and vector run and its flags get it with the next CLI
// release, and WSL servers with the later desktop release that requires that CLI. One overall set of limits, with
// a repository's own budget.run ignored, lands in desktop 1.99.109. Keep these in step with the Tokenomics and
// Permissions pages.
export const runGuardRows = [
  [
    "Where caps come from",
    "Settings → Spend limits in the desktop app, for its chats and the parallel agents you start; budget.run in the terminal's user config (~/.config/vector/vector.json, or %USERPROFILE%\\.config\\vector\\vector.json on Windows) for the terminal UI and vector run, which the desktop app does not read; or vector run --max-cost and --max-steps for one run. Automations use the Left alone limits: $5 a run and $25 a day unless you change them.",
  ],
  [
    "One set of limits for every repository",
    "From desktop 1.99.109, spend limits are overall: the day and month limits count spend in all your repositories together, and the per-repository monthly limit in Settings → Spend limits is gone, so set a monthly limit instead. A repository's own budget.run in its vector.json or .vector settings is ignored too, trusted or not, and Vector says so once for each repository file that still sets one, not again for the repository's agent worktrees or copies. Desktop 1.99.108 still reads a repository's budget.run. The terminal UI and vector run follow with the next CLI release, and Windows WSL servers once a later desktop release requires that CLI.",
  ],
  [
    "A stop before the step that would cross",
    "After a step, Vector estimates the next one from catalog prices and the context it carries, shows the estimate as a range, and stops before starting a step that would go over the cap. One step can still cost more than its estimate, and subagents running side by side each finish the step they are on, so a run stops within one step of the cap for each agent running at the time.",
  ],
  [
    "Subagents and helpers share the cap",
    "Spend from subagents, and from Vector's own helpers such as a Vectorscope review started during the run, counts against the same cap as the task that launched them. A helper you start after the run has ended runs under its own limits.",
  ],
  [
    "Automations and parallel agents hold while they run",
    "An automation or a parallel agent gets the headroom left in your limits as its live cap, up to the per-run limit. With no per-run limit it holds half of that headroom, so a run that starts beside it is not shut out, and runs going at the same time share the headroom instead of each spending all of it.",
  ],
  [
    "Unpriced is not free",
    "With a dollar cap set, a model with no catalog price stops after 40 unpriced steps, because its spend cannot be counted. A step whose provider reported what it charged, as OpenRouter does, counts at that amount. Vector Codium steps spend Codium credits, whose charge stays on vectordev.ai, so they count as unpriced steps. Free models are labelled free, and steps a plan pays for, such as a ChatGPT sign-in, are not counted in dollars; step and loop limits still hold both.",
  ],
  [
    "Loops pause themselves",
    "In chats, the terminal UI and vector run, an agent that gets the same result from the same tool call three times, with no file change and no call that returned something new in between, or hits the same error three times in a row, is paused. Checking a page between clicks or running git status between commands returns something new each time, so it runs on. Auto-approve and --yolo cannot click through a pause. Set budget.loop.enabled to false to turn this off.",
  ],
  [
    "Outages end",
    "In chats, the terminal UI and vector run, a provider outage ends the run after 10 retries or 15 minutes instead of retrying forever.",
  ],
  [
    "A way to continue",
    "The stop card says why the run stopped and what it spent. Continue starts a new run with a new cap of the same size, or with a new step limit, and the stopped turn stays in the history so the agent picks up where it was. A subagent spends under its main session's run, so its stop card points to the main session, where a new message or Continue starts the new run.",
  ],
  [
    "Made for scripts",
    "vector run exits with code 3 when a spend cap, step limit or loop pause stops it, so CI can tell a budget stop from a failure.",
  ],
]

// What each request size may recall from the brain, from desktop 1.99.110 (Brain.recallBudget and
// BrainKnowledge.budget in packages/core; test/brain-docs.test.ts checks the two agree).
export const brainBudgetRows = [
  ["Chat", "Nothing: a greeting recalls no memory and no documents."],
  ["Light", "Up to 200 tokens, or 300 in a repository with documents."],
  ["Standard", "Up to 300 tokens, or 500 in a repository with documents."],
  ["Thorough", "Up to 500 tokens, or 900 in a repository with documents."],
]

// Deep research's default caps for one run, from desktop 1.99.111 (ResearchPlan.LIMITS in packages/core;
// test/release-111-docs.test.ts checks the two agree). They apply only when the user has no spend cap of their own.
export const researchCapRows = [
  ["Focused", "$1, 80 steps, 15 pages, 8 searches and up to 2 researchers."],
  ["Deep", "$3, 240 steps, 40 pages, 24 searches and up to 4 researchers."],
]

// Who gets what Vector learned about the owner, from desktop 1.99.111 (section 6.4a of the build plan: Brain.HABITS
// and the research facets in packages/core; test/release-111-docs.test.ts checks the budgets agree).
export const memoryRoleRows = [
  ["Main agent", "How you work and facts about you, as in desktop 1.99.110, for build and plan."],
  [
    "Subagents",
    "Up to 100 tokens of how you work at every size, recalled with the task. A Thorough request's subagents also get up to 200 tokens of the cards and memory that bear on the task.",
  ],
  [
    "Vectorscope",
    "Up to 300 tokens of how you review, chosen with the changed paths and file types, never with the pull request's own text. A pull request Vector cannot trust, such as one from a fork, gets your preferences, review notes and rules only. Vector tells reviewers that no memory line drops or downgrades a security finding or a blocking one.",
  ],
  [
    "Deep research",
    "The research lead recalls how you work and the private documents its scope allows, beside what every request carries. Researchers get the formats, sources and style you prefer, and the citation judge the sources you prefer. A research run the build agent starts gets how you work and the private documents its scope allows, and nothing else private.",
  ],
  ["Titles, summaries and compaction", "Nothing."],
]

// vector memory, as packages/engine/src/cli/cmd/memory.ts describes each command.
export const brainCommandRows = [
  [
    "vector memory list",
    "Rules, saved preferences and what Vector learned. --learned lists what it put in use on its own, newest first, and --review what waits for you.",
  ],
  ["vector memory search <query>", "Search memory the way the agent does."],
  ["vector memory show <id>", "One entry with its evidence."],
  ["vector memory add <text>", "Save something for Vector to remember."],
  ["vector memory edit <id> <text>", "Change the text of an entry Vector learned."],
  ["vector memory pin <id>", "Keep an entry in every request; unpin stops."],
  ["vector memory approve <id>", "Let Vector use an entry that waits for your review; reject deletes it."],
  ["vector memory undo <id>", "Take back what Vector learned; it will not learn it again."],
  ["vector memory forget <id>", "Delete an entry for good."],
  ["vector memory tidy", "Merge duplicates, drop what waited too long for review, and archive what goes unused."],
  ["vector memory learning on|off", "See or set whether Vector adds to its memory as it works."],
  [
    "vector memory export",
    "Print memory as Markdown: entries with their evidence, and what Vector read from documents.",
  ],
  [
    "vector memory erase",
    "Erase what Vector learned in this repository, with its Deep research runs; --personal for what it learned about you, --everywhere for all of it and every run. Files you wrote are left alone.",
  ],
]

// vector memory doc and its neighbours, as packages/engine/src/cli/cmd/memory-doc.ts describes them.
export const documentCommandRows = [
  [
    "vector memory doc add <files>",
    "Keep files as documents; - reads Markdown from stdin, for any converter's output. --replace reads a file with the name of a document here as its next version.",
  ],
  ["vector memory doc extract <file>", "Show what Vector would learn from a file, storing nothing."],
  ["vector memory doc list", "The documents Vector keeps for this repository."],
  [
    "vector memory doc show <id>",
    "A document's outline and counts; --records, --page, --anchors and --held show its records, one page, its code links or what waits for review.",
  ],
  [
    "vector memory doc search <query>",
    "Search documents by keywords, and by meaning once the search model is downloaded, the way the agent does; --why says which words each result matched, or that it was found by meaning.",
  ],
  [
    "vector memory doc read <id> [part]",
    "Read a document's outline, a section (3.2 or a heading), a page (p14), or one record or passage.",
  ],
  ["vector memory doc forget <id>", "Forget a document and every version of it."],
  ["vector memory links <file>", "Which documents and memory are linked to a file of this repository."],
  [
    "vector memory review",
    "What needs a look: documents and memory that disagree, code that drifted, and held content. vector memory review resolve settles an item.",
  ],
  ["vector memory repo-docs on|off", "Whether Vector reads this repository's own docs."],
]

// vector memory model, as packages/engine/src/cli/cmd/memory-doc.ts describes it.
export const modelCommandRows = [
  [
    "vector memory model status",
    "Whether the search model is downloaded, how it was checked on this computer, and how much of this repository's documents it has embedded.",
  ],
  [
    "vector memory model download",
    "Download it once, after it shows the size, license and source and asks; --yes skips the question, --code-aware takes the Code-aware preview, and --full-precision the full-precision model, which is not yet verified.",
  ],
  [
    "vector memory model install --from <folder>",
    "Install it from a folder of its pinned files, for a computer with no network.",
  ],
  ["vector memory model pause", "Hold embedding in the background; resume goes on with it."],
  ["vector memory model remove", "Delete the model and the vectors made with it."],
]

// The knowledge eval's dated report (docs/benchmarks/vector-knowledge-meaning-2026-10-19, generated by
// packages/core/script/knowledge-eval.ts). Every number the site gives about the brain comes from it, and
// test/brain-docs.test.ts checks each one against report.json. `report` is for that test; the pages do not name it.
export const knowledgeEval = {
  date: "19 October 2026",
  report: "docs/benchmarks/vector-knowledge-meaning-2026-10-19",
  summary:
    'On the knowledge eval of 19 October 2026, recall through code links brought in the governing requirement for 40 of 40 tasks that named the files they touch, against 1 of 40 by keywords alone, and for 8 of 8 tasks that edited a file which only imports the governed one, where spreading activation over code links found 0 of 8. A Light request carried 131 tokens on average, and 10 unrelated requests, "hi" among them, carried none at any size.',
  caveat:
    "The eval is five short specs for a small invented repository and 58 requests, written alongside the feature, with no language model call. It is not an independent benchmark.",
  meaning:
    "With the search model, the same requests found the governing requirement for 13 of 40 tasks by keywords and meaning alone, with no code links, against 1 of 40 by keywords alone; with every channel at once, for 40 of 40, and 8 of 8 through an import. The 10 unrelated requests carried no tokens with it either.",
  floor:
    "The least score a match by meaning needs, 0.2, was set on this same eval. There the unrelated requests carried no cards from 0.18 up, and at 0.17 one of them carried 122 tokens, so the floor sits 0.02 above the least that kept them out, and these figures are not an out-of-sample result.",
}

// The engine's eight subagent specialists (packages/engine/src/agent/agent.ts)
// and the display identities painted over them. `general` is not listed: it is
// the general-purpose Subagent described in `subagentKinds` below. Roles restate
// the engine descriptions and the labels mirror the real permission sets.
// Explore, review, security and judge cannot write (readonlySpecialistBoundary),
// so no card promises more than its agent is allowed to do.
export const crew = [
  {
    label: "explore",
    name: "Explore",
    summary: "Finds code fast",
    hue: 25,
    readOnly: true,
    role: "Finds files by pattern, searches code for keywords, and answers questions about how the codebase works. Runs on your provider's small model when one is available. Never edits.",
  },
  {
    label: "judge",
    name: "Judge",
    summary: "Verifies completion",
    hue: 265,
    readOnly: true,
    role: "Scores finished work against the original request and returns PASS, FAIL or INCONCLUSIVE. Verified completion relies on it, and Vector can also call it for an independent check. Never edits.",
  },
  {
    label: "debug",
    name: "Debug",
    summary: "Finds root causes",
    hue: 95,
    readOnly: false,
    role: "Reproduces a failure, isolates the cause, applies a focused repair and re-checks that it holds.",
  },
  {
    label: "migration",
    name: "Migration",
    summary: "Upgrades safely",
    hue: 200,
    readOnly: false,
    role: "Plans and stages framework, dependency, API, schema and configuration upgrades across compatibility boundaries.",
  },
  {
    label: "performance",
    name: "Performance",
    summary: "Makes it faster",
    hue: 45,
    readOnly: false,
    role: "Measures a baseline, then optimises slow runtime paths, builds, bundles, queries and rendering against it.",
  },
  {
    label: "review",
    name: "Review",
    summary: "Reads the diff",
    hue: 320,
    readOnly: true,
    role: "Inspects a change for correctness, regressions, missing tests and maintainability, with file and line. Never edits.",
  },
  {
    label: "security",
    name: "Security",
    summary: "Checks the boundaries",
    hue: 220,
    readOnly: true,
    role: "Reviews trust boundaries, authentication, secrets, injection risk and unsafe data flow. Never edits.",
  },
  {
    label: "test",
    name: "Test",
    summary: "Writes coverage",
    hue: 175,
    readOnly: false,
    role: "Designs focused coverage, writes or repairs tests, runs the suite and reports failures with evidence.",
  },
]

// The two kinds of agent Vector's agent hands work to. "Subagents" are the
// engine's `general` agent; "Subagent specialists" are the agents in `crew`
// above plus any agent a user defines. Checked against
// packages/engine/src/agent/subagent-kind.ts and src/tool/task.txt.
export const subagentKinds = [
  [
    "What they take on",
    "A subagent takes any self-contained piece of the task. A subagent specialist takes only the kind of work it is named for.",
  ],
  [
    "When Vector uses them",
    "Vector's agent decides on its own, and it delegates only when splitting the work costs less than doing it. An independent part that is substantial on its own, roughly five or more files or a long check-and-repair loop, or broad research that would flood its context, goes to a subagent, and several such parts are launched together so they run at the same time while the agent keeps the integration and the final checks. Each subagent starts with a fresh context and re-reads what it needs, so ordinary multi-file changes, fixes, lookups and answers it does itself. It calls a specialist when part of the task fits that specialist's focus. You do not have to ask for either.",
  ],
  [
    "How many",
    "A small task gets no subagents; a big one gets one per independent part. Vector sets no cap on either kind. Your computer and your provider's rate limits are the practical limits, and each one spends its own tokens.",
  ],
  [
    "While they run",
    "By default the main agent waits for their results, then carries on with what they found. In the desktop app it can also leave one running in the background while it does other work, and picks up the result when that one finishes.",
  ],
  [
    "Who they answer to",
    "The main agent. Each one works in its own context and reports back to it once, when it finishes. They cannot ask you questions, though they still ask for permission the way the main agent does, and the main agent tells you what they found.",
  ],
  [
    "What they can change",
    "A subagent can read, edit and run commands like the main agent. Explore, Review, Judge and Security can read your repository and run checks, but they cannot edit it. Debug, Test, Performance and Migration can edit.",
  ],
  [
    "Where they work",
    "In your session's checkout, not a separate worktree. Vector refuses to start one whose assigned paths overlap another running subagent's.",
  ],
  ["How deep", "One level. By default, subagents cannot start subagents of their own."],
  [
    "In Plan mode",
    "Vector does not start subagents, and of the built-in specialists it uses only Explore, Review and Security, which cannot edit.",
  ],
  [
    "Turning them off",
    "Subagents are on by default, and you can turn them off in Settings → Agents or in Vector's config file. Subagent specialists are not affected and keep working.",
  ],
]
export const changelog = [
  [upcomingRelease.label, upcomingRelease.title, `${upcomingRelease.summary} ${upcomingRelease.status}`],
  // The notes the desktop app shows as What's new for these releases, word for word.
  ...["1.99.112", "1.99.111", "1.99.110", "1.99.109"].flatMap((version) =>
    release199
      .filter((release) => release.version === version)
      .map((release) => [`October 2026 · ${version}`, release.title, release.summary]),
  ),
  [
    "October 2026 · 1.99.108",
    "Background subagents you can steer, Vercel and Supabase controls, project trust and per-run spend caps",
    "Vector now starts batches of up to eight subagents in the background by default, leaving the conversation available while they work. It can explicitly wait when it needs their results, inspect their latest activity, give them new instructions at a safe step, and stop selected tasks or the whole batch. Results that finish together arrive in one notification. The Background tasks panel brings subagents, team members, swarm workers and outside agents into one view, with activity, dependencies, elapsed time and recorded spend. Talk to this subagent sends a correction to a supported running agent; Ask Vector about this adds a progress question to your conversation. Unsupported controls stay unavailable, and missing outside-agent token or cost data is shown as unknown. Individual swarm workers can be stopped, including before they start; their dependent work stops too, and completed changes are retained. Subagents can receive compact context and dependency results instead of rereading whole conversations. Scoped messages have size and rate limits, explicit file edits respect assigned paths, and child and batch spend caps stay under the launching run's Run Guard. After an engine restart, interrupted tasks keep their records and partial results and require an explicit continuation. The new vector tasks commands and the TUI's /tasks panel inspect, message and stop work; headless vector run waits for background results with a finite timeout. These terminal features need the new standalone CLI release and are not added to an already installed older CLI or WSL engine by a desktop update. Offline scripted comparisons are published with the benchmark method; they do not establish live price, speed or quality parity. Vector Cloud now runs your Vercel and Supabase accounts from the workspace, and supports only those two: Netlify, the read-only AWS inventory and Vector's own hosted publish target are removed, so Vercel is the only place the agent publishes. A Netlify connection saved by an earlier version is deleted from this computer on first launch; the access you granted Vector stays on your Netlify account until you remove it there. For Vercel: projects, deployments with Promote, Roll back and Redeploy, environment variables and domains. Publishing now makes a preview unless you choose production, where 1.99.106 went straight to production, and Vector no longer adds a Deployed with Vector badge to your site's index.html. Domains are read from the Vercel project itself; the domain records earlier versions kept on this computer are no longer read. For the linked Supabase project: the database, with the exact SQL shown before it runs, migrations, storage limits, functions, logs and security checks, and a new organization when your account has none. Vector's migration history moves from public.vector_migrations to a private vector.schema_migrations table: on the next migration run Vector copies the old rows into your Supabase database's new table and drops the public one, counts migrations the Supabase CLI recorded as applied, and stops before applying anything if an applied migration file was edited. The agent has the same controls as the Cloud screens, and Logs, Database logs and Security can hand what they show to the agent. Every change to a cloud account asks each time, with no Always allow, even in automatic mode, and that includes vercel and supabase commands in the shell and release or settings buttons on their dashboards in Vector's browser. Disconnecting a sign-in also asks Vercel or Supabase to remove Vector's access, and says so when they did not confirm it. In a project you have not trusted, Vector ignores the project's own settings, commands and skills and does not start your language servers, formatters or MCP servers there. Nothing carries over from earlier versions, so after updating each project asks once: choose Trust project in the session header to load its settings again, and changing those settings asks again. Invited guests can no longer switch on tools in their own sessions, commit, switch branches or write inside .git, and they see and add to sessions only in their own workspace. Shell commands that read a .env file now ask like the read tool, a git diff that would print files outside the work tree is checked like a file read, file writes are checked where they really land, and an MCP server's sign-in opens only web pages. Vector's own helpers, such as Vectorscope reviews, Codespace edit and autocomplete, the Browser Agent planner and the swarm planner, stay inside the screen that started them and never show up as sessions, in session lists, notifications or session counts; the session that started them shows their tokens and cost, including for stopped and failed work. The Run Guard caps what one run spends: set it in Settings, Spend limits. Vector estimates each next step and stops before one that would cross the cap, within one step for each agent running, and subagents and helpers count against the same cap. Under a dollar cap, a model with no catalog price stops after 40 unpriced steps, and Vector Codium steps count as unpriced; free models and ChatGPT plan steps are not counted in dollars. An agent that gets the same result from the same tool call, or the same error, three times in a row is paused, a provider outage ends after 10 retries or 15 minutes, and the stop card says why and offers Continue. Sessions keep stable prompt prefixes so providers can reuse their caches, ChatGPT conversations can continue over a WebSocket connection, history is downloaded again less often, titles no longer hold up the first answer, an edit and its check can share one response, and Vector loads the packages for language servers, MCP, GitLab, PowerShell and telemetry only when they are used. Background subagents and agent swarms are steadier: Stop and Discard finish even when the engine stops answering, swarm workers merge into staging one at a time, a conflicting merge is refused before anything is written and one that stops part-way is undone, Resume no longer reruns a task that had already merged, and the computer stays awake while agents in parallel workspaces or their checks run. Vector Codium is built in for when sales open: a Vector Codium provider then appears in the model picker, Vector never picks it on its own, not even for an attached image, and Settings shows the share of this month's credits left and whether purchased credits are available, running low or used up, never an amount. The /codium page lists $10, $50, $100 and $200 monthly plans and top-ups, and its buttons say Coming soon until sales open. Models included with Vector, through your own free OpenRouter account or the free models provided by Vector while they are on, now follow a no-training policy: Vector offers only free models it has checked with the provider allowlisted to serve them, every request asks OpenRouter to deny data collection, and providers may still keep prompts under their own policies, as the model picker now says. Earlier versions used only zero-data-retention providers, so Vector tells you this once, the first time you send to one of these models. The branch button in the session header is a neutral chip again, and Vectorscope's pull request header and pull request numbers look as they did before 1.99.105. The bottom of the sidebar shows who is signed in, with your Google profile photo (or your initial) and your name or email, and opens Settings; signed out, it offers Sign in to Vector. A saved Light theme, or Follow system on a light system, now applies from launch rather than only after switching it in Settings, and a server's menu in Settings opens above Settings, so a server can be edited, made the default or deleted there. Sign in with ChatGPT remains available. The npm CLI stays at 1.99.99, and vectordev.ai/install currently installs a CLI build numbered 1.99.107 from 11 October, which predates these changes, so vector trust, vector codium, vector tasks, the TUI's /trust and /tasks, and vector run --max-cost and --max-steps arrive with the next CLI release. Windows WSL servers also keep running the 1.99.99 engine this desktop requires until a later desktop release requires the new CLI, so on a WSL server the shell prompts for cloud commands and .env reads, the git diff checks, project trust, the Run Guard, loop pauses and the new subagent controls do not apply yet. The guest limits apply to vector invite from the next CLI release, because vector invite runs from the CLI. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.106",
    "Agents keep working while your computer is idle, and Sign in with ChatGPT is back",
    "While any agent or subagent is running, Vector now keeps your computer from going to sleep, so long runs no longer freeze when you step away; the display can still turn off, and closing a laptop lid still puts it to sleep. When you come back to Vector after it was in the background, or after its connection to the agent engine drops, the open session and its subagent cards reload, so finished subagents no longer stay marked as running. Pressing Stop on a subagent that already finished now settles its card and says so, instead of appearing to do nothing. Sign in with ChatGPT is back: connect OpenAI with a ChatGPT Plus or Pro account to use GPT models. Vector now sends a daily usage count: how many sessions and subagent sessions ran, and, when you are signed in, token totals, recorded cost, the models and effort levels used, and streaks, with the app version and operating system. It never sends prompts, code, file names, model output, keys or IP addresses. Turn it off in Settings, General, Share usage counts.",
  ],
  [
    "October 2026 · 1.99.105",
    "Subagents keep working in the background",
    "Subagents now run in the background by default: the agent hands a task off, keeps working with you, and gets an automated report when the task finishes, and tasks that finish together report in one message. A message sent to a running subagent reaches it at its next step, and one that depends on other tasks waits for them. Stopping the agent's turn leaves the subagents it handed off running; stop them all from the background tasks panel. A settings change, such as a new provider key, no longer stops running subagents: Vector applies it once their work ends. Vectorscope can now review your own changes before you commit: Review my changes reviews the staged, unstaged and new files in the open project, as `vector review --uncommitted` does. Set up automatic reviews opens a pull request that adds the GitHub Actions workflow `vector github install` writes, on your agent's model, and lists the repository secrets to add; no API key is sent to GitHub, and Vector asks GitHub for permission to change workflow files only for this. A repository whose workflow reviews only when someone comments /vector review is shown as such. Branch names and pull request references now show in violet. A new install can start free: Start free with OpenRouter, in the composer and in the getting started checklist, connects your own OpenRouter account and selects its best free model, with your draft kept ready to send. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.104",
    "Vectorscope double-checks its reviews",
    "Pull Requests is now called Vectorscope, with the same icon, and its screen is redesigned. Reviews are more careful: after the review, a second pass re-reads the code behind every finding above a nit and drops the ones it cannot confirm, and the findings it keeps are marked Double-checked. The reviewers also read the failing CI checks for the commit under review, with the log of the step that failed, the places in your project that use the functions and types the pull request changes, and your project's rules in AGENTS.md (or CLAUDE.md) and .vector/RULES.md. A review runs on the model you last chose for the agent, and its progress line names that model; a model set in .vector/review.json still takes precedence. Comment, Request changes and Approve now post each finding on its own line, with GitHub's one-click suggested change when a fix is safe to commit; if GitHub refuses the line comments, the review goes out as one summary that lists every finding. Dismiss a finding with a reason to leave it out of what is posted, and choose Don't flag this again to save a project rule to .vector/RULES.md that later reviews follow. Fix with agent opens an isolated agent on the pull request's code with the finding as its task: it checks the problem is real, fixes it, runs the tests and commits without pushing. Reviews and merges are pinned to the commit you were looking at, so a push that arrives in the meantime is never reviewed or merged by mistake. The panel no longer reloads itself while agents are running, and its header is no longer hidden under the window's title bar. In Settings, text boxes and buttons no longer sit directly on a section's dividing line, and the search field shows one frame instead of two. Built-in Sign in with ChatGPT is turned off until OpenAI authorizes it: connect OpenAI with an API key, or use the separately installed Codex runtime. If you signed in with ChatGPT before, Vector tells you once and stops using that sign-in. The Terms, Privacy Policy and Software License now name Krishna B / VectorDev.ai and keep your rights under the LGPL for the open-source libraries Vector includes. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.103",
    "Pull Requests with your GitHub sign-in",
    "Pull Requests now works with your GitHub sign-in in Vector, and nothing has to be installed. Open Pull Requests, choose Connect GitHub, enter the code it shows on github.com, and your repository's pull requests appear: list, open, read the diff, create, comment, approve, request changes and merge, and run a Vectorscope review, all from Vector. Failed GitHub Actions runs and their logs come through the same sign-in, cut down to the step that failed. This is the same GitHub sign-in Open from GitHub uses, and the token stays in your computer's keychain; Sign out of GitHub in the panel switches accounts. If the GitHub CLI is already signed in on your computer, Pull Requests uses that login without asking again. When an organization requires single sign-on or approval for Vector, the panel says where to authorize it. Links you click in Vector's browser now open, including Google search results, results that pass through a redirect and links that open a new tab; before, a click that led to another website did nothing. The agent still needs your approval for each new website it visits, and when it is stopped it now names the link so it can ask you for it. Release notes and Changelog in the app open the changelog in the documentation. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.102",
    "A redesigned Changes panel",
    "The Changes panel is redesigned. Each changed file is now one row with its name over its folder and its added and removed line counts, under a summary of every file's totals, and a row expands into a short preview of its first change. Opening a file fills the panel with a focused reader instead of a side-by-side diff next to a file tree: one column of line numbers, a + or − beside each changed line, word-level highlights, your line comments inline, and a header with Back, the file's counts, a pager across the changed files, Open in editor, and a menu for the full file, split view (when the panel is wide enough), the previous or next change and Copy path. Back or Esc returns to the list, and a second Esc closes the panel; < and > move between files, [ and ] between changes, and Cmd+F (Ctrl+F on Windows and Linux) finds within the diff. Diffs in the conversation and in file tabs look as before. Background tasks now opens as a floating window by default, beside the Changes panel when there is room; its dock button still docks it, and Esc closes it either way. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.101",
    "Open a GitHub repository from Vector",
    "Besides opening a folder on your computer, you can now open a repository from GitHub: choose Open from GitHub on the Home screen or in the project menu, or press Shift+Cmd+O (Shift+Ctrl+O on Windows and Linux). Pick one of your repositories or paste a GitHub link, choose where to put it, and Vector clones it with a progress bar and opens it like Open Project. Public repositories work without signing in; connect GitHub to see your own and your organizations' repositories and to clone private ones. Vector uses your GitHub sign-in only for the clone and never writes it into the repository, its settings or Vector's logs, and a canceled or failed clone leaves nothing behind and never replaces an existing folder. Push to GitHub now lists only repositories you can push to, and on Windows Vector also finds Git for Windows installed after Vector started. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.100",
    "Messages work again in the desktop app",
    "This release fixes the desktop app, where in 1.99.99 every message failed with \"Bun is not defined\" on macOS, Windows and Linux. Local plugins and skills loaded from a URL failed in the desktop app with the same error, and plugins installed from npm and providers whose SDK Vector downloads on first use could not load there; all of them work now. The 1.99.99 apps for Intel Macs, Windows on Arm and Linux on Arm did not open, because they were built without the terminal component for their processor. 1.99.100 includes it on every platform, and a terminal component that cannot load now affects only terminals. A copy that does not open never reaches its update check, so on those computers download 1.99.100 from vectordev.ai/download with your free Vector account and install it over the old one; your repositories and settings stay where they are. On Windows, Vector's Git commands now follow your Git line-ending and symlink settings: a file whose only change is its line endings no longer shows as edited or blocks switching an agent's branch, and Vector's commits keep the line endings your repository expects. Also on Windows, Claude Code and Codex installed with npm receive the whole Parallel Workspace prompt instead of only its first line, Cursor Agent installed as a command script says it cannot take the prompt instead of running with part of it, detecting these agents no longer fails when one of them or VS Code is installed as a command script, Publish finds Vercel and Netlify CLIs installed with npm, and merge and pull-request checks run npm, pnpm and yarn instead of skipping them. A failed agent check no longer repeats in a loop while the Parallel Workspace composer is open. On Linux, Restart in 1.99.99 and in-app updates to it could open a new, empty profile; 1.99.100 opens your original profile again, so anything you signed in to or set up only in that empty profile needs to be set up again. The terminal agent was not affected and stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.99",
    "Vector is free, updates itself, and agents can change branch",
    "Vector is now free: create a free Vector account to download the desktop app, and the same account signs in the terminal agent. Installed copies now update from inside the app: choose Check for Updates and Vector downloads the new release, installs it and restarts. You can change an agent's branch: click the branch name in the session header to switch that checkout to another local branch, or type a new name to create one from the current commit. Vector never stashes or discards your work to switch, and it refuses while a Vector agent is running in that checkout; in agent workspaces Vector manages, you can create a branch but not switch to an existing one. 1.99.99 is the first release with no dependency on the upstream service. Connect a provider with your own API key, sign in with ChatGPT for OpenAI models, or use Connect OpenRouter with your own OpenRouter account; its eligible zero-price models appear under Free models inside of Vector and stop at their limits instead of switching to a paid model, and the free models provided by Vector stay off. The model list is current again, including GPT-6 Astra, GPT-6 Sol, GPT-6.1 Sol and GPT-6 Luna for ChatGPT sign-in, and Vector refreshes it from vectordev.ai when it starts and every hour. On first launch after upgrading, Vector imports your 1.99.8 settings, agents, commands, skills, plugins, MCP servers and permission rules, and keeps the originals. Security fixes keep stored API keys, auth headers and MCP tokens out of what Vector's server sends to connected clients and invite guests (an invite guest still has full access to your workspace, including the terminal, so invite only people you trust), keep Vector's internal secrets out of the integrated terminal, and protect passwordless local servers from rebinding web pages. Cloud connections keep client secrets on Vector's server, project variables keep their names when you change projects, local .env writes preserve literal values, and agent publishing uses one linked destination or asks you to choose; registration of the Cloud sign-ins is still pending. Reliability: stopping a prompt during first startup no longer leaves later prompts stuck, search recovers after an interrupted first lookup, an interrupted workspace no longer hangs shutdown, shell commands keep their final output when a process exits quickly, local plugins resolve JavaScript-style imports to their TypeScript source, and switching agents keeps the selected free model. Code Archaeology has been removed; Rewind code + chat still takes you back to earlier work. Dialogs have a look of their own, the send button lines up with the composer, the code reviewer is called Vectorscope, crash reports open as editable drafts, and providers without artwork use a neutral Vector icon. The Terms and software licence now include a minimum liability cap. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "September 2026 · 1.99.9",
    "Meet Vectorscope, the code review bot",
    "Vector's code reviewer is now Vectorscope: /vectorscope on a pull request, vector vectorscope in a terminal, and the Pull Requests panel in the app, all running the same review that reads the repository around a change. The older /vector and /vx mentions still work. The documentation is now a page per subject with search, and the landing page carries twenty feature cards. You can also delete your Vector account from the account page: it revokes your CLI tokens and asks you to type your email to confirm.",
  ],
  [
    "September 2026 · 1.99.8",
    "Subagents that work in parallel",
    "For big tasks the main agent launches general-purpose Subagents on its own, one per independent part and in parallel, and does small tasks itself; eight Subagent specialists keep their focus, and Settings → Agents can turn Subagents off. They show as cards in the chat and in the Background tasks panel. Turned on in vector github install, code review covers each pull request when it opens and on every push: one summary, and comments on the exact lines, each with a severity and, where it is safe, a fix you can commit from GitHub. It follows your .vector/review.md rules, re-reviews only what changed and says what got fixed, runs locally as vector review and from the desktop app's Pull Requests panel, and every review states its model and cost. The editor follows every agent live, the main agent included; Claude Code, Codex and Cursor chats answer like any other; the 16-agent limit is gone; and every model your providers offer is listed.",
  ],
  [
    "September 2026 · 1.99.7",
    "A database it can create for you",
    "The agent creates a real Supabase project on your own account, asks which organization when there are several, and writes the keys and client into your repository. Cloud actions that are merely unfinished now say what to connect instead of failing.",
  ],
  [
    "September 2026 · 1.99.6",
    "Cloud that closes the loop",
    "The agent reads your deployment logs to diagnose a failing deploy, and applies the .sql migrations in your repository to the linked database, tracking which already ran so re-running is safe. Publishing still ends with a real browser check of the deployed URL.",
  ],
  [
    "September 2026 · 1.99.5",
    "Multiplayer, Follow mode, and GitHub that ships PRs",
    "vector invite shares a live workspace with teammates over one link; the editor now follows the agent as it types, line by line; /vector on a GitHub issue opens a pull request with a Changes table, check output, measured cost, and the judge's verdict; and MCP servers that stop answering are recovered instead of wedging the app.",
  ],
  [
    "August 2026",
    "One workspace, two ways to work",
    "Agent and Editor now share one session, files open in persistent full-screen tabs, Settings is a searchable full-screen destination, and the Agent Dashboard, browser, terminal and review use one calmer purple project shell.",
  ],
  [
    "August 2026",
    "Scheduled work that runs while you are away",
    "Vector keeps a tray presence and stays resident after the last window closes, so a recurring task still fires with no window open. The tray shows what is armed and when it next runs, can run or pause everything from there, and notifies you when a run finishes.",
  ],
  [
    "August 2026",
    "Economics that actually learn",
    "Every session now feeds measured token and cost evidence into model recommendations, so the ranking is built from what providers actually reported rather than from list prices.",
  ],
  [
    "August 2026",
    "Plugins that install themselves",
    "Vector fetches whatever runtime a plugin needs, so Computer Use and other tools connect without a terminal detour.",
  ],
  [
    "August 2026",
    "Measured spend and in-app help",
    "Model economics now records real provider-reported tokens and cost per run, plus a Help AI Assistant and one-click bug reporting inside the workspace.",
  ],
  [
    "August 2026",
    "Agents can actually reach each other",
    "Fixed the teammate message tool, which was registered where the engine never looked, so collaborating agents could not reach each other.",
  ],
  [
    "August 2026",
    "Agents that work together",
    "Shared workspaces where agents message each other, an Agent Dashboard with clash detection, per-agent edit attribution in the editor, and AI pull request review.",
  ],
  [
    "August 2026",
    "Licensing and disclosure",
    "HEIC conversion moved to the operating system, removing the last copyleft dependency, with expanded privacy and terms coverage.",
  ],
  [
    "July 2026",
    "Vector desktop release and download refresh",
    "Verified installers for macOS, Windows, and Linux, served from the new download pipeline. Signed builds continue through automatic updates; unsigned previews stay manual-download only.",
  ],
  [
    "July 2026",
    "Review tools and shell polish",
    "A refined review panel, window recovery fixes, and a cleaner desktop chrome across the workspace.",
  ],
  [
    "July 2026",
    "Models and settings controls",
    "Restored provider management, model pickers, and execution settings throughout the rebuilt shell.",
  ],
]

export const faqs = [
  {
    question: "Does Vector upload my repository?",
    answer:
      "Vector works on a local repository and does not upload it to Vector's servers by default. Prompts, selected files, tool results, and local-memory context can be sent to the model provider you choose; publishing, Git, MCP, and cloud workflows send only the data required by those connected services.",
  },
  {
    question: "Where are model provider keys stored?",
    answer:
      "Provider credentials are stored with Vector's local application data and are not written into your repository. Keep normal operating-system account security enabled and never paste secrets into repository files.",
  },
  {
    question: "Can several agents work on one repository?",
    answer:
      "Yes, in two ways. Inside one session, Vector's agent starts subagents on its own for big tasks and runs them in the same checkout. For separate responsibilities, create agent workspaces: each works on its own copy or Git worktree, and you decide which changes are reviewed and merged.",
  },
  {
    question: "What is the difference between a subagent and a subagent specialist?",
    answer:
      "A subagent is general purpose: it takes whatever self-contained piece of the task Vector's agent hands it. Vector starts them for big tasks, one per independent part, and does small tasks itself. A subagent specialist is one of eight named agents, such as Review or Debug, with a fixed focus and its own permissions. Agents you define yourself count as custom specialists. Vector uses both on its own, and both appear in the chat and in Background tasks.",
  },
  {
    question: "Is there a limit on how many subagents Vector runs?",
    answer:
      "No. Vector sets no cap, though it starts subagents only for big tasks. Your computer and your provider's rate limits are the practical limits, and each subagent spends its own tokens. By default, subagents cannot start subagents of their own.",
  },
  {
    question: "Can I stop Vector from using subagents?",
    answer:
      "Yes. In the desktop app, switch off General subagents in Settings → Agents. In the terminal, from 1.99.99, set agent.general.disable to true in ~/.config/vector/vector.json, or in a repository's vector.json for that repository only. In the terminal it takes effect the next time you start Vector there. Vector's agent then does the work itself, except parts that fit a subagent specialist, which it can still hand to one. You can also still call a specialist yourself with @ and its name.",
  },
  {
    question: "Can I edit code myself?",
    answer:
      "Yes. Switch from Agent to Editor to search the repository, open files in tabs, edit directly, use diagnostics, and keep the same session agent beside the code.",
  },
  {
    question: "Does the browser replace Chrome or Firefox?",
    answer:
      "No. It is a controlled browser for previewing the repository, testing, and completing approved web workflows alongside the active agent session.",
  },
  {
    question: "Do I need an API key?",
    answer:
      "Not for free models. Sign in to Vector to use Free models inside of Vector, provided by Vector at no cost to you while Vector's service has them on, within a daily limit for each account; a limit or an unavailable endpoint stops the request without a paid fallback. Otherwise connect a provider with your own API key or sign in with ChatGPT. Requests to free models whose providers don't train ask OpenRouter to deny data collection, which excludes endpoints OpenRouter records as training on prompts. Free models whose providers may train are labelled \"May train on your prompts\" and are sent only after you accept that once. Providers may keep prompts and outputs under their own policies, and these routing controls do not cover local history or account logging.",
  },
  {
    question: "Is Vector free?",
    answer:
      "Yes. Create a free Vector account with Google or email, then download the desktop app from your account page. The same account signs in the terminal agent. Connect your own model provider to start; that provider bills its own usage.",
  },
]
