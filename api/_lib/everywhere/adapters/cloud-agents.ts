import { ENABLED_SOURCES, type RunSource } from "../../../../packages/schema/src/codium-run-trigger.js"
import {
  ACCOUNT_ID_PATTERN,
  ACTIONS_JOB_PROMPT,
  JOB_ID_PATTERN,
  PLATFORMS,
  type PlatformId,
} from "../../../../packages/schema/src/everywhere.js"
import type { SwitchState } from "../../../../packages/schema/src/everywhere-policy.js"
import type { RepoBinding, WorkflowMode } from "../../cloud-agents-binding.js"
import type { listCloudRuns, RunEnd, RunSettleListener, RunStartListener } from "../../cloud-agents-runs.js"
import type { prepareCloudRun } from "../../cloud-agents-start.js"
import { persistentStore } from "../../persistent-store.js"
import type { GithubHandoffBinding } from "../github/adapter.js"
import type { ActionsOutcome, ActionsRunEnd, JobRecord, JobsContext } from "../jobs.js"
import { everywhereKeys } from "../keys.js"
import type { Ports, PreparedDispatch } from "../ports.js"
import { getValue, type Store } from "../store.js"

/*
 * VE-30a (contract 3.4 step 6, 3.6, E8, E11): the Actions route's ports over @vector. A failed read or a refused step
 * answers no Actions route, and nothing here logs. @vector's modules load on first use, so a platform intake does not
 * load the App, its JWT library or the binding store at cold start. This module writes no `ticket:` link: dispatchJob
 * writes it under the job's guards just before its fenced transition (jobs.ts). A dispatch abandoned before dispatchJob
 * leaves none; one whose fenced transition loses leaves a link to a cancelled ticket until the body ends, which is
 * harmless: the start hook (startDispatched) takes a ticket only for a job that is `dispatched` with that hash.
 *
 * VE-30b (EV-30, R-A2, R-A3): the listeners on @vector's run hooks (`createRunHooks`, registered by run-hooks.ts) and
 * the cron's reader of how an overdue run ended (`createActionsRunEnd`). Neither ever holds a store that can write
 * @vector's records: the listeners hold Vector everywhere's store, and the reader only lists runs.
 */

export type CloudPortsDeps = {
  /** @vector's store, for the binding read and prepareCloudRun's ticket. Default: persistentStore. */
  readonly store?: typeof persistentStore
  /**
   * The live read with the App's single-repository token: github-app.ts attachmentRepository. GitHub's `private` is
   * also true for an internal repository, so only a `visibility` of "private" is private; until the helper answers
   * that field, a repository it does not call public reads "internal".
   */
  readonly app?: {
    readonly attachmentRepository: (
      binding: RepoBinding,
    ) => Promise<{ readonly publicRepository: boolean; readonly visibility?: string }>
  }
  /** Default: prepareCloudRun (R-A1). */
  readonly prepare?: typeof prepareCloudRun
  /**
   * The live read of `.github/workflows/vector.yml` at the default branch, with the App's single-repository token (no
   * work package builds it yet; EV-29 and EV-30, Left open). "codium" means the workflow is in Codium mode by
   * workflowModeOf's rule (github-app.ts) and its pinned CLI reads the job body (EV-28); anything else, or a failed
   * read, is no Actions route. Without it there is no prepareCloud.
   */
  readonly liveMode?: (binding: RepoBinding) => Promise<WorkflowMode | undefined>
  /** Default: ENABLED_SOURCES, which reserves slack, linear and jira until the owner says yes (R-C8/R-A8). */
  readonly sources?: ReadonlySet<RunSource>
}

export function createCloudPorts(
  deps: CloudPortsDeps = {},
): Pick<Ports, "cloudSource" | "binding" | "visibility" | "prepareCloud"> {
  const sources = deps.sources ?? ENABLED_SOURCES
  const liveMode = deps.liveMode
  // Jira has no Actions route whatever the sources say (EV-30): a Jira job must end before 50 minutes from intake
  // (4.4), and an Actions run takes @vector's plan limit, up to 120 minutes.
  const cloudSource = (platform: PlatformId) => platform !== "github" && platform !== "jira" && sources.has(platform)
  const ports = {
    cloudSource,
    binding: async (repositoryId: number) => {
      const binding = await currentBinding(repositoryId, deps.store)
      if (!binding) return undefined
      return {
        account: binding.account,
        appInstalled: binding.installationId !== undefined,
        codiumMode: binding.workflowMode === "codium",
      }
    },
    visibility: async (repositoryId: number) => {
      const binding = await currentBinding(repositoryId, deps.store)
      return binding && liveVisibility(binding, deps.app)
    },
  }
  // Absent until a platform is an enabled run source and the mode is read live, so routing reads no binding.
  if (!liveMode || !PLATFORMS.some(cloudSource)) return ports
  return {
    ...ports,
    prepareCloud: async (input) => {
      if (
        !cloudSource(input.source) ||
        input.bodyReference !== input.jid ||
        !JOB_ID_PATTERN.test(input.jid) ||
        !ACCOUNT_ID_PATTERN.test(input.sponsor)
      )
        return undefined
      const binding = await currentBinding(input.repositoryId, deps.store)
      if (!binding || binding.workflowMode !== "codium" || binding.account !== input.sponsor.toLowerCase())
        return undefined
      // Read before the ticket is issued: a public, internal or unread repository never takes a platform job (E11). A
      // binding with no installation has no read, so it never counts as private.
      if ((await liveVisibility(binding, deps.app)) !== "private") return undefined
      // The stored mode is a bind-time snapshot (EV-26); only the live read decides.
      if ((await liveMode(binding).catch(() => undefined)) !== "codium") return undefined
      const prepared = await (deps.prepare ?? defaultPrepare)(
        {
          source: input.source,
          account: binding.account,
          requestedBy: input.requestedBy,
          target: { kind: "github-run", repositoryId: input.repositoryId },
          prompt: `${ACTIONS_JOB_PROMPT}${input.jid}`,
          purpose: "task",
          jobId: input.jid,
        },
        { store: deps.store ?? persistentStore },
      ).catch(() => undefined)
      if (!prepared?.ok) return undefined
      return {
        ticketHash: prepared.ticketHash,
        // The router ignores a failed commit, and the 900 s start rule ends the job. Only the reason code is kept.
        commit: async () => {
          const sent = await prepared.dispatch()
          if (!sent.ok) throw new Error(sent.reason)
        },
        cancel: async () => {
          await prepared.cancel()
        },
      } satisfies PreparedDispatch
    },
  }
}

/**
 * The GitHub handoff's binding port. EV-31 passes it to createGithubHandoff; nothing wires it yet. `laptopFirst` stays
 * false until Q13/R-A6, so the handoff answers handled:false. `shared` is true until EV-31 reads visibility live: the
 * stored visibility is a bind-time snapshot, recorded as "private" when the bind token carried no visibility claim.
 */
export function createHandoffBinding(deps: Pick<CloudPortsDeps, "store"> = {}) {
  return async (repositoryId: number) => {
    const binding = await currentBinding(repositoryId, deps.store)
    if (!binding?.installationId) return undefined
    return {
      account: binding.account,
      githubId: Number(binding.binder.githubId),
      installationId: Number(binding.installationId),
      laptopFirst: false,
      codiumMode: binding.workflowMode === "codium",
      workflowVersion: binding.workflowVersion,
      repository: { id: Number(binding.repositoryId), fullName: binding.repository, shared: true },
    } satisfies GithubHandoffBinding
  }
}

/**
 * How @vector's run outcomes end an everywhere job (EV-30). `draft` is a run a gateway stop code ended early (a plan
 * limit, an expired run, capacity, a missing perk, plans turned off) that kept its work as a draft: none of the
 * everywhere outcomes names that set, so it reads `failed`.
 */
export const ACTIONS_OUTCOME: Readonly<Record<RunEnd["outcome"], ActionsOutcome>> = {
  changes: "changes",
  "no-changes": "no-changes",
  draft: "failed",
  failed: "failed",
  refused: "refused",
  cancelled: "cancelled",
}

/** What a listener needs once a run turns out to be an everywhere job's: loaded then, never at registration. */
export type RunJobDeps = {
  readonly context: () => JobsContext
  /** Posts a settled job's result once: the jobs routes' and the cron's `settled` hook (events.ts). */
  readonly settled: (job: JobRecord) => Promise<void>
  readonly switch: () => Promise<SwitchState>
}

/** `store` is Vector everywhere's, for the settle index; @vector's store never reaches a listener. */
export type RunHooksDeps = { readonly store: Store; readonly load: () => Promise<RunJobDeps> }

/**
 * The listeners on @vector's run hooks (R-A2, R-A3). Both finish inside their notify's 5 s budget or stop at its next
 * gate, and both are idempotent: the transitions are fenced, a start moves only a `dispatched` job with that ticket,
 * and a settle moves only that run's `running` job. Under the `stop` switch neither moves a job (E10); the sweep
 * cancels it instead.
 * - start: only a ticket that carries a job id is an everywhere dispatch's, so every other @vector run costs no read.
 *   `startDispatched` moves the job to `running` and links the run (`run:<rid>`, `run:<rid>:settle`).
 * - settle: the settle index names the job, so every other @vector settle costs one GET. A fresh settle is posted
 *   while the budget lasts; otherwise the transition's reply outbox and the cron's `postPending` post it once. The
 *   reported pull request is dropped (E6, E17): it comes from the model-driven agent phase, and no check confirms
 *   that its head branch is this run's yet.
 */
export function createRunHooks(deps: RunHooksDeps) {
  return {
    start: async (ticketHash, rid, jobId, signal) => {
      if (jobId === undefined || !JOB_ID_PATTERN.test(jobId) || signal.aborted) return
      const jobs = await deps.load()
      if ((await jobs.switch()) === "stop" || signal.aborted) return
      const { startDispatched } = await import("../jobs.js")
      await startDispatched(jobs.context(), ticketHash, rid, jobId)
    },
    settle: async (rid, end, signal) => {
      if (signal.aborted) return
      const jid = await getValue(deps.store, everywhereKeys.runSettle(rid))
      if (jid === undefined || signal.aborted) return
      const jobs = await deps.load()
      if ((await jobs.switch()) === "stop" || signal.aborted) return
      const { settleDispatched } = await import("../jobs.js")
      const settled = await settleDispatched(jobs.context(), jid, { rid, outcome: ACTIONS_OUTCOME[end.outcome] })
      if (settled.ok && settled.fresh && !signal.aborted) await jobs.settled(settled.job)
    },
  } satisfies { readonly start: RunStartListener; readonly settle: RunSettleListener }
}

/**
 * The cron's reader of how an overdue Actions run ended (3.6: "settled from `listCloudRuns`"): the sponsor's newest
 * 200 runs, which is all @vector keeps per account, and of those only the one with this rid. An ended run answers its
 * outcome; an open or unknown one answers undefined; a failed read, or one damaged record among the 200, rejects.
 * While the cloud-agents service is off its run state is not read (cloud-agents-run-registration.ts), so the answer is
 * undefined with no read, and the job fails at its due time.
 */
export function createActionsRunEnd(
  deps: {
    readonly list?: typeof listCloudRuns
    readonly enabled?: () => boolean | Promise<boolean>
    readonly store?: typeof persistentStore
  } = {},
): ActionsRunEnd {
  return async (account, rid) => {
    if (!(await (deps.enabled ?? cloudAgentsOn)())) return undefined
    const runs = await (deps.list ?? defaultList)(account, { limit: 200 }, deps.store ?? persistentStore)
    // @vector's record holds an outcome only once the run ended (cloud-agents-runs.ts decodes them together).
    const outcome = runs.find((entry) => entry.rid === rid)?.outcome
    return outcome && ACTIONS_OUTCOME[outcome]
  }
}

/**
 * The repository's active binding. A missing, suspended or unreadable one answers none, and so does an id that is not
 * a repository id: bindingFor refuses it before any store command. A module that fails to load is an unreadable one
 * too, so the `binding` port never rejects.
 */
async function currentBinding(repositoryId: number, store = persistentStore) {
  const binding = await readBinding(repositoryId, store).catch(() => undefined)
  return binding && !binding.suspended ? binding : undefined
}

async function readBinding(repositoryId: number, store: typeof persistentStore) {
  const { bindingFor } = await import("../../cloud-agents-binding.js")
  return bindingFor(String(repositoryId), store)
}

/**
 * The helper also refuses an archived or disabled repository, a moved default branch, a suspended or another owner's
 * installation and a binder without write access, and each of those reads as a failed read, which counts as public.
 */
async function liveVisibility(binding: RepoBinding, app: NonNullable<CloudPortsDeps["app"]> = defaultApp) {
  if (!binding.installationId) return undefined
  const read = await app.attachmentRepository(binding).catch(() => undefined)
  if (read?.publicRepository === true) return "public"
  if (read?.publicRepository !== false) return undefined
  return read.visibility === "private" ? "private" : "internal"
}

const defaultApp: NonNullable<CloudPortsDeps["app"]> = {
  attachmentRepository: async (binding) => {
    const { githubApp } = await import("../../github-app.js")
    return githubApp.attachmentRepository(binding)
  },
}

async function defaultPrepare(...input: Parameters<typeof prepareCloudRun>) {
  const { prepareCloudRun } = await import("../../cloud-agents-start.js")
  return prepareCloudRun(...input)
}

async function defaultList(...input: Parameters<typeof listCloudRuns>) {
  const { listCloudRuns } = await import("../../cloud-agents-runs.js")
  return listCloudRuns(...input)
}

async function cloudAgentsOn() {
  const { cloudAgentsEnabled } = await import("../../model-plan-config.js")
  return cloudAgentsEnabled()
}
