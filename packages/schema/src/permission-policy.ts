export * as PermissionPolicy from "./permission-policy"

const CLOUD_WRITES = new Set([
  "vector_cloud_publish",
  "vector_cloud_database",
  "vector_cloud_environment",
  "vector_cloud_hosting",
])

// Account mutations must ask again even when configuration or a client normally auto-accepts tools.
export function requiresCloudApproval(permission?: string, always?: readonly string[]) {
  return Boolean(
    permission && (CLOUD_WRITES.has(permission) || (permission.startsWith("vector_cloud_") && !always?.length)),
  )
}

/**
 * A change to a file Vector's memory is read from (RULES.md, BRAIN.md, MEMORY.md) by a session that took in outside
 * content. A line there binds every later request, so planted text must never land in one unseen: it asks every time,
 * whatever configuration allows or a client auto-accepts.
 */
export const MEMORY_SOURCE = "memory_source"

/**
 * An edit to a file Vector reads into an agent's system prompt or permissions. It asks every time, whatever
 * configuration allows or a client auto-accepts.
 */
export const PROMPT_SOURCE = "prompt_source"

/**
 * A shell command that removes or overrides the marker Vector puts on every program its agents start, which Vector's
 * owner-only commands (`vector memory skills approve`, `vector trust prompts approve`) refuse under: run without it,
 * one would act as the owner. It asks every time, whatever configuration allows or a client auto-accepts.
 */
export const AGENT_MARKER = "agent_marker"

/** Why a command that drops the agent marker asks, as the ask shows it. */
export const AGENT_MARKER_REASON =
  "This command removes the marker that stops Vector's agents from running owner-only commands, such as approving learned skills or prompt files."

/**
 * Keeping a research run makes its report, written from web pages, recallable by every later request. A page can carry
 * planted instructions, so the agent keeps research only after the user says yes: it asks every time, whatever
 * configuration allows or a client auto-accepts.
 */
export const RESEARCH_KEEP = "research_keep"

/**
 * A shell command that may reach the network while Vector Local is on. Vector cannot see where such a command
 * connects, so it asks every time, whatever configuration allows or a client auto-accepts.
 */
export const NETWORK_COMMAND = "network_command"

/** Why a network command asks, as the ask shows it. */
export const NETWORK_COMMAND_REASON =
  "Vector Local is on, and this command may connect to the network. Vector cannot see where it connects."

/**
 * The pattern prefix of a web address the agent chose after the conversation read the web, while Vector Local is on
 * (`after-web https://…`). A page can steer the agent into putting the user's data in an address, so it asks every
 * time: no saved "Always allow" for a site matches it, and neither configuration nor auto-accept answers it.
 */
export const AFTER_WEB = "after-web "

/** Declarative workflow execution. Elevated plans always ask, including on older clients. */
export const WORKFLOW = "workflow"

export function workflowPattern(reason?: "web" | "mcp" | "agent" | "large") {
  return reason ? `${AFTER_WEB}workflow:${reason}` : "run"
}

/** Why an address after the web asks, as the ask shows it. */
export const AFTER_WEB_REASON =
  "This conversation read the web, and this address is new: neither you nor an earlier result gave it. A page can steer the agent into putting your data in an address."

/**
 * Computer permissions (Vector Hands; internal ids stay `computer_*`). Whenever one is raised, a person answers it:
 * no configuration allow, `"*": "allow"` default, auto-accept or company allow does, and a `deny` still wins.
 * `computer_app` is the per-app ask, the only one that may be saved as Always allow, and only for `app:` keys; the
 * desktop, never the engine, keeps that saved list. `computer_sensitive` asks before each risky step and never
 * offers Always. `computer_observe` and `computer_interact` are copy keys only and are never raised.
 */
export const COMPUTER_APP = "computer_app"
export const COMPUTER_OBSERVE = "computer_observe"
export const COMPUTER_INTERACT = "computer_interact"
export const COMPUTER_SENSITIVE = "computer_sensitive"

/**
 * Whether a request is one of the two asks Vector Hands raises, which clients show as Hands asks. Another tool's
 * permission can share the `computer_` prefix (an MCP server named `computer use` asks `computer_use_<tool>`, and a
 * plugin tool can take any id), so the prefix names no Hands ask; it still makes every such permission ask
 * (`requiresApproval`) and never auto-approve. The engine refuses an MCP server named `computer` in any letter case,
 * whose tools could otherwise take these two ids.
 */
export function handsAsk(permission?: string) {
  return permission === COMPUTER_APP || permission === COMPUTER_SENSITIVE
}
/** The prefix of an app key (`app:macos:<bundleId>`, `app:windows:…`), the only pattern a computer Always may save. */
export const COMPUTER_APP_PREFIX = "app:"
/** Why typing an address, recipient or number the user never gave asks once the screen has been read. */
export const AFTER_SCREEN_REASON =
  "Text on your screen can steer the agent, and this address or recipient is new: you did not give it."
/** Reserved comment marker requiring a fresh answer after a computer result, without colliding with executable names. */
export const AFTER_SCREEN_COMMAND_PREFIX = "#after-screen "
export const AFTER_SCREEN_COMMAND_REASON =
  "This conversation used your computer. Check this command before it runs; text on screen can influence the agent."
const SHELL_PERMISSIONS = new Set(["bash", "shell", "terminal", "pwsh", "powershell", "cmd"])

/** The marker changes approval requirements, not which command the existing permission rules evaluate. */
export function commandPattern(permission: string, pattern: string) {
  return SHELL_PERMISSIONS.has(permission) && pattern.startsWith(AFTER_SCREEN_COMMAND_PREFIX)
    ? pattern.slice(AFTER_SCREEN_COMMAND_PREFIX.length)
    : pattern
}
/** Why a step asks when text on screen reads as instructions to an AI. */
export const FLAGGED_SCREEN_REASON =
  "Text on screen looks like instructions to an AI. Check that this step is what you asked for."

// A saved computer approval names one concrete app: a wildcard such as `app:*` or `app:macos:*` is never one.
const concreteAppKey = (pattern: string) =>
  pattern.length > COMPUTER_APP_PREFIX.length && pattern.startsWith(COMPUTER_APP_PREFIX) && !/[*?]/.test(pattern)

/**
 * Reading, waiting on, resizing or closing a terminal, asked by the terminal tool for a terminal the agent did not
 * open.
 */
export const TERMINAL = "terminal"

/** Typing or pressing keys in a terminal. A line it submits is also asked as the shell command it is. */
export const TERMINAL_INPUT = "terminal_input"

/** The pattern prefix of a terminal the session's own agent opened (`own:pty_…`). */
export const TERMINAL_OWN = "own:"

/** The pattern prefix of any other terminal: the user's, or another session's agent's (`other:pty_…`). */
export const TERMINAL_OTHER = "other:"

/**
 * A terminal line the shell may have filled from somewhere Vector cannot read: its history, its kill ring, an editor,
 * or a command name tab completion finished. It may run a Vercel or Supabase command on the command-line tool's own
 * login, which the shell asks for every time, so it asks every time too: a Vector Cloud permission with no "always"
 * (requiresCloudApproval), which no rule, saved approval or auto-accept answers.
 */
export const CLOUD_UNREAD = "vector_cloud_unread"

/**
 * Whether a request asks the user every time: account mutations, edits to memory or prompt sources, commands that
 * drop the agent marker, keeping research, elevated workflows, Vector Local network/address asks, and every
 * computer permission, including commands that follow a screen observation.
 */
export function requiresApproval(permission?: string, always?: readonly string[], patterns?: readonly string[]) {
  return (
    Boolean(permission?.startsWith("computer_")) ||
    permission === MEMORY_SOURCE ||
    permission === PROMPT_SOURCE ||
    permission === AGENT_MARKER ||
    permission === RESEARCH_KEEP ||
    permission === NETWORK_COMMAND ||
    Boolean(
      permission &&
        SHELL_PERMISSIONS.has(permission) &&
        patterns?.some((pattern) => pattern.startsWith(AFTER_SCREEN_COMMAND_PREFIX)),
    ) ||
    (permission === WORKFLOW && (!patterns?.length || patterns.some((pattern) => pattern !== "run"))) ||
    Boolean(patterns?.some((pattern) => pattern.startsWith(AFTER_WEB))) ||
    requiresCloudApproval(permission, always)
  )
}

export function canAutoApprove(permission?: string, always?: readonly string[], patterns?: readonly string[]) {
  return (
    permission !== "doom_loop" &&
    permission !== "browser_sensitive" &&
    !permission?.startsWith("computer_") &&
    !requiresApproval(permission, always, patterns)
  )
}

/**
 * Whether a reply may be "always". `computer_app` qualifies only when every saved pattern is a concrete `app:` key, even
 * though it never auto-approves; every other computer permission never qualifies.
 */
export function canAlwaysApprove(permission?: string, always?: readonly string[], patterns?: readonly string[]) {
  if (permission === COMPUTER_APP) return Boolean(always?.length) && always!.every(concreteAppKey)
  return canAutoApprove(permission, always, patterns) && Boolean(always?.length)
}
