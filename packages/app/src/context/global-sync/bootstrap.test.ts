import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { CancelledError, QueryClient, QueryObserver } from "@tanstack/solid-query"
import type { Config, VectorClient, Project, Session } from "@vectordevai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@vectordevai/session-ui/context"
import { bootstrapDirectory, fetchLatest, loadAgentsQuery, loadPathQuery, loadProvidersQuery } from "./bootstrap"
import type { State, VcsCache } from "./types"
import { createServerSession } from "../server-session"
import { ServerScope } from "@/utils/server-scope"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider_loaded: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_spend: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("directory overlays cannot mutate the owner-global policy or share its nested config objects", async () => {
    const [globalConfig] = createStore<Config>({
      experimental: { vectorscope: false, disable_paste_summary: false },
      agent: { vectorscope: { model: "global/reviewer", disable: true } },
    })
    const client = heldClient({
      experimental: { vectorscope: true, disable_paste_summary: true },
      agent: { vectorscope: { model: "repository/reviewer", disable: false } },
    })
    const [store, setStore] = directoryState()
    const queryClient = new QueryClient()
    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: globalConfig,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: client.sdk,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient,
    })
    // This identity check also catches the alias in Solid's non-proxy server
    // store; the real browser test then exercises nested reconciliation.
    expect(store.config.experimental).not.toBe(globalConfig.experimental)
    expect(store.config.agent?.vectorscope).not.toBe(globalConfig.agent?.vectorscope)
    await client.started
    client.agents[0]!.resolve({ data: [{ name: "build", mode: "primary" }] })
    client.providers[0]!.resolve(PROVIDERS)
    await until(() => store.status === "complete")
    expect(store.status).toBe("complete")
    expect(store.config.experimental?.vectorscope).toBe(true)
    expect(store.config.experimental?.disable_paste_summary).toBe(true)
    expect(store.config.agent?.vectorscope).toEqual({ model: "repository/reviewer", disable: false })
    expect(globalConfig.experimental?.vectorscope).toBe(false)
    expect(globalConfig.experimental?.disable_paste_summary).toBe(false)
    expect(globalConfig.agent?.vectorscope).toEqual({ model: "global/reviewer", disable: true })
    queryClient.clear()
  })

  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const mcpReads: string[] = []
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        v2: { reference: { list: async () => ({ data: { data: [] } }) } },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as VectorClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(mcpReads).toEqual([])
  })

  test("seeds session status even while warming session info stalls", async () => {
    const [store, setStore] = directoryState()
    const stalled = Promise.withResolvers<never>()
    const client = {
      app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
      config: { get: async () => ({ data: {} }) },
      session: {
        status: async () => ({ data: { ses_busy: { type: "busy" } } }),
        get: () => stalled.promise,
      },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      v2: { reference: { list: async () => ({ data: { data: [] } }) } },
      mcp: { status: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as unknown as VectorClient
    const session = createServerSession(client)
    const stale: Session = {
      id: "ses_stale",
      slug: "ses_stale",
      projectID: "project",
      directory: "/project",
      title: "stale",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    session.remember(stale)
    session.set("session_status", stale.id, { type: "busy" })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: client,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      session,
    })

    const deadline = Date.now() + 500
    while (!session.data.session_working("ses_busy") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(session.data.session_status["ses_busy"]?.type).toBe("busy")
    expect(session.data.session_status[stale.id]).toBeUndefined()
  })
})

// A directory client whose agent and provider lists the test answers by hand, one call at a time. `started` resolves
// once the reload has started every fetch, after its wait for a paint.
function heldClient(config: Config = {}) {
  const agents: PromiseWithResolvers<unknown>[] = []
  const providers: PromiseWithResolvers<unknown>[] = []
  const started = Promise.withResolvers<void>()
  const held = (list: PromiseWithResolvers<unknown>[]) => () => {
    const next = Promise.withResolvers<unknown>()
    list.push(next)
    return next.promise
  }
  const sdk = {
    app: { agents: held(agents) },
    config: { get: async () => ({ data: config }) },
    session: { status: async () => ({ data: {} }) },
    vcs: { get: async () => ({ data: undefined }) },
    command: { list: async () => ({ data: [] }) },
    permission: {
      list: async () => {
        started.resolve()
        return { data: [] }
      },
    },
    question: { list: async () => ({ data: [] }) },
    v2: { reference: { list: async () => ({ data: { data: [] } }) } },
    mcp: { status: async () => ({ data: {} }) },
    provider: { list: held(providers) },
  } as unknown as VectorClient
  return { sdk, agents, providers, started: started.promise }
}

function reload(input: { sdk: VectorClient; store: ReturnType<typeof directoryState>; queryClient: QueryClient }) {
  const translated: string[] = []
  void bootstrapDirectory({
    directory: "/project",
    scope: ServerScope.local,
    mcp: false,
    global: {
      config: {} satisfies Config,
      path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
      project: [{ id: "project", worktree: "/project" } as Project],
      provider,
    },
    sdk: input.sdk,
    store: input.store[0],
    setStore: input.store[1],
    vcsCache: { setStore() {} } as unknown as VcsCache,
    loadSessions() {},
    // The reload translates the "Failed to reload" title only to show that toast.
    translate: (key) => {
      translated.push(key)
      return key
    },
    queryClient: input.queryClient,
  })
  return translated
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
}

const PROVIDERS = { data: { all: [], connected: [], default: {} } }

describe("bootstrapDirectory reloads", () => {
  // Saving a Settings switch twice in a row: the second save invalidates the providers while the first save's reload
  // is still waiting on them, which used to show "Failed to reload <repository>: CancelledError".
  test("shows no toast when a newer reload supersedes its providers fetch", async () => {
    const queryClient = new QueryClient()
    const client = heldClient()
    const store = directoryState()
    const options = loadProvidersQuery(ServerScope.local, "/project", client.sdk)
    queryClient.setQueryData(options.queryKey, provider)
    // The directory's own providers query, as the child store mounts it, is fetching when the reload starts.
    const unsubscribe = new QueryObserver(queryClient, options).subscribe(() => {})

    const translated = reload({ sdk: client.sdk, store, queryClient })
    await client.started
    void queryClient.invalidateQueries({ queryKey: options.queryKey })
    // A directory loading for the first time joins the fetch in flight rather than starting another.
    expect(client.providers).toHaveLength(2)
    for (const list of client.providers) list.resolve(PROVIDERS)
    for (const list of client.agents) list.resolve({ data: [{ name: "build", mode: "primary" }] })
    await until(() => store[0].status === "complete")

    expect(store[0].status).toBe("complete")
    expect(translated).not.toContain("toast.project.reloadFailed.title")
    unsubscribe()
  })

  test("still shows a toast when the providers fetch really fails", async () => {
    const queryClient = new QueryClient()
    const client = heldClient()
    const store = directoryState()

    const translated = reload({ sdk: client.sdk, store, queryClient })
    await client.started
    client.agents[0].resolve({ data: [{ name: "build", mode: "primary" }] })
    client.providers[0].reject(new Error("provider list failed"))
    await until(() => translated.includes("toast.project.reloadFailed.title"))

    expect(translated).toContain("toast.project.reloadFailed.title")
  })

  // Only a fetch a newer one superseded is followed. One something cancelled on purpose never loaded, so the directory
  // must not count as loaded, or its agents would never load until a reload after the next engine change.
  test("keeps a first load partial, with no toast, when something cancels its agents fetch", async () => {
    const queryClient = new QueryClient()
    const client = heldClient()
    const store = directoryState()

    const translated = reload({ sdk: client.sdk, store, queryClient })
    await client.started
    await queryClient.cancelQueries({ queryKey: loadAgentsQuery(ServerScope.local, "/project", client.sdk).queryKey })
    for (const list of client.providers) list.resolve(PROVIDERS)
    await until(
      () =>
        queryClient.getQueryState(loadProvidersQuery(ServerScope.local, "/project", client.sdk).queryKey)?.status ===
        "success",
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(store[0].status).toBe("partial")
    expect(translated).not.toContain("toast.project.reloadFailed.title")
  })

  // A directory that has loaded before reloads because the engine changed, for example after Settings turned the
  // review specialist off. An agents fetch that started before that would put review back in the @ list.
  test("refetches what was in flight when a loaded directory reloads", async () => {
    const queryClient = new QueryClient()
    const client = heldClient()
    const store = directoryState()
    store[1]("status", "complete")
    const options = loadAgentsQuery(ServerScope.local, "/project", client.sdk)
    queryClient.setQueryData(options.queryKey, [])
    const unsubscribe = new QueryObserver(queryClient, options).subscribe(() => {})
    expect(client.agents).toHaveLength(1)

    const translated = reload({ sdk: client.sdk, store, queryClient })
    await client.started
    expect(client.agents).toHaveLength(2)
    client.agents[0].resolve({
      data: [
        { name: "build", mode: "primary" },
        { name: "review", mode: "subagent" },
      ],
    })
    client.agents[1].resolve({ data: [{ name: "build", mode: "primary" }] })
    for (const list of client.providers) list.resolve(PROVIDERS)
    await until(() => store[0].agent.length > 0)

    expect(store[0].agent.map((agent) => agent.name)).toEqual(["build"])
    expect(queryClient.getQueryData(options.queryKey)?.map((agent) => agent.name)).toEqual(["build"])
    expect(translated).not.toContain("toast.project.reloadFailed.title")
    unsubscribe()
  })
})

describe("fetchLatest", () => {
  // server-sync's loadReferences joins a references fetch, and a reload after the engine changed cancels that fetch to
  // start a new one. The joined call follows the new fetch instead of rejecting with nothing to catch it.
  test("a call that joined a fetch a restart cancels gets the newer result", async () => {
    const queryClient = new QueryClient()
    const answers: PromiseWithResolvers<string>[] = []
    const options = {
      queryKey: ["references"],
      queryFn: () => {
        const next = Promise.withResolvers<string>()
        answers.push(next)
        return next.promise
      },
    }
    const started = queryClient.fetchQuery(options)
    const plain = queryClient.fetchQuery(options).catch((error: unknown) => error)
    const joined = fetchLatest(queryClient, options)
    const restarted = fetchLatest(queryClient, options, true)
    await until(() => answers.length === 2)
    answers[0].resolve("old")
    answers[1].resolve("new")

    expect(await restarted).toBe("new")
    expect(await joined).toBe("new")
    expect(await started).toBe("new")
    // What server-sync's plain fetchQuery got before.
    expect(await plain).toBeInstanceOf(CancelledError)
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as VectorClient
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, client).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
  })
})
