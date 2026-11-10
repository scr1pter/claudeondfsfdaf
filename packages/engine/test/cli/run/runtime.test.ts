import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { VectorClient } from "@vectordevai/sdk/v2"
import { registerVectorKeymap } from "@vectordevai/tui/keymap"
import { RunFooter } from "@/cli/cmd/run/footer"
import { runInteractiveMode } from "@/cli/cmd/run/runtime"
import type { LifecycleInput } from "@/cli/cmd/run/runtime.lifecycle"
import type { SessionTurnInput } from "@/cli/cmd/run/stream.transport"
import { RUN_THEME_FALLBACK } from "@/cli/cmd/run/theme"
import type { FooterApi, RunProvider, StreamCommit } from "@/cli/cmd/run/types"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

type SessionMessage = NonNullable<Awaited<ReturnType<VectorClient["session"]["messages"]>>["data"]>[number]

const provider: RunProvider = {
  id: "openai",
  name: "OpenAI",
  source: "api",
  env: [],
  options: {},
  models: {
    "gpt-5": {
      id: "gpt-5",
      providerID: "openai",
      api: {
        id: "openai",
        url: "https://openai.test",
        npm: "@ai-sdk/openai",
      },
      name: "Little Frank",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

const transportProviders: RunProvider[][] = []

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ok<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: new Request("https://vector.test"),
    response: new Response(),
  })
}

function footer(): FooterApi {
  let closed = false
  const closes = new Set<() => void>()

  const notify = () => {
    for (const fn of closes) fn()
  }

  return {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event() {},
    append() {},
    idle() {
      return Promise.resolve()
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
    destroy() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
  }
}

afterEach(() => {
  mock.restore()
  transportProviders.length = 0
})

describe("run interactive runtime", () => {
  for (const dataPolicy of ["may-train", "no-training"] as const) {
    test(`a free model ${dataPolicy === "may-train" ? "that may train shows its notice once, before" : "that does not train shows no notice before"} the first request`, async () => {
      const sdk = new VectorClient()
      const shared = {
        ...provider,
        id: "vector",
        models: {
          "maker/free:free": {
            ...provider.models["gpt-5"],
            id: "maker/free:free",
            providerID: "vector",
            name: "Maker Free",
            freeModel: { source: "shared" as const, dataPolicy },
          },
        },
      }
      spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [shared], default: {} }))
      spyOn(sdk.session, "messages").mockImplementation(() => ok([]))
      spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
      spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
      spyOn(sdk.command, "list").mockImplementation(() => ok([]))
      const output = footer()
      const order: string[] = []
      spyOn(output, "append").mockImplementation((commit) => {
        if (commit.kind === "system") order.push(commit.text)
      })
      await runInteractiveMode(
        {
          sdk,
          directory: "/tmp",
          sessionID: "ses-free-notice",
          agent: "build",
          model: { providerID: "vector", modelID: "maker/free:free" },
          variant: undefined,
          files: [],
          initialInput: "hello",
          thinking: false,
          backgroundSubagents: false,
        },
        {
          createRuntimeLifecycle: async () => ({
            footer: output,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
          streamTransport: Promise.resolve({
            createSessionTransport: async () => ({
              runPromptTurn: async () => {
                order.push("request")
                output.close()
              },
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }),
            formatUnknownError: (error: unknown) => String(error),
          }),
        },
      )
      const notices = order.filter((text) => text.includes("May train on your prompts"))
      expect(order).toContain("request")
      if (dataPolicy === "no-training") {
        expect(notices).toEqual([])
        return
      }
      expect(notices).toHaveLength(1)
      // The label alone, with no disclaimer paragraph.
      expect(notices[0]).toEndWith("Maker Free · May train on your prompts")
      expect(notices[0]).not.toContain("Vector itself never trains on your prompts.")
      expect(order.indexOf(notices[0])).toBeLessThan(order.indexOf("request"))
    })
  }

  test("waits for provider metadata before eager replay transport bootstrap", async () => {
    const providersStarted = defer<void>()
    const providers = defer<void>()

    const sdk = new VectorClient()
    spyOn(sdk.config, "providers").mockImplementation(async () => {
      providersStarted.resolve()
      await providers.promise
      return ok({ providers: [provider], default: {} })
    })
    spyOn(sdk.session, "messages").mockImplementation(() =>
      ok([
        {
          info: {
            id: "msg-user-1",
            sessionID: "ses-1",
            role: "user",
            time: {
              created: 1,
            },
            agent: "build",
            model: {
              providerID: "openai",
              modelID: "gpt-5",
              variant: undefined,
            },
          },
          parts: [
            {
              id: "part-user-1",
              sessionID: "ses-1",
              messageID: "msg-user-1",
              type: "text",
              text: "hello",
            },
          ],
        } satisfies SessionMessage,
      ]),
    )
    spyOn(sdk.session, "get").mockRejectedValue(new Error("not needed"))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: true,
        replay: true,
        replayLimit: 100,
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: footer(),
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { providers?: () => RunProvider[]; footer: FooterApi }) => {
            transportProviders.push(input.providers?.() ?? [])
            setTimeout(() => {
              input.footer.close()
            }, 0)
            return {
              runPromptTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await providersStarted.promise

    expect(transportProviders).toEqual([])

    providers.resolve()

    await task

    expect(transportProviders).toEqual([[provider]])
  })

  test("sends the --max-cost and --max-steps budget on every interactive prompt turn", async () => {
    const sdk = new VectorClient()
    spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [provider], default: {} }))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))
    const turns: SessionTurnInput[] = []

    await runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: false,
        replay: false,
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        budget: { usd: 2, steps: 60 },
        files: [],
        initialInput: "say hi",
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: footer(),
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { footer: FooterApi }) => ({
            runPromptTurn: async (turn: SessionTurnInput) => {
              turns.push(turn)
              input.footer.close()
            },
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }),
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    expect(turns.map((turn) => [turn.prompt.text, turn.budget])).toEqual([["say hi", { usd: 2, steps: 60 }]])
  })
})

// The split footer's helper commands and notice (5.I.6). Its own Esc interrupt keeps stopping only the main turn.
describe("run interactive runtime helpers", () => {
  function task(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      parentSessionID: "ses-1",
      source: "subagent" as const,
      title: "Work",
      status: "running" as const,
      startedAt: 1,
      elapsedMs: 1,
      ownedPaths: [],
      dependsOn: [],
      resultAvailable: false,
      attempt: 1,
      controls: { inspect: true, message: true, stop: true },
      background: true,
      ...extra,
    }
  }

  async function mount(sdk: VectorClient) {
    spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [provider], default: {} }))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))
    const output = footer()
    const commits: StreamCommit[] = []
    spyOn(output, "append").mockImplementation((commit) => {
      commits.push(commit)
    })
    const ready = defer<LifecycleInput>()
    const running = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: false,
        replay: false,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: undefined,
        files: [],
        thinking: false,
        backgroundSubagents: true,
      },
      {
        createRuntimeLifecycle: async (input) => {
          ready.resolve(input)
          return {
            footer: output,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
        streamTransport: Promise.resolve({
          createSessionTransport: async () => ({
            runPromptTurn: async () => {},
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }),
          formatUnknownError: (error: unknown) => String(error),
        }),
      },
    )
    const input = await ready.promise
    const system = async (match: string) => {
      for (let index = 0; index < 100 && !commits.some((commit) => commit.text.includes(match)); index++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      return commits.filter((commit) => commit.kind === "system").map((commit) => commit.text)
    }
    return {
      input,
      commits,
      system,
      async close() {
        output.close()
        await running
      },
    }
  }

  test("an interrupt stops only the main turn and then says how many helpers still run", async () => {
    const sdk = new VectorClient()
    const abort = spyOn(sdk.session, "abort").mockImplementation(() => ok(true))
    const stop = spyOn(sdk.experimental.session, "stop").mockImplementation(() =>
      ok({ aborted: true, tasks: [], shells: 0, excluded: 0, skipped: 0 }),
    )
    const list = spyOn(sdk.experimental.task, "list").mockImplementation(() =>
      ok({
        tasks: [
          task("ses-a"),
          task("ses-b"),
          task("ses-fg", { background: false }),
          task("ses-done", { status: "completed" }),
        ],
        truncated: false,
      }),
    )
    const app = await mount(sdk)
    try {
      expect(app.input.onInterruptAll).toBeDefined()
      expect(app.input.onResumeInterrupted).toBeDefined()
      app.input.onInterrupt?.()
      expect(await app.system("still running")).toContain(
        '2 helpers still running · "Stop including helpers" in the command palette stops them',
      )
      expect(abort).toHaveBeenCalledTimes(1)
      expect(abort.mock.calls[0]?.[0]).toEqual({ sessionID: "ses-1" })
      expect(stop).not.toHaveBeenCalled()
      expect(list.mock.calls[0]?.[0]).toEqual({ sessionID: "ses-1", active: "true", shells: "true" })
    } finally {
      await app.close()
    }
  })

  test("an interrupt that leaves no helper says nothing more", async () => {
    const sdk = new VectorClient()
    spyOn(sdk.session, "abort").mockImplementation(() => ok(true))
    const list = spyOn(sdk.experimental.task, "list").mockImplementation(() =>
      ok({ tasks: [task("ses-fg", { background: false })], truncated: false }),
    )
    const app = await mount(sdk)
    try {
      app.input.onInterrupt?.()
      for (let index = 0; index < 50 && list.mock.calls.length === 0; index++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(list).toHaveBeenCalledTimes(1)
      expect(app.commits.filter((commit) => commit.text.includes("helper"))).toEqual([])
    } finally {
      await app.close()
    }
  })

  test("Stop including helpers uses route 1 with helpers, and Resume interrupted helpers resumes them", async () => {
    const sdk = new VectorClient()
    spyOn(sdk.experimental.capabilities, "get").mockImplementation(() =>
      ok({ backgroundSubagents: true, sessionStop: true, taskResume: true }),
    )
    const stop = spyOn(sdk.experimental.session, "stop").mockImplementation(() =>
      ok({ aborted: true, tasks: [task("ses-a"), task("ses-b")], shells: 1, excluded: 0, skipped: 0 }),
    )
    spyOn(sdk.experimental.task, "list").mockImplementation(() =>
      ok({
        tasks: [
          task("ses-i", {
            status: "stopped",
            interrupted: { at: 1, cause: "crash" },
            controls: { inspect: true, message: false, stop: false, resume: true },
          }),
        ],
        truncated: false,
      }),
    )
    const resume = spyOn(sdk.experimental.task, "resume").mockImplementation(() => ok({ tasks: [task("ses-i")] }))
    const app = await mount(sdk)
    try {
      app.input.onInterruptAll?.()
      expect(await app.system("Stopped 2 helpers")).toContain("Stopped 2 helpers and 1 background command.")
      expect(stop.mock.calls[0]?.[0]).toEqual({ sessionID: "ses-1", helpers: true })
      app.input.onResumeInterrupted?.()
      expect(await app.system("Resumed")).toContain("Resumed 1 interrupted helper; each reports when it finishes.")
      expect(resume.mock.calls[0]?.[0]).toEqual({ sessionID: "ses-1", taskIDs: ["ses-i"] })
    } finally {
      await app.close()
    }
  })

  test("on an engine without route 3 Resume interrupted helpers says to update it", async () => {
    const sdk = new VectorClient()
    spyOn(sdk.experimental.capabilities, "get").mockImplementation(() => ok({ backgroundSubagents: true }))
    const resume = spyOn(sdk.experimental.task, "resume")
    const app = await mount(sdk)
    try {
      app.input.onResumeInterrupted?.()
      for (let index = 0; index < 100 && !app.commits.some((commit) => commit.kind === "error"); index++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      expect(app.commits.find((commit) => commit.kind === "error")?.text).toBe(
        "Could not resume the helpers: This server's engine predates 1.99.113 and cannot resume interrupted helpers; update it.",
      )
      expect(resume).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})

describe("run split footer interrupt", () => {
  test("--mini keeps its two-press interrupt: one Esc only arms it, the second fires it", async () => {
    const setup = await createTestRenderer({
      width: 80,
      height: 24,
      screenMode: "split-footer",
      footerHeight: 6,
      externalOutputMode: "capture-stdout",
      consoleMode: "disabled",
      kittyKeyboard: true,
    })
    const tuiConfig = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(setup.renderer)
    const offKeymap = registerVectorKeymap(keymap, setup.renderer, tuiConfig)
    const interrupts: string[] = []
    const footer = new RunFooter(setup.renderer, {
      directory: "/tmp",
      findFiles: async () => [],
      agents: [],
      resources: [],
      sessionID: () => "ses-1",
      agentLabel: "Build",
      modelLabel: "gpt-5",
      model: undefined,
      variant: undefined,
      first: true,
      theme: RUN_THEME_FALLBACK,
      keymap,
      tuiConfig,
      backgroundSubagents: true,
      diffStyle: "auto",
      onPermissionReply: () => {},
      onQuestionReply: () => {},
      onQuestionReject: () => {},
      onInterrupt: () => interrupts.push("turn"),
      onInterruptAll: () => interrupts.push("all"),
      onEditorOpen: async () => undefined,
    })
    try {
      const press = async () => {
        setup.mockInput.pressEscape()
        await new Promise((resolve) => setTimeout(resolve, 20))
        await setup.renderOnce()
      }
      await setup.renderOnce()
      // Idle: Esc interrupts nothing.
      await press()
      expect(interrupts).toEqual([])
      footer.event({ type: "turn.send", queue: 0 })
      await setup.renderOnce()
      await press()
      expect(interrupts).toEqual([])
      await press()
      expect(interrupts).toEqual(["turn"])
    } finally {
      footer.destroy()
      offKeymap()
      setup.renderer.destroy()
    }
  })
})
