import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"
import { createVectorClient } from "@vectordevai/sdk/v2"
import type { Task } from "@vectordevai/schema/task"
import {
  INTERRUPT_EXIT_CODE,
  INTERRUPT_WINDOW_MS,
  countHelpers,
  handlesInterrupt,
  helpersLeftMessage,
  helpersNotice,
  interruptPlan,
  liveHelpers,
  resumeInterrupted,
  stopSession,
  stoppedNotice,
  watchInterrupts,
} from "@/cli/cmd/run/interrupt"

function info(input: Partial<Task.Info> & { id: string }): Task.Info {
  return {
    parentSessionID: "parent",
    source: "subagent",
    title: "Work",
    status: "running",
    startedAt: 1,
    elapsedMs: 1,
    ownedPaths: [],
    dependsOn: [],
    resultAvailable: false,
    attempt: 1,
    controls: { inspect: true, message: true, stop: true },
    ...input,
  }
}

function engine(
  input: { capabilities?: Record<string, unknown> | Response; tasks?: Task.Info[]; shells?: Task.Shell[] } = {},
) {
  const requests: Request[] = []
  const client = createVectorClient({
    baseUrl: "http://fixture.invalid",
    fetch: async (request) => {
      requests.push(request)
      const path = new URL(request.url).pathname
      if (path === "/experimental/capabilities")
        return input.capabilities instanceof Response
          ? input.capabilities
          : Response.json(input.capabilities ?? { backgroundSubagents: true, sessionStop: true, taskResume: true })
      if (path === "/experimental/session/parent/stop") {
        const body = await request.clone().json()
        return Response.json({
          aborted: true,
          tasks: body.helpers ? [info({ id: "ses_a" }), info({ id: "ses_b" })] : [],
          shells: body.helpers ? 1 : 0,
          excluded: 0,
          skipped: 0,
        })
      }
      if (path === "/session/parent/abort") return Response.json(true)
      if (path === "/experimental/session/parent/tasks/stop") return Response.json({ tasks: [info({ id: "ses_a" })] })
      if (path === "/experimental/session/parent/tasks/resume")
        return Response.json({ tasks: (await request.clone().json()).taskIDs.map((id: string) => info({ id })) })
      if (path === "/experimental/session/parent/tasks")
        return Response.json({
          tasks: input.tasks ?? [],
          truncated: false,
          ...(input.shells ? { shells: input.shells } : {}),
        })
      return Response.json({}, { status: 404 })
    },
  })
  const operations = () =>
    requests
      .filter((request) => new URL(request.url).pathname !== "/experimental/capabilities")
      .map((request) => `${request.method} ${new URL(request.url).pathname}`)
  return { client, requests, operations }
}

describe("interruptPlan", () => {
  test("the first press stops the main turn, or everything with --stop-helpers", () => {
    expect(interruptPlan({ now: 1_000, stopHelpers: false })).toEqual({ stop: "turn", exit: false })
    expect(interruptPlan({ now: 1_000, stopHelpers: true })).toEqual({ stop: "all", exit: false })
  })

  test("a second press within 5 s stops everything and exits; a later one starts over", () => {
    expect(interruptPlan({ now: 1_000 + INTERRUPT_WINDOW_MS, previous: 1_000, stopHelpers: false })).toEqual({
      stop: "all",
      exit: true,
    })
    expect(interruptPlan({ now: 1_001 + INTERRUPT_WINDOW_MS, previous: 1_000, stopHelpers: false })).toEqual({
      stop: "turn",
      exit: false,
    })
    expect(interruptPlan({ now: 2_000, previous: 1_000, stopHelpers: true })).toEqual({ stop: "all", exit: true })
    // A clock that went backwards is not a quick second press.
    expect(interruptPlan({ now: 500, previous: 1_000, stopHelpers: false })).toEqual({ stop: "turn", exit: false })
    expect(INTERRUPT_EXIT_CODE).toBe(130)
  })

  test("only a non-interactive run at a terminal handles Ctrl+C", () => {
    expect(handlesInterrupt({ interactive: false, workflow: false, tty: true })).toBe(true)
    expect(handlesInterrupt({ interactive: false, workflow: false, tty: false })).toBe(false)
    expect(handlesInterrupt({ interactive: true, workflow: false, tty: true })).toBe(false)
    expect(handlesInterrupt({ interactive: false, workflow: true, tty: true })).toBe(false)
  })

  test("messages count helpers in the singular and plural", () => {
    expect(helpersLeftMessage(3)).toBe(
      "Stopped the main turn. 3 helpers are still running. Press Ctrl+C again to stop them and exit.",
    )
    expect(helpersLeftMessage(1)).toBe(
      "Stopped the main turn. 1 helper is still running. Press Ctrl+C again to stop them and exit.",
    )
    expect(helpersNotice(2)).toStartWith("2 helpers still running")
    expect(stoppedNotice({ helpers: 2, shells: 1, excluded: 1 })).toBe(
      "Stopped 2 helpers and 1 background command. Agent workspaces keep running; stop them from the Agent Dashboard.",
    )
    expect(stoppedNotice({ helpers: 0, shells: 0, excluded: 0 })).toBe("No helpers were running.")
  })
})

describe("helpers", () => {
  test("live helpers are running background subagents and commands, not foreground work or workspaces", () => {
    expect(
      liveHelpers({
        tasks: [
          info({ id: "bg", background: true }),
          info({ id: "legacy" }),
          info({ id: "queued", status: "queued", background: true }),
          info({ id: "waiting", status: "waiting_on_user", background: true }),
          info({ id: "fg", background: false }),
          info({ id: "done", status: "completed", background: true }),
          info({ id: "desk", source: "team" }),
        ],
        shells: [{ status: "running" }, { status: "completed" }],
      }),
    ).toBe(5)
  })

  test("countHelpers reads the active board with commands, and says 0 when the engine cannot answer", async () => {
    const live = engine({ tasks: [info({ id: "ses_a", background: true })] })
    expect(await countHelpers(live.client, "parent")).toBe(1)
    expect(new URL(live.requests[0].url).search).toBe("?active=true&shells=true")
    const broken = createVectorClient({
      baseUrl: "http://fixture.invalid",
      fetch: async () => new Response("no", { status: 500 }),
    })
    expect(await countHelpers(broken, "parent")).toBe(0)
  })

  test("stopSession uses route 1 when the engine has it, and the old abort otherwise", async () => {
    const current = engine()
    expect(await stopSession(current.client, "parent", { helpers: true })).toEqual({
      aborted: true,
      helpers: 2,
      shells: 1,
      excluded: 0,
    })
    expect(await stopSession(current.client, "parent", { helpers: false })).toMatchObject({ helpers: 0 })
    expect(current.operations()).toEqual([
      "POST /experimental/session/parent/stop",
      "POST /experimental/session/parent/stop",
    ])
    expect(await current.requests[1].json()).toEqual({ helpers: true })
    expect(await current.requests[3].json()).toEqual({ helpers: false })

    for (const capabilities of [
      { backgroundSubagents: true },
      new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    ]) {
      const old = engine({ capabilities })
      expect(await stopSession(old.client, "parent", { helpers: false })).toEqual({
        helpers: 0,
        shells: 0,
        excluded: 0,
      })
      expect(await stopSession(old.client, "parent", { helpers: true })).toEqual({ helpers: 1, shells: 0, excluded: 0 })
      expect(old.operations()).toEqual([
        "POST /session/parent/abort",
        "POST /session/parent/abort",
        "POST /experimental/session/parent/tasks/stop",
      ])
    }
  })

  test("resumeInterrupted resumes only resumable interrupted helpers, and needs route 3", async () => {
    const tasks = [
      info({
        id: "ses_i",
        status: "stopped",
        interrupted: { at: 1, cause: "crash" },
        controls: { inspect: true, message: false, stop: false, resume: true },
      }),
      info({
        id: "ses_done",
        status: "completed",
        controls: { inspect: true, message: false, stop: false, resume: true },
      }),
      info({
        id: "ses_dismissed",
        status: "stopped",
        interrupted: { at: 1, cause: "crash", dismissedAt: 2 },
        controls: { inspect: true, message: false, stop: false, resume: true },
      }),
    ]
    const current = engine({ tasks })
    expect(await resumeInterrupted(current.client, "parent")).toBe(1)
    expect(current.operations()).toEqual([
      "GET /experimental/session/parent/tasks",
      "POST /experimental/session/parent/tasks/resume",
    ])
    expect(await current.requests.at(-1)!.json()).toEqual({ taskIDs: ["ses_i"] })
    expect(await resumeInterrupted(engine({ tasks: [] }).client, "parent")).toBe(0)
    const old = engine({ capabilities: { backgroundSubagents: true }, tasks })
    await expect(resumeInterrupted(old.client, "parent")).rejects.toThrow(
      "This server's engine predates 1.99.113 and cannot resume interrupted helpers; update it.",
    )
    expect(old.operations()).toEqual([])
  })
})

describe("watchInterrupts", () => {
  async function settle() {
    for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 1))
  }

  test("the first press stops the main turn and names the helpers left; a quick second press stops all and exits 130", async () => {
    const live = engine({ tasks: [info({ id: "ses_a", background: true }), info({ id: "ses_b", background: true })] })
    const signals = new EventEmitter()
    const written: string[] = []
    const exits: number[] = []
    let clock = 10_000
    const watch = watchInterrupts({
      client: live.client,
      sessionID: "parent",
      stopHelpers: false,
      write: (text) => written.push(text),
      exit: (code) => exits.push(code),
      now: () => clock,
      signals,
    })
    expect(watch.interrupted).toBe(false)
    signals.emit("SIGINT")
    await settle()
    expect(watch.interrupted).toBe(true)
    expect(written).toEqual([helpersLeftMessage(2)])
    expect(exits).toEqual([])
    expect(live.operations()).toEqual([
      "POST /experimental/session/parent/stop",
      "GET /experimental/session/parent/tasks",
    ])
    expect(await live.requests[1].json()).toEqual({ helpers: false })

    clock += INTERRUPT_WINDOW_MS - 1
    signals.emit("SIGINT")
    await settle()
    expect(exits).toEqual([130])
    expect(live.operations().at(-1)).toBe("POST /experimental/session/parent/stop")
    expect(await live.requests.at(-1)!.json()).toEqual({ helpers: true })

    watch.dispose()
    expect(signals.listenerCount("SIGINT")).toBe(0)
  })

  test("with --stop-helpers the first press stops everything without exiting, and no helpers means no message", async () => {
    const live = engine()
    const signals = new EventEmitter()
    const written: string[] = []
    const exits: number[] = []
    const watch = watchInterrupts({
      client: live.client,
      sessionID: "parent",
      stopHelpers: true,
      write: (text) => written.push(text),
      exit: (code) => exits.push(code),
      signals,
    })
    signals.emit("SIGINT")
    await settle()
    expect(live.operations()).toEqual(["POST /experimental/session/parent/stop"])
    expect(await live.requests[1].json()).toEqual({ helpers: true })
    expect(exits).toEqual([])
    expect(written).toEqual([])
    watch.dispose()

    const quiet = engine({ tasks: [info({ id: "ses_fg", background: false })] })
    const second = new EventEmitter()
    const turnOnly = watchInterrupts({
      client: quiet.client,
      sessionID: "parent",
      stopHelpers: false,
      write: (text) => written.push(text),
      exit: (code) => exits.push(code),
      signals: second,
    })
    second.emit("SIGINT")
    await settle()
    expect(written).toEqual([])
    turnOnly.dispose()
  })
})
