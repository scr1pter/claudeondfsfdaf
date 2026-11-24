import { Option, Schema } from "effect"
import type { GlobalSession, ProjectTrustStatus } from "@vectordevai/sdk/v2/client"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { UNATTENDED_KEY } from "@vectordevai/core/everywhere/frame"
import { EverywherePreferenceWire } from "@vectordevai/core/everywhere/preferences"
import { ConfigEverywhereV1 } from "@vectordevai/core/v1/config/everywhere"
import { isJobId, isPlatform, type PlatformId } from "@vectordevai/schema/everywhere"
import { EVERYWHERE_PAGE, PLATFORM_NAMES } from "@vectordevai/schema/everywhere-policy"
import type { RemoteStatus } from "@/context/platform"
import { pathKey } from "@/utils/path-key"
import { JOBS_ONLY_LINE, stateLine } from "./remote-model"
import { projectTrustSummary } from "./project-trust-model"

/*
 * Settings → Vector everywhere (VE-41). The built-in sidecar supplies the same settings to this panel and the runner.
 * Older Desktop versions supply their global config for viewing. This computer's jobs still come from its engine's
 * sessions marked `vector.unattended`.
 */

export type EverywhereView = {
  /** `loading` until GET /global/config answers, `failed` when it could not be read. */
  readonly state: "loading" | "failed" | "ready"
  /** The user's own block says `enabled: true`, whatever the lock or the rest of the block says. Only the tab's gate reads it. */
  readonly written: boolean
  /** A company lock covers the key, or the answer lists no locks at all (everywhere-settings.ts `unlocked`). */
  readonly locked: boolean
  /** The block does not decode, so the engine refuses the whole settings file. */
  readonly invalid: boolean
  /**
   * On as far as this block decides: written, unlocked and valid. The runner also needs the user's permission rules to
   * decode (everywhere-settings.ts), so this is not a promise that jobs run.
   */
  readonly enabled: boolean
  /** A company lock on a key that can carry permission rules: jobs edit files but run no commands (EV-18 (i)). */
  readonly rulesLocked: boolean
  readonly maxUsd: number
  readonly minutes: number
  readonly atOnce: number
  readonly perDay: number
  readonly model?: string
  readonly waitForComputer: boolean
  readonly push: boolean
  readonly stayAwake: boolean
  readonly projects: readonly { readonly directory: string; readonly repository: string }[]
}

export type EverywhereJob = {
  readonly id: string
  readonly title: string
  readonly directory: string
  readonly jid: string
  readonly platform: PlatformId
  readonly platformName: string
  readonly updated: number
  /** The title of a new session continued from this job, at most 100 characters. */
  readonly continueTitle: string
}

/**
 * This computer's Vector Remote as the page knows it: `loading` until the desktop's status answers, undefined when
 * this app has no Remote or its status could not be read (read as off).
 */
export type RemoteState = RemoteStatus | "loading" | undefined

/**
 * Whether a listed folder is trusted, as far as the page may ask. `closed`: not open in Vector, so it is not read,
 * because reading it would load the folder in the engine (EV-13 (c)); `reading`; `read` with the engine's answer, or
 * undefined when it could not be read.
 */
export type FolderTrust =
  | { readonly kind: "closed" }
  | { readonly kind: "reading" }
  | { readonly kind: "read"; readonly status?: ProjectTrustStatus }

/**
 * The config keys that can carry permission rules: under a company lock on any of them the runner keeps the session's
 * commands off. A copy of desktop everywhere-wiring.ts `RULE_KEYS`, which the app cannot import; the model test reads
 * that file and compares.
 */
export const RULE_KEYS: readonly string[] = ["permission", "tools", "agent", "mode", "default_agent"]

export const CLOSED_LID =
  "A closed lid puts this computer to sleep, even with this on. While it sleeps, a job waits for it only if Wait for my computer is on, and for at most about two hours (ten minutes for Jira)."

export const PAGE_DESCRIPTION =
  "Jobs started from a chat or an issue run on this computer, each in its own copy of a repository you allow. Jobs are off unless this computer's settings file turns them on. This page shows those settings and changes none of them."

/**
 * What a job's own session keeps if you continue it there. Each limit is the engine's: the shell marks
 * (session/unattended-shell.ts, fixed at creation), the job's stored permission rules, the outward audience
 * (session/prompt.ts audienceOf) and the guest mark on the session tree (core free-model-guests.ts,
 * task/isolation.ts).
 */
export const OWN_SESSION_LIMITS =
  "Continuing a job in its own session keeps the job's limits: its commands run only offline and inside the job's folder, the job's permission rules stay, it hears how you work but nothing personal about you, free models that may train on prompts stay refused, and its subagents cannot run in task isolation. Continue in a new session on this branch starts an ordinary session in the job's folder instead."

/**
 * Said beside Continue: the folder is still the job's work. The engine keeps it untrusted, but a session there reads
 * the folder's AGENTS.md and CLAUDE.md whether or not it is trusted (engine session/instruction.ts `systemPaths`), so
 * the new session's first prompt already carries instruction files the job may have written. Continue is for a job
 * that has finished: while it runs, the job and a new session would change the same files.
 */
export const CONTINUE_NOTE =
  "Continue a job in a new session only once it has finished: while it runs, the job and the new session would change the same files. The job's folder holds files the job wrote, its settings and instruction files included. Vector keeps the folder untrusted, so its settings, formatters and language servers stay off unless you trust it, but a new session there still reads its AGENTS.md and other instruction files from its first message. Read what changed before you continue or run anything there."

/** Said in place of Continue while this app has heard that the job's session is still working. */
export const JOB_RUNNING = "Still running. You can continue it in a new session once it has finished."

export const VERSION_NOTE =
  "Vector 1.99.112 and earlier cannot read a settings file that holds these settings, even with jobs off."

export const REPOSITORY_RULE =
  "A job runs only in a folder listed here, and only while the folder's GitHub remote is the repository named beside it, the folder is open in Vector and you trust it. Nothing is listed by default."

export const PUSH_RULE = "For a private repository only. A public repository's branch always stays on this computer."

/**
 * Said above the settings a job runs with. The runner applies the lower of the dollars and minutes here and the job's
 * own (desktop everywhere-runner.ts); jobs at once and a day count this computer's jobs.
 */
export const HOW_JOBS_RUN =
  "From this computer's settings file. A job stops at its own limit for dollars or minutes when that is lower."

/**
 * Whether the signed-in account's plan offers Vector everywhere: vectordev.ai lists the perk, and the plan includes the
 * listed Remote it needs (EV-08 `requires.everywhere`). The perk has no entitlement of its own, and an account with no
 * plan still sees it listed, so Remote's entitlement is the plan check.
 */
export function everywhereOffered(status: ModelPlanStatus.Status | undefined) {
  return EverywherePreferenceWire.offered(status)
}

/**
 * Whether Settings shows the tab: on the desktop only, when the plan offers it, or when the built-in engine's own block
 * already says on, so a computer that takes jobs always shows it. Another server's settings never count.
 */
export function everywhereTab(input: {
  desktop: boolean
  /** Settings is mounted under a server the page can read (not, for example, in a test page without one). */
  server: boolean
  builtin: boolean
  /** The plan offers Vector everywhere (`everywhereOffered`): the perk is listed and the plan includes Remote. */
  offered: boolean
  config: unknown
}) {
  if (!input.desktop || !input.server) return false
  if (input.offered) return true
  return input.builtin && everywhereView(input.config).written
}

/**
 * The page's view of GET /global/config's answer (`undefined` while it loads). Only the `everywhere` block and `locked`
 * are read. Each field is its saved value or its default while the block is off or locked; a block that does not
 * decode reads as the defaults.
 */
export function everywhereView(config: unknown, failed = false): EverywhereView {
  const answer = typeof config === "object" && config !== null ? (config as Record<string, unknown>) : undefined
  const block = answer?.everywhere
  const raw = typeof block === "object" && block !== null ? (block as Record<string, unknown>) : {}
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ConfigEverywhereV1.Info)(block ?? {}))
  // Only a loaded answer is read for locks: one without the list counts as locked, as the runner reads it.
  const locks: unknown[] | undefined = Array.isArray(answer?.locked) ? answer.locked : undefined
  const locked = answer !== undefined && (!locks || locks.includes("everywhere"))
  const written = raw.enabled === true
  const info = decoded ?? {}
  return {
    state: answer ? "ready" : failed ? "failed" : "loading",
    written,
    locked,
    invalid: !decoded,
    enabled: written && !locked && decoded !== undefined && answer !== undefined,
    rulesLocked: answer !== undefined && (!locks || RULE_KEYS.some((key) => locks.includes(key))),
    maxUsd: info.max_usd ?? ConfigEverywhereV1.Defaults.max_usd,
    minutes: info.minutes ?? ConfigEverywhereV1.Defaults.minutes,
    atOnce: info.at_once ?? ConfigEverywhereV1.Defaults.at_once,
    perDay: info.per_day ?? ConfigEverywhereV1.Defaults.per_day,
    model: info.model,
    waitForComputer: info.wait_for_computer ?? ConfigEverywhereV1.Defaults.wait_for_computer,
    push: info.push ?? ConfigEverywhereV1.Defaults.push,
    stayAwake: info.stay_awake ?? ConfigEverywhereV1.Defaults.stay_awake,
    projects: info.projects ?? [],
  }
}

/**
 * The settings a job here runs with, as the page shows them, read-only: undefined until they are read, and while a
 * company lock or a block that does not decode keeps jobs off (the jobs line says which). Each row is the setting as
 * saved, not a promise about a job: the push path is still EV-17's stand-ins, so today every branch stays on this
 * computer whatever `push` says (EV-21 (s)).
 */
export function howJobsRun(view: EverywhereView) {
  if (view.state !== "ready" || view.locked || view.invalid) return undefined
  const onOff = (value: boolean) => (value ? "On" : "Off")
  return [
    { label: "US dollars per job", value: view.maxUsd.toFixed(2) },
    { label: "Minutes per job", value: String(view.minutes) },
    { label: "Jobs at once", value: String(view.atOnce) },
    { label: "Jobs a day", value: String(view.perDay) },
    { label: "Model", value: view.model ?? "Your default model" },
    { label: "Wait for my computer", value: onOff(view.waitForComputer) },
    { label: "Push the branch and open a draft pull request", value: onOff(view.push), note: PUSH_RULE },
    { label: "Stay awake to take jobs while plugged in", value: onOff(view.stayAwake), note: CLOSED_LID },
  ]
}

/** What the page says about jobs on this computer, most pressing first. */
export function jobsLine(input: { view: EverywhereView; remote?: RemoteState; localOn?: boolean }) {
  const view = input.view
  if (view.state === "loading") return { text: "Reading this computer's settings…", problem: false }
  if (view.state === "failed") return { text: "Vector could not read this computer's settings.", problem: true }
  if (view.locked) return { text: "Your company manages this setting, so this computer takes no jobs.", problem: true }
  if (view.invalid)
    return {
      text: "These settings in your settings file are not valid, so this computer takes no jobs.",
      problem: true,
    }
  if (!view.enabled) return { text: "This computer takes no jobs.", problem: false }
  if (input.localOn) return { text: "Vector Local is on, so this computer takes no jobs.", problem: true }
  if (input.remote === "loading") return { text: "Reading Vector Remote on this computer…", problem: false }
  if (!input.remote?.enabled) return { text: "Jobs need Vector Remote, which is off on this computer.", problem: true }
  const remote = stateLine(input.remote)
  if (remote.problem) return remote
  if (remote.text === JOBS_ONLY_LINE) return remote
  if (input.remote.state === "online") return { text: "Jobs can reach this computer.", problem: false }
  return { text: "Jobs reach this computer once Vector Remote is connected.", problem: false }
}

/**
 * What the page says about a listed folder's trust. A job runs only in a trusted folder (the engine's create route
 * requires `trusted === true`, EV-13 (c)), and the trust question never comes up on its own for a folder without
 * settings of its own, so the page says it and offers the same approval as Settings, Repository trust.
 */
export function folderTrustLine(
  trust: FolderTrust,
  name: string,
): { text: string; problem: boolean; canTrust: boolean; detail?: string } {
  if (trust.kind === "closed")
    return { text: "Not open in Vector. Its jobs wait until you open it and trust it.", problem: true, canTrust: false }
  if (trust.kind === "reading") return { text: "Checking whether you trust it…", problem: false, canTrust: false }
  if (!trust.status)
    return { text: "Vector could not read whether you trust it. Its jobs wait.", problem: true, canTrust: false }
  if (trust.status.trusted) return { text: "Trusted.", problem: false, canTrust: false }
  // What trusting it means, in the words Settings → Repository trust uses for the same approval; said only where the
  // approval is offered.
  const summary = projectTrustSummary(trust.status, name || "This folder")
  return {
    text: "Not trusted, so its jobs wait until you trust it.",
    problem: true,
    canTrust: summary.canTrust,
    ...(summary.canTrust ? { detail: summary.description } : {}),
  }
}

/**
 * Whether a job here can run commands at all, said unless the engine's probe (GET /experimental/shell/unattended)
 * answered `offline-v1` and no company lock keeps them off. `shell` is that answer, undefined until it is read or when
 * it could not be read; the runner also reads anything but `offline-v1` as no commands.
 */
export function checksLine(input: {
  view: EverywhereView
  os?: "macos" | "windows" | "linux"
  shell?: "offline-v1" | "none"
}) {
  if (input.view.rulesLocked)
    return "Your company manages permission or agent settings, so jobs here can edit files but run no commands."
  if (input.os === "macos" || input.os === "windows")
    return "On this computer jobs can edit files but run no commands: their offline sandbox runs on Linux only."
  if (input.shell === "offline-v1") return undefined
  if (input.shell === "none")
    return "On this computer jobs can edit files but run no commands: their offline sandbox needs bubblewrap (the bwrap command), and it did not start here."
  return "Jobs here run commands only in their offline sandbox, which needs bubblewrap (the bwrap command). Where it does not start, they edit files but run no commands."
}

/**
 * The open project a listed folder is, spelled as the engine has it, or undefined. Paths compare as the app compares
 * project paths (`pathKey`: Windows separators as `/`, no trailing separator); case is kept, so `C:\Repo` and `c:\repo`
 * still differ and the folder reads as not open (EV-21 (y)).
 */
export function openWorktree(directory: string, opened: readonly string[]) {
  const key = pathKey(directory)
  return opened.find((worktree) => pathKey(worktree) === key)
}

/** This computer's jobs from the engine's sessions: newest first, at most 20. */
export function everywhereJobs(sessions: readonly GlobalSession[]): EverywhereJob[] {
  return sessions
    .flatMap((session) => {
      const mark = session.metadata?.[UNATTENDED_KEY]
      if (typeof mark !== "object" || mark === null) return []
      const fields = mark as Record<string, unknown>
      if (fields.by !== "everywhere" || !isJobId(fields.jid) || !isPlatform(fields.platform)) return []
      const platform = fields.platform
      return [
        {
          id: session.id,
          title: session.title,
          directory: session.directory,
          jid: fields.jid,
          platform,
          platformName: PLATFORM_NAMES[platform],
          updated: session.time.updated,
          continueTitle: `Continue: ${session.title}`.slice(0, 100),
        },
      ]
    })
    .toSorted((a, b) => b.updated - a.updated)
    .slice(0, 20)
}

/** The jobs page on vectordev.ai, linked only while the plan offers the perk (website rule). */
export function jobsPage(offered: boolean) {
  return offered ? `https://${EVERYWHERE_PAGE}` : undefined
}
