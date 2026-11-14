import { ConfigMigration } from "@vectordevai/core/config/migration"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import path from "path"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "url"
import os from "os"
import { mergeDeep, omit } from "remeda"
import { Global } from "@vectordevai/core/global"
import fsNode from "fs/promises"
import { Flag } from "@vectordevai/core/flag/flag"
import { Auth } from "../auth"
import { Teams } from "@vectordevai/core/teams"
import { Env } from "../env"
import { applyEdits, modify, parse } from "jsonc-parser"
import { InstallationLocal } from "@vectordevai/core/installation/version"
import { existsSync, readFileSync, renameSync, watch, writeFileSync } from "fs"
import { isMainThread } from "node:worker_threads"
import { isRecord } from "@/util/record"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Redaction } from "@vectordevai/core/redaction"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Fiber, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import type { InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { ConfigMCPV1 } from "@vectordevai/core/v1/config/mcp"
import { RemoteAuthError } from "@vectordevai/core/v1/config/error"
import { ConfigPermissionV1 } from "@vectordevai/core/v1/config/permission"
import { ConfigPluginV1 } from "@vectordevai/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { PromptTrust } from "./prompt-trust"
import { PromptSource } from "@/session/prompt-source"
import { ConfigManaged } from "@vectordevai/core/config/managed"
import { ConfigParse } from "./parse"
import { ConfigSchema } from "./schema"
import { ConfigPaths } from "./paths"
import { ConfigImport } from "./import-settings"
import { GlobalBus } from "@/bus/global"
import { TuiEvent } from "@/server/tui-event"
import { ConfigPlugin } from "./plugin"
import { ConfigDependencies } from "./dependencies"
import { ConfigVariable } from "./variable"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { EgressHttpClient } from "@vectordevai/core/local-mode/http-client"
import { EgressLogStore } from "@vectordevai/core/local-mode/log-store"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { ConfigLocalV1 } from "@vectordevai/core/v1/config/local"
import { ChildEnvironment } from "@vectordevai/core/child-environment"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

/** What a repository's config may set, given the merged config before it (`base`). Exported for tests. */
export function projectExecutableConfig(config: Info, trusted: boolean, base: Info): Info {
  // Subagent and workflow limits only narrow the user's, trusted or not. An untrusted repository's budget and sizing
  // then collapse below.
  const next = repositorySubagents(config, base)
  // A repository's own local block never applies, trusted or not: only the user's config and the company's policy
  // set Vector Local, so a cloned repository can neither loosen it nor turn it off.
  delete next.local
  // Spend limits are one overall set across every repository, so a repository's own budget.run is ignored, trusted
  // or not. Its loop switch still follows the trust rules below.
  if (next.budget?.run) {
    const budget = { ...next.budget }
    delete budget.run
    if (Object.keys(budget).length) next.budget = budget
    else delete next.budget
  }
  // Research's settings are the user's too, trusted or not (sections 5.7 and 7.2): the domains it prefers (which clear
  // host names from the outbound check), its caps and robots.txt. Otherwise a cloned repository could raise the caps
  // and choose what research reads.
  if (next.research) {
    const research = repositoryResearch(next.research, base.research)
    if (research) next.research = research
    else delete next.research
  }
  if (!trusted) {
    const permission = authorityNarrowingPermission(next.permission)
    if (permission) next.permission = permission
    else delete next.permission
    if (next.tools) {
      next.tools = Object.fromEntries(Object.entries(next.tools).filter(([, enabled]) => !enabled))
      if (!Object.keys(next.tools).length) delete next.tools
    }
    delete next.plugin
    delete next.mcp
    delete next.lsp
    delete next.formatter
    delete next.command
    delete next.provider
    delete next.agent
    delete next.mode
    delete next.shell
    delete next.instructions
    delete next.model
    delete next.small_model
    delete next.default_agent
    delete next.skills
    if (next.enabled_providers && base.enabled_providers) {
      const enabled = new Set(base.enabled_providers)
      next.enabled_providers = next.enabled_providers.filter((provider) => enabled.has(provider))
    }
    if (next.disabled_providers) {
      next.disabled_providers = Array.from(new Set([...(base.disabled_providers ?? []), ...next.disabled_providers]))
    }
    // Sharing and undo snapshots may only get safer: an untrusted project can turn sharing down or off, never on,
    // and cannot turn snapshots off.
    if (next.share && (base.share === "disabled" || next.share === "auto")) delete next.share
    if (next.autoshare) delete next.autoshare
    if (next.snapshot === false) delete next.snapshot
    // Loop limits may only get stricter too: a cloned repository cannot switch loop pauses off, or keep the agent
    // going after a denied tool call.
    if (next.budget) {
      if (next.budget.loop?.enabled === true) next.budget = { loop: { enabled: true } }
      else delete next.budget
    }
    // Task sizing may only get cheaper too: a cloned repository can switch the judge off, but cannot turn automatic
    // sizing off (the full harness on every request) or have the judge run on the user's account.
    if (next.sizing) {
      const sizing = next.sizing.judge === "off" ? { judge: "off" as const } : undefined
      if (sizing) next.sizing = sizing
      else delete next.sizing
    }
    if (next.experimental?.continue_loop_on_deny === true && base.experimental?.continue_loop_on_deny !== true) {
      const experimental = { ...next.experimental }
      delete experimental.continue_loop_on_deny
      next.experimental = experimental
    }
    return next
  }
  if (next.provider) {
    next.provider = Object.fromEntries(
      Object.entries(next.provider).filter(([, provider]) => projectProviderEndpointsAllowed(provider)),
    )
  }
  return next
}

// A repository's budget keys that are the user's alone: spend limits cover every repository together, so these are
// dropped, with a notice once per file.
export function ignoredSpendKeys(config: Info): string[] {
  const subagents = config.budget?.subagents
  return [
    ...(config.budget?.run ? ["budget.run"] : []),
    ...(["usd", "steps", "warnAt", "unpricedSteps"] as const)
      .filter((key) => subagents?.[key] !== undefined)
      .map((key) => `budget.subagents.${key}`),
  ]
}

const lower = (repository: number | undefined, user: number | undefined, fallback?: number) =>
  repository === undefined ? undefined : Math.min(repository, user ?? fallback ?? repository)

const present = <T extends object>(value: T) => {
  const kept = Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined))
  return Object.keys(kept).length ? (kept as T) : undefined
}

// What a repository's subagent and workflow keys may set, trusted or not (multi-agent contract 4.2): the counts and
// every workflow ceiling only lower the user's value or the default, forks only turn off, models only narrow the user's
// list, and ask_timeout only shortens the user's own. The subagents' shared spend ceiling and isolation are the user's
// alone. Exported for tests.
export function repositorySubagents(config: Info, base: Info): Info {
  const next = { ...config }
  if (next.budget?.subagents || next.budget?.workflow) {
    const budget = { ...next.budget }
    const user = base.budget
    const repository = budget.subagents
    const subagents = repository
      ? present({
          running: lower(repository.running, user?.subagents?.running, ConfigV1.SubagentDefaults.running),
          per_request: lower(
            repository.per_request,
            user?.subagents?.per_request,
            ConfigV1.SubagentDefaults.per_request,
          ),
        })
      : undefined
    const flow = budget.workflow
    const defaults = ConfigV1.WorkflowDefaults
    const maxAgents = user?.workflow?.max_agents ?? defaults.max_agents
    const workflow = flow
      ? present({
          max_agents: lower(flow.max_agents, user?.workflow?.max_agents, defaults.max_agents),
          concurrency: lower(flow.concurrency, user?.workflow?.concurrency, defaults.concurrency),
          usd: lower(flow.usd, user?.workflow?.usd),
          tokens: lower(flow.tokens, user?.workflow?.tokens),
          steps: lower(flow.steps, user?.workflow?.steps, maxAgents * defaults.steps_per_agent),
          per_agent_steps: lower(flow.per_agent_steps, user?.workflow?.per_agent_steps, defaults.per_agent_steps),
          minutes: lower(flow.minutes, user?.workflow?.minutes, defaults.minutes),
          runs: lower(flow.runs, user?.workflow?.runs, defaults.runs),
        })
      : undefined
    if (subagents) budget.subagents = subagents
    else delete budget.subagents
    if (workflow) budget.workflow = workflow
    else delete budget.workflow
    if (Object.keys(budget).length) next.budget = budget
    else delete next.budget
  }
  const repository = next.sizing?.subagents
  if (repository) {
    const sizing = { ...next.sizing }
    const user = base.sizing?.subagents
    const allowed = user?.models
    const subagents = present({
      fork: repository.fork === false ? (false as const) : undefined,
      models: repository.models && allowed ? repository.models.filter((model) => allowed.includes(model)) : undefined,
      ask_timeout:
        repository.ask_timeout !== undefined &&
        user?.ask_timeout !== undefined &&
        repository.ask_timeout < user.ask_timeout
          ? repository.ask_timeout
          : undefined,
    })
    if (subagents) sizing.subagents = subagents
    else delete sizing.subagents
    if (Object.keys(sizing).length) next.sizing = sizing
    else delete next.sizing
  }
  return next
}

// What a repository's research block may set: domains to avoid, added to the user's, and a research tool setting
// narrower than the user's ("off" is narrower than "thorough", which is narrower than the default "work").
function repositoryResearch(research: NonNullable<Info["research"]>, base: Info["research"]) {
  const avoid = research.domains?.avoid?.length
    ? [...new Set([...(base?.domains?.avoid ?? []), ...research.domains.avoid])]
    : undefined
  const widths = ["off", "thorough", "work"]
  const tool =
    research.tool !== undefined && widths.indexOf(research.tool) < widths.indexOf(base?.tool ?? "work")
      ? research.tool
      : undefined
  if (!avoid && !tool) return undefined
  return { ...(avoid ? { domains: { avoid } } : {}), ...(tool ? { tool } : {}) }
}

function bindTrustedProjectExecutables(
  config: Info,
  trusted: WorkspaceTrust.TrustedSnapshot,
  workspace: string,
  source: string,
): Info {
  const next = { ...config }
  if (next.shell) {
    const shell = trustedExecutableValue(next.shell, path.dirname(source), trusted)
    if (shell) next.shell = shell
    else delete next.shell
  }
  if (next.plugin) {
    next.plugin = next.plugin.flatMap((item) => {
      const mapped = trustedExecutableValue(ConfigPlugin.pluginSpecifier(item), path.dirname(source), trusted, true)
      if (!mapped) return []
      return [Array.isArray(item) ? ([mapped, item[1]] as ConfigPluginV1.Spec) : mapped]
    })
  }
  if (isRecord(next.formatter)) {
    next.formatter = rewriteCommandEntries(next.formatter, workspace, trusted) as Info["formatter"]
  }
  if (isRecord(next.lsp)) next.lsp = rewriteCommandEntries(next.lsp, workspace, trusted) as Info["lsp"]
  if (isRecord(next.mcp)) {
    next.mcp = Object.fromEntries(
      Object.entries(next.mcp)
        .map(([name, entry]) => {
          // A project's remote server gets HTTPS or loopback HTTP only; plain HTTP to the user's network is for
          // servers the user adds themselves.
          if ("url" in entry && typeof entry.url === "string")
            return [name, WorkspaceTrust.remoteUrlAllowed(entry.url) ? entry : undefined]
          if (!("command" in entry) || !Array.isArray(entry.command)) return [name, entry]
          const cwd = "cwd" in entry && typeof entry.cwd === "string" ? path.resolve(workspace, entry.cwd) : workspace
          const command = WorkspaceTrust.materializedCommand(trusted, entry.command, cwd, entry.environment)
          if (!command) return [name, undefined]
          return [
            name,
            {
              ...entry,
              command: command.command,
              cwd: command.cwd,
            },
          ]
        })
        .filter((entry) => entry[1] !== undefined),
    ) as Info["mcp"]
  }
  return next
}

function rewriteCommandEntries(value: Record<string, unknown>, base: string, trusted: WorkspaceTrust.TrustedSnapshot) {
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, entry]) => {
      if (!isRecord(entry)) return [[name, entry]]
      // An entry without a command overrides a built-in formatter, which still launches with this environment, so a
      // PATH or preload variable would run live, unapproved programs just as a project command would.
      const environment = "environment" in entry ? entry.environment : "env" in entry ? entry.env : undefined
      const projectEnvironment = stringEnvironment(environment)
      if (
        environment !== undefined &&
        (!projectEnvironment || WorkspaceTrust.unsafeProjectEnvironment(projectEnvironment))
      )
        return []
      if (!Array.isArray(entry.command)) {
        if (typeof entry.cwd !== "string") return [[name, entry]]
        const cwd = WorkspaceTrust.materializedPathOption(trusted, path.resolve(base, entry.cwd))
        if (!cwd) return []
        return [[name, { ...entry, cwd }]]
      }
      if (!entry.command.every((item): item is string => typeof item === "string")) return []
      const cwd = typeof entry.cwd === "string" ? path.resolve(base, entry.cwd) : base
      const command = WorkspaceTrust.materializedCommand(trusted, entry.command, cwd, projectEnvironment)
      if (!command) return []
      return [[name, { ...entry, command: command.command, cwd: command.cwd }]]
    }),
  )
}

function stringEnvironment(value: unknown) {
  if (!isRecord(value)) return
  const entries = Object.entries(value)
  if (entries.some(([, item]) => typeof item !== "string")) return
  return Object.fromEntries(entries) as Record<string, string>
}

function trustedExecutableValue(
  value: unknown,
  base: string,
  trusted: WorkspaceTrust.TrustedSnapshot,
  preserveFileUrl = false,
) {
  if (typeof value !== "string") return
  if (value.startsWith("file:")) {
    const target = WorkspaceTrust.materializedPathOption(trusted, fileURLToPath(value))
    if (!target) return
    return preserveFileUrl ? pathToFileURL(target).href : target
  }
  if (/^[A-Za-z]:/.test(value) || value.startsWith("\\\\")) {
    const target = WorkspaceTrust.materializedPathOption(trusted, value)
    if (!target) return
    return preserveFileUrl ? pathToFileURL(target).href : target
  }
  if (URL.canParse(value)) return value
  if (preserveFileUrl && !path.isAbsolute(value) && !value.startsWith(".") && !/^[A-Za-z]:[\\/]/.test(value)) {
    return value
  }
  if (!path.isAbsolute(value) && !value.includes("/") && !value.includes("\\"))
    return WorkspaceTrust.hostExecutable(trusted, value)
  const target = WorkspaceTrust.materializedPathOption(trusted, path.resolve(base, value))
  if (!target) return
  return preserveFileUrl ? pathToFileURL(target).href : target
}

function authorityNarrowingPermission(permission: ConfigPermissionV1.Info | undefined) {
  if (!permission) return
  const entries = Object.entries(permission)
    .map(([name, rule]) => {
      if (rule === "deny") return [name, rule] as const
      if (typeof rule === "string") return
      const patterns = Object.fromEntries(Object.entries(rule).filter(([, action]) => action === "deny"))
      if (Object.keys(patterns).length) return [name, patterns] as const
    })
    .filter((entry) => entry !== undefined)
  if (entries.length) return Object.fromEntries(entries)
}

function toolPermissions(tools: Record<string, boolean>) {
  return Object.fromEntries(
    Object.entries(tools).map(([tool, enabled]) => [
      tool === "write" || tool === "patch" ? "edit" : tool,
      enabled ? "allow" : "deny",
    ]),
  ) as Record<string, ConfigPermissionV1.Action>
}

// Whether a project source allows or asks for anything, which could replace a user deny once merged.
function grantsPermission(config: Pick<Info, "permission" | "tools" | "agent" | "mode">) {
  const permissions = [
    config.permission,
    ...Object.values(config.agent ?? {}).map((agent) => agent?.permission),
    ...Object.values(config.mode ?? {}).map((mode) => mode?.permission),
  ]
  return (
    Object.values(config.tools ?? {}).some(Boolean) ||
    permissions.some((permission) =>
      Object.values(permission ?? {}).some((rule) =>
        typeof rule === "string" ? rule !== "deny" : Object.values(rule).some((action) => action !== "deny"),
      ),
    )
  )
}

function projectProviderEndpointsAllowed(provider: unknown) {
  if (!isRecord(provider)) return true
  const options = isRecord(provider.options) ? provider.options : undefined
  for (const value of [options?.baseURL, options?.baseUrl]) {
    if (typeof value === "string" && !WorkspaceTrust.remoteUrlAllowed(value)) return false
  }
  if (!isRecord(provider.models)) return true
  return Object.values(provider.models).every((model) => {
    if (!isRecord(model) || !isRecord(model.options)) return true
    return [model.options.baseURL, model.options.baseUrl].every(
      (value) => typeof value !== "string" || WorkspaceTrust.remoteUrlAllowed(value),
    )
  })
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

type State = {
  config: Info
  /** A repository's own local block was left out, which the Vector Local pane says. */
  repositoryLocal: boolean
  directories: string[]
  loaded: Loaded
  configDirectory: string | undefined
  deps: Fiber.Fiber<void>[]
  trust: WorkspaceTrust.Snapshot
  trustInputs: readonly string[]
  trustInputWorkspace: string
  trusted: boolean
  trustedSnapshot: WorkspaceTrust.TrustedSnapshot | undefined
  ceiling: PermissionCeiling | undefined
  research: ResearchDomains
}

/**
 * The sites research prefers and avoids by the user's own config and the company's, without any a repository added. A
 * repository's avoid list narrows what research reads, but only these clear a host name from its outbound check.
 */
export type ResearchDomains = { readonly prefer: readonly string[]; readonly avoid: readonly string[] }

/**
 * The config files and directories an instance loaded, spelled where they are on disk rather than where trust copied
 * them: what the prompt guard counts as prompt sources (PromptSource).
 */
export type Loaded = {
  /** The config files it loaded, or looked for in a config directory. */
  readonly files: readonly string[]
  /** The config directories it loaded agents, modes, commands, skills and plugins from. */
  readonly directories: readonly string[]
}

export type TrustStatus = WorkspaceTrust.Status & {
  /**
   * The project is not trusted and that holds something back: its config, .vector or skills content, or the
   * language servers, formatters and local MCP servers the user enabled (see startsInWorkspace).
   */
  ignored: boolean
  /** The project has settings of its own (config, .vector or skills content) that trust decides on. */
  settings: boolean
}

// The permissions the user's own config sources declare, merged without any project file. Set only when a
// trusted project grants something, because the merged config then lets a project allow replace a user deny.
export type PermissionCeiling = {
  permission: ConfigPermissionV1.Info
  agent: Record<string, ConfigPermissionV1.Info>
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly updateMcpLocal: (name: string, entry: ConfigMCPV1.Info | { enabled: boolean }) => Effect.Effect<void>
  readonly removeMcpLocal: (name: string) => Effect.Effect<void>
  readonly storedMcp: (name: string) => Effect.Effect<Record<string, unknown>>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly loaded: () => Effect.Effect<Loaded>
  readonly trustedPath: (path: string) => Effect.Effect<string | undefined>
  readonly waitForDependencies: () => Effect.Effect<void>
  readonly trust: () => Effect.Effect<TrustStatus>
  readonly approve: () => Effect.Effect<void>
  readonly inheritTrust: (directory: string) => Effect.Effect<boolean>
  readonly permissionCeiling: () => Effect.Effect<PermissionCeiling | undefined>
  readonly researchDomains: () => Effect.Effect<ResearchDomains>
  /**
   * The Vector Local policy in effect (Config.local()) as this instance reports it: with a note when the repository's
   * own config has a local block, which never applies.
   */
  readonly localPolicy: () => Effect.Effect<LocalMode.Policy>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Config") {}

export const use = serviceUse(Service)

// Machine-local config layer inside .vector directories. Runtime MCP installs (and their
// tokens/headers) are written here instead of the committable vector.json, so the files
// must stay gitignored.
const LOCAL_CONFIG_FILES = ["vector.local.json", "vector.local.jsonc"]
// How many repository files the ignored budget.run notice remembers having told the user about.
const IGNORED_BUDGETS_KEPT = 200

/**
 * Where the integrations a user adds from the app are kept for one project. They are the user's choice, not the
 * repository's, so they live outside the workspace: trust neither drops them nor is revoked when they change, and a
 * cloned repository cannot plant one.
 */
export function integrationStore(root: string) {
  return path.join(
    Global.Path.state,
    "integrations",
    `${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 32)}.json`,
  )
}

/**
 * Whether the user's own config starts something in the project that the project's files can take over: language
 * servers, formatters or a local MCP server. Until the project is trusted the first two stay off and MCP servers start
 * outside it.
 */
function startsInWorkspace(config: Info) {
  return (
    Boolean(config.lsp || config.formatter) ||
    Object.values(config.mcp ?? {}).some(
      (entry) => "type" in entry && entry.type === "local" && entry.enabled !== false,
    )
  )
}

function globalConfigFile() {
  const candidates = ["vector.jsonc", "vector.json", "config.json"].map((file) => path.join(Global.Path.config, file))
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

// Vector Local's policy for this process. It is process-global, not per repository, and it is resolved synchronously
// when this module loads: before any layer is built, so before any startup fetch (the model catalog, the free-models
// and plans catalogs), and with nothing to wait on, so a fetch that asks for it never waits. It comes from the managed
// policy and the user's own config only: the global config folder and, for the desktop, its own config folder
// (VECTOR_AGENT_CONFIG_DIR). The environment (LocalPolicy.resolve), VECTOR_CONFIG_CONTENT, VECTOR_AGENT_CONFIG and any
// other VECTOR_AGENT_CONFIG_DIR can only tighten it, and a repository's own local block is never read. Config.local()
// is the only reader of it: the merged config (Config.get()) carries no local block. Egress, which the labelled call
// sites and the backstop guard ask, gets each policy as it takes effect.
//
// A change that would loosen it waits for the owner: an edit to the user's config, and a change to an override, whose
// files are read at start and may only tighten what was in effect after it. The parts of a change that tighten apply
// at once: the policy in effect is the stricter of what the owner last let apply and the change, setting by setting
// (stricterLocal). The baseline is what is in effect while this process runs and, at start, the copy of the user's
// block the last process saved in Vector's state folder, so an edit made while Vector was closed is held too. A missing
// or unreadable copy counts as the user's block at start. While Vector Local is off only a change to the identity pin
// of a server on the list is held, so turning it on holds the services, the internet model servers and the sites the
// user's block lets through until the owner confirms them; a change to an identity pin waits like a new server, on or
// off. Model servers on this computer and the user's network apply when Vector Local turns on, as `vector run --local`
// and the VECTOR_LOCAL floor need them to, and requests to one whose identity changed are held until the owner
// confirms it (LocalProbe.verify).
//
// The copy is the user's to change, like the config itself, so it is a check and not a boundary: whatever can write
// the state folder can rewrite or delete it, and what stops the agent there is the ask on its own writes to these
// files. What the copy does stop is a nested vector laundering an edit. A process under the agent marker, which every
// untrusted child of Vector carries (a program the agent started, or Vector's own terminal), never reads or writes it,
// cannot confirm, and adds no model server from VECTOR_LOCAL_POLICY, so the user's config can only tighten the floor it
// inherited. And an edit the environment or the company's policy hides, such as turning the user's own block off while
// VECTOR_LOCAL keeps Local on, is held as well, so it never becomes the block a later start compares with. The floor and
// the marker live in the environment, so a program that clears it (env -i) drops them: they are advisory, and the
// network asks and the sandbox are the boundary.
//
// Known gap, until a later phase closes it: a shell command that removes the copy and turns Vector Local off in the
// user's config reaches no network, so Vector Local asks nothing, and it is off at the next start. An ask on edits to
// the global config path closes it. Until this module is evaluated, Egress holds everything but this computer whenever
// anything Vector Local reads at start may turn it on (LocalStartup, read by the backstop), and the desktop's main
// process resolves its own policy from the desktop's folders.

export type LocalChange =
  | { readonly type: "updated"; readonly policy: LocalMode.Policy }
  | {
      readonly type: "loosening"
      readonly policy: LocalMode.Policy
      readonly proposed: LocalMode.Policy
      readonly changes: readonly string[]
    }

const LOCAL_GLOBAL_FILES = ["config.json", "vector.json", "vector.jsonc"]
const LOCAL_DIRECTORY_FILES = ["vector.json", "vector.jsonc", ...LOCAL_CONFIG_FILES]
// A local block Vector cannot decode keeps Vector Local on, with no web, until it is fixed.
const LOCAL_FAIL_CLOSED: ConfigLocalV1.Info = { enabled: true, web: "none" }
const LOCAL_WEB_LABELS: Record<LocalMode.Web, string> = { ask: "Ask", network: "Your network only", none: "None" }
const LocalConfirmed = Schema.Struct({ local: Schema.NullOr(ConfigLocalV1.Info) })
const LOCAL_OFF = "turns Vector Local off"
// What a company lock always keeps (lockedKeys). autoshare is share's old switch, which would otherwise set it.
const LOCKED_ALWAYS = ["local", "share", "autoshare", "autoupdate"]
// The parts of the user's local block that only record what Vector found about the servers on the list.
const LOCAL_RECORDS = ["pins", "checked"]
// The top-level config keys, which are what `locked_keys` may name.
const CONFIG_KEYS = new Set(Object.keys(ConfigV1.Info.fields))
// Keys that set what a locked key sets, so they are locked with it: a mode becomes an agent, and tools become
// permissions.
const LOCKED_WITH: Record<string, readonly string[]> = { agent: ["mode"], permission: ["tools"] }
// Ollama on Windows answers only on 127.0.0.1, which an engine in WSL's default (NAT) networking cannot reach.
const WSL_GUIDANCE =
  "Ollama on Windows listens on 127.0.0.1 only. Use WSL mirrored networking, or run Ollama inside WSL. Setting OLLAMA_HOST=0.0.0.0 exposes it to your whole network."

type LocalBlock = {
  readonly source: string
  readonly block?: ConfigLocalV1.Info
  /** "block": the file's local block does not decode. "file": Vector could not read the file at all. */
  readonly unreadable?: "block" | "file"
}
type Catalog = Parameters<typeof LocalSources.cloudHosts>[0]
/** What Vector Local is resolved from besides the company's policy and the environment. */
type LocalInputs = {
  readonly user: ConfigLocalV1.Info | undefined
  /** VECTOR_CONFIG_CONTENT and the config-path overrides, which may only tighten it. */
  readonly overrides: readonly LocalBlock[]
}
type LocalPending = {
  readonly proposed: LocalMode.Policy
  readonly changes: readonly string[]
  readonly inputs: LocalInputs
}

const localState: {
  policy: LocalMode.Policy
  /** The inputs in effect: what the owner last let apply, with what has tightened it since. Set at the first resolution. */
  confirmed: LocalInputs | undefined
  /**
   * What the owner just confirmed through the Local API while its write is under way. It stands in for `confirmed`
   * until the caller releases it, so a resolution of the files from before the write cannot take the confirmation back.
   */
  confirming: LocalInputs | undefined
  /**
   * The copy of the user's block in the state folder, as this process last read or wrote it: written only when the
   * block changes, and never over a copy another Vector wrote since.
   */
  saved: string | undefined
  pending: LocalPending | undefined
  /** The held change a repository's config load last announced, so each one is announced there once. */
  announced: string | undefined
  /** The network log's options as last handed to Egress, as JSON, which reopens the log only when they change. */
  log: string | undefined
  /** Cloud AI hosts from the bundled model catalog, read the first time a user's model server is checked. */
  bundledCloud: readonly string[] | undefined
  /** The model catalog the engine loaded last, whose hosts are read the first time a user's model server is checked. */
  catalog: Catalog | undefined
  readonly scanned: WeakSet<Catalog>
  /** Cloud AI hosts from the model catalogs this process read, which only ever grow. */
  readonly loadedCloud: Set<string>
  watchers: number
  stop: (() => void) | undefined
  readonly listeners: Set<(change: LocalChange) => void>
} = {
  policy: LocalPolicy.PENDING,
  confirmed: undefined,
  confirming: undefined,
  saved: undefined,
  pending: undefined,
  announced: undefined,
  log: undefined,
  bundledCloud: undefined,
  catalog: undefined,
  scanned: new WeakSet(),
  loadedCloud: new Set(),
  watchers: 0,
  stop: undefined,
  listeners: new Set(),
}

/** The Vector Local policy in effect for this process. Nothing else may be read for Vector Local's settings. */
export function local() {
  return localState.policy
}

/**
 * The config keys a company lock keeps (`lock: true` in the managed `local` block): Vector Local's block, public
 * sharing and its old switch, automatic updates, and the top-level keys the company names in `locked_keys`. Their
 * values come from company policy alone: when config loads, every other source's are left out, so a list the company
 * sets replaces the user's rather than adding to it, and a key the company locks without setting keeps its default. A
 * change that sets one fails with ConfigLocked (lockedIn). Empty without a lock.
 */
export function lockedKeys(policy: LocalMode.Policy = local()): string[] {
  if (!policy.lock) return []
  const named = policy.locked_keys.filter((key) => CONFIG_KEYS.has(key))
  return [...new Set([...LOCKED_ALWAYS, ...named, ...named.flatMap((key) => LOCKED_WITH[key] ?? [])])]
}

/**
 * The keys of `patch` that a company lock keeps, as ConfigLocked lists them, or none. A top-level key is named as it
 * is; a part of the user's own local block as `local.<key>`. Under a lock the user's local block may still change
 * where the company's `user_may` leaves it to the user (Web access only to a stricter setting), add sites to deny, and
 * keep the identity pins and check results of the servers on the list. A repository's local block never applies, so
 * under a lock `scope: "repository"` refuses any.
 */
export function lockedIn(patch: Info, scope: "global" | "repository", policy: LocalMode.Policy = local()) {
  const locked = lockedKeys(policy)
  if (locked.length === 0) return []
  const values = patch as Record<string, unknown>
  const top = Object.keys(values).filter((key) => key !== "local" && locked.includes(key) && values[key] !== undefined)
  const block = patch.local
  if (!block) return top
  if (scope === "repository") return [...top, "local"]
  const keys = block as Record<string, unknown>
  return [
    ...top,
    ...Object.keys(keys)
      .filter((key) => keys[key] !== undefined && !userMayWrite(policy, key, block))
      .map((key) => `local.${key}`),
  ]
}

// Whether a lock leaves `key` of the user's local block to the user, as `block` would set it.
function userMayWrite(policy: LocalMode.Policy, key: string, block: ConfigLocalV1.Info) {
  if (LOCAL_RECORDS.includes(key)) return true
  const userMay = policy.user_may as readonly string[]
  if (key === "web") return userMay.includes("web") && LocalPolicy.stricter(policy.web, block.web) === block.web
  // A site the user never wants reached only tightens, so denying one is always the user's.
  if (key === "web_domains") return userMay.includes("web_domains") || !block.web_domains?.allow?.length
  return userMay.includes(key)
}

/** The edit to the user's config that would loosen Vector Local and waits for the owner, if there is one. */
export function localPending() {
  const pending = localState.pending
  if (!pending) return undefined
  return { proposed: pending.proposed, changes: pending.changes }
}

/**
 * Where the user's block the owner last let apply is kept between runs, one file per user config location, so the
 * desktop and the CLI, which read different config folders, never hold back each other's settings.
 */
export function localConfirmedFile() {
  const key = createHash("sha256")
    .update(JSON.stringify([Global.Path.config, localFiles().desktop ?? ""]))
    .digest("hex")
    .slice(0, 16)
  return path.join(Global.Path.state, `local-confirmed-${key}.json`)
}

/**
 * Reads Vector Local's sources again and applies them, except the part of a change that would loosen it: that keeps
 * the stricter setting in effect until `confirmLocal`. The watcher calls this, and so should anything that has just
 * written the user's config.
 */
export function refreshLocal() {
  const next = evaluateLocal()
  // Every request is decided with the policy in effect from here on. While Vector Local is on, the network log is
  // written to <data>/local, kept 30 days unless the company's policy, or else the user's config, says otherwise. A
  // log Vector cannot write keeps Vector Local as it is, logs in memory only and says so in the policy's warnings.
  const log = {
    directory: path.join(Global.Path.data, "local"),
    ...(next.retainDays === undefined ? {} : { retainDays: next.retainDays }),
  }
  const reopen = JSON.stringify(log) !== localState.log
  localState.log = JSON.stringify(log)
  const policy = Egress.configure(next.policy, reopen ? { log } : {})
  const changed = JSON.stringify(policy) !== JSON.stringify(localState.policy)
  const asked = next.pending !== undefined && pendingKey(next.pending) !== pendingKey(localState.pending)
  localState.policy = policy
  localState.pending = next.pending
  localState.confirmed = next.confirmed
  saveLocalConfirmed(next.confirmed.user)
  // Children inherit the floor of the policy in effect, and the agent marker: every untrusted child of this process
  // may be the agent or a program it started.
  ChildEnvironment.inherit({ local: policy, agent: true })
  if (changed) localState.listeners.forEach((listener) => listener({ type: "updated", policy }))
  if (next.pending && asked) {
    const pending = next.pending
    localState.listeners.forEach((listener) =>
      listener({ type: "loosening", policy, proposed: pending.proposed, changes: pending.changes }),
    )
    toastHeldLocal(pending)
  }
  return policy
}

/**
 * Lets the held change apply. Only the owner's own answer may lead here, from the app's confirmation dialog or a
 * prompt in a terminal, never the agent: a process under the agent marker cannot confirm, and `vector local` refuses
 * there too.
 */
export function confirmLocal() {
  const pending = localState.pending
  if (pending && !agentMarked()) localState.confirmed = pending.inputs
  return refreshLocal()
}

/**
 * The user's own local block in effect: what the owner last let apply, with what has tightened it since. A change the
 * Local API or `vector local` makes is judged against it, so an edit config is holding never counts as that change's.
 */
export function localConfirmedBlock() {
  return (localState.confirming ?? localState.confirmed)?.user
}

/**
 * Records `block`, the user's block as the owner just confirmed a change to it, as the one to compare with. The caller
 * writes the change next, and that write's resolution holds whatever else the files hold beyond `block`, as before.
 * Only the owner's answer to a dialog that listed what the change loosens may lead here; under the agent marker it
 * records nothing. The watcher, or a model catalog the provider service loads, can resolve the files while the write
 * is under way, so `block` stays the one to compare with until the caller calls the function this returns, after the
 * write's own resolution.
 */
export function confirmingLocal(block: ConfigLocalV1.Info | undefined) {
  if (agentMarked() || !localState.confirmed) return () => {}
  const confirming = { user: block, overrides: localState.confirmed.overrides }
  localState.confirmed = confirming
  localState.confirming = confirming
  return () => {
    if (localState.confirming === confirming) localState.confirming = undefined
  }
}

/**
 * The user's own local block as their config files hold it now, merged in the order config merges them, read from
 * disk rather than from the cached global config, so a change starts from what the files say. `unreadable` names the
 * files Vector cannot read or whose local block it cannot decode, which a change must not write over.
 */
export function localUserBlock(): { readonly block?: ConfigLocalV1.Info; readonly unreadable: readonly string[] } {
  const blocks = localFiles()
    .user.map(localFile)
    .filter((item) => item !== undefined)
  const unreadable = blocks.filter((item) => item.unreadable).map((item) => item.source)
  if (unreadable.length > 0) return { unreadable }
  const block = mergeLocalBlocks(blocks)
  return block ? { block, unreadable } : { unreadable }
}

/** Where the network log is written and for how many days, as Egress was last told. */
export function localLog() {
  const log = Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({ directory: Schema.String, retainDays: Schema.optional(Schema.Number) })),
    )(localState.log ?? ""),
  )
  return {
    directory: log?.directory ?? path.join(Global.Path.data, "local"),
    retain_days: log?.retainDays ?? EgressLogStore.RETAIN_DAYS,
  }
}

/**
 * What writing `block` as the user's own local block would loosen, compared with the block in effect
 * (`localConfirmedBlock`), in the words a held change uses, so the Local API and `vector local` ask the owner before
 * they write it rather than leave the change held. Empty when it only tightens; while Vector Local is off, it names
 * only a new identity (or none) for a server on the list, such as Add server re-pinning one that answers differently.
 * Under the agent marker it is judged as if Vector Local were on, whatever it is now: the owner turning it on later
 * would otherwise let through what the agent added while it was off. The same rules hold the change if it is written
 * anyway.
 */
export function localLoosening(block: ConfigLocalV1.Info | undefined) {
  const sources = readLocalSources()
  const confirmed = localState.confirming ?? localState.confirmed ?? { user: undefined, overrides: sources.overrides }
  const proposed = resolveLocal(sources, { user: block, overrides: sources.overrides })
  return heldChanges(sources.managed, resolveLocal(sources, confirmed), proposed, confirmed.user, block, agentMarked())
}

/**
 * How the owner applies a held change from where this Vector runs. The desktop app has no confirmation of its own yet,
 * and keeps its own copy of the block the owner let apply, which `vector local confirm` never writes. A terminal's
 * `vector local confirm` runs in a process of its own, so a Vector that is running applies what it confirmed only
 * when it next starts; the terminal UI confirms in this Vector itself.
 */
export function localHeldAdvice() {
  if (agentMarked())
    return "An agent or Vector's own terminal started this Vector, so it cannot apply a change like this."
  // The desktop app applies a held change itself, from Settings > Vector Local.
  if (Flag.VECTOR_CLIENT === "desktop") return "To apply it, open Settings → Vector Local and choose Review and apply."
  return "To apply it now, confirm it with /local in the terminal UI. vector local confirm in a terminal applies it when this Vector next starts."
}

/**
 * Adds the provider addresses of a model catalog the engine loaded to the cloud AI hosts a user may not list as a
 * model server of their own. That only takes servers off the list, so it applies at once. The provider service calls
 * this each time it reads the catalog. The catalog is read only while the user lists a server of their own, so a
 * provider nobody uses is never expanded.
 */
export function localCatalog(catalog: Catalog) {
  if (localState.catalog === catalog) return
  localState.catalog = catalog
  const listing = [localState.policy, localState.pending?.proposed].some((policy) =>
    policy?.endpoints.some((item) => item.from !== "managed"),
  )
  if (listing) refreshLocal()
}

/**
 * Announces a held change once a repository's config loads. The first resolution runs when this module loads, before
 * anything listens, so a change held at start would otherwise go unannounced.
 */
function announceHeldLocal() {
  const pending = localState.pending
  if (!pending || pendingKey(pending) === localState.announced) return
  localState.announced = pendingKey(pending)
  toastHeldLocal(pending)
}

// A global config file's prompt-bearing keys wait for the owner when they changed since the owner last approved them
// (PromptTrust); the rest of the file, its providers and sign-ins included, still loads.
// A prompt kept in a file its keys name with `{file:...}` counts as theirs: that file changed is held as well.
function withheld(file: string, info: Info): Info {
  if (PromptTrust.allowed(file) && PromptSource.references(file).every(PromptTrust.allowed)) return info
  return PromptTrust.strip(info)
}

// The held prompt files each process has announced, so a reload does not say it again.
const announcedPrompts = new Set<string>()

/**
 * Says once that prompt files outside the repository wait for the owner. A terminal gets one line on stderr; the
 * terminal UI, whose server runs in a worker beside the screen, shows it as a toast instead; the desktop app shows its
 * own banner from GET /config/prompt-trust.
 */
const announceHeldPrompts = Effect.fnUntraced(function* (held: readonly string[]) {
  if (held.length === 0) return
  yield* Effect.logWarning("holding prompt files that changed since the owner approved them", { count: held.length })
  if (Flag.VECTOR_CLIENT === "desktop" || announcedPrompts.has(held.join("\0"))) return
  announcedPrompts.add(held.join("\0"))
  if (isMainThread) {
    process.stderr.write(`${PromptTrust.notice(held.length)}\n`)
    return
  }
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: TuiEvent.ToastShow.type,
      properties: {
        title: "Prompt files held",
        message: `${PromptTrust.notice(held.length)}.`,
        variant: "warning",
        duration: 15_000,
      },
    },
  })
})

function toastHeldLocal(pending: LocalPending) {
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: TuiEvent.ToastShow.type,
      properties: {
        title: "Vector Local change held",
        message: `A change to your config would loosen Vector Local: it ${pending.changes.join(", ")}. Vector applies the parts that make it stricter and holds the rest. ${localHeldAdvice()}`,
        variant: "warning",
        duration: 15_000,
      },
    },
  })
}

function pendingKey(pending: LocalPending | undefined) {
  return pending && JSON.stringify([pending.changes, pending.proposed])
}

// Every untrusted child of a process that runs agents carries the marker, whatever its value.
function agentMarked() {
  return process.env[ChildEnvironment.AGENT_MARKER] !== undefined
}

export function subscribeLocal(listener: (change: LocalChange) => void) {
  localState.listeners.add(listener)
  return () => {
    localState.listeners.delete(listener)
  }
}

/**
 * Watches the files Vector Local reads, so an edit applies (or is held) while Vector runs. The macOS profile and the
 * Windows policy key apply at the next start. Each caller stops its own watch; the last one closes the watchers.
 */
export function watchLocal() {
  localState.watchers += 1
  if (localState.watchers === 1) localState.stop = startLocalWatchers()
  const stopped = { done: false }
  return () => {
    if (stopped.done) return
    stopped.done = true
    localState.watchers -= 1
    if (localState.watchers > 0) return
    localState.stop?.()
    localState.stop = undefined
  }
}

function evaluateLocal() {
  const sources = readLocalSources()
  const start = localState.confirmed === undefined
  const confirmed = localState.confirming ?? localState.confirmed ?? startConfirmed(sources)
  // A user block Vector cannot decode applies its fail-closed policy at once, and while a user file cannot be read at
  // all the block in effect stays. Neither counts as let apply, so fixing it needs no confirmation.
  const current = {
    user: sources.failed || sources.readable ? sources.user : confirmed.user,
    overrides: sources.overrides,
  }
  const proposed = resolveLocal(sources, current)
  const kept = resolveLocal(sources, confirmed)
  // Turning Vector Local on lets at once only what stays on this computer and the user's network. The services the
  // user's block allows, the model servers it lists on the internet and the sites it lets web pages reach wait for the
  // owner: anything could have added them while Vector Local was off, when only identity pins were held. A pin other
  // than the one the owner let apply waits too.
  const baseline =
    !kept.enabled && proposed.enabled ? { ...confirmed, user: turnedOn(current.user, confirmed.user) } : confirmed
  const changes = sources.failed
    ? []
    : heldChanges(sources.managed, resolveLocal(sources, baseline), proposed, baseline.user, current.user)
  const held = changes.length > 0
  // A held change still applies what it tightens, such as a model server it removes or a stricter Web access: on if
  // either turns Local on, the stricter Web access, only what both list, every site either denies and the longer log.
  // That is what the next start compares with.
  const effect = held
    ? {
        user: stricterLocal(baseline.user, current.user),
        overrides: [
          ...new Map(
            [...baseline.overrides, ...current.overrides].map((item) => [JSON.stringify(item), item]),
          ).values(),
        ],
      }
    : current
  const policy = held ? withWarnings(resolveLocal(sources, effect), proposed.warnings) : proposed
  // A source Vector could not read at all might say anything, so where Vector Local was on it stays on with no web.
  const on = [policy, kept, ...(start ? [] : [localState.policy])].some((item) => item.enabled)
  return {
    policy:
      sources.unread.length > 0 && on
        ? {
            ...policy,
            enabled: true,
            web: "none" as const,
            warnings: [
              ...policy.warnings,
              `Vector Local stays on with Web access None until Vector can read ${sources.unread.join(", ")}.`,
            ],
          }
        : policy,
    confirmed: sources.failed ? confirmed : effect,
    pending: held ? { proposed, changes, inputs: current } : undefined,
    retainDays: retention(sources.managed, (sources.failed ? confirmed : effect).user),
  }
}

// What the last process let apply, read once, at start: the saved copy of the user's block, or the user's block as it
// is now where there is no copy Vector can read. The overrides are read at start too. Under the agent marker the copy
// is neither trusted nor read and the user's block counts for nothing, so the user's config (wherever XDG_CONFIG_HOME
// points) can only tighten what this process inherited.
function startConfirmed(sources: ReturnType<typeof readLocalSources>) {
  if (agentMarked()) return { user: undefined, overrides: sources.overrides }
  const text = readLocalText(localConfirmedFile())
  const saved = text
    ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(LocalConfirmed))(text))
    : undefined
  localState.saved = text ?? undefined
  if (saved) return { user: saved.local ?? undefined, overrides: sources.overrides }
  return { user: sources.readable ? sources.user : undefined, overrides: sources.overrides }
}

/**
 * What a change loosens: in the policy in effect, and in the user's own block as if it alone turned Vector Local on,
 * so a change the environment or the company's policy hides today is held too. While Local is off only a new identity
 * (or none) for a server on the list is held, unless `always` asks what it would loosen if Vector Local were on: the
 * pin is how Vector tells that server from another one in its place, and turning Vector Local on applies the pins the
 * config has at once, so a pin changed while it was off would otherwise go unasked.
 */
function heldChanges(
  managed: ConfigLocalV1.Info | undefined,
  kept: LocalMode.Policy,
  proposed: LocalMode.Policy,
  before: ConfigLocalV1.Info | undefined,
  after: ConfigLocalV1.Info | undefined,
  always = false,
) {
  // A cloud AI service the user listed never applies, so listing one loosens nothing.
  const own = (block: ConfigLocalV1.Info | undefined) =>
    LocalPolicy.resolve({
      global: { ...block, enabled: true },
      ...(block?.endpoints?.length ? { cloudHosts: localCloudHosts() } : {}),
    })
  if (!kept.enabled && !always) return identities(own(before), own(after))
  const changes = [
    ...new Set([
      ...loosening(kept, proposed),
      ...(before?.enabled === true && after?.enabled !== true ? [LOCAL_OFF] : []),
      ...loosening(own(before), own(after)),
      // A shorter network log loosens it too: the log in effect, and the user's own where the company's sets it.
      ...(proposed.enabled ? shorterLog(retention(managed, before), retention(managed, after)) : []),
      ...shorterLog(before?.log?.retain_days, after?.log?.retain_days),
    ]),
  ]
  return changes.includes(LOCAL_OFF) ? [LOCAL_OFF] : changes
}

function shorterLog(before: number | undefined, after: number | undefined) {
  const from = before ?? EgressLogStore.RETAIN_DAYS
  const to = after ?? EgressLogStore.RETAIN_DAYS
  return to < from ? [`keeps the network log ${dayCount(to)} instead of ${dayCount(from)}`] : []
}

/**
 * The user's block as turning Vector Local on applies it at once: without the services it allows, the model servers it
 * lists on the internet and the sites it lets web pages reach, which wait for the owner (evaluateLocal), and with the
 * identity pins the owner let apply (`confirmed`'s), so a different one waits too.
 */
function turnedOn(
  block: ConfigLocalV1.Info | undefined,
  confirmed: ConfigLocalV1.Info | undefined,
): ConfigLocalV1.Info | undefined {
  if (!block) return block
  return {
    ...block,
    endpoints: (block.endpoints ?? []).filter(
      (item) => URL.canParse(item) && LocalPolicy.hostClass(new URL(item).hostname) !== "internet",
    ),
    allow: [],
    web_domains: { ...block.web_domains, allow: [] },
    ...(block.pins || confirmed?.pins ? { pins: { ...block.pins, ...confirmed?.pins } } : {}),
  }
}

/**
 * The stricter of the block the owner last let apply and the user's new one, setting by setting: Vector Local on if
 * either turns it on, the stricter Web access, only the model servers, services and sites both list, every site either
 * denies, the identity pins the owner let apply, and the longer log. The other parts Vector Local does not weigh
 * (checked results, certificates) come from the new block, as they would from an edit that changed only them.
 */
function stricterLocal(before: ConfigLocalV1.Info | undefined, after: ConfigLocalV1.Info | undefined) {
  const endpoints = new Set((before?.endpoints ?? []).map((item) => LocalPolicy.origin(item) ?? item))
  const allows = new Set((before?.allow ?? []).map(allowedKey))
  const sites = new Set(before?.web_domains?.allow ?? [])
  const web = before?.web || after?.web ? LocalPolicy.stricter(before?.web ?? "ask", after?.web) : undefined
  const log = before?.log?.retain_days !== undefined || after?.log?.retain_days !== undefined
  return {
    ...after,
    enabled: before?.enabled === true || after?.enabled === true,
    ...(web ? { web } : {}),
    endpoints: (after?.endpoints ?? []).filter((item) => endpoints.has(LocalPolicy.origin(item) ?? item)),
    allow: (after?.allow ?? []).filter((item) => allows.has(allowedKey(item))),
    web_domains: {
      allow: (after?.web_domains?.allow ?? []).filter((pattern) => sites.has(pattern)),
      deny: [...new Set([...(before?.web_domains?.deny ?? []), ...(after?.web_domains?.deny ?? [])])],
    },
    // A server keeps the identity it was let apply with: a new pin, or none, waits for the owner like a new server.
    ...(before?.pins || after?.pins ? { pins: { ...after?.pins, ...before?.pins } } : {}),
    ...(log
      ? {
          log: {
            retain_days: Math.max(
              before?.log?.retain_days ?? EgressLogStore.RETAIN_DAYS,
              after?.log?.retain_days ?? EgressLogStore.RETAIN_DAYS,
            ),
          },
        }
      : {}),
  } satisfies ConfigLocalV1.Info
}

// How many days the network log is kept: the company's setting, else the user's, which a company lock leaves out.
function retention(managed: ConfigLocalV1.Info | undefined, user: ConfigLocalV1.Info | undefined) {
  return managed?.log?.retain_days ?? (managed?.lock === true ? undefined : user?.log?.retain_days)
}

function dayCount(days: number) {
  return days === 1 ? "1 day" : `${days} days`
}

function withWarnings(policy: LocalMode.Policy, warnings: readonly string[]): LocalMode.Policy {
  return { ...policy, warnings: [...new Set([...policy.warnings, ...warnings])] }
}

// An allow entry as loosening compares it: the source and the hosts it covers.
function allowedKey(item: LocalMode.Allowed) {
  return JSON.stringify([item.source, [...(item.hosts ?? [])].sort()])
}

// An identity pin as loosening compares it, whatever order its fields were written in.
function pinKey(pin: LocalMode.Pin) {
  return JSON.stringify([pin.kind, pin.version ?? null, pin.models ?? null, pin.spki ?? null])
}

function readLocalSources() {
  const managed = ConfigManaged.read()
  const files = localFiles()
  const managedBlocks = [
    ...managed.files.map(localFile),
    ...managed.policies.map((policy) => localBlock(policy.text, policy.source)),
  ].filter((item) => item !== undefined)
  const userBlocks = files.user.map(localFile).filter((item) => item !== undefined)
  const overrides = [
    Flag.VECTOR_CONFIG_CONTENT ? localBlock(Flag.VECTOR_CONFIG_CONTENT, "VECTOR_CONFIG_CONTENT") : undefined,
    ...files.overrides.map(localFile),
  ].filter((item) => item !== undefined)
  const undecodable = (blocks: readonly LocalBlock[]) => blocks.some((item) => item.unreadable === "block")
  const unreadFile = (blocks: readonly LocalBlock[]) => blocks.filter((item) => item.unreadable === "file")
  // Company policy Vector cannot read, or cannot check who may change, might say anything, as one it cannot decode
  // might: either keeps Vector Local on with Web access None, for every user, until it is fixed.
  const managedUnread = [
    ...managed.ignored.filter((item) => item.kind === "unreadable").map((item) => item.source),
    ...unreadFile(managedBlocks).map((item) => item.source),
  ]
  // The company's blocks merge as config merges files: a later source's list replaces an earlier one's.
  const company =
    undecodable(managedBlocks) || managedUnread.length > 0 ? LOCAL_FAIL_CLOSED : mergeLocalBlocks(managedBlocks)
  return {
    managed: company,
    user: undecodable(userBlocks) ? LOCAL_FAIL_CLOSED : mergeLocalBlocks(userBlocks),
    failed: undecodable(userBlocks),
    // While a user file cannot be read, the block in effect stays the one to compare with.
    readable: !userBlocks.some((item) => item.unreadable),
    unread: unreadFile([...userBlocks, ...overrides]).map((item) => item.source),
    overrides: overrides.filter((item) => item.unreadable !== "file"),
    warnings: [
      ...managed.ignored.map((item) =>
        item.kind === "untrusted" ? `${ConfigManaged.UNTRUSTED} ${item.reason}` : item.reason,
      ),
      ...files.ignored.map(
        (file) =>
          `Ignored ${file}: it is inside the repository Vector started in, and only your user config and your company's policy set Vector Local.`,
      ),
      ...[...managedBlocks, ...userBlocks]
        .filter((item) => item.unreadable === "block")
        .map(
          (item) =>
            `Vector could not read the local block in ${item.source}, so Vector Local stays on with Web access None until it is fixed.`,
        ),
      ...unreadFile([...managedBlocks, ...userBlocks, ...overrides]).map(
        (item) => `Vector could not read ${item.source}.`,
      ),
      ...(managedUnread.length > 0
        ? [
            `Vector Local stays on with Web access None until Vector can read ${managedUnread.join(", ")}, which may hold your company's policy.`,
          ]
        : []),
      ...(company?.lock === true
        ? (company.locked_keys ?? [])
            .filter((key) => !CONFIG_KEYS.has(key))
            .map(
              (key) =>
                `Ignored ${key} in your company's locked_keys: Vector locks top-level config keys only, such as model or provider.`,
            )
        : []),
    ],
  }
}

/**
 * The config files Vector Local reads. `user`: the user's own, in the order the config loader merges them, which set
 * it. `overrides`: VECTOR_AGENT_CONFIG, and a VECTOR_AGENT_CONFIG_DIR that is not the desktop's own config folder
 * (the desktop names itself with VECTOR_CLIENT=desktop), which may only tighten it. `ignored`: either of those inside
 * the repository Vector started in, which the repository's .envrc can name, and which is not read at all.
 */
function localFiles() {
  const repository = startRepository()
  const inside = (file: string) => repository !== undefined && ConfigPaths.projectContains(file, repository)
  const agentConfig = localPath(Flag.VECTOR_AGENT_CONFIG)
  const agentDirectory = localPath(Flag.VECTOR_AGENT_CONFIG_DIR)
  const directoryFiles = agentDirectory ? LOCAL_DIRECTORY_FILES.map((file) => path.join(agentDirectory, file)) : []
  const desktop =
    agentDirectory && Flag.VECTOR_CLIENT === "desktop" && !inside(agentDirectory) ? agentDirectory : undefined
  return {
    desktop,
    user: [
      ...LOCAL_GLOBAL_FILES.map((file) => path.join(Global.Path.config, file)),
      ...(desktop ? directoryFiles : []),
    ],
    overrides: [
      ...(agentConfig && !inside(agentConfig) ? [agentConfig] : []),
      ...(agentDirectory && !desktop && !inside(agentDirectory) ? directoryFiles : []),
    ],
    ignored: [agentConfig, agentDirectory].filter((item): item is string => item !== undefined && inside(item)),
  }
}

// The folder Vector started in and the git worktree above it, leaving out a folder that holds the user's home: the
// desktop starts in the filesystem root, and a home folder is not a repository.
function startRepository() {
  const directory = process.cwd()
  if (FSUtil.contains(directory, Global.Path.home)) return undefined
  const worktree = gitRoot(directory)
  return { directory, worktree: worktree && !FSUtil.contains(worktree, Global.Path.home) ? worktree : undefined }
}

function gitRoot(directory: string): string | undefined {
  if (existsSync(path.join(directory, ".git"))) return directory
  const parent = path.dirname(directory)
  if (parent === directory) return undefined
  return gitRoot(parent)
}

// A path an environment variable names, spelled as the config loader spells it (ConfigPaths.environmentPath).
function localPath(input: string | undefined) {
  if (!input) return undefined
  return path.resolve(FSUtil.windowsPath(input))
}

// A file's text, undefined when it does not exist, or null when the file system refuses to read it (no permission, a
// folder in its place).
function readLocalText(file: string) {
  if (!existsSync(file)) return undefined
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

function localFile(file: string): LocalBlock | undefined {
  const text = readLocalText(file)
  if (text === null) return { source: file, unreadable: "file" }
  return localBlock(text, file)
}

// The local block of one config text, without {env:} or {file:} substitution. A legacy TOML config predates it.
function localBlock(text: string | undefined, source: string): LocalBlock | undefined {
  if (!text || !/^\s*[{/]/.test(text)) return undefined
  const value: unknown = parse(text, [], { allowTrailingComma: true })
  if (!isRecord(value) || value.local === undefined) return undefined
  return Option.match(Schema.decodeUnknownOption(ConfigLocalV1.Info)(value.local), {
    onNone: () => ({ source, unreadable: "block" as const }),
    onSome: (block) => ({ source, block }),
  })
}

function mergeLocalBlocks(blocks: readonly LocalBlock[]) {
  return blocks.reduce<ConfigLocalV1.Info | undefined>(
    (merged, item) => (item.block ? (mergeDeep(merged ?? {}, item.block) as ConfigLocalV1.Info) : merged),
    undefined,
  )
}

function resolveLocal(sources: ReturnType<typeof readLocalSources>, inputs: LocalInputs) {
  // A user may not list a cloud AI service as their own model server. The catalogs' hosts are read only when there is
  // a server of the user's to check.
  const listing = Boolean(inputs.user?.endpoints?.length || process.env.VECTOR_LOCAL_POLICY?.trim())
  const resolved = inputs.overrides.reduce(
    tightenLocal,
    LocalPolicy.resolve({
      managed: sources.managed,
      global: inputs.user,
      env: process.env,
      ...(listing ? { cloudHosts: localCloudHosts() } : {}),
    }),
  )
  // Only the desktop sets VECTOR_LOCAL_POLICY, for an engine it starts in WSL, and the desktop never runs under the
  // agent marker. Under it anything could have set it, so it may still turn Local on and tighten Web access but adds
  // no model server.
  const forged = agentMarked() ? resolved.endpoints.filter((item) => item.from === "environment") : []
  const endpoints = resolved.endpoints.filter((item) => !forged.includes(item))
  // The desktop says how WSL networks an engine it starts there. In NAT mode this computer's loopback inside WSL is not
  // Windows', so a server Windows runs on 127.0.0.1 is out of reach.
  const wsl =
    process.env.VECTOR_LOCAL_WSL_NETWORK === "nat" &&
    resolved.enabled &&
    endpoints.some((item) => {
      const origin = LocalPolicy.origin(item.origin)
      return origin !== undefined && LocalPolicy.loopback(new URL(origin).hostname)
    })
  return {
    ...resolved,
    endpoints,
    warnings: [
      ...new Set([
        ...sources.warnings,
        ...resolved.warnings,
        ...(forged.length > 0
          ? [
              "Ignored the model servers in VECTOR_LOCAL_POLICY: an agent or Vector's own terminal started this Vector, so it cannot add one.",
            ]
          : []),
        ...(wsl ? [WSL_GUIDANCE] : []),
      ]),
    ],
  }
}

/**
 * The cloud AI hosts a user may not list as a model server: the registry's, the bundled catalog's and those of every
 * catalog this process read.
 */
export function localCloudHosts() {
  localState.bundledCloud ??= LocalSources.cloudHosts(ModelCatalog.bundled() ?? {})
  const loaded = localState.catalog
  if (loaded && !localState.scanned.has(loaded)) {
    localState.scanned.add(loaded)
    LocalSources.cloudHosts(loaded).forEach((host) => localState.loadedCloud.add(host))
  }
  return [...new Set([...localState.bundledCloud, ...localState.loadedCloud])]
}

// VECTOR_CONFIG_CONTENT and the config-path overrides may turn Vector Local on, pick a stricter Web access and add
// sites to deny. Everything else they say about it would loosen it, so it is left out with a warning.
function tightenLocal(policy: LocalMode.Policy, override: LocalBlock): LocalMode.Policy {
  if (!override.block)
    return {
      ...policy,
      enabled: true,
      web: "none",
      warnings: [
        ...policy.warnings,
        `Vector could not read the local block in ${override.source}, so Vector Local stays on with Web access None.`,
      ],
    }
  const block = override.block
  const web = LocalPolicy.stricter(policy.web, block.web)
  const ignored = [
    block.enabled === false && policy.enabled ? "enabled" : undefined,
    block.web !== undefined && web !== block.web ? "web" : undefined,
    block.endpoints?.length ? "endpoints" : undefined,
    block.allow?.length ? "allow" : undefined,
    block.web_domains?.allow?.length ? "web_domains.allow" : undefined,
    ...LocalPolicy.MANAGED_ONLY.filter((key) => block[key] !== undefined),
  ].filter((key) => key !== undefined)
  return {
    ...policy,
    enabled: policy.enabled || block.enabled === true,
    web,
    web_domains: {
      allow: policy.web_domains.allow,
      deny: [...policy.web_domains.deny, ...(block.web_domains?.deny ?? [])],
    },
    warnings: [
      ...policy.warnings,
      ...(ignored.length > 0
        ? [
            `Ignored ${ignored.join(", ")} in the local block of ${override.source}: it can only make Vector Local stricter.`,
          ]
        : []),
    ],
  }
}

/**
 * What `after` would loosen compared with `before`, in words for the owner: turning Vector Local off, a looser Web
 * access, a new model server, a new identity (or none) for a server on the list, a newly allowed service or site, or a
 * site no longer denied. Empty when it only tightens.
 */
export function loosening(before: LocalMode.Policy, after: LocalMode.Policy) {
  if (!before.enabled) return []
  if (!after.enabled) return [LOCAL_OFF]
  const endpoints = new Set(before.endpoints.map(endpointKey))
  const allows = new Set(before.allow.map(allowedKey))
  return [
    ...(LocalPolicy.stricter(after.web, before.web) !== after.web
      ? [`sets Web access to ${LOCAL_WEB_LABELS[after.web]}`]
      : []),
    ...after.endpoints
      .filter((item) => !endpoints.has(endpointKey(item)))
      .map((item) => `adds the model server ${item.origin}`),
    ...identities(before, after),
    // The hosts are part of the line, so widening an entry's hosts reads differently from the entry the owner saw.
    ...after.allow
      .filter((item) => !allows.has(allowedKey(item)))
      .map((item) => `allows ${item.source} for ${item.hosts?.length ? item.hosts.join(", ") : "any host"}`),
    ...after.web_domains.allow
      .filter((pattern) => !before.web_domains.allow.includes(pattern))
      .map((pattern) => `lets web pages reach ${pattern}`),
    ...before.web_domains.deny
      .filter((pattern) => !after.web_domains.deny.includes(pattern))
      .map((pattern) => `stops blocking ${pattern}`),
  ]
}

/**
 * A new identity, or none, for each server on both lists. A pin is how Vector tells the server on the list from
 * another one in its place, so replacing or removing the pin of a server that stays listed lets a different server
 * receive the prompts.
 */
function identities(before: LocalMode.Policy, after: LocalMode.Policy) {
  const endpoints = new Set(before.endpoints.map(endpointKey))
  return after.endpoints
    .filter((item) => endpoints.has(endpointKey(item)))
    .flatMap((item) => {
      const origin = LocalPolicy.origin(item.origin) ?? item.origin
      const was = before.pins?.[origin]
      const now = after.pins?.[origin]
      if (!was || (now && pinKey(now) === pinKey(was))) return []
      return [now ? `accepts a new identity for ${origin}` : `stops checking the identity of ${origin}`]
    })
}

function endpointKey(item: LocalMode.Endpoint) {
  return `${item.from} ${LocalPolicy.origin(item.origin) ?? item.origin}`
}

function saveLocalConfirmed(block: ConfigLocalV1.Info | undefined) {
  const text = JSON.stringify({ local: block ?? null }, null, 2)
  // A process under the agent marker never writes the copy a later start trusts: it never read it, and the user's
  // config it read may be the agent's.
  if (agentMarked() || text === localState.saved) return
  const file = localConfirmedFile()
  // Another Vector of the user's wrote the copy since this one last read or wrote it, such as `vector local confirm` in
  // a terminal: what it recorded stands, and is what the next start compares with. A copy that already says what
  // this one would write (a thread of this process that resolved Vector Local too) is this one's as well.
  const current = readLocalText(file)
  if (current === text) {
    localState.saved = text
    return
  }
  if (current && current !== localState.saved) return
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  // Best effort: a copy that cannot be written only means the next start compares with an older block, or with none.
  try {
    writeFileSync(temporary, text, { mode: 0o600 })
    renameSync(temporary, file)
    localState.saved = text
  } catch {
    return
  }
}

function startLocalWatchers() {
  const timer: { current?: ReturnType<typeof setTimeout> } = {}
  const schedule = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(refreshLocal, 50)
    timer.current.unref?.()
  }
  const user = localFiles().user
  const targets = [...new Set([...user.map((file) => path.dirname(file)), ...ConfigManaged.directories()])]
  const names = new Set([...user.map((file) => path.basename(file)), "vector.json", "vector.jsonc"])
  const watchers = targets.flatMap((directory) => {
    if (!existsSync(directory)) return []
    // A folder that cannot be watched (removed, or out of watches) still applies at the next start.
    try {
      const watcher = watch(directory, { persistent: false }, (_event, name) => {
        if (!name || names.has(name)) schedule()
      })
      watcher.on("error", () => watcher.close())
      return [watcher]
    } catch {
      return []
    }
  })
  return () => {
    clearTimeout(timer.current)
    watchers.forEach((watcher) => watcher.close())
  }
}

refreshLocal()

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const teams = yield* Teams.Service
    const env = yield* Env.Service
    const dependencies = yield* ConfigDependencies.Service
    // An organization's config is the remote-config source's, so Vector Local decides each read of it.
    const http = EgressHttpClient.make(yield* HttpClient.HttpClient)
    const flock = yield* EffectFlock.Service
    // Edits to the files Vector Local reads apply, or are held, while this layer is up.
    yield* Effect.acquireRelease(Effect.sync(watchLocal), (stop) => Effect.sync(stop))

    // `root` is where the import may write: the folder itself for the user's own, the workspace for a project's.
    const importSettings = (directory: string, local = false, root = directory) =>
      ConfigImport.run(directory, local, root).pipe(
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(EffectFlock.Service, flock),
        Effect.orDie,
      )

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      // Vector Local keeps an organization's config out until its host is listed or the source is allowed. It is
      // decided here, before the retries below, so a refusal is logged once and not tried again.
      const policy = Egress.policy()
      const verdict = policy.enabled
        ? LocalPolicy.decide(policy, { purpose: "config-remote", url, source: "remote-config" })
        : undefined
      if (verdict && verdict.decision !== "allow") {
        Egress.record({ source: "remote-config", url }, verdict)
        yield* Effect.logWarning(
          `Vector Local blocked the organization config at ${url}. List its host or allow remote config to load it.`,
        )
        return
      }
      const response = yield* withTransientReadRetry(http)
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          EgressHttpClient.labelled("remote-config"),
          Effect.catch((error) =>
            error.reason._tag === "TransportError" && error.reason.cause instanceof EgressGuard.EgressBlocked
              ? Effect.succeed(undefined)
              : Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`)),
          ),
        )
      // A hop Vector Local refused as it was sent, such as a redirect to a host it does not allow.
      if (!response) {
        yield* Effect.logWarning(`Vector Local blocked a request for the organization config at ${url}.`)
        return
      }
      if (response.status === 404 && url.endsWith("/.well-known/vector")) {
        yield* Effect.logWarning(
          `Organization config at ${url} is not available for Vector (HTTP 404). Ask your administrator to serve /.well-known/vector, or run vector providers logout ${loginOrigin}. Skipping this organization config.`,
        )
        return
      }
      if (response.status < 200 || response.status >= 300)
        return yield* Effect.die(new Error(`Remote config at ${url} returned HTTP ${response.status}`))
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
      preserveSource = false,
      opaqueCredentials = false,
    ) {
      const source = "path" in options ? options.path : options.source
      const parseSource =
        "path" in options ? ({ type: "path", path: options.path } as const) : ({ type: "virtual", ...options } as const)
      // An untrusted project's {env:...} and {file:...} stay as written: reading them is the project's choice, not the
      // user's, and a device or FIFO path could hang the load.
      const parsed = opaqueCredentials
        ? ConfigParse.jsonc(text, source)
        : ConfigParse.jsonc(
            yield* Effect.promise(() => ConfigVariable.substitute({ ...parseSource, text, env })),
            source,
          )
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed), source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      const updated = ConfigSchema.rewrite(text)
      // Only the user's own files are rewritten here, and never through a link: a linked settings file belongs to
      // whatever it points at.
      if (updated !== text && !preserveSource && FSUtil.writableInside(path.dirname(options.path), options.path)) {
        data.$schema = "https://vectordev.ai/config.json"
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (
      filepath: string,
      env?: Record<string, string>,
      preserveSource = false,
      opaqueCredentials = false,
    ) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      const normalized = /^\s*[{/]/.test(text) ? text : JSON.stringify(ConfigMigration.parseConfig(text, filepath))
      return yield* loadConfig(normalized, { path: filepath }, env, preserveSource, opaqueCredentials)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      yield* importSettings(Global.Path.config)
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.VECTOR_AGENT_CONFIG && !Flag.VECTOR_AGENT_CONFIG_DIR && !Flag.VECTOR_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file) && FSUtil.writableInside(Global.Path.config, file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://vectordev.ai/config.json" }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }

      for (const [name, preserve] of [
        ["config.json", true],
        ["vector.json", false],
        ["vector.jsonc", false],
      ] as const) {
        const file = path.join(Global.Path.config, name)
        result = mergeConfig(result, withheld(file, yield* loadFile(file, env, preserve)))
      }

      // The user's own files as written, local block included: an update replaces a list, so adding a model server to
      // the user's list starts from this one, and the servers they listed have no per-token price. What Vector Local
      // is in effect comes only from Config.local(), and merge() keeps the block out of the merged config.
      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      // Mask cache publication too: protecting only the loader lets its pending interruption become the cached exit.
      return yield* Effect.uninterruptible(cachedGlobal)
    })

    // A repository's budget.run stopped applying when spend limits became one overall set, and its subagent spend
    // limits (budget.subagents usd, steps, warnAt, unpricedSteps) never apply. Say so once per repository
    // file and key, so a cap someone relied on does not disappear silently, without repeating it on every load. Parallel
    // agents and copies of a repository load it from new folders, so a file is remembered by the repository it belongs
    // to (its remote or first commit, which worktrees and copies share) and its path inside it rather than by where it
    // sits on disk, with each key it was named for. A folder without Git has no such identity; its copies share the
    // file's content instead. Only the most recent entries are remembered, so the list cannot grow without bound.
    const noticeIgnoredRunBudgets = Effect.fn("Config.noticeIgnoredRunBudgets")(function* (
      workspace: string,
      repository: string,
      ignored: { source: string; keys: string[] }[],
    ) {
      yield* Effect.logWarning("ignoring spend limits in repository config; spend limits cover every repository", {
        ignored,
      })
      const file = path.join(Global.Path.state, "ignored-repository-budgets.json")
      const noticed = yield* fs.readJson(file).pipe(
        Effect.map((value) =>
          Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
        ),
        Effect.orElseSucceed((): string[] => []),
      )
      const entries = yield* Effect.forEach(ignored, ({ source, keys: dropped }) =>
        Effect.gen(function* () {
          const relative = path.relative(workspace, source) || source
          if (repository !== "global") {
            const id = `${repository}:${relative}`
            // An entry without a key is from 1.99.111, which named budget.run alone.
            const settings = dropped.filter(
              (setting) => !noticed.includes(`${id}#${setting}`) && !(setting === "budget.run" && noticed.includes(id)),
            )
            return { relative, settings, keys: settings.map((setting) => `${id}#${setting}`) }
          }
          const content = (yield* fs.readFileStringSafe(source).pipe(Effect.orElseSucceed(() => undefined))) ?? ""
          const key = `content:${createHash("sha256").update(`${relative}\n${content}`).digest("hex").slice(0, 32)}`
          return { relative, settings: noticed.includes(key) ? [] : dropped, keys: [key] }
        }),
      )
      const fresh = entries.filter((entry) => entry.settings.length > 0)
      if (!fresh.length) return
      const keys = fresh.flatMap((entry) => entry.keys)
      yield* fs
        .writeWithDirs(
          file,
          JSON.stringify([...noticed.filter((key) => !keys.includes(key)), ...keys].slice(-IGNORED_BUDGETS_KEPT)),
        )
        .pipe(Effect.ignore)
      const files = fresh.map((entry) => entry.relative).join(" and ")
      const settings = [...new Set(fresh.flatMap((entry) => entry.settings))]
      const named = settings.join(" and ")
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: TuiEvent.ToastShow.type,
          properties: {
            title: "Repository spend cap ignored",
            message: `This repository's ${files} ${fresh.length === 1 ? "sets" : "set"} ${named}, which ${settings.length === 1 ? "does" : "do"} not apply from a repository: spend limits now cover all your repositories together. ${
              Flag.VECTOR_CLIENT === "desktop"
                ? "Set your limits in Settings, under Spend limits."
                : `Set ${named} in ${path.join(Global.Path.config, "vector.json")} instead${settings.includes("budget.run") ? ", or pass --max-cost to vector run" : ""}.`
            }`,
            variant: "warning",
            duration: 15_000,
          },
        },
      })
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string, root: string) {
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      // A dangling link reads as missing, and writing it would create the file it points at.
      if (!hasIgnore && FSUtil.writableInside(root, gitignore)) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore", ...LOCAL_CONFIG_FILES].join(
              "\n",
            ),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)
        const managed = ConfigManaged.read()
        const projectFiles = Flag.VECTOR_DISABLE_PROJECT_CONFIG
          ? []
          : yield* ConfigPaths.files("vector", ctx.directory, ctx.worktree).pipe(Effect.orDie)
        const projectTuiFiles = Flag.VECTOR_DISABLE_PROJECT_CONFIG
          ? []
          : yield* ConfigPaths.files("tui", ctx.directory, ctx.worktree).pipe(Effect.orDie)
        // A file or directory an env var names is project config when it is inside the project under any spelling.
        const agentConfig = yield* ConfigPaths.environmentPath(Flag.VECTOR_AGENT_CONFIG, ctx)
        const agentConfigDir = yield* ConfigPaths.environmentPath(Flag.VECTOR_AGENT_CONFIG_DIR, ctx)
        // Not loaded here, but captured as the TUI captures it, so both reach the same trust decision.
        const tuiConfig = yield* ConfigPaths.environmentPath(Flag.VECTOR_TUI_CONFIG, ctx)
        const allDirectories = Array.from(
          new Set(
            (yield* ConfigPaths.directories(ctx.directory, ctx.worktree)).map(
              (directory) => ConfigPaths.projectPath(directory, ctx) ?? directory,
            ),
          ),
        )
        // Above a non-git workspace the upward walk also finds .vector folders in its parents, such as the top of an
        // extracted archive or a shared /tmp. The vector.json files beside them already load as the project's, and so
        // do these: their settings stay narrowed and their plugins, commands and agents wait for trust, as the TUI and
        // core already treat them. The user's own folders are never among them.
        const parentDirectories =
          ctx.worktree === "/"
            ? allDirectories.filter(
                (directory) =>
                  path.basename(directory) === ".vector" &&
                  !ConfigPaths.userOwned(directory) &&
                  FSUtil.contains(path.dirname(directory), ctx.directory) &&
                  !FSUtil.contains(ctx.directory, directory),
              )
            : []
        const projectContains = (file: string) =>
          ConfigPaths.projectContains(file, ctx) ||
          parentDirectories.some((directory) => FSUtil.contains(directory, file))
        const projectDirectories = allDirectories.filter(projectContains)
        const localAgentConfig = agentConfig?.project ? [agentConfig.path] : []
        const trustWorkspace = ctx.worktree === "/" ? ctx.directory : ctx.worktree
        // Where a config folder may be written, never through a link: a project folder only where it really is inside
        // the workspace, a folder above a non-git workspace only inside the folder that holds it, and the user's own
        // folder only inside itself.
        const writeRoot = (dir: string) =>
          parentDirectories.includes(dir) ? path.dirname(dir) : projectContains(dir) ? trustWorkspace : dir
        const prepareProjectFile = Effect.fnUntraced(function* (filepath: string) {
          // This runs before any trust decision, and writing follows links: a project's vector.json linked, or
          // hard-linked, to ../../.codex/config.toml would turn that file into JSON. Only a plain file really inside
          // the workspace is rewritten.
          if (!FSUtil.writableInside(trustWorkspace, filepath)) return
          const text = yield* readConfigFile(filepath)
          if (!text) return
          const normalized = /^\s*[{/]/.test(text) ? text : JSON.stringify(ConfigMigration.parseConfig(text, filepath))
          const updated = ConfigSchema.rewrite(normalized)
          if (updated === normalized) return
          yield* fs.writeFileString(filepath, updated).pipe(Effect.catch(() => Effect.void))
        })
        const trustInputs = [
          ...projectFiles,
          ...projectTuiFiles,
          ...projectDirectories,
          ...localAgentConfig,
          ...(tuiConfig?.project ? [tuiConfig.path] : []),
        ]
        const captureTrustSnapshot = () =>
          WorkspaceTrust.snapshot(trustWorkspace, trustInputs).catch((cause) =>
            WorkspaceTrust.unavailableSnapshot(trustWorkspace, cause),
          )
        const existingTrustSnapshot = yield* Effect.promise(captureTrustSnapshot)
        const snapshotFailure = WorkspaceTrust.unavailableReason(existingTrustSnapshot)
        if (snapshotFailure) {
          yield* Effect.logWarning("disabling project config because workspace trust capture failed", {
            workspace: trustWorkspace,
            reason: snapshotFailure,
          })
        }
        const existingStoredTrust = yield* Effect.promise(() =>
          WorkspaceTrust.status(Global.Path.state, existingTrustSnapshot),
        )
        if (!snapshotFailure && !existingStoredTrust.trusted) {
          yield* Effect.forEach(
            new Set([
              ...projectFiles,
              ...localAgentConfig,
              ...projectDirectories.flatMap((directory) =>
                ["vector.json", "vector.jsonc", ...LOCAL_CONFIG_FILES].map((file) => path.join(directory, file)),
              ),
            ]),
            prepareProjectFile,
            { discard: true },
          )
        }
        const trustSnapshot =
          existingStoredTrust.trusted || snapshotFailure
            ? existingTrustSnapshot
            : yield* Effect.promise(captureTrustSnapshot)
        const storedTrust = yield* Effect.promise(() => WorkspaceTrust.status(Global.Path.state, trustSnapshot))
        const trusted = !Flag.VECTOR_PURE && storedTrust.trusted
        if (!trusted && !Flag.VECTOR_PURE && WorkspaceTrust.hasInputs(trustSnapshot)) {
          yield* Effect.logWarning("ignoring project config until the workspace is trusted", {
            workspace: trustWorkspace,
          })
        }
        const trustedSnapshot = trusted
          ? yield* Effect.promise(() => WorkspaceTrust.materialize(Global.Path.state, trustSnapshot))
          : undefined
        const workspace = ctx.worktree === "/" ? ctx.directory : ctx.worktree

        const loadProjectFile = Effect.fnUntraced(function* (
          filepath: string,
          env?: Record<string, string>,
          opaqueCredentials = false,
        ) {
          yield* Effect.logInfo("loading captured project config", { path: filepath })
          const text = WorkspaceTrust.readFileString(trustSnapshot, filepath)
          if (!text) return {} as Info
          const source = trustedSnapshot ? WorkspaceTrust.materializedPath(trustedSnapshot, filepath) : filepath
          const normalized = /^\s*[{/]/.test(text) ? text : JSON.stringify(ConfigMigration.parseConfig(text, filepath))
          const loaded = yield* loadConfig(normalized, { path: source }, env, true, opaqueCredentials)
          if (!trustedSnapshot) return loaded
          const bound = bindTrustedProjectExecutables(loaded, trustedSnapshot, workspace, filepath)
          // Trust drops what it cannot bind to approved bytes; say which, so a missing integration is explicable.
          const dropped = (["formatter", "lsp", "mcp"] as const).flatMap((key) => {
            const before = loaded[key]
            const after = bound[key]
            if (!isRecord(before) || !isRecord(after)) return []
            return Object.keys(before)
              .filter((name) => !(name in after))
              .map((name) => `${key}.${name}`)
          })
          if (dropped.length)
            yield* Effect.logWarning("trust left out project commands it cannot bind to approved bytes", {
              path: filepath,
              dropped,
            })
          return bound
        })

        let result: Info = {}
        const authEnv: Record<string, string> = {}

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "VECTOR_CONFIG_CONTENT") return "local"
          if (projectContains(source)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        // The user's own sources merged alone, and whether a trusted project granted any permission over them.
        let userPermissions: Pick<Info, "permission" | "tools" | "agent"> = {}
        // The user's own and the company's research block merged alone: a repository's avoid list joins the merged
        // config, never this one.
        let userResearch: Pick<Info, "research"> = {}
        let projectGrants = false
        // Repository files whose budget.run or subagent spend limits were dropped, for the notice once loading ends.
        const ignoredRunBudgets: { source: string; keys: string[] }[] = []

        // Only Config.local() says what Vector Local is: it was resolved at start from the user's own config files and
        // the company's policy (refreshLocal), so no source's local block reaches the merged config. A repository's is
        // never read, and the policy this instance reports says so; VECTOR_CONFIG_CONTENT's and the config-path
        // overrides' only tightened it.
        const localConfig = localFiles()
        const localSources = new Set([Global.Path.config, ...managed.files, ...localConfig.user])
        const startOverrides = new Set(["VECTOR_CONFIG_CONTENT", ...localConfig.overrides])
        const localDirectory = localConfig.desktop ?? Global.Path.config
        let repositoryLocal = false
        // Under a company lock only company policy sets the keys it keeps: every other source's values for them are
        // left out here, so the company's lists replace the user's and the repository's instead of adding to them.
        const locked = lockedKeys().filter((key) => key !== "local")
        const companyFiles = new Set(managed.files)

        const merge = (source: string, input: Info, kind?: ConfigPlugin.Scope) => {
          const scope = kind ?? (projectContains(source) ? "local" : "global")
          const projectSource = scope === "local" && source !== "VECTOR_CONFIG_CONTENT"
          const values = input as Record<string, unknown>
          const kept = companyFiles.has(source) ? [] : locked.filter((key) => values[key] !== undefined)
          const dropped = [...(input.local === undefined ? [] : ["local"]), ...kept]
          const next = dropped.length === 0 ? input : (omit(input, dropped as (keyof Info)[]) as Info)
          const spendKeys = projectSource ? ignoredSpendKeys(next) : []
          if (spendKeys.length) ignoredRunBudgets.push({ source, keys: spendKeys })
          const safe = projectSource ? projectExecutableConfig(next, trusted, result) : next
          if (projectSource) projectGrants ||= grantsPermission(safe)
          // Only the keys a source sets: merging an undefined key would erase what an earlier user source declared,
          // as an empty integration store loaded after the project would.
          else
            userPermissions = mergeConfigConcatArrays(userPermissions, {
              ...(safe.permission && { permission: safe.permission }),
              ...(safe.tools && { tools: safe.tools }),
              ...(safe.agent && { agent: safe.agent }),
            })
          if (!projectSource && safe.research) userResearch = mergeConfig(userResearch, { research: safe.research })
          result = mergeConfigConcatArrays(result, safe)
          if (projectSource && input.local !== undefined) repositoryLocal = true
          const ignored =
            input.local === undefined || localSources.has(source)
              ? Effect.void
              : projectSource
                ? Effect.logWarning(LocalPolicy.REPOSITORY_IGNORED, { source })
                : startOverrides.has(source)
                  ? Effect.logDebug("this config's local block only tightened Vector Local at start", { source })
                  : Effect.logWarning(
                      `Ignored the local block in ${source}: Vector Local is read only from your user config in ${localDirectory} and from your company's policy.`,
                    )
          const lockedOut =
            kept.length === 0
              ? Effect.void
              : Effect.logWarning(`Your company's policy sets ${kept.join(", ")}, so ${source} does not.`)
          return ignored.pipe(Effect.andThen(lockedOut), Effect.andThen(mergePluginOrigins(source, safe.plugin, scope)))
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/vector`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            if (!wellknown) continue
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  // Vector Local blocked it, as the warning said: the organization's config is skipped whole.
                  if (data === undefined) return undefined
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            if (!fetchedConfig) continue
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://vectordev.ai/config.json"
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const team = yield* teams.current().pipe(Effect.orDie)
        if (team.active) {
          const source = `https://vectordev.ai/api/org/config?org=${team.active.id}`
          const next = yield* loadConfig(
            JSON.stringify(team.active.config),
            { dir: "https://vectordev.ai", source },
            authEnv,
          )
          yield* merge(source, next, "global")
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (agentConfig) {
          const next = agentConfig.project
            ? yield* loadProjectFile(agentConfig.path, authEnv, !trusted)
            : withheld(agentConfig.path, yield* loadFile(agentConfig.path, authEnv, true))
          yield* merge(agentConfig.path, next, agentConfig.project ? "local" : "global")
          yield* Effect.logDebug("loaded custom config", { path: agentConfig.path })
        }

        if (!Flag.VECTOR_DISABLE_PROJECT_CONFIG) {
          for (const file of projectFiles) {
            yield* merge(file, yield* loadProjectFile(file, authEnv, !trusted), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = allDirectories
          .filter((directory) => !projectContains(directory) || trusted)
          .map((directory) =>
            projectContains(directory) && trustedSnapshot
              ? WorkspaceTrust.materializedPath(trustedSnapshot, directory)
              : directory,
          )

        if (agentConfigDir) {
          yield* Effect.logDebug("loading config from VECTOR_AGENT_CONFIG_DIR", { path: agentConfigDir.path })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of allDirectories) {
          const local = projectContains(dir)
          const runtimeDir = local && trustedSnapshot ? WorkspaceTrust.materializedPath(trustedSnapshot, dir) : dir
          if (dir.endsWith(".vector") || dir === agentConfigDir?.path) {
            if (dir === agentConfigDir?.path) yield* importSettings(dir, false, writeRoot(dir))
            if (!local || trusted) yield* importSettings(dir, true, writeRoot(dir))
            // Local files merge after the shared ones so machine-local settings win.
            for (const file of ["vector.json", "vector.jsonc", ...LOCAL_CONFIG_FILES]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              const next = local
                ? yield* loadProjectFile(source, authEnv, !trusted)
                : withheld(source, yield* loadFile(source, authEnv))
              yield* merge(source, next)
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          if (local && !trusted) continue

          // The desktop also owns .vector directories containing repository state and rules.
          const runtimeFiles =
            dir === Global.Path.config ||
            dir === agentConfigDir?.path ||
            (yield* fs.isFile(path.join(runtimeDir, "package.json"))) ||
            (yield* Effect.forEach(["plugin", "plugins", "tool", "tools"], (name) =>
              fs.isDir(path.join(runtimeDir, name)),
            )).some(Boolean)
          if (runtimeFiles) yield* ensureGitignore(dir, writeRoot(dir)).pipe(Effect.orDie)

          // A folder's commands, agents and plugins are its config too, so a company lock on them leaves them out.
          if (!locked.includes("command"))
            result.command = mergeDeep(
              result.command ?? {},
              yield* Effect.promise(() => ConfigCommand.load(runtimeDir, PromptTrust.allowed)),
            )
          const agents = mergeDeep(
            locked.includes("agent")
              ? {}
              : yield* Effect.promise(() => ConfigAgent.load(runtimeDir, PromptTrust.allowed)),
            locked.includes("mode")
              ? {}
              : yield* Effect.promise(() => ConfigAgent.loadMode(runtimeDir, PromptTrust.allowed)),
          )
          if (local) projectGrants ||= grantsPermission({ agent: agents })
          else userPermissions = mergeConfigConcatArrays(userPermissions, { agent: agents })
          result.agent = mergeDeep(result.agent ?? {}, agents)
          // Auto-discovered plugins under `.vector/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          if (!locked.includes("plugin"))
            yield* mergePluginOrigins(
              dir,
              yield* Effect.promise(() => ConfigPlugin.load(runtimeDir, PromptTrust.allowed)),
            )
        }

        if (!Flag.VECTOR_DISABLE_PROJECT_CONFIG) {
          const store = integrationStore(workspace)
          yield* merge(store, yield* loadFile(store, authEnv), "global")
        }

        if (Flag.VECTOR_CONFIG_CONTENT) {
          const source = "VECTOR_CONFIG_CONTENT"
          const next = yield* loadConfig(
            Flag.VECTOR_CONFIG_CONTENT,
            {
              dir: ctx.directory,
              source,
            },
            undefined,
            false,
            false,
          )
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from VECTOR_CONFIG_CONTENT")
        }

        // Company policy counts only where a standard user could not have written it (ConfigManaged.read).
        if (managed.ignored.length > 0)
          yield* Effect.logWarning(
            "left out company policy that a standard user could change or Vector could not read",
            {
              ignored: managed.ignored,
            },
          )
        for (const source of managed.files) {
          yield* merge(source, yield* loadFile(source), "global")
        }

        // The macOS MDM profile and the Windows policy key override everything
        for (const policy of managed.policies) {
          const next = yield* loadConfig(policy.text, {
            dir: path.dirname(policy.source),
            source: policy.source,
          })
          userPermissions = mergeConfigConcatArrays(userPermissions, {
            ...(next.permission && { permission: next.permission }),
            ...(next.tools && { tools: next.tools }),
            ...(next.agent && { agent: next.agent }),
          })
          if (next.research) userResearch = mergeConfig(userResearch, { research: next.research })
          result = mergeConfigConcatArrays(result, omit(next, ["local"]))
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.VECTOR_PERMISSION && !locked.includes("permission")) {
          try {
            const permission = JSON.parse(Flag.VECTOR_PERMISSION)
            result.permission = mergeDeep(result.permission ?? {}, permission)
            userPermissions.permission = mergeDeep(userPermissions.permission ?? {}, permission)
          } catch (err) {
            yield* Effect.logWarning("VECTOR_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) result.permission = mergeDeep(toolPermissions(result.tools), result.permission ?? {})

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        // Preferences do not grant publication consent. The sharing service only
        // auto-publishes after explicit, account-bound consent in the trusted store.
        result.share ??= result.autoshare ? "auto" : "manual"

        if (Flag.VECTOR_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.VECTOR_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        if (!InstallationLocal && result.plugin?.length) {
          deps.push(yield* dependencies.prepare().pipe(Effect.forkDetach))
        }

        if (ignoredRunBudgets.length) yield* noticeIgnoredRunBudgets(workspace, ctx.project.id, ignoredRunBudgets)
        announceHeldLocal()

        const settings = WorkspaceTrust.hasInputs(trustSnapshot)
        const desktop = Flag.VECTOR_CLIENT === "desktop"
        // Without this the repository's agents, commands and default model, or the user's language servers,
        // formatters and MCP servers, would vanish or change with no explanation. The desktop app asks once about a
        // repository's own settings and remembers "Not now", so repeating it on every load would undo that answer;
        // it never asks about a repository without settings, where only the user's tools are held back.
        if (!trusted && !Flag.VECTOR_PURE && (settings ? !desktop : startsInWorkspace(result))) {
          const held = settings
            ? "Vector is not loading this repository's vector.json or .vector settings until you trust it, and keeps your language servers, formatters and MCP servers out of it."
            : "Vector keeps your language servers, formatters and MCP servers out of this repository until you trust it."
          GlobalBus.emit("event", {
            directory: "global",
            payload: {
              type: TuiEvent.ToastShow.type,
              properties: {
                title: settings ? "Repository settings ignored" : "Repository not trusted",
                // The desktop ships no vector command, and the published CLI predates /trust and `vector trust`.
                message: `${held} ${
                  desktop
                    ? "Trust it in Settings, under Repository trust."
                    : "Use /trust in the TUI, Repository trust in the app's Settings, or run `vector trust approve` in the repository."
                }`,
                variant: "warning",
                duration: 15_000,
              },
            },
          })
        }

        // What the prompt guard counts: the files and directories loaded for prompts and permissions, which an
        // untrusted repository's are not. The hold records any root it has not seen and says what it holds.
        const loadedDirectories = allDirectories.filter((directory) => !projectContains(directory) || trusted)
        const loaded = {
          files: [
            ...["config.json", "vector.json", "vector.jsonc"].map((file) => path.join(Global.Path.config, file)),
            ...(agentConfig && (!agentConfig.project || trusted) ? [agentConfig.path] : []),
            ...(trusted ? projectFiles : []),
            ...loadedDirectories
              .filter((dir) => dir.endsWith(".vector") || dir === agentConfigDir?.path)
              .flatMap((dir) =>
                ["vector.json", "vector.jsonc", ...LOCAL_CONFIG_FILES].map((file) => path.join(dir, file)),
              ),
          ],
          directories: loadedDirectories,
        }
        const prompts = PromptTrust.scope(
          PromptSource.build({
            ...loaded,
            skills: result.skills?.paths ?? [],
            instructions: result.instructions ?? [],
            home: Global.Path.home,
            config: Global.make().config,
            directory: ctx.directory,
            worktree: ctx.worktree,
          }),
          ctx,
        )
        yield* PromptTrust.record(prompts)
        yield* announceHeldPrompts(yield* PromptTrust.held(prompts))

        return {
          config: result,
          repositoryLocal,
          directories,
          loaded,
          configDirectory:
            agentConfigDir?.project && trustedSnapshot
              ? WorkspaceTrust.materializedPath(trustedSnapshot, agentConfigDir.path)
              : agentConfigDir?.path,
          deps,
          trust: trustSnapshot,
          trustInputs,
          trustInputWorkspace: trustWorkspace,
          trusted,
          trustedSnapshot,
          ceiling:
            trusted && projectGrants
              ? {
                  permission: mergeDeep(toolPermissions(userPermissions.tools ?? {}), userPermissions.permission ?? {}),
                  agent: Object.fromEntries(
                    Object.entries(userPermissions.agent ?? {}).flatMap(([name, agent]) =>
                      agent?.permission ? [[name, agent.permission]] : [],
                    ),
                  ),
                }
              : undefined,
          research: {
            prefer: userResearch.research?.domains?.prefer ?? [],
            avoid: userResearch.research?.domains?.avoid ?? [],
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
      Effect.provideService(EffectFlock.Service, flock),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const loaded = Effect.fn("Config.loaded")(function* () {
      return yield* InstanceState.use(state, (s) => s.loaded)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const permissionCeiling = Effect.fn("Config.permissionCeiling")(function* () {
      return yield* InstanceState.use(state, (s) => s.ceiling)
    })

    const researchDomains = Effect.fn("Config.researchDomains")(function* () {
      return yield* InstanceState.use(state, (s) => s.research)
    })

    const localPolicy = Effect.fn("Config.localPolicy")(function* () {
      const repository = yield* InstanceState.use(state, (s) => s.repositoryLocal)
      const policy = local()
      if (!repository) return policy
      return { ...policy, warnings: [LocalPolicy.REPOSITORY_IGNORED, ...policy.warnings] }
    })

    const trustedPath = Effect.fn("Config.trustedPath")(function* (path: string) {
      return yield* InstanceState.use(state, (s) =>
        s.trustedSnapshot ? WorkspaceTrust.materializedPathOption(s.trustedSnapshot, path) : undefined,
      )
    })

    const trust = Effect.fn("Config.trust")(function* () {
      return yield* InstanceState.useEffect(state, (s) =>
        Effect.promise(async () => {
          const status = await WorkspaceTrust.status(Global.Path.state, s.trust)
          return {
            ...status,
            ignored:
              !status.trusted &&
              !Flag.VECTOR_PURE &&
              (WorkspaceTrust.hasInputs(s.trust) || startsInWorkspace(s.config)),
            settings: WorkspaceTrust.hasInputs(s.trust),
          }
        }),
      )
    })

    const approve = Effect.fn("Config.approve")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, s.trust)),
      )
    })

    const inheritTrust = Effect.fn("Config.inheritTrust")(function* (directory: string) {
      return yield* InstanceState.useEffect(state, (s) =>
        Effect.tryPromise({
          try: async () => {
            if (!s.trusted || Flag.VECTOR_PURE) return false
            // loaded() omits TUI settings and declined inputs; inheritance must compare the exact capture inputs.
            const inputs = s.trustInputs.map((input) => {
              if (FSUtil.contains(s.trustInputWorkspace, input)) {
                return path.join(directory, path.relative(s.trustInputWorkspace, input))
              }
              if (FSUtil.contains(s.trust.workspace, input)) {
                return path.join(directory, path.relative(s.trust.workspace, input))
              }
              return input
            })
            const child = await WorkspaceTrust.snapshot(directory, inputs)
            return WorkspaceTrust.inherit(Global.Path.state, s.trust, child)
          },
          catch: (cause) => cause,
        }).pipe(Effect.orElseSucceed(() => false)),
      )
    })

    // The config a file holds as written: {env:...} and {file:...} references stay
    // unresolved, so a secret restored from it goes back as its reference. Plugin
    // specs resolve as they do on load, so each plugin tuple a client sends back
    // pairs with the stored one.
    const storedFile = Effect.fnUntraced(function* (file: string) {
      const text = yield* readConfigFile(file)
      if (!text || !/^\s*[{/]/.test(text)) return {}
      const stored = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(ConfigParse.jsonc(text, file)), file)
      return yield* Effect.promise(() => resolveLoadedPlugins(stored, file))
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const ctx = yield* InstanceState.context
      const file = path.join(ctx.directory, "vector.json")
      // The project's vector.json can be a link to any file of the user's, which a write would replace.
      const workspace = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      if (!FSUtil.writableInside(workspace, file))
        return yield* Effect.die(
          new Error(`Cannot save settings to ${file}: it is a link, not a plain file, or outside ${workspace}.`),
        )
      // As written: {env:...} and {file:...} resolved here would be saved into the project file in place of their
      // references, and an untrusted project's {file:...} could name any file of the user's.
      const existing = yield* loadFile(file, undefined, false, true)
      // A client sends secrets back as Redaction.MARKER. Restoring them before the
      // merge keeps the ones inside arrays, such as plugin options, which a deep
      // merge replaces wholesale.
      const patch = Redaction.restore(writable(config), yield* storedFile(file))
      yield* fs.writeFileString(file, JSON.stringify(mergeDeep(writable(existing), patch), null, 2)).pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    // Persists a runtime MCP mutation into the project's integration store so it
    // survives a backend restart. A full entry replaces the server's config wholesale (a
    // deep patch could leave e.g. a stale `command` behind a type switch to "remote");
    // an { enabled } entry only flips the flag, layering over configs defined elsewhere.
    const updateMcpLocal = Effect.fn("Config.updateMcpLocal")(function* (
      name: string,
      entry: ConfigMCPV1.Info | { enabled: boolean },
    ) {
      const ctx = yield* InstanceState.context
      // Non-git projects have worktree "/", which is not a usable project root.
      const file = integrationStore(ctx.worktree === "/" ? ctx.directory : ctx.worktree)
      const before =
        (yield* readConfigFile(file)) ?? JSON.stringify({ $schema: "https://vectordev.ai/config.json" }, null, 2)
      const edits = modify(
        before,
        "type" in entry ? ["mcp", name] : ["mcp", name, "enabled"],
        "type" in entry ? entry : entry.enabled,
        { formattingOptions: { insertSpaces: true, tabSize: 2 } },
      )
      if (!FSUtil.writableInside(path.dirname(file), file))
        return yield* Effect.die(new Error(`Cannot save the integration to ${file}: it is a link or not a plain file.`))
      yield* fs.writeWithDirs(file, applyEdits(before, edits)).pipe(Effect.orDie)
    })

    // The MCP entry as the config files hold it, merged in load order. get() has
    // {env:...} and {file:...} references resolved; writing that back would put the
    // resolved secret into a file in place of its reference.
    const storedMcp = Effect.fn("Config.storedMcp")(function* (name: string) {
      const ctx = yield* InstanceState.context
      const settings = yield* InstanceState.use(state, (s) => s)
      const agentConfig = yield* ConfigPaths.environmentPath(Flag.VECTOR_AGENT_CONFIG, ctx)
      const project = Flag.VECTOR_DISABLE_PROJECT_CONFIG
        ? []
        : yield* ConfigPaths.files("vector", ctx.directory, ctx.worktree).pipe(
            Effect.provideService(FSUtil.Service, fs),
            Effect.provideService(EffectFlock.Service, flock),
            Effect.orDie,
          )
      const files = [
        ...["config.json", "vector.json", "vector.jsonc"].map((file) => path.join(Global.Path.config, file)),
        ...(agentConfig ? [agentConfig.path] : []),
        ...project,
        ...settings.directories
          .filter((dir) => dir.endsWith(".vector") || dir === settings.configDirectory)
          .flatMap((dir) => ["vector.json", "vector.jsonc", ...LOCAL_CONFIG_FILES].map((file) => path.join(dir, file))),
        ...(Flag.VECTOR_DISABLE_PROJECT_CONFIG
          ? []
          : [integrationStore(ctx.worktree === "/" ? ctx.directory : ctx.worktree)]),
        ...ConfigManaged.read().files,
      ]
      const entries = yield* Effect.forEach(files, (file) =>
        readConfigFile(file).pipe(
          Effect.map((text) => {
            const parsed: unknown = text ? parse(text, [], { allowTrailingComma: true }) : undefined
            return isRecord(parsed) && isRecord(parsed.mcp) ? parsed.mcp[name] : undefined
          }),
        ),
      )
      return entries.filter(isRecord).reduce<Record<string, unknown>>((merged, entry) => mergeDeep(merged, entry), {})
    })

    const removeMcpLocal = Effect.fn("Config.removeMcpLocal")(function* (name: string) {
      const ctx = yield* InstanceState.context
      const root = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      // Integrations added before the store existed were written into the project's .vector directory. Each file is
      // written only inside where it belongs, never through a link.
      for (const [file, owner] of [
        [integrationStore(root), path.dirname(integrationStore(root))],
        ...LOCAL_CONFIG_FILES.map((item) => [path.join(root, ".vector", item), root]),
      ]) {
        if (!FSUtil.writableInside(owner, file)) {
          yield* Effect.logWarning("left an integration in a file that is a link or outside the project", { file })
          continue
        }
        const before = yield* readConfigFile(file)
        if (!before) continue
        const edits = modify(before, ["mcp", name], undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        })
        if (!edits.length) continue
        yield* fs.writeFileString(file, applyEdits(before, edits)).pipe(Effect.orDie)
      }
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      yield* importSettings(Global.Path.config)
      const file = globalConfigFile()
      const original = (yield* readConfigFile(file)) ?? "{}"
      const before = ConfigSchema.rewrite(original)
      const patch = Redaction.restore(writableGlobal(config), yield* storedFile(file))

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(before, file), file)
        const merged = mergeDeep(writable(existing), patch)
        const serialized = JSON.stringify(merged, null, 2)
        changed = serialized !== original
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
        next = merged
      } else {
        const updated = patchJsonc(before, patch)
        next = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(updated, file), file)
        changed = updated !== original
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      // What an update tightens in Vector Local applies now, and what it loosens is held for the owner, as by hand.
      if (changed) refreshLocal()
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      update,
      updateGlobal,
      updateMcpLocal,
      removeMcpLocal,
      storedMcp,
      invalidate,
      directories,
      loaded,
      waitForDependencies,
      trust,
      trustedPath,
      approve,
      inheritTrust,
      permissionCeiling,
      researchDomains,
      localPolicy,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Teams.node, Env.node, ConfigDependencies.node, httpClient, EffectFlock.node],
})

export * as Config from "./config"
