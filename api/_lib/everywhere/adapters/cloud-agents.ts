import { ENABLED_SOURCES, type RunSource } from "../../../../packages/schema/src/codium-run-trigger.js"
import {
  ACCOUNT_ID_PATTERN,
  ACTIONS_JOB_PROMPT,
  JOB_ID_PATTERN,
  PLATFORMS,
  type PlatformId,
} from "../../../../packages/schema/src/everywhere.js"
import type { RepoBinding, WorkflowMode } from "../../cloud-agents-binding.js"
import type { prepareCloudRun } from "../../cloud-agents-start.js"
import { persistentStore } from "../../persistent-store.js"
import type { GithubHandoffBinding } from "../github/adapter.js"
import type { Ports, PreparedDispatch } from "../ports.js"

/*
 * VE-30a (contract 3.4 step 6, 3.6, E8, E11): the Actions route's ports over @vector. A failed read or a refused step
 * answers no Actions route, and nothing here logs. @vector's modules load on first use, so a platform intake does not
 * load the App, its JWT library or the binding store at cold start. This module writes no `ticket:` link: dispatchJob
 * writes it under the job's guards just before its fenced transition (jobs.ts). A dispatch abandoned before dispatchJob
 * leaves none; one whose fenced transition loses leaves a link to a cancelled ticket until the body ends, which is
 * harmless: the start hook (startDispatched) takes a ticket only for a job that is `dispatched` with that hash.
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
   * EV-30's live read of `.github/workflows/vector.yml` at the default branch, with the App's single-repository token.
   * "codium" means the workflow is in Codium mode by workflowModeOf's rule (github-app.ts) and its pinned CLI reads the
   * job body (EV-28); anything else, or a failed read, is no Actions route. Without it there is no prepareCloud.
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
  const cloudSource = (platform: PlatformId) => platform !== "github" && sources.has(platform)
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
  // Absent until a platform is an enabled run source and EV-30 reads the mode live, so routing reads no binding.
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
