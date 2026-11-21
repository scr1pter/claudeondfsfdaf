import os from "node:os"
import { Option, Schema } from "effect"
import { ConfigEverywhereV1 } from "@vectordevai/core/v1/config/everywhere"
import { ConfigPermissionV1 } from "@vectordevai/core/v1/config/permission"
import type { PermissionV1 } from "@vectordevai/schema/permission-v1"
import type { UnattendedShellPolicy } from "./everywhere-engine"

// Vector everywhere's settings on this computer, read from the engine's GET /global/config (EV-10, EV-17, EV-18). It
// imports only core, schema and a type from everywhere-engine.ts, so the engine's behaviour test
// (unattended-session.test.ts) reads the user's rules exactly as the runner does without compiling the rest of the
// desktop (F5).

export type RunnerSettings = {
  readonly enabled: boolean
  readonly modelAllowed: boolean
  readonly maxUsd: number
  readonly minutes: number
  readonly atOnce: number
  readonly perDay: number
  readonly push: boolean
  readonly projects: readonly { readonly directory: string; readonly repository: string; readonly base: string }[]
  readonly rules?: readonly PermissionV1.Rule[]
  /** The engine's offline shell (EV-16's probe): only `offline-v1` lets the session run commands. Absent is `none`. */
  readonly shell?: UnattendedShellPolicy
  readonly model?: { readonly providerID: string; readonly modelID: string }
}

export type EverywhereSettings = RunnerSettings & {
  readonly waitForComputer: boolean
  readonly stayAwake: boolean
  /** Whether the engine's last definite answer offers the unattended worktree (EV-13). Absent while the block is off. */
  readonly worktree?: boolean
}
type Project = { readonly directory: string; readonly repository: string }
export type ProjectFolder = (
  project: Project,
) => Promise<{ readonly directory: string; readonly base: string } | undefined>

/** The settings' own cap; the merged config could list more (EV-10, Coordination). */
const MAX_PROJECTS = 64
const Tools = Schema.Record(Schema.String, Schema.Boolean)

/**
 * RunnerSettings from GET /global/config's answer (EV-10, Coordination for EV-17). Only the user's own files reach that
 * route. Locked, undecodable or absent is off, and an off block resolves no folder at all. Each listed folder goes
 * through `folder` (canonical path and default branch); one it cannot resolve is dropped, so its jobs decline
 * `not-mapped`. The same folder under two spellings is kept once. `rules` are the user's own permission rules and the
 * asks and denies of their default agent (EV-18, userRules); a block among them that does not decode is off too.
 */
export async function everywhereSettings(global: unknown, folder: ProjectFolder): Promise<EverywhereSettings> {
  const answer = typeof global === "object" && global !== null ? (global as Record<string, unknown>) : {}
  // A company lock on the key turns it off; an answer without the list is read as locked.
  const locked = !unlocked(answer, "everywhere")
  const info = Option.getOrUndefined(Schema.decodeUnknownOption(ConfigEverywhereV1.Info)(answer.everywhere))
  const rules = userRules(answer)
  const enabled = info?.enabled === true && !locked && rules !== undefined
  const defaults = ConfigEverywhereV1.Defaults
  const model = info?.model
  const slash = model?.indexOf("/") ?? -1
  return {
    ...offSettings(),
    enabled,
    maxUsd: info?.max_usd ?? defaults.max_usd,
    minutes: info?.minutes ?? defaults.minutes,
    atOnce: info?.at_once ?? defaults.at_once,
    perDay: info?.per_day ?? defaults.per_day,
    push: info?.push ?? defaults.push,
    waitForComputer: info?.wait_for_computer ?? defaults.wait_for_computer,
    stayAwake: info?.stay_awake ?? defaults.stay_awake,
    ...(model && slash > 0 ? { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } } : {}),
    ...(enabled && rules && rules.length > 0 ? { rules } : {}),
    projects: enabled ? await resolveProjects(info?.projects ?? [], folder) : [],
  }
}

/** Whether GET /global/config's answer lists the company locks and `key` is not among them. */
export function unlocked(global: unknown, key: string) {
  const locked = typeof global === "object" && global !== null ? (global as { locked?: unknown }).locked : undefined
  return Array.isArray(locked) && !locked.includes(key)
}

/**
 * The user's own rules, lowest first: the denies of the legacy top-level `tools` map, the top-level permission rules,
 * then the asks and denies of their default agent (`default_agent`, else `build`; the job's checkout is never trusted,
 * so no repository picks another), from its `agent` block and its legacy `mode` block, which the engine merges into it.
 * That agent's allows, and a switched-on tool, are left out: where they sit against the other rules is not known here,
 * and an ask or a deny copied anywhere can only stop a call, never let one through. Undefined when any of these blocks
 * does not decode.
 */
function userRules(answer: Record<string, unknown>) {
  const name = typeof answer.default_agent === "string" ? answer.default_agent : "build"
  const tools = answer.tools === undefined ? Option.some({}) : Schema.decodeUnknownOption(Tools)(answer.tools)
  const top = decodePermission(answer.permission)
  const agent = decodePermission(agentPermission(answer.agent, name))
  const mode = decodePermission(agentPermission(answer.mode, name))
  if (Option.isNone(tools) || Option.isNone(top) || Option.isNone(agent) || Option.isNone(mode)) return undefined
  return [
    // As the engine reads the map (config.ts toolPermissions): `write` and `patch` are `edit`, and the block outranks it.
    ...Object.entries(tools.value)
      .filter(([, enabled]) => !enabled)
      .map(([tool]) => ({
        permission: tool === "write" || tool === "patch" ? "edit" : tool,
        pattern: "*",
        action: "deny" as const,
      })),
    ...permissionRules(top.value),
    ...[...permissionRules(agent.value), ...permissionRules(mode.value)].filter((rule) => rule.action !== "allow"),
  ]
}

function agentPermission(agents: unknown, name: string) {
  const agent = typeof agents === "object" && agents !== null ? (agents as Record<string, unknown>)[name] : undefined
  return typeof agent === "object" && agent !== null ? (agent as { permission?: unknown }).permission : undefined
}

// In the order written; GET /global/config's encoding has already put the known keys first.
const decodePermission = (value: unknown) =>
  value === undefined
    ? Option.some<ConfigPermissionV1.Info>({})
    : Schema.decodeUnknownOption(ConfigPermissionV1.Info)(value, { propertyOrder: "original" })

/**
 * A permission block as the engine reads it (permission/index.ts fromConfig, which the desktop cannot import): each
 * key's patterns in their order, a bare action as pattern `*`, and the engine's own `~` and `$HOME` expansion.
 */
function permissionRules(permission: ConfigPermissionV1.Info): PermissionV1.Rule[] {
  return Object.entries(permission).flatMap(([key, value]): PermissionV1.Rule[] => {
    if (value === undefined) return []
    if (typeof value === "string") return [{ permission: key, pattern: "*", action: value }]
    return Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action }))
  })
}

// A copy of the engine's permission/index.ts `expand`.
function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

// One folder at a time, so a long list never starts dozens of git processes at once.
async function resolveProjects(projects: readonly Project[], folder: ProjectFolder) {
  const kept: RunnerSettings["projects"][number][] = []
  const seen = new Set<string>()
  for (const project of projects) {
    if (kept.length >= MAX_PROJECTS) break
    const found = await folder(project).catch(() => undefined)
    if (!found) continue
    // realpath resolves links; a case-insensitive disk (the macOS and Windows default) still has two spellings.
    const key =
      process.platform === "win32" || process.platform === "darwin" ? found.directory.toLowerCase() : found.directory
    if (seen.has(key)) continue
    seen.add(key)
    kept.push({ directory: found.directory, repository: project.repository, base: found.base })
  }
  return kept
}

export function offSettings(): EverywhereSettings {
  const defaults = ConfigEverywhereV1.Defaults
  return {
    enabled: false,
    // 2026-11-16 (EV-17): no up-front model check; a guest prompt to a model that may train is refused by the engine.
    modelAllowed: true,
    maxUsd: defaults.max_usd,
    minutes: defaults.minutes,
    atOnce: defaults.at_once,
    perDay: defaults.per_day,
    push: defaults.push,
    waitForComputer: defaults.wait_for_computer,
    stayAwake: defaults.stay_awake,
    projects: [],
  }
}
