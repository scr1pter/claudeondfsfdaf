import { describe, expect, test } from "bun:test"
import type { Event } from "@vectordevai/sdk/v2"
import { createSessionData, flushInterrupted, reduceSessionData } from "@/cli/cmd/run/session-data"
import type { StreamCommit } from "@/cli/cmd/run/types"

function reduce(data: ReturnType<typeof createSessionData>, event: unknown, thinking = true) {
  return reduceSessionData({
    data,
    event: event as Event,
    sessionID: "session-1",
    thinking,
    limits: {},
  })
}

function assistant(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: {
        id,
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: {
          input: 1,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        ...extra,
      },
    },
  }
}

function user(id: string) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: {
        id,
        role: "user",
      },
    },
  }
}

function text(input: { id: string; messageID: string; text: string; time?: Record<string, number> }) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: input.id,
        messageID: input.messageID,
        sessionID: "session-1",
        type: "text",
        text: input.text,
        ...(input.time ? { time: input.time } : {}),
      },
    },
  }
}

function reasoning(input: { id: string; messageID: string; text: string; time?: Record<string, number> }) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: input.id,
        messageID: input.messageID,
        sessionID: "session-1",
        type: "reasoning",
        text: input.text,
        ...(input.time ? { time: input.time } : {}),
      },
    },
  }
}

function delta(messageID: string, partID: string, value: string) {
  return {
    type: "message.part.delta",
    properties: {
      sessionID: "session-1",
      messageID,
      partID,
      field: "text",
      delta: value,
    },
  }
}

function tool(input: { id: string; messageID: string; tool: string; state: Record<string, unknown>; callID?: string }) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: input.id,
        messageID: input.messageID,
        sessionID: "session-1",
        type: "tool",
        tool: input.tool,
        ...(input.callID ? { callID: input.callID } : {}),
        state: input.state,
      },
    },
  }
}

describe("run session data", () => {
  test("Codium context stays a percentage and mixed own spend remains visible", () => {
    const data = createSessionData()
    const codium = assistant("codium", {
      providerID: "vector-plan",
      cost: 0,
      unpriced: true,
      tokens: { input: 24000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const first = reduceSessionData({
      data,
      event: codium as Event,
      sessionID: "session-1",
      thinking: false,
      limits: { "vector-plan/gpt-5": 100000 },
    })
    expect(first.footer?.patch?.usage).toBe("24% of context · Codium")
    expect(reduce(data, assistant("own", { cost: 0.12 })).footer?.patch?.usage).toBe("2 · $0.12 + Codium")
    const child = assistant("child", { billing: "codium", cost: 999, unpriced: true })
    const delegated = reduceSessionData({
      data,
      event: { ...child, properties: { ...child.properties, sessionID: "child" } } as Event,
      sessionID: "session-1",
      thinking: false,
      limits: {},
      subagent: (id) => id === "child",
    })
    expect(delegated.footer?.patch?.usage).toBe("2 · $0.12 + Codium")
    expect(reduce(data, codium).footer?.patch?.usage).toBe("$0.12 + Codium")
  })
  test("the footer shows what the run has spent across its steps, not just the latest step", () => {
    const usage = (data: ReturnType<typeof createSessionData>, event: unknown) => {
      const out = reduce(data, event)
      return { data: out.data, usage: out.footer?.patch?.usage }
    }
    const first = usage(createSessionData(), assistant("msg-1", { cost: 0.5 }))
    const second = usage(first.data, assistant("msg-2", { cost: 0.6 }))
    const third = usage(second.data, assistant("msg-3", { cost: 0.04 }))
    expect([first.usage, second.usage, third.usage]).toEqual(["2 · $0.50", "2 · $1.10", "2 · $1.14"])
    // A step's message is updated again as it settles, which must not count it twice.
    expect(usage(third.data, assistant("msg-3", { cost: 0.04 })).usage).toBe("2 · $1.14")
    expect(usage(third.data, assistant("msg-4", { cost: 0, unpriced: true })).usage).toBe("2 · $1.14 + unpriced")
    // A new step streams before it reports usage; the last context reading stays on screen meanwhile.
    const empty = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(usage(third.data, assistant("msg-5", { cost: 0, tokens: empty })).usage).toBe("2 · $1.14 + unpriced")
  })

  test("the footer's spend includes the run's subagents but not unrelated sessions", () => {
    const child = (id: string, sessionID: string, cost: number) => {
      const event = assistant(id, { cost })
      return { ...event, properties: { ...event.properties, sessionID } }
    }
    const step = (data: ReturnType<typeof createSessionData>, event: unknown) =>
      reduceSessionData({
        data,
        event: event as Event,
        sessionID: "session-1",
        thinking: true,
        limits: {},
        subagent: (sessionID) => sessionID === "child-1",
      })
    const own = step(createSessionData(), assistant("msg-1", { cost: 0.5 }))
    const delegated = step(own.data, child("child-msg-1", "child-1", 2))
    expect(delegated.footer?.patch?.usage).toBe("2 · $2.50")
    const unrelated = step(delegated.data, child("other-msg-1", "other", 7))
    expect(unrelated.footer).toBeUndefined()
    expect(step(unrelated.data, assistant("msg-2", { cost: 0.1 })).footer?.patch?.usage).toBe("2 · $2.60")
  })

  test("buffers delayed assistant text until the role is known", () => {
    let data = createSessionData()
    data = reduce(data, delta("msg-1", "txt-1", "hello")).data
    data = reduce(data, assistant("msg-1")).data

    const out = reduce(
      data,
      text({
        id: "txt-1",
        messageID: "msg-1",
        text: "",
        time: { end: 1 },
      }),
    )

    expect(out.commits).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "hello",
        partID: "txt-1",
      }),
    ])
  })

  test("keeps leading whitespace buffered until real assistant content arrives", () => {
    let data = createSessionData()
    data = reduce(data, assistant("msg-1")).data
    data = reduce(data, text({ id: "txt-1", messageID: "msg-1", text: "", time: { start: 1 } })).data

    let out = reduce(data, delta("msg-1", "txt-1", " "))
    expect(out.commits).toEqual([])

    out = reduce(out.data, delta("msg-1", "txt-1", "Found"))
    expect(out.commits).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: " Found",
      }),
    ])
  })

  test("drops delayed text once the message resolves to a user role", () => {
    let data = createSessionData()
    data = reduce(data, text({ id: "txt-user-1", messageID: "msg-user-1", text: "HELLO", time: { end: 1 } })).data

    const out = reduce(data, user("msg-user-1"))

    expect(out.commits).toEqual([])
    expect(out.data.ids.has("txt-user-1")).toBe(true)
  })

  test("suppresses reasoning commits when thinking is disabled", () => {
    const out = reduce(
      createSessionData(),
      reasoning({
        id: "reason-1",
        messageID: "msg-1",
        text: "hidden",
        time: { end: 1 },
      }),
      false,
    )

    expect(out.commits).toEqual([])
    expect(out.data.ids.has("reason-1")).toBe(true)
  })

  test("keeps permission precedence over queued questions", () => {
    let data = createSessionData()
    data = reduce(data, {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "session-1",
        permission: "read",
        patterns: ["/tmp/file.txt"],
        metadata: {},
        always: [],
      },
    }).data

    const ask = reduce(data, {
      type: "question.asked",
      properties: {
        id: "question-1",
        sessionID: "session-1",
        questions: [
          {
            question: "Mode?",
            header: "Mode",
            options: [{ label: "chunked", description: "Incremental output" }],
            multiple: false,
          },
        ],
      },
    })

    expect(ask.footer).toEqual({
      patch: { status: "awaiting permission" },
      view: {
        type: "permission",
        request: expect.objectContaining({ id: "perm-1" }),
      },
    })

    expect(
      reduce(ask.data, {
        type: "permission.replied",
        properties: {
          sessionID: "session-1",
          requestID: "perm-1",
          reply: "reject",
        },
      }).footer,
    ).toEqual({
      patch: { status: "awaiting answer" },
      view: {
        type: "question",
        request: expect.objectContaining({ id: "question-1" }),
      },
    })
  })

  test("refreshes the active permission view when tool input arrives later", () => {
    const data = reduce(createSessionData(), {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "session-1",
        permission: "bash",
        patterns: ["src/**/*.ts"],
        metadata: {},
        always: [],
        tool: {
          messageID: "msg-1",
          callID: "call-1",
        },
      },
    }).data

    const out = reduce(
      data,
      tool({
        id: "tool-1",
        messageID: "msg-1",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "running",
          input: {
            command: "git status --short",
          },
        },
      }),
    )

    expect(out.footer).toEqual({
      view: {
        type: "permission",
        request: expect.objectContaining({
          id: "perm-1",
          metadata: expect.objectContaining({
            input: {
              command: "git status --short",
            },
          }),
        }),
      },
    })
  })

  test("strips bash echo only from the first assistant flush", () => {
    let data = createSessionData()
    data = reduce(data, assistant("msg-1")).data
    data = reduce(
      data,
      tool({
        id: "tool-1",
        messageID: "msg-1",
        tool: "bash",
        state: {
          status: "completed",
          input: {
            command: "printf hi",
          },
          output: "echoed\n",
          time: { start: 1, end: 2 },
        },
      }),
    ).data

    const first = reduce(
      data,
      text({
        id: "txt-1",
        messageID: "msg-1",
        text: "echoed\nanswer",
      }),
    )

    expect(first.commits).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "answer",
      }),
    ])

    expect(reduce(first.data, delta("msg-1", "txt-1", "\nechoed\nagain")).commits).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "\nechoed\nagain",
      }),
    ])
  })

  test("renders direct shell mode from first-class shell events", () => {
    let data = createSessionData()
    const started = reduce(data, {
      type: "session.next.shell.started",
      properties: {
        sessionID: "session-1",
        timestamp: 1,
        callID: "call-1",
        command: "pwd",
      },
    })

    expect(started.commits).toEqual([
      expect.objectContaining({
        kind: "tool",
        phase: "start",
        partID: "shell:call-1",
        tool: "bash",
        shell: {
          callID: "call-1",
          command: "pwd",
        },
      }),
    ])

    data = started.data
    const ended = reduce(data, {
      type: "session.next.shell.ended",
      properties: {
        sessionID: "session-1",
        timestamp: 2,
        callID: "call-1",
        output: "/tmp/demo\n",
      },
    })

    expect(ended.commits).toEqual([
      expect.objectContaining({
        kind: "tool",
        phase: "progress",
        partID: "shell:call-1",
        tool: "bash",
        text: "/tmp/demo\n",
        toolState: "completed",
        shell: {
          callID: "call-1",
          command: "pwd",
        },
      }),
    ])
  })

  test("suppresses legacy bash part updates once shell events claim the call", () => {
    let data = reduce(createSessionData(), {
      type: "session.next.shell.started",
      properties: {
        sessionID: "session-1",
        timestamp: 1,
        callID: "call-1",
        command: "pwd",
      },
    }).data

    expect(
      reduce(
        data,
        tool({
          id: "tool-1",
          messageID: "msg-1",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "running",
            input: {
              command: "pwd",
            },
            time: { start: 1 },
          },
        }),
      ).commits,
    ).toEqual([])

    data = reduce(data, {
      type: "session.next.shell.ended",
      properties: {
        sessionID: "session-1",
        timestamp: 2,
        callID: "call-1",
        output: "/tmp/demo\n",
      },
    }).data

    expect(
      reduce(
        data,
        tool({
          id: "tool-1",
          messageID: "msg-1",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "completed",
            input: {
              command: "pwd",
            },
            output: "/tmp/demo\n",
            title: "",
            metadata: {
              output: "/tmp/demo\n",
            },
            time: { start: 1, end: 2 },
          },
        }),
      ).commits,
    ).toEqual([])
  })

  test("suppresses shell events when the legacy bash part claimed the call first", () => {
    let data = reduce(
      createSessionData(),
      tool({
        id: "tool-1",
        messageID: "msg-1",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "running",
          input: {
            command: "pwd",
          },
          time: { start: 1 },
        },
      }),
    ).data

    expect(
      reduce(data, {
        type: "session.next.shell.started",
        properties: {
          sessionID: "session-1",
          timestamp: 1,
          callID: "call-1",
          command: "pwd",
        },
      }).commits,
    ).toEqual([])

    data = reduce(
      data,
      tool({
        id: "tool-1",
        messageID: "msg-1",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "completed",
          input: {
            command: "pwd",
          },
          output: "/tmp/demo\n",
          title: "",
          metadata: {
            output: "/tmp/demo\n",
          },
          time: { start: 1, end: 2 },
        },
      }),
    ).data

    expect(
      reduce(data, {
        type: "session.next.shell.ended",
        properties: {
          sessionID: "session-1",
          timestamp: 2,
          callID: "call-1",
          output: "/tmp/demo\n",
        },
      }).commits,
    ).toEqual([])
  })

  test("synthesizes a glob start before an error when the running update is missed", () => {
    expect(
      reduce(
        createSessionData(),
        tool({
          id: "tool-1",
          messageID: "msg-1",
          tool: "glob",
          state: {
            status: "error",
            input: {
              pattern: "**/*tool*",
              path: "/tmp/demo/run",
            },
            error: "No such file or directory: '/tmp/demo/run'",
          },
        }),
      ).commits,
    ).toEqual([
      expect.objectContaining({
        kind: "tool",
        tool: "glob",
        phase: "start",
        partID: "tool-1",
        text: "running glob",
        toolState: "running",
      }),
      expect.objectContaining({
        kind: "tool",
        tool: "glob",
        phase: "final",
        partID: "tool-1",
        text: "No such file or directory: '/tmp/demo/run'",
        toolState: "error",
        toolError: "No such file or directory: '/tmp/demo/run'",
      }),
    ])
  })

  test("flushInterrupted emits one interrupted final per live part", () => {
    const data = reduce(
      createSessionData(),
      text({
        id: "txt-1",
        messageID: "msg-1",
        text: "unfinished",
      }),
    ).data

    const first: StreamCommit[] = []
    flushInterrupted(data, first)
    expect(first).toEqual([
      expect.objectContaining({ kind: "assistant", text: "unfinished", phase: "progress" }),
      expect.objectContaining({ kind: "assistant", phase: "final", interrupted: true }),
    ])

    const next: StreamCommit[] = []
    flushInterrupted(data, next)
    expect(next).toEqual([])
  })

  test("surfaces session errors as error commits", () => {
    const out = reduce(createSessionData(), {
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: {
          name: "UnknownError",
          data: {
            message: "permission denied",
          },
        },
      },
    })

    expect(out.commits).toEqual([
      expect.objectContaining({
        kind: "error",
        text: "permission denied",
      }),
    ])
  })

  test("shows a spend guard stop as a Stopped warning on the session error and the assistant message", () => {
    const error = {
      name: "BudgetStopError",
      data: {
        reason: "steps",
        message: "Step limit reached: 60 of 60 steps used for this run.",
      },
    }
    const data = createSessionData()
    const session = reduce(data, {
      type: "session.error",
      properties: { sessionID: "session-1", error },
    })
    const message = reduce(session.data, assistant("msg-1", { error }))
    const stopped = {
      kind: "error",
      text: "Stopped: Step limit reached: 60 of 60 steps used for this run.",
      stopped: true,
    }

    expect(session.commits).toEqual([expect.objectContaining(stopped)])
    expect(message.commits).toEqual([expect.objectContaining({ ...stopped, messageID: "msg-1" })])
  })
})
