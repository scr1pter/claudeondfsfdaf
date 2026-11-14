import type {
  Config,
  VectorClient,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  QuestionRequest,
  ReferenceInfo,
  Session,
} from "@vectordevai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@vectordevai/core/util/path"
import { retry } from "@vectordevai/core/util/retry"
import { batch } from "solid-js"
import { produce, reconcile, unwrap, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import type { ServerSession } from "../server-session"
import { cmp, normalizeAgentList, normalizeProviderList } from "./utils"
import { formatServerError } from "@/utils/server-errors"
import { CancelledError, QueryClient, queryOptions, type FetchQueryOptions, type QueryKey } from "@tanstack/solid-query"
import { loadMcpQuery, loadMcpResourcesQuery } from "../server-sync"
import { NormalizedProviderListResponse } from "@vectordevai/session-ui/context"
import { ScopedKey, ServerScope } from "@/utils/server-scope"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

/**
 * fetchQuery for a reload. fetchQuery joins a fetch of the same query that is already in flight, and when something
 * newer refetches that query first, TanStack cancels the older fetch and the joined promise rejects with a silent
 * CancelledError although the newer fetch carries on. Saving a Settings switch twice in a row did exactly that (the
 * second save invalidates the providers the first save's reload is still loading) and showed "Failed to reload
 * <repository>: CancelledError". This follows the newer fetch instead. With `restart`, for a reload after the engine
 * changed, a fetch already in flight may have started before the change and carry the old state, so it is cancelled
 * and the query fetched again, the way TanStack's own cancelRefetch does.
 */
export function fetchLatest<TQueryFnData, TQueryKey extends QueryKey>(
  queryClient: QueryClient,
  options: FetchQueryOptions<TQueryFnData, Error, TQueryFnData, TQueryKey>,
  restart = false,
): Promise<TQueryFnData> {
  if (restart)
    void queryClient.cancelQueries({ queryKey: options.queryKey, exact: true }, { silent: true, revert: false })
  return queryClient.fetchQuery(options).catch((error: unknown) => {
    if (error instanceof CancelledError && error.silent) return fetchLatest(queryClient, options)
    throw error
  })
}

const providerRev = new Map<string, number>()

export function clearProviderRev(scope: ServerScope, directory: string) {
  providerRev.delete(ScopedKey.from(scope, directory))
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export const loadGlobalConfigQuery = (scope: ServerScope, sdk: VectorClient) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: () => retry(() => sdk.global.config.get().then((x) => x.data!)),
  })

export const loadProjectsQuery = (scope: ServerScope, sdk: VectorClient) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: async () => {
      const projects = await retry(() =>
        sdk.project.list().then((x) =>
          (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("vector-test"))
            .slice()
            .sort((a, b) => cmp(a.id, b.id)),
        ),
      )
      const desktopApi =
        typeof window === "undefined"
          ? undefined
          : (window as unknown as { api?: { pathExists?: (path: string) => Promise<boolean> } }).api
      if (scope !== ServerScope.local || !desktopApi?.pathExists) return projects
      const pathExists = desktopApi.pathExists
      const existing = await Promise.all(
        projects.map(async (project) =>
          (await pathExists(project.worktree).catch(() => false)) ? project : undefined,
        ),
      )
      return existing.filter((project): project is Project => !!project)
    },
  })

export async function bootstrapGlobal(input: {
  serverSDK: VectorClient
  scope: ServerScope
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const slow = [
    () => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.serverSDK)),
    () => input.queryClient.fetchQuery(loadProvidersQuery(input.scope, null, input.serverSDK)),
    () => input.queryClient.fetchQuery(loadPathQuery(input.scope, null, input.serverSDK)),
    () =>
      input.queryClient
        .fetchQuery(loadProjectsQuery(input.scope, input.serverSDK))
        .then((data) => input.setGlobalStore("project", data)),
  ]
  await runAll(slow)
  // showErrors({
  //   errors: errors(),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  sdk: VectorClient
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.sdk.session.get({ sessionID })).then((x) => {
        const session = x.data
        if (!session?.id) return
        mergeSession(input.setStore, session)
      }),
    ),
  ).then(() => undefined)
}

export const loadProvidersQuery = (scope: ServerScope, directory: string | null, sdk: VectorClient) =>
  queryOptions({
    queryKey: [scope, directory, "providers"],
    queryFn: () => retry(() => sdk.provider.list().then((x) => normalizeProviderList(x.data!))),
  })

export const loadAgentsQuery = (scope: ServerScope, directory: string | null, sdk: VectorClient) =>
  queryOptions({
    queryKey: [scope, directory, "agents"],
    queryFn: () => retry(() => sdk.app.agents().then((x) => normalizeAgentList(x.data))),
  })

export const loadPathQuery = (scope: ServerScope, directory: string | null, sdk: VectorClient) =>
  queryOptions<Path>({
    queryKey: [scope, directory, "path"],
    queryFn: () => retry(() => sdk.path.get().then((x) => x.data!)),
  })

export const loadReferencesQuery = (scope: ServerScope, directory: string, sdk: VectorClient) =>
  queryOptions<ReferenceInfo[]>({
    queryKey: [scope, directory, "references"] as const,
    queryFn: () => retry(() => sdk.v2.reference.list().then((x) => x.data?.data ?? [])).catch(() => []),
    placeholderData: [],
  })

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  mcp: boolean
  sdk: VectorClient
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: NormalizedProviderListResponse
  }
  queryClient: QueryClient
  session?: ServerSession
}) {
  const loading = input.store.status !== "complete"
  // A directory that has loaded before is reloading because the engine changed, for example the dispose after a
  // config save, so its queries must not take the result of a fetch that started before that.
  const restart = !loading
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    // Directory reconciliation mutates nested store objects. Its initial seed
    // must not share them with the owner-global policy query.
    input.setStore("config", reconcile(structuredClone(unwrap(input.global.config)), { merge: false }))
  }
  if (loading) input.setStore("status", "partial")

  const revKey = ScopedKey.from(input.scope, input.directory)
  const rev = (providerRev.get(revKey) ?? 0) + 1
  providerRev.set(revKey, rev)
  ;(async () => {
    const slow = [
      () => Promise.resolve(input.loadSessions(input.directory)),
      // A fetch, not ensureQueryData: a re-bootstrap follows an engine
      // dispose, for example after Settings → Agents turns a subagent off,
      // and cached agents would keep the removed agent in the @ list.
      () =>
        fetchLatest(input.queryClient, loadAgentsQuery(input.scope, input.directory, input.sdk), restart).then((data) =>
          input.setStore("agent", data),
        ),
      () =>
        retry(() => input.sdk.config.get().then((x) => input.setStore("config", reconcile(x.data!, { merge: false })))),
      () =>
        retry(() =>
          input.sdk.session.status().then(async (x) => {
            if (!input.session) {
              input.setStore("session_status", x.data!)
              return
            }
            const statuses = x.data ?? {}
            input.session.set(
              "session_status",
              produce((draft) => {
                for (const sessionID of Object.keys(draft)) {
                  if (statuses[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory === input.directory) delete draft[sessionID]
                }
              }),
            )
            for (const [sessionID, status] of Object.entries(statuses)) {
              input.session.set("session_status", sessionID, reconcile(status))
            }
            // Warm session info only after seeding statuses so a stalled session
            // fetch cannot park busy indicators behind it, mirroring how live
            // session.status events apply first and resolve info in the background.
            await Promise.all(
              Object.keys(statuses).map((sessionID) => input.session!.resolve(sessionID).catch(() => undefined)),
            )
          }),
        ),
      !seededProject &&
        (() => retry(() => input.sdk.project.current()).then((x) => input.setStore("project", x.data!.id))),
      !seededPath &&
        (() =>
          input.queryClient.ensureQueryData(loadPathQuery(input.scope, input.directory, input.sdk)).then((data) => {
            const next = projectID(data.directory ?? input.directory, input.global.project)
            if (next) input.setStore("project", next)
          })),
      () =>
        retry(() =>
          input.sdk.vcs.get().then((x) => {
            const next = x.data ?? input.store.vcs
            input.setStore("vcs", next)
            if (next) input.vcsCache.setStore("value", next)
          }),
        ),
      input.mcp && (() => retry(() => input.sdk.command.list().then((x) => input.setStore("command", x.data ?? [])))),
      () => fetchLatest(input.queryClient, loadReferencesQuery(input.scope, input.directory, input.sdk), restart),
      () =>
        retry(() =>
          input.sdk.permission.list().then((x) => {
            const ids = (x.data ?? []).map((perm) => perm?.sessionID).filter((id): id is string => !!id)
            const grouped = groupBySession(
              (x.data ?? []).filter((perm): perm is PermissionRequest => !!perm?.id && !!perm.sessionID),
            )
            const warm = input.session
              ? Promise.all(ids.map((sessionID) => input.session!.resolve(sessionID))).then(() => undefined)
              : warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.permission ?? input.store.permission
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("permission", sessionID, [])
                  if (!input.session) input.setStore("permission", sessionID, [])
                }
                for (const [sessionID, permissions] of Object.entries(grouped)) {
                  const value = reconcile(
                    permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("permission", sessionID, value)
                  if (!input.session) input.setStore("permission", sessionID, value)
                }
              }),
            )
          }),
        ),
      () =>
        retry(() =>
          input.sdk.question.list().then((x) => {
            const ids = (x.data ?? []).map((question) => question?.sessionID).filter((id): id is string => !!id)
            const grouped = groupBySession((x.data ?? []).filter((q): q is QuestionRequest => !!q?.id && !!q.sessionID))
            const warm = input.session
              ? Promise.all(ids.map((sessionID) => input.session!.resolve(sessionID))).then(() => undefined)
              : warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.question ?? input.store.question
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("question", sessionID, [])
                  if (!input.session) input.setStore("question", sessionID, [])
                }
                for (const [sessionID, questions] of Object.entries(grouped)) {
                  const value = reconcile(
                    questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("question", sessionID, value)
                  if (!input.session) input.setStore("question", sessionID, value)
                }
              }),
            )
          }),
        ),
      () => Promise.resolve(input.loadSessions(input.directory)),
      input.mcp &&
        (() => fetchLatest(input.queryClient, loadMcpQuery(input.scope, input.directory, input.sdk), restart)),
      input.mcp &&
        (() => fetchLatest(input.queryClient, loadMcpResourcesQuery(input.scope, input.directory, input.sdk), restart)),
      () =>
        fetchLatest(input.queryClient, loadProvidersQuery(input.scope, input.directory, input.sdk), restart).catch(
          (err) => {
            if (err instanceof CancelledError) throw err
            const project = getFilename(input.directory)
            showToast({
              variant: "error",
              title: input.translate("toast.project.reloadFailed.title", { project }),
              description: formatServerError(err, input.translate),
            })
          },
        ),
    ].filter(Boolean) as (() => Promise<any>)[]

    await waitForPaint()
    const rejected = errors(await runAll(slow))
    // fetchLatest follows a fetch a newer one superseded, so a cancellation that still arrives here came from something
    // that cancelled the query on purpose. That is no failure to show, but what it cancelled never loaded, so the
    // directory stays partial (below) and its next reload loads it again.
    const slowErrs = rejected.filter((reason) => !(reason instanceof CancelledError))
    if (slowErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", slowErrs[0])
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(slowErrs[0], input.translate),
      })
    }

    if (loading && rejected.length === 0) input.setStore("status", "complete")
  })()
}
