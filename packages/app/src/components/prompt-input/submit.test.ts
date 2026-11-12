import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit
let resolveExecutionAgent: typeof import("./submit").resolveExecutionAgent
let resolveSubmissionAgent: typeof import("./submit").resolveSubmissionAgent
let queueEnabled: typeof import("./submit").queueEnabled

const createdClients: string[] = []
const createdSessions: string[] = []
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: string[] = []
const sentShellAgents: string[] = []
const sentPrompts: Array<{
  directory: string
  input: {
    executionMode?: "normal" | "fast"
    agent?: string
    size?: string
    parts?: Array<{ type: string; text?: string; metadata?: Record<string, unknown> }>
  }
}> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
// Every session_status write, from the directory store and the server store alike.
const statusSets: Array<{ sessionID: string; type: string }> = []
// Every stop request the root client received, in order.
const stops: Array<{ route: string; input: Record<string, unknown> }> = []
let promptError: Error | undefined
let commands: Array<{ name: string }> = []

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let workspaceError: Error | undefined
let promptResetCount = 0
let currentModel: { id: string; provider: { id: string } } | undefined
let availableModels: Array<{ id: string; provider: { id: string } }> = []
let providerReady = true
let engineAgents = [{ name: "build" }, { name: "research" }]
let providerLoaded = true
// The desktop app's Vector account bridge; the web build has none.
let vectorAccount: object | undefined = {}
const toasts: Array<{ title?: string; description?: string; actions?: Array<{ label: string; onClick: unknown }> }> = []

const typed = (text: string): Prompt => [{ type: "text", content: text, start: 0, end: text.length }]
let promptValue: Prompt = typed("ls")
const prompt = {
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  reset: () => {
    promptResetCount++
  },
  set: () => undefined,
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => prompt,
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    local: { get: async () => ({ data: undefined }) },
    file: {
      list: async () => {
        if (workspaceError) throw workspaceError
        return { data: [] }
      },
    },
    session: {
      create: async (input?: { title?: string }) => {
        createdSessions.push(directory)
        return {
          data: {
            id: `session-${createdSessions.length}`,
            title: input?.title ?? `New session ${createdSessions.length}`,
          },
        }
      },
      shell: async (input: { agent: string }) => {
        sentShellAgents.push(input.agent)
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async (input: (typeof sentPrompts)[number]["input"]) => {
        if (promptError) throw promptError
        sentPrompts.push({ directory, input })
        return { data: undefined }
      },
      command: async () => ({ data: undefined }),
      abort: async (input: { sessionID: string }) => {
        stops.push({ route: "session.abort", input })
        return { data: true }
      },
    },
    experimental: {
      session: {
        stop: async (input: Record<string, unknown>) => {
          stops.push({ route: "experimental.session.stop", input })
          return { data: { aborted: true, tasks: [], shells: 0, excluded: 0, skipped: 0 } }
        },
      },
      task: {
        stop: async (input: Record<string, unknown>) => {
          stops.push({ route: "experimental.task.stop", input })
          return { data: { tasks: [] } }
        },
      },
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@vectordevai/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: (options: (typeof toasts)[number]) => {
      toasts.push(options)
      return 0
    },
  }))

  mock.module("@vectordevai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
    checksum: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => currentModel,
        list: () => availableModels,
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
        list: () => [{ name: "agent", mode: "primary" }],
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  mock.module("@/context/plan-mode", () => ({
    usePlanMode: () => ({ enabled: () => false }),
  }))

  mock.module("@/context/server", () => ({
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      draft: () => ({ server: "project-server" }),
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: {
        get agent() {
          return engineAgents
        },
        get command() {
          return commands
        },
        config: {},
        get provider_ready() {
          return providerReady
        },
        get provider_loaded() {
          return providerLoaded
        },
      },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: (key: string, sessionID: string, value: { type: string }) => {
        if (key === "session_status") statusSets.push({ sessionID, type: value.type })
      },
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        remember: () => undefined,
        set: (key: string, sessionID: string, value: { type: string }) => {
          if (key === "session_status") statusSets.push({ sessionID, type: value.type })
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
      vectorAccount,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
  resolveExecutionAgent = mod.resolveExecutionAgent
  resolveSubmissionAgent = mod.resolveSubmissionAgent
  queueEnabled = mod.queueEnabled
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  params = {}
  search = {}
  sentShell.length = 0
  sentShellAgents.length = 0
  sentPrompts.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  workspaceError = undefined
  promptResetCount = 0
  currentModel = { id: "model", provider: { id: "provider" } }
  availableModels = [currentModel]
  providerReady = true
  engineAgents = [{ name: "build" }, { name: "research" }]
  providerLoaded = true
  vectorAccount = {}
  toasts.length = 0
  statusSets.length = 0
  stops.length = 0
  promptError = undefined
  commands = []
  promptValue = typed("ls")
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
  })

  test("sends fast execution mode to the engine", async () => {
    params = { id: "session-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      executionMode: () => "fast",
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentPrompts).toEqual([
      { directory: "/repo/main", input: expect.objectContaining({ executionMode: "fast" }) },
    ])
  })

  test("routes explicit quick mode through the lightweight agent", async () => {
    params = { id: "session-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      executionMode: () => "quick",
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The person picked the quick lane, so the engine answers there and never escalates it to Work.
    expect(sentPrompts.at(-1)).toEqual({
      directory: "/repo/main",
      input: expect.objectContaining({ agent: "quick", executionMode: "normal", size: "chat" }),
    })
  })

  const researchSubmit = (
    depth: "auto" | "focused" | "deep",
    scope?: "web" | "web+brain" | "brain",
    mode: "normal" | "shell" = "normal",
  ) =>
    createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => mode,
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      executionMode: () => "research",
      researchDepth: () => depth,
      ...(scope ? { researchScope: () => scope } : {}),
      onSubmit: () => undefined,
    })

  test("sends Deep research to the research agent, sized by the Depth chip, with the Sources chip's scope", async () => {
    params = { id: "session-1" }
    for (const [depth, size] of [
      ["focused", "standard"],
      ["deep", "thorough"],
    ] as const) {
      await researchSubmit(depth, "brain").handleSubmit({ preventDefault: () => undefined } as unknown as Event)
      await new Promise((resolve) => setTimeout(resolve, 0))
      // Research is an agent on the message, not an execution mode of its own.
      expect(sentPrompts.at(-1)?.input).toMatchObject({ agent: "research", executionMode: "normal", size })
      expect(sentPrompts.at(-1)?.input.parts?.[0]).toMatchObject({
        type: "text",
        text: "ls",
        metadata: { "vector.research": { scope: "brain" } },
      })
      // The echo is the same part, so it carries the scope too.
      expect(optimistic.at(-1)?.message.agent).toBe("research")
    }
  })

  test("refuses a remembered research mode on an older engine without clearing or admitting the draft", async () => {
    params = { id: "session-1" }
    engineAgents = [{ name: "build" }]
    await researchSubmit("auto").handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    expect(sentPrompts).toEqual([])
    expect(createdSessions).toEqual([])
    expect(optimistic).toEqual([])
    expect(promptResetCount).toBe(0)
    expect(toasts.at(-1)?.description).toContain("not available on this engine")
  })

  test("desktop Local refuses an older destination engine before admitting or clearing the request", async () => {
    window.api = { vectorLocal: { status: async () => ({ enabled: true, held: false, sources: {} }) } }
    try {
      await researchSubmit("auto").handleSubmit({ preventDefault: () => undefined } as unknown as Event)
      expect(createdSessions).toEqual([])
      expect(sentPrompts).toEqual([])
      expect(optimistic).toEqual([])
      expect(promptResetCount).toBe(0)
      expect(toasts.at(-1)?.description).toContain("could not confirm protection")
    } finally {
      delete window.api
    }
  })

  test("a shell command does not inherit an unavailable research agent from the hidden mode chip", async () => {
    engineAgents = [{ name: "build" }]
    await researchSubmit("auto", undefined, "shell").handleSubmit({
      preventDefault: () => undefined,
    } as unknown as Event)
    expect(sentShell).toHaveLength(1)
    expect(sentShellAgents).toEqual(["agent"])
    expect(sentPrompts).toEqual([])
  })

  test("leaves the size to Vector at Auto, and sends no scope when the chip has none", async () => {
    params = { id: "session-1" }
    await researchSubmit("auto").handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sentPrompts.at(-1)?.input).toMatchObject({ agent: "research", executionMode: "normal" })
    expect(sentPrompts.at(-1)?.input.size).toBeUndefined()
    expect(sentPrompts.at(-1)?.input.parts?.[0]?.metadata).toBeUndefined()
  })

  for (const item of [
    {
      name: "a typed request",
      prompt: [{ type: "text", content: "ls", start: 0, end: 2 }],
      title: "ls",
    },
    {
      name: "the request after file and agent mentions",
      prompt: [
        { type: "agent", name: "planner", content: "@planner", start: 0, end: 8 },
        { type: "file", path: "/private/project/login.ts", content: "@/private/project/login.ts", start: 8, end: 34 },
        { type: "text", content: "\nFix the login redirect\nPrivate followup context", start: 34, end: 86 },
      ],
      title: "Fix the login redirect",
    },
    {
      name: "a file basename when there is no typed request",
      prompt: [
        { type: "file", path: "/private/project/login.ts", content: "@/private/project/login.ts", start: 0, end: 26 },
      ],
      title: "login.ts",
    },
    {
      name: "the engine's greeting title so its first work can retitle it",
      prompt: [{ type: "text", content: "👋".repeat(30), start: 0, end: 60 }],
      title: "New session 1",
    },
  ] satisfies Array<{ name: string; prompt: Prompt; title: string }>) {
    test(`seeds ${item.name} before adding an optimistic prompt`, async () => {
      const original = promptValue.splice(0, promptValue.length, ...item.prompt)
      try {
        const submit = createPromptSubmit({
          prompt,
          info: () => undefined,
          imageAttachments: () => [],
          commentCount: () => 0,
          autoAccept: () => false,
          mode: () => "normal",
          working: () => false,
          editor: () => undefined,
          queueScroll: () => undefined,
          promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
          addToHistory: () => undefined,
          resetHistoryNavigation: () => undefined,
          setMode: () => undefined,
          setPopover: () => undefined,
          newSessionWorktree: () => selected,
          onNewSessionWorktreeReset: () => undefined,
          onSubmit: () => undefined,
        })

        await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

        expect(storedSessions["/repo/worktree-a"]).toEqual([{ id: "session-1", title: item.title }])
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(optimisticSeeded).toEqual([true])
      } finally {
        promptValue.splice(0, promptValue.length, ...original)
      }
    })
  }
})

describe("follow-up optimistic echo", () => {
  type SendInput = Parameters<typeof import("./submit").sendFollowupDraft>[0]
  type SentPart = { id: string; type: string; synthetic?: boolean; text?: string }
  type Step = {
    kind: "echo" | "request"
    parts: SentPart[]
    budget?: unknown
    judge?: unknown
    agent?: string
    size?: unknown
  }

  // Real work, so the desktop's file map applies; a greeting gets none.
  const text = "add a caption under this picture that names its colors and what the square could represent"
  const pasted = {
    type: "image" as const,
    id: "pasted-image",
    filename: "image.png",
    mime: "image/png",
    dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  }

  const withDesktopContext = async <T>(run: () => Promise<T>) => {
    Object.assign(window, {
      api: { prepareAgentTask: async () => ({ instruction: "Context note from the desktop bridge." }) },
    })
    try {
      return await run()
    } finally {
      delete (window as { api?: unknown }).api
    }
  }

  const send = async (
    draft: Partial<import("./submit").FollowupDraft> = {},
    history: object[] = [],
    config: object = {},
    parts: Record<string, SentPart[]> = {},
  ) => {
    const { sendFollowupDraft } = await import("./submit")
    // One ordered log, so a test also sees when the echo happens relative to the request.
    const steps: Step[] = []
    await sendFollowupDraft({
      client: {
        session: {
          promptAsync: async (input: {
            parts: SentPart[]
            budget?: unknown
            judge?: unknown
            agent?: string
            size?: unknown
          }) => {
            steps.push({
              kind: "request",
              parts: input.parts,
              budget: input.budget,
              judge: input.judge,
              agent: input.agent,
              size: input.size,
            })
            return { data: undefined }
          },
        },
      } as unknown as SendInput["client"],
      serverSync: { session: { set: () => undefined } } as unknown as SendInput["serverSync"],
      sync: {
        data: { command: [], agent: engineAgents, message: { "session-1": history }, part: parts, config },
        session: {
          optimistic: {
            add: (value: { parts: SentPart[] }) => void steps.push({ kind: "echo", parts: value.parts }),
            remove: () => undefined,
          },
        },
      } as unknown as SendInput["sync"],
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: text, start: 0, end: text.length }, pasted],
        context: [],
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        ...draft,
      },
    })
    return steps
  }

  test("refuses queued research after switching to an engine without research", async () => {
    engineAgents = [{ name: "build" }]
    await expect(send({ agent: "research" })).rejects.toThrow("not available on this engine")
  })

  test("rechecks research after waiting for a worktree, before dispatch", async () => {
    const { sendFollowupDraft } = await import("./submit")
    const agents = [{ name: "research" }]
    let sent = false
    let removed = false
    await expect(
      sendFollowupDraft({
        client: {
          session: {
            promptAsync: async () => {
              sent = true
            },
          },
        } as unknown as SendInput["client"],
        sync: {
          data: { agent: agents, command: [], message: {}, config: {} },
          session: {
            optimistic: {
              add: () => undefined,
              remove: () => {
                removed = true
              },
            },
          },
        } as unknown as SendInput["sync"],
        serverSync: { session: { set: () => undefined } } as unknown as SendInput["serverSync"],
        before: () => {
          agents.length = 0
          return true
        },
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: text, start: 0, end: text.length }],
          context: [],
          agent: "research",
          model: { providerID: "p", modelID: "m" },
        },
      }),
    ).rejects.toThrow("not available on this engine")
    expect(sent).toBe(false)
    expect(removed).toBe(true)
  })

  test("queued sends recheck Local on their destination after waiting, even if another engine is protected", async () => {
    const { sendFollowupDraft } = await import("./submit")
    const policy = {
      enabled: true,
      web: "none",
      lock: false,
      endpoints: [],
      web_domains: { allow: [], deny: [] },
      allow: [],
      user_may: [],
      locked_keys: [],
      endpoint_domains: [],
      warnings: [],
    }
    const state = { enabled: true, sent: false, removed: false, checked: 0 }
    window.api = { vectorLocal: { status: async () => ({ enabled: true, held: false, sources: {} }) } }
    try {
      await expect(
        sendFollowupDraft({
          client: {
            local: {
              get: async () => {
                state.checked++
                return { data: { policy: { ...policy, enabled: state.enabled } } }
              },
            },
            session: {
              promptAsync: async () => {
                state.sent = true
              },
            },
          } as unknown as SendInput["client"],
          sync: {
            data: { agent: [{ name: "build" }], command: [], message: {}, config: {} },
            session: {
              optimistic: {
                add: () => undefined,
                remove: () => {
                  state.removed = true
                },
              },
            },
          } as unknown as SendInput["sync"],
          serverSync: { session: { set: () => undefined } } as unknown as SendInput["serverSync"],
          before: () => {
            state.enabled = false
            return true
          },
          draft: {
            sessionID: "session-1",
            sessionDirectory: "/repo/main",
            prompt: [{ type: "text", content: text, start: 0, end: text.length }],
            context: [],
            agent: "build",
            model: { providerID: "p", modelID: "m" },
          },
        }),
      ).rejects.toThrow("could not confirm protection")
      expect(state).toEqual({ enabled: false, sent: false, removed: true, checked: 2 })
    } finally {
      delete window.api
    }
  })

  const ids = (parts: SentPart[]) => parts.map((part) => part.id)
  const files = (parts: SentPart[]) => parts.filter((part) => part.type === "file")

  // The engine stores parts under the ids the request carries, and the timeline drops an optimistic
  // part only when a stored part with the same id arrives. An echo on any other id stays beside the
  // stored copy, so a pasted image shows twice. A second echo sent after the request could also land
  // on top of parts the server already stored, so there is exactly one, and it comes first.
  const expectOneEchoBeforeRequest = (steps: Step[], instructions: number) => {
    expect(steps.map((step) => step.kind)).toEqual(["echo", "request"])
    const [echo, request] = steps.map((step) => step.parts)
    expect(ids(echo)).toEqual(ids(request.filter((part) => !part.synthetic)))
    expect(request.filter((part) => part.synthetic)).toHaveLength(instructions)
    expect(files(echo)).toHaveLength(1)
    expect(files(request)).toHaveLength(1)
    // Stored parts are ordered by id, so the hidden instructions have to sort before the image.
    expect(ids(request)).toEqual([...ids(request)].sort())
  }

  test("keeps the echoed ids when the desktop adds task context", async () => {
    expectOneEchoBeforeRequest(await withDesktopContext(() => send()), 1)
  })

  test("sends the judge setting, and the policy an older engine needs to run the judge at all", async () => {
    const steps = await send({ judge: "changes" })
    expect(steps.at(-1)?.judge).toBe("changes")
    // A current engine reads the setting and drops the policy; an older one runs the judge only when told to.
    expectOneEchoBeforeRequest(steps, 1)
    const request = steps.at(-1)?.parts ?? []
    expect(request.some((part) => part.text?.startsWith("<vector_verified_completion>"))).toBe(true)
    // A draft queued before the scope existed still turns the judge on for large tasks.
    expect((await send({ llmJudge: true })).at(-1)?.judge).toBe("thorough")
    const off = await send()
    expect(off.at(-1)?.judge).toBeUndefined()
    expectOneEchoBeforeRequest(off, 0)
    // Only the build agent: Plan mode has nothing to judge, and a custom agent is never judged by a current engine.
    expectOneEchoBeforeRequest(await send({ judge: "thorough", agent: "plan" }), 0)
    expectOneEchoBeforeRequest(await send({ judge: "thorough", agent: "reviewer" }), 0)
  })

  test("keeps the echoed ids when the judge is on and the desktop adds task context", async () => {
    expectOneEchoBeforeRequest(await withDesktopContext(() => send({ judge: "thorough" })), 2)
  })

  test("adds no file map for a greeting, and adds it for any work, small actions included", async () => {
    const map = async (content: string) =>
      (await withDesktopContext(() => send({ prompt: [{ type: "text", content, start: 0, end: content.length }] })))
        .at(-1)
        ?.parts.filter((part) => part.synthetic).length
    expect(await map("hi")).toBe(0)
    for (const content of ["ship to vercel", "fix the typo in README.md", "what does this function do?"])
      expect(await map(content), content).toBe(1)
  })

  test("sends a thanks to the quick lane only when no work waits on the user", async () => {
    const thanks = (history: object[], parts: Record<string, SentPart[]> = {}) =>
      send({ prompt: [{ type: "text", content: "thanks", start: 0, end: 6 }] }, history, {}, parts).then(
        (steps) => steps.at(-1)?.agent,
      )
    const reply = (id: string, text: string, extra: object = {}) => ({
      history: [{ id, role: "assistant", time: { created: 1, completed: 2 }, finish: "stop", ...extra }],
      parts: { [id]: [{ id: `${id}-text`, type: "text", text }] },
    })
    const done = reply("done", "Fixed the typo in README.md.")
    expect(await thanks(done.history, done.parts)).toBe("quick")
    // The automatic quick lane is not a pick: a current engine sizes it and can escalate it to Work.
    const automatic = await send({ prompt: [{ type: "text", content: "thanks", start: 0, end: 6 }] }, done.history)
    expect(automatic.at(-1)?.size).toBeUndefined()
    // A thanks with a request after it is work, for the picked agent with the history.
    for (const content of ["thanks for the update ship it to vercel", "thanks for that run the tests"])
      expect(
        (await send({ prompt: [{ type: "text", content, start: 0, end: content.length }] }, done.history)).at(-1)
          ?.agent,
        content,
      ).toBe("build")
    // An offer or a closing line without a question mark waits on nothing.
    const offered = reply("offered", "Fixed the typo. Let me know if this works for you.")
    expect(await thanks(offered.history, offered.parts)).toBe("quick")
    // The agent asked something: the thanks answers that work, which the engine sizes with the history.
    const asked = reply("asked", "Deployed. Do you want me to keep the preview URL?")
    expect(await thanks(asked.history, asked.parts)).toBe("build")
    // The run did not finish.
    const failed = reply("failed", "Migrating the routes", { error: { name: "MessageAbortedError" } })
    expect(await thanks(failed.history, failed.parts)).toBe("build")
    // The user dismissed the agent's question: the work still waits on them.
    const dismissed = {
      history: done.history,
      parts: {
        done: [...done.parts.done, { id: "done-question", type: "tool", tool: "question", state: { status: "error" } }],
      },
    }
    expect(await thanks(dismissed.history, dismissed.parts as unknown as Record<string, SentPart[]>)).toBe("build")
    // A greeting's reply asks back, but waits on nothing.
    const smallTalk = reply("chat", "I'm doing great, thanks for asking! How about you?", { agent: "quick" })
    expect(await thanks(smallTalk.history, smallTalk.parts)).toBe("quick")
  })

  test("sends a greeting or a help with an image, a file or a named subagent to the agent the user picked", async () => {
    const mention = { type: "file" as const, path: "src/app.ts", content: "@src/app.ts", start: 3, end: 14 }
    for (const word of ["hi", "thanks", "help"]) {
      const typed = { type: "text" as const, content: word, start: 0, end: word.length }
      const withImage = await send({ prompt: [typed, pasted] })
      expect(withImage.at(-1)?.agent, word).toBe("build")
      expect(files(withImage.at(-1)?.parts ?? []), word).toHaveLength(1)
      expect((await send({ prompt: [typed, mention] })).at(-1)?.agent, word).toBe("build")
    }
    // The same words alone are a greeting for the quick lane.
    expect((await send({ prompt: [{ type: "text", content: "hi", start: 0, end: 2 }] })).at(-1)?.agent).toBe("quick")
  })

  test("in Deep research sends a greeting to the quick lane, with no research size, and research to the research agent", async () => {
    const hi = await send({
      agent: "research",
      size: "thorough",
      research: { scope: "web" },
      prompt: [{ type: "text", content: "hi", start: 0, end: 2 }],
    })
    // "hi" plans no research: one small request on the quick lane, which takes no Work or Thorough size.
    expect(hi.at(-1)).toMatchObject({ kind: "request", agent: "quick" })
    expect(hi.at(-1)?.size).toBeUndefined()
    expect(hi.at(-1)?.parts[0]).not.toHaveProperty("metadata")
    const question = await withDesktopContext(() =>
      send({
        agent: "research",
        size: "standard",
        research: { scope: "web+brain" },
        prompt: [{ type: "text", content: text, start: 0, end: text.length }],
      }),
    )
    expect(question.at(-1)).toMatchObject({ kind: "request", agent: "research", size: "standard" })
    // Research reads the repository through its own tools, so the desktop's file map is not added.
    expect(question.at(-1)?.parts.filter((part) => part.synthetic)).toHaveLength(0)
    const [echo, request] = question.map((step) => step.parts[0] as SentPart & { metadata?: unknown })
    expect(request?.metadata).toEqual({ "vector.research": { scope: "web+brain" } })
    expect(echo?.metadata).toEqual(request?.metadata)
  })

  test("never sends a research size to an agent outside Deep research", async () => {
    // A draft queued in Deep research keeps its size only on the research agent; Quick's Chat size only on quick.
    expect((await send({ agent: "build", size: "thorough" })).at(-1)?.size).toBeUndefined()
    expect((await send({ agent: "research", size: "chat" })).at(-1)?.size).toBeUndefined()
    expect(
      (await send({ agent: "quick", size: "chat", prompt: [{ type: "text", content: "hi", start: 0, end: 2 }] })).at(-1)
        ?.size,
    ).toBe("chat")
  })

  test("sends exactly the echoed parts when nothing is added", async () => {
    expectOneEchoBeforeRequest(await send(), 0)
  })

  test("adds the desktop's file map only before the session's first reply", async () => {
    const history = [
      { id: "u", role: "user", time: { created: 0 } },
      { id: "a", role: "assistant", time: { created: 1, completed: 2 }, finish: "stop" },
    ]
    expectOneEchoBeforeRequest(await withDesktopContext(() => send({}, history)), 0)
  })

  test("sends the interactive per-run cap on top of the configured run budget", async () => {
    const { clearSpendPolicyCache } = await import("@/features/economics/spend-limits-api")
    const policy = { interactive: { perRun: { usd: 10, warnAt: 0.7 } }, unattended: {} }
    clearSpendPolicyCache()
    Object.assign(window, { api: { spendLimits: { limits: async () => policy } } })
    try {
      const steps = await send({}, [], { budget: { run: { usd: 20, steps: 60 } } })
      expect(steps.find((step) => step.kind === "request")?.budget).toEqual({ usd: 10, steps: 60, warnAt: 0.7 })
    } finally {
      delete (window as { api?: unknown }).api
      clearSpendPolicyCache()
    }
  })

  test("sends no budget without an interactive cap, leaving the config to the engine", async () => {
    const steps = await send({}, [], { budget: { run: { usd: 20, steps: 60 } } })
    expect(steps.find((step) => step.kind === "request")?.budget).toBeUndefined()
  })

  test("sends the interactive per-run cap with a slash command", async () => {
    const { clearSpendPolicyCache } = await import("@/features/economics/spend-limits-api")
    const { sendFollowupDraft } = await import("./submit")
    const policy = { interactive: { perRun: { usd: 10, warnAt: 0.7 } }, unattended: {} }
    const commands: unknown[] = []
    clearSpendPolicyCache()
    Object.assign(window, { api: { spendLimits: { limits: async () => policy } } })
    try {
      await sendFollowupDraft({
        client: {
          session: {
            command: async (input: unknown) => {
              commands.push(input)
              return { data: undefined }
            },
          },
        } as unknown as SendInput["client"],
        serverSync: { session: { set: () => undefined } } as unknown as SendInput["serverSync"],
        sync: {
          data: { command: [{ name: "review" }], message: {}, config: { budget: { run: { usd: 20, steps: 60 } } } },
        } as unknown as SendInput["sync"],
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "/review src", start: 0, end: 11 }],
          context: [],
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        },
      })
      expect(commands).toMatchObject([
        { command: "review", arguments: "src", budget: { usd: 10, steps: 60, warnAt: 0.7 } },
      ])
    } finally {
      delete (window as { api?: unknown }).api
      clearSpendPolicyCache()
    }
  })
})

describe("submission agent selection", () => {
  test("uses the plan agent only while Plan Mode is enabled", () => {
    const available = [
      { name: "plan", mode: "primary" },
      { name: "build", mode: "primary" },
    ]

    expect(resolveSubmissionAgent({ planMode: true, current: "build", available })).toBe("plan")
    expect(resolveSubmissionAgent({ planMode: false, current: "plan", available })).toBe("build")
  })

  test("preserves a non-plan agent when Plan Mode is disabled", () => {
    expect(
      resolveSubmissionAgent({
        planMode: false,
        current: "review",
        available: [{ name: "review", mode: "primary" }],
      }),
    ).toBe("review")
  })

  test("sends a greeting to the quick lane on every agent, so an engine that does not size it answers cheaply too", () => {
    for (const current of ["build", "reviewer"])
      expect(resolveExecutionAgent({ planMode: false, quickRequested: false, difficulty: "trivial", current })).toBe(
        "quick",
      )
    // Plan mode keeps its agent; the engine answers its greetings on the quick lane.
    expect(
      resolveExecutionAgent({ planMode: true, quickRequested: false, difficulty: "trivial", current: "plan" }),
    ).toBe("plan")
    // A reply that continues the work stays on the agent the user picked.
    expect(
      resolveExecutionAgent({ planMode: false, quickRequested: false, difficulty: "simple", current: "reviewer" }),
    ).toBe("reviewer")
  })

  test("explicit Quick mode takes the quick lane, and Plan mode keeps its agent", () => {
    expect(
      resolveExecutionAgent({ planMode: false, quickRequested: true, difficulty: "standard", current: "build" }),
    ).toBe("quick")
    expect(
      resolveExecutionAgent({ planMode: true, quickRequested: true, difficulty: "trivial", current: "plan" }),
    ).toBe("plan")
  })

  test("repairs a stale quick agent for ordinary work", () => {
    expect(
      resolveExecutionAgent({ planMode: false, quickRequested: false, difficulty: "standard", current: "quick" }),
    ).toBe("build")
  })

  test("Deep research sends work to the research agent and a greeting to the quick lane", () => {
    for (const difficulty of ["simple", "standard", "complex"] as const)
      expect(
        resolveExecutionAgent({
          planMode: false,
          quickRequested: false,
          researchRequested: true,
          difficulty,
          current: "build",
        }),
      ).toBe("research")
    expect(
      resolveExecutionAgent({
        planMode: false,
        quickRequested: false,
        researchRequested: true,
        difficulty: "trivial",
        current: "build",
      }),
    ).toBe("quick")
    // The mode is the user's pick for this message, so Plan mode's agent does not take it.
    expect(
      resolveExecutionAgent({
        planMode: true,
        quickRequested: false,
        researchRequested: true,
        difficulty: "standard",
        current: "plan",
      }),
    ).toBe("research")
  })

  test("outside Deep research, a session that remembers the research agent sends work to build", () => {
    expect(
      resolveExecutionAgent({ planMode: false, quickRequested: false, difficulty: "standard", current: "research" }),
    ).toBe("build")
    expect(
      resolveExecutionAgent({ planMode: false, quickRequested: false, difficulty: "standard", current: "build" }),
    ).toBe("build")
  })
})

describe("queued follow-up submission", () => {
  test("keeps the draft intact when the task queue rejects it", async () => {
    params = { id: "session-1" }
    const queued: unknown[] = []
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => true,
      onQueue: (draft) => {
        queued.push(draft)
        return false
      },
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(queued).toHaveLength(1)
    expect(promptResetCount).toBe(0)
    expect(sentPrompts).toHaveLength(0)
  })
})

describe("workspace validation", () => {
  test("does not submit into a missing project folder", async () => {
    params = { id: "session-1" }
    workspaceError = new Error("Project directory no longer exists")

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic).toHaveLength(0)
  })
})

describe("missing model", () => {
  const submitWith = (connectProvider: () => void) =>
    createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      connectProvider,
    })

  test("opens the connect-provider flow when no provider offers a model", async () => {
    currentModel = undefined
    availableModels = []
    const opened: boolean[] = []

    await submitWith(() => opened.push(true)).handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(opened).toEqual([true])
    expect(toasts).toEqual([
      {
        title: "prompt.toast.providerRequired.title",
        description: "prompt.toast.providerRequired.description",
      },
    ])
    expect(promptResetCount).toBe(0)
    expect(createdSessions).toHaveLength(0)
  })

  test("in a build that cannot sign in to Vector itself, says to sign in on the engine's computer", async () => {
    currentModel = undefined
    availableModels = []
    vectorAccount = undefined
    const opened: boolean[] = []

    await submitWith(() => opened.push(true)).handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(opened).toEqual([true])
    expect(toasts).toEqual([
      {
        title: "prompt.toast.providerRequired.title",
        description: "prompt.toast.providerRequired.descriptionEngine",
      },
    ])
    expect(promptResetCount).toBe(0)
  })

  test("keeps the select-model toast while the provider catalog is still loading", async () => {
    currentModel = undefined
    availableModels = []
    providerReady = false
    providerLoaded = false
    const opened: boolean[] = []

    await submitWith(() => opened.push(true)).handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(opened).toHaveLength(0)
    expect(toasts).toEqual([
      {
        title: "prompt.toast.modelAgentRequired.title",
        description: "prompt.toast.modelAgentRequired.description",
      },
    ])
    expect(promptResetCount).toBe(0)
    expect(createdSessions).toHaveLength(0)
  })

  test("keeps the select-model toast when the provider catalog failed to load", async () => {
    // A failed load leaves the catalog empty even for users with connected providers.
    currentModel = undefined
    availableModels = []
    providerReady = true
    providerLoaded = false
    const opened: boolean[] = []

    await submitWith(() => opened.push(true)).handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(opened).toHaveLength(0)
    expect(toasts).toEqual([
      {
        title: "prompt.toast.modelAgentRequired.title",
        description: "prompt.toast.modelAgentRequired.description",
      },
    ])
    expect(promptResetCount).toBe(0)
    expect(createdSessions).toHaveLength(0)
  })

  test("still asks for a model when one is available but none is selected", async () => {
    currentModel = undefined
    const opened: boolean[] = []

    await submitWith(() => opened.push(true)).handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(opened).toHaveLength(0)
    expect(toasts).toEqual([
      {
        title: "prompt.toast.modelAgentRequired.title",
        description: "prompt.toast.modelAgentRequired.description",
      },
    ])
    expect(createdSessions).toHaveLength(0)
  })
})

describe("image attachments", () => {
  test("never send an image prompt on Vector Codium that the person did not pick", async () => {
    currentModel = { id: "maker/text", provider: { id: "anthropic" } }
    availableModels = [
      currentModel,
      { id: "codium/vision", provider: { id: "vector-plan" }, capabilities: { input: { image: true } } },
    ] as typeof availableModels
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [
        {
          type: "image",
          id: "image",
          filename: "image.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        },
      ],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(toasts).toMatchObject([
      {
        title: "Connect an image-capable model",
        description:
          "This model accepts text only, and Vector never switches to Vector Codium on its own. Choose a model with image input, then send again.",
      },
    ])
    expect(createdSessions).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
    expect(optimistic).toHaveLength(0)
  })

  test("with Vector Local on and no model on the listed servers that reads images, says so and sends nothing", async () => {
    currentModel = { id: "qwen3:30b", provider: { id: "ollama" } }
    availableModels = [currentModel, { id: "qwen3:8b", provider: { id: "ollama" } }]
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [
        {
          type: "image",
          id: "image",
          filename: "image.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        },
      ],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      localMode: () => true,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(toasts).toMatchObject([
      {
        title: "No model on your servers reads images",
        description:
          "With Vector Local on, images go only to models on the servers you listed, and none of them accepts images. Remove the image, or add a vision model on a server you host, then send again.",
      },
    ])
    expect(createdSessions).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
  })
})

describe("included model data notice", () => {
  test("sending to an included model shows no data disclaimer toast", async () => {
    // Free models show their label alone; the one-time acceptance question is the one place that explains it.
    currentModel = {
      id: "maker/coder:free",
      provider: { id: "vector" },
      freeModel: { source: "shared" },
    } as typeof currentModel
    availableModels = [currentModel!]
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    // The prompt went on past where the toast used to show: its optimistic message is in the new session.
    expect(createdSessions).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(optimistic).toHaveLength(1)
    expect(
      toasts.filter((toast) =>
        /handle your data|retention|train/i.test(`${toast.title ?? ""} ${toast.description ?? ""}`),
      ),
    ).toEqual([])
  })
})

describe("may-train free model consent", () => {
  const submitWith = (confirm: (model: unknown) => Promise<boolean>) =>
    createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
      confirmFreeModelTraining: confirm,
    })

  test("asks before the first prompt to a model that may train, and sends nothing when declined", async () => {
    currentModel = {
      id: "poolside/laguna-s-2.1:free",
      provider: { id: "vector" },
      freeModel: { source: "shared", dataPolicy: "may-train" },
    } as typeof currentModel
    availableModels = [currentModel!]
    const asked: unknown[] = []
    const sessions = createdSessions.length
    await submitWith(async (model) => {
      asked.push(model)
      return false
    }).handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    expect(asked).toEqual([currentModel])
    expect(createdSessions).toHaveLength(sessions)
    expect(sentPrompts).toHaveLength(0)

    await submitWith(async () => true).handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    expect(createdSessions).toHaveLength(sessions + 1)
  })

  test("never asks for a no-training free model", async () => {
    currentModel = {
      id: "cohere/north-mini-code:free",
      provider: { id: "vector" },
      freeModel: { source: "shared", dataPolicy: "no-training" },
    } as typeof currentModel
    availableModels = [currentModel!]
    const asked: unknown[] = []
    await submitWith(async (model) => {
      asked.push(model)
      return false
    }).handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    expect(asked).toEqual([])
  })
})

describe("pasted text", () => {
  const email = "Hi team,\nI prefer meetings on Tuesdays.\nAlways cc my manager.\nThanks, Dana"

  test("finds where the text holds what the user pasted, whole or line by line", async () => {
    const { pastedSpans } = await import("./submit")
    const text = `Summarize this email:\n${email}\nAlways use bullet points.`
    const start = text.indexOf("Hi team")
    expect(pastedSpans(text, [email])).toEqual([[start, start + email.length]])
    // The editor's own spaces and line ends, and a paste carried with its trailing newline.
    expect(pastedSpans("see: a b", ["a b\r\n"])).toEqual([[5, 8]])
    // Two pastes, and the same words pasted twice, are each marked once.
    expect(pastedSpans("x one y one", ["one", "one"])).toEqual([
      [2, 5],
      [8, 11],
    ])
    // A line the user removed from a paste leaves the rest marked; a paste deleted again marks nothing.
    const trimmed = `Summarize:\nHi team,\nThanks, Dana\nAlways use bullet points.`
    expect(pastedSpans(trimmed, [email])).toEqual([
      [11, 19],
      [20, 32],
    ])
    expect(pastedSpans("Always use bullet points.", [email])).toEqual([])
    expect(pastedSpans("", [email])).toEqual([])
  })

  test("marks the whole text when a pasted line was changed where it sits", async () => {
    const { pastedSpans } = await import("./submit")
    // "I prefer meetings on Tuesdays." became "I prefer meetings on Mondays.": it cannot be told from typed words.
    const edited = `Summarize:\nHi team,\nI prefer meetings on Mondays.\nAlways cc my manager.\nThanks, Dana`
    expect(pastedSpans(edited, [email])).toEqual([[0, edited.length]])
  })

  test("marks the whole text for a long log found by one of its lines", async () => {
    const { pastedSpans } = await import("./submit")
    const log = Array.from({ length: 450 }, (_, index) => `2026-10-23 12:00:${index} worker ${index} started`).join(
      "\n",
    )
    const text = `why does this fail?\n${log.replace("worker 7 started", "worker 7 crashed")}`
    expect(pastedSpans(text, [log])).toEqual([[0, text.length]])
  })

  test("the pasted span is marked on the sent part and its echo", async () => {
    const { createPromptSubmit, rememberPaste } = await import("./submit")
    const text = `Summarize this email:\n${email}`
    const original = promptValue.splice(0, promptValue.length, {
      type: "text",
      content: text,
      start: 0,
      end: text.length,
    })
    try {
      rememberPaste(prompt, email)
      params = { id: "session-1" }
      const submit = createPromptSubmit({
        prompt,
        info: () => ({ id: "session-1" }),
        imageAttachments: () => [],
        commentCount: () => 0,
        autoAccept: () => false,
        mode: () => "normal",
        working: () => false,
        editor: () => undefined,
        queueScroll: () => undefined,
        promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
        addToHistory: () => undefined,
        resetHistoryNavigation: () => undefined,
        setMode: () => undefined,
        setPopover: () => undefined,
        onSubmit: () => undefined,
      })
      await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const start = text.indexOf("Hi team")
      expect(sentPrompts.at(-1)?.input.parts?.[0]).toMatchObject({
        type: "text",
        text,
        metadata: { "vector.pasted": [[start, text.length]] },
      })
      const echo = (optimistic.at(-1) as unknown as { parts: { metadata?: Record<string, unknown> }[] }).parts[0]
      expect(echo?.metadata).toEqual({ "vector.pasted": [[start, text.length]] })
    } finally {
      promptValue.splice(0, promptValue.length, ...original)
    }
  })

  test("a paste never splits a word, and one the text holds more often than it was pasted marks the whole text", async () => {
    const { pastedSpans } = await import("./submit")
    expect(pastedSpans("Always run the tests before you merge to main.", ["test"])).toEqual([])
    expect(pastedSpans("I prefer pnpm_workspaces", ["pnpm"])).toEqual([])
    expect(pastedSpans("Ask about the retest", ["test"])).toEqual([])
    expect(pastedSpans("Never push directly to main without a review.", ["main"])).toEqual([[23, 27]])
    // Which "main" was pasted cannot be told, so none of the words vouches for anything.
    const twice = "Merge main into the branch, then never push directly to main."
    expect(pastedSpans(twice, ["main"])).toEqual([[0, twice.length]])
    expect(pastedSpans("x one y one", ["one"])).toEqual([[0, 11]])
  })

  test("a one-line paste changed in place marks the whole text", async () => {
    const { pastedSpans } = await import("./submit")
    const paste = "Please always send the signed invoice to accounts by Friday."
    const monday = `Answer this email.\n${paste.replace("Friday", "Monday")}`
    expect(pastedSpans(monday, [paste])).toEqual([[0, monday.length]])
    const unstopped = `Answer this email.\n${paste.slice(0, -1)}`
    expect(pastedSpans(unstopped, [paste])).toEqual([[0, unstopped.length]])
    const meetings = "I prefer to get the slides as a PDF before each review meeting."
    const plural = `Answer this email.\n${meetings.replace("meeting.", "meetings.")}`
    expect(pastedSpans(plural, [meetings])).toEqual([[0, plural.length]])
  })

  test("a paste marks only the message of the draft it went into", async () => {
    const { pastedIn, rememberPaste, restorePastes, takePastes } = await import("./submit")
    const draft = {}
    const other = {}
    rememberPaste(draft, "test")
    rememberPaste(other, "main")
    expect(takePastes(draft, "Run the test once more")).toEqual([[8, 12]])
    // The paste went with that message: the next one in the same draft is the user's own, and so is a draft it never
    // went into.
    expect(takePastes(draft, "Always run the test suite before you merge.")).toEqual([])
    expect(takePastes({}, "Never push directly to main without a review.")).toEqual([])
    // The same message brought back whole marks its paste again, in any draft.
    const back = {}
    restorePastes(back, "Run the test once more")
    expect(takePastes(back, "Run the test once more")).toEqual([[8, 12]])
    // A message the session holds says where its pastes were, as the composer marked them when it was sent.
    const text = "Summarize https://example.com/paper for me"
    const part = { text, metadata: { "vector.pasted": [[10, 35]] } }
    expect(pastedIn(part)).toEqual(["https://example.com/paper"])
    expect(pastedIn({ text, metadata: { "vector.pasted": [[10, 999]] } })).toEqual([])
    const undone = {}
    restorePastes(undone, text, pastedIn(part))
    expect(takePastes(undone, text)).toEqual([[10, 35]])
    expect(takePastes(other, "Never push directly to main without a review.")).toEqual([[23, 27]])
  })

  test("a typed message carries no paste marks", async () => {
    const { pastedSpans } = await import("./submit")
    expect(pastedSpans("When I say ship it, I mean open a PR, wait for CI, then merge", [email])).toEqual([])
  })

  test("a slash command's pasted arguments are marked from where the arguments start", async () => {
    type SendInput = Parameters<typeof import("./submit").sendFollowupDraft>[0]
    const { sendFollowupDraft } = await import("./submit")
    const commands: unknown[] = []
    const text = "/review Always cc my manager."
    await sendFollowupDraft({
      client: {
        session: {
          command: async (input: unknown) => {
            commands.push(input)
            return { data: undefined }
          },
        },
      } as unknown as SendInput["client"],
      serverSync: { session: { set: () => undefined } } as unknown as SendInput["serverSync"],
      sync: { data: { command: [{ name: "review" }], message: {}, config: {} } } as unknown as SendInput["sync"],
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: text, start: 0, end: text.length }],
        context: [],
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        pasted: [[8, text.length]],
      },
    })
    expect(commands).toMatchObject([{ command: "review", arguments: "Always cc my manager.", pasted: [[0, 21]] }])
  })
})

describe("follow-ups while Vector works", () => {
  const event = () => ({ preventDefault: () => undefined }) as unknown as Event
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
  // The open session's queueEnabled, as the session page builds it, while the agent works.
  const working =
    (followup: "steer" | "queue", steer = true) =>
    (alternate: boolean) =>
      queueEnabled({ busy: true, blocked: false, child: false, followup, steer, alternate })

  const submitWhileWorking = (input: {
    shouldQueue: (alternate: boolean) => boolean
    mode?: "normal" | "shell"
    queued?: unknown[]
    foreground?: () => { promote?: () => Promise<boolean> } | undefined
  }) =>
    createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => input.mode ?? "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: input.shouldQueue,
      onQueue: (draft) => {
        input.queued?.push(draft)
        return true
      },
      foreground: input.foreground,
      onSubmit: () => undefined,
    })

  test("Enter steers by default; Queue, an older engine and Alt+Enter flip it; idle, blocked and subagent sessions never queue", () => {
    const base = { busy: true, blocked: false, child: false, followup: "steer" as const, steer: true, alternate: false }
    expect(queueEnabled(base)).toBe(false)
    expect(queueEnabled({ ...base, alternate: true })).toBe(true)
    expect(queueEnabled({ ...base, followup: "queue" })).toBe(true)
    expect(queueEnabled({ ...base, followup: "queue", alternate: true })).toBe(false)
    // An engine before 1.99.100 cannot take a message mid-run, so Enter queues there and Alt+Enter steers.
    expect(queueEnabled({ ...base, steer: false })).toBe(true)
    expect(queueEnabled({ ...base, steer: false, alternate: true })).toBe(false)
    for (const closed of [{ busy: false }, { blocked: true }, { child: true }])
      for (const alternate of [false, true])
        for (const followup of ["steer", "queue"] as const)
          expect(queueEnabled({ ...base, ...closed, alternate, followup })).toBe(false)
  })

  test("Alt+Enter queues a message that would steer, and plain Enter steers it into the running turn", async () => {
    params = { id: "session-1" }
    promptValue = typed("also update the changelog")
    const queued: unknown[] = []
    const submit = submitWhileWorking({ shouldQueue: working("steer"), queued })

    await submit.handleSubmit(event(), { alternate: true })
    expect(queued).toHaveLength(1)
    expect(sentPrompts).toHaveLength(0)

    await submit.handleSubmit(event())
    await settle()
    expect(queued).toHaveLength(1)
    expect(sentPrompts).toHaveLength(1)
  })

  test("with Queue chosen, Enter queues and Alt+Enter steers", async () => {
    params = { id: "session-1" }
    promptValue = typed("also update the changelog")
    const queued: unknown[] = []
    const submit = submitWhileWorking({ shouldQueue: working("queue"), queued })

    await submit.handleSubmit(event())
    expect(queued).toHaveLength(1)
    await submit.handleSubmit(event(), { alternate: true })
    await settle()
    expect(queued).toHaveLength(1)
    expect(sentPrompts).toHaveLength(1)
  })

  test("slash commands and shell input always queue while the agent works, whatever the mode", async () => {
    params = { id: "session-1" }
    commands = [{ name: "review" }]
    promptValue = typed("/review the parser")
    const queued: Array<{ shell?: true; prompt: Prompt }> = []
    const submit = submitWhileWorking({ shouldQueue: working("steer"), queued: queued as unknown[] })
    await submit.handleSubmit(event())
    await submit.handleSubmit(event(), { alternate: true })
    expect(queued).toHaveLength(2)
    expect(queued.every((draft) => draft.shell === undefined)).toBe(true)

    // Shell input queues as a shell command, never as a prompt.
    promptValue = typed("bun test")
    const shell = submitWhileWorking({ shouldQueue: working("queue"), mode: "shell", queued: queued as unknown[] })
    await shell.handleSubmit(event(), { alternate: true })
    expect(queued).toHaveLength(3)
    expect(queued[2]!.shell).toBe(true)

    // Text that only starts with a slash is a message, and steers.
    promptValue = typed("/tmp is full, clear it")
    await submit.handleSubmit(event())
    await settle()
    expect(queued).toHaveLength(3)
    expect(sentPrompts).toHaveLength(1)
    expect(sentShell).toHaveLength(0)
  })

  test("nothing queues once the queue is closed, commands included", async () => {
    params = { id: "session-1" }
    commands = [{ name: "review" }]
    promptValue = typed("/review the parser")
    const queued: unknown[] = []
    const blocked = (alternate: boolean) =>
      queueEnabled({ busy: true, blocked: true, child: false, followup: "queue", steer: true, alternate })
    await submitWhileWorking({ shouldQueue: blocked, queued }).handleSubmit(event())
    expect(queued).toHaveLength(0)
  })

  test("a queued shell draft runs as a shell command when it is sent", async () => {
    const { sendFollowupDraft } = await import("./submit")
    const ran: Array<{ command: string; agent: string }> = []
    let prompted = false
    const sent = await sendFollowupDraft({
      client: {
        local: { get: async () => ({ data: undefined }) },
        session: {
          shell: async (input: { command: string; agent: string }) => {
            ran.push(input)
            return { data: undefined }
          },
          promptAsync: async () => {
            prompted = true
            return { data: undefined }
          },
        },
      } as never,
      serverSync: { session: { set: () => undefined } } as never,
      sync: {
        data: { command: [], agent: engineAgents, message: {}, part: {}, config: {} },
        session: { optimistic: { add: () => undefined, remove: () => undefined } },
      } as never,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: typed("bun test"),
        context: [],
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        shell: true,
      },
    })
    expect(sent).toBe(true)
    expect(ran).toEqual([expect.objectContaining({ command: "bun test", agent: "build" })])
    expect(prompted).toBe(false)
  })

  test("a steer while a foreground subagent holds the turn says it waits for that step, and offers Move to background", async () => {
    params = { id: "session-1" }
    promptValue = typed("also update the changelog")
    const moved: string[] = []
    const waits = () => toasts.filter((toast) => toast.title === "prompt.toast.steerWaits.title")
    await submitWhileWorking({
      shouldQueue: working("steer"),
      foreground: () => ({ promote: async () => (moved.push("moved"), true) }),
    }).handleSubmit(event())
    await settle()
    expect(sentPrompts).toHaveLength(1)
    expect(waits()).toHaveLength(1)
    expect(waits()[0]?.actions?.map((action) => action.label)).toEqual(["prompt.toast.steerWaits.background"])
    ;(waits()[0]!.actions![0]!.onClick as () => void)()
    expect(moved).toEqual(["moved"])

    // An engine that cannot move them still says why the message waits, without the button.
    toasts.length = 0
    await submitWhileWorking({ shouldQueue: working("steer"), foreground: () => ({}) }).handleSubmit(event())
    await settle()
    expect(waits()).toHaveLength(1)
    expect(waits()[0]?.actions).toBeUndefined()

    // No foreground subagent, or a steer that failed: nothing waits on one.
    toasts.length = 0
    await submitWhileWorking({ shouldQueue: working("steer"), foreground: () => undefined }).handleSubmit(event())
    await settle()
    promptError = new Error("The engine refused the message")
    await submitWhileWorking({
      shouldQueue: working("steer"),
      foreground: () => ({ promote: async () => true }),
    }).handleSubmit(event())
    await settle()
    expect(waits()).toEqual([])
    expect(moved).toEqual(["moved"])
  })

  test("a failed steer keeps the session busy, while a failed send from idle still shows it idle", async () => {
    params = { id: "session-1" }
    promptValue = typed("also update the changelog")
    promptError = new Error("The engine refused the message")

    await submitWhileWorking({ shouldQueue: working("steer") }).handleSubmit(event())
    await settle()
    // The run it was joining is still going: nothing marks the session idle, or busy.
    expect(statusSets).toEqual([])
    expect(toasts.some((toast) => toast.title === "prompt.toast.promptSendFailed.title")).toBe(true)

    const idle = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })
    await idle.handleSubmit(event())
    await settle()
    expect(statusSets.at(0)).toEqual({ sessionID: "session-1", type: "busy" })
    expect(statusSets.at(-1)).toEqual({ sessionID: "session-1", type: "idle" })
  })
})

describe("the abort scope", () => {
  const helpers = { count: 2, taskIDs: ["ses_a", "ses_b"], sessionIDs: ["ses_a", "ses_b"], untracked: [] }
  const none = { count: 0, taskIDs: [], sessionIDs: [], untracked: [] }
  const capabilities = (sessionStop: boolean) => ({
    backgroundSubagents: true,
    workDelegation: true,
    subagentLimits: true,
    sessionStop,
    taskPromote: true,
    taskResume: true,
    taskAttention: true,
    taskIsolation: true,
    workflows: true,
    backgroundShells: true,
    vectorscopeSettings: false,
    vectorscopeRuns: false,
  })
  const stopper = (input: {
    scope: "turn" | "all"
    helpers?: typeof helpers | (() => typeof helpers)
    sessionStop?: boolean
    aborted?: string[]
  }) =>
    createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onAbort: () => input.aborted?.push("paused"),
      stopScope: () => input.scope,
      helpers: () => (typeof input.helpers === "function" ? input.helpers() : (input.helpers ?? none)),
      capabilities: () => capabilities(input.sessionStop ?? true),
    })

  test("Stop with the default setting stops only the main turn, then says how many helpers still work", async () => {
    params = { id: "session-1" }
    const aborted: string[] = []
    await stopper({ scope: "turn", helpers, aborted }).abort()
    expect(stops).toEqual([{ route: "session.abort", input: { sessionID: "session-1" } }])
    expect(aborted).toEqual(["paused"])
    const toast = toasts.at(-1)
    expect(toast?.title).toBe("prompt.toast.helpersLeft.title.other")
    expect(toast?.actions?.map((action) => action.label)).toEqual([
      "prompt.toast.helpersLeft.stopAll",
      "prompt.toast.helpersLeft.showTasks",
    ])
  })

  test("the toast's Stop them too stops the main turn and every helper through route 1", async () => {
    params = { id: "session-1" }
    await stopper({ scope: "turn", helpers }).abort()
    const stopAll = toasts.at(-1)?.actions?.[0]?.onClick as () => void
    stops.length = 0
    stopAll()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(stops).toEqual([
      {
        route: "experimental.session.stop",
        input: { sessionID: "session-1", helpers: true, reason: "Stopped with the main agent; partial work was kept." },
      },
    ])
  })

  test("Stop them too stops the conversation that was stopped, even after the user opened another one", async () => {
    params = { id: "session-1" }
    const aborted: string[] = []
    await stopper({ scope: "turn", helpers, aborted }).abort()
    const stopAll = toasts.at(-1)?.actions?.[0]?.onClick as () => void
    stops.length = 0
    params = { id: "session-2" }
    stopAll()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(stops).toEqual([
      {
        route: "experimental.session.stop",
        input: { sessionID: "session-1", helpers: true, reason: "Stopped with the main agent; partial work was kept." },
      },
    ])
    // The open conversation's queue is not paused: only the Stop itself paused the stopped one's.
    expect(aborted).toEqual(["paused"])

    // An engine without route 1 stops the stopped conversation's helpers, not the ones of the conversation now open.
    const other = { count: 1, taskIDs: ["ses_other"], sessionIDs: ["ses_other"], untracked: [] }
    stops.length = 0
    params = { id: "session-1" }
    await stopper({
      scope: "turn",
      helpers: () => (params.id === "session-1" ? helpers : other),
      sessionStop: false,
    }).abort()
    const older = toasts.at(-1)?.actions?.[0]?.onClick as () => void
    stops.length = 0
    params = { id: "session-2" }
    older()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(stops.map((stop) => [stop.route, stop.input.sessionID])).toEqual([
      ["session.abort", "session-1"],
      ["experimental.task.stop", "session-1"],
    ])
    expect(stops[1]!.input.taskIDs).toEqual(["ses_a", "ses_b"])
  })

  test("with Stop set to include helpers, the default stop (Esc, Ctrl+G, Stop) never uses the plain abort", async () => {
    params = { id: "session-1" }
    await stopper({ scope: "all", helpers }).abort()
    expect(stops.map((stop) => stop.route)).toEqual(["experimental.session.stop"])
    expect(stops[0]!.input.helpers).toBe(true)
    expect(toasts).toEqual([])

    // An engine without route 1 gets the abort and task.stop for the helpers.
    stops.length = 0
    await stopper({ scope: "all", helpers, sessionStop: false }).abort()
    expect(stops.map((stop) => stop.route)).toEqual(["session.abort", "experimental.task.stop"])
    expect(stops[1]!.input.taskIDs).toEqual(["ses_a", "ses_b"])
  })

  test("a scope named by the Stop menu wins over the setting, and no toast appears without helpers", async () => {
    params = { id: "session-1" }
    await stopper({ scope: "all", helpers }).abort("turn")
    expect(stops.map((stop) => stop.route)).toEqual(["session.abort"])
    expect(toasts.at(-1)?.title).toBe("prompt.toast.helpersLeft.title.other")

    stops.length = 0
    toasts.length = 0
    await stopper({ scope: "turn" }).abort("all")
    expect(stops.map((stop) => stop.route)).toEqual(["experimental.session.stop"])

    stops.length = 0
    await stopper({ scope: "turn" }).abort()
    expect(stops.map((stop) => stop.route)).toEqual(["session.abort"])
    expect(toasts).toEqual([])
  })

  test("an empty submit while working stops with the setting's scope", async () => {
    params = { id: "session-1" }
    promptValue = typed("   ")
    await stopper({ scope: "all", helpers }).handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(stops.map((stop) => stop.route)).toEqual(["experimental.session.stop"])
  })
})
