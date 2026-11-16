// The documentation's shape: groups in order, each leaf a page under /docs.
// Edit here and the sidebar, the pager and the search index all follow.
import { release111, release113 } from "./vector-releases"

export type DocLink = { id: string; title: string; blurb: string }
export type DocGroup = { label: string; links: DocLink[] }

export const docsNav: DocGroup[] = [
  {
    label: "Get started",
    links: [
      {
        id: "first-launch",
        title: "First launch, step by step",
        blurb:
          "For anyone new to Vector: download it, get past the first-launch warnings, sign in, pick a model and run a first task.",
      },
      {
        id: "install",
        title: "Install Vector",
        blurb: "Create a free account, download the installer for your computer and run it.",
      },
      {
        id: "first-task",
        title: "Your first task",
        blurb: "Open a repository, then describe the result, the constraints and how Vector should verify the work.",
      },
    ],
  },
  {
    label: "Agents",
    links: [
      {
        id: "vector-agent",
        title: "Vector Agent",
        blurb: "The main session inspects the repository, edits files, runs commands and reports a reviewable result.",
      },
      {
        id: "subagents",
        title: "Subagents and subagent specialists",
        blurb: `Vector's agent hands self-contained pieces of a task to other agents that run at the same time. ${release113.since} on ordinary requests too, within limits you set, with Stop including helpers, worktrees and background commands.`,
      },
      {
        id: "workflows",
        title: "Workflows",
        blurb: `${release113.since} a declarative plan of stages that runs many subagents with ceilings you approve first, and reports once.`,
      },
      {
        id: "parallel-agents",
        title: "Parallel agents",
        blurb: "Run several agents at once, each in its own checkout, and watch them from one dashboard.",
      },
      {
        id: "external-agents",
        title: "Run your own coding agents",
        blurb:
          "Run Claude Code, Codex, Cursor CLI and twelve more agents you installed yourself in Vector workspaces, each with its own sign-in.",
      },
      {
        id: "automations",
        title: "Automations",
        blurb: "An automation is one task Vector runs again and again on a schedule.",
      },
    ],
  },
  {
    label: "Features",
    links: [
      {
        id: "browser-agent",
        title: "Browser agent",
        blurb: "A real Chromium view inside Vector that the agent drives against your running product.",
      },
      {
        id: "research",
        title: "Deep research",
        blurb: `${release111.since} a preview that researches a question across the web and this repository's brain, then writes a report in which each claim cites a quote.`,
      },
      {
        id: "vectorscope",
        title: "Vectorscope code review",
        blurb: "Vector's code review bot: on every pull request, on your branch before you push, and in the app.",
      },
      {
        id: "tokenomics",
        title: "Vector Tokenomics Engine",
        blurb: `Measures what each run spends from the tokens your provider reports, and stops starting automations once your daily cap is spent. ${release113.since} learned defaults that only make work cheaper.`,
      },
      {
        id: "mcp-and-plugins",
        title: "MCP, custom MCP servers and plugins",
        blurb: "MCP servers and plugins give an agent structured access to approved tools.",
      },
      {
        id: "skills-and-commands",
        title: "Skills and custom commands",
        blurb: "Packaged instructions for recurring work, and your own prompt templates as Markdown files.",
      },
      {
        id: "verified-completion",
        title: "Verified completion",
        blurb: "Completion you can check, instead of a confident summary.",
      },
      {
        id: "checkpoints",
        title: "Checkpoints and recovery",
        blurb: "Rewind an agent's file changes and the conversation, one request at a time.",
      },
      {
        id: "brain",
        title: "Vector Brain",
        blurb: `From desktop 1.99.110: rules, memory and what Vector learns, kept on your computer and sent only when they bear on a request. ${release113.since} skills learned from your own runs, waiting for your review.`,
      },
      {
        id: "documents",
        title: "Documents and code links",
        blurb:
          "From desktop 1.99.110: give Vector your specs, PDFs and docs once, and it links them to the code that implements them.",
      },
      {
        id: "search-by-meaning",
        title: "Search by meaning",
        blurb:
          "From desktop 1.99.110: an optional local model that finds the passages of your documents that say what a request means in other words.",
      },
      {
        id: "models",
        title: "Models, free models and your own keys",
        blurb:
          "Sign in to Vector for free models, connect a provider account or API key, or add an OpenAI-compatible server of your own.",
      },
      {
        id: "codium",
        title: "Vector Codium",
        blurb:
          "Vector's optional monthly plan: coding models without provider keys, usage shown as a percentage, and no top-ups.",
      },
      {
        id: "local",
        title: "Vector Local",
        blurb: `${release111.since} run Vector's AI features on model servers you or your company host, with a log of what Vector sent.`,
      },
      {
        id: "cloud-services",
        title: "Vector Cloud",
        blurb: "Deployments, domains, databases and logs through your own Vercel and Supabase accounts.",
      },
      {
        id: "multiplayer",
        title: "Multiplayer and Follow mode",
        blurb: "One workspace, several people, and an editor that follows the agent as it types.",
      },
      {
        id: "desktop-app",
        title: "The desktop app",
        blurb: "Agent and Editor are two modes over the same local repository and session.",
      },
    ],
  },
  {
    label: "Terminal",
    links: [
      {
        id: "terminal-agent",
        title: "The terminal agent",
        blurb: "Run vector in any directory for the interactive agent, scripted runs and a headless server.",
      },
      {
        id: "sdk",
        title: "JavaScript SDK",
        blurb: "Connect typed JavaScript integrations to a local Vector server.",
      },
    ],
  },
  {
    label: "Reference",
    links: [
      {
        id: "configuration",
        title: "Configuration files",
        blurb:
          "Where vector.json lives for the desktop app, the terminal and a repository, how it takes values from the environment, and where each key is described.",
      },
      {
        id: "permissions",
        title: "Permissions",
        blurb: "Every tool action is checked against a ruleset whose effect is allow, ask or deny.",
      },
      {
        id: "troubleshooting",
        title: "Troubleshooting and FAQ",
        blurb: "Fixes for common problems, frequent questions, and deleting your account.",
      },
      {
        id: "changelog",
        title: "Changelog",
        blurb: "Every Vector release, newest first.",
      },
    ],
  },
]

export const docsOrder: DocLink[] = docsNav.flatMap((group) => group.links)

// Pages that were merged into another one, and where each now lives. The /docs
// hash shim reads this, and vercel.json carries the same map as redirects, so an
// old /docs/<id> or /docs#<id> link still lands on its subject.
export const docsMoved: Record<string, string> = {
  "open-repository": "first-task#open-repository",
  "project-rules": "vector-agent#repository-rules",
  tools: "vector-agent#tools",
  context: "vector-agent#context",
  "why-vector": "vector-agent",
  "operating-loop": "vector-agent",
  "only-in-vector": "vector-agent",
  conditions: "vector-agent",
  comparison: "vector-agent",
  "custom-agents": "subagents#custom-agents",
  "agent-workspaces": "parallel-agents",
  "agent-dashboard": "parallel-agents#agent-dashboard",
  browser: "browser-agent",
  "controlled-browser": "browser-agent#controlled-browser",
  "code-review": "vectorscope",
  "review-pipeline": "vectorscope#review-pipeline",
  github: "vectorscope#github",
  "cli-github": "vectorscope#cli-github",
  connections: "mcp-and-plugins",
  "cli-mcp": "mcp-and-plugins#cli-mcp",
  "cli-plugins": "mcp-and-plugins#cli-plugins",
  skills: "skills-and-commands",
  commands: "skills-and-commands#commands",
  review: "checkpoints#review",
  "cli-models": "models#cli-models",
  velocity: "models",
  "api-platform": "sdk",
  follow: "multiplayer#follow",
  "agent-editor": "desktop-app#agent-editor",
  composer: "desktop-app#composer",
  transcript: "desktop-app#transcript",
  "workspace-rail": "desktop-app#workspace-rail",
  "settings-appearance": "desktop-app#settings",
  "help-assistant": "desktop-app#help-assistant",
  "terminal-review": "desktop-app#terminal-review",
  "cli-terminal": "terminal-agent",
  "cli-run": "terminal-agent#cli-run",
  "cli-account": "terminal-agent#cli-account",
  "cli-sessions": "terminal-agent#cli-sessions",
  "cli-server": "terminal-agent#cli-server",
  "cli-maintenance": "terminal-agent#cli-maintenance",
  faq: "troubleshooting#faq",
  "delete-account": "troubleshooting#delete-account",
  "local-memory": "brain",
  // Plans and pricing have no pages of their own: Vector Codium covers both.
  plans: "codium",
  pricing: "codium",
}

export const groupOf = (id: string) => docsNav.find((group) => group.links.some((link) => link.id === id))?.label ?? ""

export const neighbours = (id: string) => {
  const index = docsOrder.findIndex((link) => link.id === id)
  return { previous: index > 0 ? docsOrder[index - 1] : undefined, next: index >= 0 ? docsOrder[index + 1] : undefined }
}
