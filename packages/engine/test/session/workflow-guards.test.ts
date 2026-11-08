import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { Provider } from "@/provider/provider"
import { SessionMemory } from "@/session/memory"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionTaskSize } from "@/session/task-size"
import { SessionWorkflow } from "@/session/workflow"
import { TestLLMServer } from "../lib/llm-server"
import { engine, ref, setup } from "./learning-fixture"

const it = engine()

it.instance("workflow coordinators refuse direct execution and revert before changing their history", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const revert = yield* SessionRevert.Service
    const llm = yield* TestLLMServer
    const parent = yield* sessions.create({})
    const run = yield* sessions.create({ parentID: parent.id, agent: "workflow", title: "Review changes" })
    const before = yield* sessions.get(run.id)
    const actions: readonly Effect.Effect<unknown, unknown>[] = [
      prompt.prompt({ sessionID: run.id, agent: "build", noReply: true, parts: [{ type: "text", text: "Bypass" }] }),
      prompt.command({ sessionID: run.id, agent: "build", command: "missing", arguments: "" }),
      prompt.shell({ sessionID: run.id, agent: "build", command: "echo must-not-run" }),
      prompt.loop({ sessionID: run.id }),
      prompt.admit(run.id),
      revert.revert({ sessionID: run.id, messageID: MessageID.ascending() }),
      revert.unrevert({ sessionID: run.id }),
    ]
    for (const action of actions) {
      const exit = yield* action.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Workflow runs cannot")
      expect(yield* sessions.messages({ sessionID: run.id })).toEqual([])
      expect(yield* sessions.get(run.id)).toEqual(before)
    }
    expect(yield* llm.calls).toBe(0)
  }),
)

it.instance("ordinary sessions can still save a prompt without inference", () =>
  Effect.gen(function* () {
    yield* setup()
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const session = yield* sessions.create({ agent: "build" })
    const message = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "Save this request." }],
    })
    expect(message.info.role).toBe("user")
    expect(yield* sessions.messages({ sessionID: session.id })).toHaveLength(1)
    const llm = yield* TestLLMServer
    expect(yield* llm.calls).toBe(0)
  }),
)

it.instance(
  "workflow tool observations stay partial and carry subagent taint after completion",
  () =>
    Effect.gen(function* () {
      const { place, dir } = yield* setup()
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const workflow = yield* SessionWorkflow.Service
      const provider = yield* Provider.Service
      const database = yield* BrainDatabase.Service
      const session = yield* sessions.create({ agent: "build" })
      const user = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: ref,
        noReply: true,
        size: "standard",
        parts: [{ type: "text", text: "Review the repository changes." }],
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        parentID: user.info.id,
        sessionID: session.id,
        role: "assistant",
        agent: "build",
        mode: "build",
        modelID: ref.modelID,
        providerID: ref.providerID,
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: assistant.id,
        type: "tool",
        tool: "workflow",
        callID: "workflow-observation",
        state: {
          status: "completed",
          input: { action: "run" },
          output: "Review complete",
          title: "Review changes",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      })
      const messages = yield* sessions.messages({ sessionID: session.id })
      expect(SessionMemory.taint(messages)).toBe("subagent")
      const request = SessionTaskSize.size({ messages, caching: false, lifetime: 0 })[0]
      yield* workflow.observe({
        session,
        taught: new Map([[user.info.id, { message: user, tier: request.tier }]]),
        // The call happened before this attempt; the whole request remains partial.
        since: assistant.id,
        run: undefined,
        background: 0,
        step: {
          request,
          effortTier: request.tier,
          model: yield* provider.getModel(ref.providerID, ref.modelID),
          effort: "default",
          source: "size",
        },
      })
      const rows = yield* database.db.all<{ partial: number; taint: string; subagents: number }>(
        sql`SELECT partial, taint, subagents FROM brain_workflow_run WHERE repository_id = ${place.repository}`,
      )
      expect(rows).toEqual([{ partial: 1, taint: "subagent", subagents: 0 }])
    }),
  { git: true },
)

test.each(["pending", "completed"] as const)("a %s workflow call preserves direct MCP and web taint", (status) => {
  const sessionID = SessionID.make("ses_workflow_taint")
  const messageID = MessageID.make("msg_workflow_taint")
  const part = (tool: string, pending = false): SessionV1.ToolPart => ({
    id: PartID.make(`prt_${tool}`),
    sessionID,
    messageID,
    type: "tool",
    tool,
    callID: tool,
    state: pending
      ? { status: "pending", input: {}, raw: "{}" }
      : { status: "completed", input: {}, output: "Result", title: tool, metadata: {}, time: { start: 1, end: 2 } },
  })
  const history = (parts: SessionV1.Part[]): SessionV1.WithParts[] => [
    {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.make("msg_user"),
        agent: "build",
        mode: "build",
        modelID: ref.modelID,
        providerID: ref.providerID,
        path: { cwd: "/test", root: "/test" },
        time: { created: 1 },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts,
    },
  ]
  for (const tool of ["workflow", "task", "task_manage", "send_teammate_message"]) {
    const delegation = part(tool, status === "pending")
    expect(SessionMemory.taint(history([delegation, part("read")]))).toBe("subagent")
    expect(SessionMemory.taint(history([part("mcp_fixture"), delegation]))).toBe("mcp")
    expect(SessionMemory.taint(history([delegation, part("mcp_fixture"), part("webfetch")]))).toBe("web")
    expect(
      SessionMemory.taint(
        history([
          delegation,
          {
            id: PartID.make("prt_mcp_command"),
            sessionID,
            messageID,
            type: "text",
            text: "MCP prompt",
            metadata: { [SessionMemory.COMMAND]: { arguments: "", outside: "mcp" } },
          },
        ]),
      ),
    ).toBe("mcp")
  }
})
