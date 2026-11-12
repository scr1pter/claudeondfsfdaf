import type { LocalMode } from "@vectordevai/schema/local-mode"
import { GithubAgents } from "./github-agents"
import { LocalPolicy } from "./local-mode/policy"

const PRIVATE_RUNTIME_ENVIRONMENT = new Set([
  "BLOB_READ_WRITE_TOKEN",
  "VECTOR_AUTH_CONTENT",
  "VECTOR_CLOUD_TOKEN",
  "VECTOR_CREDENTIAL_KEY",
  "VECTOR_MCP_AUTH_KEY",
  "VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE",
])

// The credentials INV-S5 names on GitHub Actions. SECRET_NAME_PATTERN also covers the _TOKEN ones; the bind code and the
// ticket it misses.
const ACTIONS_CREDENTIALS = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "VECTOR_CLI_TOKEN",
  "VECTOR_BIND_CODE",
  "VECTOR_TICKET",
])
// A name VECTOR_SECRET_ENV_NAMES may list: the generator's key-name rule (INV-S15).
const SECRET_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/

/**
 * Set in every untrusted child of a process that runs agents. `vector local off`, `allow` and `web` refuse under it.
 * Its presence is what counts, whatever its value: a source's "0" is kept as it is and still marks the child.
 */
export const AGENT_MARKER = "VECTOR_AGENT_SESSION"

// What untrusted children inherit from Vector itself, set by the process that resolved Vector Local. Nothing is added
// until a process says so, so a process that runs no agents passes its environment through unchanged.
const inherited: { local?: LocalMode.Web; agent: boolean } = { agent: false }

// The configured names the Actions filter has said it withheld, so each is reported once per process.
const reported = new Set<string>()

/**
 * Builds an environment for project-controlled or otherwise untrusted child
 * processes without exposing Vector's in-process vault and bridge secrets.
 * Filtering is case-insensitive because Windows environment keys are too.
 *
 * Only Vector's own secrets are removed. The user's variables, including
 * NODE_OPTIONS, PYTHONPATH and LD_LIBRARY_PATH, reach their commands unchanged;
 * preload variables a project config tries to set are refused when that
 * config is loaded (WorkspaceTrust.unsafeProjectEnvironment).
 *
 * On GitHub Actions (any source with GITHUB_ACTIONS=true) children also lose
 * the runner's ACTIONS_* values, the GitHub and Vector credentials INV-S5
 * names, every name ending _TOKEN, _KEY, _SECRET or _PASSWORD, and every name
 * VECTOR_SECRET_ENV_NAMES lists. That is defence in depth: workflow v3's agent
 * sandbox keeps credentials out of the engine's environment altogether, but v2
 * workflows and self-hosted runners have no sandbox. The filter reads the
 * merged result, so a name a caller configures for the child (any source after
 * the first: an MCP server's `environment`, a formatter's or language server's
 * env, a plugin's shell env) is withheld too, and the first time each such name
 * is withheld the process says so on stderr, naming it but never its value.
 *
 * Once a process has called `inherit`, its children also get the Vector Local
 * floor (VECTOR_LOCAL=1 and a Web access at least as strict, so a nested
 * vector keeps Local on whatever config it reads) and the agent marker. A
 * source environment cannot lower either.
 */
export function untrustedChildEnvironment(...sources: Array<NodeJS.ProcessEnv | undefined>): Record<string, string> {
  const list = sources.length
    ? sources.filter((source): source is NodeJS.ProcessEnv => source !== undefined)
    : [process.env]
  const environment: NodeJS.ProcessEnv = Object.assign({}, ...list)
  const hidden = actionsSecrets(list)
  reportWithheld(list.slice(1), (key) => !privateRuntimeKey(key) && hidden(key))
  const filtered = Object.entries(environment).flatMap(([key, value]) =>
    typeof value === "string" && !privateRuntimeKey(key) && !hidden(key) ? [[key, value] as const] : [],
  )
  const added = floor(filtered)
  // Windows keys are case-insensitive, so a source's own spelling of a key the floor sets is dropped, not doubled.
  const replaced = new Set(Object.keys(added))
  return {
    ...Object.fromEntries(filtered.filter(([key]) => !replaced.has(key.toUpperCase()))),
    ...added,
  }
}

/**
 * Sets what this process's untrusted children inherit: the Vector Local floor while Local is on, and the agent marker
 * in a process that runs agents. The engine calls it when it resolves Vector Local at start and whenever the policy
 * in effect changes.
 */
export function inherit(input: {
  readonly local?: { readonly enabled: boolean; readonly web: LocalMode.Web }
  readonly agent?: boolean
}) {
  inherited.local = input.local?.enabled ? input.local.web : undefined
  if (input.agent !== undefined) inherited.agent = input.agent
}

function floor(environment: ReadonlyArray<readonly [string, string]>) {
  const value = (name: string) => environment.find(([key]) => key.toUpperCase() === name)?.[1]
  const web = inherited.local
  // VECTOR_LOCAL_WEB names only the stricter settings; Ask is what Local means without it.
  const current = (["network", "none"] as const).find(
    (setting) => setting === value("VECTOR_LOCAL_WEB")?.trim().toLowerCase(),
  )
  const strictest = web === undefined ? undefined : LocalPolicy.stricter(web, current)
  return {
    ...(inherited.agent ? { [AGENT_MARKER]: value(AGENT_MARKER) || "1" } : {}),
    ...(strictest === undefined ? {} : { VECTOR_LOCAL: "1" }),
    ...(strictest === undefined || strictest === "ask" ? {} : { VECTOR_LOCAL_WEB: strictest }),
  }
}

// What a child of a process on GitHub Actions must not see (INV-S5). Any source that says Actions turns this on, so a
// later source (a project MCP server's environment, a plugin's shell env) cannot turn it off with GITHUB_ACTIONS=false,
// and a name any source lists stays hidden whatever list a later source gives. Names are compared upper-cased, as
// Windows compares them.
function actionsSecrets(sources: readonly NodeJS.ProcessEnv[]) {
  if (!sources.some((source) => GithubAgents.onActionsRunner(source))) return () => false
  const listed = new Set(
    sources.flatMap((source) =>
      Object.entries(source).flatMap(([key, value]) =>
        key.toUpperCase() === "VECTOR_SECRET_ENV_NAMES" && typeof value === "string"
          ? value
              .split(",")
              .map((name) => name.trim().toUpperCase())
              .filter((name) => SECRET_ENV_NAME.test(name))
          : [],
      ),
    ),
  )
  return (key: string) => {
    const name = key.toUpperCase()
    return (
      name.startsWith("ACTIONS_") ||
      ACTIONS_CREDENTIALS.has(name) ||
      GithubAgents.SECRET_NAME_PATTERN.test(name) ||
      listed.has(name)
    )
  }
}

// Says once per name and process which names a caller configured for a child (a source after the first) the Actions
// filter withheld, so an MCP server or command that fails for want of one can be diagnosed from the run's log. Names
// only, never values. Inherited names go silently: every run on Actions has some, and the docs say which.
function reportWithheld(configured: readonly NodeJS.ProcessEnv[], withheld: (key: string) => boolean) {
  const names = [
    ...new Set(
      configured.flatMap((source) =>
        Object.entries(source).flatMap(([key, value]) =>
          typeof value === "string" && withheld(key) ? [key.toUpperCase()] : [],
        ),
      ),
    ),
  ].filter((name) => !reported.has(name))
  if (names.length === 0) return
  names.forEach((name) => reported.add(name))
  console.warn(
    `Vector on GitHub Actions passes no credential to the commands and servers it starts. Withheld from one: ${names.toSorted().join(", ")}.`,
  )
}

function privateRuntimeKey(key: string) {
  const normalized = key.toUpperCase()
  if (PRIVATE_RUNTIME_ENVIRONMENT.has(normalized)) return true
  if (/^[A-Z0-9_]+_(?:AUTH_CONTENT|CONSOLE_TOKEN|SERVER_PASSWORD|SERVER_GUEST_PASSWORD)$/.test(normalized)) return true
  if (!normalized.startsWith("VECTOR_")) return false
  return (
    normalized.endsWith("_TOKEN") ||
    normalized.endsWith("_KEY") ||
    normalized.endsWith("_PASSWORD") ||
    normalized.endsWith("_SECRET")
  )
}

export * as ChildEnvironment from "./child-environment"
